import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const lockPath = join(root, 'upstream.lock.json')
if (process.argv[2] === '--create') {
  const reference = process.argv[3]
  if (!reference) throw new Error('Supply the upstream Git checkout after --create')
  const commit = execFileSync('git', ['-C', reference, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const tree = execFileSync('git', ['-C', reference, 'ls-tree', '-r', '-z', 'HEAD'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const files = tree.split('\0').filter(Boolean).map(entry => {
    const match = /^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(entry)
    if (!match) throw new Error(`Unsupported upstream tree entry: ${entry}`)
    return { path: match[3], mode: match[1], blob: match[2] }
  })
  await writeFile(lockPath, JSON.stringify({ commit, files }, null, 2) + '\n')
}
const lock = JSON.parse(await readFile(lockPath, 'utf8'))
const upstream = join(root, 'upstream')
const actual = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.isFile()) actual.push(relative(upstream, path).split(sep).join('/'))
    else throw new Error(`Unexpected non-file in upstream snapshot: ${path}`)
  }
}
await walk(upstream)
const expected = new Set(lock.files.map(file => file.path))
for (const path of actual) if (!expected.has(path)) throw new Error(`Unexpected upstream file: ${path}`)
for (const file of lock.files) {
  const data = await readFile(join(upstream, file.path))
  const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
  if (hash !== file.blob) throw new Error(`Upstream blob differs: ${file.path}`)
}
console.log(`Verified ${lock.files.length} upstream blobs against ${lock.commit}.`)
