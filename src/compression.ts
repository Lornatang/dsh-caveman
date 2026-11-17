import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
import type { ResolvedToolSet, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MiddlewareRuntime, recoveryInputSchema, recoveryToolDescription, type Optimization, type RetrieveArgs, type Scope } from '@caveman-ai/sdk/middleware'

const HANDLE = /^cmw_[a-f0-9]{48}$/u
const MARKER = /\[caveman: shortened; exact original via caveman_retrieve handle=(cmw_[a-f0-9]{48})/u
const MINIMUM_TEXT_LENGTH = 2048
const ADAPTER = { id: 'dsh', version: '0.1.0', framework_version: 'unknown', serialization_revision: 'dsh-session-v1' }

function scopeFor(agent: Agent): Scope {
  return { namespace: 'dsh-caveman', session_id: String(agent.session.id), branch_id: 'main', cache_epoch: '0' }
}

function parseArgs(value: unknown): RetrieveArgs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid recovery arguments')
  const args = value as Record<string, unknown>
  if (Object.keys(args).some(key => !['handle', 'offset', 'limit', 'query'].includes(key)) ||
    typeof args.handle !== 'string' || !HANDLE.test(args.handle) ||
    (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || (args.offset as number) < 0)) ||
    (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 4 || (args.limit as number) > 262144)) ||
    (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 1024))) {
    throw new Error('Invalid recovery arguments')
  }
  return args as unknown as RetrieveArgs
}

function textBlocks(event: SessionEvent): { index: number; text: string }[] {
  if (event.type !== 'tool/result' || event.data.message.isError) return []
  return event.data.message.content.flatMap((block, index) => block.type === 'text' ? [{ index, text: block.text }] : [])
}

function isManagedTool(name: string): boolean {
  return name === 'caveman_retrieve' || name.startsWith('mcp__caveman__') || name.startsWith('mcp__caveman_browse__') ||
    /^mcp__.+__(?:caveman_retrieve|browser_recover)$/u.test(name)
}

function originalForHandle(session: Session, handle: string): { text: string; sourceId: string } | undefined {
  for (const event of session.snapshotEvents()) {
    const block = textBlocks(event).find(candidate => MARKER.exec(candidate.text)?.[1] === handle)
    if (!block || event.sourceEventSeqs?.length !== 1) continue
    const source = session.eventAt(event.sourceEventSeqs[0]!)
    const original = source && textBlocks(source).find(candidate => candidate.index === block.index)
    if (source?.type === 'tool/result' && original) return { text: original.text, sourceId: `seq-${resolveOriginalResult(session, source).seq}` }
  }
  return undefined
}

function fallbackPage(session: Session, args: RetrieveArgs): string | undefined {
  if (args.query !== undefined) return undefined
  const original = originalForHandle(session, args.handle)
  if (!original) return undefined
  const bytes = Buffer.from(original.text, 'utf8')
  const offset = args.offset ?? 0
  if (offset > bytes.length) throw new Error('Recovery offset exceeds the original length')
  let end = Math.min(offset + (args.limit ?? 262144), bytes.length)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let page: string | undefined
  for (let attempt = 0; attempt < 4 && end >= offset; attempt++, end--) {
    try { page = decoder.decode(bytes.subarray(offset, end)); break } catch {}
  }
  if (page === undefined) throw new Error('Recovery offset is not a UTF-8 boundary')
  const actualEnd = offset + Buffer.byteLength(page)
  return JSON.stringify({
    schema_version: 1, handle: args.handle, source_id: original.sourceId, text: page,
    original_sha256: createHash('sha256').update(bytes).digest('hex'), total_bytes: bytes.length,
    complete: offset === 0 && actualEnd === bytes.length, kind: 'original_page', offset,
    next_offset: actualEnd === bytes.length ? null : actualEnd,
  })
}

const resultOrigins = new WeakMap<Session, WeakMap<SessionEvent<'tool/result'>, SessionEvent<'tool/result'>>>()

/** Resolve immutable event ancestry once per session, reusing earlier results. */
export function resolveOriginalResult(session: Session, event: SessionEvent<'tool/result'>): SessionEvent<'tool/result'> {
  const cache = resultOrigins.get(session) ?? new WeakMap<SessionEvent<'tool/result'>, SessionEvent<'tool/result'>>()
  resultOrigins.set(session, cache)
  const visited: SessionEvent<'tool/result'>[] = []
  let current = event
  for (;;) {
    const known = cache.get(current)
    if (known) { current = known; break }
    visited.push(current)
    const previous = (current.sourceEventSeqs ?? []).map(seq => session.eventAt(seq))
      .filter((item): item is SessionEvent<'tool/result'> => item?.type === 'tool/result')
    if (!previous.length) break
    const oldest = previous.reduce((a, b) => a.seq < b.seq ? a : b)
    if (oldest.seq >= current.seq) break
    current = oldest
  }
  for (const item of visited) cache.set(item, current)
  return current
}

function manifestFor(session: Session): { id: string; sha256: string }[] {
  return session.surface.nodes.map(seq => {
    let event = session.eventAt(seq)!
    if (event.type === 'tool/result') event = resolveOriginalResult(session, event)
    const data = event.type === 'user/message' ? event.data : 'message' in event.data ? event.data.message : event.data
    return { id: `seq-${event.seq}`, sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') }
  })
}

function surfaceMatchesManifest(session: Session, manifest: readonly { id: string }[]): boolean {
  if (session.surface.nodes.length !== manifest.length) return false
  return session.surface.nodes.every((seq, index) => {
    let event = session.eventAt(seq)
    if (!event) return false
    if (event.type === 'tool/result') event = resolveOriginalResult(session, event)
    return manifest[index]?.id === `seq-${event.seq}`
  })
}

type ExpectedProjection = { callId: string; blocks: readonly { index: number; text: string }[] }
type ProjectedMessage = { role: string; toolCallId?: string; content: readonly { type: string; text?: string }[] }

/** Check the changed blocks on each matching tool result, including partial projections. */
export function projectionCoverage(expected: readonly ExpectedProjection[], messages: readonly ProjectedMessage[]): 'none' | 'incomplete' | 'complete' {
  const projections = expected.map(item => {
    const target = messages.find(message => message.role === 'tool' && message.toolCallId === item.callId)
    return target ? item.blocks.every(({ index, text }) => {
      const block = target.content[index]
      return block?.type === 'text' && block.text === text
    }) : undefined
  })
  if (projections.every(value => value === undefined)) return 'none'
  return projections.every(value => value === true) ? 'complete' : 'incomplete'
}

/** Keep each result together while respecting middleware limits and unique segment ids. */
export function planCompressionBatches<T extends { bytes: number; segments: readonly { id: string }[] }>(items: readonly T[], byteBudget: number, maxSegments: number): T[][] {
  const batches: T[][] = []
  let batch: T[] = []
  let bytes = 0
  let count = 0
  let ids = new Set<string>()
  for (const item of items) {
    if (batch.length && (bytes + item.bytes > byteBudget || count + item.segments.length > maxSegments || item.segments.some(segment => ids.has(segment.id)))) {
      batches.push(batch)
      batch = []
      bytes = 0
      count = 0
      ids = new Set()
    }
    batch.push(item)
    bytes += item.bytes
    count += item.segments.length
    for (const segment of item.segments) ids.add(segment.id)
  }
  if (batch.length) batches.push(batch)
  return batches
}

/** Install recoverable compression using the middleware protocol. */
export function registerCompression(ctx: Context, endpoint: string, automatic?: {
  fetch: typeof fetch
  available: (signal: AbortSignal) => Promise<boolean>
}): void {
  const runtime = new MiddlewareRuntime({ endpoint, mode: 'compress', ...(automatic ? { fetch: automatic.fetch } : {}) })
  const pending = new Map<string, {
    session: Session
    replacements: { seq: SessionSeq; original: SessionEvent<'tool/result'>; optimization: Optimization; sentBlocks: { index: number; text: string }[] }[]
    optimizations: Map<Optimization, boolean>
  }>()
  function restore(session: Session): Optimization[] {
    const key = String(session.id)
    const work = pending.get(key)
    if (!work || work.session !== session) return []
    while (work.replacements.length) {
      const replacement = work.replacements[0]!
      if (session.surface.nodes.includes(replacement.seq)) {
        session.append('tool/result', replacement.original.data, {
          surfaceOp: { op: 'replace', startSeq: replacement.seq, endSeq: replacement.seq },
          sourceEventSeqs: [replacement.seq, replacement.original.seq],
        })
      } else work.optimizations.set(replacement.optimization, false)
      // Retain the current item until append succeeds so idle/disposal can
      // retry a transient restoration error without stranding the projection.
      work.replacements.shift()
    }
    pending.delete(key)
    return [...work.optimizations].filter(([, applied]) => applied).map(([optimization]) => optimization)
  }
  const tool: ToolDefinition = {
    name: 'caveman_retrieve', description: recoveryToolDescription,
    parameters: structuredClone(recoveryInputSchema) as unknown as Record<string, unknown>,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(value, exec) {
      if (!exec.agent) throw new Error('Caveman recovery requires an agent session')
      const args = parseArgs(value)
      try { return JSON.stringify(await runtime.retrieve(scopeFor(exec.agent), args, exec.signal)) } catch (error) {
        exec.signal.throwIfAborted()
        const fallback = fallbackPage(exec.agent.session, args)
        if (fallback !== undefined) return fallback
        throw error
      }
    },
  }
  if (ctx.tools.get(tool.name)) {
    ctx.logger.warn('dsh-caveman: recovery tool name is already in use; input compression is disabled')
    runtime.close()
    return
  }
  ctx.tools.register(tool, automatic ? {
    when: ({ agent, signal }) => agent.session.snapshotEvents().some(event => textBlocks(event).some(block => MARKER.test(block.text))) || automatic.available(signal),
  } : undefined)
  ctx.effect(() => () => {
    try { for (const work of [...pending.values()]) restore(work.session) } finally { runtime.close() }
  }, 'dsh-caveman:runtime')

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && pending.has(String(agent.session.id))) restore(agent.session)
  })
  ctx.on('llm/stream', (options, next) => (async function* () {
    const work = options.sessionId === undefined ? undefined : pending.get(String(options.sessionId))
    if (work) {
      const coverage = projectionCoverage(work.replacements.map(replacement => ({
        callId: replacement.original.data.message.toolCallId, blocks: replacement.sentBlocks,
      })), options.messages)
      const visible = options.tools?.find(entry => entry.name === tool.name)
      const valid = visible && visible.description === tool.description && isDeepStrictEqual(visible.parameters, tool.parameters)
      const restored = restore(work.session)
      if (coverage !== 'none' && (coverage !== 'complete' || !valid)) {
        throw new Error('dsh-caveman: compressed results or their recovery tool were not available for the request')
      }
      if (coverage === 'complete') for (const optimization of restored) runtime.report(optimization)
    }
    yield* next()
  })())

  const selections = new WeakMap<object, ResolvedToolSet>()
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    if (context.agent && context.toolSet) selections.set(context.agent, context.toolSet)
    return result
  })
  ctx.on('agent/pre-step', async ({ agent, modelSelection, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const toolSet = selections.get(agent)
    if (!toolSet || ctx.tools.get(tool.name, agent, toolSet) !== tool) return decision
    const session = agent.session
    if (pending.has(String(session.id))) restore(session)
    const toolNames = new Map<string, string>()
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'assistant/message') continue
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call' && !toolNames.has(block.id)) toolNames.set(block.id, block.name)
      }
    }
    const eligible: { seq: SessionSeq; event: SessionEvent<'tool/result'>; blocks: { index: number; text: string }[] }[] = []
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq)
      if (!event || event.type !== 'tool/result') continue
      const blocks = textBlocks(event).filter(block => block.text.length >= MINIMUM_TEXT_LENGTH && !MARKER.test(block.text))
      if (!blocks.length) continue
      const toolName = toolNames.get(event.data.message.toolCallId)
      if (!toolName || isManagedTool(toolName)) continue
      eligible.push({ seq, event, blocks })
    }
    if (!eligible.length) return decision
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent, modelSelection, toolSet, signal })
    const published = assembly.tools.find(entry => entry.name === tool.name)
    if (!published || published.description !== tool.description || !isDeepStrictEqual(published.parameters, tool.parameters)) return decision
    const scope = scopeFor(agent)
    const binding = runtime.recovery(scope)
    if (!binding) return decision
    let capabilities
    try { capabilities = await runtime.ready(signal) } catch { signal.throwIfAborted(); return decision }
    const manifest = manifestFor(session)
    const maxSegments = capabilities.limits.max_segments ?? 256
    const byteBudget = Math.max(0, capabilities.limits.request_bytes - Buffer.byteLength(JSON.stringify(manifest), 'utf8') - 16_384)
    const prepared = eligible.map(candidate => {
      const sourceId = `seq-${resolveOriginalResult(session, candidate.event).seq}`
      const segments = candidate.blocks.map(block => ({
        id: candidate.event.data.message.content.length === 1 ? sourceId : `${sourceId}-block-${block.index}`,
        sourceId, kind: 'tool_result' as const, content: block.text, index: block.index,
      }))
      return { ...candidate, sourceId, segments, bytes: segments.reduce((sum, segment) => sum + Buffer.byteLength(JSON.stringify(segment), 'utf8') + 256, 0) }
    })
    type Candidate = typeof prepared[number]
    const batches = planCompressionBatches(prepared, byteBudget, maxSegments)
    try { for (const group of batches) {
      signal.throwIfAborted()
      if (!surfaceMatchesManifest(session, manifest)) { restore(session); return decision }
      const candidates = group.filter(candidate => session.surface.nodes.includes(candidate.seq))
      if (!candidates.length || ctx.tools.get(tool.name, agent, toolSet) !== tool) continue
      const segments = candidates.flatMap(candidate => candidate.segments)
      const optimization = await runtime.optimize({
        scope, binding, adapter: ADAPTER, manifest,
        candidates: segments,
        model: { provider: modelSelection.provider, id: modelSelection.model, protocol: 'dsh' },
        recoveryOverheadText: JSON.stringify(published), signal,
      })
      signal.throwIfAborted()
      if (!surfaceMatchesManifest(session, manifest) || ctx.tools.get(tool.name, agent, toolSet) !== tool) {
        restore(session)
        return decision
      }
      if (!optimization.replacements.length) continue
      const updates = new Map<Candidate, Map<number, string>>()
      let invalid = false
      for (const replacement of optimization.replacements) {
        const candidate = candidates.find(item => item.segments.some(segment => segment.id === replacement.segment_id))
        const segment = candidate?.segments.find(item => item.id === replacement.segment_id)
        if (!candidate || !segment || replacement.source_id !== candidate.sourceId || !session.surface.nodes.includes(candidate.seq)) { invalid = true; break }
        const changes = updates.get(candidate) ?? new Map<number, string>()
        if (changes.has(segment.index)) { invalid = true; break }
        changes.set(segment.index, replacement.text)
        updates.set(candidate, changes)
      }
      if (invalid) continue
      for (const [candidate, changes] of updates) {
        const message = freezeMessage<ToolResultMessage>({
          ...candidate.event.data.message,
          content: candidate.event.data.message.content.map((block, index) => changes.has(index) ? { type: 'text', text: changes.get(index)! } : block),
        })
        const replaced = session.append('tool/result', { ...candidate.event.data, message }, {
          surfaceOp: { op: 'replace', startSeq: candidate.seq, endSeq: candidate.seq }, sourceEventSeqs: [candidate.seq],
        })
        const key = String(session.id)
        const work = pending.get(key) ?? { session, replacements: [], optimizations: new Map<Optimization, boolean>() }
        work.optimizations.set(optimization, true)
        work.replacements.push({ seq: replaced.seq, original: candidate.event, optimization, sentBlocks: [...changes].map(([index, text]) => ({ index, text })) })
        pending.set(key, work)
      }
    } } catch (error) {
      restore(session)
      throw error
    }
    return decision
  })
}
