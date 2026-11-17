import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { SessionModeTracker, resolveMode } from '../lib/mode.js'
import { createSkillProvider } from '../lib/skills.js'

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const events = Array.from({ length: 1000 }, (_, index) => ({
  type: 'user/message', data: {
    source: { kind: 'user' },
    content: [{ type: 'text', text: index % 150 === 0 ? '/caveman ultra' : 'Inspect the current code and report the results.' }],
  },
}))
const session = {
  get seq() { return events.length },
  snapshotEvents(from = 0, to = events.length) { return events.slice(from, to) },
}
const pending = [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }]
const tracker = new SessionModeTracker()
tracker.resolve('manual', session, pending)
const full = []
const incremental = []
for (let index = 0; index < 101; index++) {
  events.push({ type: 'turn/start', data: {} })
  let start = performance.now()
  const expected = resolveMode('manual', events, pending)
  full.push(performance.now() - start)
  start = performance.now()
  const actual = tracker.resolve('manual', session, pending)
  incremental.push(performance.now() - start)
  if (actual.mode !== expected.mode || actual.action !== expected.action) throw new Error('mode results differ')
}
const provider = createSkillProvider(resolve('vendor/caveman/skills'))
const discovery = []
for (let index = 0; index < 31; index++) {
  const start = performance.now()
  const result = await provider.list({})
  if (!result.complete || result.candidates.length !== 22) throw new Error('skill catalog is incomplete')
  discovery.push(performance.now() - start)
}
console.log(JSON.stringify({
  mode: { initialMessages: 1000, runs: full.length, fullReplayMedianMs: median(full), incrementalMedianMs: median(incremental) },
  skills: { count: 22, runs: discovery.length, discoveryMedianMs: median(discovery) },
}, null, 2))
