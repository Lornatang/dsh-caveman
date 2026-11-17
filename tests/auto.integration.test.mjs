import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createNetServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { parse as parseYaml } from 'yaml'

const proxyBinary = process.env.CAVEMAN_PROXY_BINARY
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => server.close(resolve))

test('a DSH pi-ai route reaches Auto and applies the Cloud decision', { skip: !proxyBinary, timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-auto-'))
  const home = join(directory, 'state')
  const cloudBodies = []
  const upstreamBodies = []
  let cloud, upstream, tunnel, child, ctx
  const previousKey = process.env.CAVEMAN_TEST_PROVIDER_KEY
  try {
    await mkdir(home)
    const key = join(directory, 'key.pem')
    const cert = join(directory, 'cert.pem')
    const opensslConfig = join(directory, 'openssl.cnf')
    await writeFile(opensslConfig, '[req]\ndistinguished_name = dn\n[dn]\n')
    execFileSync('openssl', ['req', '-config', opensslConfig, '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', cert, '-days', '1', '-subj', '/CN=api.openai.com', '-addext', 'subjectAltName=DNS:api.openai.com'], { stdio: 'ignore' })
    cloud = createHttpServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      if (request.headers['x-cave-warm']) { response.writeHead(204, { 'x-cave-edge-engine': 'warm' }); response.end(); return }
      if (request.url !== '/v1/route') { response.writeHead(404); response.end(); return }
      cloudBodies.push(JSON.parse(raw))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model: 'gpt-6-luna', effort: 'low' }))
    })
    await listen(cloud)
    upstream = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      upstreamBodies.push(JSON.parse(raw))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        { choices: [{ delta: { role: 'assistant', content: '' }, index: 0, finish_reason: null }] },
        { choices: [{ delta: { content: 'fixture answer' }, index: 0, finish_reason: null }] },
        { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      ]
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await listen(upstream)
    tunnel = createHttpServer()
    tunnel.on('connect', (request, client, head) => {
      if (request.url !== 'api.openai.com:443') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
      const target = connect(upstream.address().port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) target.write(head)
        client.pipe(target).pipe(client)
      })
      target.on('error', () => client.destroy())
      client.on('error', () => target.destroy())
    })
    await listen(tunnel)
    const probe = createNetServer()
    await listen(probe)
    const port = probe.address().port
    await close(probe)
    const cloudUrl = `http://127.0.0.1:${cloud.address().port}`
    const token = `${Buffer.from(JSON.stringify({ uid: 'fixture', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ baseURL: cloudUrl, gatewayUrl: cloudUrl, tokenStore: 'file', deviceId: 'fixture', modules: { routing: true } }))
    await writeFile(join(home, 'credentials'), JSON.stringify({ access_token: token, gateway_api_key: 'fixture-gateway-key' }))
    await writeFile(join(home, 'caveman.yaml'), `mode: record\nupstream_proxy: 'http://127.0.0.1:${tunnel.address().port}'\nca_bundle: '${cert.replaceAll('\\', '/')}'\n`)
    child = spawn(proxyBinary, ['serve'], { windowsHide: true, stdio: 'ignore', env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory, USERPROFILE: directory,
      CAVEMAN_HOME: home, CAVEMAN_CONFIG: join(home, 'caveman.yaml'), CAVEMAN_LISTEN: `127.0.0.1:${port}`,
      DO_NOT_TRACK: '1', CAVE_NO_KEYCHAIN: '1',
    } })
    const endpoint = `http://127.0.0.1:${port}`
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${endpoint}/caveman/v1/middleware/capabilities`)).ok) break } catch {}
      if (attempt === 99 || child.exitCode !== null) throw new Error('proxy did not start')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    process.env.CAVEMAN_TEST_PROVIDER_KEY = 'fixture-provider-key'
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const example = parseYaml(await readFile(new URL('../examples/caveman-auto.patch.yml', import.meta.url), 'utf8'))
    const profile = example[0].config.providers['caveman-auto']
    profile.baseURL = `${endpoint}/v1`
    profile.apiKeyEnv = 'CAVEMAN_TEST_PROVIDER_KEY'
    await ctx.plugin(LlmPiAi, { providers: { 'caveman-auto': profile } })
    const assembler = new BlockAssembler()
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture prompt' }] })
    for await (const chunk of ctx.llm.stream({ provider: 'caveman-auto', model: 'caveman-auto', messages: [message] })) assembler.push(chunk)
    assert.match(JSON.stringify(assembler.blocks()), /fixture answer/)
    assert.equal(cloudBodies.length, 1)
    assert.equal(cloudBodies[0].ask.text, 'fixture prompt')
    assert.equal(upstreamBodies.length, 1)
    assert.equal(upstreamBodies[0].model, 'gpt-6-luna')
    assert.equal(upstreamBodies[0].reasoning_effort, 'low')
  } finally {
    if (ctx) await ctx.fiber.dispose()
    if (previousKey === undefined) delete process.env.CAVEMAN_TEST_PROVIDER_KEY
    else process.env.CAVEMAN_TEST_PROVIDER_KEY = previousKey
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill(); await exited
    }
    if (cloud) await close(cloud)
    if (tunnel) await close(tunnel)
    if (upstream) await close(upstream)
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-auto-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
