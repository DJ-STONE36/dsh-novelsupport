/**
 * Remove the throwaway maps this session's testing added, then generate one good one.
 *
 * The earlier runs predated `paths` support, so they produced maps whose rivers never reached disk.
 * Leaving three of those in the author's project would be leaving litter.
 *
 * Usage: node tools/reset-demo-maps.mjs [--root DIR] [--seed N] [--keep]
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as react from 'react'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf('--' + name)
  return at === -1 ? fallback : args[at + 1]
}
const root = flag('root', process.cwd())
const seed = Number(flag('seed', 424242))
const keep = args.includes('--keep')
const BASE = 'http://127.0.0.1:19387/dsh-novel'
const MAP_DOC = 'setting/map/index.json'
const headers = { 'x-dsh-novel': '1', 'content-type': 'application/json; charset=utf-8' }

let captured = null
new Function('window', 'react', readFileSync('client/client.js', 'utf8'))(
  { __ModuleLoader__: { load: (mod) => { captured = mod } } },
  react,
)
const api = captured.factory((id) => {
  if (id === 'react') return react
  throw new Error(id)
}).__test

const readDoc = async () => (await (await fetch(BASE + '/document?root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(MAP_DOC))).json()).value

const before = await readDoc()
const maps = api.mapMaps(before)
console.log('before:')
for (const map of maps) {
  console.log('  ' + map.id.padEnd(8) + ' 「' + map.name + '」 ' + map.strokes.length + ' 笔 · ' + map.paths.length + ' 河/路 · ' + map.pins.length + ' 标记')
}

// Only maps this session generated are candidates, and only those with no rivers at all.
const doomed = maps.filter((map) => map.name.startsWith('示例地图'))
console.log('removing ' + doomed.length + ' generated map(s): ' + doomed.map((map) => map.id).join(', '))
const survivors = maps.filter((map) => !doomed.includes(map))

if (survivors.length === 0) {
  console.error('refusing: that would leave the document with no maps')
  process.exit(1)
}

const canvas = api.mapCanvas(survivors[0])
const generated = api.generateRandomMap(seed, canvas, api.allPinIds(survivors))
const id = api.mintMapId('map-', survivors)
console.log(
  'generating ' + id + ': ' + generated.strokes.length + ' 笔 · ' + generated.paths.length + ' 河/路 · ' + generated.pins.length + ' 标记',
)
for (const path of generated.paths) {
  console.log('    ' + path.id.padEnd(13) + ' ' + path.kind.padEnd(6) + ' w=' + String(path.width).padStart(3) + ' taper=' + path.taper + ' ' + path.dash)
}

const fresh = {
  ...api.freshMap(id, canvas, '示例地图'),
  strokes: generated.strokes,
  paths: generated.paths,
  pins: generated.pins,
}
const after = api.withMaps(before, [...survivors, fresh], id)

if (keep) {
  console.log('--keep, so nothing was written')
  process.exit(0)
}

const target = join(root, 'novel', MAP_DOC)
if (existsSync(target)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(target, target + '.bak-' + stamp)
  console.log('backed up the document')
}

const written = await fetch(BASE + '/document', { method: 'POST', headers, body: JSON.stringify({ root, path: MAP_DOC, value: after }) })
const body = await written.json().catch(() => null)
if (!written.ok) {
  console.error('write refused: HTTP ' + written.status + ' ' + JSON.stringify(body))
  process.exit(1)
}

const reread = api.mapMaps(await readDoc())
console.log('after:')
for (const map of reread) {
  console.log('  ' + map.id.padEnd(8) + ' 「' + map.name + '」 ' + map.strokes.length + ' 笔 · ' + map.paths.length + ' 河/路 · ' + map.pins.length + ' 标记')
}
const checked = reread.find((map) => map.id === id)
const ok = checked !== undefined && checked.paths.length === generated.paths.length && checked.strokes.length === generated.strokes.length && checked.pins.length === generated.pins.length
console.log(ok ? 'round trip OK — rivers, coastline and settlements all present' : 'READ-BACK MISMATCH')
process.exit(ok ? 0 : 1)
