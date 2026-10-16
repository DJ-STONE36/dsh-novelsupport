/**
 * Show the raw asar header entry for specific paths.
 *
 * Needed to patch the archive surgically: a packed entry records `offset`/`size` into the data
 * section, while an unpacked entry omits `offset` and is read from `<asar>.unpacked/<path>`
 * instead. Knowing the exact shape tells us whether a header can be edited without rewriting the
 * whole 115MB archive.
 *
 * Usage: node tools/asar-entry.mjs <asar> <pathSubstring> [more...]
 */
import { openSync, readSync, closeSync } from 'node:fs'

const [, , asar, ...needles] = process.argv
const fd = openSync(asar, 'r')
const head = Buffer.alloc(8)
readSync(fd, head, 0, 8, null)
const headerSize = head.readUInt32LE(4)
const headBuf = Buffer.alloc(headerSize)
readSync(fd, headBuf, 0, headerSize, null)
const jsonLen = headBuf.readUInt32LE(4)
const jsonText = headBuf.subarray(8, 8 + jsonLen).toString('utf8')
const header = JSON.parse(jsonText)
closeSync(fd)

console.log(`headerSize=${headerSize}  jsonLen=${jsonLen}  jsonText=${jsonText.length}`)
console.log(`header ends at ${8 + headerSize}; the data section starts there.\n`)

for (const needle of needles) {
  // Walk to the entry and report its PARENT object, because that is where the entry lives.
  const segments = needle.split('/')
  let node = header
  let ok = true
  for (const segment of segments) {
    if (node?.files?.[segment] === undefined) { ok = false; break }
    node = node.files[segment]
  }
  console.log(`--- ${needle}`)
  if (!ok) { console.log('    NOT FOUND'); continue }
  if (node.files) { console.log('    (a directory)'); continue }
  console.log(`    ${JSON.stringify(node)}`)
}

// And one known-unpacked entry, as the reference shape to copy.
console.log('\n=== a known-unpacked entry, for comparison ===')
const found = []
;(function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, path)
    else if (value.unpacked === true && found.length < 2) found.push([path, value])
  }
})(header, '')
for (const [path, value] of found) console.log(`  ${path}\n    ${JSON.stringify(value)}`)
