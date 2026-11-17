import { createRequire } from 'node:module'

export type VoiceMode = 'off' | 'caveman' | 'ultracave' | 'megacave'
export type DefaultMode = VoiceMode | 'manual'
export type ModeAction = 'none' | 'change' | 'status' | 'one-shot' | 'unresolved'

interface InputMessage {
  readonly source: { readonly kind: string }
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}
interface InputEvent { readonly type: string; readonly data: unknown }
interface ParsedChange { action: 'set' | 'clear' | 'status' | 'unresolved'; mode?: string }

const require = createRequire(import.meta.url)
const upstream = require('../upstream/src/hooks/caveman-parse.js') as {
  parseModeChange(prompt: string, options: { getDefaultMode: () => string }): ParsedChange | null
  INDEPENDENT_MODES: Set<string>
}
const upstreamConfig = require('../upstream/src/hooks/caveman-config.js') as { getDefaultMode(startDir?: string): string }

/** A profile override wins; otherwise follow upstream environment and file resolution. */
export function defaultModeFor(configured: DefaultMode | undefined, cwd?: string): DefaultMode {
  if (configured !== undefined) return configured
  const mode = upstreamConfig.getDefaultMode(cwd)
  return mode === 'manual' || mode === 'off' || mode === 'caveman' || mode === 'ultracave' || mode === 'megacave' ? mode : 'caveman'
}

function transition(mode: VoiceMode, message: InputMessage, configured: DefaultMode): { mode: VoiceMode; action: ModeAction } {
  if (message.source.kind !== 'user') return { mode, action: 'none' }
  const text = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  const change = upstream.parseModeChange(text, { getDefaultMode: () => configured })
  if (!change) return { mode, action: 'none' }
  if (change.action === 'status') return { mode, action: 'status' }
  if (change.action === 'unresolved') return { mode, action: 'unresolved' }
  if (change.action === 'clear') return { mode: 'off', action: 'change' }
  if (change.mode && upstream.INDEPENDENT_MODES.has(change.mode)) return { mode, action: 'one-shot' }
  if (change.mode === 'caveman' || change.mode === 'ultracave' || change.mode === 'megacave') {
    return { mode: change.mode, action: 'change' }
  }
  return { mode, action: 'none' }
}

/** Replay only user-authored messages, then evaluate the incoming batch. */
export function resolveMode(configured: DefaultMode, events: readonly InputEvent[], pending: readonly InputMessage[]): { mode: VoiceMode; action: ModeAction } {
  let mode: VoiceMode = configured === 'manual' ? 'off' : configured
  for (const event of events) {
    if (event.type !== 'user/message' || !event.data || typeof event.data !== 'object') continue
    const message = event.data as InputMessage
    if (!message.source || !Array.isArray(message.content)) continue
    mode = transition(mode, message, configured).mode
  }
  let action: ModeAction = 'none'
  for (const message of pending) {
    const result = transition(mode, message, configured)
    mode = result.mode
    if (result.action !== 'none') action = result.action
  }
  return { mode, action }
}
