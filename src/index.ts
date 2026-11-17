import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createSkillProvider } from './skills.js'
import { defaultModeFor, resolveMode, type DefaultMode, type VoiceMode } from './mode.js'
import { registerCompression } from './compression.js'
import { registerBlocks } from './blocks.js'
import { sessionStats } from './stats.js'
import { findCavemanBinary, moduleEnabled } from './runtime.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-caveman-mode': { kind: 'dsh-caveman-mode'; form: 'instructions'; mode: VoiceMode }
    'dsh-caveman-stats': { kind: 'dsh-caveman-stats'; form: 'notice' }
  }
}

export const name = 'caveman'
export const inject = ['skills', 'tools', 'systemPrompt', 'llm']

export interface Config { defaultMode?: DefaultMode; inputCompression?: boolean; middlewareEndpoint?: string; blocksBinary?: string; browseBinary?: string }
export const Config: z<Config> = z.object({
  defaultMode: z.union([
    z.const('caveman'), z.const('ultracave'), z.const('megacave'), z.const('off'), z.const('manual'),
  ]),
  inputCompression: z.boolean().default(false),
  middlewareEndpoint: z.string().default('http://127.0.0.1:8787'),
  blocksBinary: z.string().min(1),
  browseBinary: z.string().min(1),
})

/** Register skills and reinforce the selected mode per session. */
export function apply(ctx: Context, config: Config = {}): void {
  const root = fileURLToPath(new URL('../vendor/caveman/skills/', import.meta.url))
  ctx.skills.registerProvider(control => createSkillProvider(root, control))
  if (config.inputCompression) registerCompression(ctx, config.middlewareEndpoint ?? 'http://127.0.0.1:8787')
  const blocks = moduleEnabled('scripts') ? findCavemanBinary('blocks', config.blocksBinary) : undefined
  if (blocks) registerBlocks(ctx, blocks)
  const browse = moduleEnabled('browse') ? findCavemanBinary('browse', config.browseBinary) : undefined
  if (browse) {
    ctx.inject(['mcpManager'], scoped => {
      if (!scoped.mcpManager.list().some(entry => entry.name === 'caveman_browse' && entry.configured)) {
        scoped.mcpManager.register('caveman_browse', { transport: 'stdio', command: browse, args: [] })
      }
    })
  }
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)
    if (preset === 'cavecrew-investigator' || preset === 'cavecrew-builder' || preset === 'cavecrew-reviewer') return decision
    const directMessages = decision.messages.filter(message => message.source.kind === 'user')
    if (directMessages.length === 0) return decision
    signal.throwIfAborted()
    const statsRequest = directMessages.map(message => message.content
      .filter(block => block.type === 'text').map(block => block.text).join('\n'))
      .map(text => /^\/caveman(?::caveman)?-stats(?:\s+(.*))?$/u.exec(text.trim()))
      .reverse().find(match => match !== null)
    if (statsRequest) {
      const report = sessionStats(agent.session.snapshotEvents(), statsRequest[1]?.trim() ?? '')
      const reminder = createUserMessage({
        source: { kind: 'dsh-caveman-stats', form: 'notice' },
        content: [{ type: 'text', text: `Print this report verbatim in a fenced code block. Do not infer savings.\n\n${report}` }],
      })
      return { ...decision, messages: [...decision.messages, reminder] }
    }
    const directory = ctx.get('workingDirectory') as { ensure(agent: Agent, signal: AbortSignal): Promise<string> } | undefined
    const cwd = directory ? await directory.ensure(agent, signal) : agent.session.header.cwd
    const selected = resolveMode(defaultModeFor(config.defaultMode, cwd), agent.session.snapshotEvents(), directMessages)
    if (selected.action === 'one-shot' || (selected.mode === 'off' && selected.action === 'none')) return decision
    let text: string
    if (selected.action === 'status') {
      text = `Report this status without changing it: Caveman mode: ${selected.mode}`
    } else if (selected.action === 'unresolved') {
      text = 'The requested Caveman mode is not recognized. Keep the current mode unchanged and explain the valid commands.'
    } else if (selected.mode === 'off') {
      text = 'Caveman mode is off. Stop following previous Caveman mode instructions and resume the normal response style.'
    } else {
      const skill = await ctx.skills.get(selected.mode, { scope: agent, signal })
      signal.throwIfAborted()
      if (!skill) throw new Error(`dsh-caveman: ${selected.mode} skill is unavailable`)
      text = `Caveman mode: ${selected.mode}\n\n${skill.content}`
    }
    const reminder = createUserMessage({
      source: { kind: 'dsh-caveman-mode', form: 'instructions', mode: selected.mode },
      content: [{ type: 'text', text }],
    })
    return { ...decision, messages: [...decision.messages, reminder] }
  })
}
