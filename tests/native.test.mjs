import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { nativeCall, nativePrompt, nativeSocketPath, recoveryIsPublished, registerNative } from '../lib/native.js'

test('native task classification sends a digest and bounded terms, not the raw prompt', () => {
  const prompt = 'Fix the regression in login with sk-secret-token and abcdefghijklmnopqrstuvwxyzabcdefghijklmn.'
  const result = nativePrompt(prompt)
  assert.equal(result.task_profile.type, 'bugfix')
  assert.equal(result.prompt.bytes, Buffer.byteLength(prompt))
  assert.match(result.prompt.sha256, /^sha256:[a-f0-9]{64}$/u)
  assert.ok(result.task_profile.terms.includes('login'))
  assert.ok(!result.task_profile.terms.includes('sk-secret-token'))
  assert.ok(!JSON.stringify(result).includes(prompt))
  assert.equal(nativePrompt('please continue').task_profile.continuation, true)
})

test('native socket naming matches the runtime on Windows', () => {
  assert.equal(nativeSocketPath('C:\\Users\\İlker\\ΝΙΚΟΣ\\.caveman', 'win32'), '\\\\.\\pipe\\caveman-native-4f3f9f7846224643')
  assert.equal(nativeSocketPath('C:/Users/Jane Doe/.caveman', 'win32'), '\\\\.\\pipe\\caveman-native-0b9a73ef77a5671a')
})

test('native recovery hints require a published direct tool or program binding', () => {
  const tool = { name: 'mcp__caveman__caveman_retrieve', description: 'Recover', parameters: { type: 'object', properties: {} } }
  assert.equal(recoveryIsPublished({ tools: [tool], sections: [] }, tool), true)
  assert.equal(recoveryIsPublished({ tools: [{ ...tool, description: 'different' }], sections: [] }, tool), false)
  const sdk = `interface ToolArgsMap {\n  ${tool.name}: unknown;\n}\ninterface ToolOutputMap {\n  ${tool.name}: string;\n}\ndeclare const tools: {}`
  assert.equal(recoveryIsPublished({ tools: [{ name: 'run_code' }], sections: [{ name: 'tools:sdk', interpolate: false, text: sdk }] }, tool), true)
  assert.equal(recoveryIsPublished({ tools: [{ name: 'run_code' }], sections: [] }, tool), false)
})

test('a newly starting native socket can be retried before any request was sent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-native-start-'))
  const server = createServer(socket => socket.once('data', () => socket.end(JSON.stringify({ protocol_version: 1, action: 'allow', visibility: 'silent', fail_open: true }) + '\n')))
  try {
    await mkdir(join(directory, 'run'))
    const response = nativeCall(directory, { event: 'fixture' })
    await new Promise(resolve => setTimeout(resolve, 15))
    await new Promise((resolve, reject) => server.listen(nativeSocketPath(directory), resolve).on('error', reject))
    assert.equal((await response)?.action, 'allow')
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-native-start-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('native responses are consumed as soon as a complete line arrives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-native-line-'))
  const connections = new Set()
  const server = createServer({ allowHalfOpen: true }, socket => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.once('data', () => socket.write(JSON.stringify({ protocol_version: 1, action: 'allow', visibility: 'silent', fail_open: true }) + '\n'))
  })
  try {
    await mkdir(join(directory, 'run'))
    await new Promise((resolve, reject) => server.listen(nativeSocketPath(directory), resolve).on('error', reject))
    const response = await nativeCall(directory, { event: 'fixture' })
    assert.equal(response?.action, 'allow', 'a complete response does not require the server to close its connection')
  } finally {
    for (const connection of connections) connection.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-native-line-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('a late native response has transport slack without repeating the request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-native-slack-'))
  let requests = 0
  const server = createServer(socket => socket.once('data', () => {
    requests++
    setTimeout(() => socket.end(JSON.stringify({ protocol_version: 1, action: 'allow', visibility: 'silent', fail_open: true }) + '\n'), 350)
  }))
  try {
    await mkdir(join(directory, 'run'))
    await new Promise((resolve, reject) => server.listen(nativeSocketPath(directory), resolve).on('error', reject))
    assert.equal((await nativeCall(directory, { event: 'fixture' }))?.action, 'allow')
    assert.equal(requests, 1)
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-native-slack-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('transient missing native responses do not discard the child session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-native-recovery-'))
  const previous = process.env.CAVEMAN_HOME
  const hooks = new Map()
  let cleanup
  const ctx = {
    on(name, callback) { hooks.set(name, callback) },
    effect(callback) { cleanup = callback() },
    get() { return undefined },
    tools: { get() { return undefined } },
  }
  const requests = []
  const missing = new Set(['subagent.start', 'prompt.submit', 'tool.before'])
  const socketServer = createServer(socket => {
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      if (!buffer.includes('\n')) return
      const request = JSON.parse(buffer)
      requests.push(request)
      if (missing.has(request.event.type)) socket.end()
      else socket.end(JSON.stringify({ protocol_version: 1, action: 'allow', visibility: 'silent', fail_open: true }) + '\n')
    })
  })
  const httpServer = createHttpServer((_request, response) => {
    response.writeHead(200, { 'x-caveman-instance': 'fixture-instance' }).end()
  })
  try {
    process.env.CAVEMAN_HOME = directory
    await mkdir(join(directory, 'run'))
    await new Promise((resolve, reject) => httpServer.listen(0, '127.0.0.1', resolve).on('error', reject))
    const port = httpServer.address().port
    await writeFile(join(directory, 'run', `${port}.json`), JSON.stringify({ schema: 'caveman.proxy.run.v1', owner: 'start', pid: process.pid, port, instance_token: 'fixture-instance' }))
    await new Promise((resolve, reject) => socketServer.listen(nativeSocketPath(directory), resolve).on('error', reject))
    registerNative(ctx, `http://127.0.0.1:${port}`, { mode: 'safe', profile: 'full-safe', core: true })
    const agent = { session: { id: 'child', header: { cwd: directory, origin: 'subagent', parentSession: 'parent' } } }
    const signal = new AbortController().signal
    const decision = { kind: 'continue', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect this file.' }] }] }
    await hooks.get('agent/pre-step')({ agent, signal, modelSelection: { provider: 'mock', model: 'mock' } }, async () => decision)
    const result = { content: [{ type: 'text', text: 'fixture result' }] }
    assert.equal(await hooks.get('tools/execute')({ agent, signal, name: 'fixture_tool', arguments: {} }, async () => result), result)
    hooks.get('agent/disposed')({ agent })
    await cleanup()
    assert.deepEqual(requests.map(request => request.event.type), ['session.start', 'subagent.start', 'prompt.submit', 'tool.before', 'tool.after', 'subagent.stop', 'session.end'])
    assert.equal(Buffer.from(requests.find(request => request.event.type === 'tool.after').tool.output, 'base64').toString('utf8'), 'fixture result')

    const firstCount = requests.length
    missing.add('session.start')
    const unconfirmed = { session: { id: 'other-child', header: { cwd: directory, origin: 'subagent', parentSession: 'parent' } } }
    await hooks.get('agent/pre-step')({ agent: unconfirmed, signal, modelSelection: { provider: 'mock', model: 'mock' } }, async () => decision)
    assert.equal(await hooks.get('tools/execute')({ agent: unconfirmed, signal, name: 'fixture_tool', arguments: { private: 'input' } }, async () => result), result)
    hooks.get('agent/disposed')({ agent: unconfirmed })
    await cleanup()
    assert.deepEqual(requests.slice(firstCount).map(request => request.event.type), ['session.start', 'subagent.start', 'prompt.submit', 'subagent.stop', 'session.end'], 'tool input and output stay private until the native peer has replied')
  } finally {
    if (previous === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previous
    if (socketServer.listening) await new Promise(resolve => socketServer.close(resolve))
    if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-native-recovery-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
