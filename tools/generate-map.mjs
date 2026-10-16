/**
 * Put a generated map into a real project, the same way the 随机生成 button does.
 *
 * WHY A TOOL rather than clicking the button: it lets the result be inspected and asserted from the
 * outside, and it is repeatable. It also has to perform the LEGACY MIGRATION on disk, because the
 * document's shape decides how it is read: once a `maps` key exists, the `layers` key is no longer
 * consulted — so adding a map without migrating would HIDE the author's existing layers.
 *
 * The original file is backed up beside itself before anything is written.
 *
 * Usage:
 *   node tools/generate-map.mjs [--root DIR] [--seed N] [--size WxH] [--dry]
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as react from 'react'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const root = flag('root', process.cwd())
const seed = Number(flag('seed', Date.now() % 1000000))
const [width, height] = String(flag('size', '1600x1200')).split('x').map(Number)
const dry = args.includes('--dry')
const BASE = 'http://127.0.0.1:19387/dsh-novel'
const MAP_DOC = 'setting/map/index.json'
const headers = { 'x-dsh-novel': '1', 'content-type': 'application/json; charset=utf-8' }

// --- the plugin's own code, loaded exactly as the suites load it -------------------------------
let captured = null
new Function('window', 'react', readFileSync('client/client.js', 'utf8'))(
  { __ModuleLoader__: { load: (mod) => { captured = mod } } },
  react,
)
const api = captured.factory((id) => {
  if (id === 'react') return react
  throw new Error(id)
}).__test

const response = await fetch(`${BASE}/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(MAP_DOC)}`)
if (!response.ok) {
  console.error(`cannot read ${MAP_DOC}: HTTP ${response.status}`)
  process.exit(1)
}
const before = (await response.json()).value
const beforeMaps = api.mapMaps(before)
console.log(`before: ${beforeMaps.length} map(s)`)
for (const map of beforeMaps) {
  console.log(`  ${map.id} 「${map.name}」 ${map.strokes.length} strokes · ${map.pins.length} pins`)
}
const legacy = !Array.isArray(before?.maps) && (Array.isArray(before?.layers) || before?.layers !== undefined)
console.log(`shape on disk: ${legacy ? 'LEGACY (layers) — it will be migrated' : 'maps'}`)

// --- generate, and append as a NEW map so nothing is overwritten ------------------------------
const canvas = api.mapCanvas(beforeMaps[0])
const size = { width: Number.isFinite(width) && width > 0 ? width : canvas.width, height: Number.isFinite(height) && height > 0 ? height : canvas.height }
// Pin ids are unique across the WHOLE document, not per map — avoid every one of them.
const generated = api.generateRandomMap(seed, size, api.allPinIds(beforeMaps))
const id = api.mintMapId('map-', beforeMaps)
const fresh = {
  ...api.freshMap(id, size, `示例地图 ${beforeMaps.length + 1}`),
  // ALL THREE groups. Carrying only strokes and pins silently dropped every generated river, which is
  // exactly how the same omission in the 随机生成 button went unnoticed.
  strokes: generated.strokes,
  paths: generated.paths,
  pins: generated.pins,
}
console.log(
  `generated ${id} at ${size.width}x${size.height}, seed ${seed}: ` +
    `${generated.strokes.length} strokes · ${generated.paths.length} paths · ${generated.pins.length} pins`,
)
console.log(`  settlements: ${generated.pins.map((pin) => pin.label).join(' ')}`)

const after = api.withMaps(before, [...beforeMaps, fresh], id)
const afterMaps = api.mapMaps(after)
console.log(`after: ${afterMaps.length} map(s), active ${after.activeMapId}`)
const kept = afterMaps.slice(0, beforeMaps.length)
const lostPins = beforeMaps.reduce((n, map) => n + map.pins.length, 0) - kept.reduce((n, map) => n + map.pins.length, 0)
const lostStrokes = beforeMaps.reduce((n, map) => n + map.strokes.length, 0) - kept.reduce((n, map) => n + map.strokes.length, 0)
console.log(`existing content preserved: pins lost ${lostPins}, strokes lost ${lostStrokes}`)
if (lostPins !== 0 || lostStrokes !== 0) {
  console.error('REFUSING TO WRITE: the migration would lose content')
  process.exit(1)
}

if (dry) {
  console.log('--dry, so nothing was written')
  process.exit(0)
}

const target = join(root, 'novel', MAP_DOC)
if (existsSync(target)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${target}.bak-${stamp}`
  copyFileSync(target, backup)
  console.log(`backed up to ${backup}`)
}

const written = await fetch(`${BASE}/document`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ root, path: MAP_DOC, value: after }),
})
const body = await written.json().catch(() => null)
if (!written.ok) {
  console.error(`write refused: HTTP ${written.status} ${JSON.stringify(body)}`)
  process.exit(1)
}
console.log(`written: ${MAP_DOC}${body?.warnings?.length ? ` (${body.warnings.length} warning(s))` : ''}`)

// --- read it back, rather than trusting the write -----------------------------------------------
const check = await (await fetch(`${BASE}/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(MAP_DOC)}`)).json()
const reread = api.mapMaps(check.value)
const readBack = reread.find((map) => map.id === id)
console.log(
  `read back: ${reread.length} map(s); ${id} has ${readBack?.strokes.length} strokes, ` +
    `${readBack?.paths.length} paths and ${readBack?.pins.length} pins`,
)
// EVERY group is checked, not just strokes. Paths were added to the generator and NOT to this write, so
// the map was reported as round-tripped while every one of its rivers was missing.
if (
  readBack === undefined ||
  readBack.strokes.length !== generated.strokes.length ||
  readBack.paths.length !== generated.paths.length ||
  readBack.pins.length !== generated.pins.length
) {
  console.error('READ-BACK MISMATCH — the map did not survive the round trip')
  process.exit(1)
}
const flatRivers = readBack.paths.filter((entry) => entry.kind === 'river' && !(entry.taper > 0))
if (flatRivers.length > 0) {
  console.error(`READ-BACK MISMATCH — ${flatRivers.length} river(s) lost their taper and would draw as wires`)
  process.exit(1)
}
console.log(`round trip OK: point[0] ${JSON.stringify(readBack.strokes[0].points[0])}, label ${JSON.stringify(readBack.pins[0].label)}`)
