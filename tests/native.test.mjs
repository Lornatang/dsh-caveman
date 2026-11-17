import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { nativeCall, nativePrompt, nativeSocketPath, recoveryIsPublished } from '../lib/native.js'

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
