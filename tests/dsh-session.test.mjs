import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SkillRegistry from '@deepseek-ai/dsh-skill'

const plugin = await import('../lib/index.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/lib/index.js')) return undefined
  throw error
})

class LocalAdapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function send(agent, text) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
}

test('a real DSH agent receives mode rules and stop leaves another session untouched', async () => {
  assert.ok(plugin, 'DSH plugin entry is implemented')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, { defaultMode: 'manual' })
  const adapter = new LocalAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  try {
    const first = await ctx.agentLoop.create('first', { provider: 'mock', model: 'mock' })
    const second = await ctx.agentLoop.create('second', { provider: 'mock', model: 'mock' })
    await send(first, '/ultracave')
    await send(second, '/megacave')
    await send(first, 'stop caveman')
    await send(second, 'continue')
    const modeEvents = agent => agent.session.snapshotEvents()
      .filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-caveman-mode')
    assert.deepEqual(modeEvents(first).map(event => event.data.source.mode), ['ultracave', 'off'])
    assert.deepEqual(modeEvents(second).map(event => event.data.source.mode), ['megacave', 'megacave'])
    assert.match(modeEvents(first)[0].data.content[0].text, /ultracave/i)
    assert.match(modeEvents(first)[1].data.content[0].text, /off/i)
    assert.equal(adapter.requests.length, 4)
    assert.ok(first.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.content[0].text === '/ultracave'))
  } finally {
    await ctx.fiber.dispose()
  }
})
