import { readFile } from 'node:fs/promises'
import { normalize } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'cavecrew'
export const inject = ['tools', 'systemPrompt']
export interface Config { role: 'investigator' | 'builder' | 'reviewer' }
export const Config: z<Config> = z.object({
  role: z.union([z.const('investigator'), z.const('builder'), z.const('reviewer')]).required(),
})

/** Install one original Cavecrew persona and keep its agent's tools bounded. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const original = await readFile(new URL(`../upstream/agents/cavecrew-${config.role}.md`, import.meta.url), 'utf8')
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(original)
  if (!frontmatter) throw new Error(`dsh-caveman: missing Cavecrew metadata for ${config.role}`)
  const body = original.slice(frontmatter[0].length).trim()
  ctx.systemPrompt.section({
    name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: body, interpolate: false,
  })
  ctx.systemPrompt.section({
    name: 'deployment:persona-suffix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: '', interpolate: false,
  })
  const allowed = config.role === 'builder' ? ['read', 'edit'] : ['read', 'glob', 'grep']
  const permitted = new Set(allowed)
  const edited = new WeakMap<object, Set<string>>()
  ctx.tools.guard(exec => {
    if (!permitted.has(exec.name)) return `Cavecrew ${config.role} does not permit ${exec.name}.`
    if (config.role !== 'builder' || exec.name !== 'edit') return undefined
    if (!exec.agent || typeof exec.arguments !== 'object' || exec.arguments === null ||
      !('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string' || !exec.arguments.file_path.trim()) {
      return 'Cavecrew builder requires an existing file path.'
    }
    const path = normalize(exec.arguments.file_path)
    const paths = edited.get(exec.agent) ?? new Set<string>()
    if (!paths.has(path) && paths.size >= 2) return 'Cavecrew builder is limited to two file paths.'
    paths.add(path)
    edited.set(exec.agent, paths)
    return undefined
  })
  ctx.on('agent/created', ({ agent }) => {
    const available = allowed.filter(tool => ctx.tools.get(tool, agent) !== undefined)
    agent.ctx.tools.restrict({ allow: available })
    return undefined
  })
}
