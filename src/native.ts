import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { cavemanSessionId } from './attribution.js'
import { verifiedRuntime } from './runtime.js'
import { isManagedTool } from './compression.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-caveman-native': { kind: 'dsh-caveman-native'; form: 'notice' }
  }
}

type PolicyMode = 'record' | 'safe' | 'max'
interface NativeResponse { protocol_version: 1; action: string; visibility: string; fail_open: true; context?: string }
const profiles = new Set(['record-only', 'core', 'core-lean-build', 'ledger', 'ccr-masking', 'cache-aware', 'full-safe', 'full-max'])
const stopwords = new Set(['about', 'after', 'again', 'agent', 'before', 'build', 'change', 'code', 'could', 'create', 'does', 'from', 'have', 'help', 'implement', 'into', 'make', 'please', 'project', 'repository', 'should', 'spec', 'task', 'that', 'their', 'then', 'there', 'these', 'they', 'this', 'through', 'user', 'want', 'what', 'when', 'where', 'which', 'with', 'would', 'your'])

/** Hash and classify the prompt locally; the runtime does not receive the prompt text. */
export function nativePrompt(prompt: string): { prompt: { bytes: number; sha256: string }; task_profile: { type: string; terms: string[]; continuation: boolean } } {
  const text = prompt.toLowerCase()
  const type = /\b(migrat(?:e|ion)|schema change|backfill|rollback)\b/u.test(text) ? 'migration'
    : /\b(bug|fix|broken|regression|crash|error|fails?|incorrect)\b/u.test(text) ? 'bugfix'
      : /\b(investigat(?:e|ion)|diagnos(?:e|is)|root cause|why does|trace)\b/u.test(text) ? 'investigation'
        : /\b(refactor|restructure|reorganize|cleanup|clean up)\b/u.test(text) ? 'refactor'
          : /\b(review|audit|critique|assess)\b/u.test(text) ? 'review'
            : /\b(verif(?:y|ication)|test only|prove|validate|check that)\b/u.test(text) ? 'verification'
              : /\b(build|implement|add|create|ship|feature)\b/u.test(text) ? 'feature' : 'general'
  const seen = new Set<string>()
  for (const raw of prompt.match(/[A-Za-z][A-Za-z0-9_./-]{2,63}/gu) ?? []) {
    const term = raw.toLowerCase().replace(/^[-./]+|[-./]+$/gu, '')
    if (term.length < 3 || term.length > 64 || term.includes('..') || term.startsWith('/') || stopwords.has(term) ||
      /^(?:sk|pk|rk|ghp|github_pat|xox[baprs]|akia)[-_]/iu.test(term) || /^[a-z0-9_-]{40,}$/iu.test(term)) continue
    seen.add(term)
    if (seen.size === 12) break
  }
  const trimmed = text.trim()
  const continuation = Boolean(trimmed && trimmed.length <= 160 && trimmed.split(/\s+/u).length <= 14 &&
    /^(?:please\s+)?(?:continue|go ahead|keep going|proceed|do (?:it|that)|fix (?:it|that)|retry|try again|explain (?:it|that)|what do you mean|yes|yep|yeah|why\??|how\??)[.!?\s]*$/u.test(trimmed))
  const bytes = Buffer.from(prompt, 'utf8')
  return { prompt: { bytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }, task_profile: { type, terms: [...seen], continuation } }
}

/** Name the same per-install socket as the local runtime. */
export function nativeSocketPath(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return join(home, 'run', 'native.sock')
  let folded = ''
  for (const char of win32.resolve(home)) folded += String.fromCodePoint(char.toLowerCase().codePointAt(0)!)
  return `\\\\.\\pipe\\caveman-native-${createHash('sha256').update(folded).digest('hex').slice(0, 16)}`
}

function validResponse(value: unknown): value is NativeResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (response.protocol_version !== 1 || response.fail_open !== true || !['allow', 'observe', 'block', 'ask', 'defer'].includes(String(response.action)) ||
    !['silent', 'advisory', 'user'].includes(String(response.visibility))) return false
  if (response.policy_mode !== undefined && !['record', 'safe', 'max'].includes(String(response.policy_mode))) return false
  if (response.profile !== undefined && !profiles.has(String(response.profile))) return false
  for (const [key, maximum] of [['context', 65536], ['message', 4096], ['output_replacement', 2097152], ['recovery_ref', 1024], ['decision_id', 256]] as const) {
    const field = response[key]
    if (field !== undefined && (typeof field !== 'string' || Buffer.byteLength(field, 'utf8') > maximum)) return false
  }
  return true
}

async function nativeCall(home: string, request: object, signal?: AbortSignal): Promise<NativeResponse | undefined> {
  if (signal?.aborted) return undefined
  const payload = Buffer.from(JSON.stringify(request) + '\n')
  if (payload.length > 2 * 1024 * 1024) return undefined
  return new Promise(resolveResponse => {
    let finished = false
    let size = 0
    const chunks: Buffer[] = []
    const socket = connect({ path: nativeSocketPath(home) })
    const finish = (response?: NativeResponse): void => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      resolveResponse(response)
    }
    const abort = (): void => finish()
    signal?.addEventListener('abort', abort, { once: true })
    socket.setTimeout(250)
    socket.once('connect', () => { if (!finished) socket.end(payload) })
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) return finish()
      chunks.push(chunk)
    })
    socket.once('end', () => {
      try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); finish(validResponse(parsed) ? parsed : undefined) } catch { finish() }
    })
    socket.once('timeout', () => finish())
    socket.once('error', () => finish())
  })
}

async function inputState(cwd: string, input: unknown): Promise<string | undefined> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const values = input as Record<string, unknown>
  const path = [values.path, values.file_path, values.file, values.filename].find(value => typeof value === 'string' && value.trim())
  if (typeof path !== 'string' || path.includes('\0')) return undefined
  try {
    const absolute = resolve(cwd, path)
    const [resolved, info] = await Promise.all([realpath(absolute), stat(absolute)])
    const identity = JSON.stringify({ path: resolved, size: info.size, mtime_ms: info.mtimeMs, mode: info.mode })
    return `sha256:${createHash('sha256').update(identity).digest('hex')}`
  } catch { return undefined }
}

async function runtimeInstance(endpoint: string, home: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!await verifiedRuntime(endpoint, process.env, signal)) return undefined
  try {
    const port = Number(new URL(endpoint).port || 80)
    const token: unknown = JSON.parse(readFileSync(join(home, 'run', `${port}.json`), 'utf8')).instance_token
    return typeof token === 'string' && token ? token : undefined
  } catch { return undefined }
}

/** Add dynamic native task context when the verified local runtime is running. */
export function registerNative(ctx: Context, endpoint: string, policy: { mode: PolicyMode; profile: string; core: boolean }): void {
  interface SessionState { instance: string; session: { caveman_session_id: string; host_session_id: string; cwd: string }; queue?: Promise<void>; contexts: string[] }
  const sessions = new WeakMap<Agent, SessionState>()
  const owners = new WeakMap<Session, Agent>()
  const selections = new WeakMap<Agent, ResolvedToolSet>()
  const pending = new Set<Promise<unknown>>()
  const home = process.env.CAVEMAN_HOME ?? join(homedir(), '.caveman')
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    if (context.agent && context.toolSet) selections.set(context.agent, context.toolSet)
    return result
  })
  ctx.on('agent/pre-step', async ({ agent, modelSelection, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)
    if (preset === 'cavecrew-investigator' || preset === 'cavecrew-builder' || preset === 'cavecrew-reviewer') return decision
    const existing = sessions.get(agent)
    if (existing?.queue) await existing.queue
    const toolSet = selections.get(agent)
    const canRecover = toolSet && ctx.tools.get('mcp__caveman__caveman_retrieve', agent, toolSet)
    const contexts = policy.core ? (existing?.contexts.splice(0) ?? []).filter(text => !text.includes('ccr://') || canRecover) : []
    const withContexts = () => {
      if (!contexts.length) return decision
      const reminder = createUserMessage({ source: { kind: 'dsh-caveman-native', form: 'notice' }, content: [{ type: 'text', text: contexts.join('\n\n') }] })
      return { ...decision, messages: [...decision.messages, reminder] }
    }
    const prompts = decision.messages.filter(message => message.source.kind === 'user')
      .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).filter(Boolean)
    if (!prompts.length) return withContexts()
    const instance = await runtimeInstance(endpoint, home, signal)
    if (!instance) { sessions.delete(agent); return withContexts() }
    const directory = ctx.get('workingDirectory')
    const cwd = directory ? await directory.ensure(agent, signal) : agent.session.header.cwd ?? process.cwd()
    const id = cavemanSessionId(String(agent.session.id))
    const session = { caveman_session_id: id, host_session_id: id, cwd }
    const base = { protocol_version: 1, policy_mode: policy.mode, profile: policy.profile, agent: { id: 'dsh', surface: 'dsh' }, session,
      model: { provider: modelSelection.provider, model: modelSelection.model } }
    const current = sessions.get(agent)
    if (!current || current.instance !== instance) {
      const started = await nativeCall(home, { ...base, event: { type: 'session.start', timestamp_ms: Date.now() } }, signal)
      if (!started) { sessions.delete(agent); return withContexts() }
      sessions.set(agent, { instance, session, contexts: [] })
      owners.set(agent.session, agent)
    }
    for (const prompt of prompts) {
      signal.throwIfAborted()
      const response = await nativeCall(home, { ...base, event: { type: 'prompt.submit', timestamp_ms: Date.now() }, ...nativePrompt(prompt) }, signal)
      if (!response) { sessions.delete(agent); break }
      if (policy.core && response.context && (!response.context.includes('ccr://') || canRecover)) contexts.push(response.context)
    }
    return withContexts()
  })
  ctx.on('session/event', (session, event) => {
    const kind = event.type as string
    if (kind !== 'compaction/start' && kind !== 'compaction/end') return
    if (kind === 'compaction/end' && 'error' in event.data && event.data.error) return
    const agent = owners.get(session)
    const state = agent && sessions.get(agent)
    if (!agent || !state) return
    const task = (state.queue ?? Promise.resolve()).then(async () => {
      if (sessions.get(agent) !== state || await runtimeInstance(endpoint, home) !== state.instance) return
      const response = await nativeCall(home, { protocol_version: 1, policy_mode: policy.mode, profile: policy.profile,
        agent: { id: 'dsh', surface: 'dsh' }, session: state.session,
        event: { type: kind === 'compaction/start' ? 'context.compact.before' : 'context.compact.after', timestamp_ms: Date.now() } })
      if (kind === 'compaction/end' && response?.context) state.contexts.push(response.context)
    }).catch(() => {})
    state.queue = task
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (!exec.agent || exec.name === 'run_code' || isManagedTool(exec.name)) return next()
    const state = sessions.get(exec.agent)
    if (!state) return next()
    if (await runtimeInstance(endpoint, home, exec.signal) !== state.instance) { sessions.delete(exec.agent); return next() }
    const base = { protocol_version: 1, policy_mode: policy.mode, profile: policy.profile, agent: { id: 'dsh', surface: 'dsh' }, session: state.session }
    const beforeState = await inputState(state.session.cwd, exec.arguments)
    const before = await nativeCall(home, { ...base, event: { type: 'tool.before', timestamp_ms: Date.now() },
      tool: { name: exec.name, input: exec.arguments, ...(beforeState ? { input_state: beforeState } : {}) } }, exec.signal)
    if (!before) { sessions.delete(exec.agent); return next() }
    const result = await next()
    if (!exec.signal.aborted && await runtimeInstance(endpoint, home, exec.signal) === state.instance) {
      const afterState = await inputState(state.session.cwd, exec.arguments)
      const textOnly = result.content.every(block => block.type === 'text') && result.content.reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0) <= 1_500_000
      const content = textOnly ? result.content.map(block => block.type === 'text' ? block.text : '').join('\n') : ''
      await nativeCall(home, { ...base, event: { type: result.isError ? 'tool.failure' : 'tool.after', timestamp_ms: Date.now() },
        tool: { name: exec.name, input: exec.arguments, ...(afterState ? { input_state: afterState } : {}), ...(content ? { output: Buffer.from(content).toString('base64') } : {}) } }, exec.signal)
    }
    const canRecover = exec.toolSet && ctx.tools.get('mcp__caveman__caveman_retrieve', exec.agent, exec.toolSet)
    if (!policy.core || !before?.context || (before.context.includes('ccr://') && !canRecover) || exec.signal.aborted) return result
    const reminder = createUserMessage({ source: { kind: 'dsh-caveman-native', form: 'notice' }, content: [{ type: 'text', text: before.context }] })
    return { ...result, additionalContexts: [...result.additionalContexts ?? [], reminder] }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = sessions.get(agent)
    if (!state) return
    sessions.delete(agent)
    const task = (state.queue ?? Promise.resolve()).then(() => runtimeInstance(endpoint, home)).then(instance => instance === state.instance
      ? nativeCall(home, { protocol_version: 1, policy_mode: policy.mode, profile: policy.profile,
        agent: { id: 'dsh', surface: 'dsh' }, session: state.session, event: { type: 'session.end', timestamp_ms: Date.now() } })
      : undefined)
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  ctx.effect(() => async () => { await Promise.allSettled([...pending]) }, 'dsh-caveman:native')
}
