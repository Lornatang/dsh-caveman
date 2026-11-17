import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

const root = fileURLToPath(new URL('../upstream/skills/', import.meta.url))

async function providerModule() {
  try { return await import('../lib/skills.js') } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/lib/skills.js')) return undefined
    throw error
  }
}

test('the DSH skill registry serves the unmodified upstream voice and its resources', async () => {
  const module = await providerModule()
  assert.ok(module, 'skill provider is implemented')
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const dispose = ctx.skills.registerProvider(() => module.createSkillProvider(root))
  try {
    const catalog = await ctx.skills.list()
    for (const name of ['caveman', 'ultracave', 'megacave', 'caveman-help', 'caveman-commit', 'caveman-review', 'caveman-compress']) {
      assert.ok(catalog.some(candidate => candidate.name === name), `${name} is discoverable`)
    }
    const skill = await ctx.skills.get('caveman')
    const original = await readFile(new URL('../upstream/skills/caveman/SKILL.md', import.meta.url), 'utf8')
    const body = original.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim()
    assert.equal(skill.content, body)
    assert.equal(skill.resourceBase.kind, 'directory')
    assert.ok(skill.resourceBase.path.endsWith('/caveman'))
  } finally {
    dispose()
    assert.equal((await ctx.skills.list()).length, 0)
    await ctx.fiber.dispose()
  }
})
