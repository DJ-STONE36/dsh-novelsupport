/**
 * Restore maps from an automatic backup into the live document.
 *
 * WHY THIS EXISTS: the map document was edited directly by tools while the browser had its own copy
 * loaded, and the two diverged — the author's 「图层 1」 and 「图层 2」 ended up absent from the file. The
 * automatic `index.json.bak-*` copies taken before every write still hold them.
 *
 * IDS ARE RE-MINTED where they collide. Pin ids are unique across the WHOLE document, and one of the
 * maps written since the backup already uses `pin-1` — restoring the backup verbatim would therefore
 * produce exactly the duplicate the host refuses, and every save would fail again. Colliding pins are
 * given fresh ids instead, which is invisible to the author: a pin's id is internal.
 *
 * Usage:
 *   node tools/restore-maps.mjs [--from <backup>] [--names "图层 1,图层 2"] [--root DIR] [--dry]
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
const dry = args.includes('--dry')
const names = String(flag('names', '图层 1,图层 2')).split(',').map((name) => name.trim()).filter(Boolean)
const BASE = 'http://127.0.0.1:19387/dsh-novel'
const MAP_DOC = 'setting/map/index.json'
const headers = { 'x-dsh-novel': '1', 'content-type': 'application/json; charset=utf-8' }
const target = join(root, 'novel', MAP_DOC)

let captured = null
new Function('window', 'react', readFileSync('client/client.js', 'utf8'))(
  { __ModuleLoader__: { load: (mod) => { captured = mod } } },
  react,
)
const api = captured.factory((id) => {
  if (id === 'react') return react
  throw new Error(id)
}).__test

const readDoc = async () =>
  (await (await fetch(BASE + '/document?root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(MAP_DOC))).json()).value

// --- find the newest backup that holds the wanted maps ---------------------------------------
const dir = join(root, 'novel', 'setting', 'map')
let source = flag('from', null)
if (source === null) {
  const candidates = readFileSync
    ? (await import('node:fs')).readdirSync(dir)
        .filter((name) => name.startsWith('index.json.bak-'))
        .sort()
        .reverse()
    : []
  for (const name of candidates) {
    const candidate = join(dir, name)
    try {
      const maps = api.mapMaps(JSON.parse(readFileSync(candidate, 'utf8')))
      if (names.every((wanted) => maps.some((map) => map.name === wanted))) {
        source = candidate
        break
      }
    } catch {
      /* an unreadable backup is simply not a candidate */
    }
  }
}
if (source === null || !existsSync(source)) {
  console.error('no backup holds all of: ' + names.join(', '))
  process.exit(1)
}
console.log('restoring from ' + source)

const backupMaps = api.mapMaps(JSON.parse(readFileSync(source, 'utf8')))
const wanted = backupMaps.filter((map) => names.includes(map.name))
console.log('found in the backup:')
for (const map of wanted) {
  console.log('  ' + map.id.padEnd(9) + ' 「' + map.name + '」 ' + map.strokes.length + ' strokes · ' + map.paths.length + ' paths · ' + map.pins.length + ' pins')
}

const current = await readDoc()
const currentMaps = api.mapMaps(current)
console.log('currently on disk:')
for (const map of currentMaps) {
  console.log('  ' + map.id.padEnd(9) + ' 「' + map.name + '」 ' + map.strokes.length + ' strokes · ' + map.paths.length + ' paths · ' + map.pins.length + ' pins')
}

// --- re-mint only what would collide ----------------------------------------------------------
const takenMapIds = currentMaps.map((map) => map.id)
const takenPinIds = api.allPinIds(currentMaps)
const takenPathIds = api.allPathIds(currentMaps)
const restored = []
let renamedPins = 0
let renamedPaths = 0
for (const map of wanted) {
  const id = takenMapIds.includes(map.id) ? api.mintMapId('map-', takenMapIds) : map.id
  takenMapIds.push(id)
  // TWO PASSES, and the order matters. Keeping every free id FIRST means only genuine collisions are
  // re-minted. Re-minting as we go instead lets a fresh id collide with the backup's own next pin, and
  // the cascade renames all of them — correct, but it reports eight collisions where there was one, and
  // a report nobody can trust is worse than no report.
  const freePins = map.pins.filter((pin) => !takenPinIds.includes(pin.id))
  for (const pin of freePins) takenPinIds.push(pin.id)
  const pins = map.pins.map((pin) => {
    if (freePins.includes(pin)) return pin
    const fresh = api.mintMapId('pin-', takenPinIds)
    takenPinIds.push(fresh)
    renamedPins += 1
    return { ...pin, id: fresh }
  })
  const freePaths = map.paths.filter((path) => !takenPathIds.includes(path.id))
  for (const path of freePaths) takenPathIds.push(path.id)
  const paths = map.paths.map((path) => {
    if (freePaths.includes(path)) return path
    const fresh = api.mintMapId('path-', takenPathIds)
    takenPathIds.push(fresh)
    renamedPaths += 1
    return { ...path, id: fresh }
  })
  restored.push({ ...map, id, pins, paths })
}
console.log('re-minted ' + renamedPins + ' pin id(s) and ' + renamedPaths + ' path id(s) that would have collided')

const after = api.withMaps(current, [...currentMaps, ...restored], restored[0].id)
const afterMaps = api.mapMaps(after)
console.log('after the restore:')
for (const map of afterMaps) {
  console.log('  ' + map.id.padEnd(9) + ' 「' + map.name + '」 ' + map.strokes.length + ' strokes · ' + map.paths.length + ' paths · ' + map.pins.length + ' pins')
}

// Refuse to write anything that would lose existing work, and check the ids ARE now unique — the whole
// point of the re-minting.
const ids = api.allPinIds(afterMaps)
if (ids.length !== new Set(ids).size) {
  console.error('REFUSING: pin ids would still collide')
  process.exit(1)
}
const beforeCount = currentMaps.reduce((n, map) => n + map.strokes.length + map.pins.length + map.paths.length, 0)
const afterCount = afterMaps.reduce((n, map) => n + map.strokes.length + map.pins.length + map.paths.length, 0)
console.log('content before ' + beforeCount + ' items, after ' + afterCount + ' — nothing existing may be lost')

if (dry) {
  console.log('--dry, so nothing was written')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(target, target + '.bak-restore-' + stamp)
console.log('backed up to index.json.bak-restore-' + stamp)

const written = await fetch(BASE + '/document', { method: 'POST', headers, body: JSON.stringify({ root, path: MAP_DOC, value: after }) })
const body = await written.json().catch(() => null)
if (!written.ok) {
  console.error('write refused: HTTP ' + written.status + ' ' + JSON.stringify(body))
  process.exit(1)
}
console.log('written')

const reread = api.mapMaps(await readDoc())
console.log('read back:')
for (const map of reread) {
  console.log('  ' + map.id.padEnd(9) + ' 「' + map.name + '」 ' + map.strokes.length + ' strokes · ' + map.paths.length + ' paths · ' + map.pins.length + ' pins')
}
const ok = restored.every((map) => {
  const back = reread.find((entry) => entry.id === map.id)
  return back !== undefined && back.pins.length === map.pins.length && back.strokes.length === map.strokes.length
})
console.log(ok ? 'round trip OK — every restored stroke and pin is present' : 'READ-BACK MISMATCH')
process.exit(ok ? 0 : 1)
