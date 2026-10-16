/**
 * Find a string inside a packed Electron app.asar, robustly.
 *
 * `asar-peek.mjs grep` reads each whole file into memory and dies on the first entry it cannot
 * read, which makes it useless for hunting a needle across a 115MB archive: one bad entry aborts
 * the scan and you never learn which file caused it. This streams in chunks, isolates failures
 * per entry, and prints the ones that failed so a partial result is still trustworthy.
 *
 * Usage:
 *   node tools/asar-find.mjs <asar> <needle> [pathRegex] [contextChars] [maxHits]
 *
 * Example:
 *   node tools/asar-find.mjs app.asar "throwIfAborted" "\\.js$" 160 20
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const [, , asar, needle, pathFilter = '.', contextChars = '160', maxHits = '20'] = process.argv
if (asar === undefined || needle === undefined) {
  console.error('usage: asar-find.mjs <asar> <needle> [pathRegex] [contextChars] [maxHits]')
  process.exit(2)
}

const fd = openSync(asar, 'r')
const head = Buffer.alloc(8)
readSync(fd, head, 0, 8, null)
const headerSize = head.readUInt32LE(4)
const headBuf = Buffer.alloc(headerSize)
readSync(fd, headBuf, 0, headerSize, null)
const header = JSON.parse(headBuf.subarray(8, 8 + headBuf.readUInt32LE(4)).toString('utf8'))
const dataStart = 8 + headerSize

const entries = []
;(function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, path)
    else entries.push({ path, offset: Number(value.offset), size: Number(value.size) })
  }
})(header, '')

const CHUNK = 4 * 1024 * 1024
const OVERLAP = 4096 // a needle can straddle a chunk boundary
const encoder = Buffer.from(needle, 'utf8')

const filter = new RegExp(pathFilter)
const limit = Number(maxHits)
const context = Number(contextChars)

/** Read one entry in chunks, searching as it goes, and remembering where it matched. */
function scan(entry) {
  const hits = []
  const buffer = Buffer.alloc(Math.min(CHUNK + OVERLAP, entry.size + OVERLAP))
  let position = 0
  let tail = Buffer.alloc(0)
  while (position < entry.size) {
    const want = Math.min(buffer.length, entry.size - position)
    const read = readSync(fd, buffer, 0, want, dataStart + entry.offset + position)
    if (read <= 0) break
    const window = Buffer.concat([tail, buffer.subarray(0, read)])
    let from = 0
    for (;;) {
      const at = window.indexOf(encoder, from)
      if (at === -1) break
      // The absolute file offset of this match, for a line number.
      const absolute = position - tail.length + at
      hits.push({ absolute, snippet: window.subarray(Math.max(0, at - context), at + encoder.length + context).toString('utf8') })
      from = at + encoder.length
      if (hits.length > 200) return hits
    }
    tail = window.subarray(Math.max(0, window.length - OVERLAP))
    position += read
    if (hits.length > 200) break
  }
  return hits
}

/** Line number for an absolute byte offset, by counting newlines up to it. */
function lineAt(entry, absolute) {
  try {
    const buffer = Buffer.alloc(absolute + 1)
    readSync(fd, buffer, 0, absolute + 1, dataStart + entry.offset)
    let line = 1
    for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 10) line += 1
    return line
  } catch {
    return null
  }
}

console.log(`archive: ${asar} (${(statSync(asar).size / 1048576).toFixed(1)}MB, ${entries.length} entries)`)
console.log(`needle : ${JSON.stringify(needle)}  path filter: ${pathFilter}\n`)

let total = 0
const failed = []
for (const entry of entries) {
  if (!filter.test(entry.path)) continue
  if (entry.size === 0 || entry.size > 64 * 1024 * 1024) continue
  let hits = []
  try {
    hits = scan(entry)
  } catch (error) {
    failed.push(`${entry.path}: ${error?.code ?? ''} ${error?.message ?? error}`)
    continue
  }
  if (hits.length === 0) continue
  console.log(`--- ${entry.path}  (${hits.length}${hits.length > 200 ? '+' : ''} hit(s))`)
  for (const hit of hits.slice(0, limit)) {
    const line = lineAt(entry, hit.absolute)
    console.log(`  line ${line ?? '?'}: ${hit.snippet.replace(/\s+/g, ' ').slice(0, context * 2)}`)
  }
  total += hits.length
}

console.log(`\n=== total hits: ${total}`)
if (failed.length > 0) {
  console.log(`=== ${failed.length} entr(y|ies) could not be read:`)
  for (const line of failed.slice(0, 10)) console.log(`  ${line}`)
}
closeSync(fd)
