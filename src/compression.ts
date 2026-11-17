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

function textOf(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result' || event.data.message.isError || event.data.message.content.length !== 1) return undefined
  const block = event.data.message.content[0]
  return block?.type === 'text' ? block.text : undefined
}

function originalForHandle(session: Session, handle: string): { text: string; sourceId: string } | undefined {
  for (const event of session.snapshotEvents()) {
    const text = textOf(event)
    if (!text || MARKER.exec(text)?.[1] !== handle || event.sourceEventSeqs?.length !== 1) continue
    const source = session.eventAt(event.sourceEventSeqs[0]!)
    const original = source && textOf(source)
    if (source && original !== undefined) return { text: original, sourceId: `seq-${source.seq}` }
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

function toolNameFor(session: Session, callId: string): string | undefined {
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type === 'tool-call' && block.id === callId) return block.name
    }
  }
  return undefined
}

function originalResult(session: Session, event: SessionEvent<'tool/result'>): SessionEvent<'tool/result'> {
  let current = event
  for (;;) {
    const previous = (current.sourceEventSeqs ?? []).map(seq => session.eventAt(seq))
      .filter((item): item is SessionEvent<'tool/result'> => item?.type === 'tool/result')
    if (!previous.length) return current
    const oldest = previous.reduce((a, b) => a.seq < b.seq ? a : b)
    if (oldest.seq >= current.seq) return current
    current = oldest
  }
}

function manifestFor(session: Session): { id: string; sha256: string }[] {
  return session.surface.nodes.map(seq => {
    let event = session.eventAt(seq)!
    if (event.type === 'tool/result') event = originalResult(session, event)
    const data = event.type === 'user/message' ? event.data : 'message' in event.data ? event.data.message : event.data
    return { id: `seq-${event.seq}`, sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') }
  })
}

/** Install recoverable compression using the middleware protocol. */
export function registerCompression(ctx: Context, endpoint: string, automatic?: {
  fetch: typeof fetch
  available: (signal: AbortSignal) => Promise<boolean>
}): void {
  const runtime = new MiddlewareRuntime({ endpoint, mode: 'compress', ...(automatic ? { fetch: automatic.fetch } : {}) })
  const pending = new Map<string, { session: Session; replacements: { seq: SessionSeq; original: SessionEvent<'tool/result'>; optimization: Optimization }[] }>()
  function restore(session: Session): Optimization[] {
    const key = String(session.id)
    const work = pending.get(key)
    if (!work || work.session !== session) return []
    const restored: Optimization[] = []
    while (work.replacements.length) {
      const replacement = work.replacements[0]!
      if (session.surface.nodes.includes(replacement.seq)) {
        session.append('tool/result', replacement.original.data, {
          surfaceOp: { op: 'replace', startSeq: replacement.seq, endSeq: replacement.seq },
          sourceEventSeqs: [replacement.seq, replacement.original.seq],
        })
        restored.push(replacement.optimization)
      }
      // Retain the current item until append succeeds so idle/disposal can
      // retry a transient restoration error without stranding the projection.
      work.replacements.shift()
    }
    pending.delete(key)
    return restored
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
    when: ({ agent, signal }) => agent.session.snapshotEvents().some(event => {
      const text = textOf(event)
      return text !== undefined && MARKER.test(text)
    }) || automatic.available(signal),
  } : undefined)
  ctx.effect(() => () => {
    try { for (const work of [...pending.values()]) restore(work.session) } finally { runtime.close() }
  }, 'dsh-caveman:runtime')

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && pending.has(String(agent.session.id))) restore(agent.session)
  })
  ctx.on('llm/stream', (options, next) => (async function* () {
    const work = options.sessionId === undefined ? undefined : pending.get(String(options.sessionId))
    const sentText = new Set(options.messages.filter(message => message.role === 'tool')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)))
    const containsReplacements = work?.replacements.every(replacement => {
      const event = work.session.eventAt(replacement.seq)
      const text = event && textOf(event)
      return text !== undefined && sentText.has(text)
    })
    if (work && containsReplacements) {
      const visible = options.tools?.find(entry => entry.name === tool.name)
      const valid = visible && visible.description === tool.description && isDeepStrictEqual(visible.parameters, tool.parameters)
      const restored = restore(work.session)
      if (!valid) throw new Error('dsh-caveman: recovery tool was not available for the compressed request')
      for (const optimization of restored) runtime.report(optimization)
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
    const eligible: { seq: SessionSeq; event: SessionEvent<'tool/result'>; text: string }[] = []
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq)
      if (!event || event.type !== 'tool/result') continue
      const text = textOf(event)
      if (!text || text.length < MINIMUM_TEXT_LENGTH || MARKER.test(text)) continue
      const toolName = toolNameFor(session, event.data.message.toolCallId)
      if (!toolName || toolName === tool.name) continue
      eligible.push({ seq, event, text })
    }
    if (!eligible.length) return decision
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent, modelSelection, toolSet, signal })
    const published = assembly.tools.find(entry => entry.name === tool.name)
    if (!published || published.description !== tool.description || !isDeepStrictEqual(published.parameters, tool.parameters)) return decision
    const scope = scopeFor(agent)
    const binding = runtime.recovery(scope)
    if (!binding) return decision
    try { for (const candidate of eligible) {
      signal.throwIfAborted()
      if (!session.surface.nodes.includes(candidate.seq) || ctx.tools.get(tool.name, agent, toolSet) !== tool) continue
      const original = originalResult(session, candidate.event)
      const id = `seq-${original.seq}`
      const optimization = await runtime.optimize({
        scope, binding, adapter: ADAPTER, manifest: manifestFor(session),
        candidates: [{ id, sourceId: id, kind: 'tool_result', content: candidate.text }],
        model: { provider: modelSelection.provider, id: modelSelection.model, protocol: 'dsh' },
        recoveryOverheadText: JSON.stringify(published), signal,
      })
      signal.throwIfAborted()
      const replacement = optimization.replacements[0]
      if (!replacement || optimization.replacements.length !== 1 || replacement.source_id !== id || !session.surface.nodes.includes(candidate.seq)) continue
      const message = freezeMessage<ToolResultMessage>({
        ...candidate.event.data.message, content: [{ type: 'text', text: replacement.text }],
      })
      const replaced = session.append('tool/result', { ...candidate.event.data, message }, {
        surfaceOp: { op: 'replace', startSeq: candidate.seq, endSeq: candidate.seq }, sourceEventSeqs: [candidate.seq],
      })
      const key = String(session.id)
      const work = pending.get(key) ?? { session, replacements: [] }
      work.replacements.push({ seq: replaced.seq, original, optimization })
      pending.set(key, work)
    } } catch (error) {
      restore(session)
      throw error
    }
    return decision
  })
}
