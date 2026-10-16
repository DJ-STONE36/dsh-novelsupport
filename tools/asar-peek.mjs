// Inspect the packed DSH host app.asar (read-only).
//
// asar layout:
//   [0..3]   uint32 = 4            (pickle length of the next field)
//   [4..7]   uint32 = headerSize   (length of the JSON pickle that follows)
//   [8..]    JSON pickle: [uint32 jsonLen][jsonLen bytes of JSON]
//   data     starts at 8 + headerSize; each entry's `offset` is relative to it
//
// Usage:
//   node tools/asar-peek.mjs <asar> count
//   node tools/asar-peek.mjs <asar> list  <pathRegex>
//   node tools/asar-peek.mjs <asar> cat   <exactPath>
//   node tools/asar-peek.mjs <asar> range <exactPath> <startLine> <endLine>
//   node tools/asar-peek.mjs <asar> grep  <pathRegex> <lineRegex> [maxHits]
//   node tools/asar-peek.mjs <asar> dump  <pathRegex> <outFile>
import { openSync, readSync, closeSync, writeFileSync, statSync } from 'node:fs'

const ASAR = process.argv[2]
const fd = openSync(ASAR, 'r')
const sizeBuf = Buffer.alloc(8)
readSync(fd, sizeBuf, 0, 8, null)
const headerSize = sizeBuf.readUInt32LE(4)
const headBuf = Buffer.alloc(headerSize)
readSync(fd, headBuf, 0, headerSize, null)
const jsonLen = headBuf.readUInt32LE(4)
const header = JSON.parse(headBuf.subarray(8, 8 + jsonLen).toString('utf8'))
const dataStart = 8 + headerSize

const flat = []
;(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (val.files) walk(val, p)
    else flat.push({ path: p, offset: Number(val.offset), size: val.size })
  }
})(header, '')

function extract(p) {
  const e = flat.find(f => f.path === p)
  if (!e) return null
  const b = Buffer.alloc(e.size)
  readSync(fd, b, 0, e.size, dataStart + e.offset)
  return b
}

const binary = b => !b || b.subarray(0, 8192).includes(0)
const mode = process.argv[3]

if (mode === 'count') {
  console.log(`entries=${flat.length} headerSize=${headerSize} dataStart=${dataStart} asarBytes=${statSync(ASAR).size}`)
} else if (mode === 'list') {
  const re = new RegExp(process.argv[4] ?? '.')
  console.log(flat.map(f => f.path).filter(p => re.test(p)).join('\n'))
} else if (mode === 'cat') {
  const b = extract(process.argv[4])
  if (!b) { console.error('NOT FOUND: ' + process.argv[4]); process.exit(1) }
  process.stdout.write(b)
} else if (mode === 'range') {
  const b = extract(process.argv[4])
  if (!b) { console.error('NOT FOUND'); process.exit(1) }
  const lines = b.toString('utf8').split('\n')
  const s = Number(process.argv[5]), e = Number(process.argv[6])
  lines.slice(s - 1, e).forEach((l, i) => console.log(`${s + i}: ${l}`))
} else if (mode === 'grep') {
  const pathRe = new RegExp(process.argv[4])
  const lineRe = new RegExp(process.argv[5])
  const hits = []
  for (const f of flat) {
    if (!pathRe.test(f.path) || f.size > 8_000_000) continue
    const b = extract(f.path)
    if (binary(b)) continue
    b.toString('utf8').split('\n').forEach((line, i) => {
      if (lineRe.test(line)) hits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 300)}`)
    })
  }
  console.log(hits.slice(0, Number(process.argv[6] ?? 200)).join('\n'))
  console.log(`--- total hits: ${hits.length}`)
} else if (mode === 'dump') {
  const re = new RegExp(process.argv[4])
  const out = []
  for (const f of flat) {
    if (!re.test(f.path) || f.size > 4_000_000) continue
    const b = extract(f.path)
    if (!binary(b)) out.push(`\n===== ${f.path} (${f.size}B) =====\n` + b.toString('utf8'))
  }
  writeFileSync(process.argv[5], out.join('\n'), 'utf8')
  console.log(`dumped ${out.length} files -> ${process.argv[5]}`)
}
closeSync(fd)
