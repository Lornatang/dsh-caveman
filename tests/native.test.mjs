import assert from 'node:assert/strict'
import test from 'node:test'
import { nativePrompt, nativeSocketPath } from '../lib/native.js'

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
