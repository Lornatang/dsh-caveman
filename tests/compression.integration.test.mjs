import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as plugin from '../lib/index.js'

const proxyBinary = process.env.CAVEMAN_PROXY_BINARY
const original = Array.from({ length: 1200 }, (_, i) => `INFO request ${i} GET /api/test status=200 duration=12ms`).join('\n')

async function startProxy() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-test-'))
  const probe = createServer()
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).on('error', reject))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const child = spawn(proxyBinary, ['serve'], {
    windowsHide: true,
    env: { ...process.env, CAVEMAN_HOME: directory, CAVEMAN_CONFIG: join(directory, 'missing.yaml'), CAVEMAN_LISTEN: `127.0.0.1:${port}`, CAVEMAN_MODE: 'compress', CAVEMAN_MIDDLEWARE_MODE: 'compress' },
    stdio: 'ignore',
  })
  const endpoint = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${endpoint}/caveman/v1/middleware/capabilities`)).ok) break } catch {}
    if (child.exitCode !== null) throw new Error(`proxy exited: ${child.exitCode}`)
    if (attempt === 99) throw new Error('proxy did not start')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return {
    endpoint,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill()
        await exited
      }
    },
    async close() {
      await this.stop()
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-test-')) throw new Error('unexpected test directory')
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function call(id, name, args) {
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class LocalAdapter extends LlmAdapter {
  requests = []
  onCompressed
  constructor(onCompressed) { super(); this.onCompressed = onCompressed }
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    let chunks
    if (this.requests.length === 1) chunks = call('output-call', 'large_fixture', {})
    else if (this.requests.length === 2) {
      const text = options.messages.filter(message => message.role === 'tool').at(-1)?.content?.[0]?.text ?? ''
      const handle = /handle=(cmw_[a-f0-9]{48})/.exec(text)?.[1]
      if (handle) await this.onCompressed?.()
      chunks = handle ? call('retrieve-call', 'caveman_retrieve', { handle }) : [{ type: 'finish', reason: { kind: 'stop' } }]
    } else chunks = [{ type: 'finish', reason: { kind: 'stop' } }]
    for (const chunk of chunks) yield chunk
  }
}

async function exerciseRecovery(stopBeforeRecovery, denyRecovery = false, failRestoreOnce = false) {
  const service = await startProxy()
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: true, middlewareEndpoint: service.endpoint })
    ctx.tools.register(defineTool({
      name: 'large_fixture', description: 'Return a large sample.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return original },
    }))
    const adapter = new LocalAdapter(stopBeforeRecovery ? () => service.stop() : undefined)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create('compression-session', { provider: 'mock', model: 'mock' })
    if (denyRecovery) agent.ctx.get('tools').restrict({ deny: ['caveman_retrieve'] })
    let restoreFailed = false
    if (failRestoreOnce) {
      const append = agent.session.append.bind(agent.session)
      agent.session.append = (type, data, options) => {
        if (!restoreFailed && type === 'tool/result' && options?.sourceEventSeqs?.length === 2) {
          restoreFailed = true
          throw new Error('injected transient restore failure')
        }
        return append(type, data, options)
      }
    }
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the sample.' }] }))
    await agent.whenIdle()
    if (failRestoreOnce) {
      assert.ok(restoreFailed, 'the test exercised a failed restoration')
      const visible = agent.session.surface.nodes.map(seq => agent.session.eventAt(seq))
      assert.ok(visible.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'output-call' && event.data.message.content[0]?.text === original), 'idle cleanup retries restoration after a transient failure')
      return
    }
    if (denyRecovery) {
      assert.equal(adapter.requests.length, 2)
      const visible = adapter.requests[1].messages.filter(message => message.role === 'tool').at(-1).content[0].text
      assert.equal(visible, original, 'without a callable recovery tool the original passes through')
      return
    }
    assert.equal(adapter.requests.length, 3, 'model can invoke recovery after seeing compressed output')
    const compressed = adapter.requests[1].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    assert.ok(compressed.length < original.length / 4)
    const recovered = adapter.requests[2].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    assert.equal(JSON.parse(recovered).text, original)
    assert.ok(agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.content[0]?.text === original), 'the original event remains in the session log')
    const visible = agent.session.surface.nodes.map(seq => agent.session.eventAt(seq))
    assert.ok(visible.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'output-call' && event.data.message.content[0]?.text === original), 'the visible session is restored after dispatch')
  } finally {
    await ctx.fiber.dispose()
    await service.close()
  }
}

test('DSH compresses recoverably while preserving the original session event', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(false)
})

test('the original remains recoverable from the session if the proxy stops', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(true)
})

test('a restricted recovery tool prevents shortening', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(false, true)
})

test('a transient restore error does not strand compressed content on the session surface', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(false, false, true)
})
