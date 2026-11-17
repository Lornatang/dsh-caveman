import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const lock = JSON.parse(await readFile(join(root, 'upstream.lock.json'), 'utf8'))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })

// Windows cannot retain executable bits in the working tree. Restore their
// original upstream modes in the index before verifying or committing it.
if (process.argv.includes('--restore-modes')) {
  const executable = lock.files.filter(file => file.mode === '100755').map(file => `upstream/${file.path}`)
  for (let index = 0; index < executable.length; index += 100) {
    git(['update-index', '--chmod=+x', '--', ...executable.slice(index, index + 100)])
  }
}

const entries = git(['ls-files', '-s', '-z', '--', 'upstream']).split('\0').filter(Boolean)
const indexed = new Map(entries.map(entry => {
  const match = /^(\d+) ([a-f0-9]{40}) 0\tupstream\/([\s\S]+)$/u.exec(entry)
  if (!match) throw new Error(`Unexpected Git index entry: ${entry}`)
  return [match[3], { mode: match[1], blob: match[2] }]
}))
if (indexed.size !== lock.files.length) throw new Error(`Expected ${lock.files.length} indexed upstream files, got ${indexed.size}`)
for (const file of lock.files) {
  const actual = indexed.get(file.path)
  if (!actual || actual.mode !== file.mode || actual.blob !== file.blob) {
    throw new Error(`Indexed upstream file differs: ${file.path}`)
  }
}
console.log(`Verified ${indexed.size} upstream Git blobs and modes against ${lock.commit}.`)
