import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'

type Binary = 'blocks' | 'browse'
type Module = 'scripts' | 'browse' | 'input'

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch { return false }
}

function pathCommand(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const names = process.platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? [name, `${name}.exe`] : [name]
  for (const dir of dirs) for (const candidate of names) {
    const path = resolve(dir, candidate)
    if (executable(path)) return path
  }
  return undefined
}

/** Find a configured binary, PATH command, or the CLI's installation. */
export function findCavemanBinary(kind: Binary, configured?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error(`dsh-caveman: ${kind}Binary must be an absolute path`)
    return configured
  }
  const override = env[kind === 'blocks' ? 'CAVEMAN_BLOCKS_BIN' : 'CAVEMAN_BROWSE_BIN']
  if (override) {
    if (isAbsolute(override) || /[\\/]/u.test(override)) {
      const absolute = resolve(override)
      return executable(absolute) ? absolute : undefined
    }
    return pathCommand(override, env)
  }
  const name = `caveman-${kind}`
  const onPath = pathCommand(name, env)
  if (onPath) return onPath
  const filename = process.platform === 'win32' ? `${name}.exe` : name
  const local = resolve(env.CAVEMAN_HOME ?? join(homedir(), '.caveman'), 'bin', filename)
  return executable(local) ? local : undefined
}

/** Modules default to on; a saved explicit off is respected. */
export function moduleEnabled(kind: Module, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const home = env.CAVEMAN_HOME ?? join(homedir(), '.caveman')
    let raw: string
    try { raw = readFileSync(join(home, 'cloud.json'), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      raw = readFileSync(join(homedir(), '.caveman-cloud', 'config.json'), 'utf8')
    }
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/u, ''))
    const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
    const document = object(parsed)
    const selected = object(document.modules)[kind]
    if (typeof selected === 'boolean') return selected
    if (kind === 'input') {
      const setting = object(document.think).mode ?? object(document.wrap).mode
      return setting !== 'record'
    }
    if (kind !== 'browse') return true
    const setting = object(document.execute).browse_tool ?? object(document.wrap).browse
    return setting !== false && !(typeof setting === 'string' && ['0', 'false', 'no', 'off'].includes(setting.trim().toLowerCase()))
  } catch { return true }
}

function localOrigin(endpoint: string): URL | undefined {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' || url.username || url.password || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined
    return url
  } catch { return undefined }
}

// Use an explicit direct connection, even when the host process uses an HTTP proxy.
async function directLocalFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const request = new Request(input, init)
  const url = localOrigin(request.url)
  if (!url) throw new Error('Caveman runtime must use a loopback HTTP address')
  const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer())
  return new Promise<Response>((resolveResponse, reject) => {
    const child = httpRequest({
      hostname: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/gu, ''),
      port: url.port || 80, path: `${url.pathname}${url.search}`, method: request.method,
      headers: Object.fromEntries(request.headers), signal: request.signal, agent: false,
    }, response => {
      try {
        const status = response.statusCode ?? 500
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item)
          else if (value !== undefined) headers.set(name, value)
        }
        const empty = status === 204 || status === 205 || status === 304
        if (empty) response.resume()
        const stream = empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>
        resolveResponse(new Response(stream, { status, statusText: response.statusMessage, headers }))
      } catch (error) {
        response.destroy()
        reject(error)
      }
    })
    child.once('error', reject)
    child.end(body)
  })
}

/** Verify that the loopback listener matches the runtime's private run-state record. */
export async function verifiedRuntime(endpoint: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const url = localOrigin(endpoint)
  if (!url) return false
  const port = Number(url.port || 80)
  try {
    const home = env.CAVEMAN_HOME ?? join(homedir(), '.caveman')
    const state: unknown = JSON.parse(readFileSync(join(home, 'run', `${port}.json`), 'utf8'))
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false
    const run = state as Record<string, unknown>
    if (run.schema !== 'caveman.proxy.run.v1' || (run.owner !== 'start' && run.owner !== 'wrap') ||
      typeof run.pid !== 'number' || run.port !== port || typeof run.instance_token !== 'string' || !run.instance_token) return false
    const timeout = AbortSignal.timeout(750)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const health = await directLocalFetch(`${url.origin}/health/live`, { signal: combined })
    const matches = health.ok && health.headers.get('x-caveman-instance') === run.instance_token
    await health.body?.cancel()
    return matches
  } catch {
    signal?.throwIfAborted()
    return false
  }
}

/** Guard every automatic middleware call against a different or replaced listener. */
export function guardedRuntimeFetch(endpoint: string, env: NodeJS.ProcessEnv = process.env): typeof fetch {
  const origin = localOrigin(endpoint)?.origin
  return async (input, init) => {
    const request = new Request(input, init)
    if (!origin || localOrigin(request.url)?.origin !== origin || !await verifiedRuntime(endpoint, env, request.signal)) {
      throw new Error('Caveman runtime is unavailable or unverified')
    }
    return directLocalFetch(request)
  }
}
