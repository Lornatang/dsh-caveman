import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { findCavemanBinary, moduleEnabled } from '../lib/runtime.js'

test('runtime discovery honors overrides, PATH, the Caveman home, and module switches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-caveman-discovery-'))
  const home = join(root, 'home')
  const bin = join(home, 'bin')
  const pathBin = join(root, 'path')
  const filename = process.platform === 'win32' ? 'caveman-browse.exe' : 'caveman-browse'
  const local = join(bin, filename)
  const onPath = join(pathBin, filename)
  const override = join(root, filename)
  try {
    await mkdir(bin, { recursive: true })
    await mkdir(pathBin)
    await writeFile(join(home, 'cloud.json'), '{}')
    for (const file of [local, onPath, override]) {
      await writeFile(file, 'fixture')
      await chmod(file, 0o755)
    }
    const env = { CAVEMAN_HOME: home, PATH: [pathBin, join(root, 'missing')].join(delimiter) }
    assert.equal(findCavemanBinary('browse', undefined, env), onPath)
    assert.equal(findCavemanBinary('browse', undefined, { ...env, PATH: '' }), local)
    assert.equal(findCavemanBinary('browse', undefined, { ...env, CAVEMAN_BROWSE_BIN: override }), override)
    assert.equal(findCavemanBinary('browse', local, { ...env, CAVEMAN_BROWSE_BIN: override }), local)
    assert.equal(findCavemanBinary('browse', undefined, { ...env, CAVEMAN_BROWSE_BIN: join(root, 'missing') }), undefined)
    assert.throws(() => findCavemanBinary('browse', 'relative-binary', env), /absolute path/u)
    assert.equal(moduleEnabled('browse', env), true)
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ modules: { browse: false, scripts: true } }))
    assert.equal(moduleEnabled('browse', env), false)
    assert.equal(moduleEnabled('scripts', env), true)
    await writeFile(join(home, 'cloud.json'), '\uFEFF' + JSON.stringify({ execute: { browse_tool: false } }))
    assert.equal(moduleEnabled('browse', env), false)
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ modules: { browse: true }, execute: { browse_tool: false } }))
    assert.equal(moduleEnabled('browse', env), true)
    await writeFile(join(home, 'cloud.json'), '{invalid')
    assert.equal(moduleEnabled('browse', env), true)
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('dsh-caveman-discovery-')) throw new Error('unexpected test directory')
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
