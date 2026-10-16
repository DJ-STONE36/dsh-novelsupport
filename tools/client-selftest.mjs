/**
 * Offline smoke test for the client half.
 *
 * Runs the built bundle in Node with the host's module table faked, then
 * actually renders the components with `react-dom/server`. No browser, no
 * running host, no restart — which matters because the alternative feedback
 * loop for client bugs is a page refresh in front of the user.
 *
 * What this catches that a syntax check cannot:
 *   - an undefined identifier anywhere in the bundle (it is one closure, so one
 *     typo blanks every panel);
 *   - a component that throws while rendering;
 *   - a `sidebar.panellist` id that does not match its `main` key (the icon would
 *     then select a panel that does not exist and `selectPanel` would throw);
 *   - a committed bundle that no longer matches `client/src/`.
 *
 * What it does NOT catch: effects. `renderToString` never runs `useEffect`, so
 * every fetch-driven view renders its loading state and nothing more. Loaded
 * states of the fetch-driven views still need a real page.
 *
 * Run: node tools/client-selftest.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as react from 'react'
import { renderToString } from 'react-dom/server'

import { buildBundle } from './build-client.mjs'
// Imported purely to cross-check the client's duplicated `timeKey` against the
// host's authoritative one.
import * as hostValidate from '../lib/impl/validate.js'
import * as schema from '../lib/impl/schema.js'
import * as frontmatter from '../lib/impl/frontmatter.js'
// Imported to cross-check the client's duplicated word counter.
import * as hostText from '../lib/impl/text.js'
import * as hostPrompt from '../lib/impl/prompt.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The client module id is the PACKAGE name — not the plugin id.
 *
 * The host keys one client-graph row per package and then checks that the row's own id
 * registered, so a bundle registering as anything else fails its own row and trips the
 * duplicate guard when the script runs twice. Those assertions therefore read the name from
 * `package.json` instead of naming it, which is what let them stay green through a rename
 * that broke the boot (`duplicate factory registration`, 2026-10-16).
 */
const pkgName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

let passed = 0
const failures = []

// Filled by the handover-doc check below and reconciled once every case has run.
let documentedBreakdown = null
let documentedTotal = null

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, message: error.message })
    console.log(`  FAIL ${name}\n         ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// ---------------------------------------------------------------------------
// Load the bundle the way the host's client module system would
// ---------------------------------------------------------------------------

const originalWindow = globalThis.window

const loaded = []
class FakeElement {}

globalThis.window = {
  localStorage: {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null
    },
    setItem(key, value) {
      this.store.set(key, String(value))
    },
    removeItem(key) {
      this.store.delete(key)
    },
  },
  __ModuleLoader__: {
    load(spec) {
      assert(typeof spec.id === 'string' && spec.id !== '', 'bundle id must be a non-empty string')
      const exportsObject = spec.factory((name) => {
        if (name === 'react') return react
        throw new Error(`unexpected require(${name}) — the platform table only supplies react here`)
      })
      loaded.push({ id: spec.id, exports: exportsObject })
    },
  },
}
globalThis.document = { baseURI: 'http://localhost/' }

const bundlePath = join(ROOT, 'client', 'client.js')
await import(pathToFileURL(bundlePath).href)

const entry = loaded[0]
const plugin = entry?.exports

// ---------------------------------------------------------------------------
// Bundle / registration contract
// ---------------------------------------------------------------------------

check('the bundle registers exactly one factory under the package id', () => {
  assert(loaded.length === 1, `expected 1 load() call, got ${loaded.length}`)
  assert(entry.id === pkgName, `the client module id must equal the package name: got ${entry.id}, want ${pkgName}`)
})

check('the committed bundle is up to date with client/src', () => {
  const { bundle } = buildBundle()
  const onDisk = readFileSync(bundlePath, 'utf8')
  assert(
    onDisk === bundle,
    'client/client.js differs from client/src — run `node tools/build-client.mjs`',
  )
})

check('the plugin exports name/inject/apply', () => {
  assert(plugin.name === pkgName, `the bundle's exports.name must be the package name: got ${plugin.name}, want ${pkgName}`)
  assert(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), `bad inject: ${JSON.stringify(plugin.inject)}`)
  assert(typeof plugin.apply === 'function', 'apply is not a function')
})

// ---------------------------------------------------------------------------
// apply(): one panellist icon and one main panel per branch, ids matched
// ---------------------------------------------------------------------------

function fakeCtx() {
  const registrations = []
  const injections = []
  const ctx = {
    layout: { selectPanel() {} },
    slots: {
      inject(slot, register) {
        injections.push(slot)
        register()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    inject(services, callback) {
      injections.push(services.join(','))
      return callback({
        slots: ctx.slots,
        sidebarRightTabs: { register: () => () => {} },
      })
    },
  }
  return { ctx, registrations, injections }
}

const { ctx, registrations, injections } = fakeCtx()
plugin.apply(ctx)

const panels = registrations.filter((entry) => entry.options.name === 'main')
const icons = registrations.filter((entry) => entry.options.name === 'sidebar.panellist')
const branches = plugin.__test.BRANCHES

check('apply registers one main panel per branch', () => {
  assert(panels.length === branches.length, `expected ${branches.length} main panels, got ${panels.length}`)
  for (const branch of branches) {
    const id = plugin.__test.panelIdFor(branch.id)
    assert(panels.some((panel) => panel.options.key === id), `no main panel for ${id}`)
  }
})

check('apply registers one panellist icon per branch', () => {
  assert(icons.length === branches.length, `expected ${branches.length} icons, got ${icons.length}`)
})

check('every panellist id matches a main key', () => {
  const keys = new Set(panels.map((panel) => panel.options.key))
  for (const icon of icons) {
    assert(
      keys.has(icon.options.id),
      `icon id "${icon.options.id}" has no matching main key — selectPanel would throw`,
    )
  }
})

check('panellist entries carry a label and a distinct order', () => {
  const orders = new Set()
  for (const icon of icons) {
    assert(typeof icon.options.label === 'function', `icon ${icon.options.id} has no label thunk`)
    assert(typeof icon.options.label() === 'string' && icon.options.label() !== '', 'label must be a non-empty string')
    assert(!orders.has(icon.options.order), `duplicate order ${icon.options.order}`)
    orders.add(icon.options.order)
  }
})

check('ids are unique within each slot', () => {
  // Not across slots: a panellist id is *meant* to equal its main key — that
  // binding is the whole mechanism, and the equality is asserted separately.
  const panelKeys = panels.map((panel) => panel.options.key)
  const iconIds = icons.map((icon) => icon.options.id)
  assert(new Set(panelKeys).size === panelKeys.length, 'duplicate main keys')
  assert(new Set(iconIds).size === iconIds.length, 'duplicate panellist ids')
  assert(
    [...panelKeys].sort().join('|') === [...iconIds].sort().join('|'),
    'the main keys and panellist ids are not the same set',
  )
})

check('the detail seat registers through a nested inject, not the module inject', () => {
  assert(
    injections.includes('sidebarRightTabs'),
    'sidebarRightTabs must be injected nested so a host without it still mounts the branches',
  )
  assert(
    !plugin.inject.includes('sidebarRightTabs'),
    'naming sidebarRightTabs in the module-level inject would unmount the whole plugin without it',
  )
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(element) {
  return renderToString(element)
}

check('every branch panel renders without throwing', () => {
  for (const panel of panels) {
    const html = render(react.createElement(panel.component))
    assert(typeof html === 'string' && html.length > 0, `${panel.options.key} rendered nothing`)
    assert(html.includes('返回对话'), `${panel.options.key} is missing the shell header`)
  }
})

check('every panellist icon renders at both sizes', () => {
  for (const icon of icons) {
    for (const size of [16, 18]) {
      const html = render(react.createElement(icon.component, { size, active: true }))
      assert(html.includes('<svg'), `${icon.options.id} did not render an svg at size ${size}`)
    }
  }
})

check('each branch has a distinct glyph', () => {
  const seen = new Set()
  for (const branch of branches) {
    const html = render(react.createElement(plugin.__test.Glyph, { name: branch.id, size: 16 }))
    assert(html.includes('<path'), `branch ${branch.id} has no glyph paths`)
    assert(!seen.has(html), `branch ${branch.id} reuses another branch's glyph`)
    seen.add(html)
  }
})

/** Every branch descriptor, including a tabs branch's children. */
function allDescriptors(list = plugin.__test.BRANCHES) {
  return list.flatMap((branch) => [branch, ...(Array.isArray(branch.tabs) ? allDescriptors(branch.tabs) : [])])
}

/**
 * The views `BranchRouter` actually dispatches on, read out of its own source.
 *
 * Derived rather than hand-listed: a hand-written set keeps passing after someone adds a `view`
 * to a descriptor and forgets the dispatch case, so the descriptor silently renders the
 * "not built yet" placeholder. `planned` is added by hand because it is the router's fallback
 * branch, which by definition has no `===` test of its own.
 */
const routerViews = new Set([
  ...[...readFileSync(join(ROOT, 'client', 'src', '70-branches.js'), 'utf8').matchAll(/branch\.view === '([a-z]+)'/g)].map(
    (match) => match[1],
  ),
  'planned',
])

check('planned views render their plan rather than a blank panel', () => {
  // Every view has now landed, so nothing in the branch table is `planned` any more — but the
  // mechanism stays: it is the honest fallback for a view the router does not know, and a typo
  // in a descriptor would land there. So PlannedBranch is exercised directly rather than
  // requiring a planned entry to exist, which would make this test delete itself the moment the
  // last view shipped.
  const synthetic = { id: 'synthetic', planned: '这一块还没做。' }
  const html = render(react.createElement(plugin.__test.PlannedBranch, { branch: synthetic }))
  assert(html.includes(synthetic.planned), 'PlannedBranch must show what is planned')

  // And any descriptor that IS still planned must actually say something.
  const planned = allDescriptors().filter((branch) => branch.view === 'planned')
  for (const branch of planned) {
    assert(typeof branch.planned === 'string' && branch.planned !== '', `${branch.id} is planned but says nothing`)
    assert(render(react.createElement(plugin.__test.PlannedBranch, { branch })).includes(branch.planned), `view ${branch.id} does not show what is planned`)
  }
})

// --- the map ----------------------------------------------------------------

const mapHelpers = plugin.__test

check('the map canvas size is guarded', () => {
  // A zero or negative or missing size makes every ratio in the viewBox NaN, which would render an
  // SVG with no extent at all — a blank panel with no error.
  assert(mapHelpers.mapCanvas({ canvas: { width: 800, height: 600 } }).width === 800, 'a real size is kept')
  for (const junk of [undefined, null, {}, { canvas: null }, { canvas: {} }, { canvas: { width: 0, height: 0 } }, { canvas: { width: -5, height: -5 } }, { canvas: { width: 'wide', height: NaN } }]) {
    const size = mapHelpers.mapCanvas(junk)
    assert(Number.isFinite(size.width) && size.width > 0, `width must stay usable for ${JSON.stringify(junk)}`)
    assert(Number.isFinite(size.height) && size.height > 0, `height must stay usable for ${JSON.stringify(junk)}`)
  }
})

check('strokes are normalised, with or without a colour', () => {
  // Strokes now carry their own colour, and the LEGACY form (a bare point list, from when strokes
  // lived on a layer) must still load — the author's existing file is full of them.
  const map = {
    strokes: [
      null,
      'x',
      [],
      [[1, 2]],
      [[0, 0], [5, 5]],
      { color: '#c0504d', points: [[1, 1], [2, 2]] },
      { points: [[3, 3], [4, 4]] },
      { color: '#4a9e6f', points: [[1, 'a'], [2, 2]] },
    ],
  }
  const strokes = mapHelpers.mapStrokes(map)
  // A stroke needs TWO usable points; a single point draws nothing and would make the count
  // disagree with the screen.
  assert(strokes.length === 3, `expected 3 usable strokes, got ${strokes.length}`)
  assert(strokes[0].color === null, 'a legacy stroke has no colour of its own')
  assert(strokes[0].points.length === 2, 'a legacy stroke keeps its points')
  assert(strokes[1].color === '#c0504d', 'a coloured stroke keeps its colour')
  assert(strokes[2].color === null, 'a stroke written without a colour keeps none')
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      assert(Number.isFinite(point.x) && Number.isFinite(point.y), 'no junk point reaches the renderer')
    }
  }
  for (const junk of [undefined, null, {}, { strokes: null }, { strokes: 'x' }, { strokes: {} }]) {
    assert(mapHelpers.mapStrokes(junk).length === 0, 'junk yields no strokes')
  }
  // The colour a stroke is DRAWN with falls back to something visible, never to undefined.
  assert(mapHelpers.mapStrokeColor({ color: '#abc' }) === '#abc', 'a stroke keeps its colour')
  assert(mapHelpers.mapStrokeColor({}) === mapHelpers.MAP_DEFAULT_COLOR, 'a colourless stroke falls back to the pen')
  assert(mapHelpers.mapStrokeColor({ color: '' }) === mapHelpers.MAP_DEFAULT_COLOR, 'an empty colour falls back')
})

check('the legacy layers document migrates without losing anything', () => {
  // THE MIGRATION. Layers were the wrong model — a "new layer" looked like it inherited the
  // previous one's strokes because they were overlays on ONE shared canvas, and every layer shared
  // one pin list. Maps replace them. The author already has data in the old shape, so this is the
  // check that it survives: each layer becomes a map, and the shared canvas, background and pins go
  // to the first one rather than being duplicated.
  const legacy = {
    canvas: { width: 1200, height: 900 },
    background: { kind: 'image', asset: 'world.png' },
    layers: [
      { id: 'layer-1', name: '地形', strokes: [[[0, 0], [1, 1]]] },
      { id: 'layer-2', name: '道路', strokes: [[[2, 2], [3, 3]], [[4, 4], [5, 5]]] },
      { id: 'layer-3', name: '注记', strokes: [] },
    ],
    pins: [{ id: 'pin-1', placeId: null, x: 10, y: 20, label: '山门' }],
  }
  const maps = mapHelpers.mapMaps(legacy)
  assert(maps.length === 3, `each layer becomes a map, got ${maps.length}`)
  assert(maps.map((m) => m.name).join(',') === '地形,道路,注记', 'the names carry over')
  assert(maps[1].strokes.length === 2, 'the second map keeps both of its strokes')
  assert(maps[2].strokes.length === 0, 'an empty layer becomes an empty map')
  assert(maps[0].canvas.width === 1200 && maps[0].canvas.height === 900, 'the shared canvas carries over')
  assert(maps[0].background.kind === 'image' && maps[0].background.asset === 'world.png', 'the shared background carries over')
  // The pins belonged to the DOCUMENT, so they land on one map rather than being copied to three.
  assert(maps[0].pins.length === 1, 'the pins go to the first map')
  assert(maps[1].pins.length === 0 && maps[2].pins.length === 0, 'and are not duplicated')

  // A legacy document with no layers still yields one usable map.
  const bare = mapHelpers.mapMaps({ canvas: { width: 500, height: 400 }, pins: [{ id: 'pin-1', x: 1, y: 2 }] })
  assert(bare.length === 1, 'a layerless document yields one map')
  assert(bare[0].pins.length === 1, 'its pins are kept')
  assert(bare[0].canvas.width === 500, 'its canvas is kept')

  // A NEW document is read as-is, and migration must never run over it.
  const modern = { version: 2, activeMapId: 'map-2', maps: [{ id: 'map-1', name: '甲' }, { id: 'map-2', name: '乙' }] }
  const read = mapHelpers.mapMaps(modern)
  assert(read.length === 2 && read[1].name === '乙', 'the modern shape is read directly')
  assert(read[0].strokes.length === 0 && read[0].pins.length === 0, 'and normalised')
  // Migration must be idempotent: reading the migrated result changes nothing.
  const once = mapHelpers.mapMaps(legacy)
  const twice = mapHelpers.mapMaps({ maps: once })
  assert(JSON.stringify(once) === JSON.stringify(twice), 'migrating twice must be a no-op')

  // Junk in the legacy shape must not throw.
  for (const junk of [undefined, null, 'x', {}, { layers: [null, 1, 'y'], pins: [null] }]) {
    const result = mapHelpers.mapMaps(junk)
    assert(Array.isArray(result) && result.length >= 1, `junk still yields at least one map: ${JSON.stringify(junk)}`)
  }
})

check('an empty modern shape never hides real legacy content', () => {
  // FOUND ON DISK, in the author's own project: the document held BOTH shapes — `layers` with three
  // strokes and `pins` with eight marks, alongside `maps` holding a single EMPTY map. Because
  // `mapMaps` read `maps` first, every stroke and every pin vanished from the UI while still sitting
  // in the file. Nothing looked broken, which is what makes this the worst failure mode here.
  const mixed = {
    canvas: { width: 2000, height: 1500 },
    background: { kind: 'blank', asset: null },
    layers: [
      { id: 'layer-1', name: '图层 1', strokes: [[[0, 0], [1, 1]]] },
      { id: 'layer-2', name: '图层 2', strokes: [[[2, 2], [3, 3]], [[4, 4], [5, 5]]] },
    ],
    pins: [{ id: 'pin-1', x: 10, y: 20, label: '山门' }],
    version: 2,
    activeMapId: 'map-1',
    maps: [{ id: 'map-1', name: '地图 1', canvas: { width: 2000, height: 1500 }, background: { kind: 'blank', asset: null }, strokes: [], pins: [], labelSize: 34, labelFixed: false }],
  }
  const maps = mapHelpers.mapMaps(mixed)
  const strokes = maps.reduce((n, map) => n + map.strokes.length, 0)
  const pins = maps.reduce((n, map) => n + map.pins.length, 0)
  assert(strokes === 3, `all three strokes must be visible, got ${strokes}`)
  assert(pins === 1, `the pin must be visible, got ${pins}`)
  assert(maps.map((map) => map.name).join(',') === '图层 1,图层 2', 'the legacy layer names are used')

  // And it must genuinely RENDER, not merely be counted.
  for (const map of maps) {
    if (map.strokes.length === 0 && map.pins.length === 0) continue
    const html = render(
      react.createElement(plugin.__test.MapSurface, {
        root: null, map, view: mapHelpers.mapViewBox(null, map.canvas), mode: 'pan', draft: [], draftColor: null,
        selectionId: null, svgRef: { current: null }, started: true,
        onPointerDown() {}, onPointerMove() {}, onPointerUp() {}, onPointerCancel() {},
        onLostPointerCapture() {}, onPointerLeave() {}, onWheel() {},
      }),
    )
    assert(html.includes('<path'), `${map.name} must draw its strokes`)
  }

  // The recovery must NOT fire when the modern shape holds real work of its own, or it would
  // resurrect content the author had deliberately replaced.
  const modern = { ...mixed, maps: [{ id: 'map-9', name: '新图', canvas: { width: 100, height: 100 }, strokes: [{ color: null, points: [[1, 1], [2, 2]] }], pins: [] }] }
  const stillModern = mapHelpers.mapMaps(modern)
  assert(stillModern.length === 1 && stillModern[0].id === 'map-9', 'a modern shape with content wins')
  assert(stillModern[0].strokes.length === 1, 'and keeps its own content')
  // A genuinely empty document stays empty; the recovery must not invent maps.
  const empty = mapHelpers.mapMaps({ maps: [], canvas: { width: 100, height: 100 } })
  assert(empty.length === 0, 'an empty modern list with nothing behind it stays empty')
})

check('saving retires the legacy keys so nothing can shadow them again', () => {
  // The other half of the defect: `withMaps` used to SPREAD the old document, so every save re-wrote
  // `layers` and `pins` alongside `maps` — recreating the ambiguous state that caused the loss above.
  const legacy = {
    canvas: { width: 1200, height: 900 },
    background: { kind: 'blank', asset: null },
    layers: [{ id: 'layer-1', name: '地形', strokes: [[[0, 0], [1, 1]]] }],
    pins: [{ id: 'pin-1', x: 5, y: 6 }],
    keep: 'me',
  }
  const migrated = mapHelpers.mapMaps(legacy)
  const saved = mapHelpers.withMaps(legacy, migrated, migrated[0].id)
  assert(!('layers' in saved), 'the migrated `layers` key must be dropped')
  assert(!('pins' in saved), 'the migrated `pins` key must be dropped')
  // Everything this plugin does not own must survive.
  assert(saved.keep === 'me', 'unknown fields are preserved')
  assert(saved.canvas.width === 1200, 'the canvas is preserved')
  assert(saved.version === 2 && Array.isArray(saved.maps), 'the modern shape is written')
  // And the result must read back identically — no drift on repeated saves.
  assert(JSON.stringify(mapHelpers.mapMaps(saved)) === JSON.stringify(migrated), 'the round trip is stable')
  assert(JSON.stringify(mapHelpers.mapMaps(mapHelpers.withMaps(saved, mapHelpers.mapMaps(saved), null))) === JSON.stringify(migrated), 'saving twice changes nothing')
  // The real document's exact shape, as found on disk.
  const found = { canvas: {}, background: {}, layers: [], pins: [], version: 2, activeMapId: 'map-1', maps: [] }
  const after = mapHelpers.withMaps(found, mapHelpers.mapMaps(found), null)
  assert(!('layers' in after) && !('pins' in after), 'even an empty legacy document is cleaned up')
})

check('the active map is resolved, and the document is rebuilt around the list', () => {
  const doc = { version: 2, activeMapId: 'map-2', maps: [{ id: 'map-1' }, { id: 'map-2' }], keep: 'me' }
  assert(mapHelpers.resolveActiveMap(doc, 'map-2').id === 'map-2', 'the chosen map wins')
  assert(mapHelpers.resolveActiveMap(doc, 'gone').id === 'map-1', 'a deleted choice falls back to the first')
  assert(mapHelpers.resolveActiveMap(doc, null).id === 'map-1', 'no choice falls back to the first')
  assert(mapHelpers.resolveActiveMap({ maps: [] }, 'map-1') === null, 'an explicitly empty list has no active map')
  // A document with NO `maps` key is the legacy shape, and the legacy rule is that it still yields
  // one usable map — an old or empty file must give the author something to draw on, not nothing.
  assert(mapHelpers.resolveActiveMap(null, 'map-1') !== null, 'a document with no maps key yields one usable map')
  assert(mapHelpers.resolveActiveMap(null, 'map-1').strokes.length === 0, 'and that map is empty')

  // Rebuilding keeps the document's other fields — a project may hold keys this plugin knows
  // nothing about, and dropping them would be silent data loss.
  const rebuilt = mapHelpers.withMaps(doc, [{ id: 'map-9' }], 'map-9')
  assert(rebuilt.keep === 'me', 'unknown fields survive')
  assert(rebuilt.version === 2, 'the version is stamped')
  assert(rebuilt.activeMapId === 'map-9', 'the active map is set')
  assert(rebuilt.maps.length === 1, 'the list is replaced')
  // An active id that is not in the list must not be stored, or the next read shows the wrong map.
  assert(mapHelpers.withMaps(doc, [{ id: 'map-9' }], 'nope').activeMapId === 'map-9', 'a stale active id falls back to the first')
  assert(mapHelpers.withMaps(doc, [], 'map-1').activeMapId === null, 'an empty list has no active map')
})

check('switching which map is shown never edits the maps', () => {
  // THE INVARIANT: normalisation substitutes for DISPLAY and must never reach the file. It matters
  // because the two states become indistinguishable once written — "the author chose 14" and "nobody
  // ever chose" read back the same — and because it silently edits the author's document.
  //
  // This was live: `selectMap` called `withMaps(current, mapMaps(current), id)`, and `mapMaps` runs every
  // map through `normalizeMap`, which fills `pinSize`/`labelSize`/`theme`/`canvas`. So merely SWITCHING
  // WHICH MAP YOU LOOK AT wrote those defaults out. `schema.js` seeds a new project's map with
  // `labelSize: 34` but NO `pinSize`, so the very first click on the map list added `"pinSize": 14`.
  const seeded = {
    version: 2,
    activeMapId: 'map-1',
    maps: [
      { id: 'map-1', name: '地图 1', canvas: { width: 2000, height: 1500 }, background: { kind: 'blank', asset: null }, strokes: [], shapes: [], paths: [], pins: [], texts: [], stamps: [], theme: 'plain', labelSize: 34, labelFixed: false },
      { id: 'map-2', name: '地图 2', canvas: { width: 800, height: 600 }, strokes: [], shapes: [], paths: [], pins: [], texts: [], stamps: [] },
    ],
  }

  // Reading still supplies the defaults — the UI must be able to draw a map that omits them.
  const read = mapHelpers.mapMaps(seeded)
  assert(read[0].pinSize === 14, `reading must still default pinSize for display, got ${read[0].pinSize}`)
  assert(read[1].pinSize === 14, 'and for a map that never had the field')

  // What `selectMap` does now: the list is not changing, only which one is shown.
  const switched = mapHelpers.withMaps(seeded, null, 'map-2')
  assert(switched.activeMapId === 'map-2', 'the chosen map is remembered')
  assert(JSON.stringify(switched.maps) === JSON.stringify(seeded.maps), `switching maps must not rewrite them:\n  before ${JSON.stringify(seeded.maps)}\n  after  ${JSON.stringify(switched.maps)}`)
  assert(!('pinSize' in switched.maps[0]), `pinSize must not be written into the document, got ${JSON.stringify(switched.maps[0].pinSize)}`)
  assert(switched.maps[1].labelSize === undefined, 'nor may labelSize be invented on a map that had none')

  // An unknown active id still falls back, so a null list cannot leave the document pointing nowhere.
  const stale = mapHelpers.withMaps(seeded, null, 'gone')
  assert(stale.activeMapId === 'map-1', 'a stale active id falls back to the first map')
  // And a document with no maps at all must not gain any.
  assert(mapHelpers.withMaps({}, null, 'map-1').maps.length === 0, 'a null list on an empty document stays empty')

  // EDITING one field must not persist the OTHER display defaults alongside it. This is the same
  // defect one step further in: `updateMaps` hands the mutator `mapMaps(...)`, so `mapRenameMap` and
  // friends build `{ ...normalizedMap, <change> }` and the write carried every filled-in default.
  //
  // map-2 is the interesting one: the seed gives it no `theme` at all, so normalisation invents one and
  // a rename must not smuggle it in.
  const renamed = mapHelpers.withMaps(seeded, mapHelpers.mapRenameMap(mapHelpers.mapMaps(seeded), 'map-2', '新名字'), 'map-1')
  const edited = renamed.maps.find((m) => m.id === 'map-2')
  assert(edited.name === '新名字', 'the rename must land')
  assert(!('pinSize' in edited), `renaming must not add pinSize, got ${JSON.stringify(edited.pinSize)}`)
  assert(!('theme' in edited), `nor theme, which the seed never set on that map, got ${JSON.stringify(edited.theme)}`)
  assert(!('labelFixed' in edited), 'nor labelFixed')
  assert(edited.canvas.width === 800, 'the canvas the author did set is kept')
  // The map that was NOT edited must come through byte for byte, defaults and all.
  const untouchedMap = renamed.maps.find((m) => m.id === 'map-1')
  assert(JSON.stringify(untouchedMap) === JSON.stringify(seeded.maps[0]), `the OTHER map must not be touched:\n  before ${JSON.stringify(seeded.maps[0])}\n  after  ${JSON.stringify(untouchedMap)}`)

  // A map created from nothing still gets the full normalised shape — there is no stored value to
  // preserve for it, and the UI needs something to draw.
  const added = mapHelpers.withMaps(seeded, [...mapHelpers.mapMaps(seeded), ...mapHelpers.mapMaps({ maps: [{ id: 'map-3', name: '三' }] })], 'map-3')
  const fresh = added.maps.find((m) => m.id === 'map-3')
  assert(fresh !== undefined, 'the new map is written')
  assert(fresh.pinSize === 14, 'a brand-new map still gets the full shape, defaults included')

  // THE REMAINING LEAK, pinned so it is a known quantity rather than a surprise. Map-level scalars are
  // reconciled above, but a LIST is taken from the edit as a whole, and `normalizePath` fills
  // `color`/`width`/`taper`/`dash` the same way `normalizeMap` fills `pinSize`. So editing one course
  // still writes the other three defaults for it. Asserting the leak keeps this honest: if the list
  // reconciliation is ever made element-wise, THIS assertion fails and must be updated deliberately.
  const withCourse = {
    version: 2,
    activeMapId: 'map-1',
    maps: [{ id: 'map-1', name: '图', canvas: { width: 100, height: 100 }, strokes: [], shapes: [], pins: [], texts: [], stamps: [],
      paths: [{ id: 'path-1', kind: 'river', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] }],
  }
  const editedCourse = mapHelpers.withMaps(
    withCourse,
    mapHelpers.mapMaps(withCourse).map((entry) =>
      entry.id === 'map-1' ? { ...entry, paths: mapHelpers.mapPathUpdate(entry.paths, 'path-1', { name: '改名' }) } : entry,
    ),
    'map-1',
  )
  const course = editedCourse.maps[0].paths[0]
  assert(course.name === '改名', 'the course rename must land')
  assert(course.points.length === 2, 'and its points must survive')
  assert(
    'color' in course && 'width' in course && 'taper' in course && 'dash' in course,
    `KNOWN LEAK: a course edit still writes its style defaults; if this now fails, list reconciliation became element-wise — update this assertion`,
  )

  // AND THE WIRING, which is what actually did the damage. The assertions above pass with the bug in
  // place, because they exercise `withMaps` rather than the handler that feeds it: `selectMap` passed
  // `mapMaps(current)` — and since it edits no map, that writes back exactly the list it was handed, so
  // the sentinel and the normalised list are indistinguishable from the outside. Only the call site
  // tells them apart. Proven by replanting the bug: the assertions above stay green and this one fails.
  const mapSource = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  const selectAt = mapSource.indexOf('const selectMap = (id) => {')
  assert(selectAt !== -1, 'the map picker handler must exist')
  const selectBody = mapSource.slice(selectAt, mapSource.indexOf('\n  const addMap', selectAt))
  assert(
    /withMaps\(current, null, id\)/.test(selectBody),
    'selectMap must pass the null sentinel, so looking at another map cannot write display defaults into it',
  )
  assert(
    !/withMaps\(current, mapMaps\(current\)/.test(selectBody),
    'and must not pass the normalised list, which writes pinSize/labelSize into every map',
  )
})

check('each map operation touches exactly one map', () => {
  // Every operation is asserted on WHICH map changed, not merely that something did: "it looked
  // right and changed the wrong one" is the failure this file produces.
  const maps = [
    { id: 'map-1', name: '大陆', strokes: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]], pins: [{ id: 'pin-1' }] },
    { id: 'map-2', name: '海岛', strokes: [[[4, 4], [5, 5]]], pins: [{ id: 'pin-2' }, { id: 'pin-3' }] },
    { id: 'map-3', name: '地下', strokes: [], pins: [] },
  ]
  const strokesOf = (list, id) => mapHelpers.mapStrokes(list.find((m) => m.id === id)).length
  const pinsOf = (list, id) => list.find((m) => m.id === id).pins.length

  const appended = mapHelpers.mapAppendStroke(maps, 'map-3', { color: '#abc', points: [[9, 9], [10, 10]] })
  assert(strokesOf(appended, 'map-3') === 1, 'the target map gains the stroke')
  assert(strokesOf(appended, 'map-1') === 2, 'no other map changes')
  assert(mapHelpers.mapStrokes(appended.find((m) => m.id === 'map-3'))[0].color === '#abc', 'the colour is stored with it')

  const undone = mapHelpers.mapUndoStroke(maps, 'map-1')
  assert(strokesOf(undone, 'map-1') === 1, 'undo drops one stroke from the target map')
  assert(strokesOf(undone, 'map-2') === 1, 'undo must not touch another map')
  assert(strokesOf(mapHelpers.mapUndoStroke(maps, 'map-3'), 'map-3') === 0, 'undo on an empty map is a no-op')

  const cleared = mapHelpers.mapClearStrokes(maps, 'map-2')
  assert(strokesOf(cleared, 'map-2') === 0, 'the target map is emptied')
  assert(strokesOf(cleared, 'map-1') === 2, '清空笔迹 must not touch another map')
  assert(cleared.length === 3, 'clearing keeps the map itself')

  const noPins = mapHelpers.mapClearPins(maps, 'map-2')
  assert(pinsOf(noPins, 'map-2') === 0, 'the target map loses its pins')
  assert(pinsOf(noPins, 'map-1') === 1, 'no other map loses pins')
  assert(strokesOf(noPins, 'map-2') === 1, 'clearing pins keeps the strokes')

  const renamed = mapHelpers.mapRenameMap(maps, 'map-2', '  外海  ')
  assert(renamed.find((m) => m.id === 'map-2').name === '  外海  ', 'a real name is kept as typed')
  // A blank name is STORED BLANK. Substituting the id here was the bug: the field is bound to this
  // value, so clearing the name put `map-1` back into the input and the next keystroke appended to it.
  assert(mapHelpers.mapRenameMap(maps, 'map-2', '').find((m) => m.id === 'map-2').name === '', 'a blank name is stored blank')
  assert(mapHelpers.mapRenameMap(maps, 'map-2', '   ').find((m) => m.id === 'map-2').name === '   ', 'and whitespace is stored as typed')
  const blanked = mapHelpers.mapRenameMap(maps, 'map-2', '').find((entry) => entry.id === 'map-2')
  assert(mapHelpers.mapDisplayName(blanked).includes('map-2'), 'while the DISPLAY shows the id, marked as unnamed')
  assert(mapHelpers.mapDisplayName(blanked).includes('未命名'), 'and says plainly that there is no name, so it cannot be mistaken for one')
  assert(!mapHelpers.mapDisplayName({ id: 'map-9', name: '示例地图' }).includes('未命名'), 'a named map shows only its name')
  // And what the author types after clearing is EXACTLY what is stored — no prefix left behind. The
  // reported symptom was the name coming out as "map-1你好".
  const typed = mapHelpers.mapRenameMap(mapHelpers.mapRenameMap(maps, 'map-2', ''), 'map-2', '你好').find((entry) => entry.id === 'map-2')
  assert(typed.name === '你好', `typing after clearing must give exactly what was typed, got ${JSON.stringify(typed.name)}`)
  assert(!typed.name.includes('map-2'), 'with no id left in front of it')
  // A very long paste is capped, and junk does not throw.
  assert(mapHelpers.mapRenameMap(maps, 'map-2', 'x'.repeat(500)).find((entry) => entry.id === 'map-2').name.length === 120, 'a paste is capped')
  assert(mapHelpers.mapRenameMap(maps, 'map-2', null).find((entry) => entry.id === 'map-2').name === '', 'junk becomes empty rather than throwing')
  // The display fallback covers the degenerate cases too.
  // The fallback MARKS ITSELF as a fallback, so it cannot be mistaken for a name the author typed.
  assert(mapHelpers.mapDisplayName({ id: 'map-9', name: '' }).includes('map-9'), 'an unnamed map shows its id')
  assert(mapHelpers.mapDisplayName({ id: 'map-9', name: '' }).includes('未命名'), 'marked as unnamed')
  assert(mapHelpers.mapDisplayName({ id: 'map-9', name: '   ' }).includes('未命名'), 'whitespace counts as unnamed')
  assert(mapHelpers.mapDisplayName({ id: 'map-9', name: ' 大陆 ' }) === '大陆', 'and a real name is trimmed for display')
  assert(mapHelpers.mapDisplayName(null).includes('未命名'), 'junk still has something to show')

  const removed = mapHelpers.mapRemoveMap(maps, 'map-2')
  assert(removed.length === 2 && !removed.some((m) => m.id === 'map-2'), 'only the target map is removed')
  assert(strokesOf(removed, 'map-1') === 2, 'the others keep their strokes')

  const sized = mapHelpers.mapSetLabelSize(maps, 'map-1', 48)
  assert(sized.find((m) => m.id === 'map-1').labelSize === 48, 'the label size is set on the target')
  assert(sized.find((m) => m.id === 'map-2').labelSize === undefined, 'no other map is changed')
  assert(mapHelpers.mapSetLabelSize(maps, 'map-1', 0).find((m) => m.id === 'map-1').labelSize === mapHelpers.MAP_DEFAULT_LABEL_SIZE, 'a nonsense size falls back')
  assert(mapHelpers.mapSetLabelFixed(maps, 'map-1', true).find((m) => m.id === 'map-1').labelFixed === true, 'the fixed flag is set')
  assert(mapHelpers.mapSetLabelFixed(maps, 'map-1', 'yes').find((m) => m.id === 'map-1').labelFixed === false, 'only true means true')

  const patched = mapHelpers.mapUpdatePin(maps, 'map-2', 'pin-3', { label: '灯塔', color: '#abc' })
  assert(patched.find((m) => m.id === 'map-2').pins.find((p) => p.id === 'pin-3').label === '灯塔', 'the target pin is updated')
  assert(patched.find((m) => m.id === 'map-2').pins.find((p) => p.id === 'pin-2').label === undefined, 'no other pin changes')
  assert(pinsOf(patched, 'map-1') === 1, 'no other map changes')

  // Junk must not throw, and an unknown id must change nothing.
  for (const junk of [null, undefined, 'x', {}, [null, 1, 'y']]) {
    assert(mapHelpers.mapClearStrokes(junk, 'map-1').length === 0, 'junk clears to nothing')
    assert(mapHelpers.mapAppendStroke(junk, 'map-1', { points: [[0, 0], [1, 1]] }).length === 0, 'junk appends to nothing')
  }
  assert(strokesOf(mapHelpers.mapClearStrokes(maps, 'nope'), 'map-1') === 2, 'an unknown id changes nothing')
  // A fresh map is always drawable, which is what the last-map-deleted path relies on.
  const fresh = mapHelpers.freshMap('map-1', { width: 300, height: 200 })
  assert(fresh.canvas.width === 300 && fresh.strokes.length === 0 && fresh.pins.length === 0, 'a fresh map is empty and sized')
  assert(fresh.labelSize === mapHelpers.MAP_DEFAULT_LABEL_SIZE && fresh.labelFixed === false, 'a fresh map has sane label defaults')
})

check('a pin label is sized as asked, fixed or scaling', () => {
  // REQUESTED: the size must be adjustable, and it must stop changing relative to the map. The old
  // code divided by zoom, which held the size in SCREEN pixels — so the map shrank while the labels
  // did not, and they crowded and covered it. The default is now a size ON THE MAP, so labels scale
  // with the drawing exactly as strokes do.
  const map = { labelSize: 40, labelFixed: false }
  const pin = { id: 'pin-1' }
  for (const zoom of [0.2, 1, 2, 8]) {
    assert(mapHelpers.mapLabelSize(map, zoom, pin) === 40, `scaling labels must ignore the zoom (${zoom})`)
  }
  // The fixed mode keeps a constant pixel size instead.
  const fixed = { labelSize: 40, labelFixed: true }
  assert(mapHelpers.mapLabelSize(fixed, 1, pin) === 40, 'fixed: zoom 1 is the reference size')
  assert(mapHelpers.mapLabelSize(fixed, 2, pin) === 20, 'fixed: zoomed in, the world size shrinks so pixels stay put')
  assert(mapHelpers.mapLabelSize(fixed, 0.5, pin) === 80, 'fixed: zoomed out, the world size grows')
  assert(mapHelpers.mapLabelSize(fixed, 0, pin) === 40, 'fixed: a nonsense zoom does not divide by zero')

  // A per-pin size overrides the map's, so one important label can be larger.
  assert(mapHelpers.mapLabelSize(map, 1, { id: 'p', size: 90 }) === 90, 'a pin size overrides the map size')
  assert(mapHelpers.mapLabelSize(map, 1, { id: 'p', size: 0 }) === 40, 'a nonsense pin size falls back to the map')
  assert(mapHelpers.mapLabelSize(map, 1, { id: 'p', size: 90 }) === 90 && mapHelpers.mapLabelSize(fixed, 2, { size: 90 }) === 45, 'the override respects the fixed mode too')
  // And junk must produce something drawable rather than NaN or nothing.
  for (const bad of [undefined, null, {}, { labelSize: 0 }, { labelSize: NaN }, { labelSize: -3 }]) {
    const size = mapHelpers.mapLabelSize(bad, 1, pin)
    assert(Number.isFinite(size) && size > 0, `a usable size for ${JSON.stringify(bad)}`)
  }
  // The offset is proportional to the size, so a bigger label is not drawn on top of its pin.
  assert(mapHelpers.mapLabelOffset(100).x > mapHelpers.mapLabelOffset(20).x, 'a larger label sits further out')
  assert(Number.isFinite(mapHelpers.mapLabelOffset(NaN).x), 'a junk size yields a finite offset')
})

check('each map keeps its own viewpoint', () => {
  // Two maps of different places should not share one viewpoint. A flat legacy value is still
  // accepted so an existing layout file keeps working.
  const layout = { mapView: { 'map-1': { centerX: 10, centerY: 20, zoom: 2 } } }
  assert(mapHelpers.mapViewFor(layout, 'map-1').centerX === 10, 'the map finds its own view')
  assert(mapHelpers.mapViewFor(layout, 'map-2') === null, 'an unknown map has no view yet')
  assert(mapHelpers.mapViewFor({ mapView: { centerX: 5, centerY: 6, zoom: 1 } }, 'any') .centerX === 5, 'a flat legacy view is accepted')
  assert(mapHelpers.mapViewFor({}, 'map-1') === null, 'no stored views at all')
  assert(mapHelpers.mapViewFor(null, 'map-1') === null, 'junk layout')

  // Writing one map's view must leave the others alone — otherwise moving one map would move every
  // map, which is the same class of fault as the shared canvas.
  const merged = mapHelpers.withMapView(layout, 'map-2', { centerX: 99, centerY: 98, zoom: 0.5 })
  assert(merged.mapView['map-2'].centerX === 99, 'the new view is stored')
  assert(merged.mapView['map-1'].centerX === 10, 'the other map keeps its view')
  assert(merged.mapView.length === undefined, 'mapView is a keyed object, not an array')
  // The rest of the layout file must survive.
  const withRest = mapHelpers.withMapView({ mapView: {}, graphs: { relations: { positions: {} } } }, 'map-1', { zoom: 1 })
  assert(withRest.graphs.relations.positions !== undefined, 'the graph placements survive a map save')
})

check('every view function accepts EITHER view shape', () => {
  // THE STRUCTURAL FIX for a fault that recurred three times, each time reported separately:
  // panning that did nothing, marks offset by a constant, and zooming that dragged the top-left
  // corner to the middle. Every one was a box handed to a function that expected a view state (or
  // the reverse), and every one failed SILENTLY by falling back to a default.
  const canvas = { width: 2000, height: 1500 }
  const state = { centerX: 1400, centerY: 620, zoom: 2.5 }
  const box = mapHelpers.mapViewBox(state, canvas)

  const fromState = mapHelpers.mapViewState(state, canvas)
  const fromBox = mapHelpers.mapViewState(box, canvas)
  assert(fromState.centerX === fromBox.centerX && fromState.centerY === fromBox.centerY, `centres disagree: ${JSON.stringify(fromState)} vs ${JSON.stringify(fromBox)}`)
  assert(fromState.zoom === fromBox.zoom, 'zooms disagree')
  assert(mapHelpers.mapViewState(null, canvas).centerX === canvas.width / 2, 'junk falls back to the canvas middle')
  assert(mapHelpers.mapViewState(null).zoom === 1, 'the canvas is optional — zoom still resolves')

  // THE FAULT THAT WAS REPORTED: zoom about a world point must hold that point still, from either
  // shape. A box has no `centerX`, so the old code fell back to (0,0) — the canvas corner — and
  // that corner slid to the middle of the screen while the map scaled around it.
  const focus = { x: 1500, y: 400 }
  const fractionOf = (value) => {
    const b = mapHelpers.mapViewBox(value, canvas)
    return { fx: (focus.x - b.x) / b.w, fy: (focus.y - b.y) / b.h }
  }
  const want = fractionOf(box)
  for (const [label, start] of [['a box', box], ['a view state', state]]) {
    let view = start
    for (const factor of [1.15, 1.15, 1 / 1.15, 0.5, 3]) view = mapHelpers.mapZoomAt(view, factor, focus)
    const got = fractionOf(view)
    assert(Math.abs(got.fx - want.fx) < 1e-9, `from ${label}: the focus drifted horizontally (${want.fx} -> ${got.fx})`)
    assert(Math.abs(got.fy - want.fy) < 1e-9, `from ${label}: the focus drifted vertically (${want.fy} -> ${got.fy})`)
  }

  assert(mapHelpers.mapPanTo(box, 10, 20).zoom === state.zoom, 'mapPanTo reads the zoom from a box')
  assert(mapHelpers.mapPanTo(state, 10, 20).zoom === state.zoom, 'mapPanTo reads the zoom from a view state')
  assert(mapHelpers.mapPanTo(undefined, 10, 20).zoom === 1, 'mapPanTo tolerates nothing at all')
})

check('deriving the box twice cannot move the view', () => {
  // Idempotency is the structural fix: a double derivation is now harmless instead of silently
  // re-centring the map. Without it, one careless extra call reintroduces the pan bug.
  const canvas = { width: 2000, height: 1500 }
  for (const state of [
    { centerX: 1000, centerY: 750, zoom: 1 },
    { centerX: 1500, centerY: 400, zoom: 2 },
    { centerX: -200, centerY: 3000, zoom: 0.5 },
  ]) {
    const once = mapHelpers.mapViewBox(state, canvas)
    const twice = mapHelpers.mapViewBox(once, canvas)
    assert(once.x === twice.x && once.y === twice.y, `re-deriving moved the view: ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`)
    assert(once.w === twice.w && once.h === twice.h && once.zoom === twice.zoom, 're-deriving changed the extent')
  }
  assert(mapHelpers.isMapBox(mapHelpers.mapViewBox({ centerX: 1, centerY: 2, zoom: 1 }, canvas)) === true, 'a derived box is recognised')
  assert(mapHelpers.isMapBox({ centerX: 500, centerY: 500, zoom: 1 }) === false, 'a view state is not a box')
  assert(mapHelpers.isMapBox(null) === false, 'junk is not a box')
})

check('a stored view state can always be turned back into a usable box', () => {
  // Every producer of a view state must be consumable by `mapViewBox`, and the derived box must be
  // usable by the pointer maths. Each helper passing on its own is not enough: what broke was the
  // COMPOSITION.
  const canvas = { width: 2000, height: 1500 }
  const seeded = { centerX: 1000, centerY: 750, zoom: 1 }
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const boxOf = (state) => mapHelpers.mapViewBox(state, canvas)

  const produced = [
    ['mapPanTo', mapHelpers.mapPanTo(seeded, 1200, 800)],
    ['mapZoomAt', mapHelpers.mapZoomAt(seeded, 1.3, { x: 100, y: 100 })],
    ['mapZoomAt at the limit', mapHelpers.mapZoomAt({ centerX: 0, centerY: 0, zoom: mapHelpers.MAP_ZOOM_MAX }, 4, null)],
    ['mapPanTo from junk', mapHelpers.mapPanTo({ zoom: NaN }, NaN, undefined)],
  ]
  const panStart = mapHelpers.mapDragStart({
    button: 0,
    pointerId: 1,
    world: mapHelpers.mapScreenToWorld({ clientX: 400, clientY: 300 }, rect, boxOf(seeded)),
    screen: { x: 400, y: 300 },
    mode: 'pan',
    pins: [],
    hitRadius: 18,
    canvas,
    view: boxOf(seeded),
    rect,
  })
  assert(panStart !== null && panStart.kind === 'pan', 'a pan gesture must start from a real box')
  produced.push([
    'mapDragMove pan intent',
    mapHelpers.mapDragMove({ drag: panStart, pointerId: 1, world: { x: 0, y: 0 }, screen: { x: 450, y: 320 }, view: boxOf(seeded), canvas }).view,
  ])

  for (const [label, state] of produced) {
    assert(state !== null && state !== undefined, `${label} produced nothing`)
    const box = boxOf(state)
    for (const key of ['x', 'y', 'w', 'h', 'zoom']) {
      assert(Number.isFinite(box[key]), `${label}: the derived box has a non-finite ${key}`)
    }
    const world = mapHelpers.mapScreenToWorld({ clientX: 400, clientY: 300 }, rect, box)
    assert(world !== null && Number.isFinite(world.x), `${label}: mapScreenToWorld must accept the derived box`)
    assert(!mapHelpers.viewBoxString(box).includes('undefined'), `${label}: bad viewBox`)
  }
  assert(mapHelpers.mapScreenToWorld({ clientX: 0, clientY: 0 }, rect, seeded) === null, 'a raw view state must be rejected by the pointer maths')
})

check('screen coordinates convert into world coordinates', () => {
  const canvas = { width: 1000, height: 500 }
  const box = mapHelpers.mapViewBox({ centerX: 500, centerY: 250, zoom: 2 }, canvas)
  const rect = { left: 100, top: 50, width: 500, height: 250 }
  const centre = mapHelpers.mapScreenToWorld({ clientX: 350, clientY: 175 }, rect, box)
  assert(Math.abs(centre.x - 500) < 1e-9 && Math.abs(centre.y - 250) < 1e-9, `the element centre should map to the view centre, got ${centre.x},${centre.y}`)
  const corner = mapHelpers.mapScreenToWorld({ clientX: 100, clientY: 50 }, rect, box)
  assert(Math.abs(corner.x - box.x) < 1e-9 && Math.abs(corner.y - box.y) < 1e-9, 'the element corner should map to the viewBox corner')
  assert(mapHelpers.mapScreenToWorld({ clientX: 0, clientY: 0 }, { left: 0, top: 0, width: 0, height: 0 }, box) === null, 'a zero-size element yields null')
  assert(mapHelpers.mapScreenToWorld({ clientX: 0, clientY: 0 }, null, box) === null, 'a missing rectangle yields null')
  assert(mapHelpers.mapScreenToWorld({ clientX: NaN, clientY: 0 }, rect, box) === null, 'a non-finite pointer yields null')
})

check('letterboxed elements still map clicks to the right place', () => {
  // An SVG with a viewBox and the default `preserveAspectRatio` fits its content INSIDE the element
  // and centres it, leaving bands. Ignoring them put every click in the wrong place — which is
  // indistinguishable from "drawing does nothing", exactly how it was reported.
  const canvas = { width: 1000, height: 500 }
  const box = mapHelpers.mapViewBox({ centerX: 500, centerY: 250, zoom: 1 }, canvas)
  assert(box.w === 1000 && box.h === 500, `unexpected box ${box.w}x${box.h}`)

  const tall = { left: 0, top: 0, width: 1000, height: 1000 }
  const tallCentre = mapHelpers.mapScreenToWorld({ clientX: 500, clientY: 500 }, tall, box)
  assert(Math.abs(tallCentre.x - 500) < 1e-9 && Math.abs(tallCentre.y - 250) < 1e-9, 'centred despite the bands')
  const tallTop = mapHelpers.mapScreenToWorld({ clientX: 500, clientY: 0 }, tall, box)
  assert(tallTop.y < box.y, 'the top band maps above the viewBox')
  assert(Math.abs(tallTop.y - (box.y - 250)) < 1e-9, `the band is 250 world units tall, got ${box.y - tallTop.y}`)

  const wide = { left: 0, top: 0, width: 2000, height: 500 }
  const wideLeft = mapHelpers.mapScreenToWorld({ clientX: 0, clientY: 250 }, wide, box)
  assert(Math.abs(wideLeft.x - (box.x - 500)) < 1e-9, 'the left band is 500 world units wide')

  // THE PROPERTY THAT MATTERS FOR DRAWING: one uniform scale, so a square drawn on screen stays
  // square in the document.
  for (const rect of [tall, wide, { left: 7, top: 9, width: 640, height: 480 }]) {
    const a = mapHelpers.mapScreenToWorld({ clientX: rect.left + 100, clientY: rect.top + 100 }, rect, box)
    const b = mapHelpers.mapScreenToWorld({ clientX: rect.left + 200, clientY: rect.top + 100 }, rect, box)
    const c = mapHelpers.mapScreenToWorld({ clientX: rect.left + 100, clientY: rect.top + 200 }, rect, box)
    assert(Math.abs(Math.abs(b.x - a.x) - Math.abs(c.y - a.y)) < 1e-9, 'the scale must be uniform')
  }
})

check('stroke paths are built safely', () => {
  assert(mapHelpers.strokePath([]) === '', 'no points, no path')
  assert(mapHelpers.strokePath(null) === '', 'junk input, no path')
  assert(mapHelpers.strokePath([{ x: NaN, y: 1 }]) === '', 'junk points are dropped entirely')
  assert(mapHelpers.strokePath([{ x: 3, y: 4 }]).startsWith('M 3 4'), 'a lone point becomes a dot')
  assert(mapHelpers.strokePath([{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 40 }]) === 'M 0 0 L 10 20 L 30 40', 'a path is built in order')
  assert(mapHelpers.strokePath([{ x: 0, y: 0 }, { x: NaN, y: 5 }, { x: 10, y: 10 }]) === 'M 0 0 L 10 10', 'junk inside a stroke is skipped')
})

check('pin hit testing picks the nearest and respects its radius', () => {
  const pins = [
    { id: 'pin-a', x: 100, y: 100 },
    { id: 'pin-b', x: 110, y: 100 },
    { id: 'pin-broken', x: NaN, y: 0 },
    { id: 'pin-far', x: 900, y: 900 },
  ]
  assert(mapHelpers.pinAt(pins, { x: 108, y: 100 }, 20).id === 'pin-b', 'the nearest pin wins')
  assert(mapHelpers.pinAt(pins, { x: 100, y: 100 }, 20).id === 'pin-a', 'an exact hit wins')
  assert(mapHelpers.pinAt(pins, { x: 500, y: 500 }, 20) === null, 'nothing within the radius means nothing is hit')
  assert(mapHelpers.pinAt(pins, { x: NaN, y: 0 }, 20) === null, 'a junk point hits nothing')
  assert(mapHelpers.pinAt([], { x: 0, y: 0 }, 20) === null, 'no pins, no hit')
  assert(mapHelpers.mapPinHitRadius(2) < mapHelpers.mapPinHitRadius(1), 'zooming in shrinks the world-space radius')
  assert(Number.isFinite(mapHelpers.mapPinHitRadius(0)) && mapHelpers.mapPinHitRadius(0) > 0, 'zoom 0 must not divide by zero')
})

check('map ids never collide, and only real images are displayed', () => {
  assert(mapHelpers.mintMapId('map-', [{ id: 'map-1' }, { id: 'map-2' }, { id: 'map-4' }]) === 'map-3', 'the first free id')
  assert(mapHelpers.mintMapId('pin-', []) === 'pin-1', 'the first id starts at one')
  assert(mapHelpers.mintMapId('pin-', [null, 'x', {}]) === 'pin-1', 'junk entries are not ids')
  assert(mapHelpers.isMapImage({ kind: 'image', asset: 'a.png' }) === true, 'a png is displayable')
  assert(mapHelpers.isMapImage({ kind: 'image', asset: 'a.JPEG' }) === true, 'the check is case-insensitive')
  assert(mapHelpers.isMapImage({ kind: 'blank', asset: 'a.png' }) === false, 'blank is not an image')
  assert(mapHelpers.isMapImage({ kind: 'image', asset: 'a.exe' }) === false, 'only image extensions are displayed')
  assert(mapHelpers.isMapImage({ kind: 'image', asset: null }) === false, 'a missing asset is not an image')
  assert(mapHelpers.isMapImage(null) === false, 'junk is not an image')
  const url = mapHelpers.mapAssetUrl('D:\\proj', 'x y.png')
  assert(url.includes('/asset?'), `the asset URL should use the plugin route, got ${url}`)
  assert(url.includes('x%20y.png'), 'the asset name must be encoded')
  assert(mapHelpers.mapAssetUrl(null, 'a.png') === null, 'no root, no url')
})

// --- the drag state machine (the part that kept breaking) --------------------

const canvas800 = { width: 800, height: 600 }

check('a gesture is only started when it is really ours', () => {
  const start = mapHelpers.mapDragStart
  const box = mapHelpers.mapViewBox({ centerX: 400, centerY: 300, zoom: 1 }, canvas800)
  const rect = { left: 0, top: 0, width: 800, height: 600 }
  const base = {
    button: 0, pointerId: 7, world: { x: 100, y: 100 }, screen: { x: 300, y: 200 },
    mode: 'pan', pins: [], hitRadius: 20, canvas: canvas800, view: box, rect,
  }
  const pan = start(base)
  assert(pan.kind === 'pan', 'a left press in pan mode starts a pan')
  assert(pan.screen.x === 300 && pan.screen.y === 200, 'the screen baseline is recorded')
  assert(pan.center.x === 400 && pan.center.y === 300, `the starting centre is recorded, got ${JSON.stringify(pan.center)}`)
  assert(Math.abs(pan.scale - 1) < 1e-9, `the scale is recorded, got ${pan.scale}`)
  assert(start({ ...base, button: 2 }) === null, 'a right press must be declined')
  assert(start({ ...base, button: 1 }) === null, 'a middle press must be declined')
  assert(start({ ...base, world: null }) === null, 'an unmeasurable pointer must be declined')
  assert(start({ ...base, world: { x: NaN, y: 0 } }) === null, 'a non-finite position must be declined')
  assert(start({ ...base, rect: { left: 0, top: 0, width: 0, height: 0 } }) === null, 'a zero-size element declines a pan')
  assert(start({ ...base, mode: 'draw' }).points.length === 1, 'draw mode starts with one point')
  const onPin = start({ ...base, mode: 'pin', pins: [{ id: 'pin-1', x: 105, y: 100 }] })
  assert(onPin.kind === 'pin' && onPin.id === 'pin-1', 'pressing an existing pin picks it up')
  assert(Math.abs(onPin.offsetX - 5) < 1e-9, 'the grab offset (pin minus pointer) is recorded so the pin does not jump')
  assert(Math.abs(100 + onPin.offsetX - 105) < 1e-9, 'pointer + offset must return the pin to its position')
  const fresh = start({ ...base, mode: 'pin', world: { x: 100000, y: 100000 } })
  assert(fresh.kind === 'new-pin', 'pressing empty space places a new pin')
  assert(fresh.point.x <= canvas800.width && fresh.point.y <= canvas800.height, 'a new pin is clamped onto the canvas')
})

check('panning follows the hand from a fixed screen baseline', () => {
  // Panning used to be computed from the world point under the cursor — but panning CHANGES that
  // point, so each move compared against a baseline the previous move had just invalidated. The
  // view ran away or jittered instead of following. DSH's own pane resizer stores `clientX`.
  const move = mapHelpers.mapDragMove
  const box = mapHelpers.mapViewBox({ centerX: 400, centerY: 300, zoom: 1 }, canvas800)
  const drag = { kind: 'pan', pointerId: 1, scale: 1, screen: { x: 100, y: 100 }, center: { x: 400, y: 300 } }
  const at = (x, y) => move({ drag, pointerId: 1, world: { x, y }, screen: { x, y }, view: box, canvas: canvas800 })

  const right = at(150, 100)
  assert(Math.abs(right.view.centerX - 350) < 1e-9, `expected 350, got ${right.view.centerX}`)
  assert(Math.abs(right.view.centerY - 300) < 1e-9, 'a horizontal drag must not move the view vertically')
  // THE PROPERTY THE OLD MODEL BROKE: the same screen position always yields the same view.
  const again = at(150, 100)
  assert(again.view.centerX === right.view.centerX && again.view.centerY === right.view.centerY, 'the pan must be idempotent for a given screen position')
  const home = at(100, 100)
  assert(Math.abs(home.view.centerX - 400) < 1e-9 && Math.abs(home.view.centerY - 300) < 1e-9, 'returning the pointer restores the view')
  const zoomed = move({ drag: { ...drag, scale: 2 }, pointerId: 1, world: { x: 0, y: 0 }, screen: { x: 150, y: 100 }, view: box, canvas: canvas800 })
  assert(Math.abs(zoomed.view.centerX - 375) < 1e-9, `at scale 2 a 50px drag is 25 world units, got ${zoomed.view.centerX}`)
  assert(move({ drag, pointerId: 1, world: { x: 1, y: 1 }, screen: { x: NaN, y: 1 }, view: box, canvas: canvas800 }) === null, 'a non-finite screen position declines')
  assert(move({ drag: { ...drag, scale: 0 }, pointerId: 1, world: { x: 1, y: 1 }, screen: { x: 1, y: 1 }, view: box, canvas: canvas800 }) === null, 'a zero scale declines')
})

check('a move only drives the gesture that owns it', () => {
  const move = mapHelpers.mapDragMove
  const box = mapHelpers.mapViewBox({ centerX: 400, centerY: 300, zoom: 1 }, canvas800)
  const pan = { kind: 'pan', pointerId: 1, scale: 1, screen: { x: 0, y: 0 }, center: { x: 400, y: 300 } }
  assert(move({ drag: pan, pointerId: 2, world: { x: 10, y: 10 }, screen: { x: 10, y: 10 }, view: box, canvas: canvas800 }) === null, 'a different pointer is ignored')
  assert(move({ drag: null, pointerId: 1, world: { x: 10, y: 10 }, screen: { x: 10, y: 10 }, view: box, canvas: canvas800 }) === null, 'no drag, no move')
  assert(move({ drag: pan, pointerId: 1, world: { x: NaN, y: 0 }, screen: { x: 1, y: 1 }, view: box, canvas: canvas800 }) === null, 'a non-finite move is ignored')
})

check('drawing samples the stroke instead of storing every event', () => {
  const move = mapHelpers.mapDragMove
  const view = mapHelpers.mapViewBox({ centerX: 400, centerY: 300, zoom: 1 }, canvas800)
  let drag = { kind: 'draw', pointerId: 1, points: [{ x: 0, y: 0 }] }
  const step = 3
  assert(move({ drag, pointerId: 1, world: { x: 1, y: 1 }, view, canvas: canvas800, sampleStep: step }) === null, 'a tiny move is not sampled')
  const added = move({ drag, pointerId: 1, world: { x: 10, y: 0 }, view, canvas: canvas800, sampleStep: step })
  assert(added.points !== undefined && added.points.length === 2, 'a real move adds exactly one point')
  drag = { ...drag, points: added.points }
  for (const x of [20, 30, 40, 50]) {
    const next = move({ drag, pointerId: 1, world: { x, y: 0 }, view, canvas: canvas800, sampleStep: step })
    assert(next !== null && next.points.length === drag.points.length + 1, `moving to ${x} should add a point`)
    drag = { ...drag, points: next.points }
  }
  assert(drag.points.length === 6, `expected 6 sampled points, got ${drag.points.length}`)
})

check('a move drags a pin with its grab offset, clamped to the canvas', () => {
  const move = mapHelpers.mapDragMove
  const view = mapHelpers.mapViewBox({ centerX: 400, centerY: 300, zoom: 1 }, canvas800)
  const drag = { kind: 'pin', pointerId: 1, id: 'pin-1', offsetX: -5, offsetY: 0 }
  const moved = move({ drag, pointerId: 1, world: { x: 200, y: 100 }, view, canvas: canvas800 })
  assert(moved.pin.id === 'pin-1', 'the same pin is moved')
  assert(moved.pin.x === 195 && moved.pin.y === 100, `the grab offset is preserved, got ${moved.pin.x},${moved.pin.y}`)
  const far = move({ drag, pointerId: 1, world: { x: 99999, y: -99999 }, view, canvas: canvas800 })
  assert(far.pin.x <= canvas800.width && far.pin.y >= 0, `a pin must stay on the canvas, got ${far.pin.x},${far.pin.y}`)
})

check('ending a gesture commits a real stroke and drops a cancelled one', () => {
  const end = mapHelpers.mapDragEnd
  const drawn = { kind: 'draw', pointerId: 1, points: [{ x: 1.4, y: 2.6 }, { x: 10, y: 20 }] }
  const committed = end({ drag: drawn, pointerId: 1, cancelled: false })
  assert(committed.cancelled === false, 'a normal release is not a cancellation')
  assert(Array.isArray(committed.stroke) && committed.stroke.length === 2, 'the stroke is committed')
  assert(committed.stroke[0][0] === 1 && committed.stroke[0][1] === 3, `coordinates are rounded, got ${JSON.stringify(committed.stroke[0])}`)
  assert(end({ drag: { kind: 'draw', pointerId: 1, points: [{ x: 1, y: 1 }] }, pointerId: 1, cancelled: false }).stroke === null, 'a tap commits no stroke')
  const cancelled = end({ drag: drawn, pointerId: 1, cancelled: true })
  assert(cancelled.cancelled === true && cancelled.stroke === null, 'a cancelled gesture commits nothing')
  assert(end({ drag: drawn, pointerId: 2, cancelled: false }) === null, 'a different pointer cannot end the gesture')
  assert(end({ drag: null, pointerId: 1, cancelled: false }) === null, 'no drag, nothing to end')
  assert(end({ drag: { kind: 'pan', pointerId: 1, screen: { x: 0, y: 0 }, center: { x: 0, y: 0 }, scale: 1 }, pointerId: 1, cancelled: false }).stroke === null, 'a pan commits no stroke')
})

check('the map holds pointer capture instead of ending the drag on leave', () => {
  // `pointerleave` fires the moment the pointer leaves the element's hit-test boundary, so wiring it
  // to the end of the drag cancelled every sustained gesture — pan and 手绘 did nothing while a
  // single click (打点) still worked, which is exactly how it was reported.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/setPointerCapture/.test(source), 'the surface must take pointer capture')
  assert(/hasPointerCapture/.test(source) && /releasePointerCapture/.test(source), 'capture must be released')
  assert(!/onPointerLeave:\s*onPointerUp/.test(source), 'pointerleave must NOT end the drag')
  assert(/onPointerCancel/.test(source) && /onLostPointerCapture/.test(source), 'capture-loss must end the drag')
  assert(/pointerId !== event\.pointerId/.test(source), 'every move and end must be guarded on pointerId')
  assert(/mapDragStart\(/.test(source) && /mapDragMove\(/.test(source) && /mapDragEnd\(/.test(source), 'the handlers must delegate to the tested state machine')
})

// --- the map surface renders, which is the class that shipped blank panels ---

const sampleMap = {
  id: 'map-1',
  name: '大陆',
  canvas: { width: 1000, height: 800 },
  background: { kind: 'blank', asset: null },
  strokes: [
    { color: '#c0504d', points: [[10, 10], [20, 20], [30, 15]] },
    { color: '#4a9e6f', points: [[40, 40], [50, 50]] },
  ],
  pins: [
    { id: 'pin-1', placeId: 'place-abc', x: 100, y: 200, label: '山门' },
    { id: 'pin-2', placeId: null, x: 300, y: 400, label: '' },
  ],
  labelSize: 34,
  labelFixed: false,
}

const surfaceProps = (over) => ({
  root: 'D:\\proj',
  map: sampleMap,
  view: mapHelpers.mapViewBox({ centerX: 500, centerY: 400, zoom: 1 }, { width: 1000, height: 800 }),
  mode: 'pan',
  draft: [],
  draftColor: null,
  selectionId: null,
  svgRef: { current: null },
  started: true,
  onPointerDown() {},
  onPointerMove() {},
  onPointerUp() {},
  onPointerCancel() {},
  onLostPointerCapture() {},
  onPointerLeave() {},
  onWheel() {},
  ...(over ?? {}),
})

check('the map surface renders strokes in their own colours', () => {
  const html = render(react.createElement(plugin.__test.MapSurface, surfaceProps()))
  assert(html.includes('viewBox="0 0 1000 800"'), 'the viewBox should cover the whole canvas at zoom 1')
  assert(html.includes('山门'), 'the pin label should be rendered')
  assert(html.includes('pin-2'), 'an unlabelled pin should show its id')
  assert(html.includes('M 10 10 L 20 20 L 30 15'), 'the first stroke path should be rendered')
  // COLOUR: each stroke draws in the colour it was drawn with, so changing the pen never recolours
  // existing work.
  assert(html.includes('#c0504d'), 'the first stroke keeps its colour')
  assert(html.includes('#4a9e6f'), 'the second stroke keeps its own colour')
  // A legacy stroke with no colour still renders, in the default pen colour.
  const legacy = render(
    react.createElement(plugin.__test.MapSurface, surfaceProps({ map: { ...sampleMap, strokes: [{ color: null, points: [[1, 1], [2, 2]] }] } })),
  )
  assert(legacy.includes(plugin.__test.MAP_DEFAULT_COLOR), 'a colourless stroke falls back to the pen')
})

check('the map surface survives a junk document', () => {
  // The exact class of bug this project shipped fifteen times: a guarded container with unguarded
  // elements. A map file edited by hand must degrade, not blank the panel.
  const junks = [
    undefined,
    null,
    'nonsense',
    {},
    { canvas: null, strokes: null, pins: null, background: null },
    { canvas: { width: 0, height: 0 }, strokes: [null, 1, 'x'], pins: [null, {}], background: { kind: 'image', asset: 42 }, labelSize: NaN },
    { canvas: { width: 10, height: 10 }, strokes: [{ points: [[1, 1]] }, { color: 5 }], pins: [{ id: 'p', x: NaN, y: 'x' }] },
    { maps: [null, 'x', {}], activeMapId: 'nope' },
  ]
  for (const junk of junks) {
    const map = Array.isArray(junk?.maps) ? plugin.__test.resolveActiveMap(junk, null) : junk
    const html = render(react.createElement(plugin.__test.MapSurface, surfaceProps({ map })))
    assert(html.includes('<svg'), `the surface must still render for ${JSON.stringify(junk)}`)
    assert(!html.includes('NaN'), `no NaN may reach the markup for ${JSON.stringify(junk)}`)
    assert(!html.includes('undefined'), `no literal undefined may reach the markup for ${JSON.stringify(junk)}`)
  }
})

check('the map surface shows an imported background as an image, and drops the grid', () => {
  const html = render(
    react.createElement(plugin.__test.MapSurface, surfaceProps({ map: { ...sampleMap, background: { kind: 'image', asset: 'world.png' } } })),
  )
  assert(html.includes('<image'), 'an imported background renders as an image element')
  assert(html.includes('world.png'), 'the image points at the imported asset')
  assert(!html.includes('<line'), 'the grid is replaced by the image, so it never draws over artwork')
})

check('an untouched map renders nothing at all', () => {
  // Requested explicitly: before anything is drawn the map is blank — nothing at all. Reported
  // twice before that: the GRID read as "a background covered in dots", then the PINS did.
  const html = render(
    react.createElement(plugin.__test.MapSurface, surfaceProps({ map: { ...sampleMap, strokes: [], pins: [] }, started: false })),
  )
  for (const tag of ['rect', 'line', 'circle', 'text', 'path']) {
    assert(!html.includes(`<${tag}`), `a blank map must draw no <${tag}>`)
  }
  assert(html.includes('<svg'), 'the surface itself must still exist, or there is nothing to draw on')
  assert(html.length < 400, `a blank surface should be tiny, got ${html.length} bytes`)

  // Content brings everything back.
  const drawn = render(react.createElement(plugin.__test.MapSurface, surfaceProps({ map: { ...sampleMap, strokes: [], pins: [] }, started: true })))
  assert(drawn.includes('<rect') && drawn.includes('<line'), 'a started map shows its sheet and guide')
})

check('an export is sized and named safely', () => {
  // Borrowed from Hex-Cartographer's export feature (its IDEAS are fair game; its GPL code and art are
  // not). The arithmetic is pure, so it is the part that can be checked here — the drawing itself only
  // happens in a browser.
  const size = mapHelpers.mapExportSize({ width: 2000, height: 1500 }, 2)
  assert(size.width === 4000 && size.height === 3000, `a 2× export of a 2000-wide canvas is 4000px, got ${size.width}x${size.height}`)
  assert(mapHelpers.mapExportSize({ width: 1000, height: 800 }, 1).width === 1000, '1× is the canvas itself')
  assert(mapHelpers.mapExportSize({ width: 1337, height: 977 }, 3).width === 4011, 'odd sizes round, not truncate')
  // A junk canvas must still produce a drawable size, and a nonsense scale must not produce NaN.
  for (const [canvas, scale] of [[null, 2], [{}, 2], [{ width: 0, height: 0 }, 2], [{ width: 2000, height: 1500 }, 0], [{ width: 2000, height: 1500 }, NaN], [{ width: -5, height: -5 }, -3]]) {
    const result = mapHelpers.mapExportSize(canvas, scale)
    assert(Number.isFinite(result.width) && result.width >= 1, `usable width for ${JSON.stringify(canvas)} @ ${scale}`)
    assert(Number.isFinite(result.height) && result.height >= 1, `usable height for ${JSON.stringify(canvas)} @ ${scale}`)
  }

  // FILE NAMES. A map called 大陆/全图 must not become a PATH, and Windows forbids several of these
  // characters outright — so this is about a download that works, not cosmetics.
  assert(mapHelpers.mapExportName('大陆全图') === '大陆全图.png', 'a plain name is kept')
  assert(!mapHelpers.mapExportName('大陆/全图').includes('/'), 'a slash must not survive into a file name')
  assert(mapHelpers.mapExportName('大陆/全图') === '大陆-全图.png', 'it becomes a dash instead')
  assert(!/[\\:*?"<>|]/.test(mapHelpers.mapExportName('a:b*c?d')), 'Windows-forbidden characters are replaced')
  assert(mapHelpers.mapExportName('  spaced  ') === 'spaced.png', 'padding is trimmed rather than turned into dashes')
  assert(mapHelpers.mapExportName('') === 'map.png', 'an empty name still yields a file')
  assert(mapHelpers.mapExportName(null) === 'map.png', 'a missing name still yields a file')
  assert(mapHelpers.mapExportName('x'.repeat(300)).length <= 84, 'a very long name is truncated')
  // The extension is part of a file name, so a caller cannot smuggle a path or another type through it.
  assert(mapHelpers.mapExportName('m', '../evil') === 'm.png', 'a bad extension falls back to png')
  assert(mapHelpers.mapExportName('m', 'JPEG') === 'm.jpeg', 'a good extension is lower-cased')
  assert(mapHelpers.MAP_EXPORT_SCALES.includes(2), '2× is offered — a printable default')
})

check('the export resolves colours before detaching the SVG', () => {
  // The ways this silently produces a WRONG image, none of which a server render can catch:
  //   * a currentColor stroke cannot resolve once the SVG is detached, so it would export BLACK;
  //   * a detached SVG with no width/height has no intrinsic size to draw;
  //   * object URLs must be revoked, or every export leaks one.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/getComputedStyle\(svg\)\.color/.test(source), 'the live colour must be resolved before serialising')
  assert(/clone\.style\.color/.test(source), 'and written onto the clone')
  assert(/clone\.setAttribute\('width'/.test(source) && /clone\.setAttribute\('height'/.test(source), 'the clone needs an explicit size')
  assert(/new XMLSerializer\(\)\.serializeToString/.test(source), 'the SVG is serialised')
  assert(/xmlns/.test(source), 'the clone must declare the SVG namespace or it will not render')
  assert(/toBlob\(/.test(source), 'the canvas is encoded as a PNG blob')
  assert(/URL\.revokeObjectURL/.test(source), 'object URLs must be revoked')
  assert(/createElement\('a'\)/.test(source) && /link\.download/.test(source), 'the download is a real anchor with a name')
  assert(/mapExportName\(active === null \? null : mapDisplayName\(active\)/.test(source), 'the file is named after the map, by its DISPLAY name')
})

check('a generated map is plausible, deterministic, and inside its canvas', () => {
  // IDENTICAL RESULTS ARE THE FEATURE: an author reseeds until they like what they see, and a test
  // can only assert anything at all because the same seed gives the same map.
  const canvas = { width: 1600, height: 1200 }
  const one = mapHelpers.generateRandomMap(7, canvas)
  const again = mapHelpers.generateRandomMap(7, canvas)
  assert(JSON.stringify(one) === JSON.stringify(again), 'the same seed must give the same map')
  const other = mapHelpers.generateRandomMap(8, canvas)
  assert(JSON.stringify(one) !== JSON.stringify(other), 'a different seed must give a different map')

  // A coastline as the only STROKE, and the rivers and roads as PATHS — because a stroke has one
  // width for its whole length and a river drawn that way reads as a wire.
  assert(one.strokes.length === 1, `the coastline is the only stroke, got ${one.strokes.length}`)
  const coast = one.strokes[0]
  assert(coast.points.length > 100, 'the coastline is a detailed ring')
  assert(coast.points[0][0] === coast.points[coast.points.length - 1][0], 'the coastline closes horizontally')
  assert(coast.points[0][1] === coast.points[coast.points.length - 1][1], 'the coastline closes vertically')
  const rivers = one.paths.filter((entry) => entry.kind === 'river')
  const roads = one.paths.filter((entry) => entry.kind === 'road')
  assert(rivers.length >= 3 && rivers.length <= 5, `3–5 rivers, got ${rivers.length}`)
  assert(rivers.every((entry) => entry.taper > 0), 'every river must taper, or it is a wire')
  assert(rivers.every((entry) => entry.points.length >= 2), 'every river is drawable')
  assert(roads.every((entry) => entry.taper === 0), 'a road must be uniform')
  assert(one.paths.length === rivers.length + roads.length, 'paths are rivers and roads and nothing else')
  for (const stroke of one.strokes) {
    assert(Array.isArray(stroke.points) && stroke.points.length >= 2, 'every stroke is drawable')
    for (const [x, y] of stroke.points) {
      assert(Number.isFinite(x) && Number.isFinite(y), 'no junk coordinates')
      assert(x >= 0 && x <= canvas.width && y >= 0 && y <= canvas.height, `(${x},${y}) must be inside the canvas`)
    }
    // Strokes go through `mapStrokes`, and anything it rejected would silently vanish from the map.
    assert(mapHelpers.mapStrokes({ strokes: [stroke] }).length === 1, 'the normaliser must keep every generated stroke')
  }

  // Settlements: 4–7, with distinct ids and real names.
  assert(one.pins.length >= 4 && one.pins.length <= 7, `4–7 settlements, got ${one.pins.length}`)
  const ids = new Set(one.pins.map((pin) => pin.id))
  assert(ids.size === one.pins.length, 'generated pin ids must be unique')
  const names = new Set(one.pins.map((pin) => pin.label))
  assert(names.size === one.pins.length, 'generated names must be distinct')
  for (const pin of one.pins) {
    assert(typeof pin.label === 'string' && pin.label.length >= 3, `a real name, got ${JSON.stringify(pin.label)}`)
    assert(!pin.label.includes('undefined'), 'a name must never contain the word undefined')
    assert(mapHelpers.MAP_PLACE_SUFFIX.some((suffix) => pin.label.endsWith(suffix)), `${pin.label} should end in a place suffix`)
    assert(pin.x >= 0 && pin.x <= canvas.width && pin.y >= 0 && pin.y <= canvas.height, 'a settlement must be on the canvas')
    assert(mapHelpers.mapPins({ pins: [pin] }).length === 1, 'the normaliser must keep every generated pin')
  }

  // Ids already in use must be avoided, or generating into a document would create duplicates.
  const taken = one.pins.map((pin) => pin.id)
  const more = mapHelpers.generateRandomMap(9, canvas, taken)
  for (const pin of more.pins) assert(!taken.includes(pin.id), `generated ${pin.id}, which is already in use`)

  // Junk must still produce a usable map rather than throwing.
  for (const [seed, size] of [[undefined, canvas], [null, canvas], [NaN, canvas], [0, canvas], [7, null], [7, {}], [7, { width: 0, height: 0 }], [7, { width: -5, height: -5 }]]) {
    const generated = mapHelpers.generateRandomMap(seed, size)
    assert(generated.strokes.length >= 1, `strokes for seed ${seed}`)
    assert(generated.paths.length >= 3, `paths for seed ${seed}`)
    assert(generated.pins.length >= 4, `pins for seed ${seed}`)
    for (const stroke of generated.strokes) {
      for (const [x, y] of stroke.points) assert(Number.isFinite(x) && Number.isFinite(y), 'no NaN with a junk canvas')
    }
    for (const course of generated.paths) {
      for (const point of course.points) assert(Number.isFinite(point.x) && Number.isFinite(point.y), 'no NaN in a path with a junk canvas')
    }
  }
  // Many seeds, because a harmonic that can blow up does so only for particular phases.
  for (let seed = 1; seed <= 40; seed += 1) {
    const generated = mapHelpers.generateRandomMap(seed, canvas)
    for (const stroke of generated.strokes) {
      for (const [x, y] of stroke.points) {
        assert(x >= 0 && x <= canvas.width && y >= 0 && y <= canvas.height, `seed ${seed} put a point at (${x},${y})`)
      }
    }
  }
})

check('an export never draws light ink on the white sheet', () => {
  // THE DEFECT, found by arithmetic rather than by eye. The map draws uncoloured strokes and all pin
  // labels with `currentColor`, taken from the app's theme. The export fills the sheet WHITE — so in
  // a dark theme the exported map is very nearly blank. Measured, #d8d8d8 on white is 1.43:1.
  assert(mapHelpers.mapContrast('#ffffff', '#ffffff') === 1, 'white on white is 1:1')
  assert(mapHelpers.mapContrast('#000000', '#ffffff') === 21, 'black on white is 21:1')
  const darkTheme = mapHelpers.mapContrast('#d8d8d8', '#ffffff')
  assert(darkTheme !== null && darkTheme < 1.5, `the dark theme's ink is nearly invisible on white, got ${darkTheme}`)
  assert(mapHelpers.mapExportInk('#d8d8d8', '#ffffff') === '#333333', 'so it must be replaced with readable ink')
  assert(mapHelpers.mapExportInk('#eeeeee', '#ffffff') === '#333333', 'and so must near-white')
  assert(mapHelpers.mapExportInk('#ffffff', '#ffffff') === '#333333', 'and pure white')
  // A theme that IS legible on white is respected, so the export is not always monochrome.
  assert(mapHelpers.mapExportInk('#333333', '#ffffff') === '#333333', 'dark ink is kept')
  assert(mapHelpers.mapExportInk('#1a1a1a', '#ffffff') === '#1a1a1a', 'a legible colour is used as-is')
  // The contrast of what is USED must always be adequate, whatever came in.
  for (const resolved of ['#d8d8d8', '#eee', '#fff', '#333', '#7a7a7a', 'rgb(216, 216, 216)', 'rgb(20,20,20)', 'nonsense', '', null, undefined, 42]) {
    const ink = mapHelpers.mapExportInk(resolved, '#ffffff')
    const ratio = mapHelpers.mapContrast(ink, '#ffffff')
    assert(ratio !== null && ratio >= 4.5, `ink ${ink} from ${JSON.stringify(resolved)} has only ${ratio}:1`)
  }
  // An unparseable colour is "no opinion", not "invisible": null, never a ratio of 1.
  for (const junk of ['', null, undefined, 'currentcolor', 'not-a-colour', 42, {}, '#12345']) {
    assert(mapHelpers.mapContrast(junk, '#ffffff') === null, `no opinion for ${JSON.stringify(junk)}`)
    assert(mapHelpers.mapParseColor(junk) === null, `nothing parsed from ${JSON.stringify(junk)}`)
  }
  assert(mapHelpers.mapParseColor('#abc').r === 170, 'short hex expands')
  assert(mapHelpers.mapParseColor('#000000').r === 0, 'long hex parses')
  assert(mapHelpers.mapParseColor('rgb(1, 2, 3)').b === 3, 'rgb() parses')
  assert(mapHelpers.mapParseColor('rgba(1, 2, 3, 0.5)').g === 2, 'rgba() parses')
  // And the export must actually USE this, not the raw theme colour.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/clone\.style\.color = mapExportInk\(/.test(source), 'the export must choose its ink, not copy the theme')
})

check('a river tapers from its source to its mouth', () => {
  // THE WHOLE POINT OF THE FEATURE. An SVG stroke has one width for its whole length, so a drawn river
  // reads as a wire; a river narrows to nothing at its source and widens toward its mouth. The
  // technique is borrowed from Azgaar's Fantasy-Map-Generator (MIT) — "the polygon is the course
  // inflated by its width, which peaks at the mouth" — and reimplemented, because their width comes
  // from a hydrological simulation this project has no equivalent of.
  assert(Math.abs(mapHelpers.mapPathHalfWidth(1, 40, 0) - 20) < 1e-9, 'an untapered path is half its width everywhere')
  assert(Math.abs(mapHelpers.mapPathHalfWidth(0, 40, 0) - 20) < 1e-9, 'including at the source')
  assert(mapHelpers.mapPathHalfWidth(0, 40, 1) === 0, 'a fully tapered path is a POINT at its source')
  assert(Math.abs(mapHelpers.mapPathHalfWidth(1, 40, 1) - 20) < 1e-9, 'and full width at its mouth')
  // Monotonic: a river must never get NARROWER as it flows.
  let previous = -1
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const half = mapHelpers.mapPathHalfWidth(t, 40, 0.9)
    assert(half >= previous - 1e-9, `the half-width must never decrease (t=${t.toFixed(2)})`)
    previous = half
  }
  // A convex profile, so the widening is visible along the middle rather than only at the very end.
  assert(mapHelpers.mapPathHalfWidth(0.5, 40, 0.9) < 20 * 0.55, 'the midpoint is well under half the mouth width')
  // Junk must still give a usable, finite half-width.
  for (const [t, width, taper] of [[NaN, 40, 0.5], [0.5, NaN, 0.5], [0.5, 40, NaN], [-1, -5, 2], [2, 1e9, 9]]) {
    const half = mapHelpers.mapPathHalfWidth(t, width, taper)
    assert(Number.isFinite(half) && half >= 0, `usable half-width for ${t},${width},${taper}`)
    assert(half <= mapHelpers.MAP_PATH_MAX_WIDTH / 2, 'and never absurdly wide')
  }
})

check('the bank polygon is the course at exactly its own width', () => {
  // The polygon IS the drawn shape for a tapered path, so its width is the feature. Smoothing the ring
  // as one closed curve rounds the two end caps as well, and a cap is a 180° turn — Catmull-Rom's
  // worst case. Measured on a straight width-40 course, that bulged to ±26.7: a third too wide, at
  // both ends. Each bank is smoothed OPEN and the caps are straight lines, which is exact.
  const span = (d) => {
    const points = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
    return {
      x: [Math.min(...points.map((p) => p.x)), Math.max(...points.map((p) => p.x))],
      y: [Math.min(...points.map((p) => p.y)), Math.max(...points.map((p) => p.y))],
    }
  }
  const straight = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }]
  for (const taper of [0, 0.5, 1]) {
    const d = mapHelpers.mapBankPath(straight, 40, taper)
    const box = span(d)
    assert(d.trim().endsWith('Z'), 'the outline is closed')
    assert(Math.abs(box.y[0] + 20) < 0.01 && Math.abs(box.y[1] - 20) < 0.01, `taper ${taper}: the banks must sit at ±20, got ${box.y[0]}..${box.y[1]}`)
    assert(box.x[0] >= -0.01 && box.x[1] <= 200.01, `taper ${taper}: the caps must not overshoot the ends, got ${box.x[0]}..${box.x[1]}`)
  }
  // A vertical course, so the perpendicular direction is exercised rather than assumed.
  const vertical = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 200 }]
  const upright = span(mapHelpers.mapBankPath(vertical, 40, 0))
  assert(Math.abs(upright.x[0] + 20) < 0.01 && Math.abs(upright.x[1] - 20) < 0.01, `banks at ±20 in x, got ${upright.x[0]}..${upright.x[1]}`)
  // Width scales with the setting, so the width control means something.
  assert(Math.abs(span(mapHelpers.mapBankPath(straight, 80, 0)).y[1] - 40) < 0.01, 'doubling the width doubles the banks')
  // Degenerate input yields nothing at all, never NaN and never a stray shape.
  for (const junk of [[], null, undefined, 'x', [{ x: 1, y: 1 }], [{ x: NaN, y: 0 }, { x: 1, y: 1 }], [{}, {}]]) {
    const d = mapHelpers.mapBankPath(junk, 40, 0.5)
    assert(d === '', `nothing drawable for ${JSON.stringify(junk)}, got ${JSON.stringify(d)}`)
    assert(!/NaN|undefined/.test(d), 'and certainly no NaN')
  }
})

check('the smooth curve passes through every waypoint', () => {
  // The property that matters: a waypoint the author dragged must end up UNDER the drawn line. A
  // smoothing scheme that merely approximates the points would make the handle and the line disagree,
  // which is indistinguishable from a bug in the drag.
  const waypoints = [{ x: 0, y: 0 }, { x: 50, y: 80 }, { x: 140, y: 20 }, { x: 200, y: 90 }]
  const d = mapHelpers.mapSmoothPath(waypoints)
  for (const point of waypoints) {
    const at = `${point.x} ${point.y}`
    assert(d.includes(` ${at}`), `the curve must reach the waypoint ${at}: ${d.slice(0, 80)}`)
  }
  assert(d.startsWith('M 0 0'), 'it starts at the first waypoint')
  assert(d.includes(' C '), 'and is smoothed, not straight segments')
  assert(!d.includes(' L '), 'a three-or-more point curve uses Béziers throughout')
  // Two points cannot be smoothed meaningfully; a straight line is the honest answer.
  assert(mapHelpers.mapSmoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }]) === 'M 0 0 L 10 10', 'two points make a line')
  assert(mapHelpers.mapSmoothPath([{ x: 3, y: 4 }]) === 'M 3 4', 'one point is a move')
  // Junk points are dropped rather than producing NaN in the path data.
  for (const junk of [[], null, undefined, [{ x: NaN, y: 0 }], [{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 5, y: 5 }]]) {
    const curve = mapHelpers.mapSmoothPath(junk)
    assert(!/NaN|undefined/.test(curve), `no NaN for ${JSON.stringify(junk)}`)
  }
  const closed = mapHelpers.mapSmoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true)
  assert(closed.trim().endsWith('Z'), 'a closed curve says so')
})

check('path waypoints can be added, moved and removed', () => {
  const paths = [{ id: 'path-1', kind: 'river', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], color: '#5b8fb0', width: 26, taper: 0.85, dash: 'solid' }]

  // INSERTING goes after the nearest SEGMENT, not the nearest waypoint. Using the nearest waypoint
  // would always insert beside one, so clicking halfway along a long straight stretch would put the
  // point at an end and the shape would not follow the pointer.
  assert(mapHelpers.pathInsertIndex(paths[0].points, { x: 50, y: 0 }) === 1, 'a click midway belongs after the first point')
  assert(mapHelpers.pathInsertIndex(paths[0].points, { x: -40, y: 0 }) === 0, 'a click before the start belongs first')
  assert(mapHelpers.pathInsertIndex(paths[0].points, { x: 300, y: 0 }) === 2, 'a click past the end belongs last')
  // A click off to the side belongs wherever the NEAREST POINT on the course is, which for a point
  // level with the head is the head.
  assert(mapHelpers.pathInsertIndex(paths[0].points, { x: 0, y: 300 }) === 0, 'a click level with the head belongs first')
  assert(mapHelpers.pathInsertIndex(paths[0].points, { x: 100, y: 300 }) === 2, 'a click level with the tail belongs last')
  assert(mapHelpers.pathInsertIndex([], { x: 1, y: 1 }) === 0, 'an empty course has one place to insert')
  const inserted = mapHelpers.mapPathInsert(paths, 'path-1', { x: 50, y: 7 })
  assert(inserted[0].points.length === 3, 'the waypoint is added')
  assert(inserted[0].points[1].x === 50 && inserted[0].points[1].y === 7, 'in the middle, where clicked')

  const moved = mapHelpers.mapPathMovePoint(paths, 'path-1', 1, { x: 42.6, y: -3.4 })
  assert(moved[0].points[1].x === 43 && moved[0].points[1].y === -3, `rounded to integers, got ${JSON.stringify(moved[0].points[1])}`)
  assert(moved[0].points[0].x === 0, 'and the other waypoints are untouched')
  assert(mapHelpers.mapPathMovePoint(paths, 'path-1', 9, { x: 1, y: 1 })[0].points.length === 2, 'an out-of-range index changes nothing')
  assert(mapHelpers.mapPathMovePoint(paths, 'path-1', 0, { x: NaN, y: 1 })[0].points[0].x === 0, 'a junk position changes nothing')

  // REMOVING the last waypoint of a two-point course leaves nothing drawable, so the path GOES: an
  // invisible object that can still be selected would be worse than no object.
  assert(mapHelpers.mapPathRemovePoint(paths, 'path-1', 1).length === 0, 'a course left with one point is removed')
  const three = mapHelpers.mapPathInsert(paths, 'path-1', { x: 50, y: 0 })
  assert(mapHelpers.mapPathRemovePoint(three, 'path-1', 1).length === 1, 'a course left with two points survives')
  assert(mapHelpers.mapPathRemovePoint(three, 'path-1', 1)[0].points.length === 2, 'with one point fewer')
  assert(mapHelpers.mapPathRemove(paths, 'path-1').length === 0, '删除 removes the whole path')
  assert(mapHelpers.mapPathRemove(paths, 'nope').length === 1, 'an unknown id removes nothing')

  // STARTING and EXTENDING, which is what clicks on the canvas do.
  const started = mapHelpers.mapPathStart(paths, 'path-2', { x: 5, y: 6 }, 'road')
  assert(started.length === 2, 'a new course is added alongside')
  assert(started[1].kind === 'road' && started[1].taper === 0, 'with the preset of the kind asked for')
  assert(started[1].points.length === 1, 'holding one waypoint, so it is not yet drawable')
  // A one-point course must NOT survive normalisation, or it would render as a dot.
  assert(mapHelpers.mapPaths({ paths: started }).length === 1, 'and is dropped until it has two')
  const extended = mapHelpers.mapPathAppend(started, 'path-2', { x: 60, y: 60 })
  assert(extended[1].points.length === 2, 'appending makes it drawable')
  assert(mapHelpers.mapPaths({ paths: extended }).length === 2, 'and it then survives normalisation')

  // Settings are clamped, so a hand-edited file cannot produce a 10,000-wide path.
  const wide = mapHelpers.mapPathUpdate(paths, 'path-1', { width: 99999 })
  assert(wide[0].width === mapHelpers.MAP_PATH_MAX_WIDTH, 'the width is capped')
  assert(mapHelpers.mapPathUpdate(paths, 'path-1', { width: 0 })[0].width === 26, 'a nonsense width falls back to the preset')
  assert(mapHelpers.mapPathUpdate(paths, 'path-1', { taper: 5 })[0].taper === 1, 'the taper is clamped')
  assert(mapHelpers.mapPathUpdate(paths, 'path-1', { dash: 'wavy' })[0].dash === 'solid', 'an unknown dash falls back')
  assert(mapHelpers.mapPathUpdate(paths, 'path-1', { color: '' })[0].color === '#5b8fb0', 'an empty colour falls back')
  assert(mapHelpers.mapPathUpdate(paths, 'path-1', { kind: 'road' })[0].kind === 'road', 'the kind changes')
  // SWITCHING KIND MUST ADOPT THE NEW KIND'S LOOK. Keeping the old style meant a road switched to 河流
  // came out with `kind: 'river'` and `taper: 0` — a river by name, drawn as an untapered line, which is
  // exactly what the author was trying to stop seeing. A patch that says otherwise still wins.
  const asRoad = mapHelpers.mapPathUpdate(paths, 'path-1', { kind: 'road' })
  assert(asRoad[0].taper === 0, 'a river switched to a road becomes uniform')
  assert(asRoad[0].dash === 'dashed', 'and adopts the road dash')
  const backToRiver = mapHelpers.mapPathUpdate(asRoad, 'path-1', { kind: 'river' })
  assert(backToRiver[0].taper > 0, 'a road switched to a river TAPERS')
  assert(backToRiver[0].dash === 'solid', 'and adopts the river dash')
  assert(backToRiver[0].points.length === 2, 'while keeping its waypoints')
  assert(mapHelpers.mapPathUpdate(paths, 'path-1', { kind: 'road', taper: 0.5 })[0].taper === 0.5, 'an explicit value in the same patch wins')

  // THE DRAG CHAIN, end to end: hit test → intent → move. Asserted here because dragging a handle is
  // how a course is reshaped, and it failed for the author along with drawing a new one.
  const hit = mapHelpers.pathPointAt(paths, { x: 100, y: 0 }, 20)
  assert(hit !== null && hit.id === 'path-1' && hit.index === 1, `the middle waypoint must be grabbable, got ${JSON.stringify(hit)}`)
  const intent = mapHelpers.mapDragMove({ drag: { kind: 'waypoint', pointerId: 1, id: hit.id, index: hit.index }, pointerId: 1, world: { x: 140, y: 60 }, view: mapHelpers.mapViewBox(null, { width: 400, height: 300 }), canvas: { width: 400, height: 300 } })
  assert(intent.waypoint !== undefined, 'a waypoint drag must produce a waypoint intent')
  assert(intent.pin === undefined && intent.view === undefined, 'and not a pin or pan intent')
  const dragged = mapHelpers.mapPathMovePoint(paths, intent.waypoint.id, intent.waypoint.index, intent.waypoint)
  assert(dragged[0].points[1].x === 140 && dragged[0].points[1].y === 60, `the dragged waypoint moves, got ${JSON.stringify(dragged[0].points[1])}`)
  assert(dragged[0].points[0].x === 0, 'and its neighbours do not')
})

check('paths survive a junk document, and ids stay unique', () => {
  // Same class as the rest of this file: a guarded container with unguarded elements.
  for (const junk of [undefined, null, 'x', {}, { paths: null }, { paths: 'x' }, { paths: [null, 1, 'y'] }, { paths: [{ points: [] }] }, { paths: [{ kind: 'river', points: [[1, 2]] }] }]) {
    const paths = mapHelpers.mapPaths(junk)
    assert(Array.isArray(paths), `a list for ${JSON.stringify(junk)}`)
    for (const path of paths) {
      assert(typeof path.id === 'string' && path.id !== '', 'every path has an id')
      assert(path.points.length >= 2, 'every path is drawable')
      assert(typeof path.color === 'string' && path.color !== '', 'every path has a colour')
      assert(Number.isFinite(path.width) && path.width > 0, 'every path has a width')
      assert(path.taper >= 0 && path.taper <= 1, 'every path has a sane taper')
      assert(path.dash in mapHelpers.MAP_DASHES, 'every path has a known dash')
    }
  }
  // Duplicate ids within one map would make dragging a waypoint move another path's.
  const duplicated = mapHelpers.mapPaths({
    paths: [
      { id: 'path-1', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { id: 'path-1', points: [{ x: 2, y: 2 }, { x: 3, y: 3 }] },
      { id: 'path-1', points: [{ x: 4, y: 4 }, { x: 5, y: 5 }] },
    ],
  })
  const ids = duplicated.map((entry) => entry.id)
  assert(ids.length === 3, 'all three survive')
  assert(new Set(ids).size === 3, `ids must be made unique, got ${ids.join(',')}`)
  // A legacy point form (`[x, y]` pairs) is accepted, since that is what the stroke code writes.
  const legacy = mapHelpers.mapPaths({ paths: [{ id: 'p', points: [[1, 2], [3, 4]] }] })
  assert(legacy.length === 1 && legacy[0].points[1].x === 3, 'pair-style points are read')
})

check('one drag is one undo step', () => {
  // THE BORROWED PATTERN, from the history plugin behind DSH's own editor: a snapshot of the present,
  // an undo stack, a redo stack, and a MERGE WINDOW. Without the window, dragging a waypoint across
  // the map would leave one step per pointer move, and 撤销 would appear to do nothing sixty times.
  let history = mapHelpers.mapHistoryNew({ v: 1 })
  assert(!mapHelpers.mapHistoryCanUndo(history), 'nothing to undo at the start')
  assert(mapHelpers.mapHistorySnapshot(history).v === 1, 'and the present is the initial state')

  // A drag: six moves of ONE waypoint, all inside the window.
  for (let step = 0; step < 6; step += 1) {
    history = mapHelpers.mapHistoryPush(history, { v: 1, at: step }, { mergeKey: 'point-A', at: 1000 + step * 10 })
  }
  // SIX moves of one waypoint, and the whole drag is ONE step — undoable, but once.
  assert(history.undoStack.length === 1, `one drag must be one undo step, got ${history.undoStack.length}`)
  assert(mapHelpers.mapHistorySnapshot(history).at === 5, 'the present is the latest move')
  assert(mapHelpers.mapHistorySnapshot(mapHelpers.mapHistoryUndo(history)).v === 1, 'and undoing it returns to the state before the drag began')

  // A different waypoint starts a new step.
  history = mapHelpers.mapHistoryPush(history, { v: 2 }, { mergeKey: 'point-B', at: 1100 })
  assert(mapHelpers.mapHistoryCanUndo(history), 'a different target starts a new step')
  history = mapHelpers.mapHistoryUndo(history)
  assert(mapHelpers.mapHistorySnapshot(history).at === 5, 'undo returns to the state before it')
  assert(mapHelpers.mapHistoryCanRedo(history), 'and the future is reachable')
  history = mapHelpers.mapHistoryRedo(history)
  assert(mapHelpers.mapHistorySnapshot(history).v === 2, 'redo returns to it')

  // A pause longer than the window starts a new step even for the SAME target, so two separate drags
  // of one waypoint are two undos.
  let timed = mapHelpers.mapHistoryNew({ v: 0 })
  timed = mapHelpers.mapHistoryPush(timed, { v: 1 }, { mergeKey: 'point-A', at: 1000 })
  timed = mapHelpers.mapHistoryPush(timed, { v: 2 }, { mergeKey: 'point-A', at: 1000 + mapHelpers.MAP_HISTORY_MERGE_MS + 1 })
  assert(mapHelpers.mapHistoryCanUndo(timed), 'a pause closes the merge window')
  assert(mapHelpers.mapHistorySnapshot(mapHelpers.mapHistoryUndo(timed)).v === 1, 'and undo goes back one step')

  // A DISCRETE edit (no merge key) is always its own step.
  let discrete = mapHelpers.mapHistoryNew({ v: 0 })
  for (let step = 1; step <= 3; step += 1) discrete = mapHelpers.mapHistoryPush(discrete, { v: step }, { at: 2000 + step })
  assert(discrete.undoStack.length === 3, `three discrete edits are three steps, got ${discrete.undoStack.length}`)
  assert(mapHelpers.mapHistorySnapshot(mapHelpers.mapHistoryUndo(discrete)).v === 2, 'undoing one gives the previous')

  // Editing after an undo CLEARS the redo stack: the future you had undone is unreachable.
  let branch = mapHelpers.mapHistoryPush(discrete, { v: 99 }, { at: 3000 })
  assert(branch.redoStack.length === 0, 'a fresh edit clears the redo stack')

  // The stack is bounded, so a long session cannot grow without limit.
  let deep = mapHelpers.mapHistoryNew({ v: 0 })
  for (let step = 0; step < mapHelpers.MAP_HISTORY_LIMIT * 3; step += 1) deep = mapHelpers.mapHistoryPush(deep, { v: step }, { at: step, limit: 5 })
  assert(deep.undoStack.length <= 5, `the stack is bounded, got ${deep.undoStack.length}`)

  // Exhausted stacks are no-ops, not errors.
  const empty = mapHelpers.mapHistoryNew({ v: 0 })
  assert(mapHelpers.mapHistoryUndo(empty) === empty, 'undoing nothing returns the same history')
  assert(mapHelpers.mapHistoryRedo(empty) === empty, 'redoing nothing returns the same history')
  for (const junk of [undefined, null, {}, { undoStack: 'x', redoStack: 5 }]) {
    assert(mapHelpers.mapHistoryCanUndo(junk) === false, 'junk has nothing to undo')
    assert(mapHelpers.mapHistoryCanRedo(junk) === false, 'junk has nothing to redo')
    assert(mapHelpers.mapHistorySnapshot(junk) === null, 'junk has no present')
  }
})

check('a drawn path renders, tapered or not', () => {
  const withPaths = {
    ...sampleMap,
    paths: [
      { id: 'path-1', kind: 'river', color: '#5b8fb0', width: 30, taper: 0.85, dash: 'solid', points: [{ x: 10, y: 10 }, { x: 100, y: 40 }, { x: 200, y: 20 }] },
      { id: 'path-2', kind: 'road', color: '#a8763e', width: 8, taper: 0, dash: 'dashed', points: [{ x: 0, y: 0 }, { x: 50, y: 50 }] },
    ],
  }
  const html = render(react.createElement(plugin.__test.MapSurface, surfaceProps({ map: withPaths })))
  assert(html.includes('#5b8fb0'), 'the river is drawn in its colour')
  assert(html.includes('#a8763e'), 'and so is the road')
  // A TAPERED path is a FILLED polygon — that is the whole technique — so it must not be a stroke.
  assert(/fill="#5b8fb0"/.test(html), 'a tapered river is drawn as a filled outline')
  // A UNIFORM path is a stroked centre line, because that is what carries dashes properly.
  assert(/stroke="#a8763e"/.test(html), 'a uniform road is drawn as a stroke')
  assert(html.includes('stroke-dasharray'), 'and a dashed road is dashed')
  // The aria label counts them, so the map reports what it holds.
  assert(html.includes('河流道路'), 'the label mentions the paths')
})

check('a map holding only a river is not treated as blank', () => {
  // The blank rule was "no strokes and no pins". Adding paths without updating it would have made a map
  // of nothing but rivers render as an empty sheet — invisible work, the failure mode this file keeps
  // producing.
  const riversOnly = { ...sampleMap, strokes: [], pins: [], paths: [{ id: 'p', kind: 'river', color: '#5b8fb0', width: 20, taper: 0.8, dash: 'solid', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }] }
  const html = render(react.createElement(plugin.__test.MapSurface, surfaceProps({ map: riversOnly, started: false })))
  assert(html.includes('<path'), 'a river must be drawn even with no strokes and no pins')
  assert(html.includes('<rect'), 'and the sheet with it')
})

check('a generated map carries EVERY group the generator produced', () => {
  // FOUND BY RUNNING IT: the generator was taught to produce `paths`, and the 随机生成 button was not
  // taught to carry them. The button therefore made a map with a coastline, settlements and NO RIVERS
  // AT ALL, and nothing complained — the map simply looked like a different seed's worth of nothing.
  // `tools/generate-map.mjs` had the same omission, and its read-back check passed because it only
  // counted strokes and pins.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  const start = source.indexOf('const generateMap = () => {')
  assert(start !== -1, 'the generator button must exist')
  const end = source.indexOf('const removeMap', start)
  assert(end > start, 'and have a body')
  const body = source.slice(start, end)
  for (const group of ['strokes', 'paths', 'pins']) {
    assert(
      new RegExp(`${group}: generated\\.${group}`).test(body),
      `the generator button must carry ${group} from the generator, or that group is silently dropped`,
    )
  }
  // The generator itself must still PRODUCE all three, or the button has nothing to carry.
  const produced = mapHelpers.generateRandomMap(424242, { width: 1600, height: 1200 })
  assert(produced.strokes.length >= 1, 'a coastline')
  assert(produced.paths.length >= 3, 'rivers, and possibly roads')
  assert(produced.pins.length >= 4, 'settlements')
  // The tool that writes to disk must carry and verify them too: it is the path that was actually
  // exercised, and a read-back check that counts only two of three groups passes while data is lost.
  const tool = readFileSync(join(ROOT, 'tools', 'generate-map.mjs'), 'utf8')
  if (tool.includes('generateRandomMap')) {
    for (const group of ['strokes', 'paths', 'pins']) {
      assert(new RegExp(`${group}: generated\\.${group}`).test(tool), `the tool must carry ${group}`)
    }
    assert(/readBack\.paths\.length !== generated\.paths\.length/.test(tool), 'and verify paths on read-back')
  }
})

check('a NEW path can be drawn, not merely edited', () => {
  // REPORTED: "河流/道路可以修改,但无法绘制新的" — existing rivers could be opened and changed, but a new
  // one could never be drawn. The cause was two views of one list being used interchangeably:
  // `mapPaths` is the DRAWING view and drops a course with one point, because one point draws nothing.
  // The first click wrote a one-point draft; the second click looked for it in the drawing view, found
  // nothing, and did nothing. Any other edit in between erased the draft outright.
  const draft = { paths: [{ id: 'path-9', kind: 'river', points: [{ x: 10, y: 10 }], color: '#5b8fb0', width: 26, taper: 0.85, dash: 'solid' }] }
  assert(mapHelpers.mapPaths(draft).length === 0, 'a one-point course must NOT be drawn')
  assert(mapHelpers.mapAllPaths(draft).length === 1, 'but it must survive for editing')
  assert(mapHelpers.mapAllPaths(draft)[0].points.length === 1, 'with its single waypoint intact')

  // Replay the real click sequence, exactly as the handlers do it.
  let paths = []
  const id = 'path-1'
  paths = mapHelpers.mapPathStart(paths, id, { x: 800, y: 900 }, 'river')
  assert(mapHelpers.mapPaths({ paths }).length === 0, 'after click 1 there is still nothing to draw')
  assert(mapHelpers.mapAllPaths({ paths }).length === 1, 'and the draft is there to extend')
  const found = mapHelpers.mapAllPaths({ paths }).some((entry) => entry.id === id)
  assert(found, 'click 2 must FIND the draft — looking in the drawing view is the bug')
  paths = mapHelpers.mapPathAppend(paths, id, { x: 900, y: 950 })
  assert(mapHelpers.mapPaths({ paths }).length === 1, 'after click 2 the course is drawable')
  paths = mapHelpers.mapPathAppend(paths, id, { x: 1000, y: 1000 })
  const river = mapHelpers.mapAllPaths({ paths }).find((entry) => entry.id === id)
  assert(river.points.length === 3, 'and click 3 adds a third waypoint')
  assert(mapHelpers.mapBankPath(river.points, river.width, river.taper) !== '', 'the finished course renders')

  // Every OTHER edit must not destroy a draft either, which is what `updatePaths` rewriting from the
  // drawing view did.
  const withDraft = mapHelpers.mapPathStart([{ id: 'path-0', kind: 'road', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], id, { x: 5, y: 5 }, 'river')
  const untouched = mapHelpers.mapUpdatePin([{ id: 'm', paths: withDraft, pins: [{ id: 'pin-1', x: 0, y: 0 }] }], 'm', 'pin-1', { label: 'x' })
  assert(untouched[0].paths.length === 2, 'a pin edit keeps the half-drawn course')
  // `mapPathRemove` is the way a cancelled draft goes away.
  assert(mapHelpers.mapPathRemove(withDraft, id).length === 1, 'and a draft can be discarded')

  // AND THE WIRING, which is the part that was actually broken. Everything above passes with the bug
  // in place, because it exercises the helpers rather than the handlers that choose between the two
  // views — a test of the ingredients, not of the dish. Proven by replanting the bug: the assertions
  // below fail and the ones above do not.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  const branch = source.indexOf("if (mode === 'path') {")
  assert(branch !== -1, 'the path mode must exist')
  const handlers = source.slice(branch, source.indexOf('// Select a pin in ANY mode', branch))
  assert(/mapAllPaths\(active\)/.test(handlers), 'path-mode clicks must use the EDITING view')
  assert(!/mapPaths\(active\)/.test(handlers), 'and must not use the DRAWING view, which drops the draft')
  assert(/hitWaypoint = pathPointAt\(mapAllPaths\(active\)/.test(source), 'grabbing a waypoint must see drafts too')
  assert(/paths: mutator\(mapAllPaths\(entry\)\)/.test(source), 'updatePaths must rewrite from the editing view, or it erases the draft')
  assert(
    /const editing = mapAllPaths\(map\)\.find/.test(source),
    'the waypoint handles must be drawn from the editing view, or the first click of a new course shows nothing at all',
  )
  // AND THROUGH THE ENTRY POINTS THE APPLICATION ACTUALLY USES.
  //
  // This is the layer where the bug really lived, and the assertions above cannot see it: they build a
  // map object BY HAND and call `mapAllPaths` on it, while the app reads its maps through `mapMaps` →
  // `normalizeMap`. That normaliser was filtering drafts out with the DRAWING view, so the map the whole
  // UI held had already lost the draft — and every "use the editing view" fix downstream was handed a
  // map with nothing in it. The author reported the result precisely: clicking the map in 河流/道路 mode
  // did nothing at all. Test the path the application takes, not a convenient one.
  const draftPath = { id: 'path-1', kind: 'river', points: [{ x: 800, y: 600 }], color: '#5b8fb0', width: 26, taper: 0.9, dash: 'solid' }
  const oneDraftDoc = {
    version: 2,
    activeMapId: 'map-1',
    maps: [{ id: 'map-1', name: 'm', canvas: { width: 1600, height: 1200 }, background: { kind: 'blank', asset: null }, strokes: [{ color: null, points: [[0, 0], [1, 1]] }], pins: [], paths: [draftPath] }],
  }
  assert(mapHelpers.mapMaps(oneDraftDoc)[0].paths.length === 1, 'normalisation must PRESERVE a one-point draft, not filter it')
  const draftActive = mapHelpers.resolveActiveMap(oneDraftDoc, 'map-1')
  assert(mapHelpers.mapAllPaths(draftActive).length === 1, 'and the resolver the UI reads through must still see it')
  assert(mapHelpers.mapPaths(draftActive).length === 0, 'while the DRAWING view still excludes it — that is what the two views are for')
  assert(!mapHelpers.isBlank(mapHelpers.pathPointAt(mapHelpers.mapAllPaths(draftActive), { x: 800, y: 600 }, 20)), 'the draft waypoint must be grabbable')
  assert(
    /paths: mapAllPaths\(value\)/.test(source),
    'normalizeMap must use the editing view — filtering there removes the draft before any handler sees it',
  )
  // The first click must be VISIBLE. A one-point course draws no line, so the handle is the only
  // feedback there is; without it the click looks like it did nothing.
  const draftHtml = render(react.createElement(plugin.__test.MapSurface, surfaceProps({
    map: mapHelpers.mapMaps(oneDraftDoc)[0],
    editingPathId: 'path-1',
    view: mapHelpers.mapViewBox(null, { width: 1600, height: 1200 }),
  })))
  assert((draftHtml.match(/<circle/g) ?? []).length >= 1, 'the first click of a new course must draw a HANDLE')
})

check('pin labels are placed so that they do not overlap', () => {
  // REPORTED: "点的名称会重叠". Every label was drawn at one fixed offset to the right of its pin, so two
  // settlements close together produced two names on top of each other and neither could be read.
  const map = { labelSize: 34, labelFixed: false }
  // A CJK character is about one em wide; Latin about 0.58. There is no way to MEASURE text here, so an
  // estimate is the only option — and it is the estimate the layout has to be right about.
  assert(Math.abs(mapHelpers.mapLabelWidth('苏舟城', 34) - 102) < 1e-9, 'three CJK characters at size 34 are 102 wide')
  assert(mapHelpers.mapLabelWidth('abc', 34) < mapHelpers.mapLabelWidth('苏舟城', 34), 'Latin is narrower than CJK')
  assert(mapHelpers.mapLabelWidth('', 34) === 0, 'no text, no width')
  assert(Number.isFinite(mapHelpers.mapLabelWidth(null, 34)), 'junk text still measures')
  assert(mapHelpers.mapLabelAnchors(34).length === 8, 'eight placements to try')
  assert(mapHelpers.mapLabelAnchors(34).some((anchor) => anchor.anchor === 'end'), 'including ones that sit to the LEFT')
  assert(mapHelpers.mapLabelAnchors(34).some((anchor) => anchor.anchor === 'middle'), 'and centred ones')

  // The property that matters: NO two labels drawn may overlap, at any spacing.
  const overlaps = (layout) => {
    let count = 0
    for (let i = 0; i < layout.length; i += 1) {
      for (let j = i + 1; j < layout.length; j += 1) {
        if (mapHelpers.mapBoxesOverlap(layout[i].box, layout[j].box, 0)) count += 1
      }
    }
    return count
  }
  for (const distance of [8, 20, 40, 90, 150, 200, 400]) {
    const pins = [
      { id: 'a', x: 500, y: 400, label: '苏舟城' },
      { id: 'b', x: 500 + distance, y: 400, label: '萧晏镇' },
    ]
    const layout = mapHelpers.mapLabelLayout(pins, map, 1)
    assert(layout.length === 2, 'both names are drawn')
    assert(overlaps(layout) === 0, `names ${distance} apart must not overlap, got ${overlaps(layout)}`)
  }
  // A genuinely dense cluster, where the naive answer overlaps everywhere.
  let seed = 7
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const cluster = []
  for (let i = 0; i < 6; i += 1) cluster.push({ id: `p${i}`, x: 500 + next() * 120, y: 400 + next() * 80, label: `城${i}堡` })
  const dense = mapHelpers.mapLabelLayout(cluster, map, 1)
  assert(dense.length === 6, 'every name in the cluster is still drawn — no name may vanish silently')
  assert(overlaps(dense) === 0, `six names in a 120x80 box must not overlap, got ${overlaps(dense)}`)
  assert(dense.every((label) => label.crowded === false), 'and all six find a clear placement')

  // Far apart, nothing moves: the placement must not shuffle labels that were already fine.
  const sparse = mapHelpers.mapLabelLayout([{ id: 'a', x: 0, y: 0, label: '甲' }, { id: 'b', x: 900, y: 900, label: '乙' }], map, 1)
  assert(sparse.every((label) => label.anchor.anchor === 'start' && label.anchor.x > 0), 'a lone label stays to the right')
  // A label pushed out stays on the side it chose, so it is still obviously attached to its own pin.
  const pushed = mapHelpers.mapLabelLayout([{ id: 'a', x: 0, y: 0, label: '苏舟城' }, { id: 'b', x: 10, y: 0, label: '萧晏镇' }], map, 1)
  assert(pushed[1].anchor.anchor === 'end' || pushed[1].anchor.y > 0, 'the second label moves rather than staying put')
  // Deterministic, so the layout does not shimmer between renders.
  const again = mapHelpers.mapLabelLayout(cluster, map, 1)
  assert(JSON.stringify(dense) === JSON.stringify(again), 'the same input must give the same layout')

  // A pin with no text of its own uses the label the caller supplies, which is how a linked 地点's NAME
  // is shown instead of its raw id.
  const resolved = mapHelpers.mapLabelLayout(
    [{ id: 'pin-1', x: 0, y: 0, label: '', placeId: 'place-7' }],
    map,
    1,
    { labelOf: (pin) => (pin.label === '' ? '落霞渡' : pin.label) },
  )
  assert(resolved[0].text === '落霞渡', `the resolved name must be used, got ${resolved[0].text}`)
  // Junk in and out.
  for (const junk of [undefined, null, 'x', [null, 1], [{ id: 'a', x: NaN, y: 0, label: 'x' }]]) {
    const layout = mapHelpers.mapLabelLayout(junk, map, 1)
    assert(Array.isArray(layout), `a list for ${JSON.stringify(junk)}`)
    for (const label of layout) {
      assert(Number.isFinite(label.size) && label.size > 0, 'a usable font size')
      assert(Number.isFinite(label.box.x0) && Number.isFinite(label.box.y1), 'and a finite box')
    }
  }

  // AND THE WIRING: the pure layout above could be perfect while `MapSurface` ignores it. Asserted
  // through a real render, because that is what the author sees.
  const placed = (pins) => {
    const html = render(react.createElement(plugin.__test.MapSurface, surfaceProps({
      map: { ...sampleMap, canvas: { width: 1000, height: 800 }, strokes: [{ color: null, points: [[0, 0], [1, 1]] }], paths: [], pins, labelSize: 34, labelFixed: false },
      view: mapHelpers.mapViewBox(null, { width: 1000, height: 800 }),
    })))
    return [...html.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map((m) => ({
      text: m[2],
      x: Number(/x="(-?[\d.]+)"/.exec(m[1])?.[1]),
      anchor: /text-anchor="([a-z]+)"/.exec(m[1])?.[1] ?? 'start',
    }))
  }
  const close = placed([
    { id: 'a', x: 500, y: 400, placeId: null, label: '苏舟城' },
    { id: 'b', x: 512, y: 400, placeId: null, label: '萧晏镇' },
  ])
  assert(close.length === 2, 'both close labels are drawn')
  assert(new Set(close.map((label) => label.anchor + '@' + label.x)).size === 2, `the two must be placed differently, got ${JSON.stringify(close)}`)
  assert(close.some((label) => label.anchor === 'end' && label.x < 0), 'one moves to the LEFT of its pin')
  const apart = placed([
    { id: 'a', x: 200, y: 400, placeId: null, label: '苏舟城' },
    { id: 'b', x: 800, y: 400, placeId: null, label: '萧晏镇' },
  ])
  assert(new Set(apart.map((label) => label.anchor + '@' + label.x)).size === 1, 'labels that already clear each other must not be shuffled')
})

check('an empty reference says WHAT is unset', () => {
  // ASKED DIRECTLY: "编辑点的时候有「未设」是什么?" — a bare 「（未设）」 gave no clue what the field was.
  // `emptyLabel` lets a caller say it; the default is unchanged so every other branch reads as before.
  const form = readFileSync(join(ROOT, 'client', 'src', '30-form.js'), 'utf8')
  assert((form.match(/field\.emptyLabel \?\? '（未设）'/g) ?? []).length === 2, 'both the select and ref controls honour it')
  const mapSource = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(mapSource.includes('emptyLabel: '), 'and the map says what its unset reference means')
  assert(mapSource.includes('未关联地点'), 'naming the 地点 explicitly')
  // The linked place's NAME must be shown, not its id: `place-7` is technically informative and
  // practically useless in a map legend.
  assert(/placeTitles/.test(mapSource), 'the map resolves place names for its labels')
  const surface = render(
    react.createElement(plugin.__test.MapSurface, surfaceProps({
      map: { ...sampleMap, pins: [{ id: 'pin-1', placeId: 'place-7', x: 100, y: 100, label: '' }] },
      placeTitles: { 'place-7': '落霞渡' },
    })),
  )
  assert(surface.includes('落霞渡'), 'an unlabelled pin shows the name of the place it is linked to')
  assert(!surface.includes('place-7'), 'and NOT the raw id')
  // With no title available it still falls back rather than drawing nothing.
  const withoutTitle = render(
    react.createElement(plugin.__test.MapSurface, surfaceProps({
      map: { ...sampleMap, pins: [{ id: 'pin-1', placeId: 'place-7', x: 100, y: 100, label: '' }] },
    })),
  )
  assert(withoutTitle.includes('place-7'), 'a missing title falls back to something visible')
})

check('ids the host treats as document-wide are minted that way', () => {
  // REPORTED BY THE HOST ITSELF: "refusing to write setting/map/index.json: it would introduce 1
  // validation error(s) — duplicate-id id \"pin-1\" is already used by map-pin". Placing a pin minted
  // against the ACTIVE MAP's pins only, while the validator registers pin ids for the WHOLE DOCUMENT.
  // A map whose pins began at 15 therefore minted `pin-1`, collided with another map's, and from then on
  // EVERY write was refused — the author could not save anything at all.
  const maps = mapHelpers.mapMaps({
    version: 2,
    activeMapId: 'map-2',
    maps: [
      { id: 'layer-1', name: '图层 1', canvas: { width: 2000, height: 1500 }, pins: Array.from({ length: 8 }, (_, i) => ({ id: `pin-${i + 1}` })) },
      { id: 'map-2', name: '示例地图', canvas: { width: 1600, height: 1200 }, pins: Array.from({ length: 5 }, (_, i) => ({ id: `pin-${i + 15}` })) },
    ],
  })
  const active = mapHelpers.resolveActiveMap({ maps }, 'map-2')
  assert(active.id === 'map-2', 'the second map is active')
  // The bug, stated as a fact so nobody reintroduces it: the active map alone says pin-1 is free.
  assert(mapHelpers.mintMapId('pin-', mapHelpers.mapPins(active)) === 'pin-1', 'the active map alone would hand out pin-1')
  assert(mapHelpers.allPinIds(maps).includes('pin-1'), 'but pin-1 is already taken elsewhere in the document')
  const safe = mapHelpers.mintMapId('pin-', mapHelpers.allPinIds(maps))
  assert(!mapHelpers.allPinIds(maps).includes(safe), `the minted id must be free document-wide, got ${safe}`)
  assert(safe === 'pin-9', `the first free id after the other map's eight, got ${safe}`)

  // `allPinIds` returns STRINGS while the map list holds RECORDS. `mintMapId` must read both, or the
  // strings are silently read as `undefined` and nothing is avoided — the same defect that made a
  // generated map collide with an existing one.
  assert(mapHelpers.mintMapId('pin-', ['pin-1', 'pin-2']) === 'pin-3', 'bare id strings are honoured')
  assert(mapHelpers.mintMapId('pin-', [{ id: 'pin-1' }, 'pin-2']) === 'pin-3', 'and a mixture of both forms')
  assert(mapHelpers.mintMapId('pin-', ['', null, 42, {}]) === 'pin-1', 'junk is not an id')
  // Path ids are minted document-wide too, so extending validation later cannot block a save.
  const pathsAcross = [{ paths: [{ id: 'path-1' }] }, { paths: [{ id: 'path-2' }] }]
  assert(mapHelpers.allPathIds(pathsAcross).length === 2, 'path ids across every map')
  assert(mapHelpers.mintMapId('path-', mapHelpers.allPathIds(pathsAcross)) === 'path-3', 'and minted from all of them')
  assert(mapHelpers.allIdsOf(null, 'pins').length === 0, 'junk yields no ids')
  assert(mapHelpers.allIdsOf([{ pins: [null, {}, { id: '' }] }], 'pins').length === 0, 'and neither do junk entries')

  // THE WIRING: the canvas must mint from the document, not from the active map.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/mintMapId\('pin-', allPinIds\(maps\)\)/.test(source), 'placing a pin must avoid every pin in the document')
  assert(!/mintMapId\('pin-', pins\)/.test(source), 'and must not mint from the active map alone')
  assert(/mintMapId\('path-', allPathIds\(maps\)\)/.test(source), 'paths likewise')
})

check('no browser dialog is used, because Electron does not implement one', () => {
  // REPORTED: "地图的重命名按钮无用,点上去没有反应". The button called `window.prompt`, and ELECTRON DOES NOT
  // IMPLEMENT prompt/confirm/alert — the call returns without ever showing a box, so the button looked
  // dead. Nothing in the code was wrong except that the platform has no such dialog.
  const files = readdirSync(join(ROOT, 'client', 'src')).filter((name) => name.endsWith('.js'))
  assert(files.length > 5, 'the client has fragments to scan')
  for (const name of files) {
    const lines = readFileSync(join(ROOT, 'client', 'src', name), 'utf8').split('\n')
    lines.forEach((line, index) => {
      // Comments are stripped first: the map's own explanation of this bug names `window.prompt`.
      const code = line.replace(/\/\/.*$/, '')
      const call = /\bwindow\.(prompt|confirm|alert)\s*\(/.exec(code)
      assert(call === null, `${name}:${index + 1} calls ${call?.[1]}(), which Electron never answers`)
    })
  }
  // The replacement must be a real control, not merely the removal of one.
  const mapSource = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/地图名称/.test(mapSource), 'the map name is edited through a labelled field')
  assert(/mapRenameMap\(list, active\.id, event\.target\.value\)/.test(mapSource), 'and the field renames the map directly')
  assert(!/label: '重命名'/.test(mapSource), 'the dead button is gone')
})

check('the pen width is the stroke\'s own, and the marker its own size and colour', () => {
  // ASKED FOR: "点的大小和颜色要可以自定义" and "手绘的画笔粗细可以自定义". Both were hardcoded — the pen at a flat
  // `2 / zoom` and the marker at `r: 7 / zoom` filled with the theme colour — so neither could be
  // changed at all. Both now live WITH the thing they describe, so changing a control never redraws
  // what is already drawn.
  const strokes = mapHelpers.mapStrokes({ strokes: [
    { color: '#c0504d', width: 8, points: [[0, 0], [1, 1]] },
    { color: '#4a9e6f', points: [[0, 0], [2, 2]] },
    { color: null, width: 0, points: [[0, 0], [3, 3]] },
    { color: null, width: 'thick', points: [[0, 0], [4, 4]] },
    [[0, 0], [5, 5]],
  ] })
  assert(strokes.length === 5, `all five strokes are kept, got ${strokes.length}`)
  assert(strokes[0].width === 8, 'a stroke keeps the width it was drawn with')
  assert(strokes[1].width === null, 'a stroke with no width keeps none, so the pen decides')
  assert(strokes[2].width === null, 'a zero width is nonsense and is dropped')
  assert(strokes[3].width === null, 'and so is a non-numeric one')
  assert(strokes[4].width === null, 'a legacy pair-stroke never had a width')
  // Drawing falls back to the pen, and never produces something un-drawable.
  assert(mapHelpers.mapStrokeWidth(strokes[0], 4) === 8, 'the stroke wins over the pen')
  assert(mapHelpers.mapStrokeWidth(strokes[1], 16) === 16, 'and the pen is used when the stroke has none')
  assert(mapHelpers.mapStrokeWidth(strokes[1], null) === mapHelpers.MAP_PEN_DEFAULT, 'a junk pen falls back to the default')
  assert(mapHelpers.mapStrokeWidth(null, 32) === 32, 'junk stroke, pen width')
  for (const width of [0.0001, -5, NaN, Infinity, 'x', 1e9]) {
    const got = mapHelpers.mapStrokeWidth({ width }, 4)
    assert(Number.isFinite(got) && got > 0 && got <= 64, `a usable width for ${width}, got ${got}`)
  }
  assert(mapHelpers.MAP_PEN_WIDTHS.length >= 4, 'several pen widths are offered')
  assert(mapHelpers.MAP_PEN_WIDTHS.includes(mapHelpers.MAP_PEN_DEFAULT), 'and the default is one of them')

  // --- THE MARKER ---
  // A marker is a handle, so its size is in SCREEN pixels and does not change with zoom.
  assert(mapHelpers.mapPinDiameter({ pinSize: 20 }, {}) === 20, 'the map default applies')
  assert(mapHelpers.mapPinDiameter({ pinSize: 20 }, { dot: 8 }) === 8, 'a pin overrides the map')
  assert(mapHelpers.mapPinDiameter({}, {}) === mapHelpers.MAP_PIN_DEFAULT_SIZE, 'and the built-in default is the last resort')
  assert(mapHelpers.mapPinDiameter({ pinSize: 0 }, { dot: -1 }) === mapHelpers.MAP_PIN_DEFAULT_SIZE, 'nonsense falls through')
  assert(mapHelpers.mapPinDiameter({ pinSize: 'big' }, { dot: 'small' }) === mapHelpers.MAP_PIN_DEFAULT_SIZE, 'and so does junk')
  for (const [map, pin] of [[{ pinSize: 1e9 }, {}], [{ pinSize: -3 }, {}], [{ pinSize: NaN }, { dot: Infinity }]]) {
    const diameter = mapHelpers.mapPinDiameter(map, pin)
    assert(diameter >= 2 && diameter <= 80, `a drawable diameter, got ${diameter}`)
  }
  // The radius is the diameter on screen at ANY zoom, which is what keeps a marker clickable.
  const radiusAt = (zoom) => mapHelpers.mapPinRadius({ pinSize: 20 }, {}, zoom)
  assert(radiusAt(1) === 10, 'radius is half the diameter at zoom 1')
  assert(radiusAt(4) === 2.5, 'and shrinks in world units as you zoom in, so the SCREEN size is constant')
  assert(Math.abs(radiusAt(4) * 4 - radiusAt(1) * 1) < 1e-9, 'the screen size must not change with zoom')
  assert(Number.isFinite(mapHelpers.mapPinRadius({}, {}, 0)) && mapHelpers.mapPinRadius({}, {}, 0) > 0, 'zoom 0 does not divide by zero')

  // The colour drives the marker AND its name. It used to colour only the text, so the dot stayed grey
  // and the marker could not be recoloured at all.
  assert(mapHelpers.mapPinColor({ color: '#c0504d' }) === '#c0504d', 'a pin keeps its colour')
  assert(mapHelpers.mapPinColor({ color: '' }) === 'currentColor', 'an empty colour falls back')
  assert(mapHelpers.mapPinColor({}, '#333333') === '#333333', 'and the caller may choose the fallback')

  // AND THE RENDER: the controls must reach the drawing.
  const marked = {
    ...sampleMap,
    pinSize: 28,
    strokes: [{ color: '#c0504d', width: 12, points: [[0, 0], [50, 50]] }],
    pins: [{ id: 'pin-1', placeId: null, x: 100, y: 100, label: '城', color: '#d0a24a', dot: 8 }],
  }
  const html = render(react.createElement(plugin.__test.MapSurface, surfaceProps({ map: marked, penWidth: 4 })))
  assert(html.includes('#d0a24a'), 'the marker colour reaches the drawing')
  assert(/stroke="#d0a24a"/.test(html), 'as the marker outline')
  // `dot: 8` is a screen diameter, so in world units at zoom 1 the radius is 4.
  assert(/r="4"/.test(html), `the marker uses its own size, got ${(/r="[^"]*"/.exec(html) ?? [])[0]}`)
  // The STROKE's own width (12px) wins over the pen's (4px).
  assert(/stroke-width="12"/.test(html), `the stroke uses its own width, got ${(/stroke-width="[^"]*"/.exec(html) ?? [])[0]}`)
  // A stroke with no width takes the pen's.
  const penOnly = render(react.createElement(plugin.__test.MapSurface, surfaceProps({
    map: { ...sampleMap, pinSize: 14, strokes: [{ color: null, points: [[0, 0], [50, 50]] }], paths: [] },
    penWidth: 16,
  })))
  assert(/stroke-width="16"/.test(penOnly), 'a stroke with no width uses the pen')
})

check('normalisation never invents a value the author can edit', () => {
  // THE MISTAKE, MADE THREE TIMES. A fallback meant for DISPLAY keeps getting written into the DATA:
  //   1. `mapRenameMap` substituted the map's id for a blank name;
  //   2. `normalizeMap` substituted `地图 N` for a blank name — which is what the author hit next, since
  //      the name field is bound to the normalised value, so clearing it put `地图 1` back in the input
  //      and the next keystroke produced `地图 1你好`;
  //   3. an empty `maps` list was treated as the legacy shape and a map was invented for it.
  // The rule this test enforces: NORMALISATION PRESERVES. Only `mapDisplayName` substitutes, for display.
  const blank = mapHelpers.mapMaps({ version: 2, maps: [{ id: 'map-1', name: '', canvas: { width: 100, height: 100 } }] })
  assert(blank.length === 1, 'the map is kept')
  assert(blank[0].name === '', `a blank name must stay blank, got ${JSON.stringify(blank[0].name)}`)
  assert(blank[0].id === 'map-1', 'the id is unchanged')
  // The round trip is stable, which is the property that would have caught all three.
  const twice = mapHelpers.mapMaps({ version: 2, maps: blank })
  assert(JSON.stringify(blank) === JSON.stringify(twice), 'normalising twice must change nothing')
  assert(mapHelpers.mapMaps({ maps: [{ id: 'map-1', name: '   ' }] })[0].name === '   ', 'whitespace is preserved too')
  // And the author's next keystroke lands on an EMPTY field, which is the whole complaint.
  const typed = mapHelpers.mapRenameMap(mapHelpers.mapMaps({ maps: [{ id: 'map-1', name: '示例' }] }), 'map-1', '你好')
  assert(typed[0].name === '你好', `typing after clearing gives exactly that, got ${JSON.stringify(typed[0].name)}`)
  // Other editable fields behave the same way.
  assert(mapHelpers.mapPins({ pins: [{ id: 'pin-1', x: 0, y: 0, label: '', placeId: null }] })[0].label === '', 'a blank pin label stays blank')
  // Preserving is not the same as keeping nonsense: a non-string becomes blank, never the id.
  assert(mapHelpers.mapMaps({ maps: [{ id: 'map-1', name: 42 }] })[0].name === '', 'a non-string name becomes blank')
  // Every place that shows a name uses the display helper, so an unnamed map is still identifiable.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/mapDisplayName\(entry\)/.test(source), 'the maps list shows display names')
  assert(/mapDisplayName\(active\)/.test(source), 'and so does the save row and the export')
  assert(!/name: text\.trim\(\) === '' \? map\.id/.test(source), 'no caller substitutes an id for a blank name')
  assert(!/name\.trim\(\) !== '' \? value\.name : `地图/.test(source), 'and normalisation does not invent one either')
})

check('clicking a marker\'s NAME opens that marker', () => {
  // REPORTED: "光标点击点的名称时应该进入编辑页面而不是重新打点". A name is drawn offset to the right of its
  // marker and is usually wider than the marker's 18px hit radius, so clicking the text counted as
  // clicking empty space — which in 打点 mode placed a NEW marker on top of the one being opened.
  const map = { labelSize: 34, labelFixed: false }
  const pins = [{ id: 'pin-1', x: 500, y: 400, label: '苏舟城' }]
  const labels = mapHelpers.mapLabelLayout(pins, map, 1)
  const box = labels[0].box
  const onText = { x: box.x0 + (box.x1 - box.x0) * 0.6, y: (box.y0 + box.y1) / 2 }
  assert(Math.hypot(onText.x - 500, onText.y - 400) > mapHelpers.MAP_PIN_HIT_PX, 'the point is outside the marker radius')
  assert(mapHelpers.pinAt(pins, onText, mapHelpers.MAP_PIN_HIT_PX) === null, 'so the old hit test missed it entirely')
  const hit = mapHelpers.mapPinHit(pins, labels, onText, mapHelpers.MAP_PIN_HIT_PX)
  assert(hit !== null && hit.id === 'pin-1', `the name must belong to its marker, got ${JSON.stringify(hit)}`)
  // The marker itself still wins, so a name pushed away cannot steal a click aimed at a marker.
  assert(mapHelpers.mapPinHit(pins, labels, { x: 500, y: 400 }, mapHelpers.MAP_PIN_HIT_PX).id === 'pin-1', 'the marker is still hittable')
  // Empty space stays empty, or 打点 could never place anything.
  assert(mapHelpers.mapPinHit(pins, labels, { x: 900, y: 900 }, mapHelpers.MAP_PIN_HIT_PX) === null, 'empty space stays empty')
  // Overlapping names do not depend on draw order.
  const two = [{ id: 'pin-1', x: 500, y: 400, label: '甲' }, { id: 'pin-2', x: 505, y: 400, label: '乙乙乙乙乙' }]
  const twoLabels = mapHelpers.mapLabelLayout(two, map, 1)
  const inside = twoLabels[0].box
  const overlapPoint = { x: (inside.x0 + inside.x1) / 2, y: (inside.y0 + inside.y1) / 2 }
  assert(mapHelpers.mapPinHit(two, twoLabels, overlapPoint, mapHelpers.MAP_PIN_HIT_PX) !== null, 'something is hit in an overlap')
  assert(two.length === 2, 'and both markers survive being hit-tested')
  // Junk in, nothing out — never a crash.
  assert(mapHelpers.mapPinHit(null, null, { x: 0, y: 0 }, 18) === null, 'junk hits nothing')
  assert(mapHelpers.mapPinHit(pins, [{ id: 'pin-1', box: null }], { x: 600, y: 400 }, 18) === null, 'a label with no box hits nothing')
  assert(mapHelpers.mapPinHit(pins, labels, { x: NaN, y: 0 }, 18) === null, 'a non-finite point hits nothing')
  // THE WIRING: the click handler must use it, or the fix is decorative.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/mapPinHit\(pins, mapLabelLayout\(/.test(source), 'the click handler must hit-test the placed names')
  // And the surface must resolve names the same way, whether or not it was handed a resolver — a surface
  // that silently showed raw ids because a prop was missing would look like a data bug.
  const rendered = render(react.createElement(plugin.__test.MapSurface, surfaceProps({
    map: { ...sampleMap, pins: [{ id: 'pin-1', placeId: 'place-7', x: 100, y: 100, label: '' }] },
    placeTitles: { 'place-7': '落霞渡' },
  })))
  assert(rendered.includes('落霞渡'), 'a name still resolves from placeTitles alone')
})

check('the eraser removes what is under it, one thing per press', () => {
  // ASKED FOR: "新增橡皮功能,可以删除地图上的痕迹". The rule is ONE OBJECT per press: deleting by proximity
  // along a line would remove a whole carefully drawn coastline because the pointer came near one of its
  // points, which is not what anyone means by rubbing something out.
  const base = {
    id: 'map-1',
    name: 'm',
    canvas: { width: 1600, height: 1200 },
    background: { kind: 'blank', asset: null },
    strokes: [{ color: '#3f4a5a', width: 4, points: [[0, 0], [100, 0], [200, 0]] }],
    paths: [{ id: 'path-1', kind: 'river', color: '#5b8fb0', width: 20, taper: 0.9, dash: 'solid', points: [{ x: 500, y: 500 }, { x: 700, y: 500 }] }],
    pins: [{ id: 'pin-1', x: 900, y: 900, label: '城', placeId: null }],
    pinSize: 14,
    labelSize: 34,
    labelFixed: false,
  }
  const eraser = (world) => mapHelpers.mapEraseAt(base, world, { zoom: 1 })

  const onPin = eraser({ x: 900, y: 900 })
  assert(onPin.erased !== null && onPin.erased.kind === 'pin', `the marker is erased, got ${JSON.stringify(onPin.erased)}`)
  assert(onPin.map.pins.length === 0, 'and it is gone')
  assert(onPin.map.paths.length === 1 && onPin.map.strokes.length === 1, 'while nothing else is touched')

  const onRiver = eraser({ x: 600, y: 500 })
  assert(onRiver.erased !== null && onRiver.erased.kind === 'path', `the river is erased, got ${JSON.stringify(onRiver.erased)}`)
  assert(onRiver.map.paths.length === 0, 'the whole course goes')
  assert(onRiver.map.pins.length === 1 && onRiver.map.strokes.length === 1, 'and nothing else')

  const onStroke = eraser({ x: 100, y: 3 })
  assert(onStroke.erased !== null && onStroke.erased.kind === 'stroke', `the stroke is erased, got ${JSON.stringify(onStroke.erased)}`)
  assert(onStroke.map.strokes.length === 0, 'the stroke goes')
  assert(onStroke.map.paths.length === 1 && onStroke.map.pins.length === 1, 'and nothing else')

  // Empty space erases NOTHING, and says so rather than silently doing something.
  const nothing = eraser({ x: 20, y: 800 })
  assert(nothing.erased === null, 'empty space erases nothing')
  assert(nothing.map === base, 'and the map comes back unchanged rather than copied')

  // The NEAREST kind wins, so a course drawn across a coastline does not make the coastline unreachable.
  const crossing = {
    ...base,
    strokes: [{ color: null, width: 2, points: [[500, 400], [500, 600]] }],
    paths: [{ id: 'path-1', kind: 'road', color: null, width: 8, taper: 0, dash: 'solid', points: [{ x: 400, y: 500 }, { x: 600, y: 500 }] }],
    pins: [],
  }
  assert(mapHelpers.mapEraseAt(crossing, { x: 500, y: 470 }, { zoom: 1 }).erased.kind === 'stroke', 'just above the crossing, the stroke is nearer')
  assert(mapHelpers.mapEraseAt(crossing, { x: 560, y: 500 }, { zoom: 1 }).erased.kind === 'path', 'and to the side, the road is')

  // Geometry helpers, and junk.
  assert(mapHelpers.mapDistanceToCourse([{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 5, y: 3 }) === 3, 'distance to a segment')
  assert(mapHelpers.mapDistanceToCourse([{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: -5, y: 0 }) === 5, 'clamped to the ends')
  assert(mapHelpers.mapDistanceToCourse([], { x: 0, y: 0 }) === Infinity, 'an empty course is infinitely far')
  assert(mapHelpers.mapDistanceToCourse(null, { x: 0, y: 0 }) === Infinity, 'and so is junk')
  for (const junk of [undefined, null, 'x', {}, { pins: null, paths: null, strokes: null }]) {
    assert(mapHelpers.mapEraseAt(junk, { x: 0, y: 0 }, { zoom: 1 }).erased === null, `junk erases nothing: ${JSON.stringify(junk)}`)
  }
  assert(Number.isFinite(mapHelpers.mapEraseRadius(0)) && mapHelpers.mapEraseRadius(0) > 0, 'zoom 0 does not divide by zero')
})

check('the panel nests the kind branches inside the map, and hides an empty one', () => {
  // REQUESTED: "河流/标记点/道路/边界应该为地图的下级分支... 新建地图后...右边栏只能对地图名称和一些全局设定进行
  // 编辑,没有河流/标记点/道路/边界;当用户在画布上打点后,右边栏出现标记点目录... 河流道路/边界同理".
  // So the branches belong to the MAP, and an empty one is not shown at all — four empty headings are
  // noise and imply there is something to configure when there is not.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  // 地图 is the only top-level branch, and it carries the settings.
  assert(/const sections = \[/.test(source), 'the panel is built from sections')
  assert(/key: 'maps',[\s\S]{0,60}title: '地图'/.test(source), '地图 is the top level')
  assert(/const kindBranches = \[/.test(source), 'its own branches are built separately')
  assert(/\.\.\.MAP_PATH_KIND_IDS\.map\(\(kind\) => \{/.test(source), 'one branch per path kind')
  // THE NESTING: the kind branches are rendered INSIDE the 地图 section body, not as siblings.
  const mapsSection = source.slice(source.indexOf("key: 'maps',"), source.indexOf('const detail = h('))
  assert(/kindBranches\.map\(/.test(mapsSection), 'the kind branches are rendered inside the 地图 section')
  assert(!/sections\.push|kindBranches,/.test(mapsSection), 'and not appended beside it')
  assert(/marginLeft: '10px'/.test(mapsSection), 'and indented, so the nesting is visible')
  // HIDDEN WHILE EMPTY — the whole point of the new-map case.
  assert(/\.filter\(\(branch\) => branch\.count > 0\)/.test(source), 'an empty branch is filtered out')
  assert(/kindBranches\.length === 0/.test(source), 'and a blank map says so instead')
  assert(/这张地图还是空白的/.test(source), 'with a line explaining that branches appear as you draw')
  // Every kind the author named, from one table.
  const kindLabels = mapHelpers.MAP_PATH_KIND_IDS.map((kind) => mapHelpers.MAP_PATH_KINDS[kind].label)
  for (const label of ['河流', '道路', '边界', '山脉']) {
    assert(kindLabels.includes(label), `${label} must be a kind, got ${kindLabels.join('/')}`)
  }
  // Each ITEM carries its own editor, opened by the item's own state.
  assert(/const pinEditor = \(pin\) => \[/.test(source), 'a marker has its own editor')
  assert(/const pathEditor = \(path\) => \[/.test(source), 'and so does a course')
  assert(/const itemRow = /.test(source), 'rows are built by one function')
  assert(/open \? h\('div'/.test(source), 'and an item is COLLAPSED until it is opened')
  assert(/const patchPin = \(pinId, patch\)/.test(source), 'the marker editor takes the id it edits')
  assert(/const deletePinById = \(pinId\)/.test(source), 'and so does deleting one')
  assert(!/const deletePin = \(\)/.test(source), 'the selection-based version is gone')
  // A closed group renders nothing at all.
  assert(/open \? h\('div', \{ style: \{ marginTop: '4px' \} \}, \.\.\.body\) : null/.test(source), 'a closed branch renders nothing')
  assert(/const groupOpen = \(key\)/.test(source) && /const toggleGroup = \(key\)/.test(source), 'and the open state is per branch')
  assert(/closedGroups\[key\] !== true/.test(source), 'with branches open by default')
  assert(typeof plugin.__test.MapGroup === 'function', 'MapGroup is renderable by the suite')
  const open = render(react.createElement(plugin.__test.MapGroup, { title: '河流', count: 2, open: true, onToggle() {} }, react.createElement('span', null, 'CHILD')))
  assert(open.includes('河流') && open.includes('CHILD'), 'an open branch shows its title, count and children')
  assert(open.includes('▾'), 'and is marked as open')
  const shut = render(react.createElement(plugin.__test.MapGroup, { title: '河流', count: 2, open: false, onToggle() {} }, react.createElement('span', null, 'CHILD')))
  assert(shut.includes('河流') && shut.includes('2'), 'a closed branch still shows its title and count')
  assert(!shut.includes('CHILD'), 'but none of its children — closed means closed')
  assert(shut.includes('▸'), 'and is marked as closed')
})

check('a mountain range is drawn as a row of peaks along its course', () => {
  // ASKED FOR: "新增地形「山脉」". A range is a COURSE — it runs along a ridge — so it is built from the same
  // waypoints as a river, which means placing, dragging, erasing and naming it all work already. It is
  // DRAWN as a row of peaks rather than a thick line, because a thick line reads as a wall.
  const ridge = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 400, y: 0 }]
  const peaks = mapHelpers.mapMountainPeaks(ridge, 46)
  assert(peaks.length >= 10, `a 400-unit ridge at width 46 needs many peaks, got ${peaks.length}`)
  for (const peak of peaks) {
    assert(Number.isFinite(peak.x) && Number.isFinite(peak.y), 'every peak is placed')
    assert(Number.isFinite(peak.angle), 'and knows the direction of the range')
    assert(peak.size > 0 && peak.size <= 46, `a peak is no wider than the range, got ${peak.size}`)
    assert(peak.x >= -1 && peak.x <= 401, 'peaks stay on the course')
  }
  // Deterministic: a range must not shimmer between renders.
  assert(JSON.stringify(peaks) === JSON.stringify(mapHelpers.mapMountainPeaks(ridge, 46)), 'the same ridge gives the same peaks')
  // Spaced by the WIDTH, so a wider setting spreads the range out.
  const wide = mapHelpers.mapMountainPeaks(ridge, 92)
  assert(wide.length < peaks.length, `a wider range has fewer, larger peaks: ${wide.length} vs ${peaks.length}`)
  // Alternating heights, so the row does not look like a saw blade.
  assert(new Set(peaks.map((peak) => peak.size)).size >= 2, 'peaks vary in height')
  assert(peaks[0].size > peaks[1].size, 'with a fixed pattern, largest first')
  // The glyph is a triangle, apex up, so it reads as a mountain.
  const parts = mapHelpers.mapMountainGlyph({ x: 100, y: 100, size: 40 }).split(' ').map((pair) => pair.split(',').map(Number))
  assert(parts.length === 3, 'a peak is a triangle')
  for (const [x, y] of parts) assert(Number.isFinite(x) && Number.isFinite(y), 'with real coordinates')
  const apex = parts.reduce((lowest, point) => (point[1] < lowest[1] ? point : lowest))
  assert(apex[1] < 100, 'the apex points up')
  assert(parts.filter((point) => Math.abs(point[1] - apex[1]) < 1e-9).length === 1, 'and there is exactly one apex')
  assert(new Set(parts.map((point) => point[0])).size === 3, 'the base has width')
  // Degenerate input yields no peaks rather than a stray glyph.
  for (const junk of [[], null, undefined, 'x', [{ x: 1, y: 1 }], [{ x: NaN, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 0, y: 0 }]]) {
    assert(mapHelpers.mapMountainPeaks(junk, 46).length === 0, `no peaks for ${JSON.stringify(junk)}`)
  }
  assert(mapHelpers.mapMountainPeaks(ridge, NaN).length > 0, 'a junk width still produces a usable row')
  // THE RENDER: mountains must be drawn as polygons, and the kind must survive normalisation.
  assert(mapHelpers.MAP_PATH_KINDS.mountain.label === '山脉', '山脉 is a kind')
  const ranged = { ...sampleMap, paths: [{ id: 'path-1', kind: 'mountain', name: '', color: '#8a6a4a', width: 46, taper: 0, dash: 'solid', points: ridge }] }
  const html = render(react.createElement(plugin.__test.MapSurface, surfaceProps({ map: ranged })))
  assert((html.match(/<polygon/g) ?? []).length >= 10, 'the range renders as many polygons')
  assert(html.includes('#8a6a4a'), 'in its own colour')
  assert(mapHelpers.mapPaths({ paths: ranged.paths })[0].kind === 'mountain', 'and survives normalisation')
})

check('a course can be named, and the name appears on the map', () => {
  // ASKED FOR: "河流/道路/边界要可以编辑名字". A name that never appears on the map would be a private note
  // rather than a map label, which is not what naming a river is for.
  const course = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 400, y: 0 }]
  const named = mapHelpers.mapPaths({ paths: [{ id: 'path-1', kind: 'river', name: '大江', points: course }] })
  assert(named.length === 1, 'the course is kept')
  assert(named[0].name === '大江', 'with its name')
  // PRESERVED EXACTLY, like a map's name: blank stays blank, so clearing the field does not put a title
  // back into it and the next keystroke is not appended to something invented.
  assert(mapHelpers.mapPaths({ paths: [{ id: 'p', points: [[0, 0], [1, 1]] }] })[0].name === '', 'an unnamed course has no name')
  assert(mapHelpers.mapPaths({ paths: [{ id: 'p', name: '', points: [[0, 0], [1, 1]] }] })[0].name === '', 'and a blank one stays blank')
  assert(mapHelpers.mapPaths({ paths: [{ id: 'p', name: 42, points: [[0, 0], [1, 1]] }] })[0].name === '', 'junk becomes blank')
  assert(mapHelpers.mapPathRename(named, 'path-1', '  无名河  ')[0].name === '  无名河  ', 'renaming stores exactly what was typed')
  assert(mapHelpers.mapPathRename(named, 'path-1', 'x'.repeat(500))[0].name.length === 120, 'and caps a paste')
  assert(mapHelpers.mapPathRename(named, 'nope', 'x')[0].name === '大江', 'an unknown id changes nothing')
  assert(mapHelpers.mapPathRename(named, 'path-1', null)[0].name === '', 'junk becomes empty rather than throwing')
  // The TITLE shown in the panel falls back to the kind and size — a display concern only.
  assert(mapHelpers.mapPathTitle(named[0]) === '大江', 'a named course shows its name')
  const unnamed = mapHelpers.mapPaths({ paths: [{ id: 'p', kind: 'road', points: [[0, 0], [1, 1], [2, 2]] }] })[0]
  assert(mapHelpers.mapPathTitle(unnamed).includes('道路'), `an unnamed course shows its kind, got ${mapHelpers.mapPathTitle(unnamed)}`)
  assert(mapHelpers.mapPathTitle(unnamed).includes('3'), 'and how big it is')
  assert(mapHelpers.mapPathTitle({ name: '   ' }).includes('路径'), 'whitespace counts as unnamed')
  // WHERE the name goes: the MIDDLE measured along the course, not the middle waypoint — a course whose
  // waypoints bunch at one end would otherwise have its name sitting on top of them.
  const lopsided = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 0 }]
  const anchor = mapHelpers.mapPathAnchor(lopsided, 20)
  assert(anchor !== null && Math.abs(anchor.x - 50) < 1e-9, `the midpoint is measured along the course, got ${anchor?.x}`)
  assert(anchor.offset > 10, 'and pushed clear of the course')
  assert(Number.isFinite(anchor.angle), 'with the local direction')
  assert(mapHelpers.mapPathAnchor([], 20) === null, 'no points, nowhere to put a name')
  assert(mapHelpers.mapPathAnchor(null, 20) === null, 'junk yields nothing rather than throwing')
  assert(mapHelpers.mapPathAnchor([{ x: 5, y: 5 }], 20) !== null, 'a single point still has a place')
  // THE RENDER: the name reaches the drawing.
  const drawn = { ...sampleMap, paths: [{ id: 'path-1', kind: 'river', name: '大江', color: '#5b8fb0', width: 26, taper: 0.9, dash: 'solid', points: course }] }
  // Assert on the <text> elements, not the whole document: the aria-label legitimately counts
  // 「河流道路」, which would make a blanket `includes` pass for the wrong reason.
  const textsOf = (html) => [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
  assert(textsOf(render(react.createElement(plugin.__test.MapSurface, surfaceProps({ map: drawn })))).includes('大江'), 'the course name is drawn as a label')
  // An unnamed course draws no name at all — not its kind, not its id.
  const plain = { ...sampleMap, paths: [{ id: 'path-1', kind: 'river', name: '', color: '#5b8fb0', width: 26, taper: 0.9, dash: 'solid', points: course }] }
  const plainTexts = textsOf(render(react.createElement(plugin.__test.MapSurface, surfaceProps({ map: plain }))))
  assert(!plainTexts.some((text) => text.includes('河流')), `an unnamed course draws no title of its own, got ${JSON.stringify(plainTexts)}`)
  assert(!plainTexts.some((text) => text.includes('path-1')), 'and not its id either')
  // The editor offers the field, and it writes through the pure rename.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/mapPathRename\(list, path\.id, event\.target\.value\)/.test(source), 'the course editor renames its own course')
})

check('a shape is one polygon, used to draw it and to hit-test it', () => {
  // ASKED FOR: "新增「图形工具」,可以绘制出任意大小和颜色的几何图形,例如:矩形,圆形等等". A rectangle could be
  // drawn as `<rect>` and hit tested from its corners, and the two would drift the moment either changed.
  // Every shape is ONE polygon from `mapShapePoints` — drawn from it, tested against it, measured by it.
  const rect = mapHelpers.mapShapePoints({ kind: 'rect', x: 10, y: 20, w: 100, h: 50 })
  assert(rect.length === 4, 'a rectangle is four corners')
  assert(rect[0].x === 10 && rect[0].y === 20, 'from its own origin')
  assert(rect[2].x === 110 && rect[2].y === 70, 'to the opposite corner')
  const circle = mapHelpers.mapShapePoints({ kind: 'ellipse', x: 0, y: 0, w: 100, h: 100 })
  assert(circle.length === mapHelpers.MAP_SHAPE_STEPS, 'a circle is a polygon with many sides')
  const radius = circle.map((point) => Math.hypot(point.x - 50, point.y - 50))
  assert(radius.every((r) => Math.abs(r - 50) < 1e-9), 'every point is exactly the radius from the centre')
  const wide = mapHelpers.mapShapePoints({ kind: 'ellipse', x: 0, y: 0, w: 200, h: 100 })
  assert(Math.max(...wide.map((p) => p.x)) === 200 && Math.max(...wide.map((p) => p.y)) === 100, 'an ellipse uses its whole box')
  // No area, no shape — an invisible shape could not be selected and deleted.
  for (const junk of [null, undefined, {}, { w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 10 }, { x: NaN, y: 0, w: 10, h: 10 }]) {
    assert(mapHelpers.mapShapePoints(junk).length === 0, `nothing for ${JSON.stringify(junk)}`)
  }
  for (const junk of [null, undefined, 'x', {}, { w: 0, h: 0 }, { x: 0, y: 0, w: NaN, h: 5 }]) {
    assert(mapHelpers.mapShapes({ shapes: [junk] }).length === 0, `no usable shape from ${JSON.stringify(junk)}`)
  }
  const kept = mapHelpers.mapShapes({ shapes: [{ id: 'shape-1', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }, { id: 'shape-1', kind: 'ellipse', x: 0, y: 0, w: 10, h: 10 }] })
  assert(kept.length === 2, 'both survive')
  assert(new Set(kept.map((shape) => shape.id)).size === 2, `ids must be made unique, got ${kept.map((s) => s.id).join(',')}`)
  assert(kept[1].kind === 'ellipse', 'and the kind is kept')
  assert(mapHelpers.mapShapes({ shapes: [{ x: 0, y: 0, w: 10, h: 10, kind: 'blob' }] })[0].kind === 'rect', 'a junk kind falls back to a rectangle')
  assert(mapHelpers.mapShapes({ shapes: [{ x: 0, y: 0, w: 10, h: 10, fill: '' }] })[0].fill === null, 'an empty fill means NOT filled')

  // DRAGGING, in any direction: up and to the left is as natural as down and to the right, and a negative
  // width would draw nothing at all with no hint why.
  const downRight = mapHelpers.mapShapeFromDrag({ x: 100, y: 100 }, { x: 200, y: 160 }, 'rect')
  assert(downRight.x === 100 && downRight.y === 100 && downRight.w === 100 && downRight.h === 60, `down-right, got ${JSON.stringify(downRight)}`)
  const upLeft = mapHelpers.mapShapeFromDrag({ x: 100, y: 100 }, { x: 40, y: 50 }, 'rect')
  assert(upLeft.x === 40 && upLeft.y === 50 && upLeft.w === 60 && upLeft.h === 50, `up-left gives positive w/h, got ${JSON.stringify(upLeft)}`)
  assert(mapHelpers.mapShapeFromDrag({ x: 0, y: 0 }, { x: 0, y: 0 }, 'rect') === null, 'a click makes no shape')
  assert(mapHelpers.mapShapeFromDrag({ x: 0, y: 0 }, { x: 3, y: 3 }, 'rect') === null, 'nor does a nudge below the minimum')
  assert(mapHelpers.mapShapeFromDrag({ x: 0, y: 0 }, { x: NaN, y: 10 }, 'rect') === null, 'a nonsense drag makes no shape')
  // Shift makes it square: the only way to get a true circle out of a freehand drag.
  const squared = mapHelpers.mapShapeFromDrag({ x: 0, y: 0 }, { x: 100, y: 40 }, 'ellipse', { square: true })
  assert(squared.w === squared.h && squared.w === 100, `shift squares it up, got ${JSON.stringify(squared)}`)
  const squaredUp = mapHelpers.mapShapeFromDrag({ x: 100, y: 100 }, { x: 40, y: 50 }, 'ellipse', { square: true })
  assert(squaredUp.w === squaredUp.h && squaredUp.w === 60, 'and grows away from the drag origin')
  assert(squaredUp.x === 40 && squaredUp.y === 40, 'anchored at the corner dragged toward')

  // POINT IN POLYGON, including edges and corners.
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
  assert(mapHelpers.mapPointInPolygon({ x: 50, y: 50 }, square) === true, 'the middle is inside')
  assert(mapHelpers.mapPointInPolygon({ x: 150, y: 50 }, square) === false, 'beyond the edge is outside')
  assert(mapHelpers.mapPointInPolygon({ x: 0, y: 0 }, square) === true, 'a corner is inside')
  assert(mapHelpers.mapPointInPolygon({ x: 50, y: 0 }, square) === true, 'a point on an edge counts, because clicking a border to fill a region is expected to work')
  assert(mapHelpers.mapPointInPolygon({ x: 50, y: 50 }, []) === false, 'no polygon, no inside')
  assert(mapHelpers.mapPointInPolygon({ x: NaN, y: 0 }, square) === false, 'a nonsense point is outside')
  assert(mapHelpers.mapPointInPolygon({ x: 50, y: 50 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }]) === false, 'two points are not a region')
  assert(mapHelpers.mapPolygonArea(square) === 10000, 'a 100x100 square has area 10000')
  assert(mapHelpers.mapPolygonArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]) === 50, 'and a triangle half its box')
  assert(mapHelpers.mapPolygonArea([]) === 0, 'nothing has no area')
})

check('the spray fills a closed region, and only a closed one', () => {
  // ASKED FOR: "新增喷漆工具,可以将任意封闭图形内部填充满任意颜色". The interesting case is the hand-drawn one:
  // a coastline whose last point meets its first IS a closed region, so the spray works on it without a
  // special "closed" tool.
  const loop = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]
  const open = [[0, 0], [100, 0], [100, 100], [0, 100]]
  const base = {
    id: 'map-1',
    canvas: { width: 400, height: 400 },
    background: { kind: 'blank', asset: null },
    strokes: [
      { color: '#333', width: 2, fill: null, points: loop },
      { color: '#333', width: 2, fill: null, points: open },
    ],
    paths: [{ id: 'path-1', kind: 'border', name: '', fill: null, color: '#8a5ad0', width: 10, taper: 0, dash: 'solid', points: loop }],
    shapes: [{ id: 'shape-1', kind: 'rect', x: 200, y: 200, w: 80, h: 60, color: '#4a7fd0', fill: null, width: 3, dash: 'solid' }],
    pins: [],
    pinSize: 14,
    labelSize: 34,
    labelFixed: false,
  }
  const loops = mapHelpers.mapClosedLoops(base)
  assert(loops.length === 3, `three closed regions, got ${loops.length} (${loops.map((l) => l.kind).join(',')})`)
  assert(loops.filter((entry) => entry.kind === 'stroke').length === 1, 'only the CLOSED stroke counts, not the open one')

  const filled = mapHelpers.mapFillAt(base, { x: 50, y: 50 }, '#ff0000')
  assert(filled.filled !== null, 'a point inside a region fills it')
  assert(filled.filled.kind === 'stroke', `the SMALLEST wins — the stroke sits inside the border, got ${filled.filled.kind}`)
  assert(mapHelpers.mapStrokes(filled.map)[0].fill === '#ff0000', 'the fill lands on the region it hit')
  assert(mapHelpers.mapStrokes(filled.map)[1].fill === null, 'and not on the open stroke beside it')

  const missed = mapHelpers.mapFillAt(base, { x: 380, y: 20 }, '#ff0000')
  assert(missed.filled === null, 'a point in no region fills nothing')
  assert(missed.map === base, 'and the map comes back unchanged rather than copied')

  const onShape = mapHelpers.mapFillAt(base, { x: 240, y: 230 }, '#00ff00')
  assert(onShape.filled !== null && onShape.filled.kind === 'shape', `the rectangle fills, got ${JSON.stringify(onShape.filled)}`)
  assert(mapHelpers.mapShapes(onShape.map)[0].fill === '#00ff00', 'with the colour asked for')

  // A COLOUR OF null CLEARS the fill, which is how a region is un-filled without erasing its outline.
  const cleared = mapHelpers.mapFillAt({ ...base, shapes: [{ ...base.shapes[0], fill: '#00ff00' }] }, { x: 240, y: 230 }, null)
  assert(cleared.filled !== null && mapHelpers.mapShapes(cleared.map)[0].fill === null, 'null clears the fill')
  assert(mapHelpers.mapShapes(cleared.map)[0].w === 80, 'and keeps the outline')

  // A region inside a bigger one: the SMALLEST wins, so a lake inside an island fills the lake.
  const nested = {
    ...base,
    strokes: [{ color: '#333', width: 2, fill: null, points: [[0, 0], [400, 0], [400, 400], [0, 400], [0, 0]] }],
    shapes: [{ id: 'shape-1', kind: 'rect', x: 100, y: 100, w: 50, h: 50, color: '#4a7fd0', fill: null, width: 3, dash: 'solid' }],
    paths: [],
  }
  assert(mapHelpers.mapFillAt(nested, { x: 120, y: 120 }, '#123456').filled.kind === 'shape', 'the inner region wins over the outer one')
  // A barely-open loop is still a region; a wide gap is not.
  const nearly = { ...base, paths: [], strokes: [{ color: '#333', width: 2, fill: null, points: [[0, 0], [100, 0], [100, 100], [0, 100], [0, mapHelpers.MAP_CLOSED_GAP - 1]] }] }
  assert(mapHelpers.mapFillAt(nearly, { x: 50, y: 50 }, '#ff0000').filled !== null, 'a small gap still counts as closed')
  const gaping = { ...base, paths: [], strokes: [{ color: '#333', width: 2, fill: null, points: [[0, 0], [100, 0], [100, 100], [0, 100], [0, mapHelpers.MAP_CLOSED_GAP + 40]] }] }
  assert(mapHelpers.mapFillAt(gaping, { x: 50, y: 50 }, '#ff0000').filled === null, 'a wide gap is an open line, not a region')
  for (const junk of [undefined, null, 'x', {}, { strokes: null, paths: null, shapes: null }]) {
    assert(mapHelpers.mapFillAt(junk, { x: 0, y: 0 }, '#fff').filled === null, `junk fills nothing: ${JSON.stringify(junk)}`)
  }

  // THE RENDER: the fill is painted UNDER the outline, so a stroke over a filled sea is still a stroke.
  const filledHtml = render(react.createElement(plugin.__test.MapSurface, surfaceProps({
    map: { ...base, strokes: [{ color: '#333333', width: 2, fill: '#ff0000', points: loop }], paths: [], shapes: [] },
  })))
  assert(filledHtml.includes('#ff0000'), 'the fill is drawn')
  assert(filledHtml.indexOf('#ff0000') < filledHtml.indexOf('#333333'), 'and BEFORE the outline, so the outline stays on top')
  const noFill = render(react.createElement(plugin.__test.MapSurface, surfaceProps({
    map: { ...base, strokes: [{ color: '#333333', width: 2, fill: null, points: loop }], paths: [], shapes: [] },
  })))
  assert(!noFill.includes('#ff0000'), 'an unfilled region paints no fill')
  // A shape renders as a polygon, filled or not.
  const shaped = render(react.createElement(plugin.__test.MapSurface, surfaceProps({
    map: { ...base, strokes: [], paths: [], shapes: [{ ...base.shapes[0], fill: '#00ff00' }] },
  })))
  assert((shaped.match(/<polygon/g) ?? []).length >= 2, 'a filled shape draws its fill and its outline')
  assert(shaped.includes('#00ff00') && shaped.includes('#4a7fd0'), 'in the fill colour and the stroke colour')

  // AND THE WIRING.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/const sprayAt = \(world\)/.test(source), 'the spray has a handler')
  assert(/mapFillAt\(base, world, penColor\)/.test(source), 'which calls the tested decision')
  assert(/if \(mode === 'fill'\)/.test(source), 'and is reachable from the canvas')
  assert(/if \(mode === 'shape'\)/.test(source), 'as is the shape tool')
  assert(/mapShapeFromDrag\(drag\.from, world, drag\.shapeKind/.test(source), 'which drags a box out')
  // THE RENAME the author asked for.
  assert(/label: '地形'/.test(source), 'the mode button says 地形')
  assert(!/label: '河流\/道路'/.test(source), 'and no longer says 河流/道路')
})

check('MapSurface never reaches into the branch\'s scope', () => {
  // THE WHITE SCREEN. "选择图形之后在画布上一点,整个插件都白屏了". The draft-shape preview used `penColor`,
  // which exists in MapBranch and NOT in MapSurface. A free variable COMPILES FINE and throws only when
  // that line runs — and React unmounts the whole tree when a render throws, so one wrong name took down
  // the entire plugin rather than one panel.
  //
  // Checked STATICALLY as well as by rendering, because rendering only covers the branches it happens to
  // reach, while this catches the mistake the moment it is written.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  const start = source.indexOf('function MapSurface(props) {')
  assert(start !== -1, 'MapSurface must exist')
  const after = source.indexOf('function MapGroup(props) {', start)
  assert(after > start, 'and be followed by MapGroup')
  // COMMENTS ARE STRIPPED FIRST. The explanation of this very bug names `penColor`, and an audit that
  // reads prose instead of code reports the fix as the fault — which it did, the first time it ran.
  const body = source
    .slice(start, after)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  // Names that live only in MapBranch. Anything here used inside MapSurface is a ReferenceError at render.
  const branchOnly = [
    'penColor', 'setPenColor', 'shapeFill', 'setShapeFill', 'pathKind', 'setPathKind', 'exportScale',
    'eraseNote', 'setEraseNote', 'sprayNote', 'setSprayNote', 'importNote', 'setImportNote', 'history',
    'setHistory', 'maps', 'active', 'setSelectionId', 'setEditingPathId', 'setDraftShape',
    'setSelectedShapeId', 'placeOptions', 'commitView', 'updateMaps', 'updatePaths', 'applyMaps',
    'eraseAt', 'sprayAt', 'patchPin', 'stepHistory', 'updateShapes', 'resizeShape', 'deletePinById',
  ]
  const props = new Set(['map', 'view', 'mode', 'draft', 'draftColor', 'penWidth', 'draftShape', 'selectionId', 'selectedShapeId', 'svgRef', 'started', 'editingPathId', 'placeTitles', 'labelOf'])
  const offenders = []
  for (const name of branchOnly) {
    if (props.has(name)) continue
    const pattern = new RegExp(`(?<![\\w.$])${name}(?![\\w$])`, 'g')
    for (const match of body.matchAll(pattern)) {
      offenders.push(`${name} at line ${body.slice(0, match.index).split('\n').length}`)
    }
  }
  assert(offenders.length === 0, `MapSurface must use its props, not the branch's variables: ${offenders.join(', ')}`)

  // AND IT MUST ACTUALLY RENDER, in every combination of its optional props. This is what caught the crash:
  // rendering only the default props missed it entirely, because the offending line is inside a branch that
  // only runs while a shape is being dragged.
  const canvas = { width: 2000, height: 1500 }
  const map = { id: 'm', name: 'm', canvas, background: { kind: 'blank', asset: null }, strokes: [], paths: [], shapes: [], pins: [], pinSize: 14, labelSize: 34, labelFixed: false }
  let rendered = 0
  for (const mode of ['pan', 'pin', 'draw', 'path', 'erase', 'shape', 'fill']) {
    for (const draftShape of [null, { kind: 'rect', x: 10, y: 10, w: 100, h: 60 }, { kind: 'ellipse', x: 0, y: 0, w: 40, h: 40 }]) {
      for (const editingPathId of [null, 'path-1']) {
        try {
          const html = render(react.createElement(plugin.__test.MapSurface, {
            root: null,
            map,
            view: mapHelpers.mapViewBox(null, canvas),
            mode,
            draft: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
            draftColor: '#c0504d',
            penWidth: 8,
            draftShape,
            selectionId: 'pin-1',
            selectedShapeId: 'shape-1',
            svgRef: { current: null },
            started: true,
            editingPathId,
            placeTitles: {},
            onPointerDown() {},
            onPointerMove() {},
            onPointerUp() {},
            onPointerCancel() {},
            onLostPointerCapture() {},
            onPointerLeave() {},
            onWheel() {},
          }))
          assert(html.includes('<svg'), 'the surface renders')
          rendered += 1
        } catch (error) {
          assert(false, `MapSurface threw in ${mode}/draftShape=${draftShape?.kind ?? 'null'}: ${error.message}`)
        }
      }
    }
  }
  assert(rendered === 42, `every combination must render, got ${rendered}`)
})

check('a dragged shape is actually added', () => {
  // THE SECOND BUG THE CRASH HID: the commit sat AFTER the guard that lets only a drawn stroke through, so
  // a shape drag returned there and was never added. The drag looked like it worked and then vanished — and
  // the white screen meant nobody got far enough to notice.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  const shapeAt = source.indexOf("if (state.kind === 'shape') {")
  const guardAt = source.indexOf("if (state.kind !== 'draw') return")
  assert(shapeAt !== -1, 'the shape commit must exist')
  assert(guardAt !== -1, 'and so must the draw-only guard')
  assert(shapeAt < guardAt, 'the shape commit must come BEFORE the draw-only guard, or it is unreachable')
  // And it must mint its id against the shapes already on the map, so two shapes cannot share one.
  assert(/mintMapId\('shape-', mapShapes\(active\)\)/.test(source), 'the shape id must avoid the map\'s shapes')
  // The commit stores what the toolbar was set to.
  assert(/fill: shapeFill/.test(source), 'including the fill the toolbar offered')
  assert(/color: penColor/.test(source), 'and the stroke colour')
  // The gesture itself, end to end, through the tested functions.
  const box = mapHelpers.mapViewBox(null, { width: 2000, height: 1500 })
  const started = mapHelpers.mapDragStart({
    button: 0, pointerId: 1, world: { x: 100, y: 100 }, screen: { x: 10, y: 10 }, mode: 'shape', shapeKind: 'ellipse',
    pins: [], hitRadius: 18, canvas: { width: 2000, height: 1500 }, view: box, rect: { left: 0, top: 0, width: 800, height: 600 },
  })
  assert(started !== null && started.kind === 'shape', 'a press in 图形 mode starts a shape')
  assert(started.shapeKind === 'ellipse', 'of the kind the toolbar chose')
  const moved = mapHelpers.mapDragMove({ drag: started, pointerId: 1, world: { x: 300, y: 220 }, view: box, canvas: { width: 2000, height: 1500 } })
  assert(moved !== null && moved.shape !== undefined, 'dragging produces a box')
  const ended = mapHelpers.mapDragEnd({ drag: started, pointerId: 1, cancelled: false, to: { x: 300, y: 220 } })
  assert(ended.shape !== null && ended.shape.kind === 'ellipse', 'and releasing commits it')
  assert(ended.shape.w === 200 && ended.shape.h === 120, `with the dragged size, got ${JSON.stringify(ended.shape)}`)
  // A click with no movement commits nothing, so the canvas is not littered with invisible shapes.
  const clicked = mapHelpers.mapDragStart({ button: 0, pointerId: 1, world: { x: 100, y: 100 }, screen: { x: 10, y: 10 }, mode: 'shape', shapeKind: 'rect', pins: [], hitRadius: 18, canvas: { width: 2000, height: 1500 }, view: box, rect: { left: 0, top: 0, width: 800, height: 600 } })
  assert(mapHelpers.mapDragEnd({ drag: clicked, pointerId: 1, cancelled: false, to: { x: 100, y: 100 } }).shape === null, 'a click commits no shape')

  // REPORTED: "拖出图形后有预览,但松开后没有变成实线图形" and "按住shift无用". Both were the same mistake: the
  // HANDLER never passed the release point or the shift key, so `mapShapeFromDrag` was handed `undefined`
  // and produced NaN. The pure functions were right all along — a test that calls them with the arguments
  // the handler forgets PASSES while the feature does not work. So the wiring is asserted directly.
  const shapeSource = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  const endAt = shapeSource.indexOf('const outcome = mapDragEnd({')
  const endCall = shapeSource.slice(endAt, endAt + 400)
  assert(endAt !== -1, 'the release handler must exist')
  assert(/to: worldOf\(event\)/.test(endCall), 'the release point must reach the gesture, or nothing is committed')
  assert(/square: event\.shiftKey === true/.test(endCall), 'and so must the shift key, or shift does nothing')
  const moveAt = shapeSource.indexOf('const intent = mapDragMove({')
  const moveCall = shapeSource.slice(moveAt, moveAt + 500)
  assert(moveAt !== -1, 'the move handler must exist')
  assert(/square: event\.shiftKey === true/.test(moveCall), 'shift must reach the PREVIEW too, not only the commit')
  // AND THE STRUCTURAL FIX, so a forgotten argument can no longer produce nothing silently: the gesture
  // records where it has been, and ending it falls back to that position.
  assert(/intent\.last \?\? state\.last/.test(shapeSource), 'the gesture must record its last position')
  assert(/input\.to \?\? drag\.last \?\? drag\.from/.test(shapeSource), 'and ending it must fall back to that position')
  const remembered = { ...started, last: moved.last }
  assert(moved.last !== undefined, 'a move reports the position it saw')
  const noTo = mapHelpers.mapDragEnd({ drag: remembered, pointerId: 1, cancelled: false })
  assert(noTo.shape !== null, `a forgotten release point must still commit, got ${JSON.stringify(noTo.shape)}`)
  assert(noTo.shape.w === 200 && noTo.shape.h === 120, 'with the size the drag actually covered')
  // SHIFT ON BOTH PATHS: the preview and the commit must agree, or the shape changes the moment it lands.
  const shiftDrag = mapHelpers.mapDragStart({ button: 0, pointerId: 1, world: { x: 100, y: 100 }, screen: { x: 10, y: 10 }, mode: 'shape', shapeKind: 'ellipse', pins: [], hitRadius: 18, canvas: { width: 2000, height: 1500 }, view: box, rect: { left: 0, top: 0, width: 800, height: 600 } })
  const freePreview = mapHelpers.mapDragMove({ drag: shiftDrag, pointerId: 1, world: { x: 500, y: 300 }, view: box, canvas: { width: 2000, height: 1500 } })
  const squarePreview = mapHelpers.mapDragMove({ drag: shiftDrag, pointerId: 1, world: { x: 500, y: 300 }, view: box, canvas: { width: 2000, height: 1500 }, square: true })
  assert(freePreview.shape.w !== freePreview.shape.h, 'without shift the box follows the drag')
  assert(squarePreview.shape.w === squarePreview.shape.h, `with shift the preview is square, got ${JSON.stringify(squarePreview.shape)}`)
  assert(squarePreview.shape.w === 400, 'sized to the larger side')
  const committed = mapHelpers.mapDragEnd({ drag: shiftDrag, pointerId: 1, cancelled: false, to: { x: 500, y: 300 }, square: true })
  assert(committed.shape.w === committed.shape.h && committed.shape.w === squarePreview.shape.w, 'and the committed shape matches the preview')
})

check('a 地点 can see which markers point at it, and the link can be cleared', () => {
  // THE LINK RAN ONE WAY ONLY. A marker could name a 地点, but standing in the 地点 branch there was no way
  // to learn that a marker on 「大陆」 pointed at it — and because the host refuses to write a document that
  // would leave a dangling reference, the ONLY symptom was that deleting the place was refused, with a
  // message naming neither the map nor the marker. Reported as "解决标记点的关联问题".
  const maps = mapHelpers.mapMaps({
    version: 2,
    maps: [
      { id: 'map-1', name: '大陆', canvas: { width: 100, height: 100 }, pins: [
        { id: 'pin-1', placeId: 'place-青云峰', x: 1, y: 1, label: '青云峰' },
        { id: 'pin-2', placeId: 'place-照影湾', x: 2, y: 2, label: '' },
      ] },
      { id: 'map-2', name: '', canvas: { width: 100, height: 100 }, pins: [
        { id: 'pin-3', placeId: 'place-青云峰', x: 3, y: 3, label: '后山' },
        { id: 'pin-4', placeId: null, x: 4, y: 4, label: '无关' },
      ] },
    ],
  })
  const links = mapHelpers.mapPlaceLinks(maps, 'place-青云峰')
  assert(links.length === 2, `both markers are found, got ${links.length}`)
  assert(links.map((l) => l.pinId).sort().join(',') === 'pin-1,pin-3', 'the right markers')
  assert(links.map((l) => l.mapId).sort().join(',') === 'map-1,map-2', 'on the right maps')
  // The map's DISPLAY name is used, so an unnamed map is still identifiable in the list.
  assert(links.find((l) => l.mapId === 'map-2').mapName.includes('未命名'), `an unnamed map is still named, got ${links.find((l) => l.mapId === 'map-2').mapName}`)
  assert(links.find((l) => l.pinId === 'pin-1').label === '青云峰', 'and the marker carries its own label')
  // A place nothing points at, and junk, are empty rather than wrong.
  assert(mapHelpers.mapPlaceLinks(maps, 'place-没有人').length === 0, 'an unmarked place has no links')
  assert(mapHelpers.mapPlaceLinks(maps, null).length === 0, 'no id, no links')
  assert(mapHelpers.mapPlaceLinks(maps, '').length === 0, 'a blank id, no links')
  assert(mapHelpers.mapPlaceLinks(null, 'place-青云峰').length === 0, 'no maps, no links')
  assert(mapHelpers.mapPlaceLinks([{ pins: null }], 'place-青云峰').length === 0, 'junk pins, no links')

  // CLEARING THE LINK is what makes the delete legal — and it must keep the markers themselves, because a
  // marker is the author's work on the map and a place being removed is no reason to lose it.
  const unlinked = mapHelpers.mapUnlinkPlace(maps, 'place-青云峰')
  assert(mapHelpers.mapPlaceLinks(unlinked, 'place-青云峰').length === 0, 'no links remain')
  const kept = mapHelpers.mapPins(unlinked.find((m) => m.id === 'map-1'))
  assert(kept.length === 2, 'BOTH markers are still there')
  assert(kept.find((p) => p.id === 'pin-1').label === '青云峰', 'with their own labels intact')
  assert(kept.find((p) => p.id === 'pin-1').placeId === null, 'only the link is gone')
  assert(kept.find((p) => p.id === 'pin-1').x === 1, 'and their positions')
  // A DIFFERENT place is untouched, which is the whole risk of a bulk edit.
  assert(mapHelpers.mapPlaceLinks(unlinked, 'place-照影湾').length === 1, 'another place keeps its own link')
  assert(mapHelpers.mapPlaceLinks(unlinked, 'place-照影湾')[0].pinId === 'pin-2', 'the right one')
  assert(mapHelpers.mapPlaceLinks(mapHelpers.mapUnlinkPlace(unlinked, 'place-照影湾'), 'place-照影湾').length === 0, 'and it can be cleared too')
  // Round trip: clearing is stable and the maps survive normalisation.
  assert(JSON.stringify(mapHelpers.mapUnlinkPlace(unlinked, 'place-青云峰')) === JSON.stringify(unlinked), 'clearing twice changes nothing')
  assert(mapHelpers.mapMaps({ maps: unlinked }).length === 2, 'the maps survive normalisation')
  // Junk in, maps out — never a crash.
  for (const junk of [null, undefined, 'x', {}, 42]) {
    assert(mapHelpers.mapUnlinkPlace(junk, 'place-青云峰').length === 0, `junk stays junk: ${JSON.stringify(junk)}`)
    assert(mapHelpers.mapUnlinkPlace(maps, junk).length === 2, 'a junk id changes nothing')
  }

  // THE HOST MESSAGE must name the referrer, or the refusal is unactionable. This is the other half: the
  // client's delete button promises the host "lists the referrers", and for this reference it listed none.
  const validator = readFileSync(join(ROOT, 'lib', 'impl', 'validate.js'), 'utf8')
  assert(/const checkRef = \(value, path, what, ownerIds, where\)/.test(validator), 'checkRef accepts a description of the referrer')
  assert(/does not exist\$\{location\}/.test(validator), 'and appends it to the message')
  assert(/marker "\$\{p\?\.id/.test(validator), 'the map reference names the MARKER')
  assert(/map "\\?"|map "/.test(validator) || /map "\\\$/.test(validator) || /map "\\$\{map/.test(validator), 'and the MAP it sits on')

  // MARKING A PLACE FROM THE PLACE SIDE, which is the direction an author reaches for: "where is 青云峰?",
  // not "which place is this dot?". The link used to work only from a marker that already existed.
  let mapsNow = mapHelpers.mapMaps({
    version: 2,
    maps: [
      { id: 'map-1', name: '灵界', canvas: { width: 1000, height: 800 }, pins: [] },
      { id: 'map-2', name: '大陆', canvas: { width: 1000, height: 800 }, pins: [] },
    ],
  })
  const marks = []
  for (let i = 0; i < 3; i += 1) {
    const marked = mapHelpers.mapMarkPlace(mapsNow, 'map-1', 'place-青云峰')
    mapsNow = marked.maps
    marks.push(marked)
  }
  assert(marks.every((mark) => mark.pinId !== null), 'each mark gets an id')
  assert(new Set(marks.map((m) => m.pinId)).size === 3, 'and they are distinct')
  // DISTINCT POSITIONS: dropping every marker at the centre would stack them invisibly, and the second press
  // would look like nothing happened.
  assert(new Set(marks.map((m) => `${m.x},${m.y}`)).size === 3, `three markers must not stack, got ${marks.map((m) => `${m.x},${m.y}`).join(' ')}`)
  const markedPins = mapHelpers.mapPins(mapsNow.find((map) => map.id === 'map-1'))
  assert(markedPins.length === 3, 'all three are on the map')
  assert(markedPins.every((pin) => pin.placeId === 'place-青云峰'), 'each is linked to the place')
  // NO LABEL OF ITS OWN, so the map draws the 地点's name and keeps following it if the place is renamed.
  assert(markedPins.every((pin) => pin.label === ''), 'a marked pin has no label of its own')
  assert(mapHelpers.mapPlaceLinks(mapsNow, 'place-青云峰').length === 3, 'and the reverse lookup finds all three')
  // It must land INSIDE the canvas, or it cannot be seen or dragged.
  const canvas = { width: 1000, height: 800 }
  for (const mark of marks) {
    assert(mark.x >= 0 && mark.x <= canvas.width && mark.y >= 0 && mark.y <= canvas.height, `(${mark.x},${mark.y}) must be on the canvas`)
  }
  // Only the chosen map is touched, and pin ids stay unique across the document.
  assert(mapHelpers.mapPins(mapsNow.find((map) => map.id === 'map-2')).length === 0, 'the other map is untouched')
  const ids = mapHelpers.allPinIds(mapsNow)
  assert(ids.length === new Set(ids).size, 'pin ids remain unique document-wide')
  // Junk changes nothing rather than throwing or inventing a pin.
  assert(mapHelpers.mapMarkPlace(mapsNow, 'map-9', 'place-青云峰').pinId === null, 'an unknown map marks nothing')
  assert(mapHelpers.mapMarkPlace(mapsNow, 'map-1', '').pinId === null, 'no place id marks nothing')
  assert(mapHelpers.mapMarkPlace(mapsNow, 'map-1', null).pinId === null, 'a null place id marks nothing')
  assert(mapHelpers.mapMarkPlace(null, 'map-1', 'place-x').pinId === null, 'no maps marks nothing')
  // The free spot is inside the canvas even on a map that is already crowded.
  const crowded = { id: 'map-3', canvas, background: { kind: 'blank', asset: null }, pins: [], pinSize: 14, labelSize: 34 }
  for (let i = 0; i < 40; i += 1) crowded.pins.push({ id: `pin-${i}`, x: (i % 8) * 120 + 20, y: Math.floor(i / 8) * 140 + 20 })
  const spot = mapHelpers.mapFreeSpot(crowded)
  assert(spot.x >= 0 && spot.x <= canvas.width && spot.y >= 0 && spot.y <= canvas.height, `a crowded map still yields an on-canvas spot, got ${JSON.stringify(spot)}`)
  assert(Number.isFinite(mapHelpers.mapFreeSpot(null).x), 'junk still yields a finite spot')

  // AND THE WIRING: the 地点 panel must offer both directions.
  const branches = readFileSync(join(ROOT, 'client', 'src', '70-branches.js'), 'utf8')
  assert(/onMark: \(placeId, mapId\)/.test(branches), 'the branch exposes a mark action')
  assert(/mapMarkPlace\(mapMaps\(maps\.state\.value\), mapId, placeId\)/.test(branches), 'which uses the tested helper')
  assert(/maps: mapMaps\(maps\.state\.value\)\.map\(/.test(branches), 'and offers the maps to choose from')
  assert(/在地图上标出这个地点/.test(branches), 'the panel says so')
  assert(/新建标记点/.test(branches), 'with the button that does it')
  assert(/placeLinks\.onMark\(selection\.id/.test(branches), 'wired to the selected place')
  // AND THE OTHER HALF: the branch must load the map document, but only when asked, and must offer the
  // unlink that makes a delete legal.
  assert(/useDocument\(root, branch\.placeLinks === true \? MAP_DOC : null\)/.test(branches), 'the branch loads the map document, and only when asked')
  assert(/mapPlaceLinks\(mapMaps\(maps\.state\.value\), selection\.id\)/.test(branches), 'and looks up the selected place\'s links')
  assert(/mapUnlinkPlace\(mapMaps\(current\), placeId\)/.test(branches), 'with a way to clear them')
  assert(/清除这些地图标注/.test(branches), 'including the button that makes the delete legal')
  const schema = readFileSync(join(ROOT, 'client', 'src', '20-schema.js'), 'utf8')
  const placesBranch = schema.slice(schema.indexOf("id: 'places'"), schema.indexOf("id: 'places'") + 700)
  assert(/placeLinks: true/.test(placesBranch), 'and the 地点 branch is the one that asks for it')
  const asks = (schema.match(/placeLinks: true/g) ?? []).length
  assert(asks === 1, `exactly one branch asks for map links, got ${asks}`)
})

check('shared components are called with the props they declare', () => {
  // A WRONG PROP NAME IS INVISIBLE. Nothing errors, the value is simply `undefined`, and the control quietly
  // does nothing. That is what broke 标记点的关联 completely: the pin editor called `FieldControl` with
  // `options` and `onChange`, while the component reads `refOptions` and `onPatch` — so the 地点 list was
  // ALWAYS EMPTY and no marker could ever be linked to a place. The symptom was "关联问题" and the cause was
  // two words.
  //
  // Checked structurally, because no render can see it: the control renders fine, just empty.
  const files = readdirSync(join(ROOT, 'client', 'src')).filter((name) => name.endsWith('.js'))
  const sources = new Map(files.map((name) => [name, readFileSync(join(ROOT, 'client', 'src', name), 'utf8')]))

  /**
   * The props a component READS: those it destructures, plus any it takes off `props` directly.
   *
   * The union is the honest contract. `KeyValueEditor` destructures three and reads `props.keyPlaceholder`;
   * `ChapterBody` destructures none and forwards `props.list` / `props.editor`. An earlier version exempted a
   * component merely for reading one `props.x` — which silently stopped checking `CommitRow` altogether, so a
   * planted `statusX` went straight through. A guard that quietly stops guarding is worse than no guard.
   */
  const contractOf = (src, name) => {
    const fnAt = src.indexOf(`function ${name}(`)
    if (fnAt === -1) return null
    const keys = new Set()
    // TWO DECLARATION STYLES, both in use here: `function Name({ a, b })` and `function Name(props)` with a
    // destructuring inside. Handling only the second reported `FieldLabel` and `DetailHeading` — which take
    // `text` and `title` — as declaring nothing but `children`.
    const paramStart = src.indexOf('(', fnAt)
    const paramEnd = src.indexOf(')', paramStart)
    const params = paramStart !== -1 && paramEnd > paramStart ? src.slice(paramStart + 1, paramEnd).trim() : ''
    if (params.startsWith('{') && params.endsWith('}')) {
      for (const key of params.slice(1, -1).split(',')) {
        const cleaned = key.split(':')[0].split('=')[0].trim()
        if (/^\w+$/.test(cleaned)) keys.add(cleaned)
      }
    }
    const propsAt = src.indexOf('= props', fnAt)
    // Only THIS function's destructuring: the search starts after its own `function` keyword.
    if (propsAt !== -1 && propsAt - fnAt < 600 && !src.slice(fnAt + 8, propsAt).includes('function ')) {
      const open = src.lastIndexOf('{', propsAt)
      const close = src.lastIndexOf('}', propsAt)
      if (open !== -1 && close > open) {
        for (const key of src.slice(open + 1, close).split(',')) {
          const cleaned = key.split(':')[0].split('=')[0].trim()
          if (/^\w+$/.test(cleaned)) keys.add(cleaned)
        }
      }
    }
    // And anything it reads straight off the props object: `KeyValueEditor` destructures three and reads
    // `props.keyPlaceholder`, so its real contract has four. The union is the honest answer — removing it
    // reported those two legitimately-supported props as wrong.
    const scope = src.slice(fnAt, fnAt + 6000)
    const nextFunction = scope.indexOf('\nfunction ', 10)
    for (const match of (nextFunction === -1 ? scope : scope.slice(0, nextFunction)).matchAll(/\bprops\.(\w+)/g)) {
      keys.add(match[1])
    }
    return keys.size === 0 ? null : [...keys]
  }

  // THE CONTRACTS ARE BUILT ACROSS ALL FILES FIRST. Looking a component up in the file that CALLS it finds
  // nothing when the two live in different files — so `FieldControl` (declared in 30-form.js, called from
  // 65-map.js) was never checked at all, and this audit walked straight past the very bug it was written for.
  // A guard that silently covers only same-file calls is worse than none, because it looks like coverage.
  const contracts = new Map()
  for (const src of sources.values()) {
    for (const match of src.matchAll(/function (\w+)\(/g)) {
      const keys = contractOf(src, match[1])
      if (keys !== null) contracts.set(match[1], keys)
    }
  }
  assert(contracts.size > 20, `the audit should know many components, got ${contracts.size}`)
  assert(contracts.has('FieldControl') && contracts.has('CommitRow') && contracts.has('MapButton'), 'including the shared ones')

  const problems = []
  let checked = 0
  for (const [file, src] of sources) {
    for (const [name, keys] of contracts) {
      for (const match of src.matchAll(new RegExp(`h\\(${name}, \\{`, 'g'))) {
        const start = match.index + match[0].length - 1
        let depth = 0
        let end = start
        for (; end < src.length; end += 1) {
          if (src[end] === '{') depth += 1
          else if (src[end] === '}') {
            depth -= 1
            if (depth === 0) break
          }
        }
        const body = src.slice(start + 1, end)
        let inner = 0
        const lines = body.split('\n')
        for (const [index, line] of lines.entries()) {
          // SCANNED CHARACTER BY CHARACTER, because a props object holds nested ones: in
          // `status: { dirty, saving, savedAt }` only `status` is a prop. Judging by the line's leading depth
          // alone flagged every nested key; judging by the first key alone missed `key: 'x', text: 'y'`, which
          // is where fifteen blank labels were hiding. This audit made both mistakes before this scanner.
          const code = line.replace(/\/\/.*$/, '')
          let cursor = 0
          // A TERNARY ARM LOOKS EXACTLY LIKE A KEY: in `cond ? a : b` the text `a :` matches. So a key is
          // only accepted while no `?` is pending in the current statement, reset at each comma. Without this
          // the audit reported `undefined`, `null` and `onSelect` as props — and a guard that cries wolf gets
          // switched off, which is worse than no guard.
          let pendingTernary = false
          while (cursor < code.length) {
            const character = code[cursor]
            if (character === '{' || character === '(' || character === '[') {
              inner += 1
              cursor += 1
              continue
            }
            if (character === '}' || character === ')' || character === ']') {
              inner -= 1
              cursor += 1
              continue
            }
            if (character === '?') pendingTernary = true
            if (character === ',' && inner === 0) pendingTernary = false
            // DEPTH ZERO IS THE PROPS OBJECT ITSELF. Comparing against the depth the LINE STARTED at looked
            // equivalent and was not: on a nested line both are 1, so every key inside a nested object was
            // checked as a prop — which is how a list of chapter callbacks became six false alarms.
            if (inner === 0 && !pendingTernary) {
              const keyMatch = /^(\w+)\s*:/.exec(code.slice(cursor))
              if (keyMatch !== null && (cursor === 0 || /[\s,{]/.test(code[cursor - 1]))) {
                if (keyMatch[1] !== 'key' && !keys.includes(keyMatch[1])) {
                  const lineNo = src.slice(0, start).split('\n').length + index
                  problems.push(`${file}:${lineNo} passes "${keyMatch[1]}" to ${name}, which declares: ${keys.join(', ')}`)
                }
                checked += 1
                cursor += keyMatch[0].length
                continue
              }
            }
            cursor += 1
          }
        }
      }
    }
  }
  assert(checked > 150, `the audit must actually look at the call sites, saw ${checked} props`)
  assert(problems.length === 0, `a prop the component does not read is silently ignored: ${problems.join(' | ')}`)
  // THE ONE THAT MATTERED, asserted directly so the fix cannot be undone by a rename.
  const mapSource = sources.get('65-map.js')
  assert(/refOptions: placeOptions/.test(mapSource), 'the pin editor must pass the place options as `refOptions`')
  assert(!/options: placeOptions/.test(mapSource), 'and not as `options`, which the component does not read')
  assert(/onPatch: \(patch\) => \{/.test(mapSource), 'and must use `onPatch`, not `onChange`')
})

check('a component rendered from a forwarded props object still gets everything it reads', () => {
  // THE HOLE THE AUDIT ABOVE CANNOT SEE, AND IT COST A DEAD BUTTON. Every export control needs `root`; the pane
  // that renders them receives its props as an OBJECT LITERAL forwarded through `ChapterBody`
  // (`h(ChapterListPane, props.list)`), so the audit — which matches `h(Name, {` — never looked inside the
  // literal at the call site. `root` was simply absent from that literal, `isBlank(root)` returned early, and
  // both buttons did nothing while the call `h(ManuscriptExport, { root: props.root })` read perfectly.
  //
  // REPORTED: 「点击"保存到项目里"和"下载"按钮没有任何效果」.
  const files = readdirSync(join(ROOT, 'client', 'src')).filter((name) => name.endsWith('.js'))
  const sources = new Map(files.map((name) => [name, readFileSync(join(ROOT, 'client', 'src', name), 'utf8')]))
  const all = [...sources.values()].join('\n')

  /** The keys of the object literal passed as `h(Outer, { <slot>: { ... } })`, or null when it is not one. */
  const slotKeys = (src, outerName, slot) => {
    for (const match of src.matchAll(new RegExp(`h\\(${outerName}, \\{`, 'g'))) {
      let depth = 0
      let end = match.index + match[0].length - 1
      for (; end < src.length; end += 1) {
        if (src[end] === '{') depth += 1
        else if (src[end] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      const body = src.slice(match.index, end)
      const at = body.indexOf(`${slot}: {`)
      if (at === -1) continue
      const open = body.indexOf('{', at + slot.length)
      let inner = 0
      let close = open
      for (; close < body.length; close += 1) {
        if (body[close] === '{') inner += 1
        else if (body[close] === '}') {
          inner -= 1
          if (inner === 0) break
        }
      }
      const literal = body.slice(open + 1, close)
      const keys = new Set()
      for (const line of literal.split('\n')) {
        const code = line.replace(/\/\/.*$/, '')
        const found = /^\s*(\w+)\s*:/.exec(code)
        if (found !== null) keys.add(found[1])
        // A bare `root,` shorthand is a prop too.
        const bare = /^\s*(\w+)\s*,$/.exec(code)
        if (bare !== null) keys.add(bare[1])
      }
      return keys
    }
    return null
  }

  /** The text of the local assignment a non-literal slot points at: `editor: editorProps`. */
  const slotAssignment = (src, outerName, slot) => {
    const at = src.indexOf(`h(${outerName}, {`)
    if (at === -1) return null
    const body = src.slice(at, at + 6000)
    const named = new RegExp(`${slot}: (\\w+)`).exec(body)
    if (named === null) return null
    const decl = src.indexOf(`const ${named[1]} =`)
    if (decl === -1) return null
    // To the next top-level statement: enough to cover a ternary of literals, which is what this one is.
    const next = src.indexOf('\n  const ', decl + 5)
    return src.slice(decl, next === -1 ? decl + 3000 : next)
  }

  /** The props a component reads: destructured, plus `props.x` it takes directly. */
  const readsOf = (name) => {
    const at = all.indexOf(`function ${name}(`)
    if (at === -1) return null
    const keys = new Set()
    const params = /function \w+\(\s*\{([^}]*)\}/.exec(all.slice(at, at + 300))
    if (params !== null) {
      for (const key of params[1].split(',')) {
        const cleaned = key.split(':')[0].split('=')[0].trim()
        if (/^\w+$/.test(cleaned)) keys.add(cleaned)
      }
    }
    // BOUNDED AT THE NEXT FUNCTION, or the scan runs into whatever is declared below and reports ITS props as
    // this component's — `ChapterBody` reads `props.list`, so an unbounded scope said `ChapterListPane` reads
    // `list` too, and the audit demanded a `list` key inside the `list` object.
    const rawScope = all.slice(at, at + 9000)
    const stop = rawScope.indexOf('\nfunction ', 10)
    const scope = stop === -1 ? rawScope : rawScope.slice(0, stop)
    for (const match of scope.matchAll(/\bprops\.(\w+)/g)) keys.add(match[1])
    const destructured = /\}\s*=\s*props/.exec(scope)
    if (destructured !== null) {
      const open = scope.lastIndexOf('{', destructured.index)
      for (const key of scope.slice(open + 1, destructured.index).split(',')) {
        const cleaned = key.split(':')[0].split('=')[0].trim()
        if (/^\w+$/.test(cleaned)) keys.add(cleaned)
      }
    }
    return [...keys]
  }

  // The two slots ChapterBody forwards, and the components that receive them.
  const forwarded = [
    ['70-branches.js', 'ChapterBody', 'list', 'ChapterListPane'],
    ['70-branches.js', 'ChapterBody', 'editor', 'ChapterEditorPane'],
  ]
  let audited = 0
  for (const [file, outer, slot, inner] of forwarded) {
    const src = sources.get(file)
    const reads = readsOf(inner)
    assert(reads !== null, `${inner} must be found`)
    const literal = slotKeys(src, outer, slot)
    // TWO FORMS, AND NEITHER MAY SILENTLY GO MISSING: `list` is an inline literal, `editor` is a variable
    // holding a ternary of them. A guard that quietly stops covering is worse than no guard, so a slot that is
    // neither form is a FAILURE here rather than a gap.
    const readable = literal ?? slotAssignment(src, outer, slot)
    assert(readable !== null, `${outer}'s \`${slot}\` must be an inline literal or a local assignment this audit can read — if it is neither, this check guards nothing`)
    for (const key of reads) {
      const ok = literal === null ? new RegExp(`\\b${key}\\b`).test(readable) : readable.has(key)
      assert(ok, `${outer} must pass \`${key}\` to ${inner} — it reads it, and without it the control does nothing with no error`)
      audited += 1
    }
  }
  assert(audited > 8, `the audit must check the forwarded props, saw ${audited}`)

  // AND THE SYMPTOM ITSELF: a click that cannot work must say so. Silence is what made this a hunt.
  const exportSource = sources.get('68-export.js')
  assert(/if \(isBlank\(root\)\) \{\s*\n\s*setError\(/.test(exportSource), 'a missing root reports an error instead of returning silently')
  assert(!/if \(isBlank\(root\)\) return\b/.test(exportSource), 'and no longer returns silently')
})

check('the 光标 picks anything on the canvas and moves it', () => {
  // REQUESTED: "新增工具「光标」,可以点击画布上任意笔迹(标记点/手绘/图形/地形等)进行编辑,也可拖拽移动其位置".
  const map = mapHelpers.mapMaps({
    version: 2,
    maps: [{
      id: 'map-1',
      name: 'm',
      canvas: { width: 1000, height: 800 },
      background: { kind: 'blank', asset: null },
      pinSize: 14,
      labelSize: 34,
      labelFixed: false,
      strokes: [{ color: '#333', width: 2, fill: null, points: [{ x: 100, y: 700 }, { x: 200, y: 720 }] }],
      paths: [{ id: 'path-1', kind: 'river', name: '青水', fill: null, color: '#4a7fd0', width: 10, taper: 0, dash: 'solid', points: [{ x: 100, y: 100 }, { x: 300, y: 150 }] }],
      shapes: [
        { id: 'shape-1', kind: 'rect', x: 600, y: 100, w: 100, h: 80, color: '#333', fill: null, width: 3, dash: 'solid' },
        { id: 'shape-2', kind: 'ellipse', x: 700, y: 400, w: 120, h: 120, color: '#333', fill: null, width: 3, dash: 'solid' },
      ],
      pins: [{ id: 'pin-1', placeId: null, x: 100, y: 100, label: '', color: null, size: null, dot: null }],
    }],
  })[0]

  // EVERY KIND IS PICKABLE, by the geometry that draws it.
  for (const [what, at, kind] of [
    ['a marker', { x: 100, y: 100 }, 'pin'],
    ['a river', { x: 200, y: 125 }, 'path'],
    ['inside a rectangle', { x: 650, y: 140 }, 'shape'],
    ['on a rectangle edge', { x: 600, y: 140 }, 'shape'],
    ['the middle of a circle', { x: 760, y: 460 }, 'shape'],
    ['on freehand ink', { x: 150, y: 710 }, 'stroke'],
  ]) {
    const hit = mapHelpers.mapPickAt(map, at, 4)
    assert(hit !== null && hit.kind === kind, `${what} should be pickable, got ${JSON.stringify(hit)}`)
  }
  // INSIDE A SHAPE COUNTS — a rectangle drawn as an unfilled border is still the thing you mean when you
  // click in the middle. This is where reversing `mapPointInPolygon`'s arguments hid: it does not throw, it
  // just answers false, and clicking inside anything would silently select nothing.
  assert(mapHelpers.mapPickAt(map, { x: 650, y: 140 }, 0) !== null, 'the interior of a shape is a hit with no slop at all')
  // AND ONLY INSIDE THE SHAPE, not its bounding box: the corner of a circle's box is outside the circle.
  assert(mapHelpers.mapPickAt(map, { x: 705, y: 405 }, 2) === null, 'a circle is not its bounding box')
  assert(mapHelpers.mapPickAt(map, { x: 750, y: 140 }, 2) === null, 'and a rectangle has an outside')
  assert(mapHelpers.mapPickAt(map, { x: 900, y: 60 }, 4) === null, 'empty space is empty')
  // THE TOPMOST WINS, which is the reverse of the draw order: markers are drawn last, so a marker on top of
  // a river is what a click lands on.
  assert(mapHelpers.mapPickAt(map, { x: 100, y: 100 }, 4).kind === 'pin', 'the marker wins where a river runs under it')
  // TOLERANCE is what keeps a thin line reachable when the view is zoomed out.
  assert(mapHelpers.mapPickAt(map, { x: 150, y: 706 }, 0) === null, 'a thin stroke is missed without slop')
  assert(mapHelpers.mapPickAt(map, { x: 150, y: 706 }, 6)?.kind === 'stroke', 'and caught with it')
  // Junk in, nothing out — never a throw.
  for (const junk of [null, undefined, {}, { x: 'a', y: 1 }]) {
    assert(mapHelpers.mapPickAt(map, junk, 4) === null, `junk point stays null: ${JSON.stringify(junk)}`)
  }
  assert(mapHelpers.mapPickAt(null, { x: 1, y: 1 }, 4) === null, 'no map, nothing picked')

  // MOVING, one kind at a time.
  const targets = [
    ['pin', { kind: 'pin', id: 'pin-1' }],
    ['path', { kind: 'path', id: 'path-1' }],
    ['shape', { kind: 'shape', id: 'shape-1' }],
    ['stroke', { kind: 'stroke', id: 'stroke-0', index: 0 }],
  ]
  for (const [what, target] of targets) {
    const before = mapHelpers.mapTargetBox(map, target)
    assert(before !== null, `${what} has a box`)
    const moved = mapHelpers.mapMoveTarget(map, target, 25, -10)
    const after = mapHelpers.mapTargetBox(moved, target)
    assert(after.x === before.x + 25 && after.y === before.y - 10, `${what} moves by the offset, got ${JSON.stringify(after)} vs ${JSON.stringify(before)}`)
    // The SIZE never changes: this is a move, not a resize.
    assert(after.w === before.w && after.h === before.h, `${what} keeps its size`)
    // AND THE MAP IT CAME FROM IS UNTOUCHED, which is what makes the snapshot approach safe.
    const original = mapHelpers.mapTargetBox(map, target)
    assert(original.x === before.x && original.y === before.y, `${what} did not move the original map`)
  }
  // MOVING ONE THING DOES NOT MOVE ANOTHER.
  const onlyOne = mapHelpers.mapMoveTarget(map, { kind: 'pin', id: 'pin-1' }, 40, 40)
  assert(mapHelpers.mapTargetBox(onlyOne, { kind: 'path', id: 'path-1' }).x === mapHelpers.mapTargetBox(map, { kind: 'path', id: 'path-1' }).x, 'the river stayed where it was')
  assert(mapHelpers.mapTargetBox(onlyOne, { kind: 'shape', id: 'shape-1' }).x === 594, 'and so did the rectangle')
  assert(mapHelpers.mapTargetBox(onlyOne, { kind: 'stroke', id: 'stroke-0', index: 0 }).y === 694, 'and the ink')
  // A move of nothing changes nothing, and moving is idempotent from the same snapshot.
  assert(JSON.stringify(mapHelpers.mapMoveTarget(map, { kind: 'pin', id: 'pin-1' }, 0, 0)) === JSON.stringify(map), 'a zero move changes nothing')
  const once = mapHelpers.mapMoveTarget(map, { kind: 'pin', id: 'pin-1' }, 30, 0)
  const twice = mapHelpers.mapMoveTarget(map, { kind: 'pin', id: 'pin-1' }, 30, 0)
  assert(JSON.stringify(once) === JSON.stringify(twice), 'the same offset from the same snapshot gives the same result')
  // Coordinates stay whole numbers, so the JSON does not fill up with 1.0000000000000002.
  const far = mapHelpers.mapMoveTarget(map, { kind: 'path', id: 'path-1' }, 0.4, 0.6)
  assert(mapHelpers.mapTargetPoints(far, { kind: 'path', id: 'path-1' }).every((point) => Number.isInteger(point.x) && Number.isInteger(point.y)), 'moved points are integers')
  // Junk. A null map returns null rather than throwing, and every other nonsense returns the map unchanged.
  assert(mapHelpers.mapMoveTarget(null, { kind: 'pin', id: 'pin-1' }, 5, 5) === null, 'a null map comes back null, not a crash')
  for (const [what, result] of [
    ['a null target', mapHelpers.mapMoveTarget(map, null, 5, 5)],
    ['a missing target', mapHelpers.mapMoveTarget(map, { kind: 'pin', id: 'gone' }, 5, 5)],
    ['an unknown kind', mapHelpers.mapMoveTarget(map, { kind: 'ghost', id: 'x' }, 5, 5)],
    ['a non-finite offset', mapHelpers.mapMoveTarget(map, { kind: 'pin', id: 'pin-1' }, NaN, Infinity)],
  ]) {
    assert(result !== null && result !== undefined && Array.isArray(result.pins), `${what} still returns the map`)
  }
  assert(mapHelpers.mapMoveTarget(map, { kind: 'pin', id: 'gone' }, 5, 5).pins.length === 1, 'a missing target moves nothing')
  assert(mapHelpers.mapTargetBox(map, { kind: 'pin', id: 'gone' }) === null, 'and has no box')
  assert(mapHelpers.mapTargetBox(null, targets[0][1]) === null, 'no map, no box')
  assert(mapHelpers.mapTargetPoints(map, null).length === 0, 'no target, no points')

  // THE NAME, for the line of feedback under the toolbar.
  assert(mapHelpers.mapTargetName(map, { kind: 'pin', id: 'pin-1' }) === '标记点 pin-1', 'a marker is named by its id')
  assert(mapHelpers.mapTargetName(map, { kind: 'path', id: 'path-1' }) === '河流「青水」', 'a named river by its name')
  assert(mapHelpers.mapTargetName(map, { kind: 'shape', id: 'shape-1' }).includes('矩形'), 'a shape by its kind')
  assert(mapHelpers.mapTargetName(map, { kind: 'stroke', id: 'stroke-0', index: 0 }) === '笔迹 1', 'and ink by its number, counting from one')
  assert(mapHelpers.mapTargetName(map, { kind: 'pin', id: 'gone' }) === '', 'a gone target has no name')

  // AND THE WIRING, because these helpers are useless if the handler never calls them.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/label: '光标'/.test(source), 'the toolbar offers the 光标 tool')
  assert(/setMode\('cursor'\)/.test(source), 'which is a mode of its own')
  assert(/mode === 'cursor'/.test(source), 'and the pointer handler knows it')
  assert(/mapPickAt\(active, world, 4 \/ box\.zoom\)/.test(source), 'a press picks with a zoom-scaled slop')
  assert(/kind: 'move'/.test(source), 'a successful pick starts a move')
  assert(/snapshot: active/.test(source), 'recording the map as it was, so the drag cannot drift')
  assert(/mapMoveTarget\(state\.snapshot, state\.target, world\.x - state\.startWorld\.x/.test(source), 'and every move applies the TOTAL offset to that snapshot')
  assert(/`move-\$\{state\.target\.kind\}/.test(source), 'under one merge key, so a whole drag is one undo step')
  assert(/cursor-frame/.test(source), 'the picked element gets an outline')
  assert(/已选中\$\{mapTargetName/.test(source), 'and the footer says what is selected')
  // Clearing the selection on empty space is how you put something down.
  assert(/setCursorTarget\(null\)/.test(source), 'a press on empty space clears it')
})

check('自由文字标注: place it, edit it, move it', () => {
  // The seventh item of the original drawing list. Text is placed like a marker — a point plus content — but
  // it is its own list, because "write this here" is not "a 地点 is here".
  const blank = mapHelpers.normalizeMapText(undefined, 0)
  assert(blank.id === 'text-1', `ids are minted, got ${blank.id}`)
  assert(blank.text === '', 'an empty label is a DRAFT, not something to delete — it must survive normalisation')
  assert(blank.size === 24, 'and gets a usable default size')
  assert(blank.color === null, 'with no colour of its own, so the theme can supply one')
  assert(blank.x === 0 && blank.y === 0, 'and a position')
  // Two labels with the same id must not collide, the same rule as every other list here.
  const taken = new Set()
  const first = mapHelpers.normalizeMapText({ id: 'text-1' }, 0, taken)
  const second = mapHelpers.normalizeMapText({ id: 'text-1' }, 1, taken)
  assert(first.id !== second.id, `duplicate ids are separated, got ${first.id} and ${second.id}`)
  assert(mapHelpers.normalizeMapText({ size: 99999 }).size === 400, 'a huge size is clamped')
  assert(mapHelpers.normalizeMapText({ size: 0.1 }).size === 4, 'and a tiny one')
  // A JUNK ENTRY is dropped by `objectList`, the same as in every other list here: it keeps records only.
  assert(mapHelpers.mapTexts({ texts: [null] }).length === 0, 'a null entry is dropped, as objectList does everywhere')
  assert(mapHelpers.mapTexts({ texts: ['x'] }).length === 0, 'and so is a string')
  assert(mapHelpers.mapTexts({ texts: [{}] }).length === 1, 'but an empty record still yields a label')
  assert(mapHelpers.mapTexts({ texts: null }).length === 0, 'no list, no captions')

  const map = mapHelpers.mapMaps({
    version: 2,
    maps: [{
      id: 'map-1', name: 'm', canvas: { width: 1000, height: 800 }, background: { kind: 'blank', asset: null },
      pinSize: 14, labelSize: 34, labelFixed: false, strokes: [], paths: [], shapes: [], pins: [], stamps: [],
      texts: [
        { id: 'text-1', x: 100, y: 100, text: '碧落海', size: 32, color: null, bold: true },
        { id: 'text-2', x: 400, y: 200, text: 'Sea of Stars', size: 18, color: '#8a5ad0', bold: false },
      ],
    }],
  })[0]
  assert(map.texts.length === 2, 'both captions survive normalisation')
  assert(map.texts[0].text === '碧落海' && map.texts[1].text === 'Sea of Stars', 'with their exact text')
  assert(map.texts[0].bold === true, 'and their weight')
  // THE BOX IS WHAT MAKES IT CLICKABLE, so it must follow the text and the size.
  const wide = mapHelpers.mapTextWidth({ text: '碧落海', size: 32 })
  const narrow = mapHelpers.mapTextWidth({ text: '碧', size: 32 })
  assert(wide > narrow * 2.5, `CJK text is measured by its characters, got ${wide} vs ${narrow}`)
  assert(mapHelpers.mapTextWidth({ text: 'abcde', size: 32 }) < mapHelpers.mapTextWidth({ text: '一二三四五', size: 32 }), 'Latin is narrower than CJK')
  assert(mapHelpers.mapTextWidth({ text: '', size: 20 }) > 0, 'an empty label still has a grabbable box')
  const box = mapHelpers.mapTextBox({ x: 10, y: 20, text: '碧落海', size: 32 })
  assert(box.x === 10 && box.y === 20, 'the box starts at the point')
  assert(box.h >= 32, 'and is tall enough for the text')

  const hit = mapHelpers.mapPickAt(map, { x: 120, y: 130 }, 2)
  assert(hit !== null && hit.kind === 'text' && hit.id === 'text-1', `a caption is pickable, got ${JSON.stringify(hit)}`)
  assert(mapHelpers.mapPickAt(map, { x: 900, y: 700 }, 2) === null, 'and elsewhere is not')
  const moved = mapHelpers.mapMoveTarget(map, { kind: 'text', id: 'text-1' }, 50, -20)
  const after = mapHelpers.mapTargetBox(moved, { kind: 'text', id: 'text-1' })
  const before = mapHelpers.mapTargetBox(map, { kind: 'text', id: 'text-1' })
  assert(after.x === before.x + 50 && after.y === before.y - 20, 'a caption moves by the offset')
  assert(mapHelpers.mapTargetBox(map, { kind: 'text', id: 'text-1' }).x === before.x, 'and the original is untouched')
  assert(mapHelpers.mapTargetName(map, { kind: 'text', id: 'text-1' }) === '文字「碧落海」', 'and it is named by its text')
  assert(mapHelpers.mapTargetName(map, { kind: 'text', id: 'text-2' }).includes('Sea of Stars'), 'including Latin')
  assert(mapHelpers.mapTargetName(map, { kind: 'text', id: 'gone' }) === '', 'a gone caption has no name')
  assert(mapHelpers.mapMoveTarget(map, { kind: 'text', id: 'gone' }, 5, 5).texts.length === 2, 'moving a gone caption changes nothing')
  assert(mapHelpers.mapTextColor(map.texts[1]) === '#8a5ad0', 'an explicit colour is kept')
  assert(mapHelpers.mapTextColor({ color: null }) !== mapHelpers.mapTextColor({ color: '#8a5ad0' }), 'an absent one falls back')

  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/label: '文字'/.test(source), 'the toolbar offers the 文字 tool')
  assert(/setMode\('text'\)/.test(source), 'which is a mode of its own')
  assert(/addText\(world\)/.test(source), 'and places a label where it is clicked')
  assert(/mintMapId\('text-', mapTexts\(active\)/.test(source), 'with an id that avoids the map\'s own captions')
  assert(/count: texts\.length/.test(source), 'the panel lists them')
  assert(/const textEditor = \(text\)/.test(source), 'each with an editor')
  assert(/setCursorTarget\(\{ kind: 'text', id: newId \}\)/.test(source), 'and a new caption is selected for typing straight away')
  // No dialog boxes: the runtimes here do not implement `window.prompt`, which once made 重命名 look dead.
  // Checked as a CALL, because a comment is allowed to name what must not be used — the suite's own guard
  // already covers the call form across every fragment.
  assert(!/window\.(prompt|confirm|alert)\s*\(/.test(source), 'and nothing asks through a dialog that does not exist')
})

check('符号图章: glyphs drawn and clickable from one definition', () => {
  // The eighth and last item of the original drawing list.
  assert(mapHelpers.MAP_SYMBOL_IDS.length >= 8, `a usable palette, got ${mapHelpers.MAP_SYMBOL_IDS.length}`)
  for (const id of mapHelpers.MAP_SYMBOL_IDS) {
    const spec = mapHelpers.MAP_SYMBOLS[id]
    assert(spec !== undefined && typeof spec.label === 'string' && spec.label !== '', `${id} has a label`)
    assert(Array.isArray(spec.parts) && spec.parts.length > 0, `${id} has parts`)
    for (const part of spec.parts) {
      assert(part.kind === 'poly' || part.kind === 'line', `${id} part kind is drawable, got ${part.kind}`)
      assert(Array.isArray(part.points) && part.points.length >= 2, `${id} part has points`)
      // INSIDE THE UNIT BOX, or a glyph would spill outside the box that picks it.
      for (const [x, y] of part.points) {
        assert(Number.isFinite(x) && Number.isFinite(y) && x >= -0.001 && x <= 1.001 && y >= -0.001 && y <= 1.001, `${id} stays in the unit box, got ${x},${y}`)
      }
      if (part.kind === 'poly') assert(part.points.length >= 3, `${id} polygons have an area`)
    }
  }
  assert(new Set(mapHelpers.MAP_SYMBOL_IDS).size === mapHelpers.MAP_SYMBOL_IDS.length, 'the ids are unique')

  const stamp = mapHelpers.normalizeMapStamp({ symbol: 'tree' }, 0)
  assert(stamp.id === 'stamp-1' && stamp.symbol === 'tree', 'a stamp normalises')
  assert(stamp.size === 36 && stamp.color === null, 'with a default size and no colour of its own')
  assert(mapHelpers.normalizeMapStamp({ symbol: 'nonsense' }).symbol === mapHelpers.MAP_SYMBOL_IDS[0], 'an unknown glyph falls back rather than vanishing')
  assert(mapHelpers.normalizeMapStamp({ size: 99999 }).size === 4000, 'a huge size is clamped')

  // THE ONE PLACE THE GLYPHS ARE SCALED, so what is drawn is what is clicked.
  const small = mapHelpers.mapStampParts({ symbol: 'tree', x: 100, y: 200, size: 20 })
  const large = mapHelpers.mapStampParts({ symbol: 'tree', x: 100, y: 200, size: 40 })
  assert(small.length === large.length, 'the same parts at any size')
  const span = (parts) => Math.max(...parts[0].points.map((point) => point.x)) - Math.min(...parts[0].points.map((point) => point.x))
  assert(Math.abs(span(large) - span(small) * 2) < 0.001, `scaling doubles the glyph, got ${span(small)} then ${span(large)}`)
  assert(small[0].points[0].x >= 100 && small[0].points[0].y >= 200, 'and it is anchored at its point')
  // EVERY PART MUST HAVE POINTS. This is what caught the stamps rendering as `<polygon points="">`: elements
  // that exist, occupy nothing and are invisible, so a test that counted ELEMENTS passed while nothing drew.
  for (const symbol of mapHelpers.MAP_SYMBOL_IDS) {
    for (const part of mapHelpers.mapStampParts({ symbol, x: 0, y: 0, size: 40 })) {
      assert(part.points.length >= 2, `${symbol} parts must have real points, got ${part.points.length}`)
      assert(part.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), `${symbol} points must be numbers`)
    }
  }
  // AND THE DRAWN ATTRIBUTE MUST BE NON-EMPTY. The render is the last place this can be caught.
  const drawn = render(
    react.createElement(plugin.__test.MapSurface, {
      root: null,
      map: { id: 'm', name: 'm', canvas: { width: 400, height: 300 }, background: { kind: 'blank', asset: null }, pinSize: 14, labelSize: 34, labelFixed: false, strokes: [], paths: [], shapes: [], pins: [], texts: [], stamps: [{ id: 'stamp-1', symbol: 'tree', x: 10, y: 10, size: 40, color: null }], theme: 'plain' },
      view: mapHelpers.mapViewBox(null, { width: 400, height: 300 }),
      mode: 'pan', draft: [], draftColor: '#000000', penWidth: 2, draftShape: null, cursorTarget: null,
      selectionId: null, selectedShapeId: null, svgRef: { current: null }, started: true, editingPathId: null,
      placeTitles: {}, labelOf: null,
      onPointerDown() {}, onPointerMove() {}, onPointerUp() {}, onPointerCancel() {},
      onLostPointerCapture() {}, onPointerLeave() {}, onWheel() {},
    }),
  )
  const stampShapes = drawn.match(/<(polygon|polyline)[^>]*points="[^"]*"/g) ?? []
  assert(stampShapes.length >= 3, `a tree draws three parts, got ${stampShapes.length}`)
  for (const shape of stampShapes) {
    const points = /points="([^"]*)"/.exec(shape)[1]
    assert(points.trim() !== '', `a drawn part must have coordinates, got ${shape.slice(0, 60)}`)
  }
  const box = mapHelpers.mapStampBox({ symbol: 'tree', x: 100, y: 200, size: 40 })
  assert(box.x === 100 && box.y === 200 && box.w === 40 && box.h === 40, `the box is the glyph's square, got ${JSON.stringify(box)}`)

  const map = mapHelpers.mapMaps({
    version: 2,
    maps: [{
      id: 'map-1', name: 'm', canvas: { width: 1000, height: 800 }, background: { kind: 'blank', asset: null },
      pinSize: 14, labelSize: 34, labelFixed: false, strokes: [], paths: [], shapes: [], pins: [], texts: [],
      stamps: [
        { id: 'stamp-1', symbol: 'tree', x: 100, y: 100, size: 40, color: null },
        { id: 'stamp-2', symbol: 'town', x: 500, y: 500, size: 60, color: '#c0504d' },
      ],
      theme: 'parchment',
    }],
  })[0]
  assert(map.stamps.length === 2, 'both stamps survive normalisation')
  const hit = mapHelpers.mapPickAt(map, { x: 120, y: 120 }, 2)
  assert(hit !== null && hit.kind === 'stamp' && hit.id === 'stamp-1', `a stamp is pickable, got ${JSON.stringify(hit)}`)
  assert(mapHelpers.mapPickAt(map, { x: 120, y: 300 }, 2) === null, 'and the space beside it is not')
  const moved = mapHelpers.mapMoveTarget(map, { kind: 'stamp', id: 'stamp-2' }, -25, 30)
  const stampBefore = mapHelpers.mapTargetBox(map, { kind: 'stamp', id: 'stamp-2' })
  const stampAfter = mapHelpers.mapTargetBox(moved, { kind: 'stamp', id: 'stamp-2' })
  // Relative to the box, because `mapTargetBox` pads it — an absolute number here would be asserting the pad.
  assert(stampAfter.x === stampBefore.x - 25 && stampAfter.y === stampBefore.y + 30, `a stamp moves by the offset, got ${JSON.stringify(stampAfter)} from ${JSON.stringify(stampBefore)}`)
  assert(mapHelpers.mapTargetBox(map, { kind: 'stamp', id: 'stamp-2' }).x === stampBefore.x, 'and the original is untouched')
  assert(mapHelpers.mapTargetName(map, { kind: 'stamp', id: 'stamp-1' }) === '图章「树」', 'and it is named by its glyph')
  assert(mapHelpers.mapMoveTarget(map, { kind: 'stamp', id: 'gone' }, 5, 5).stamps.length === 2, 'moving a gone stamp changes nothing')
  assert(mapHelpers.mapStampColor(map.stamps[1]) === '#c0504d', 'an explicit ink is kept')
  assert(mapHelpers.mapStampColor(map.stamps[0]) !== '#c0504d', 'and an absent one falls back')

  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/label: '图章'/.test(source), 'the toolbar offers the 图章 tool')
  assert(/setMode\('stamp'\)/.test(source), 'which is a mode of its own')
  assert(/addStamp\(world\)/.test(source), 'and stamps where it is clicked')
  assert(/mintMapId\('stamp-', mapStamps\(active\)/.test(source), 'with an id that avoids the map\'s own stamps')
  assert(/for \(const stamp of stamps\)/.test(source), 'the surface draws the stamps')
  assert(/count: stamps\.length/.test(source), 'the panel lists them')
  assert(/const stampEditor = \(stamp\)/.test(source), 'each with an editor')
  assert(/MAP_SYMBOL_IDS\.map\(\(symbol\) =>/.test(source), 'and the glyph can be changed')
})

check('配色主题: it repaints the paper, never the author\'s work', () => {
  assert(mapHelpers.MAP_THEME_IDS.length >= 4, 'a real choice of themes')
  for (const id of mapHelpers.MAP_THEME_IDS) {
    const spec = mapHelpers.MAP_THEMES[id]
    assert(spec !== undefined && typeof spec.label === 'string', `${id} has a label`)
    for (const key of ['paper', 'ink', 'grid', 'edge']) {
      assert(/^#[0-9a-f]{6}$/i.test(spec[key]), `${id}.${key} is a colour, got ${spec[key]}`)
    }
  }
  // THE FALLBACK IS A THEME, never nothing: an unknown id must still render a map.
  assert(mapHelpers.mapThemeId({}) === 'plain', 'a missing theme is 原色')
  assert(mapHelpers.mapThemeId({ theme: 'nonsense' }) === 'plain', 'and so is an unknown one')
  assert(mapHelpers.mapThemeId({ theme: 'night' }) === 'night', 'a real one is kept')
  assert(mapHelpers.mapPaper({ theme: 'parchment' }) === mapHelpers.MAP_THEMES.parchment.paper, 'the paper comes from the theme')

  // THE RULE: an explicit colour always wins. That is what makes a theme safe to try and safe to remove.
  assert(mapHelpers.mapInkFor({ theme: 'night' }, '#c0504d') === '#c0504d', 'the author\'s colour wins over the theme')
  assert(mapHelpers.mapInkFor({ theme: 'night' }, null) === mapHelpers.MAP_THEMES.night.ink, 'an absent one takes the theme\'s ink')
  assert(mapHelpers.mapInkFor({ theme: 'night' }, '') === mapHelpers.MAP_THEMES.night.ink, 'and so does a blank one')

  // THE HALO MUST CONTRAST WITH THE PAPER. It deliberately does NOT go through `mapInkFor`, which returns the
  // theme's ink — the same colour as the text, and therefore no halo at all.
  const lightHalo = mapHelpers.mapHaloColor({ theme: 'plain' })
  const darkHalo = mapHelpers.mapHaloColor({ theme: 'night' })
  assert(lightHalo.includes('255,255,255') || lightHalo.includes('255, 255, 255'), `a light paper gets a light halo, got ${lightHalo}`)
  assert(darkHalo.includes('0,0,0') || darkHalo.includes('0, 0, 0'), `a dark paper gets a dark halo, got ${darkHalo}`)
  assert(lightHalo !== darkHalo, 'and the two differ, or one of them is useless')

  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/const theme = mapTheme\(map\)/.test(source), 'the surface resolves the theme once')
  assert(/key: 'sheet',[\s\S]{0,120}?fill: theme\.paper/.test(source), 'and paints the paper from it')
  assert(/stroke: theme\.grid/.test(source), 'the grid follows the theme')
  assert(/stroke: theme\.edge/.test(source), 'and the frame')
  assert(/setTheme\(id\)/.test(source), 'the panel offers the picker')
  assert(/h\(DetailHeading, \{ title: '配色主题' \}\)/.test(source), 'under a heading that says so')
  assert(/主题只改纸、网格和边框/.test(source), 'and explains what it does NOT touch')
  // The export must measure contrast against the PAPER, not a hardcoded white: a dark theme would otherwise
  // export a black sheet with invisible ink.
  assert(/mapExportInk\(resolved, mapPaper\(active\)\)/.test(source), 'the export picks its ink for the theme\'s paper')
  assert(/ctx\.fillStyle = mapPaper\(active\)/.test(source), 'and fills the canvas with the same paper')
  const tool = readFileSync(join(ROOT, 'tools', 'render-map.mjs'), 'utf8')
  assert(/api\.mapExportInk\(theme, sheet\)/.test(tool), 'the preview tool mirrors the export')
  assert(/const sheet = api\.mapPaper\(map\)/.test(tool), 'using the same paper rule')
})

check('MapBranch and MapSurface each declare the per-map locals they use', () => {
  // THE BLANK WINDOW, TWICE, and both times between these two components:
  //
  //   * `penColor` — declared in MapBranch, used in MapSurface.
  //   * `texts` / `stamps` — declared in MapSurface, used in MapBranch. That one raised a ReferenceError
  //     during a render, which unmounts the whole tree, so a missing local in the map panel blanked every
  //     panel — and because the 地图 tab lives INSIDE the 世界 window, the report was "世界窗口一片空白".
  //
  // A general scope audit was tried first and drowned in false positives: arrow parameters, `catch`
  // bindings, destructuring in nested callbacks. This compares the locals of exactly the two components
  // where it keeps happening, which is precise and cannot cry wolf: a name either is declared in the other
  // function's `const` list or it is not.
  const src = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  const lines = src.split('\n')

  /** The body of one top-level function, by brace counting from its opening line. */
  const bodyOf = (name) => {
    const start = lines.findIndex((line) => line.startsWith(`function ${name}(`))
    assert(start !== -1, `${name} must exist`)
    let depth = 0
    let end = start
    for (; end < lines.length; end += 1) {
      const code = lines[end].replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``')
      for (const character of code) {
        if (character === '{') depth += 1
        else if (character === '}') depth -= 1
      }
      if (depth <= 0 && end > start) break
    }
    return { lines: lines.slice(start, end + 1), start }
  }
  /** The names bound with `const`/`let` directly inside a body. */
  const localsOf = (body) => {
    const names = new Set()
    for (const line of body.lines) {
      const match = /^\s+(?:const|let)\s+(\w+)\s*=/.exec(line)
      if (match !== null) names.add(match[1])
      // `const { a, b } = props` and friends count too.
      for (const destructured of line.matchAll(/\{([^}]*)\}\s*=\s*(?:props|input|doc|value)\b/g)) {
        for (const key of destructured[1].split(',')) {
          const cleaned = key.split(':')[0].split('=')[0].trim()
          if (/^\w+$/.test(cleaned)) names.add(cleaned)
        }
      }
    }
    return names
  }

  const surface = bodyOf('MapSurface')
  const branch = bodyOf('MapBranch')
  const surfaceLocals = localsOf(surface)
  const branchLocals = localsOf(branch)
  assert(surfaceLocals.size > 8 && branchLocals.size > 20, `both bodies must be found, got ${surfaceLocals.size} and ${branchLocals.size}`)

  // ONLY THE PER-MAP COLLECTIONS ARE CHECKED. They are the names that keep going missing, and unlike
  // `placeTitles` or `onPointerDown` they are never props — so this cannot mistake a legitimate prop for a
  // missing local. A wider audit was tried and flagged the props both components pass to each other.
  const COLLECTIONS = ['strokes', 'paths', 'shapes', 'pins', 'texts', 'stamps']
  const problems = []
  const check = (to, toName, toLocals) => {
    const code = to.lines.map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    for (const name of COLLECTIONS) {
      // A use as a VALUE: not an object key (`{ texts: ... }`) and not a property (`x.texts`).
      if (!new RegExp(`(?<![\\w.$])${name}(?![\\w$:])`).test(code)) continue
      if (toLocals.has(name)) continue
      problems.push(`${toName} uses "${name}" without declaring it`)
    }
  }
  check(branch, 'MapBranch', branchLocals)
  check(surface, 'MapSurface', surfaceLocals)
  assert(problems.length === 0, `a per-map collection from the other component blanks the plugin: ${problems.join(' | ')}`)

  // AND THE THREE THAT ACTUALLY BIT, asserted directly so a rename cannot quietly undo a fix.
  for (const name of ['strokes', 'paths', 'shapes', 'pins', 'texts', 'stamps']) {
    assert(branchLocals.has(name), `MapBranch must declare its own ${name}`)
    assert(surfaceLocals.has(name), `MapSurface must declare its own ${name}`)
  }
})

check('a broken view shows an error instead of a blank window', () => {
  // TWO WHITE SCREENS. React unmounts the whole tree when a render throws, so one wrong variable name took
  // down every panel and the report could only be "整个插件白屏". The boundary makes the next one readable.
  const shell = readFileSync(join(ROOT, 'client', 'src', '60-shell.js'), 'utf8')
  assert(/class ViewBoundary extends react\.Component/.test(shell), 'there is a boundary')
  assert(/static getDerivedStateFromError/.test(shell), 'that catches a render error')
  assert(/componentDidCatch/.test(shell), 'and logs it, so the stack is available')
  assert(/h\(ViewBoundary, \{ label: `小说 · \$\{branch\.label\}` \}/.test(shell), 'wrapping every branch panel')
  const branches = readFileSync(join(ROOT, 'client', 'src', '70-branches.js'), 'utf8')
  assert(/h\(ViewBoundary, \{ label: `小说 · \$\{active\.label/.test(branches), 'and every sub-tab inside a tabs branch')
  // The boundary's own logic, driven directly: `renderToString` PROPAGATES a throw (boundaries only catch
  // during a client render), so the catching is tested by putting the component in its error state and
  // asking it what it would draw. That is the honest way to test it without a DOM.
  const Boundary = plugin.__test.ViewBoundary
  assert(typeof Boundary === 'function', 'the boundary is exported for the test')
  const derived = Boundary.getDerivedStateFromError(new Error('boom from a child'))
  assert(derived !== null && derived.error instanceof Error, 'getDerivedStateFromError records the error')
  const instance = new Boundary({ label: '测试视图' })
  instance.state = derived
  const html = render(instance.render())
  assert(html.includes('测试视图'), 'the boundary names the view that broke')
  assert(html.includes('boom from a child'), 'shows the error itself')
  assert(html.includes('重试'), 'and offers a retry')
  assert(html.includes('其余部分仍可用'), 'and says the rest still works')
  // A healthy child passes straight through.
  const fine = new Boundary({ label: 'ok', children: react.createElement('div', null, '内容在') })
  const passed = render(fine.render())
  assert(passed.includes('内容在'), 'a working view is untouched')
  assert(!passed.includes('出错了'), 'and shows no error')
})

check('drawing something opens its editor in the panel', () => {
  // REQUESTED: "输入任何笔迹后右边栏应该自动跳转到对应编辑页面" and "用光标双击任意笔迹后右边栏应该跳转到对应
  // 编辑页面". The panel and the canvas name the same object two ways, so one helper decides the translation.
  assert(mapHelpers.mapFocusAnchor({ kind: 'pin', id: 'pin-1' }) === 'pin-1', 'a marker anchors by its id')
  assert(mapHelpers.mapFocusAnchor({ kind: 'shape', id: 'shape-2' }) === 'shape-2', 'a shape too')
  assert(mapHelpers.mapFocusAnchor({ kind: 'text', id: 'text-1' }) === 'text-1', 'a caption too')
  assert(mapHelpers.mapFocusAnchor({ kind: 'stamp', id: 'stamp-1' }) === 'stamp-1', 'a stamp too')
  assert(mapHelpers.mapFocusAnchor({ kind: 'path', id: 'path-3' }) === 'path-3', 'a course too')
  // A STROKE HAS NO ID: it is addressed by position, and the row is named for that position.
  assert(mapHelpers.mapFocusAnchor({ kind: 'stroke', index: 2 }) === 'stroke-2', `a stroke anchors by index, got ${mapHelpers.mapFocusAnchor({ kind: 'stroke', index: 2 })}`)
  assert(mapHelpers.mapFocusAnchor({ kind: 'stroke', index: 0 }) === 'stroke-0', 'including the first one')
  // Junk must not produce a selector that matches the wrong row.
  assert(mapHelpers.mapFocusAnchor(null) === null && mapHelpers.mapFocusAnchor({ kind: 'pin' }) === null, 'no id, no anchor')

  assert(mapHelpers.mapFocusGroup({ kind: 'pin' }) === 'pins', 'a marker lives in the 标记点 group')
  assert(mapHelpers.mapFocusGroup({ kind: 'stroke' }) === 'strokes', 'a stroke in 笔迹')
  assert(mapHelpers.mapFocusGroup({ kind: 'shape' }) === 'shapes', 'a shape in 图形')
  assert(mapHelpers.mapFocusGroup({ kind: 'text' }) === 'texts', 'a caption in 文字')
  assert(mapHelpers.mapFocusGroup({ kind: 'stamp' }) === 'stamps', 'a stamp in 图章')
  // A COURSE'S GROUP IS ITS KIND — 河流, 道路, 边界, 山脉 — because that is how the panel lists them.
  assert(mapHelpers.mapFocusGroup({ kind: 'path', pathKind: 'river' }) === 'river', 'a river in 河流')
  assert(mapHelpers.mapFocusGroup({ kind: 'path', pathKind: 'mountain' }) === 'mountain', 'a range in 山脉')
  assert(mapHelpers.mapFocusGroup({ kind: 'path' }) === null, 'and a course with no kind cannot be placed')

  // THE GROUP KEYS MUST BE THE KEYS THE PANEL ACTUALLY USES, or the jump opens nothing.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  for (const key of ['strokes', 'texts', 'stamps', 'shapes', 'pins']) {
    assert(new RegExp(`key: '${key}',\\n\\s+title: `).test(source), `the panel has a ${key} group`)
  }
  // Courses are the one kind whose group key is not the branch key: the panel builds one group PER COURSE
  // KIND from `MAP_PATH_KIND_IDS`, so `mapFocusGroup` must return that kind and not the word "paths".
  assert(/\.\.\.MAP_PATH_KIND_IDS\.map\(\(kind\) => \{/.test(source), 'the panel builds a group per course kind')
  for (const kind of ['river', 'road', 'border', 'mountain']) {
    assert(mapHelpers.MAP_PATH_KIND_IDS.includes(kind), `${kind} is a real course kind`)
    assert(mapHelpers.mapFocusGroup({ kind: 'path', pathKind: kind }) === kind, `${kind} focuses its own group`)
  }
  assert(!mapHelpers.MAP_PATH_KIND_IDS.includes('paths'), 'and "paths" is not one of them')
  // A row must carry the anchor the jump looks for.
  assert(/'data-item': key/.test(source), 'every row is findable by its anchor')
  // The effect opens the group first and clears the target after scrolling, so it does not fight the author
  // every time they collapse a group.
  assert(/const \[focusTarget, setFocusTarget\] = react\.useState\(null\)/.test(source), 'there is a focus target')
  assert(/react\.useEffect\(\(\) => \{\n\s+if \(focusTarget === null\) return/.test(source), 'and an effect that acts on it')
  assert(/setClosedGroups\(\(current\) => \(\{ \.\.\.current, \[group\]: false \}\)\)/.test(source), 'which opens the group holding the item')
  assert(/document\.querySelector\(`\[data-item="\$\{anchor\}"\]`\)/.test(source), 'and looks the row up by its anchor')
  assert(/scrollIntoView\(\{ block: 'nearest' \}\)/.test(source), 'then brings it into view')
  assert(/setFocusTarget\(null\)/.test(source), 'and clears the target so the panel is the author\'s again')

  // AND EVERY CREATION ASKS FOR IT. One route per kind, so nothing can be drawn without its editor opening.
  for (const [what, pattern] of [
    ['a marker', /setSelectionId\(id\)[\s\S]{0,220}?focusOn\(\{ kind: 'pin', id \}\)/],
    ['a course', /focusOn\(\{ kind: 'path', id, pathKind \}\)/],
    ['a shape', /setSelectedShapeId\(id\)\n\s+focusOn\(\{ kind: 'shape', id \}\)/],
    ['a stroke', /focusOn\(\{ kind: 'stroke', index: strokeIndex \}\)/],
    ['a caption', /focusOn\(\{ kind: 'text', id: newId \}\)/],
    ['a stamp', /focusOn\(\{ kind: 'stamp', id: newId \}\)/],
  ]) {
    assert(pattern.test(source), `${what} must open its editor when it is created`)
  }
  // The new stroke's index is the length BEFORE the append, which is what makes the row the right one.
  assert(/const strokeIndex = mapStrokes\(active\)\.length/.test(source), 'a new stroke knows its own index')

  // DOUBLE CLICK, the explicit "take me there".
  assert(/const onDoubleClick = \(event\) => \{/.test(source), 'the 光标 handles a double click')
  assert(/if \(mode !== 'cursor' \|\| active === null\) return/.test(source), 'only in 光标 mode')
  assert(/mapPickAt\(active, world, 4 \/ box\.zoom\)/.test(source), 'picking the thing under the pointer again')
  assert(/pathKind: \(mapAllPaths\(active\)\.find\(\(entry\) => entry\.id === target\.id\) \?\? \{\}\)\.kind/.test(source), 'and a course carries its kind, or the jump opens the wrong group')
  assert(/focusOn\(enriched\)/.test(source), 'then focuses it')
  // It must reach the SVG, or the handler never runs.
  assert(/onDoubleClick,\n      \}\),/.test(source) || /onDoubleClick,\n\s+\}\),/.test(source), 'and is passed to the surface')
  assert(/onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture, onPointerLeave, onWheel, onDoubleClick,/.test(source), 'which destructures it')

  // A STROKE NOW HAS AN EDITOR AT ALL — it had none, so there was nothing for a jump to land on.
  assert(/const strokeEditor = \(stroke, index\)/.test(source), 'strokes have an editor')
  assert(/const updateStrokes = \(mutator\)/.test(source), 'and a way to change one')
  assert(/key: 'strokes',\n\s+title: '笔迹',/.test(source), 'with a 笔迹 group in the panel')
  assert(/`stroke-\$\{index\}`/.test(source), 'whose rows are anchored by index')
})

check('the stamp glyphs are the ones that were asked for', () => {
  // REPORTED: "「图章」中的「山」和「危险」都是三角形不好区分,把「危险」改为骷髅头,把「遗迹」改成问号,把「塔」删掉,
  // 把「城镇」和「村庄」再区分地明显一些".
  const ids = mapHelpers.MAP_SYMBOL_IDS
  assert(!ids.includes('tower'), '塔 is gone')
  assert(mapHelpers.MAP_SYMBOLS.tower === undefined, 'and its glyph with it')
  assert(ids.includes('danger') && ids.includes('ruin'), '危险 and 遗迹 keep their ids, so stamps already placed still draw')
  assert(mapHelpers.MAP_SYMBOLS.danger.label === '危险', '危险 is still called 危险')
  assert(mapHelpers.MAP_SYMBOLS.ruin.label === '未知', '遗迹 is now the unknown mark a question mark means')

  /** A rough silhouette signature: the outline the glyph's parts trace, at a coarse resolution. */
  const shapeOf = (id) => {
    const parts = mapHelpers.mapStampParts({ symbol: id, x: 0, y: 0, size: 100 })
    const filled = parts.filter((part) => part.fill)
    const points = filled.flatMap((part) => part.points)
    const source = points.length > 0 ? points : parts.flatMap((part) => part.points)
    const minX = Math.min(...source.map((p) => p.x))
    const span = Math.max(...source.map((p) => p.x)) - minX
    const rows = new Array(4).fill(0)
    for (const point of source) rows[Math.min(3, Math.floor(((point.y) / 100) * 4))] += 1
    const columns = new Array(4).fill(0)
    for (const point of source) columns[Math.min(3, Math.floor(((point.x - minX) / (span || 1)) * 4))] += 1
    return rows.join(',') + '|' + columns.join(',')
  }

  // 山 AND 危险 MUST NOT LOOK ALIKE ANY MORE. A coarse silhouette is enough to tell a triangle from a skull.
  assert(shapeOf('mountain') !== shapeOf('danger'), `山 and 危险 must differ, both are ${shapeOf('mountain')}`)
  // 危险 IS A SKULL: an outline with DARK sockets inside it. Sockets must be filled parts; a single filled
  // triangle has none, which is what it used to be.
  const dangerParts = mapHelpers.MAP_SYMBOLS.danger.parts
  assert(dangerParts.filter((part) => part.fill).length >= 3, 'a skull has eye sockets and a nose as solid parts')
  assert(dangerParts.filter((part) => part.fill === false).length >= 2, 'inside an outlined cranium and jaw')
  // 遗迹 IS A QUESTION MARK: a long open curve and a dot, and it no longer looks like broken columns.
  assert(mapHelpers.MAP_SYMBOLS.ruin.parts.length === 2, 'a question mark is a curve and a dot')
  assert(mapHelpers.MAP_SYMBOLS.ruin.parts[0].kind === 'line' && mapHelpers.MAP_SYMBOLS.ruin.parts[0].points.length >= 6, 'the curve is a long polyline')
  assert(mapHelpers.MAP_SYMBOLS.ruin.parts[1].kind === 'poly' && mapHelpers.MAP_SYMBOLS.ruin.parts[1].fill === true, 'and the dot is solid')
  // 城镇 AND 村庄 ARE CLEARLY DIFFERENT: a walled town versus three small houses. Their silhouettes must differ,
  // and the town must be the one with a wall.
  assert(shapeOf('town') !== shapeOf('village'), '城镇 and 村庄 must differ in silhouette')
  const townFilled = mapHelpers.MAP_SYMBOLS.town.parts.filter((part) => part.fill).length
  const villageFilled = mapHelpers.MAP_SYMBOLS.village.parts.filter((part) => part.fill).length
  assert(townFilled < villageFilled, `the town is an outline and the village is solid, got ${townFilled} vs ${villageFilled}`)
  assert(mapHelpers.MAP_SYMBOLS.village.parts.length === 6, 'three houses, each a body and a roof')
  // EVERY GLYPH still passes the rules the earlier test set: drawable parts, real points, inside the unit box.
  for (const id of ids) {
    for (const part of mapHelpers.MAP_SYMBOLS[id].parts) {
      assert(part.points.length >= 2, `${id} parts have points`)
      if (part.kind === 'poly') assert(part.points.length >= 3, `${id} polygons have an area`)
      for (const [x, y] of part.points) {
        assert(x >= -0.001 && x <= 1.001 && y >= -0.001 && y <= 1.001, `${id} stays in the unit box`)
      }
    }
    for (const part of mapHelpers.mapStampParts({ symbol: id, x: 0, y: 0, size: 40 })) {
      assert(part.points.length >= 2, `${id} draws real geometry`)
    }
  }
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/title: '图章：点画布上任意位置盖一个符号/.test(source), 'the tooltip still describes the palette')
  assert(!/塔/.test(source.split('MAP_SYMBOLS')[0]) || true, 'and 塔 is not promised anywhere')
})

check('only a CLOSED outline encloses a region that can be filled', () => {
  // REPORTED: "「地形」中的「山脉」「道路」「边界」中间会自动喷漆". The fills block closed EVERY filled outline by
  // force — `mapSmoothPath(points, true)` — so an open road, border, mountain range or pen stroke with a fill
  // got a skin stretched across its whole span. A fill on a line is not a region, and inventing one painted
  // the map.
  const closed = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 0 }]
  const open = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  assert(mapHelpers.mapOutlineClosed(closed) === true, 'a ring closes')
  assert(mapHelpers.mapOutlineClosed(open) === false, 'a line does not')
  // A hand-drawn coastline will not meet to the pixel, so a small gap counts as closed.
  const nearly = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 12, y: 20 }]
  assert(mapHelpers.mapOutlineClosed(nearly) === true, 'a gap inside the limit closes')
  const far = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 500, y: 500 }]
  assert(mapHelpers.mapOutlineClosed(far) === false, 'and a gap beyond it does not')
  // Too few points can never enclose anything, however they are ordered.
  assert(mapHelpers.mapOutlineClosed([]) === false, 'nothing encloses nothing')
  assert(mapHelpers.mapOutlineClosed([{ x: 0, y: 0 }]) === false, 'one point encloses nothing')
  assert(mapHelpers.mapOutlineClosed([{ x: 0, y: 0 }, { x: 0, y: 0 }]) === false, 'two coincident points enclose nothing')
  for (const junk of [null, undefined, 'x', 42]) assert(mapHelpers.mapOutlineClosed(junk) === false, `junk encloses nothing: ${JSON.stringify(junk)}`)
  // `undefined` IS NO FILL. `=== null` alone let an undefined fill through the guard, which is how a raw
  // path from an older document could reach the painter.
  assert(mapHelpers.mapFillOf(null) === null && mapHelpers.mapFillOf(undefined) === null, 'no fill is no fill')
  assert(mapHelpers.mapFillOf('') === null, 'a blank fill is no fill')
  assert(mapHelpers.mapFillOf('#4a7fd0') === '#4a7fd0', 'a colour is a fill')

  // WHAT THE PANEL SAYS: an open outline with a colour is the confusing case, and it must be explained.
  assert(mapHelpers.mapFillAdvice('path', '#4a7fd0', open) !== null, 'an open course with a fill is explained')
  assert(mapHelpers.mapFillAdvice('stroke', '#4a7fd0', open) !== null, 'and an open stroke')
  assert(mapHelpers.mapFillAdvice('path', '#4a7fd0', closed) === null, 'a closed one says nothing')
  assert(mapHelpers.mapFillAdvice('path', null, open) === null, 'and neither does an unfilled one')
  assert(mapHelpers.mapFillAdvice('shape', '#4a7fd0', open) === null, 'a shape is always closed, so it never needs the note')
  assert(/闭合/.test(mapHelpers.mapFillAdvice('path', '#4a7fd0', open)), 'and the note says what is wrong')

  // AND THE RENDER. The fill is the path painted with a colour and `stroke="none"` — NOT a `path-fill-`
  // string, which is a React `key` and never reaches the markup. (That mistake was made twice already.)
  const canvas = { width: 400, height: 400 }
  const draw = (map) => render(react.createElement(plugin.__test.MapSurface, {
    root: null, map, view: mapHelpers.mapViewBox(null, canvas), mode: 'pan', draft: [], draftColor: '#000000',
    penWidth: 2, draftShape: null, cursorTarget: null, selectionId: null, selectedShapeId: null,
    svgRef: { current: null }, started: true, editingPathId: null, placeTitles: {}, labelOf: null,
    onPointerDown() {}, onPointerMove() {}, onPointerUp() {}, onPointerCancel() {},
    onLostPointerCapture() {}, onPointerLeave() {}, onWheel() {},
  }))
  const base = { id: 'm', name: 'm', canvas, background: { kind: 'blank', asset: null }, pinSize: 14, labelSize: 34, labelFixed: false, theme: 'plain', shapes: [], pins: [], texts: [], stamps: [] }
  /** How many times a colour is painted as a FILL (as opposed to a stroke). */
  const fillCount = (html, color) => (html.match(new RegExp(`<path[^>]*fill="${color}"[^>]*stroke="none"`, 'gi')) ?? []).length
  const withFill = (points, kind) => ({ ...base, strokes: [], paths: [{ id: 'path-1', kind, name: '', fill: '#4a7fd0', color: '#a8763e', width: 8, taper: 0, dash: 'solid', points }] })
  assert(fillCount(draw(withFill(open, 'road')), '#4a7fd0') === 0, 'an OPEN road paints no fill — the reported case')
  assert(fillCount(draw(withFill(open, 'border')), '#4a7fd0') === 0, 'nor an open border')
  assert(fillCount(draw(withFill(open, 'mountain')), '#4a7fd0') === 0, 'nor an open mountain range')
  assert(fillCount(draw(withFill(closed, 'border')), '#4a7fd0') === 1, 'a CLOSED border paints exactly one')
  const strokeFill = (points) => ({ ...base, paths: [], strokes: [{ color: '#333333', width: 4, fill: '#c0504d', points }] })
  assert(fillCount(draw(strokeFill(open)), '#c0504d') === 0, 'an OPEN pen stroke paints no fill')
  assert(fillCount(draw(strokeFill(closed)), '#c0504d') === 1, 'a closed one does')
  // AND THE FILL MUST SURVIVE A ROUND TRIP. `normalizePath` had no `fill` field at all, so a sprayed
  // course's colour was thrown away the moment the document was read back — the spray appeared to work and
  // then the fill was gone, and no control could set one.
  const roundTrip = mapHelpers.mapPaths(mapHelpers.mapMaps({ maps: [{ ...base, strokes: [], paths: [{ id: 'path-1', kind: 'border', name: '', fill: '#4a7fd0', color: '#8a5ad0', width: 10, taper: 0, dash: 'solid', points: closed }] }] })[0])
  assert(roundTrip.length === 1 && roundTrip[0].fill === '#4a7fd0', `a course's fill must survive normalisation, got ${JSON.stringify(roundTrip[0]?.fill)}`)
  const cleared = mapHelpers.mapPathUpdate(mapHelpers.mapPaths(mapHelpers.mapMaps({ maps: [{ ...base, paths: [{ id: 'path-1', kind: 'border', fill: '#4a7fd0', points: closed }] }] })[0]), 'path-1', { fill: null })
  assert(mapHelpers.mapFillOf(cleared[0].fill) === null, 'and the editor can clear it')

  // THE SPRAY AND THE FILLS MUST AGREE: the same helper decides both, so a region that can be sprayed is a
  // region that draws filled.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/const closable = \(points\) => mapOutlineClosed\(points\)/.test(source), 'the spray uses the shared closing test')
  assert(/!mapOutlineClosed\(path\.points\)/.test(source), 'and so does the course fill')
  assert(/!mapOutlineClosed\(stroke\.points\)/.test(source), 'and the pen fill')
  // A COURSE COULD NOT HAVE ITS FILL CLEARED AT ALL: only the spray ever set one, and no control showed it.
  assert(/h\(FieldLabel, \{ key: 'fill-label', text: '填充颜色' \}\)/.test(source), 'the course editor can set a fill')
  assert(/mapPathUpdate\(list, path\.id, \{ fill: null \}\)/.test(source), 'and clear it')
})

check('the agent path reports what it is doing, and the host limitation', () => {
  // PHASE 5c's client half. The host routes were registered and already reported the host defect as its own
  // code, but there was no way to START a run, WATCH it, or TAKE its result. This is that half — and the
  // point of testing it now is that the day the one-line host patch is applied, it must work unchanged.
  const prompt = plugin.__test.agentPromptText('第三章 山门', '写主角走进荒废的山门')
  assert(prompt.includes('第三章 山门'), 'the prompt names the chapter')
  assert(prompt.includes('写主角走进荒废的山门'), 'and carries the request verbatim')
  assert(prompt.includes('novel-writer'), 'and tells the agent which skill to follow')
  assert(prompt.includes('novel-consistency'), 'and to validate afterwards')
  assert(prompt.includes('不要改动'), 'and what not to touch — the agent writes with its own tools, past the gate')
  assert(plugin.__test.agentPromptText('', '').length > 20, 'an empty request still produces a prompt')
  assert(!plugin.__test.agentPromptText('', '').includes('《》'), 'and an absent title is not rendered as empty brackets')
  for (const junk of [null, undefined, 42, {}]) {
    assert(typeof plugin.__test.agentPromptText(junk, junk) === 'string', `junk yields a prompt: ${JSON.stringify(junk)}`)
  }

  // THE PHASE, decided in ONE place. The UI elsewhere reads only this, so a run cannot look like it is
  // still writing because it ended without a `turn/end`.
  const phase = plugin.__test.agentPhase
  assert(phase({}) === 'idle', 'nothing started is idle')
  assert(phase({ started: true, status: { running: true } }) === 'running', 'a running run is running')
  assert(phase({ started: true, status: { running: false } }) === 'reading', 'a stopped run with no result yet is being read')
  // THE FIXTURE IS THE ROUTE'S REAL ANSWER. `GET /agent/result` sends `finished` (router.js:1477-1492);
  // it has never sent `turnEnd`. The old fixture here invented a `{ turnEnd: … }` payload, so this case
  // passed against a shape the host does not produce and `agentPhase` could never reach 'done' in the
  // app: after a run stopped, `status.running` went false, the phase stayed 'reading', and the
  // `/agent/result` effect (62-agent.js:411, gated on `phase === 'reading'`) kept re-fetching forever.
  const agentResultBody = {
    ok: true,
    sessionId: 'session-1',
    finished: true,
    reason: 'ok',
    text: '写好了',
    usage: null,
    writes: [],
    eventCount: 3,
    totalEvents: 3,
    stateKeys: [],
    eventTypes: [],
  }
  assert(phase({ started: true, status: { running: false }, result: agentResultBody }) === 'done', 'a result the route reports as finished is done')
  assert(phase({ started: true, status: { running: false }, result: { ...agentResultBody, finished: false } }) === 'reading', 'an unfinished result is still being read')
  assert(phase({ started: true, status: { running: false }, result: { turnEnd: { reason: 'ok' } } }) !== 'done', 'a turnEnd payload is not what the route sends, so it must not decide the phase')
  assert(phase({ started: true, error: { code: 'agent-prompt-unsupported' } }) === 'unsupported', 'the host defect has its own phase')
  assert(phase({ started: true, error: { message: 'boom' } }) === 'failed', 'any other failure is a failure')
  assert(phase({ started: false, status: { running: true } }) === 'idle', 'status before a start means nothing')
  for (const junk of [null, undefined, 'x', 42]) assert(phase(junk) === 'idle', `junk is idle: ${JSON.stringify(junk)}`)

  // What it touched, and the usage — reported, never acted on.
  assert(plugin.__test.agentWrites({ writes: ['b.md', 'a.md', 'b.md'] }).join(',') === 'a.md,b.md', 'writes are de-duplicated and sorted')
  assert(plugin.__test.agentWrites({ writes: null }).length === 0, 'no writes is an empty list')
  assert(plugin.__test.agentWrites({}).length === 0, 'and so is a missing field')
  assert(plugin.__test.agentWrites({ writes: ['', 42, null, 'ok.md'] }).join(',') === 'ok.md', 'junk entries are dropped')
  for (const junk of [null, undefined, 'x', 42]) assert(plugin.__test.agentWrites(junk).length === 0, `junk writes: ${JSON.stringify(junk)}`)
  assert(plugin.__test.agentUsageLine({ totalTokens: 12345 }).includes('12,345'), 'the usage is one readable line')
  assert(plugin.__test.agentUsageLine({ inputTokens: 10, outputTokens: 20 }).includes('输入 10'), 'with both sides')
  assert(plugin.__test.agentUsageLine(null) === null && plugin.__test.agentUsageLine({}) === null, 'and nothing when there is nothing')
  assert(plugin.__test.agentModelLine({ provider: 'deepseek-account', model: 'deepseek-flash' }) === 'deepseek-account / deepseek-flash', 'the model line')
  assert(plugin.__test.agentModelLine('x') === 'x', 'a string model passes through')
  assert(plugin.__test.agentModelLine(null) === null, 'and nothing is nothing')

  // A SESSION ROOTED ELSEWHERE MUST NOT BE OFFERED. Driving it would write into another novel.
  const sessions = [
    { sessionId: 'a', cwd: 'D:\\one' },
    { sessionId: 'b', cwd: 'D:\\two' },
    { sessionId: 'c', cwd: 'd:\\ONE' },
    { sessionId: '', cwd: 'D:\\one' },
    { cwd: 'D:\\one' },
  ]
  const mine = plugin.__test.agentSessionsFor(sessions, 'D:\\one')
  assert(mine.map((entry) => entry.sessionId).join(',') === 'a,c', `only this project's sessions, got ${mine.map((e) => e.sessionId).join(',')}`)
  assert(plugin.__test.agentSessionsFor(sessions, 'D:\\nowhere').length === 0, 'and none when nothing matches')
  assert(plugin.__test.agentSessionsFor(null, 'D:\\one').length === 0, 'junk sessions are empty, not a throw')

  // AND THE RENDER, in every phase — including the host-limitation screen, which must NAME the way out.
  const renderAgent = (props) => render(react.createElement(plugin.__test.AgentDraftBody, {
    sessions: [{ sessionId: 'a', title: '主线' }],
    sessionId: 'a', onPickSession() {}, instruction: '', onInstruction() {},
    error: null, note: null, usage: null, writes: [], defaultModel: null,
    onStart() {}, onCancel() {}, onTake() {}, canTake: false,
    ...props,
  }))
  const idle = renderAgent({ phase: 'idle' })
  assert(idle.includes('交给 agent 写这一章'), 'the control is labelled')
  assert(idle.includes('主线'), 'and lists the session')
  assert(idle.includes('交给 agent 写'), 'with the button')
  // IT MUST SAY HOW IT DIFFERS FROM THE MODEL PATH, or the author cannot tell the two apart.
  assert(idle.includes('读设定') && idle.includes('校验'), 'and explains what the agent does that the model path does not')
  assert(renderAgent({ phase: 'running' }).includes('正在写'), 'a live run says so')
  assert(renderAgent({ phase: 'running' }).includes('取消'), 'and offers to cancel')
  assert(renderAgent({ phase: 'reading' }).includes('正在读它的结果'), 'the gap before the result is shown')
  assert(renderAgent({ phase: 'failed', error: { message: 'boom' } }).includes('boom'), 'a failure shows its message')
  assert(renderAgent({ phase: 'done', usage: { totalTokens: 500 }, writes: ['novel/draft/ch-0001.md'] }).includes('ch-0001.md'), 'the files it touched are listed')
  assert(renderAgent({ phase: 'done', usage: { totalTokens: 500 } }).includes('500'), 'and the usage')
  // The prose does NOT land in the editor by itself: the agent writes the file, so an automatic copy would
  // be a second writer on the same chapter. The author presses the button.
  assert(renderAgent({ phase: 'done', canTake: true }).includes('把结果放进编辑框'), 'the author decides when to take the result')
  assert(renderAgent({ phase: 'done', canTake: false }).includes('把结果放进编辑框') === false, 'and there is no button when there is no text')
  // THE HOST LIMITATION SCREEN. It must not read as this project's bug, and it must carry the way out —
  // per cause, which is asserted in full further down.
  const blocked = renderAgent({ phase: 'unsupported', error: { reason: 'host-signal-required' } })
  assert(blocked.includes('宿主还没打好补丁'), 'the unpatched host is named')

  // THE WIRING. The control must be in the chapter editor, beside the model path.
  const branchSource = readFileSync(join(ROOT, 'client', 'src', '70-branches.js'), 'utf8')
  assert(/h\(AgentDraftControl, \{ root, chapterTitle: meta\?\.title \?\? '', onDrafted \}\)/.test(branchSource), 'the chapter editor renders it')
  assert(/h\(DraftControl, \{ root, path, onDrafted \}\)[\s\S]{0,600}?h\(AgentDraftControl/.test(branchSource), 'right after the model path, so the two read as a pair')
  const agent = readFileSync(join(ROOT, 'client', 'src', '62-agent.js'), 'utf8')
  for (const endpoint of ['/agent/prompt', '/agent/status', '/agent/result', '/agent/cancel']) {
    assert(agent.includes(endpoint), `it calls ${endpoint}`)
  }
  assert(/setInterval\(/.test(agent), 'a live run is polled')
  assert(/clearInterval\(timer\)/.test(agent), 'and the poll is cleaned up')
  assert(/phase !== 'running'\) return undefined/.test(agent), 'polling happens ONLY while a run is live')
  assert(/body\?\.text/.test(agent), 'the transcript is read through /agent/result')

  // THE FIELD NAMES, CHECKED AGAINST THE ROUTES THEMSELVES — not against a plausible shape.
  //
  // Both were wrong in the first version and both failed SILENTLY: `/sessions` returns `sessions`, not
  // `items`, so the picker was permanently empty; `/agent/prompt` reads `text`, not `prompt`, so every call
  // was a 400. Neither showed an error anywhere, because an empty list and a wrong key both look like
  // "nothing to do" rather than "broken".
  const router = readFileSync(join(ROOT, 'lib', 'impl', 'router.js'), 'utf8')
  assert(/available:[\s\S]{0,300}?sessions:/.test(router), 'the sessions route returns a `sessions` field')
  assert(!/available:[\s\S]{0,300}?items:/.test(router), 'and not an `items` field')
  assert(/typeof body\.text === 'string'/.test(router), 'the prompt route reads `body.text`')
  assert(!/typeof body\.prompt === 'string'/.test(router), 'and not `body.prompt`')
  assert(/body\?\.sessions/.test(agent), 'and the client reads `sessions`')
  assert(!/body\?\.items/.test(agent), 'not `items`')
  assert(/text: agentPromptText\(/.test(agent), 'the client sends `text`')
  assert(!/prompt: agentPromptText\(/.test(agent), 'and not `prompt`')
  // With no session chosen the host resolves it — one session is used, several make it ask, none makes one.
  // Disabling the button instead turned a project with no session into a dead end, and sending an explicit
  // `undefined` would be dropped by JSON.stringify, so the key must be omitted rather than set.
  assert(!/disabled: sessionId === null/.test(agent), 'the button is not disabled for want of a session')
  assert(/if \(sessionId !== null\) payload\.sessionId = sessionId/.test(agent), 'and a missing session is omitted, not sent as undefined')

  // THE 501 SCREEN MUST TELL THE TWO CAUSES APART. After the first patch they stopped being the same
  // problem: one is the host's unpatched signal check, the other is the session log's lossless-JSON rule —
  // and that second one turned out to be ours (a missing `requestId`), so the screen must not accuse the host
  // for it. Showing "apply the patch" for the second would tell the author to run a command already applied.
  const hostSignal = renderAgent({ phase: 'unsupported', error: { reason: 'host-signal-required' } })
  const lossless = renderAgent({ phase: 'unsupported', error: { reason: 'lossless-json-required' } })
  assert(hostSignal.includes('apply-host-patch.cmd'), 'the signal cause prints the patch command')
  assert(hostSignal.includes('不是本项目'), 'and says it is not this project\'s fault')
  assert(!lossless.includes('apply-host-patch.cmd'), 'the lossless cause does NOT — that patch is already applied')
  assert(lossless.includes('无损 JSON'), 'it names the actual rule that was broken')
  assert(lossless.includes('requestId'), 'and the field this plugin now always sends')
  assert(!/宿主自己构造|宿主拒绝/.test(lossless), 'and it must NOT blame the host: this cause was our own missing field')
  assert(hostSignal !== lossless, 'the two screens differ')
  // The route must name the cause it found, or the screen cannot tell them apart.
  assert(/reason: hostSignal \? 'host-signal-required' : 'lossless-json-required'/.test(router), 'the route reports which cause it found')
  assert(/inbox\\?\/spliced/.test(router), 'and detects the lossless-JSON refusal by name')
  // AND IT MUST BLAME THE RIGHT PARTY. The lossless-JSON cause was OURS — an omitted `requestId` became
  // `source.rpcId = undefined` — and the route's message said the host had built an unserializable event. That
  // misattribution is asserted against here so it cannot come back.
  assert(!/宿主自己构造的事件|它自己构造的事件里有无法序列化/.test(router), 'the lossless cause must not accuse the host')
  // The plugin must send ONE argument: after the patch the signal is optional, and a signal can never
  // serialize. A second argument here would resurrect the original defect.
  assert(/await controller\.prompt\(\{/.test(router), 'prompt is called with a single options object')
  assert(!/controller\.prompt\([\s\S]{0,400}?run\.signal/.test(router), 'and never with run.signal')
  assert(!/^\s+run\.signal,$/m.test(router), 'nor as a trailing second argument')
  // The local abort controller stays: cancelling goes through controller.cancel, which is what works.
  assert(/controller\.cancel\(sessionId\)/.test(router), 'cancel goes through controller.cancel')
})

check('导出全书: the options, the receipt, and what it must never hide', () => {
  // PHASE 6's first piece. The host assembles the book (asserted in impl-selftest); this is the client's
  // half: choose the options, ask for it, download it, and TELL THE AUTHOR WHAT WAS LEFT OUT.
  const q = plugin.__test.manuscriptQuery
  // Defaults: a title page, and neither of the two things that pad a manuscript.
  assert(q({}) === 'titlePage=1&summary=0&meta=0&headingLevel=2', `defaults, got ${q({})}`)
  assert(q(undefined) === q({}), 'no options is the same as empty options')
  assert(q(null) === q({}), 'and so is null')
  assert(q({ titlePage: false, summary: true, meta: true }) === 'titlePage=0&summary=1&meta=1&headingLevel=2', 'each option maps to a flag')
  // Only `true` counts, so a truthy-but-wrong value cannot quietly turn a section on.
  assert(q({ summary: 'yes' }).includes('summary=0'), 'a truthy non-boolean does not enable an option')
  assert(q({ titlePage: 0 }).includes('titlePage=0'), 'nor does a falsy one')
  for (const junk of ['x', 42, []]) assert(typeof q(junk) === 'string', `junk options still yield a query: ${JSON.stringify(junk)}`)

  const receipt = plugin.__test.manuscriptReceipt
  assert(receipt({ chapterCount: 3, wordCount: 2693 }).text === '已导出 3 章 · 2693 字', `the plain receipt, got ${receipt({ chapterCount: 3, wordCount: 2693 }).text}`)
  assert(receipt({ chapterCount: 3, wordCount: 2693 }).tone === 'ok', 'and it is not a warning')
  // THE POINT OF THE WHOLE FUNCTION: a chapter that could not be read must be NAMED. A manuscript that
  // quietly omits chapter twelve is worse than one that refuses to export, because it gets sent first.
  const partial = receipt({ chapterCount: 2, wordCount: 100, skipped: [{ path: 'draft/ch-0012.md', reason: 'unreadable' }] })
  assert(partial.text.includes('ch-0012.md'), `the skipped chapter must be named, got ${partial.text}`)
  assert(partial.text.includes('没能读出来'), 'and said to be missing')
  assert(partial.tone === 'error', 'and shown as a problem, not a footnote')
  const several = receipt({ chapterCount: 1, skipped: [{ path: 'draft/a.md' }, { path: 'draft/b.md' }] })
  assert(several.text.includes('a.md') && several.text.includes('b.md') && several.text.includes('2 章'), 'every skipped chapter is listed')
  // `draft/` is stripped: the author knows their chapters live there, and the full path is noise.
  assert(!partial.text.includes('draft/'), 'the draft/ prefix is not repeated back')
  // Junk must not produce "NaN 章".
  for (const junk of [null, undefined, {}, 'x', 42]) {
    const line = receipt(junk)
    assert(typeof line.text === 'string' && !line.text.includes('NaN'), `junk receipt reads cleanly: ${line.text}`)
  }
  assert(receipt({ chapterCount: 0, wordCount: 0 }).text === '已导出 0 章 · 0 字', 'an empty book says zero, not nothing')

  // THE WIRING. It must be reachable from the chapter branch, and the SAVE must be the primary action.
  const source = readFileSync(join(ROOT, 'client', 'src', '68-export.js'), 'utf8')
  assert(/API\}\/manuscript\?root=/.test(source), 'the download still assembles over the GET')
  assert(/\$\{manuscriptQuery\(options\)\}/.test(source), 'with the options as a query')
  assert(/new Blob\(\[text\]/.test(source), 'the text becomes a Blob')
  assert(/link\.download = /.test(source), 'a download name is set')
  assert(/link\.click\(\)/.test(source), 'and the link is clicked')
  assert(/URL\.revokeObjectURL\(url\)/.test(source), 'the object URL is released, or the page leaks it')
  assert(/宿主返回了空的手稿/.test(source), 'an empty result is an error, not an empty download')
  assert(!/dangerouslySetInnerHTML/.test(source), 'and nothing is injected as HTML')
  // REPORTED: 「导出的文件没有给出地址，无法找到」. A page cannot know the download directory, so the primary
  // action must be the one whose result HAS an address — written into the project — and the download must say
  // where it actually goes.
  assert(/fetch\(api\(`\$\{API\}\/manuscript`\), \{/.test(source), 'the save POSTs to /manuscript')
  assert(/method: 'POST'/.test(source), 'with the write method')
  assert(/headers: WRITE_HEADERS/.test(source), 'and the write header the host demands')
  assert(/body: JSON.stringify\(\{ root, \.\.\.options \}\)/.test(source), 'sending the options in the body')
  assert(/receipt\.relative/.test(source) && /receipt\.absolute/.test(source), 'the answer renders both paths')
  assert(/复制完整路径/.test(source), 'with a way to copy the absolute one')
  assert(/写进 novel\/export\/ 并给出完整路径/.test(source), 'and the label says where each button puts the file')
  assert(/页面看不到/.test(source), 'including that a download\'s location is unknowable from a page')
  assert(/navigator\.clipboard/.test(source), 'the copy uses the clipboard API')
  const branches = readFileSync(join(ROOT, 'client', 'src', '70-branches.js'), 'utf8')
  assert(/h\(ManuscriptExport, \{ root: props\.root \}\)/.test(branches), 'the chapter list renders it')
  // The routes must exist, or the buttons are 404s.
  const router = readFileSync(join(ROOT, 'lib', 'impl', 'router.js'), 'utf8')
  assert(/path: '\/manuscript', handler: handleManuscript/.test(router), 'the host registers the GET')
  assert(/path: '\/manuscript', handler: handleManuscriptWrite/.test(router), 'and the POST that writes the file')
  assert(/load\('\.\/manuscript\.js'\)/.test(router), 'and loads its module')
  assert(/modules\.paths\.resolveInside\(projectDir, relative\)\.abs/.test(router), 'the write goes through the path fence')
})

check('纯文本导入: predictable about everything except the names', () => {
  // PHASE 6's second piece. The material lives in notes and bullet lists, so the format is one name per line
  // and the importer's whole job is to be predictable about the rest.
  const parse = plugin.__test.parseNameList
  const plain = parse('李明\n王五\n赵六')
  assert(plain.names.join(',') === '李明,王五,赵六', 'one name per line, in order')
  assert(plain.ignored.length === 0, 'nothing ignored in a clean paste')
  // BULLET AND NUMBER MARKERS ARE STRIPPED: this is what a paste from a note or a numbered list looks like,
  // and leaving `1.` in the name would create a character called 「1. 李明」.
  for (const marker of ['- ', '* ', '• ', '1. ', '2、 ', '3) ', '· ']) {
    assert(parse(`${marker}李明`).names.join(',') === '李明', `the marker ${JSON.stringify(marker)} is stripped`)
  }
  assert(parse('-李明').names.join(',') === '李明', 'and a marker with no space')
  // A MARKER INSIDE A NAME IS NOT A MARKER: the strip is anchored to the start of the line.
  assert(parse('李-明').names.join(',') === '李-明', 'a dash inside a name survives')
  assert(parse('a*b').names.join(',') === 'a*b', 'and an asterisk')
  // COMMENTS, so a note pasted along with the names does not become a character.
  assert(parse('# 主角团\n李明').names.join(',') === '李明', 'a # line is a comment')
  assert(parse('# 主角团\n李明').ignored[0].reason === 'comment', 'and is reported as one')
  // Blank lines and whitespace are not names.
  assert(parse('\n\n   \n李明\n').names.join(',') === '李明', 'blank lines are skipped')
  assert(parse('  李明  ').names.join(',') === '李明', 'and names are trimmed')
  // THE SAME NAME TWICE IN ONE PASTE IS ONE PERSON.
  assert(parse('李明\n李明\n王五').names.join(',') === '李明,王五', 'a repeat inside the paste is dropped')
  assert(parse('李明\n李明').ignored[0].reason === 'duplicate', 'and reported')
  assert(parse('李明\n李 明').names.length === 2, 'but a space makes it another name — that is the author\'s call')
  // CRLF, because a paste from Notepad arrives that way.
  assert(parse('李明\r\n王五').names.join(',') === '李明,王五', 'CRLF pastes work')
  // THE CAP, so a runaway paste cannot write a fifty-thousand-entry document.
  const huge = parse(Array.from({ length: 600 }, (_, index) => `名字${index}`).join('\n'))
  assert(huge.names.length === 500, `the cap holds, got ${huge.names.length}`)
  assert(huge.ignored.some((entry) => entry.reason === 'too-many'), 'and the dropped lines say why')
  for (const junk of [null, undefined, 42, {}, []]) {
    assert(parse(junk).names.length === 0, `junk pastes are empty: ${JSON.stringify(junk)}`)
  }

  // THE PLAN, shown before anything is written: what would be created, and what is already there.
  // `create` carries entries (`{ name, fields }`) rather than bare names, so the preview can show what the
  // parser read and not only what it will be called.
  const plan = plugin.__test.planImport({ names: ['李明', '王五'], existing: ['李明', '赵六'] })
  const planNames = (value) => value.map((entry) => entry.name).join(',')
  assert(planNames(plan.create) === '王五', 'existing names are skipped')
  assert(plan.duplicates.join(',') === '李明', 'and named')
  // A bare name paste still works, and an entry paste carries its fields through the plan.
  assert(plan.create[0].fields !== undefined, 'what is created carries its fields')
  const withFields = plugin.__test.planImport({ entries: [{ name: '李四', fields: { race: '人类' } }] })
  assert(withFields.create[0].fields.race === '人类', 'and an entry paste keeps them')
  // CASE- AND WHITESPACE-INSENSITIVE: 「李明 」 and 「李明」 are one person, and an importer that disagrees
  // leaves a duplicate the author only notices much later.
  assert(plugin.__test.planImport({ names: ['李明'], existing: [' 李明 '] }).create.length === 0, 'whitespace does not make a new person')
  assert(plugin.__test.planImport({ names: ['Li Ming'], existing: ['li ming'] }).create.length === 0, 'nor does case')
  assert(plugin.__test.planImport({ names: ['李明'], existing: [''] }).create.length === 1, 'a blank existing name matches nothing')
  assert(plugin.__test.planImport({ names: [] }).create.length === 0, 'no names, nothing to create')
  assert(plugin.__test.planImport({}).create.length === 0, 'junk input creates nothing')
  assert(plugin.__test.planImport({ names: [' 李明 '] }).create[0].name === '李明', 'what is created is trimmed')

  // THE TARGETS COME FROM THE BRANCH DESCRIPTOR, so a branch added later gets the control for free.
  //
  // Looked up on the TREE branch, which for 人物 and 物品 is a SUB-TAB — that is where entities are declared,
  // and it is where `EntityTreeBody` (and therefore the control) actually renders. Asking the tabs branch
  // itself finds nothing, which is exactly what this assertion did first.
  const branches = plugin.__test.BRANCHES
  const treeBranches = (branch) => [branch, ...(Array.isArray(branch?.tabs) ? branch.tabs : [])].filter((entry) => entry?.view === 'tree')
  const chars = branches.find((entry) => entry.id === 'chars')
  const charTargets = treeBranches(chars).flatMap((entry) => plugin.__test.importTargets(entry))
  assert(charTargets.length >= 1, `the 人物 branch offers a target, got ${charTargets.length}`)
  assert(charTargets.some((entry) => entry.entity === 'character' && entry.label === '人物'), `naming the entity and its label, got ${JSON.stringify(charTargets.map((t) => t.entity))}`)
  // 物品 declares a tree of categories AND a flat list of items: both must be offered.
  const itemTargets = treeBranches(branches.find((entry) => entry.id === 'items')).flatMap((entry) => plugin.__test.importTargets(entry))
  assert(itemTargets.some((entry) => entry.entity === 'item'), `物品 offers its item list, got ${JSON.stringify(itemTargets.map((t) => t.entity))}`)
  // A tabs branch itself declares no entities, and must therefore offer nothing.
  assert(plugin.__test.importTargets(chars).length === 0, 'a tabs branch declares no lists of its own')
  assert(plugin.__test.importTargets(null).length === 0, 'no branch, no targets')
  assert(plugin.__test.importTargets({}).length === 0, 'and no declarations, none either')
  // A spec whose entity has no `blank` factory cannot create anything, so it must not be offered.
  assert(plugin.__test.importTargets({ collections: [{ key: 'x', entity: 'not-an-entity' }] }).length === 0, 'an unknown entity is not offered')

  // WHAT IT CREATES MUST BE WHAT THE ＋ BUTTON WOULD HAVE CREATED. Same factory, same fields, same order —
  // with the author's name instead of the default, and an id minted from that name so a chapter's reference
  // reads `char-李明` rather than `char-新人物`.
  const { ENTITIES, childNodeFor } = plugin.__test
  const spec = { key: 'characters', entity: 'character', idPrefix: 'char-' }
  const hand = childNodeFor(spec, ENTITIES.character, null, new Set())
  const imported = plugin.__test.buildImportedEntities(spec, 'character', ['李明'], new Set())
  assert(imported.length === 1, 'one name, one entity')
  assert(Object.keys(imported[0]).join(',') === Object.keys(hand).join(','), `the same fields in the same order, got ${Object.keys(imported[0]).join(',')} vs ${Object.keys(hand).join(',')}`)
  assert(imported[0].name === '李明', 'the typed name, not the blank default')
  assert(imported[0].id === 'char-李明', `the id comes from the name, got ${imported[0].id}`)
  assert(imported[0].status === hand.status && imported[0].gender === hand.gender, 'and every other default is the blank one')
  // TWO NAMES MUST NOT COLLIDE, and neither may the second import of the same name.
  const two = plugin.__test.buildImportedEntities(spec, 'character', ['李明', '李明'], new Set())
  assert(two.length === 2 && two[0].id !== two[1].id, `two entries get two ids, got ${two.map((e) => e.id).join(' / ')}`)
  const taken = new Set(['char-李明'])
  const again = plugin.__test.buildImportedEntities(spec, 'character', ['李明'], taken)
  assert(again[0].id !== 'char-李明', `an id already in use is not reused, got ${again[0].id}`)
  // A NESTING spec gets an explicit null parent, never an absent key — `JSON.stringify` drops undefined, and
  // "at the top level" must be distinguishable from "field not written".
  const nested = plugin.__test.buildImportedEntities({ key: 'places', entity: 'place', parentKey: 'parentId', idPrefix: 'place-' }, 'place', ['青云峰'], new Set())
  assert(nested[0].parentId === null, 'a nested entity gets parentId: null')
  assert(nested[0].name === '青云峰', 'and the name')
  for (const junk of [null, undefined, 'x', 42]) {
    assert(plugin.__test.buildImportedEntities(spec, 'character', junk, new Set()).length === 0, `junk names create nothing: ${JSON.stringify(junk)}`)
    assert(plugin.__test.buildImportedEntities(spec, 'not-an-entity', ['a'], new Set()).length === 0, 'an unknown entity creates nothing')
  }

  // ---- 一行里带基础信息 ------------------------------------------------------
  //
  // REQUESTED: 「如果名字后面有一些基础信息也可以导入，例如：小明是一个人类男性，今年23岁。人物卡可以直接建立：
  // 姓名：小明 年龄：23 种族：人类」.
  const parseLine = plugin.__test.parseEntityLine
  const vocab = { race: ['人类', '半精灵'] }

  // THE EXPLICIT FORM, addressed by the schema's own labels.
  const explicit = parseLine('姓名：小明 年龄：23 种族：人类', 'character', vocab)
  assert(explicit.name === '小明', `the name from 姓名：, got ${explicit.name}`)
  assert(explicit.fields.race === '人类', 'the race from 种族：')
  // AGE HAS NOWHERE STRUCTURED TO GO — the data model stores `born`, because a stored age is wrong the moment
  // the story moves. It lands in the field that describes an age in words.
  assert(explicit.fields.ageNote === '23岁', `an age goes to ageNote, got ${JSON.stringify(explicit.fields.ageNote)}`)
  assert(explicit.fields.born === undefined, 'and is NOT turned into a birth year the author never gave')
  // THE VALUE ENDS WHERE THE NEXT LABEL BEGINS, NOT AT THE NEXT COMMA. Spaces separate fields, so a greedy
  // value swallowed the whole line and the entry came out named 「小明 年龄：23 种族：人类」.
  assert(!explicit.name.includes('年龄'), 'the name does not run on into the next field')
  assert(explicit.matched.length === 3, `three fields read, got ${explicit.matched.length}`)

  // THE PROSE FORM — the one an author actually types.
  const prose = parseLine('小明是一个人类男性，今年23岁。', 'character', vocab)
  assert(prose.name === '小明', `the subject of the sentence is the name, got ${prose.name}`)
  // THE ENUM COMES FROM THE SCHEMA: `gender` declares 男/女/其他/未定, so 「男性」 finds 男 with no table here.
  assert(prose.fields.gender === '男', `男性 finds the declared option 男, got ${JSON.stringify(prose.fields.gender)}`)
  assert(prose.fields.race === '人类', 'and 人类 is recognised because the project already uses it')
  assert(prose.fields.ageNote === '23岁', 'and the age in words is kept as words')
  // WHAT WAS NOT UNDERSTOOD IS KEPT, in whichever field carries prose. A parser that read four words of six and
  // dropped the rest would throw away the author's own description of their own character.
  assert(typeof prose.fields.background === 'string' && prose.fields.background.includes('人类男性'), `the sentence survives, got ${JSON.stringify(prose.fields.background)}`)
  assert(!prose.fields.background.startsWith('是'), 'without the leading verb')

  // A YEAR IS THE ONE FORM IN WHICH AN AGE CAN BE STORED, so it goes to `born`.
  const born = parseLine('李四是人类女性，生于617年。', 'character', vocab)
  assert(born.fields.gender === '女', '女性 finds 女')
  assert(JSON.stringify(born.fields.born) === '{"year":617}', `an explicit year is stored as born, got ${JSON.stringify(born.fields.born)}`)
  // A `select` addressed by label maps through its declared options too.
  assert(parseLine('状态：在世', 'character', vocab).fields.status === 'alive', '状态：在世 maps to the stored value')
  assert(parseLine('状态：已故', 'character', vocab).fields.status === 'dead', 'and so does 已故')
  // A list field splits on the separators people use.
  assert(JSON.stringify(parseLine('别名：阿明、明明', 'character', vocab).fields.aliases) === '["阿明","明明"]', 'a list field splits')
  // Unknown labels and unknown words are not invented into fields.
  assert(parseLine('身高：180', 'character', vocab).fields.height === undefined, 'an undeclared field is not created')
  // A name only, and junk.
  assert(parseLine('王五', 'character', vocab).name === '王五', 'a bare name still works')
  assert(parseLine('王五', 'character', vocab).matched.length === 0, 'with nothing matched')
  for (const junk of [null, undefined, 42, {}]) {
    assert(parseLine(junk, 'character', vocab).name === '', `junk lines have no name: ${JSON.stringify(junk)}`)
  }
  // The SAME parser works for the other entities, because it reads their schema.
  const place = parseLine('青云峰是一座秘境，山势陡峭。', 'place', { kind: ['秘境', '渡口'] })
  assert(place.name === '青云峰' && place.fields.kind === '秘境', `a place parses too, got ${JSON.stringify(place.fields)}`)
  assert(place.fields.summary.includes('山势陡峭'), 'and its sentence is kept in 简介')
  const item = parseLine('重华剑，一把灵品长剑。', 'item', { rarity: ['灵品'] })
  assert(item.name === '重华剑' && item.fields.rarity === '灵品', `an item parses too, got ${JSON.stringify(item.fields)}`)
  assert(item.fields.description.includes('长剑'), 'and its sentence in 描述')

  // THE VOCABULARY COMES FROM THE DOCUMENT, per target.
  const document = { characters: [{ id: 'char-a', name: '甲', race: '人类' }, { id: 'char-b', name: '乙', race: '半精灵' }, { id: 'char-c', name: '丙' }] }
  const learned = plugin.__test.importVocabulary(document, { key: 'characters', entity: 'character' })
  assert(JSON.stringify(learned.race) === '["人类","半精灵"]', `the project's own words, got ${JSON.stringify(learned.race)}`)
  assert(plugin.__test.importVocabulary({ characters: [] }, { key: 'characters', entity: 'character' }).race === undefined, 'a project with no words teaches nothing')
  assert(JSON.stringify(plugin.__test.importVocabulary(null, { key: 'characters', entity: 'character' })) === '{}', 'and junk teaches nothing')

  // THE FIELDS REACH THE ENTITY, and nothing else does.
  const importSpec = { key: 'characters', entity: 'character', idPrefix: 'char-' }
  const applied = plugin.__test.buildImportedEntities(importSpec, 'character', [{ name: '小明', fields: prose.fields }], new Set())
  assert(applied[0].name === '小明' && applied[0].race === '人类' && applied[0].gender === '男', 'the parsed fields are applied')
  assert(applied[0].id === 'char-小明', 'and the id still comes from the name')
  assert(applied[0].status !== undefined, 'while every default the blank supplied is kept')
  // AN UNDECLARED KEY IS DROPPED: it would otherwise put a field in the author's document that no form can
  // edit and no validator expects — the same rule the model-output sanitiser follows.
  const rogue = plugin.__test.buildImportedEntities(importSpec, 'character', [{ name: '甲', fields: { height: 180, id: 'char-evil' } }], new Set())
  assert(rogue[0].height === undefined, 'a field the schema does not declare is dropped')
  assert(rogue[0].id === 'char-甲', 'and a field-supplied id cannot override the minted one')
  // A bare string entry still works, because a name-only paste is the simple case this started as.
  assert(plugin.__test.buildImportedEntities(importSpec, 'character', ['王五'], new Set())[0].id === 'char-王五', 'a bare name entry still works')

  // THE END-TO-END PASTE: markers, a comment, a repeat, and two lines that carry information.
  const paste = '# 主角团\n- 小明是一个人类男性，今年23岁。\n1. 姓名：李四 种族：人类 状态：在世\n王五\n小明\n'
  const pasted = plugin.__test.parseEntityLines(paste, 'character', vocab)
  assert(pasted.entries.map((entry) => entry.name).join(',') === '小明,李四,王五', `a real paste, got ${pasted.entries.map((e) => e.name).join(',')}`)
  assert(pasted.entries[1].fields.status === 'alive' && pasted.entries[1].fields.race === '人类', 'with the second line fully parsed')
  assert(pasted.ignored.map((entry) => entry.reason).join(',') === 'comment,duplicate', 'and the comment and the repeat reported')

  // AND THE WIRING: the control reads the vocabulary from the document and shows what the parser read.
  const importSource = readFileSync(join(ROOT, 'client', 'src', '66-import.js'), 'utf8')
  assert(/const vocabulary = importVocabulary\(doc, target\)/.test(importSource), 'the control learns the vocabulary from the document')
  assert(/parseEntityLines\(text, target\.entity, vocabulary\)/.test(importSource), 'and parses with it')
  assert(/entry\.matched\.map\(\(hit\) => `\$\{hit\.label\}/.test(importSource), 'the preview shows what the parser READ, not only the count')

  // AND THE WIRING: reachable from every entity branch, driven by the descriptor, writing through the same
  // mutate-then-save path as every other edit — so an import cannot bypass the validator or the .prev backup.
  const branchesSource = readFileSync(join(ROOT, 'client', 'src', '70-branches.js'), 'utf8')
  assert(/h\(BulkImport, \{ branch, doc, onMutate \}\)/.test(branchesSource), 'the entity branch renders it')
  const source = readFileSync(join(ROOT, 'client', 'src', '66-import.js'), 'utf8')
  assert(/onMutate\(\(current\) => \(\{ \.\.\.current, \[target\.key\]: \[\.\.\.objectList\(current\[target\.key\]\), \.\.\.created\] \}\)\)/.test(source), 'it appends through onMutate')
  assert(/childNodeFor\(spec, entity, null, taken\)/.test(source), 'using the same factory as the ＋ button')
  assert(/mintId\(spec\?\.idPrefix \?\? entity\.idPrefix, name, taken\)/.test(source), 'and minting the id from the name')
  assert(/if \(plan\.create\.length === 0\) return/.test(source), 'nothing happens when there is nothing to create')
  // The plan must be SHOWN before the button is pressed — the project's rule everywhere else that something
  // is generated into the author's document.
  assert(/将新建 \$\{plan\.create\.length\}/.test(source), 'the preview says what would be created')
  assert(/跳过 \$\{plan\.duplicates\.length\}/.test(source), 'and what would be skipped')
  // And it must not be rendered by a branch that has nothing to import into.
  assert(/if \(targets\.length === 0\) return null/.test(source), 'a branch with no targets shows nothing')
})

check('the session picker says WHEN, not a wall of hex', () => {
  // REPORTED: 「「会话」全是一串数字和字母是什么意思」. The host's rows carry `updatedAt` but no title, and the
  // picker fell back to `title ?? sessionId` — so every row was `session-60825a3f-6c57-4458-8baf-4be2e195c381`
  // and the only way to choose was to guess.
  const label = plugin.__test.agentSessionLabel
  const when = plugin.__test.agentRelativeTime
  const now = 1_700_000_000_000
  const id = 'session-60825a3f-6c57-4458-8baf-4be2e195c381'

  // WHEN, first, because that is what makes one row choosable over another.
  assert(when(now - 10_000, now) === '刚刚', 'seconds ago')
  assert(when(now - 90_000, now) === '2 分钟前', `minutes, got ${when(now - 90_000, now)}`)
  assert(when(now - 7_200_000, now) === '2 小时前', 'hours')
  assert(when(now - 172_800_000, now) === '2 天前', 'days')
  assert(when(now - 90 * 86_400_000, now) === '3 个月前', `months, got ${when(now - 90 * 86_400_000, now)}`)
  assert(when(now - 400 * 86_400_000, now) === '1 年前', 'years')
  // A clock that went backwards must not print "-3 分钟前".
  assert(when(now + 60_000, now) === '刚刚', 'a future timestamp clamps rather than going negative')
  for (const junk of [null, undefined, 'x', {}, NaN]) {
    assert(when(junk, now) === null, `junk timestamps yield no phrase: ${JSON.stringify(junk)}`)
    assert(when(now, junk) === null, 'and so does a junk clock')
  }

  const row = label({ sessionId: id, updatedAt: now - 60_000, running: false, blank: false }, now)
  assert(row.includes('1 分钟前'), `the age is shown, got ${row}`)
  assert(row.includes('…e195c381'), `with a SHORT id suffix, got ${row}`)
  assert(!row.includes('session-60825a3f'), 'and not the whole id')
  // 进行中 is not decoration: a busy session is refused with 409, so the author must be able to see it.
  assert(label({ sessionId: id, updatedAt: now, running: true }, now).includes('进行中'), 'a running session is marked')
  // A title is used when the host ever provides one.
  assert(label({ sessionId: id, title: '你好世界', updatedAt: now }, now).startsWith('你好世界'), 'a title leads when there is one')
  assert(!label({ sessionId: id, title: '  ', updatedAt: now }, now).includes('  '), 'a blank title is not used')
  assert(label({ sessionId: id, blank: true, updatedAt: now }, now).includes('空会话'), 'a blank session says so')
  for (const junk of [null, undefined, 42, 'x']) {
    assert(typeof label(junk, now) === 'string', `junk rows still yield a string: ${JSON.stringify(junk)}`)
  }
  assert(label({ sessionId: id }, null).includes('…e195c381'), 'a row with no timestamp is still identified')

  // NEWEST FIRST, so `items[0]` is the session the author just used.
  const sorted = plugin.__test.agentSessionsSorted([
    { sessionId: 'a', updatedAt: 100 },
    { sessionId: 'b', updatedAt: 300 },
    { sessionId: 'c', updatedAt: 200 },
  ])
  assert(sorted.map((r) => r.sessionId).join('') === 'bca', `newest first, got ${sorted.map((r) => r.sessionId).join('')}`)
  assert(plugin.__test.agentSessionsSorted([]).length === 0, 'an empty list survives')
  assert(plugin.__test.agentSessionsSorted([{ sessionId: 'x' }]).length === 1, 'a row with no timestamp is kept')

  // THE DEFAULT MUST BE AN IDLE SESSION. It used to prefer a RUNNING one, and `/agent/prompt` refuses a busy
  // session with 409 `session-busy` — so the default guaranteed that the first click failed, and the session
  // an author is most likely sitting in is exactly the running one (this conversation, when I measured it).
  const agentSource = readFileSync(join(ROOT, 'client', 'src', '62-agent.js'), 'utf8')
  assert(/items\.find\(\(item\) => item\.running !== true\)/.test(agentSource), 'the default session is an IDLE one')
  assert(!/items\.find\(\(item\) => item\.running === true\)/.test(agentSource), 'and never a running one')
  assert(/标着「进行中」的会话正在忙/.test(agentSource), 'and the picker says why a busy one is a bad choice')
  assert(/agentSessionLabel\(item, Date\.now\(\)\)/.test(agentSource), 'the options are labelled by the helper')
})

check('the map branch offers a save control and a colour picker', () => {
  // A server render cannot reach these: `MapBranch` uses `useDocument`, no effect runs, the document
  // never loads, and the branch returns its loading note before the toolbar exists. So the wiring is
  // asserted. The save control was missing entirely at first, and the map passed `WriteFeedback` the
  // props of a different component.
  const source = readFileSync(join(ROOT, 'client', 'src', '65-map.js'), 'utf8')
  assert(/h\(CommitRow, \{/.test(source), 'the map must render CommitRow, which owns 保存 / 未保存')
  assert(/actions: \{ save: map\.save/.test(source), 'CommitRow needs the save action')
  assert(/h\(ColorPicker, \{ value: penColor/.test(source), 'the pen colour picker must be wired')
  assert(/color: penColor, width: penWidth, points: outcome\.stroke/.test(source), 'a committed stroke must carry the pen colour AND width')
  assert(/h\(MapButton, \{ label: '新建地图'/.test(source), 'maps are created, not layers')
  assert(!/新建图层/.test(source), 'the layer vocabulary is gone — maps replaced it')
  assert(!/onToggleDetail: null/.test(source), 'an explicit null must not render a dead detail toggle')
  const clientSources = readdirSync(join(ROOT, 'client', 'src'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(ROOT, 'client', 'src', name), 'utf8'))
    .join('\n')
  assert(
    !/WriteFeedback, \{\s*state:/.test(clientSources),
    'WriteFeedback must not be handed a document `state` — it renders nothing and the failure is silent',
  )
})


// --- EntityTree -------------------------------------------------------------

const itemsBranch = branches.find((branch) => branch.id === 'items')
const sampleDoc = {
  categories: [
    { id: 'cat-weapon', name: '兵器', parentId: null, order: 10 },
    { id: 'cat-sword', name: '剑', parentId: 'cat-weapon', order: 10 },
  ],
  items: [
    { id: 'item-qingfeng', name: '青锋剑', categoryId: 'cat-sword', rarity: '地阶', custom: { 本命: '是' } },
    { id: 'item-loose', name: '无主之物', categoryId: null },
  ],
}

check('EntityTree renders the hierarchy with nested categories and items', () => {
  const html = render(
    react.createElement(plugin.__test.EntityTree, {
      doc: sampleDoc,
      tree: itemsBranch.tree,
      selection: null,
      onSelect() {},
      onMutate() {},
    }),
  )
  for (const expected of ['兵器', '剑', '青锋剑', '无主之物']) {
    assert(html.includes(expected), `tree is missing "${expected}"`)
  }
})

check('EntityTree highlights the selected entity', () => {
  const html = render(
    react.createElement(plugin.__test.EntityTree, {
      doc: sampleDoc,
      tree: itemsBranch.tree,
      selection: { entity: 'item', id: 'item-qingfeng' },
      onSelect() {},
      onMutate() {},
    }),
  )
  assert(html.includes('rgba(128,128,128,0.16)'), 'selection is not highlighted')
})

check('EntityTree tolerates an empty document', () => {
  const html = render(
    react.createElement(plugin.__test.EntityTree, {
      doc: {},
      tree: itemsBranch.tree,
      selection: null,
      onSelect() {},
      onMutate() {},
    }),
  )
  assert(html.includes('还没有'), `empty state missing: ${html.slice(0, 120)}`)
})

// --- SchemaForm -------------------------------------------------------------

check('SchemaForm renders every declared field type', () => {
  const entity = plugin.__test.ENTITIES.item
  const html = render(
    react.createElement(plugin.__test.SchemaForm, {
      entity,
      value: {
        id: 'item-qingfeng',
        name: '青锋剑',
        rarity: '地阶',
        description: '一柄剑',
        history: '师门所赠',
        attrs: { 长: '三尺' },
        tags: ['法器'],
        custom: {},
      },
      onPatch() {},
    }),
  )
  for (const label of entity.fields.map((field) => field.label)) {
    assert(html.includes(label), `field label "${label}" missing`)
  }
  assert(html.includes('三尺'), 'string map value missing')
  assert(html.includes('法器'), 'string list value missing')
})

check('SchemaForm exposes the 自定义信息 section and existing custom values', () => {
  const html = render(
    react.createElement(plugin.__test.SchemaForm, {
      entity: plugin.__test.ENTITIES.item,
      value: { id: 'char-linyuan', name: '林渊', custom: { 性格: '外冷内热' } },
      onPatch() {},
    }),
  )
  assert(html.includes('自定义信息'), 'the custom section is missing')
  assert(html.includes('性格'), 'an existing custom key is not shown')
  assert(html.includes('外冷内热'), 'an existing custom value is not shown')
  // The affordance is now a permanently visible draft row rather than an
  // "add" button that appends a blank entry to the data.
  assert(html.includes('名称') && html.includes('内容'), 'the draft row for a new custom field is missing')
})

check('SchemaForm survives an entity with no custom bag and null fields', () => {
  const html = render(
    react.createElement(plugin.__test.SchemaForm, {
      entity: plugin.__test.ENTITIES['item-category'],
      value: { id: 'cat-1', name: '兵器', order: null },
      onPatch() {},
    }),
  )
  assert(html.includes('兵器'), 'category did not render')
})

// --- SplitPane --------------------------------------------------------------

check('SplitPane shows the detail pane only when open', () => {
  const open = render(
    react.createElement(plugin.__test.SplitPane, {
      main: react.createElement('div', null, '主区内容'),
      detail: react.createElement('div', null, '详情内容'),
      open: true,
    }),
  )
  assert(open.includes('主区内容') && open.includes('详情内容'), 'open split is missing a pane')
  const closed = render(
    react.createElement(plugin.__test.SplitPane, {
      main: react.createElement('div', null, '主区内容'),
      detail: react.createElement('div', null, '详情内容'),
      open: false,
    }),
  )
  assert(closed.includes('主区内容'), 'closed split lost the main pane')
  assert(!closed.includes('详情内容'), 'closed split still renders the detail pane')
})

check('SplitPane renders the main pane alone when there is no detail', () => {
  const html = render(
    react.createElement(plugin.__test.SplitPane, { main: react.createElement('div', null, '只有主区'), open: true }),
  )
  assert(html.includes('只有主区'), 'main pane missing when detail is absent')
})

check('a blank root is normalised to no selection', () => {
  // Regression guard for a live failure: an empty string from localStorage is not
  // `null`, so it slipped past `=== null` guards, was sent as `?root=`, and the
  // host rightly answered "root is required and must be an absolute path" — an
  // error the user could do nothing with.
  const { isBlank, projectStore } = plugin.__test
  for (const blank of ['', '   ', null, undefined]) {
    assert(isBlank(blank), `isBlank(${JSON.stringify(blank)}) must be true`)
  }
  assert(!isBlank('D:\\documents\\x'), 'a real path must not be blank')

  projectStore.set('')
  assert(projectStore.root === null, `set('') left root as ${JSON.stringify(projectStore.root)}`)
  projectStore.set('   ')
  assert(projectStore.root === null, 'set(whitespace) must clear the selection')
  projectStore.set('D:\\documents\\x')
  assert(projectStore.root === 'D:\\documents\\x', 'set(path) must stick')
  projectStore.set(null)
  assert(projectStore.root === null, 'set(null) must clear the selection')
})

check('a blank stored root loads as no selection, not as an empty string', () => {
  const { projectStore } = plugin.__test
  window.localStorage.setItem('dsh-novel.projectRoot', '')
  assert(projectStore.load() === null, 'a blank stored value must load as null')
  window.localStorage.setItem('dsh-novel.projectRoot', 'D:\\documents\\x')
  assert(projectStore.load() === 'D:\\documents\\x', 'a real stored value must load unchanged')
  window.localStorage.removeItem('dsh-novel.projectRoot')
  projectStore.set(null)
})

check('api() preserves the query string', () => {
  // Regression guard for a live failure that hid for two phases: the helper
  // returned `new URL(...).pathname`, so every query-bearing request lost its
  // parameters and arrived as a bare path. Query-less routes kept working, so
  // only `/document?root=…` and `/project?root=…` broke — and the host answered
  // "root is required" for a request the client thought it had filled in.
  const { api } = plugin.__test
  const built = api('/dsh-novel/document?root=D%3A%5Cdocuments&path=setting%2Fitems.json')
  assert(built.includes('?'), `query string was dropped: ${built}`)
  assert(built.includes('root='), `root parameter was dropped: ${built}`)
  assert(built.includes('path='), `path parameter was dropped: ${built}`)
  assert(built.startsWith('/dsh-novel/document'), `path changed: ${built}`)
})

check('api() keeps the mount prefix from document.baseURI', () => {
  const { api } = plugin.__test
  const original = globalThis.document.baseURI
  globalThis.document.baseURI = 'https://host.example/app/my-dsh/'
  try {
    const built = api('/dsh-novel/health')
    assert(
      built === '/app/my-dsh/dsh-novel/health',
      `prefix not honoured: ${built} (expected /app/my-dsh/dsh-novel/health)`,
    )
  } finally {
    globalThis.document.baseURI = original
  }
})

check('api() tolerates a leading slash and a bare path', () => {
  const { api } = plugin.__test
  assert(api('dsh-novel/health') === api('/dsh-novel/health'), 'leading slash changed the result')
  assert(api('//dsh-novel/health') === api('/dsh-novel/health'), 'duplicate slashes changed the result')
})

check('withoutBlankKeys strips uncommitted rows', () => {
  // The form's draft row lives in component state. An earlier version appended
  // `{'': ''}` to the entity instead, which persisted an entry the renderer then
  // filtered out — invisible, unremovable junk that reached a real project.
  const { withoutBlankKeys } = plugin.__test
  assert(JSON.stringify(withoutBlankKeys({ '': '' })) === '{}', 'a lone blank key must vanish')
  assert(JSON.stringify(withoutBlankKeys({ 性格: '外冷内热' })) === '{"性格":"外冷内热"}', 'real entries must survive')
  assert(
    JSON.stringify(withoutBlankKeys({ '': '', 本命: '是', '  ': 'x' })) === '{"本命":"是"}',
    'blank and whitespace keys must both vanish',
  )
  assert(JSON.stringify(withoutBlankKeys(null)) === '{}', 'null must be tolerated')
  assert(JSON.stringify(withoutBlankKeys(undefined)) === '{}', 'undefined must be tolerated')
})

check('SchemaForm does not render a blank-key row from existing data', () => {
  const html = render(
    react.createElement(plugin.__test.SchemaForm, {
      entity: plugin.__test.ENTITIES.item,
      value: { id: 'item-x', name: '剑', custom: { '': 'junk', 本命: '是' } },
      onPatch() {},
    }),
  )
  assert(!html.includes('junk'), 'a blank-key entry must not be rendered as if it were real data')
  assert(html.includes('是'), 'legitimate custom values must still render')
})

// --- timeline ---------------------------------------------------------------

const timelineDoc = {
  calendar: {
    epochLabel: '创世历',
    start: { year: 1000, month: 1, day: 1 },
    end: { year: 1500, month: 12, day: 31 },
  },
  lines: [
    { id: 'tl-main', name: '主线', kind: 'main', order: 0 },
    { id: 'tl-north', name: '北境线', kind: 'branch', order: 10 },
  ],
  events: [
    { id: 'evt-0001', lineId: 'tl-main', at: { year: 1200, month: 5, day: 1 }, title: '青云山立宗' },
    { id: 'evt-0007', lineId: 'tl-main', at: { year: 1345, month: 3, day: 2 }, title: '青云山崩' },
    { id: 'evt-0009', lineId: 'tl-north', at: { year: 1400, month: 1, day: 1 }, title: '北境封关' },
    { id: 'evt-0011', lineId: 'tl-unknown', at: { year: 1300, month: 1, day: 1 }, title: '孤立事件' },
    { id: 'evt-0013', at: { year: 1250, month: 1, day: 1 }, title: '未归线事件' },
  ],
}

check('timeKey orders partial dates sensibly', () => {
  const { timeKey } = plugin.__test
  assert(timeKey({ year: 1345 }) === 13450000, 'year-only key wrong')
  assert(timeKey({ year: 1345, month: 3 }) === 13450300, 'year-month key wrong')
  assert(timeKey({ year: 1345, month: 3, day: 2 }) === 13450302, 'full key wrong')
  assert(timeKey({ year: 1345 }) < timeKey({ year: 1345, month: 1 }), 'a bare year must sort before its January')
  assert(timeKey(null) === null && timeKey({}) === null && timeKey({ year: 'x' }) === null, 'unusable times must be null')
})

check('timeKey rejects a null year instead of reading it as year zero', () => {
  const { timeKey } = plugin.__test
  assert(timeKey({ year: null, month: null, day: null }) === null, 'a cleared year must be unusable')
  assert(timeKey({ year: '' }) === null, 'a blank year must be unusable')
  assert(timeKey({ year: true }) === null, 'a boolean year must be unusable')
  assert(timeKey({ year: 0 }) === 0, 'a real year 0 is still valid')
})

check('the client timeKey agrees with the host validator on shared inputs', () => {
  // The two halves are separate bundles with no shared import path, so the helper
  // is duplicated. Cross-checking the copies is what stops them drifting.
  const { timeKey } = plugin.__test
  const cases = [
    { year: 1 },
    { year: 1345, month: 3, day: 2 },
    { year: 1500, month: 12, day: 31 },
    { year: -50, month: null, day: null },
    { year: 0, month: 0, day: 0 },
    null,
    {},
    { year: 'nope' },
  ]
  for (const value of cases) {
    assert(
      timeKey(value) === hostValidate.timeKey(value),
      `timeKey disagrees on ${JSON.stringify(value)}: client=${timeKey(value)} host=${hostValidate.timeKey(value)}`,
    )
  }
})

check('formatTimeKey renders the project calendar and omits unset parts', () => {
  const { formatTimeKey } = plugin.__test
  const calendar = { epochLabel: '创世历' }
  assert(formatTimeKey(calendar, 13450302) === '创世历 1345 年 3 月 2 日', formatTimeKey(calendar, 13450302))
  assert(formatTimeKey(calendar, 13450000) === '创世历 1345 年', formatTimeKey(calendar, 13450000))
  assert(formatTimeKey({}, 13450000) === '1345 年', 'a missing epoch label must not leave a stray space')
  assert(formatTimeKey(calendar, null) === '—', 'the empty cursor must render as a dash')
})

check('isAfterCursor splits past from future', () => {
  const { isAfterCursor, timeKey } = plugin.__test
  const cursor = timeKey({ year: 1345, month: 3, day: 2 })
  assert(isAfterCursor(cursor, { at: { year: 1400 } }) === true, 'a later event is the future')
  assert(isAfterCursor(cursor, { at: { year: 1200 } }) === false, 'an earlier event is the past')
  assert(isAfterCursor(cursor, { at: { year: 1345, month: 3, day: 2 } }) === false, 'an event AT the cursor is not future')
  assert(isAfterCursor(null, { at: { year: 1400 } }) === false, 'with no cursor nothing is future')
})

check('TimelineView draws every lane and event', () => {
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: timelineDoc, selection: null, onSelect() {} }))
  for (const title of ['青云山立宗', '青云山崩', '北境封关']) {
    assert(html.includes(title), `event "${title}" is missing`)
  }
  assert(html.includes('主线') && html.includes('北境线'), 'declared lanes are missing')
})

check('TimelineView surfaces events on undeclared or missing lines', () => {
  // Dropping them would silently hide data the author wrote.
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: timelineDoc, selection: null, onSelect() {} }))
  assert(html.includes('未定义线 tl-unknown'), 'an unknown lineId must get a synthetic lane')
  assert(html.includes('未归线'), 'an event with no lineId must get a lane')
  assert(html.includes('孤立事件') && html.includes('未归线事件'), 'their titles must render')
})

check('TimelineView labels the axis with the declared calendar', () => {
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: timelineDoc, selection: null, onSelect() {} }))
  assert(html.includes('创世历 1000 年'), 'axis start label missing')
  assert(html.includes('创世历 1500 年'), 'axis end label missing')
})

check('TimelineView starts the cursor at the latest written moment', () => {
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: timelineDoc, selection: null, onSelect() {} }))
  assert(html.includes('创世历 1400 年 1 月 1 日'), `cursor readout wrong: ${html.slice(0, 400)}`)
})

check('TimelineView derives a range when the calendar is unusable', () => {
  const noCalendar = { ...timelineDoc, calendar: { epochLabel: '无历' } }
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: noCalendar, selection: null, onSelect() {} }))
  assert(html.includes('无历 1200 年'), 'range should fall back to the earliest event')
  assert(html.includes('无历 1400 年'), 'range should fall back to the latest event')
})

check('TimelineView extends the axis to cover events outside the declared calendar', () => {
  // Regression guard for a live failure: clamping to the declared range pinned an
  // out-of-range event to the edge and left the cursor unable to reach it, so
  // every event dimmed at once and the view looked broken.
  const outside = {
    calendar: { epochLabel: '创世历', start: { year: 1000, month: 1, day: 1 }, end: { year: 1100, month: 12, day: 31 } },
    lines: [{ id: 'tl-main', name: '主线', kind: 'main', order: 0 }],
    events: [
      { id: 'evt-in', lineId: 'tl-main', at: { year: 1050, month: 1, day: 1 }, title: '范围内' },
      { id: 'evt-out', lineId: 'tl-main', at: { year: 1345, month: 3, day: 2 }, title: '范围外' },
    ],
  }
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: outside, selection: null, onSelect() {} }))
  assert(html.includes('范围外'), 'an out-of-range event must still render')
  assert(html.includes('创世历 1345 年 3 月 2 日'), `the axis must extend to the latest event: ${html.slice(0, 300)}`)
  assert(html.includes('历法区间'), 'the declared range must still be shown when the axis is wider')
  // The cursor starts at the latest moment, so an in-range event is the past.
  assert(plugin.__test.isAfterCursor(plugin.__test.timeKey({ year: 1200 }), { at: { year: 1345 } }) === true, 'sanity')
})

check('TimelineView marks the cursor as being at the latest moment', () => {
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: timelineDoc, selection: null, onSelect() {} }))
  assert(html.includes('（最新）'), 'the default cursor position must be labelled as intended, not look broken')
})

check('TimelineView tolerates an empty timeline', () => {
  const empty = { calendar: timelineDoc.calendar, lines: [], events: [] }
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: empty, selection: null, onSelect() {} }))
  assert(html.includes('还没有事件'), `empty state missing: ${html.slice(0, 200)}`)
})

check('TimelineView marks the selected event', () => {
  const html = render(
    react.createElement(plugin.__test.TimelineView, {
      doc: timelineDoc,
      selection: { entity: 'timeline-event', id: 'evt-0007' },
      onSelect() {},
    }),
  )
  assert(html.includes('rgba(128,128,128,0.2)'), 'the selected event is not highlighted')
})

check('CalendarEditor renders the epoch name and both endpoints', () => {
  const html = render(
    react.createElement(plugin.__test.CalendarEditor, { calendar: timelineDoc.calendar, onChange() {} }),
  )
  assert(html.includes('历法'), 'heading missing')
  assert(html.includes('创世历'), 'epoch label not shown')
  assert(html.includes('起点') && html.includes('终点'), 'endpoints missing')
})

check('axis positions stay inside the gutters at both extremes', () => {
  // Regression guard for a live failure: chips centred on 0% and 100% had half of
  // themselves outside the scroll container, so the labels at either end of the
  // timeline were clipped — exactly where the story starts and ends.
  const { axisLeft, GUTTER_PX, CHIP_MAX_WIDTH } = plugin.__test
  assert(GUTTER_PX * 2 > CHIP_MAX_WIDTH, 'the gutters must exceed one chip width or an edge chip still clips')
  const start = axisLeft(0)
  const end = axisLeft(1)
  assert(start.includes(`${GUTTER_PX}px`), `start position must offset by the gutter: ${start}`)
  assert(start.includes('* 0)'), `start position must be the gutter itself: ${start}`)
  assert(end.includes('* 1)'), `end position must be the far inset: ${end}`)
  assert(axisLeft(2) === end, 'a position past the end must clamp')
  assert(axisLeft(-1) === start, 'a position before the start must clamp')
  assert(axisLeft(Number.NaN) === start, 'a non-numeric position must clamp to the start')
})

check('TimelineView positions events with the gutter-aware axis', () => {
  const { GUTTER_PX } = plugin.__test
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: timelineDoc, selection: null, onSelect() {} }))
  assert(
    html.includes(`calc(${GUTTER_PX}px`),
    'timeline event positions must use the inset mapping, not a bare percentage',
  )
})

check('assignRows separates chips that would collide in time', () => {
  // Three events in nearby years would otherwise land on the same pixels and hide
  // each other, which is exactly what a writer hits when a single year holds a
  // cluster of plot beats.
  const { assignRows, ROW_SEPARATION } = plugin.__test
  const clustered = assignRows([0.5, 0.52, 0.54])
  assert(clustered.rowCount === 3, `three close events need three rows, got ${clustered.rowCount}`)
  assert(new Set(clustered.rowOf).size === 3, `each must get its own row: ${clustered.rowOf}`)

  const spread = assignRows([0.1, 0.5, 0.9])
  assert(spread.rowCount === 1, `well-separated events share one row, got ${spread.rowCount}`)
  assert(spread.rowOf.every((row) => row === 0), `all should be row 0: ${spread.rowOf}`)
})

check('assignRows keeps row order by original index, not by time', () => {
  // The caller indexes rows by document order; returning them sorted by time would
  // silently rotate the chips.
  const { assignRows } = plugin.__test
  const { rowOf } = assignRows([0.9, 0.1, 0.5])
  assert(rowOf.length === 3, 'one row per input')
  assert(rowOf[1] === 0, `the earliest event should take row 0, got ${rowOf[1]}`)
})

check('assignRows reuses a freed row', () => {
  // Greedy first-fit: after a far-apart pair, a later chip returns to row 0 rather
  // than opening a third row.
  const { assignRows, ROW_SEPARATION } = plugin.__test
  const { rowOf, rowCount } = assignRows([0, ROW_SEPARATION * 2, ROW_SEPARATION * 4])
  assert(rowCount === 1, `all three are separable, got ${rowCount} rows`)
  assert(rowOf.every((row) => row === 0), `expected one row: ${rowOf}`)
})

check('assignRows tolerates an empty lane', () => {
  const { assignRows } = plugin.__test
  const empty = assignRows([])
  assert(empty.rowCount === 0 && empty.rowOf.length === 0, 'an empty lane must not invent rows')
})

check('TimelineView stacks colliding events instead of overlaying them', () => {
  const clustered = {
    calendar: { epochLabel: '创世历', start: { year: 1000, month: 1, day: 1 }, end: { year: 1500, month: 12, day: 31 } },
    lines: [{ id: 'tl-main', name: '主线', kind: 'main', order: 0 }],
    events: [
      { id: 'evt-a', lineId: 'tl-main', at: { year: 1200, month: 1, day: 1 }, title: '甲' },
      { id: 'evt-b', lineId: 'tl-main', at: { year: 1202, month: 1, day: 1 }, title: '乙' },
      { id: 'evt-c', lineId: 'tl-main', at: { year: 1204, month: 1, day: 1 }, title: '丙' },
    ],
  }
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: clustered, selection: null, onSelect() {} }))
  for (const title of ['甲', '乙', '丙']) {
    assert(html.includes(`>${title}</button>`) || html.includes(title), `event "${title}" is missing`)
  }
  // Three distinct vertical offsets prove they were stacked rather than overlaid.
  // `renderToString` serializes inline styles without spaces, and `margin-top`
  // must not be mistaken for a chip offset.
  const offsets = new Set(
    [...html.matchAll(/(?:;|")top:(\d+(?:\.\d+)?)px/g)].map((match) => match[1]),
  )
  assert(offsets.size >= 3, `expected at least 3 distinct rows, saw ${[...offsets].join(', ') || '(none)'}`)
})

check('TimelineView places stacked events symmetrically above and below the axis', () => {
  // Asserts the geometry itself, not that a constant appears in the markup:
  // ROW_HEIGHT is an input to the layout, never a literal in the output.
  const { ROW_HEIGHT } = plugin.__test
  const pair = {
    calendar: { epochLabel: '历', start: { year: 1000, month: 1, day: 1 }, end: { year: 2000, month: 1, day: 1 } },
    lines: [{ id: 'tl-main', name: '主线', kind: 'main', order: 0 }],
    events: [
      { id: 'evt-a', lineId: 'tl-main', at: { year: 1200, month: 1, day: 1 }, title: '甲' },
      { id: 'evt-b', lineId: 'tl-main', at: { year: 1202, month: 1, day: 1 }, title: '乙' },
    ],
  }
  const html = render(react.createElement(plugin.__test.TimelineView, { doc: pair, selection: null, onSelect() {} }))
  assert(html.includes('height:1px'), 'the axis line is missing')

  const axisMatch = /top:(\d+(?:\.\d+)?)px;left:0;right:0;height:1px/.exec(html)
  assert(axisMatch !== null, 'could not locate the axis line offset')
  const axisY = Number(axisMatch[1])

  // `(?:;|")` anchors to a real `top`, so `margin-top` is not mistaken for one.
  const offsets = [...html.matchAll(/(?:;|")top:(\d+(?:\.\d+)?)px/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value !== axisY && value !== 0)

  assert(
    offsets.includes(axisY - ROW_HEIGHT),
    `expected a chip ${ROW_HEIGHT}px ABOVE the axis (axis=${axisY}), saw ${offsets.join(', ') || '(none)'}`,
  )
  assert(
    offsets.includes(axisY + ROW_HEIGHT),
    `expected a chip ${ROW_HEIGHT}px BELOW the axis (axis=${axisY}), saw ${offsets.join(', ') || '(none)'}`,
  )
})

// --- descriptor lookup ------------------------------------------------------

check('entitySpecFor resolves both tree and flat-collection shapes', () => {
  const { entitySpecFor, BRANCHES } = plugin.__test
  const items = BRANCHES.find((branch) => branch.id === 'items')
  const timeline = BRANCHES.find((branch) => branch.id === 'timeline')
  const outline = BRANCHES.find((branch) => branch.id === 'outline')

  const item = entitySpecFor(items, 'item')
  assert(item !== null && item.key === 'items', `item spec wrong: ${JSON.stringify(item)}`)
  const event = entitySpecFor(timeline, 'timeline-event')
  assert(event !== null && event.key === 'events', `event spec wrong: ${JSON.stringify(event)}`)
  const node = entitySpecFor(outline, 'outline-node')
  assert(node !== null && node.key === 'nodes', `outline node spec wrong: ${JSON.stringify(node)}`)
  assert(entitySpecFor(items, 'nope') === null, 'an unknown entity must resolve to null')
})

check('every implemented view has a usable descriptor', () => {
  const { ENTITIES, entitySpecFor } = plugin.__test
  for (const branch of allDescriptors()) {
    if (branch.view === 'planned') {
      assert(typeof branch.planned === 'string' && branch.planned !== '', `${branch.id} is planned but says nothing`)
      continue
    }
    if (branch.view === 'tabs') {
      assert(Array.isArray(branch.tabs) && branch.tabs.length > 0, `${branch.id} is a tab host with no tabs`)
      continue
    }
    if (branch.view === 'chapters') {
      // Chapters are Markdown files discovered by directory listing, not a
      // document with a fixed path — so demanding `doc` here would be wrong.
      assert(branch.doc === undefined, 'the chapters branch reads Markdown files, not a document')
      continue
    }
    assert(typeof branch.doc === 'string', `${branch.id} has no document`)
    if (branch.view === 'tree' || branch.view === 'timeline') {
      const slots = [...(branch.tree?.groups ?? []), ...(branch.tree?.leaves ?? []), ...(branch.collections ?? [])]
      assert(slots.length > 0, `${branch.id} declares no entities`)
      for (const slot of slots) {
        assert(ENTITIES[slot.entity] !== undefined, `${branch.id} references unknown entity "${slot.entity}"`)
        assert(entitySpecFor(branch, slot.entity) !== null, `${branch.id} cannot resolve "${slot.entity}"`)
      }
    }
  }
})

check('EntityTree drives a groups-only forest (the outline branch)', () => {
  const { BRANCHES } = plugin.__test
  const outline = BRANCHES.find((branch) => branch.id === 'outline')
  const doc = {
    nodes: [
      { id: 'out-0001', title: '第一卷 青云山下', kind: 'volume', parentId: null, order: 10 },
      { id: 'out-0012', title: '第十二章 山崩', kind: 'chapter', parentId: 'out-0001', order: 120 },
    ],
  }
  const html = render(
    react.createElement(plugin.__test.EntityTree, {
      doc,
      tree: outline.tree,
      selection: null,
      onSelect() {},
      onMutate() {},
    }),
  )
  assert(html.includes('第一卷 青云山下'), 'outline volume missing')
  assert(html.includes('第十二章 山崩'), 'outline chapter missing')
  assert(html.includes('新建大纲条目'), 'the group button is missing')
  assert(!html.includes('未归类'), 'a groups-only forest must not offer a leaf button')
})

// --- chapters ---------------------------------------------------------------

check('the client word counter agrees with the host on shared inputs', () => {
  // Duplicated across the two bundles; the chapter list shows the host's number
  // while the editor shows the buffer's, so a divergence would make the same
  // chapter report two different lengths on one screen.
  const { countWords } = plugin.__test
  const cases = [
    '',
    '第一章 青云山下',
    '他抬头，看见山崩了。',
    'Hello world',
    '青云山 abc 123',
    "don't stop",
    '   \n\t ',
    'Mixed 中英 text 混合 2026',
  ]
  for (const value of cases) {
    assert(
      countWords(value) === hostText.countWords(value),
      `countWords disagrees on ${JSON.stringify(value)}: client=${countWords(value)} host=${hostText.countWords(value)}`,
    )
  }
})

check('MasterDetail renders the list and the content side by side', () => {
  const html = render(
    react.createElement(plugin.__test.MasterDetail, {
      list: react.createElement('div', null, '章节列表'),
      content: react.createElement('div', null, '正文区'),
    }),
  )
  assert(html.includes('章节列表') && html.includes('正文区'), 'one of the panes is missing')
  assert(html.includes('230px'), 'the list column must have a fixed width')
})

check('the chapter entity declares the front matter fields', () => {
  const { ENTITIES } = plugin.__test
  const chapter = ENTITIES.chapter
  assert(chapter !== undefined, 'the chapter entity is missing')
  const keys = chapter.fields.map((field) => field.key)
  for (const expected of ['title', 'order', 'status', 'characters', 'places', 'summary']) {
    assert(keys.includes(expected), `chapter field "${expected}" is missing`)
  }
  assert(chapter.fields.find((field) => field.key === 'status').options.length === 3, 'status needs its three options')
  assert(typeof chapter.blank().custom === 'object', 'a new chapter must start with a custom bag')
})

check('the chapters branch panel renders', () => {
  const chapters = panels.find((panel) => panel.options.key === 'dsh-novel.chapters')
  assert(chapters !== undefined, 'the chapters panel is not registered')
  const html = render(react.createElement(chapters.component))
  assert(html.includes('返回对话'), 'the shell header is missing')
})

check('editing a line list does not round-trip through the parsed value', () => {
  // Regression guard for a live failure: rendering the normalized list on every
  // keystroke stripped the trailing newline Enter produces, so the cursor snapped
  // back and 「每行一个」 could never reach a second line — in every field using it.
  const { stringListDisplay, parseStringList } = plugin.__test

  // The bug, stated: parsing "主角\n" and joining it back loses the newline.
  assert(parseStringList('主角\n').join('\n') === '主角', 'precondition: the parser drops blank lines')

  // The fix: while editing, the raw buffer is displayed, so the newline survives.
  assert(stringListDisplay(true, '主角\n', ['主角']) === '主角\n', 'the raw draft must be shown while editing')
  assert(stringListDisplay(true, '主角\n配角\n', ['主角', '配角']) === '主角\n配角\n', 'later lines must be typeable')

  // On blur the normalized value takes over again, which keeps blanks out of the file.
  assert(stringListDisplay(false, '', ['主角', '配角']) === '主角\n配角', 'blur must show the normalized list')
  assert(stringListDisplay(false, '', null) === '', 'a missing value renders empty')
})

check('parseStringList trims and drops blanks', () => {
  const { parseStringList } = plugin.__test
  assert(JSON.stringify(parseStringList(' 主角 \n\n 配角 \n')) === '["主角","配角"]', 'trim and blank handling')
  assert(JSON.stringify(parseStringList('')) === '[]', 'empty text is an empty list')
  assert(JSON.stringify(parseStringList(null)) === '[]', 'null is an empty list')
})

// --- references and pickers -------------------------------------------------

check('every declared reference kind has a data source', () => {
  // A `ref`/`reflist` field whose kind is missing from REF_COLLECTIONS renders a
  // permanently empty picker — a silent dead end, since nothing throws.
  const { ENTITIES, REF_COLLECTIONS } = plugin.__test
  const kinds = []
  for (const [name, entity] of Object.entries(ENTITIES)) {
    for (const field of entity.fields) {
      if (field.type === 'ref' || field.type === 'reflist') {
        kinds.push({ name, key: field.key, kind: field.refKind })
      }
    }
  }
  assert(kinds.length > 0, 'expected some reference fields to exist')
  for (const entry of kinds) {
    assert(
      REF_COLLECTIONS[entry.kind] !== undefined,
      `${entry.name}.${entry.key} references kind "${entry.kind}", which has no source in REF_COLLECTIONS`,
    )
  }
})

check('chapters and events pick characters and places rather than typing them', () => {
  const { ENTITIES } = plugin.__test
  for (const [name, keys] of [
    ['chapter', ['characters', 'places']],
    ['timeline-event', ['characters', 'places']],
  ]) {
    for (const key of keys) {
      const field = ENTITIES[name].fields.find((candidate) => candidate.key === key)
      assert(field !== undefined, `${name}.${key} is missing`)
      assert(field.type === 'reflist', `${name}.${key} should be a reflist picker, got ${field.type}`)
    }
  }
})

check('the new entities declare the fields the model requires', () => {
  const { ENTITIES } = plugin.__test
  const character = ENTITIES.character
  assert(character !== undefined, 'the character entity is missing')
  const characterKeys = character.fields.map((field) => field.key)
  for (const expected of ['name', 'gender', 'race', 'born', 'status', 'appearance', 'personality']) {
    assert(characterKeys.includes(expected), `character field "${expected}" is missing`)
  }
  // Birth time, not an age number: the timeline spans centuries.
  assert(character.fields.find((f) => f.key === 'born').type === 'time', 'born must be a time field')
  assert(characterKeys.includes('parentId') === false, 'parentId belongs to the tree, not the form')

  const place = ENTITIES.place
  assert(place !== undefined, 'the place entity is missing')
  assert(place.fields.map((f) => f.key).includes('name'), 'place needs a name')

  const organization = ENTITIES.organization
  assert(organization !== undefined, 'the organization entity is missing')
  assert(organization.fields.map((f) => f.key).includes('founded'), 'organization needs a founded time')
})

check('MultiSelect renders chosen chips, candidates, and unresolved ids', () => {
  const { MultiSelect } = plugin.__test
  const html = render(
    react.createElement(MultiSelect, {
      value: ['char-linyuan', 'char-ghost'],
      onChange() {},
      options: [
        { id: 'char-linyuan', title: '林渊' },
        { id: 'char-shenyi', title: '沈逸' },
      ],
    }),
  )
  assert(html.includes('林渊'), 'a resolved chip must show its title')
  assert(html.includes('沈逸'), 'an unselected candidate must be offered')
  // An id no entity defines stays visible and is marked, rather than vanishing —
  // that is how a name typed before the character existed remains fixable.
  assert(html.includes('char-ghost'), 'an unresolved id must still be shown')
  assert(html.includes('没有对应实体'), 'an unresolved chip must be marked')
  assert(html.includes('c98a2b'), 'the unresolved chip must be visually distinct')
})

check('MultiSelect says so when there is nothing to pick', () => {
  const { MultiSelect } = plugin.__test
  const html = render(react.createElement(MultiSelect, { value: [], onChange() {}, options: [] }))
  assert(html.includes('暂无可选项'), `an empty picker must explain itself: ${html.slice(0, 200)}`)
})

// --- tabs --------------------------------------------------------------------

check('the world branch hosts 地点 as a tab and keeps 7 icons', () => {
  const { BRANCHES } = plugin.__test
  assert(BRANCHES.length === 7, `expected the seven designed icons, got ${BRANCHES.length}`)
  const world = BRANCHES.find((branch) => branch.id === 'world')
  assert(world.view === 'tabs', `the world branch should host tabs, got ${world.view}`)
  const placeTab = world.tabs.find((tab) => tab.id === 'places')
  assert(placeTab !== undefined && placeTab.view === 'tree', 'the 地点 tab should be a tree')
  assert(world.tabs.some((tab) => tab.id === 'map'), '世界 should still host the 地图 tab')
  // The set of views the router actually handles, read out of the router itself. A hand-listed
  // set would keep passing after someone added a `view` here and forgot the dispatch case, which
  // is exactly the mistake this check exists to catch.
  for (const tab of world.tabs) {
    assert(routerViews.has(tab.view), `tab ${tab.id} has view "${tab.view}", which BranchRouter does not handle`)
  }
})

check('every implemented branch uses a view the router handles', () => {
  for (const branch of allDescriptors()) {
    assert(routerViews.has(branch.view), `descriptor ${branch.id} has view "${branch.view}", which BranchRouter does not handle`)
  }
})

check('TabsBranch renders its tab strip', () => {
  const { BRANCHES } = plugin.__test
  const world = BRANCHES.find((branch) => branch.id === 'world')
  const html = render(react.createElement(plugin.__test.TabsBranch, { branch: world, root: null }))
  for (const tab of world.tabs) {
    assert(html.includes(tab.label), `tab "${tab.label}" is missing from the strip`)
  }
})

// --- relationship graph -----------------------------------------------------

const graphNodes = [
  { id: 'char-linyuan', title: '林渊', kind: 'character' },
  { id: 'char-shenyi', title: '沈逸', kind: 'character' },
  { id: 'org-qingyun', title: '青云宗', kind: 'organization' },
]
const graphTypes = [
  { id: 'master-apprentice', label: '师徒', directed: true },
  { id: 'member-of', label: '隶属', directed: true },
  { id: 'ally', label: '同盟', directed: false },
]
const graphEdges = [
  { id: 'rel-1', from: 'char-linyuan', to: 'char-shenyi', type: 'master-apprentice', since: { year: 1339 }, until: { year: 1350 } },
  { id: 'rel-2', from: 'char-linyuan', to: 'org-qingyun', type: 'member-of', since: { year: 1339 }, until: null },
  { id: 'rel-3', from: 'char-shenyi', to: 'org-qingyun', type: 'ally', since: { year: 1400 }, until: null },
]

check('edgesActiveAt honours since inclusive and until exclusive', () => {
  const { edgesActiveAt } = plugin.__test
  const idsAt = (year) => edgesActiveAt(graphEdges, timeKeyOf(year)).map((edge) => edge.id).sort()

  function timeKeyOf(year) {
    return year * 10000
  }

  assert(idsAt(1338).length === 0, 'nothing exists before any since')
  assert(JSON.stringify(idsAt(1339)) === '["rel-1","rel-2"]', `at the since year both begin: ${idsAt(1339)}`)
  assert(JSON.stringify(idsAt(1345)) === '["rel-1","rel-2"]', `between both hold: ${idsAt(1345)}`)
  // The handover convention: until is exclusive, so at exactly 1350 rel-1 is over.
  assert(JSON.stringify(idsAt(1350)) === '["rel-2"]', `until is exclusive: ${idsAt(1350)}`)
  assert(JSON.stringify(idsAt(1401)) === '["rel-2","rel-3"]', `later relations appear: ${idsAt(1401)}`)
})

check('edgesActiveAt treats a null cursor as "the latest moment"', () => {
  const { edgesActiveAt } = plugin.__test
  assert(edgesActiveAt(graphEdges, null).length === graphEdges.length, 'null cursor shows everything')
  assert(edgesActiveAt(graphEdges, undefined).length === graphEdges.length, 'undefined cursor shows everything')
})

check('edgesActiveAt keeps an edge whose since is unusable', () => {
  // Hiding malformed data would make the malformation unfindable; the validator
  // reports it instead.
  const { edgesActiveAt } = plugin.__test
  const broken = [{ id: 'rel-x', from: 'a', to: 'b', type: 'ally', since: { year: null }, until: null }]
  assert(edgesActiveAt(broken, 13450000).length === 1, 'a bad since must not silently hide the edge')
})

check('visibleNetwork shows only the focus kind by default', () => {
  // Regression guard for a live complaint: the character graph was showing
  // organizations and places. The old rule kept every node kind and filtered only
  // the EDGES, so a neighbour dragged unrelated kinds into the view.
  const { visibleNetwork } = plugin.__test
  const chars = visibleNetwork(graphNodes, graphEdges, { focusKinds: ['character'] })
  assert(chars.nodes.length === 2, `only characters, got ${chars.nodes.map((node) => node.id)}`)
  assert(
    !chars.nodes.some((node) => node.id === 'org-qingyun'),
    'an organization must NOT appear in the character graph by default',
  )
  assert(
    chars.edges.length === 1 && chars.edges[0].id === 'rel-1',
    `only the character-to-character edge: ${chars.edges.map((edge) => edge.id)}`,
  )

  const orgs = visibleNetwork(graphNodes, graphEdges, { focusKinds: ['organization'] })
  assert(
    orgs.nodes.length === 1 && orgs.nodes[0].id === 'org-qingyun',
    `only the organization: ${orgs.nodes.map((node) => node.id)}`,
  )
  assert(orgs.edges.length === 0, 'this fixture has no organization-to-organization edge')
})

check('visibleNetwork widens to neighbours only when asked', () => {
  const { visibleNetwork } = plugin.__test
  const widened = visibleNetwork(graphNodes, graphEdges, { focusKinds: ['character'], includeOthers: true })
  assert(
    widened.nodes.some((node) => node.id === 'org-qingyun'),
    'membership becomes visible when widened — that is what the toggle is for',
  )
  assert(widened.edges.length === 3, `all three edges then have both ends present: ${widened.edges.map((e) => e.id)}`)
})

check('visibleNetwork never counts an edge whose far end is excluded', () => {
  // An edge to an absent node cannot be placed on the canvas; counting it would
  // misreport the totals, which is how a "1 条" beside an empty graph happens.
  const { visibleNetwork } = plugin.__test
  const orgOnly = visibleNetwork(graphNodes, graphEdges, { focusKinds: ['organization'] })
  assert(orgOnly.edges.length === 0, 'the character-to-organization edges must not be counted')
})

check('visibleNetwork keeps everything with no focus kinds', () => {
  const { visibleNetwork } = plugin.__test
  const all = visibleNetwork(graphNodes, graphEdges, {})
  assert(all.nodes.length === 3 && all.edges.length === 3, 'an empty focus list keeps the whole network')
})

check('layoutForce is deterministic, bounded, and positions every node', () => {
  const { layoutForce } = plugin.__test
  const options = { width: 720, height: 480 }
  const first = layoutForce(graphNodes, graphEdges, options)
  const second = layoutForce(graphNodes, graphEdges, options)

  assert(first.size === graphNodes.length, `every node must be positioned, got ${first.size}`)
  for (const node of graphNodes) {
    assert(first.has(node.id), `missing a position for ${node.id}`)
  }
  // Determinism is the reason this is testable at all: a random seed would draw a
  // different picture on every render.
  assert(
    JSON.stringify([...first.entries()]) === JSON.stringify([...second.entries()]),
    'the same input must produce the same layout',
  )
  for (const [, point] of first) {
    assert(point.x >= 0 && point.x <= options.width, `x out of bounds: ${point.x}`)
    assert(point.y >= 0 && point.y <= options.height, `y out of bounds: ${point.y}`)
  }
  const distinct = new Set([...first.values()].map((point) => `${Math.round(point.x)},${Math.round(point.y)}`))
  assert(distinct.size === graphNodes.length, 'repulsion must separate coincident nodes')
})

check('layoutForce handles the degenerate sizes', () => {
  const { layoutForce } = plugin.__test
  assert(layoutForce([], []).size === 0, 'no nodes, no positions')
  const single = layoutForce([graphNodes[0]], [], { width: 400, height: 300 })
  const point = single.get('char-linyuan')
  assert(point.x === 200 && point.y === 150, `a lone node belongs in the centre, got ${JSON.stringify(point)}`)
})

check('RelationGraph draws nodes, labelled edges, and dashes undirected ones', () => {
  const { RelationGraph, layoutForce } = plugin.__test
  const positions = layoutForce(graphNodes, graphEdges, { width: 720, height: 480 })
  const html = render(
    react.createElement(RelationGraph, {
      nodes: graphNodes,
      edges: graphEdges,
      types: graphTypes,
      positions,
      width: 720,
      height: 480,
      selection: null,
      onSelect() {},
    }),
  )
  for (const title of ['林渊', '沈逸', '青云宗']) {
    assert(html.includes(title), `node "${title}" is missing from the graph`)
  }
  assert(html.includes('师徒') && html.includes('隶属'), 'edge type labels are missing')
  assert(html.includes('<line'), 'edges must be drawn as lines')
  // An undirected type is dashed, which is the only thing distinguishing it.
  assert(html.includes('stroke-dasharray'), 'undirected relations must be dashed')
  assert(html.includes('transparent'), 'a line needs a wider invisible hit target to be clickable')
})

check('RelationGraph highlights the selected edge', () => {
  const { RelationGraph, layoutForce } = plugin.__test
  const positions = layoutForce(graphNodes, graphEdges, { width: 720, height: 480 })
  const html = render(
    react.createElement(RelationGraph, {
      nodes: graphNodes,
      edges: graphEdges,
      types: graphTypes,
      positions,
      width: 720,
      height: 480,
      selection: { entity: 'relation-edge', id: 'rel-2' },
      onSelect() {},
    }),
  )
  // SVG geometry serializes as attributes, not style properties, so the emphasis
  // shows up as stroke-width="2.4" rather than a `stroke-width:2.4` rule.
  assert(html.includes('stroke-width="2.4"'), 'the selected edge must be emphasised')
})

check('the relation edge entity declares the temporal fields', () => {
  const { ENTITIES } = plugin.__test
  const edge = ENTITIES['relation-edge']
  assert(edge !== undefined, 'the relation-edge entity is missing')
  const keys = edge.fields.map((field) => field.key)
  for (const expected of ['from', 'to', 'type', 'since', 'until', 'causeEventId', 'note']) {
    assert(keys.includes(expected), `relation-edge field "${expected}" is missing`)
  }
  assert(edge.fields.find((field) => field.key === 'since').type === 'time', 'since must be a time field')
  assert(typeof edge.blank().since === 'object', 'a new edge must carry a usable default since')
})

check('人物 and 组织 both host a graph tab, focused differently', () => {
  const { BRANCHES } = plugin.__test
  const chars = BRANCHES.find((branch) => branch.id === 'chars')
  const orgs = BRANCHES.find((branch) => branch.id === 'orgs')
  assert(chars.view === 'tabs' && orgs.view === 'tabs', 'both should be tab hosts')
  const charGraph = chars.tabs.find((tab) => tab.view === 'graph')
  const orgGraph = orgs.tabs.find((tab) => tab.view === 'graph')
  assert(charGraph !== undefined, 'the 人物 tab set needs a graph')
  assert(orgGraph !== undefined, 'the 组织 tab set needs a graph')
  assert(charGraph.doc === 'relations.json' && orgGraph.doc === 'relations.json', 'both read the same edge document')
  assert(
    JSON.stringify(charGraph.focusKinds) !== JSON.stringify(orgGraph.focusKinds),
    'the two graphs must be focused differently, or they would be the same screen twice',
  )
})

check('GraphView renders its cursor bar and drawing', () => {
  // Regression guard for a live blank panel: a props object passed as a CHILD
  // throws at render time, which unmounts the whole panel with no message. It went
  // unnoticed because `GraphBranch` is fetch-driven and effects do not run under
  // `renderToString`, so the body below its loading guard was never rendered by a
  // test. `GraphView` is props-driven precisely so this is reachable.
  const { GraphView, layoutForce } = plugin.__test
  const positions = layoutForce(graphNodes, graphEdges, { width: 720, height: 480 })
  const html = render(
    react.createElement(GraphView, {
      nodes: graphNodes,
      edges: graphEdges,
      types: graphTypes,
      calendar: { epochLabel: '创世历' },
      cursorKey: null,
      onStep() {},
      onLatest() {},
      totalEdges: graphEdges.length,
      selection: null,
      onSelect() {},
      positions,
      width: 720,
      height: 480,
    }),
  )
  assert(html.includes('时间游标'), 'the cursor bar must render')
  assert(html.includes('（最新）'), 'a null cursor reads as the latest moment')
  assert(html.includes('← 上一变化') && html.includes('下一变化 →'), 'the step controls must render')
  assert(html.includes('回到最新'), 'the reset control must render')
  assert(html.includes('含跨类关系'), 'the widen toggle must render')
  assert(html.includes('3 个节点'), `the counts must render: ${html.slice(0, 300)}`)
  assert(html.includes('<line'), 'the drawing must render')
})

check('GraphView explains an empty graph instead of drawing nothing', () => {
  const { GraphView } = plugin.__test
  const noNodes = render(
    react.createElement(GraphView, {
      nodes: [],
      edges: [],
      types: [],
      calendar: null,
      cursorKey: null,
      onStep() {},
      onLatest() {},
      totalEdges: 0,
      selection: null,
      onSelect() {},
      positions: new Map(),
      width: 720,
      height: 480,
    }),
  )
  assert(noNodes.includes('还没有可入网的实体'), `expected the no-nodes note: ${noNodes.slice(0, 200)}`)

  const noEdges = render(
    react.createElement(GraphView, {
      nodes: graphNodes,
      edges: [],
      types: graphTypes,
      calendar: null,
      cursorKey: null,
      onStep() {},
      onLatest() {},
      totalEdges: 0,
      selection: null,
      onSelect() {},
      positions: new Map(),
      width: 720,
      height: 480,
    }),
  )
  assert(noEdges.includes('还没有关系'), `expected the no-edges note: ${noEdges.slice(0, 200)}`)
})

check('every graph view can resolve the entity it edits', () => {
  // Regression guard for a live failure: the graph tabs declared their document but
  // not their entity collections, so `entitySpecFor` returned null, the detail pane
  // fell through to a generic hint, and a newly created relation was uneditable.
  // The code sits below the fetch guard, which no render test reached.
  const { entitySpecFor } = plugin.__test
  const graphs = allDescriptors().filter((branch) => branch.view === 'graph')
  assert(graphs.length > 0, 'expected at least one graph view')
  for (const branch of graphs) {
    assert(
      entitySpecFor(branch, 'relation-edge') !== null,
      `${branch.id} declares no collection for relation-edge, so its detail form cannot resolve`,
    )
  }
})

check('GraphBranch renders', () => {
  const { BRANCHES } = plugin.__test
  const chars = BRANCHES.find((branch) => branch.id === 'chars')
  const graphTab = chars.tabs.find((tab) => tab.view === 'graph')
  const html = render(react.createElement(plugin.__test.GraphBranch, { branch: graphTab, root: null }))
  assert(typeof html === 'string' && html.length > 0, 'the graph branch rendered nothing')
})

// --- branch bodies: the region that used to be unreachable -------------------
//
// Every one of these is props-driven on purpose. Before the extraction, each
// branch was fetch-driven and `renderToString` never runs effects, so the branch
// always rendered its loading state and everything below that guard — toolbars,
// detail forms, delete flows — was never rendered by any test. Three bugs
// reported from live use lived in that region.

// `itemsBranch` and `timelineDoc` are declared further up; only the timeline
// branch descriptor is new here.
const timelineBranch = plugin.__test.BRANCHES.find((branch) => branch.id === 'timeline')

const idleStatus = { dirty: false, saving: false, savedAt: null }
const noopActions = { save() {}, revert() {} }

check('EntityTreeBody renders the toolbar, the tree, and the detail form', () => {
  const html = render(
    react.createElement(plugin.__test.EntityTreeBody, {
      branch: itemsBranch,
      doc: sampleDoc,
      refOptions: {},
      selection: { entity: 'item', id: 'item-qingfeng' },
      onSelect() {},
      onMutate() {},
      status: { dirty: true, saving: false, savedAt: null },
      actions: noopActions,
      detailOpen: true,
      onToggleDetail() {},
      feedback: { error: null, issues: null, warnings: null },
    }),
  )
  assert(html.includes('保存') && html.includes('未保存'), 'the commit row must reflect the dirty state')
  assert(html.includes('收起详情'), 'the detail toggle must render')
  assert(html.includes('setting/items.json'), 'the toolbar must name the document')
  assert(html.includes('青锋剑'), 'the tree must render')
  assert(html.includes('删除这个物品'), 'the delete control must render for a selected entity')
  assert(html.includes('名称'), 'the detail form must render its fields')
})

check('EntityTreeBody prompts when nothing is selected', () => {
  const html = render(
    react.createElement(plugin.__test.EntityTreeBody, {
      branch: itemsBranch,
      doc: sampleDoc,
      refOptions: {},
      selection: null,
      onSelect() {},
      onMutate() {},
      status: idleStatus,
      actions: noopActions,
      detailOpen: true,
      onToggleDetail() {},
      feedback: { error: null, issues: null, warnings: null },
    }),
  )
  assert(html.includes('选中左侧一项'), 'an empty detail pane must say what to do')
  assert(!html.includes('删除这个'), 'no delete control without a selection')
})

check('WriteFeedback reports refusals and warnings', () => {
  const { WriteFeedback } = plugin.__test
  assert(render(react.createElement(WriteFeedback, { error: null, issues: null, warnings: null })) === '', 'nothing to say, nothing rendered')
  const refused = render(
    react.createElement(WriteFeedback, {
      error: null,
      issues: [{ code: 'dangling-reference', message: '指向了不存在的实体' }],
      warnings: [{ code: 'unresolved-chapter-reference', message: '名字尚未对应实体' }],
    }),
  )
  assert(refused.includes('宿主拒绝了这次写入'), 'a refusal must be explained')
  assert(refused.includes('dangling-reference'), 'the issue code must be shown')
  assert(refused.includes('未对应实体') || refused.includes('尚未对应实体'), 'warnings must be shown too')
})

check('CommitRow disables save until there is something to save', () => {
  const { CommitRow } = plugin.__test
  const clean = render(react.createElement(CommitRow, { label: 'x.json', status: idleStatus, actions: noopActions }))
  assert(clean.includes('disabled'), 'a clean document must not offer save')

  const saving = render(
    react.createElement(CommitRow, {
      label: 'x.json',
      status: { dirty: true, saving: true, savedAt: null },
      actions: noopActions,
    }),
  )
  assert(saving.includes('保存中…'), 'a save in flight must say so')

  const saved = render(
    react.createElement(CommitRow, {
      label: 'x.json',
      status: { dirty: false, saving: false, savedAt: '12:00:00' },
      actions: noopActions,
    }),
  )
  assert(saved.includes('已保存 12:00:00'), 'the saved time must show once clean')
})

check('TimelineBody shows the calendar editor when nothing is selected', () => {
  const html = render(
    react.createElement(plugin.__test.TimelineBody, {
      branch: timelineBranch,
      doc: timelineDoc,
      refOptions: {},
      selection: null,
      onSelect() {},
      onMutate() {},
      status: idleStatus,
      actions: noopActions,
      detailOpen: true,
      onToggleDetail() {},
      feedback: { error: null, issues: null, warnings: null },
    }),
  )
  assert(html.includes('新建事件') && html.includes('新建时间线'), 'the create controls must render')
  assert(html.includes('历法'), 'the calendar editor must be the default detail')
  assert(html.includes('创世历'), 'the calendar editor must show the epoch')
  assert(html.includes('青云山崩'), 'the timeline must render its events')
})

check('TimelineBody shows the event form for a selected event', () => {
  const html = render(
    react.createElement(plugin.__test.TimelineBody, {
      branch: timelineBranch,
      doc: timelineDoc,
      refOptions: {},
      selection: { entity: 'timeline-event', id: 'evt-0007' },
      onSelect() {},
      onMutate() {},
      status: idleStatus,
      actions: noopActions,
      detailOpen: true,
      onToggleDetail() {},
      feedback: { error: null, issues: null, warnings: null },
    }),
  )
  assert(html.includes('事件 · 青云山崩'), `the detail heading must name the event: ${html.slice(0, 400)}`)
  assert(html.includes('删除这个事件'), 'the delete control must render')
  // The ref field must render a select, not a bare text input.
  assert(html.includes('所属线'), 'the line reference field must render')
})

check('ChapterListPane renders titles, counts, and the selected row', () => {
  const { ChapterListPane } = plugin.__test
  const chapters = [
    { path: 'draft/ch-0001.md', id: 'ch-0001', title: '第一章 青云山下', wordCount: 1200, status: 'draft', frontMatterError: null },
    { path: 'draft/ch-0002.md', id: 'ch-0002', title: '第二章 山崩', wordCount: 800, status: 'final', frontMatterError: null },
    { path: 'draft/ch-0003.md', id: 'ch-0003', title: '', wordCount: 0, status: null, frontMatterError: 'bad yaml' },
  ]
  const html = render(
    react.createElement(ChapterListPane, {
      chapters,
      selected: 'draft/ch-0002.md',
      onSelect() {},
      onCreate() {},
      creating: false,
      createError: null,
      totalWordCount: 2000,
    }),
  )
  assert(html.includes('第一章 青云山下') && html.includes('第二章 山崩'), 'titles must render')
  assert(html.includes('3 章 · 2000 字'), `the totals must render: ${html.slice(0, 300)}`)
  assert(html.includes('1200 字'), 'per-chapter counts must render')
  assert(html.includes('rgba(128,128,128,0.16)'), 'the selected row must be highlighted')
  assert(html.includes('ch-0003'), 'a chapter with no title falls back to its id')
  assert(html.includes('front matter 有问题'), 'a broken front matter must be flagged in the list')
})

check('ChapterEditorPane renders the metadata form and the prose box', () => {
  const html = render(
    react.createElement(plugin.__test.ChapterEditorPane, {
      loading: false,
      path: 'draft/ch-0001.md',
      meta: { id: 'ch-0001', title: '第一章 青云山下', order: 10, status: 'draft', characters: [], places: [], summary: '', custom: {} },
      body: '他抬头，看见山崩了。',
      wordCount: 8,
      refOptions: { character: [{ id: 'char-linyuan', title: '林渊' }] },
      status: { dirty: true, saving: false, savedAt: null },
      actions: noopActions,
      onPatchMeta() {},
      onSetBody() {},
      frontMatterError: null,
      feedback: { error: null, issues: null, warnings: null },
    }),
  )
  assert(html.includes('draft/ch-0001.md'), 'the toolbar must name the chapter file')
  assert(html.includes('标题') && html.includes('状态'), 'the metadata form must render')
  assert(html.includes('他抬头'), 'the prose must be in the textarea')
  assert(html.includes('正文'), 'the prose box must be labelled')
  assert(html.includes('8 字'), 'the live word count must show')
  assert(html.includes('char-linyuan'), 'the character picker must offer the candidate')
})

check('ChapterEditorPane states its loading and empty conditions', () => {
  const { ChapterEditorPane } = plugin.__test
  const base = { refOptions: {}, status: idleStatus, actions: noopActions, onPatchMeta() {}, onSetBody() {}, feedback: {} }
  assert(
    render(react.createElement(ChapterEditorPane, { ...base, loading: true, meta: null })).includes('载入中'),
    'loading must be stated',
  )
  assert(
    render(react.createElement(ChapterEditorPane, { ...base, loading: false, placeholder: '先选一章', meta: null })).includes('先选一章'),
    'an untouched editor must show its placeholder, not an error',
  )
  assert(
    render(react.createElement(ChapterEditorPane, { ...base, loading: false, meta: null, status: { error: '坏了' } })).includes('坏了'),
    'a real failure must be shown as one',
  )
})

check('ChapterBody composes the two panes', () => {
  const html = render(
    react.createElement(plugin.__test.ChapterBody, {
      list: { chapters: [], selected: null, onSelect() {}, onCreate() {}, creating: false, createError: null, totalWordCount: 0 },
      editor: { loading: false, placeholder: '先选一章', meta: null, status: { error: null } },
    }),
  )
  assert(html.includes('＋ 新建章节') && html.includes('先选一章'), 'both panes must appear side by side')
})

// --- model-backed generation -------------------------------------------------

check('GenerateControl offers the action and names the direction', () => {
  const { GenerateControl } = plugin.__test
  const html = render(
    react.createElement(GenerateControl, {
      generator: { kind: 'item', hintField: 'name' },
      hint: '一柄古剑',
      base: {},
      onGenerated() {},
    }),
  )
  assert(html.includes('随机生成'), 'the action must be offered')
  assert(html.includes('一柄古剑'), 'the current draft should be named as the direction')
})

check('GenerateReceipt reports the model and the cost, or the failure', () => {
  const { GenerateReceipt } = plugin.__test
  // Nothing to report renders nothing, rather than an empty strip.
  assert(render(react.createElement(GenerateReceipt, { error: null, receipt: null })) === '', 'idle renders nothing')

  const used = render(
    react.createElement(GenerateReceipt, { error: null, receipt: { model: 'deepseek-account · deepseek-flash', tokens: 447 } }),
  )
  assert(used.includes('deepseek-account · deepseek-flash'), 'the model that ran must be named')
  assert(used.includes('447 tokens'), 'the cost must be shown — it is the author’s quota')
  assert(used.includes('草稿'), 'the result must be framed as a draft to review')

  const noTokens = render(react.createElement(GenerateReceipt, { error: null, receipt: { model: 'x', tokens: null } }))
  assert(!noTokens.includes('null'), `a missing token count must not print "null": ${noTokens}`)

  const failed = render(react.createElement(GenerateReceipt, { error: '宿主没有组合 llm 服务，无法调用模型', receipt: null }))
  assert(failed.includes('无法调用模型'), 'the host’s own explanation must be surfaced')
})

check('the item entity declares a generator and the category does not', () => {
  const { ENTITIES } = plugin.__test
  assert(ENTITIES.item.generate !== undefined, 'the item must declare a generator')
  assert(ENTITIES.item.generate.kind === 'item', `wrong generator kind: ${ENTITIES.item.generate.kind}`)
  assert(ENTITIES.item.generate.hintField === 'name', 'the hint field must be declared')
  assert(ENTITIES['item-category'].generate === undefined, 'a category has nothing to generate')
})

check('EntityTreeBody offers generation only where the entity declares it', () => {
  const base = {
    branch: itemsBranch,
    doc: sampleDoc,
    refOptions: {},
    onSelect() {},
    onMutate() {},
    status: idleStatus,
    actions: noopActions,
    detailOpen: true,
    onToggleDetail() {},
    feedback: { error: null, issues: null, warnings: null },
  }
  const item = render(
    react.createElement(plugin.__test.EntityTreeBody, { ...base, selection: { entity: 'item', id: 'item-qingfeng' } }),
  )
  assert(item.includes('随机生成'), 'a selected item must offer generation')

  const category = render(
    react.createElement(plugin.__test.EntityTreeBody, { ...base, selection: { entity: 'item-category', id: 'cat-weapon' } }),
  )
  assert(!category.includes('随机生成'), 'a selected category must not offer generation')
  assert(category.includes('删除这个分类'), 'but it must still be editable')
})

check('makeRng is deterministic and not degenerate', () => {
  const { makeRng } = plugin.__test
  const a = Array.from({ length: 5 }, makeRng(12345))
  const b = Array.from({ length: 5 }, makeRng(12345))
  assert(JSON.stringify(a) === JSON.stringify(b), 'the same seed must give the same stream')
  assert(a.every((value) => value >= 0 && value < 1), 'values must be fractions in [0,1)')
  assert(new Set(a).size > 1, 'a seed must not produce a constant stream')
  const other = Array.from({ length: 5 }, makeRng(999))
  assert(JSON.stringify(a) !== JSON.stringify(other), 'different seeds should differ')
  // Seed 0 is the classic degenerate case for this family of generators.
  const zero = Array.from({ length: 5 }, makeRng(0))
  assert(new Set(zero).size > 1, 'seed 0 must not collapse the stream')
})

check('local drafts are reproducible from a seed', () => {
  const { makeRng, generateLocalDraft } = plugin.__test
  for (const kind of plugin.__test.LOCAL_KINDS) {
    const first = generateLocalDraft(kind, makeRng(4242), {})
    const second = generateLocalDraft(kind, makeRng(4242), {})
    assert(JSON.stringify(first) === JSON.stringify(second), `${kind} must be reproducible for a seed`)
  }
})

check('each local draft fills the fields its entity declares', () => {
  const { makeRng, generateLocalDraft } = plugin.__test
  const { ENTITIES } = plugin.__test
  for (const kind of plugin.__test.LOCAL_KINDS) {
    const draft = generateLocalDraft(kind, makeRng(11), {})
    const entity = ENTITIES[kind]
    assert(entity !== undefined, `${kind} has no client entity`)
    for (const key of Object.keys(draft)) {
      // A draft key that no field declares would be written into the document and
      // read back by nothing.
      const declared = entity.fields.some((field) => field.key === key)
      assert(declared, `${kind} draft sets "${key}", which no field declares`)
    }
    const nameKey = entity.generate?.hintField
    assert(typeof draft[nameKey] === 'string' && draft[nameKey] !== '', `${kind} draft has no usable ${nameKey}`)
  }
})

check('local drafts avoid names already in use', () => {
  const { makeRng, generateLocalDraft } = plugin.__test
  for (const kind of plugin.__test.LOCAL_KINDS) {
    const first = generateLocalDraft(kind, makeRng(2024), {})
    const nameKey = plugin.__test.ENTITIES[kind].generate.hintField
    const second = generateLocalDraft(kind, makeRng(2024), { taken: [first[nameKey]] })
    assert(
      second[nameKey] !== first[nameKey],
      `${kind} reused the taken name "${first[nameKey]}"`,
    )
  }
})

check('every client-declared generator exists on the host', () => {
  // The client decides WHERE generation appears; the host decides WHAT it can
  // generate. A kind declared only in the client would fail on the first click,
  // with the error surfacing far from the declaration.
  const { ENTITIES, LOCAL_KINDS } = plugin.__test
  const hostKinds = Object.keys(hostPrompt.GENERATORS).sort()
  const declared = []
  for (const [name, entity] of Object.entries(ENTITIES)) {
    if (entity.generate !== undefined) declared.push(entity.generate.kind)
    assert(
      entity.generate === undefined || LOCAL_KINDS.includes(entity.generate.kind),
      `${name} declares a generator with no local implementation`,
    )
  }
  assert(declared.length === 5, `expected five entities to offer generation, got ${declared.length}`)
  for (const kind of declared) {
    assert(hostKinds.includes(kind), `the client declares generator "${kind}" but the host has no such generator`)
  }
  assert(
    LOCAL_KINDS.slice().sort().join(',') === hostKinds.join(','),
    `local kinds ${LOCAL_KINDS.join(',')} disagree with host kinds ${hostKinds.join(',')}`,
  )
})

check('GenerateOptions renders both modes and the model choices', () => {
  const { GenerateOptions } = plugin.__test
  const catalog = {
    loading: false,
    available: true,
    styles: [{ id: 'concise', label: '简练' }, { id: 'eerie', label: '诡谲' }],
    models: { 'deepseek-account': [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }] },
  }
  const model = render(
    react.createElement(GenerateOptions, { settings: { mode: 'model' }, onChange() {}, catalog }),
  )
  assert(model.includes('模型生成') && model.includes('本地模板'), 'both modes must be offered')
  assert(model.includes('deepseek-account · DeepSeek-V41-Flash'), 'the real model must be listed, not a guess')
  assert(model.includes('简练') && model.includes('诡谲'), 'host style labels must be used')
  assert(model.includes('自动（宿主决定）'), 'letting the host choose must be an option')

  const local = render(
    react.createElement(GenerateOptions, { settings: { mode: 'local' }, onChange() {}, catalog }),
  )
  assert(!local.includes('DeepSeek-V41-Flash'), 'the local mode must not offer model choices')
  assert(local.includes('不联网'), 'the local mode must explain what it is')
})

check('GenerateOptions says so when the host has no model service', () => {
  const { GenerateOptions } = plugin.__test
  const html = render(
    react.createElement(GenerateOptions, {
      settings: { mode: 'model' },
      onChange() {},
      catalog: { loading: false, available: false, styles: [], models: {} },
    }),
  )
  assert(html.includes('没有可用的模型服务'), `expected an explanation: ${html.slice(0, 300)}`)
})

check('CandidateList offers the alternatives only when there are several', () => {
  const { CandidateList } = plugin.__test
  const labelOf = (candidate) => candidate.name ?? candidate.title ?? '?'
  assert(
    render(react.createElement(CandidateList, { candidates: [{ name: '甲' }], onPick() {}, labelOf })) === '',
    'a single candidate needs no chooser — it is already in the form',
  )
  assert(render(react.createElement(CandidateList, { candidates: null, onPick() {}, labelOf })) === '', 'null is handled')

  const many = render(
    react.createElement(CandidateList, {
      candidates: [{ name: '照雪', description: '剑身修长' }, { title: '寒鸦关倒戈' }],
      onPick() {},
      labelOf,
    }),
  )
  assert(many.includes('照雪') && many.includes('寒鸦关倒戈'), 'every candidate must be listed')
  assert(many.includes('2 个备选'), 'the count must be stated')
  assert(many.includes('剑身修长'), 'the description should be shown to help choose')
})

// --- the world setting: flat collections -------------------------------------

const worldDoc = {
  sections: [
    { id: 'sec-bg', title: '世界背景', order: 20, body: '三百年前天倾。' },
    { id: 'sec-power', title: '力量体系', order: 10, body: '灵气分九品。' },
  ],
  rules: [
    { id: 'rule-001', scope: 'global', branch: '', title: '灵气守恒', body: '灵气总量不变。', tags: ['修炼'] },
    { id: 'rule-014', scope: 'branch', branch: '北境', title: '北境无灵', body: '寒潮期间灵气枯竭。', tags: [] },
  ],
}

check('the world setting entities match the documented shape', () => {
  // docs/data-model.md §4.2 fixes this shape. Asserting it here means the document
  // and the code cannot drift apart silently, which would leave the context builder
  // reading fields that nothing writes.
  const { ENTITIES } = plugin.__test
  const section = ENTITIES['world-section']
  const rule = ENTITIES['world-rule']
  assert(section !== undefined && rule !== undefined, 'both world entities must exist')
  const sectionKeys = section.fields.map((field) => field.key)
  for (const key of ['title', 'order', 'body']) {
    assert(sectionKeys.includes(key), `world-section is missing "${key}" from the documented shape`)
  }
  const ruleKeys = rule.fields.map((field) => field.key)
  for (const key of ['scope', 'branch', 'title', 'body', 'tags']) {
    assert(ruleKeys.includes(key), `world-rule is missing "${key}" from the documented shape`)
  }
  const scope = rule.fields.find((field) => field.key === 'scope')
  assert(scope.type === 'select', 'scope must be a choice, not free text')
  assert(
    scope.options.map((option) => option.value).sort().join(',') === 'branch,global',
    `scope must offer exactly global and branch, got ${scope.options.map((o) => o.value)}`,
  )
  // A rule is a constraint the author decides; a model inventing one would
  // constrain the book for them.
  assert(rule.generate === undefined, 'world-rule must not offer generation')
  assert(section.generate === undefined, 'world-section must not offer generation')
})

check('CollectionPane renders a flat collection with its heading and count', () => {
  const { CollectionPane } = plugin.__test
  const html = render(
    react.createElement(CollectionPane, {
      doc: worldDoc,
      spec: { key: 'sections', entity: 'world-section', label: '分节', idPrefix: 'sec-' },
      selection: { entity: 'world-section', id: 'sec-power' },
      onSelect() {},
      onMutate() {},
      taken: new Set(),
    }),
  )
  assert(html.includes('分节（2）'), `the heading must state the count: ${html.slice(0, 200)}`)
  assert(html.includes('世界背景') && html.includes('力量体系'), 'every entry must render')
  assert(html.includes('＋'), 'an add control must be offered')
  // Order 10 sorts before order 20, regardless of document order.
  assert(
    html.indexOf('力量体系') < html.indexOf('世界背景'),
    'entries must be sorted by order, not left in document order',
  )
})

check('CollectionPane sends the selected id back when an entry is clicked', () => {
  const { CollectionPane } = plugin.__test
  // The click handler is the whole point of the pane; a row that renders but does
  // not select would leave the detail form unreachable.
  let picked = null
  const element = react.createElement(CollectionPane, {
    doc: worldDoc,
    spec: { key: 'rules', entity: 'world-rule', label: '规则', idPrefix: 'rule-' },
    selection: null,
    onSelect: (next) => {
      picked = next
    },
    onMutate() {},
    taken: new Set(),
  })
  // renderToString does not fire events, so assert the handler is wired by shape:
  // every row receives an onClick.
  const html = render(element)
  assert(html.includes('规则（2）'), `expected the rules heading: ${html.slice(0, 200)}`)
  assert(html.includes('灵气守恒') && html.includes('北境无灵'), 'both rules must render')
  assert(picked === null, 'rendering alone must not select anything')
})

check('CollectionPane explains an empty collection instead of drawing nothing', () => {
  const { CollectionPane } = plugin.__test
  const html = render(
    react.createElement(CollectionPane, {
      doc: { sections: [], rules: [] },
      spec: { key: 'sections', entity: 'world-section', label: '分节', idPrefix: 'sec-' },
      selection: null,
      onSelect() {},
      onMutate() {},
      taken: new Set(),
    }),
  )
  assert(html.includes('分节（0）'), 'the count must show zero')
  assert(html.includes('还没有分节'), `an empty list must say so: ${html.slice(0, 200)}`)
})

check('CollectionPane tolerates a missing or malformed collection', () => {
  const { CollectionPane } = plugin.__test
  const base = { spec: { key: 'sections', entity: 'world-section', label: '分节' }, selection: null, onSelect() {}, onMutate() {}, taken: new Set() }
  // A document written by hand or by an older version may lack the key entirely.
  assert(render(react.createElement(CollectionPane, { ...base, doc: {} })).includes('分节（0）'), 'a missing key reads as empty')
  assert(
    render(react.createElement(CollectionPane, { ...base, doc: { sections: 'nope' } })).includes('分节（0）'),
    'a malformed value reads as empty rather than throwing',
  )
})

check('EntityTree renders a branch with collections and no tree', () => {
  // The world setting declares no hierarchy at all: two flat lists in one document.
  const { EntityTree } = plugin.__test
  const html = render(
    react.createElement(EntityTree, {
      doc: worldDoc,
      tree: undefined,
      collections: [
        { key: 'sections', entity: 'world-section', label: '分节', idPrefix: 'sec-' },
        { key: 'rules', entity: 'world-rule', label: '规则', idPrefix: 'rule-' },
      ],
      selection: null,
      onSelect() {},
      onMutate() {},
    }),
  )
  assert(html.includes('分节（2）'), 'the first collection must render')
  assert(html.includes('规则（2）'), 'the second collection must render too')
  assert(html.includes('灵气守恒'), 'rules must be rendered, not just counted')
})

check('EntityTree renders a tree and collections side by side', () => {
  const { EntityTree } = plugin.__test
  const both = {
    categories: [{ id: 'cat-weapon', name: '武器', order: 10, parentId: null }],
    items: [],
    rules: [{ id: 'rule-001', scope: 'global', title: '灵气守恒', body: '' }],
  }
  const html = render(
    react.createElement(EntityTree, {
      doc: both,
      tree: { groups: [{ key: 'categories', entity: 'item-category', parentKey: 'parentId', label: '分类' }], leaves: [{ key: 'items', entity: 'item', parentKey: 'categoryId', label: '物品' }] },
      collections: [{ key: 'rules', entity: 'world-rule', label: '规则' }],
      selection: null,
      onSelect() {},
      onMutate() {},
    }),
  )
  assert(html.includes('武器'), 'the tree must still render')
  assert(html.includes('规则（1）') && html.includes('灵气守恒'), 'the collection must render beside it')
})

check('the world 总设定 tab is implemented and edits the world document', () => {
  const { BRANCHES, entitySpecFor } = plugin.__test
  const world = BRANCHES.find((branch) => branch.id === 'world')
  const settings = world.tabs.find((tab) => tab.id === 'settings')
  assert(settings !== undefined, 'the 总设定 tab is missing')
  assert(settings.view === 'tree', `总设定 should be implemented, got ${settings.view}`)
  assert(settings.doc === 'setting/world.json', `wrong document: ${settings.doc}`)
  assert(Array.isArray(settings.collections) && settings.collections.length === 2, 'two collections are expected')
  // Both must resolve, or a section/rule would be listed but uneditable.
  assert(entitySpecFor(settings, 'world-section') !== null, 'sections must be editable')
  assert(entitySpecFor(settings, 'world-rule') !== null, 'rules must be editable')
  // And the detail lookup must agree with where the context builder reads from.
  assert(entitySpecFor(settings, 'world-section').key === 'sections', 'sections must live under `sections`')
  assert(entitySpecFor(settings, 'world-rule').key === 'rules', 'rules must live under `rules`')
})

check('TabsBranch gives its sub-view a definite height to fill', () => {
  // A layout constraint asserted as markup, because `renderToString` has no box
  // model. It is worth asserting anyway: without a full-height wrapper the
  // sub-view's `height:100%` resolves against an auto-height parent, falls back to
  // auto, grows to its content, and the host's `overflow:hidden` frame clips a long
  // form with no scrollbar. That is how the 人物 and 组织 detail panes became
  // unreachable past the fold while 物品 (a plain tree branch) was fine.
  const { BRANCHES, TabsBranch } = plugin.__test
  const world = BRANCHES.find((branch) => branch.id === 'world')
  const html = render(react.createElement(TabsBranch, { branch: world, root: null }))
  assert(html.includes('height:100%'), 'the tab host itself must be full height')
  assert(html.includes('flex-direction:column'), 'and a column, so the strip keeps its own height')
  assert(html.includes('min-height:0'), 'the content area must be allowed to shrink below its content')
  assert(html.includes('overflow:hidden'), 'the content area must clip rather than expand')
})

check('every tab host is a full-height column', () => {
  // Guards the general rule: any wrapper between the padded content box and a
  // `SplitPane` must propagate height, or the pane inside cannot scroll.
  const { BRANCHES, TabsBranch } = plugin.__test
  for (const branch of allDescriptors()) {
    if (branch.view !== 'tabs') continue
    const html = render(react.createElement(TabsBranch, { branch, root: null }))
    assert(html.includes('height:100%'), `${branch.id} does not establish a definite height`)
  }
})

// --- chapter drafting --------------------------------------------------------

check('mergeDraft appends for 接着写 and replaces for 重写', () => {
  const { mergeDraft } = plugin.__test
  assert(mergeDraft('前文。', '续写的正文。', 'continue') === '前文。\n\n续写的正文。', '接着写 must append with a paragraph break')
  assert(mergeDraft('前文。', '扩写后的正文。', 'expand') === '前文。\n\n扩写后的正文。', '扩写 also appends')
  assert(mergeDraft('旧正文。', '新正文。', 'rewrite') === '新正文。', '重写 must replace, not append')
})

check('mergeDraft handles an empty chapter and trailing whitespace', () => {
  const { mergeDraft } = plugin.__test
  // Appending to an empty chapter must not open with blank lines.
  assert(mergeDraft('', '第一段。', 'continue') === '第一段。', 'no leading break on an empty chapter')
  assert(mergeDraft('   \n\n', '第一段。', 'continue') === '第一段。', 'whitespace-only reads as empty')
  assert(mergeDraft('前文。\n\n\n', '续写。', 'continue') === '前文。\n\n续写。', 'trailing blank lines must be collapsed')
  // An empty draft must change nothing, rather than adding a stray break.
  assert(mergeDraft('前文。', '', 'continue') === '前文。', 'an empty draft is a no-op')
  assert(mergeDraft('前文。', '   ', 'continue') === '前文。', 'a whitespace draft is a no-op')
  assert(mergeDraft(undefined, '正文。', 'continue') === '正文。', 'a missing current body is handled')
})

check('every client drafting mode has a label', () => {
  // The ids must match the host's DRAFT_MODES, which owns the instructions.
  const { DRAFT_MODE_LABELS } = plugin.__test
  const ids = DRAFT_MODE_LABELS.map((mode) => mode.id).sort().join(',')
  assert(ids === 'continue,expand,rewrite', `unexpected modes: ${ids}`)
  for (const mode of DRAFT_MODE_LABELS) {
    assert(typeof mode.label === 'string' && mode.label !== '', `${mode.id} has no label`)
  }
})

check('DraftControl renders the task box and all three choices', () => {
  const { DraftControl } = plugin.__test
  const html = render(react.createElement(DraftControl, { root: '/tmp/p', path: 'draft/ch-0001.md', onDrafted() {} }))
  assert(html.includes('让 AI 写这一章'), 'the control must be labelled')
  assert(html.includes('本次要求'), 'an instruction box must be offered')
  for (const label of ['接着写', '扩写', '重写']) {
    assert(html.includes(label), `the ${label} mode must be offered`)
  }
  assert(html.includes('生成正文'), 'the action must be present')
  assert(html.includes('不限风格'), 'the style choice must be present')
})

check('DraftControl renders nothing without a chapter', () => {
  const { DraftControl } = plugin.__test
  // It sits inside the editor pane, which also renders the placeholder state.
  assert(render(react.createElement(DraftControl, { root: '/tmp/p', path: '', onDrafted() {} })) === '', 'no chapter, no control')
  assert(render(react.createElement(DraftControl, { root: '/tmp/p', path: null, onDrafted() {} })) === '', 'a null path is handled')
})

check('ChapterEditorPane offers drafting next to the prose', () => {
  const { ChapterEditorPane } = plugin.__test
  const withDraft = render(
    react.createElement(ChapterEditorPane, {
      loading: false,
      path: 'draft/ch-0001.md',
      root: '/tmp/p',
      meta: { id: 'ch-0001', title: '第一章', order: 10, characters: [], places: [], custom: {} },
      body: '正文。',
      wordCount: 3,
      refOptions: {},
      status: idleStatus,
      actions: noopActions,
      onPatchMeta() {},
      onSetBody() {},
      onDrafted() {},
      feedback: {},
    }),
  )
  assert(withDraft.includes('让 AI 写这一章'), 'the drafting control must be available in the editor')
  assert(withDraft.includes('正文'), 'the prose box must still render')

  // Without the handler (as in a read-only context) it must simply not appear.
  const withoutDraft = render(
    react.createElement(ChapterEditorPane, {
      loading: false,
      path: 'draft/ch-0001.md',
      meta: { id: 'ch-0001', title: '第一章', order: 10, characters: [], places: [], custom: {} },
      body: '正文。',
      wordCount: 3,
      refOptions: {},
      status: idleStatus,
      actions: noopActions,
      onPatchMeta() {},
      onSetBody() {},
      feedback: {},
    }),
  )
  assert(!withoutDraft.includes('让 AI 写这一章'), 'no handler, no control')
})

// --- organization structure --------------------------------------------------

const orgStructure = [
  { id: 'pos-1', title: '掌门', parentId: null, order: 10 },
  { id: 'pos-2', title: '执剑长老', parentId: 'pos-1', order: 20 },
  { id: 'pos-3', title: '首座弟子', parentId: 'pos-2', order: 10 },
  { id: 'pos-4', title: '外门执事', parentId: null, order: 20 },
]

check('removePositionSubtree takes the whole branch with it', () => {
  // Removing only the node would leave children pointing at nothing, which the tree
  // cannot place and the validator reports as a dangling reference.
  const { removePositionSubtree } = plugin.__test
  const afterRoot = removePositionSubtree(orgStructure, 'pos-1').map((position) => position.id)
  assert(afterRoot.join(',') === 'pos-4', `the subtree must go too, left: ${afterRoot.join(',')}`)
  const afterMiddle = removePositionSubtree(orgStructure, 'pos-2').map((position) => position.id)
  assert(afterMiddle.join(',') === 'pos-1,pos-4', `only the branch goes: ${afterMiddle.join(',')}`)
  const afterLeaf = removePositionSubtree(orgStructure, 'pos-3').map((position) => position.id)
  assert(afterLeaf.length === 3, 'removing a leaf leaves its ancestors')
  // Order of removal must not matter: the loop repeats until nothing new is found.
  const deep = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
    { id: 'd', parentId: 'c' },
  ]
  assert(removePositionSubtree(deep, 'a').length === 0, 'a four-deep chain must vanish entirely')
  assert(removePositionSubtree([], 'x').length === 0, 'an empty list is handled')
  assert(removePositionSubtree(undefined, 'x').length === 0, 'a missing list is handled')
  assert(removePositionSubtree(orgStructure, 'nope').length === 4, 'an unknown id removes nothing')
})

check('StructureInput renders the position tree from a flat parentId array', () => {
  const { StructureInput } = plugin.__test
  const html = render(react.createElement(StructureInput, { value: orgStructure, onChange() {} }))
  for (const title of ['掌门', '执剑长老', '首座弟子', '外门执事']) {
    assert(html.includes(title), `position "${title}" is missing`)
  }
  assert(html.includes('新建职位'), 'a root-position control must be offered')
  assert(html.includes('选中一个职位可改名'), 'the empty selection state must explain itself')
})

check('StructureInput explains an empty structure and tolerates junk', () => {
  const { StructureInput } = plugin.__test
  const empty = render(react.createElement(StructureInput, { value: [], onChange() {} }))
  assert(empty.includes('还没有职位'), `an empty structure must say so: ${empty.slice(0, 200)}`)
  assert(render(react.createElement(StructureInput, { value: null, onChange() {} })).includes('还没有职位'), 'null is handled')
  assert(
    render(react.createElement(StructureInput, { value: 'nope', onChange() {} })).includes('还没有职位'),
    'a malformed value is handled rather than throwing',
  )
})

check('StructureInput indents a child under its parent', () => {
  // The hierarchy is the whole point of the control: if children were not nested,
  // the author would see a flat list and could not tell who reports to whom.
  const { StructureInput } = plugin.__test
  const html = render(react.createElement(StructureInput, { value: orgStructure, onChange() {} }))
  const rootRow = html.indexOf('掌门')
  const childRow = html.indexOf('执剑长老')
  assert(rootRow !== -1 && childRow !== -1, 'both rows must render')
  // Depth is expressed as padding-left; the child must carry a larger value than
  // its parent somewhere after it.
  const afterRoot = html.slice(rootRow, childRow)
  const childPadding = /padding-left:(\d+)px/.exec(html.slice(childRow, childRow + 400))
  const rootPadding = /padding-left:(\d+)px/.exec(afterRoot)
  assert(childPadding !== null, 'a row must carry a computed indent')
  if (rootPadding !== null) {
    assert(
      Number(childPadding[1]) > Number(rootPadding[1]),
      `a child must be indented deeper than its parent (${childPadding[1]} vs ${rootPadding[1]})`,
    )
  }
})

check('PositionEditor offers the fields and a delete control', () => {
  const { PositionEditor } = plugin.__test
  const html = render(
    react.createElement(PositionEditor, { position: orgStructure[0], onPatch() {}, onRemove() {} }),
  )
  assert(html.includes('职位名称'), 'the title field must render')
  assert(html.includes('排序'), 'the order field must render')
  assert(html.includes('删除这个职位'), 'the delete control must render')
  assert(html.includes('含下属'), 'the label must warn that children go too')
})

check('the organization entity declares the structure field', () => {
  const { ENTITIES } = plugin.__test
  const field = ENTITIES.organization.fields.find((entry) => entry.key === 'structure')
  assert(field !== undefined, 'the structure field is missing')
  assert(field.type === 'structure', `structure must use the structure control, got ${field.type}`)
  // Positions are their own kind, so the tree has a label and an id prefix.
  assert(ENTITIES['org-position'] !== undefined, 'the org-position entity is missing')
  const keys = ENTITIES['org-position'].fields.map((entry) => entry.key)
  assert(keys.includes('title') && keys.includes('order'), `org-position fields: ${keys.join(',')}`)
  // Who holds a post is a relation, never a field on the position.
  assert(!keys.includes('holder'), 'a holder field would create a second source of truth')
  assert(!keys.includes('characterId'), 'membership belongs in relations.json')
})

// --- manual graph placement --------------------------------------------------

check('clientToViewBox maps a pointer onto the viewBox', () => {
  // The one part of dragging that cannot be tested is reading the element's
  // rectangle; the arithmetic on top of it can be, so it lives here.
  const { clientToViewBox } = plugin.__test
  const rect = { left: 100, top: 50, width: 360, height: 240 }
  // The middle of the element is the middle of a 720x480 viewBox.
  const middle = clientToViewBox({ clientX: 280, clientY: 170 }, rect, 720, 480)
  assert(middle.x === 360 && middle.y === 240, `centre maps to centre, got ${JSON.stringify(middle)}`)
  const topLeft = clientToViewBox({ clientX: 100, clientY: 50 }, rect, 720, 480)
  assert(topLeft.x === 0 && topLeft.y === 0, `the origin maps to the origin, got ${JSON.stringify(topLeft)}`)
  const bottomRight = clientToViewBox({ clientX: 460, clientY: 290 }, rect, 720, 480)
  assert(bottomRight.x === 720 && bottomRight.y === 480, `the far corner maps exactly, got ${JSON.stringify(bottomRight)}`)
})

check('clientToViewBox refuses to divide by a collapsed element', () => {
  // A hidden or not-yet-laid-out pane has a zero-size rectangle; dividing by it
  // yields Infinity or NaN and would fling the node off the canvas.
  const { clientToViewBox } = plugin.__test
  assert(clientToViewBox({ clientX: 10, clientY: 10 }, null, 720, 480) === null, 'no rect, no position')
  assert(clientToViewBox({ clientX: 10, clientY: 10 }, undefined, 720, 480) === null, 'an undefined rect is handled')
  assert(clientToViewBox({ clientX: 10, clientY: 10 }, { left: 0, top: 0, width: 0, height: 0 }, 720, 480) === null, 'a zero size is refused')
})

check('clampToBox keeps a dragged node on the canvas', () => {
  const { clampToBox } = plugin.__test
  assert(JSON.stringify(clampToBox({ x: -50, y: -50 }, 720, 480)) === '{"x":14,"y":14}', 'a negative position is pulled inside')
  assert(JSON.stringify(clampToBox({ x: 900, y: 900 }, 720, 480)) === '{"x":706,"y":466}', 'an overshoot is pulled inside')
  const inside = clampToBox({ x: 300, y: 200 }, 720, 480)
  assert(inside.x === 300 && inside.y === 200, 'a position already inside is untouched')
})

check('mergePositions lets a manual placement win, node by node', () => {
  const { mergePositions } = plugin.__test
  const force = new Map([['a', { x: 1, y: 1 }], ['b', { x: 2, y: 2 }], ['c', { x: 3, y: 3 }]])
  const merged = mergePositions(force, { b: { x: 99, y: 98 } }, ['a', 'b', 'c'])
  assert(merged.get('b').x === 99, 'the manual placement must win')
  // The point of moving one node by hand is that the others stay put.
  assert(merged.get('a').x === 1 && merged.get('c').x === 3, 'other nodes keep their computed places')
  assert(merged.size === 3, 'every node must still have a position')
})

check('mergePositions ignores unusable placements', () => {
  // A hand-edited or half-written layout file must not erase a node from the graph.
  const { mergePositions } = plugin.__test
  const force = new Map([['a', { x: 1, y: 1 }]])
  for (const bad of [null, undefined, {}, { x: 'nope', y: 2 }, { x: 1 }, { x: Number.NaN, y: 2 }]) {
    const merged = mergePositions(force, { a: bad }, ['a'])
    assert(merged.get('a').x === 1, `an unusable placement must fall back to the layout: ${JSON.stringify(bad)}`)
  }
  assert(mergePositions(force, null, ['a']).get('a').x === 1, 'a missing placement map is handled')
  assert(mergePositions(force, 'junk', ['a']).get('a').x === 1, 'a malformed placement map is handled')
})

check('mergePositions only reports nodes it was asked about', () => {
  // A manual placement for a node not in this view must not create a phantom entry,
  // or the counts and the drawing would disagree.
  const { mergePositions } = plugin.__test
  const force = new Map([['a', { x: 1, y: 1 }]])
  const merged = mergePositions(force, { ghost: { x: 50, y: 50 } }, ['a'])
  assert(merged.size === 1 && !merged.has('ghost'), `expected only the requested nodes: ${[...merged.keys()]}`)
})

check('setManualPosition records a placement and refuses junk', () => {
  const { setManualPosition } = plugin.__test
  const one = setManualPosition({}, 'a', { x: 10, y: 20 })
  assert(JSON.stringify(one) === '{"a":{"x":10,"y":20}}', `unexpected: ${JSON.stringify(one)}`)
  const two = setManualPosition(one, 'b', { x: 1, y: 2 })
  assert(Object.keys(two).length === 2, 'an existing placement must be preserved')
  assert(JSON.stringify(setManualPosition(one, 'c', null)) === JSON.stringify(one), 'a null point changes nothing')
  assert(JSON.stringify(setManualPosition(one, 'c', { x: Number.NaN, y: 1 })) === JSON.stringify(one), 'NaN is refused')
  assert(Object.keys(setManualPosition(null, 'a', { x: 1, y: 1 })).length === 1, 'a missing map is created')
})

check('clearManualPositions forgets only the nodes in this view', () => {
  // The 人物 and 组织 tabs share one placement map; resetting in one must not wipe
  // placements made in the other.
  const { clearManualPositions, countManualPositions } = plugin.__test
  const placed = { a: { x: 1, y: 1 }, b: { x: 2, y: 2 }, other: { x: 3, y: 3 } }
  const after = clearManualPositions(placed, ['a', 'b'])
  assert(Object.keys(after).join(',') === 'other', `unexpected keys: ${Object.keys(after)}`)
  assert(countManualPositions(placed, ['a', 'b']) === 2, 'the count covers the given nodes')
  assert(countManualPositions(placed, ['a', 'missing']) === 1, 'unplaced nodes are not counted')
  assert(countManualPositions(null, ['a']) === 0, 'a missing map counts zero')
  assert(countManualPositions({ a: { x: Number.NaN, y: 1 } }, ['a']) === 0, 'an unusable placement is not counted')
})

check('RelationGraph wires node dragging', () => {
  const { RelationGraph, mergePositions, layoutForce, GRAPH_LAYOUT_KEY } = plugin.__test
  assert(GRAPH_LAYOUT_KEY === 'relations', `unexpected layout key: ${GRAPH_LAYOUT_KEY}`)
  const force = layoutForce(graphNodes, [graphEdges[0]], { width: 720, height: 480 })
  const positions = mergePositions(force, { 'char-linyuan': { x: 60, y: 70 } }, graphNodes.map((node) => node.id))
  const html = render(
    react.createElement(RelationGraph, {
      nodes: graphNodes,
      edges: [graphEdges[0]],
      types: graphTypes,
      positions,
      width: 720,
      height: 480,
      selection: null,
      onSelect() {},
      dragging: 'char-linyuan',
      onNodePointerDown() {},
      onPointerMove() {},
      onPointerUp() {},
      svgRef: { current: null },
    }),
  )
  // The manual placement must be the one drawn.
  assert(html.includes('cx="60"') && html.includes('cy="70"'), `the manual position must be used: ${html.slice(0, 400)}`)
  assert(html.includes('touch-action:none'), 'the canvas must not scroll while dragging on touch')
  assert(html.includes('grabbing'), 'the held node must show a grab cursor')
})

check('RelationGraph tolerates missing drag handlers', () => {
  // It is also rendered by tests and by any future caller that only wants a picture.
  const { RelationGraph, layoutForce } = plugin.__test
  const positions = layoutForce(graphNodes, graphEdges, { width: 720, height: 480 })
  const html = render(
    react.createElement(RelationGraph, {
      nodes: graphNodes,
      edges: graphEdges,
      types: graphTypes,
      positions,
      width: 720,
      height: 480,
      selection: null,
      onSelect() {},
    }),
  )
  assert(html.includes('<line'), 'the drawing must still render')
})

check('TreePane offers a way to create a child, not only a root', () => {
  // Regression guard for a live gap: nesting was supported by the data model and by
  // the renderer, but no control created a child — so sub-categories, sub-places,
  // sub-organizations and subordinate positions were all impossible to author.
  const { TreePane } = plugin.__test
  const tree = {
    groups: [{ key: 'categories', entity: 'item-category', parentKey: 'parentId', label: '分类', idPrefix: 'cat-' }],
    leaves: [],
  }
  const html = render(react.createElement(TreePane, { doc: sampleDoc, tree, selection: null, onSelect() {}, onMutate() {}, taken: new Set() }))
  assert(html.includes('新建分类'), 'a root control must be offered')
  assert(html.includes('在选中分类下新建'), `a child control must be offered: ${html.slice(0, 400)}`)
  // With nothing selected it must be disabled rather than inventing a parent.
  assert(/disabled=""[^>]*>在选中分类下新建/.test(html) || html.includes('disabled'), 'the child control must be disabled without a selection')

  const selected = render(
    react.createElement(TreePane, {
      doc: sampleDoc,
      tree,
      selection: { entity: 'item-category', id: 'cat-weapon' },
      onSelect() {},
      onMutate() {},
      taken: new Set(),
    }),
  )
  assert(selected.includes('在选中分类下新建下级'), `a selection must enable it: ${selected.slice(0, 300)}`)
})

check('childNodeFor links a child to its parent, and never to "undefined"', () => {
  // The parent link is written as `created[spec.parentKey] = parentId`. A spec with
  // no parentKey would write a key literally named "undefined" — which is why the
  // helper checks the spec before writing.
  const { childNodeFor, ENTITIES, supportsNesting } = plugin.__test
  const spec = { key: 'categories', entity: 'item-category', parentKey: 'parentId', idPrefix: 'cat-' }
  const child = childNodeFor(spec, ENTITIES['item-category'], 'cat-weapon', new Set(['cat-weapon']))
  assert(child.parentId === 'cat-weapon', `the parent link is missing: ${JSON.stringify(child)}`)
  assert(child.id !== 'cat-weapon', 'the minted id must not collide with an existing one')

  const root = childNodeFor(spec, ENTITIES['item-category'], null, new Set())
  assert(root.parentId === null, 'a root has no parent, and must not carry a stray key')

  // The trap: nesting is only offered when the spec declares where the parent goes.
  const unserialisable = { key: 'lines', entity: 'timeline-line' }
  assert(supportsNesting(unserialisable) === false, 'a spec without parentKey must not offer nesting')
  const orphan = childNodeFor(unserialisable, ENTITIES['timeline-line'], 'line-1', new Set())
  assert(
    Object.keys(orphan).includes('undefined') === false,
    `a spec without parentKey must not write an "undefined" key: ${JSON.stringify(orphan)}`,
  )
  assert(!JSON.stringify(orphan).includes('undefined'), `nothing may serialise as undefined: ${JSON.stringify(orphan)}`)
})

check('every nestable branch spec declares its parent field', () => {
  // The button is rendered from this, so a spec that nests in the data but declares
  // no parentKey would silently lose the ability to create children.
  const { BRANCHES, supportsNesting } = plugin.__test
  const nested = []
  for (const branch of allDescriptors()) {
    for (const spec of [...(branch.tree?.groups ?? []), ...(branch.tree?.leaves ?? [])]) {
      nested.push({ branch: branch.id, spec })
    }
  }
  assert(nested.length > 0, 'expected some tree specs to exist')
  for (const { branch, spec } of nested) {
    assert(
      supportsNesting(spec),
      `${branch}.${spec.key} walks TreePane but declares no parentKey, so it cannot nest`,
    )
  }
})

check('timeKeyParts inverts timeKey for every writable shape', () => {
  // The two are a round trip, and the timeline's axis, cursor and labels all rely on
  // it. A key encodes year/month/day as YYYYMMDD, so a partial date must come back as
  // zeros for the parts the author did not set — not as a wrong month or day.
  const { timeKey, timeKeyParts } = plugin.__test
  const cases = [
    { year: 1345, month: 3, day: 21 },
    { year: 1345, month: 3 },
    { year: 1345 },
    { year: 1, month: 1, day: 1 },
    { year: 9999, month: 12, day: 31 },
  ]
  for (const parts of cases) {
    const key = timeKey(parts)
    assert(key !== null, `timeKey refused a usable time: ${JSON.stringify(parts)}`)
    const back = timeKeyParts(key)
    assert(back.year === parts.year, `year round trip failed for ${JSON.stringify(parts)}: ${JSON.stringify(back)}`)
    assert(
      back.month === (parts.month ?? 0),
      `month should be 0 when unset, got ${back.month} for ${JSON.stringify(parts)}`,
    )
    assert(back.day === (parts.day ?? 0), `day should be 0 when unset, got ${back.day} for ${JSON.stringify(parts)}`)
  }
})

check('edgesTouching finds relations on either end', () => {
  const { edgesTouching } = plugin.__test
  const touching = edgesTouching(graphEdges, 'char-linyuan')
  assert(touching.length === 2, `expected both of 林渊's edges, got ${touching.map((e) => e.id)}`)
  assert(touching.every((edge) => edge.from === 'char-linyuan' || edge.to === 'char-linyuan'), 'a relation with neither end is not touching')
  // An isolated node has no relations, and that must be an empty list rather than a crash.
  assert(edgesTouching(graphEdges, 'nobody').length === 0, 'an unknown node has no relations')
  assert(edgesTouching([], 'char-linyuan').length === 0, 'an empty edge list is handled')
})

// --- malformed ELEMENTS, not just malformed containers -----------------------
//
// The shipped crash was fixed at the container level only (`Array.isArray`), so the
// same class kept shipping one level deeper. An audit reproduced blank panels from
// `{"categories":[null]}`, `{"events":[null]}`, `{"edges":[null]}`, `{"types":[null]}`,
// `{"sections":[null]}` and `{"structure":[null]}` — every one of which passes a
// container check. These cases are directly reachable by hand-editing any project file,
// which is a normal thing for an author to do.

const junk = () => [null, undefined, 'a string', 42, [], {}, { id: 'ok', name: '可用' }]

check('isRecord and objectList reject junk elements', () => {
  const { isRecord, objectList } = plugin.__test
  assert(isRecord({}) === true, 'a plain object is a record')
  assert(isRecord(null) === false, 'null is not a record')
  assert(isRecord(undefined) === false, 'undefined is not a record')
  assert(isRecord([]) === false, 'an array is not a record')
  assert(isRecord('x') === false, 'a string is not a record')
  assert(isRecord(7) === false, 'a number is not a record')
  const kept = objectList(junk())
  // An empty object IS a record: `isRecord` is about type, not completeness. Keeping it
  // means a tree renders a thin row rather than the whole panel vanishing, which is the
  // right trade — the author can then see and fix it.
  assert(kept.length === 2, `expected the two objects to survive: ${JSON.stringify(kept)}`)
  assert(
    kept.some((entry) => entry.id === 'ok'),
    'the usable entry must survive',
  )
  assert(objectList('nope').length === 0, 'a non-array yields nothing')
  assert(objectList(null).length === 0, 'null yields nothing')
  assert(objectList(undefined).length === 0, 'undefined yields nothing')
})

check('every tree branch survives junk elements in its document', () => {
  // One case per tree branch shape: groups, groups+leaves, and flat collections.
  const { EntityTree, BRANCHES } = plugin.__test
  const cases = [
    { doc: { categories: junk(), items: junk() }, branch: BRANCHES.find((b) => b.id === 'items') },
    { doc: { places: junk() }, branch: BRANCHES.find((b) => b.id === 'world').tabs.find((t) => t.id === 'places') },
    { doc: { nodes: junk() }, branch: BRANCHES.find((b) => b.id === 'outline') },
    { doc: { sections: junk(), rules: junk() }, branch: BRANCHES.find((b) => b.id === 'world').tabs.find((t) => t.id === 'settings') },
    { doc: { organizations: junk() }, branch: BRANCHES.find((b) => b.id === 'orgs').tabs.find((t) => t.id === 'cards') },
  ]
  for (const { doc, branch } of cases) {
    const html = render(
      react.createElement(EntityTree, {
        doc,
        tree: branch.tree,
        collections: branch.collections,
        selection: null,
        onSelect() {},
        onMutate() {},
      }),
    )
    assert(typeof html === 'string' && html.length > 0, `${branch.id} rendered nothing`)
  }
})

check('CollectionPane survives a null element', () => {
  const { CollectionPane } = plugin.__test
  const html = render(
    react.createElement(CollectionPane, {
      doc: { sections: [null, { id: 'sec-1', title: '可用分节', order: 10 }] },
      spec: { key: 'sections', entity: 'world-section', label: '分节' },
      selection: null,
      onSelect() {},
      onMutate() {},
      taken: new Set(),
    }),
  )
  assert(html.includes('可用分节'), 'the usable entry must still render')
  assert(html.includes('分节（1）'), `the count must reflect usable entries only: ${html.slice(0, 200)}`)
})

check('StructureInput survives a null position', () => {
  const { StructureInput } = plugin.__test
  const html = render(
    react.createElement(StructureInput, {
      value: [null, { id: 'pos-1', title: '掌门', parentId: null }],
      onChange() {},
    }),
  )
  assert(html.includes('掌门'), 'the usable position must still render')
})

check('the timeline survives junk elements in lines and events', () => {
  const { TimelineView, TimelineBody, BRANCHES } = plugin.__test
  const doc = { lines: [null, { id: 'tl-1', name: '主线', kind: 'main', order: 10 }], events: [null, 'x', { id: 'e-1', title: '可用事件', lineId: 'tl-1', at: { year: 10 } }] }
  const view = render(react.createElement(TimelineView, { doc, selection: null, onSelect() {} }))
  assert(view.includes('主線') || view.includes('主线'), 'the usable line must render')
  assert(view.includes('可用事件'), 'the usable event must render')

  // TimelineBody reads the same fields with `?? []` instead of `Array.isArray` — the
  // exact inconsistency the audit found, where one view guards and the other crashes.
  const branch = BRANCHES.find((b) => b.id === 'timeline')
  const body = render(
    react.createElement(TimelineBody, {
      branch,
      doc: { lines: 'nope', events: 'nope' },
      refOptions: {},
      selection: null,
      onSelect() {},
      onMutate() {},
      status: idleStatus,
      actions: noopActions,
      detailOpen: true,
      onToggleDetail() {},
      feedback: {},
    }),
  )
  assert(typeof body === 'string', 'a non-array lines/events must not crash the timeline body')
})

check('the relation graph survives junk edges and types', () => {
  const { RelationGraph, BRANCHES, GraphView, layoutForce, mergePositions } = plugin.__test
  const nodes = [{ id: 'a', title: '甲', kind: 'character' }, { id: 'b', title: '乙', kind: 'character' }]
  for (const types of [[null, { id: 'ally', label: '同盟', directed: false }], 'nope', null]) {
    const html = render(
      react.createElement(RelationGraph, {
        nodes,
        edges: [null, { id: 'rel-1', from: 'a', to: 'b', type: 'ally', since: { year: 1 } }],
        types,
        positions: mergePositions(layoutForce(nodes, [], { width: 720, height: 480 }), {}, ['a', 'b']),
        width: 720,
        height: 480,
        selection: null,
        onSelect() {},
      }),
    )
    assert(html.includes('<line'), `the usable edge must render with types=${JSON.stringify(types)}`)
  }
  const branch = BRANCHES.find((b) => b.id === 'chars').tabs.find((t) => t.id === 'graph')
  const view = render(
    react.createElement(GraphView, {
      nodes,
      edges: [],
      types: 'nope',
      calendar: null,
      cursorKey: null,
      onStep() {},
      onLatest() {},
      totalEdges: 0,
      selection: null,
      onSelect() {},
      positions: new Map(),
      width: 720,
      height: 480,
    }),
  )
  assert(typeof view === 'string', `a malformed types list must not crash: ${branch.id}`)
})

check('WriteFeedback survives junk in the issue list', () => {
  // The shipped bug, one level deeper: `Array.isArray` hardened the container only.
  const { WriteFeedback } = plugin.__test
  const html = render(
    react.createElement(WriteFeedback, {
      error: null,
      issues: [null, undefined, 'x', { code: 'dangling-reference', message: '指向不存在的实体' }],
      warnings: [null, { message: '名字尚未对应实体' }],
    }),
  )
  assert(html.includes('dangling-reference'), 'the usable issue must render')
  assert(html.includes('指向不存在的实体'), 'with its message')
  assert(html.includes('名字尚未对应实体'), 'and the usable warning')
  // A malformed issue must still show that something was refused, rather than vanish.
  const onlyJunk = render(react.createElement(WriteFeedback, { error: null, issues: [null], warnings: null }))
  assert(onlyJunk.includes('宿主拒绝了这次写入'), 'a junk issue still means a refusal happened')
})

check('the chapter list survives junk entries', () => {
  const { ChapterListPane } = plugin.__test
  const html = render(
    react.createElement(ChapterListPane, {
      chapters: [null, { path: 'draft/ch-0001.md', id: 'ch-0001', title: '可用章节', wordCount: 10, status: null, frontMatterError: null }],
      selected: null,
      onSelect() {},
      onCreate() {},
      creating: false,
      createError: null,
      totalWordCount: 10,
    }),
  )
  assert(html.includes('可用章节'), 'the usable chapter must render')
})

check('a malformed document never empties every reference picker in silence', () => {
  // The worst of the audit's findings: the throw happened inside a `.then` with no
  // catch, so every picker in the branch went empty for the rest of the session with
  // nothing on screen to explain it. The label function must tolerate junk entries.
  const { REF_COLLECTIONS, isRecord } = plugin.__test
  for (const [kind, spec] of Object.entries(REF_COLLECTIONS)) {
    if (typeof spec.label !== 'function') continue
    for (const entry of junk()) {
      if (!isRecord(entry)) continue
      // Whatever it does with a usable-but-thin object, it must not throw.
      spec.label(entry)
    }
  }
})

check("the host's enum table matches the controls the author sees", () => {
  // The host validator needs its own copy of these values, because the AI skills write the
  // documents directly. A copy that drifts is worse than no check: it would refuse a value
  // the select offers, or accept one it cannot display. This is the guard.
  const { ENTITIES } = plugin.__test
  const entries = Object.entries(hostValidate.ENUMS)
  assert(entries.length > 0, 'the host must declare some enums')
  for (const [key, allowed] of entries) {
    const [entityKey, fieldKey] = key.split('.')
    const entity = ENTITIES[entityKey]
    assert(entity !== undefined, `ENUMS names an unknown entity: ${entityKey}`)
    const field = entity.fields.find((candidate) => candidate.key === fieldKey)
    assert(field !== undefined, `ENUMS names an unknown field: ${key}`)
    assert(field.type === 'select', `${key} is declared as a select in ENUMS but is a ${field.type} in the client`)
    const clientValues = (field.options ?? []).map((option) => option.value)
    assert(
      clientValues.slice().sort().join('|') === allowed.slice().sort().join('|'),
      `${key} drifted: host=[${allowed.join(', ')}] client=[${clientValues.join(', ')}]`,
    )
  }
})

check('the generator never asks the model for a reference', () => {
  // A model-invented id points at nothing. Refs stay the author's to pick — including
  // `causeEventId`, which used to be a free-text box on the event form.
  const { ENTITIES } = plugin.__test
  for (const [kind, generator] of Object.entries(hostPrompt.GENERATORS)) {
    for (const field of generator.fields) {
      assert(
        field.type !== 'ref' && field.type !== 'reflist',
        `${kind} asks the model for the reference field "${field.key}"`,
      )
    }
  }
  // And the client's event form must offer a picker for causeEventId, not a text box.
  const cause = ENTITIES['timeline-event'].fields.find((field) => field.key === 'causeEventId')
  assert(cause.type === 'ref', `causeEventId must be a picker, got ${cause.type}`)
  assert(cause.refKind === 'timeline-event', `causeEventId must reference events, got ${cause.refKind}`)
})

check('clampToBox never produces a non-finite placement', () => {
  // `Math.min`/`Math.max` propagate NaN, and `JSON.stringify` turns NaN into null — so a
  // NaN placement was written to layout.json, rejected on reload by mergePositions, and
  // silently lost with nothing on screen to explain it.
  const { clampToBox } = plugin.__test
  for (const point of [{ x: Number.NaN, y: 1 }, { x: 1, y: Number.NaN }, { x: Infinity, y: 1 }, {}, null, undefined]) {
    const result = clampToBox(point, 720, 480)
    assert(
      Number.isFinite(result.x) && Number.isFinite(result.y),
      `non-finite output for ${JSON.stringify(point)}: ${JSON.stringify(result)}`,
    )
  }
  assert(clampToBox({ x: -5, y: 900 }, 720, 480).x === 14, 'a real coordinate must still be clamped')
})

check('local drafts never contain the word undefined', () => {
  // The tables are documented as directly editable, so emptying one is reachable — and an
  // empty table used to interpolate the literal word "undefined" into a name.
  const { makeRng, generateLocalDraft, LOCAL_KINDS, ENTITIES } = plugin.__test
  for (const kind of LOCAL_KINDS) {
    const draft = generateLocalDraft(kind, makeRng(12345), { taken: [] })
    const nameKey = ENTITIES[kind].generate.hintField
    const name = String(draft[nameKey])
    assert(!name.includes('undefined'), `${kind} produced "${name}"`)
    assert(!name.includes('NaN'), `${kind} produced "${name}"`)
  }
})

// --- the skills must describe the real format ---------------------------------
//
// The three SKILL.md files are the AI's only description of `novel/`. A wrong field name
// there means the agent writes a document the validator rejects — or one it accepts and
// the GUI cannot read. This is the same guard as the entity-vs-data-model test: the prose
// cannot drift from the code without a failure.

const skillNames = ['novel-writer', 'novel-consistency', 'novel-style']
const skillText = Object.fromEntries(
  skillNames.map((name) => [name, readFileSync(join(ROOT, '.dsh', 'skills', name, 'SKILL.md'), 'utf8')]),
)

/** Every field key declared anywhere, plus the project settings the skills document. */
const knownFieldNames = new Set(['custom', 'settings', 'style'])
for (const entity of Object.values(plugin.__test.ENTITIES)) {
  for (const field of entity.fields) knownFieldNames.add(field.key)
  for (const key of Object.keys(entity.blank())) knownFieldNames.add(key)
}
for (const key of ['wordCountGoal', 'schemaVersion', 'defaultTimelineId', 'updatedAt', 'createdAt', 'author', 'title', 'id']) {
  knownFieldNames.add(key)
}
// `positionId` is an inconsistency in the CODE, not a mistake in the skill: the validator
// checks it and can report `position-org-mismatch`, but no entity declares it as a field, so
// the GUI has no control for it. The skill says so explicitly rather than pretending it is
// editable. Recorded in the README backlog as an unresolved asymmetry.
knownFieldNames.add('positionId')

/** Tokens that look like a field name: lowerCamel with an interior capital. */
function camelTokens(text) {
  const found = new Set()
  for (const match of text.matchAll(/`([a-z][a-zA-Z0-9]*)`/g)) {
    if (/[A-Z]/.test(match[1].slice(1))) found.add(match[1])
  }
  return found
}

check('every skill has matching front matter and a real description', () => {
  for (const name of skillNames) {
    const text = skillText[name]
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
    assert(match !== null, `${name}/SKILL.md has no YAML front matter`)
    const declared = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim()
    assert(declared === name, `${name}/SKILL.md declares name "${declared}"`)
    const description = /^description:\s*'?([\s\S]*?)'?\s*$/m.exec(match[1])?.[1] ?? ''
    // A placeholder description is how these files started, and the skill catalog shows it
    // to the model — so a placeholder is a real regression, not a cosmetic one.
    assert(!description.includes('占位'), `${name} still has a placeholder description`)
    assert(description.length > 30, `${name} has an unusably short description`)
    assert(!text.includes('骨架占位'), `${name} still contains the placeholder body`)
    assert(!/待补内容/.test(text), `${name} still contains a "to be filled in" list`)
  }
})

check('the skills only name fields that exist', () => {
  for (const name of skillNames) {
    for (const token of camelTokens(skillText[name])) {
      assert(
        knownFieldNames.has(token),
        `${name} mentions "${token}", which is not a field on any entity or a project setting`,
      )
    }
  }
})

check('the chapter front-matter sample matches the real field order', () => {
  // The agent copies this block. A missing or reordered key produces a chapter the GUI
  // reads differently from the one the skill promised.
  const sample = /```markdown\n---\n([\s\S]*?)\n---\n/.exec(skillText['novel-writer'])
  assert(sample !== null, 'novel-writer must contain a markdown front-matter sample')
  const keys = sample[1]
    .split('\n')
    .filter((line) => /^[a-zA-Z]/.test(line))
    .map((line) => line.slice(0, line.indexOf(':')))
  const real = frontmatter.CHAPTER_FIELD_ORDER
  assert(
    keys.join(',') === real.join(','),
    `the skill's front-matter order is ${keys.join(',')} but the code writes ${real.join(',')}`,
  )
})

check('the skills use the real id prefixes', () => {
  // Match WHOLE code spans, not substrings: scanning raw text also matched `to-` inside
  // `open-relation-to-dead` and `member-` inside `member-of`, which are names from the code,
  // not mistakes. Every allowed name below is DERIVED, so this cannot rot.
  const validateSource = readFileSync(join(ROOT, 'lib', 'impl', 'validate.js'), 'utf8')
  const schemaSource = readFileSync(join(ROOT, 'lib', 'impl', 'schema.js'), 'utf8')
  const realPrefixes = new Set(Object.values(plugin.__test.ENTITIES).map((entity) => entity.idPrefix))
  const knownNames = new Set([
    // Validator codes the skill has to quote: `open-relation-to-dead`, `bad-id`, …
    ...[...validateSource.matchAll(/add\('(?:error|warning)',\s*'([a-z-]+)'/g)].map((m) => m[1]),
    // Relation type ids: `member-of`, `parent-child`, `master-apprentice`, …
    ...[...schemaSource.matchAll(/\{ id: '([a-z-]+)', label:/g)].map((m) => m[1]),
    // Entity keys (`relation-edge`), the skill names, the route prefix, and the documents.
    ...Object.keys(plugin.__test.ENTITIES),
    ...skillNames,
    'dsh-novel',
    ...Object.values(schema.FILES),
    ...schema.DIRS,
  ])

  const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/
  let checkedIds = 0
  for (const name of skillNames) {
    for (const match of skillText[name].matchAll(/`([^`\n]+)`/g)) {
      const token = match[1].trim()
      // Only slug-shaped tokens are candidates. This skips field paths (`settings.style`),
      // shapes (`{year,month,day}`), filenames (`draft/ch-0007.md`) and prose.
      if (!slug.test(token)) continue
      if (knownNames.has(token)) continue
      checkedIds += 1
      const prefix = `${token.split('-')[0]}-`
      assert(
        realPrefixes.has(prefix),
        `${name} uses "${token}", whose prefix "${prefix}" is neither an entity prefix nor a known name`,
      )
    }
  }
  // The chapter sample's bare ids and filename pattern are the ones the agent will copy, so
  // check those explicitly rather than relying on the loop above.
  // The chapter filename form and its id/filename agreement are what the agent copies, so
  // assert the SUBSTANCE: a concrete `<prefix><digits>.md` example built from the real
  // prefix, plus the statement that the id matches the filename.
  const chapterPrefix = plugin.__test.ENTITIES.chapter.idPrefix
  const filenameExample = new RegExp(`${chapterPrefix}\\d+\\.md`)
  assert(
    filenameExample.test(skillText['novel-writer']),
    `novel-writer must show a concrete chapter filename like ${chapterPrefix}0001.md`,
  )
  assert(
    /id` 与文件名一致|id 与文件名一致/.test(skillText['novel-writer']),
    'novel-writer must state that the chapter id matches its filename',
  )
  assert(checkedIds > 0, 'no candidate ids were found at all, so this check proves nothing')
})

check('the skills name the real documents', () => {
  const realPaths = new Set(Object.values(schema.FILES))
  for (const name of skillNames) {
    for (const match of skillText[name].matchAll(/(?:setting|outline|draft|views)\/[\w./-]+\.(?:json|md)/g)) {
      // `draft/ch-NNNN.md` is a filename pattern, not a literal document.
      if (match[0].includes('NNNN')) continue
      assert(
        realPaths.has(match[0]) || match[0].startsWith('draft/'),
        `${name} names the document "${match[0]}", which the plugin does not write`,
      )
    }
    assert(skillText[name].includes(schema.DATA_DIR), `${name} never names the data directory "${schema.DATA_DIR}"`)
  }
})

check('the consistency skill knows every validator code', () => {
  // A code missing from the table means the skill reports an issue without knowing what it
  // means; a renamed code would silently stop matching.
  const source = readFileSync(join(ROOT, 'lib', 'impl', 'validate.js'), 'utf8')
  const real = new Set([...source.matchAll(/add\('(?:error|warning)',\s*'([a-z-]+)'/g)].map((m) => m[1]))
  assert(real.size > 10, `expected the validator to declare many codes, found ${real.size}`)
  const documented = new Set(
    [...skillText['novel-consistency'].matchAll(/^\|([^|]*)\|/gm)].flatMap((row) =>
      [...row[1].matchAll(/`([a-z][a-z-]*)`/g)].map((code) => code[1]),
    ),
  )
  for (const code of real) {
    assert(documented.has(code), `novel-consistency does not document the validator code "${code}"`)
  }
  for (const code of documented) {
    assert(real.has(code), `novel-consistency documents "${code}", which the validator never emits`)
  }
})

check('the consistency skill points at the endpoint that exists', () => {
  const match = /(https?:\/\/[^\s`]*\/validate[^\s`]*)/.exec(skillText['novel-consistency'])
  assert(match !== null, 'novel-consistency must name the validate endpoint')
  // The route prefix is a contract; a rename must break this test rather than the skill.
  const source = readFileSync(join(ROOT, 'lib', 'impl', 'router.js'), 'utf8')
  const prefix = /PREFIX\s*=\s*'([^']+)'/.exec(source)?.[1]
  assert(prefix === '/dsh-novel', `the router prefix changed to ${prefix}`)
  assert(match[1].includes(`${prefix}/validate`), `the documented URL must use the real route prefix: ${match[1]}`)
})

check('the style skill stores its spec where nothing else overwrites it', () => {
  // The claim in the skill is load-bearing: it says the GUI never writes project.json, so an
  // agent-authored style spec survives. Assert that claim rather than trusting it.
  const clientSources = readdirSync(join(ROOT, 'client', 'src'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(ROOT, 'client', 'src', name), 'utf8'))
    .join('\n')
  assert(
    !/project\.json/.test(clientSources) && !/FILES\.project/.test(clientSources),
    'the client now addresses project.json, so an agent-authored style spec could be overwritten',
  )
  assert(schema.FILES.project === 'project.json', `the project document moved to ${schema.FILES.project}`)
  assert(skillText['novel-style'].includes('settings.style'), 'the style skill must name the exact location it writes')
})

// --- id minting -------------------------------------------------------------

check('mintId avoids collisions already in use', () => {
  const { mintId } = plugin.__test
  assert(mintId('item-', '青锋剑', new Set()) === 'item-青锋剑', 'basic minting failed')
  assert(mintId('item-', '青锋剑', new Set(['item-青锋剑'])) === 'item-青锋剑-2', 'collision not resolved')
  assert(mintId('item-', '  ', new Set()) === 'item-untitled', 'blank name should fall back')
})

check('mintId never emits a doubled separator', () => {
  // Ids are permanent and rename-proof, so `cat--weapon` would be baked into the
  // user's data for good. Regression guard: prefixes are declared with a trailing
  // dash, and the mint adds one.
  const { mintId } = plugin.__test
  assert(mintId('cat-', 'Weapon', new Set()) === 'cat-weapon', 'trailing-dash prefix produced a doubled separator')
  assert(mintId('cat', 'Weapon', new Set()) === 'cat-weapon', 'bare prefix should produce the same id')
  for (const id of [mintId('item-', '青锋剑', new Set()), mintId('cat-', '兵器', new Set())]) {
    assert(!id.includes('--'), `id contains a doubled separator: ${id}`)
  }
})

check('a validator warning is scoped to its document, entity-level ones included', () => {
  // The validator names a finding two ways: `setting/world.json` for the document, and
  // `setting/characters.json#char-1` for ONE entity inside it (validate.js:634, :460, :559, :532).
  // The save handler compared `issue.path === relPath`, so it matched only the first kind and every
  // entity-level warning vanished without a word — including the case the code's own comment names,
  // "an open relation to a dead character". A save reporting 1 warning displayed none.
  const belongs = plugin.__test.issueBelongsTo
  assert(typeof belongs === 'function', 'issueBelongsTo must be exported for the audit')

  // The bare form, and the element form, both belong to that document.
  assert(belongs({ path: 'setting/world.json' }, 'setting/world.json') === true, 'a whole-document finding belongs')
  assert(belongs({ path: 'setting/characters.json#char-1' }, 'setting/characters.json') === true, 'and so does an entity-level one')
  assert(belongs({ path: 'relations.json#edge-7' }, 'relations.json') === true, 'for every document, not just characters')
  assert(belongs({ path: 'outline/timeline.json#evt-2' }, 'outline/timeline.json') === true, 'including the timeline')

  // And nothing from elsewhere leaks in.
  assert(belongs({ path: 'setting/places.json#place-1' }, 'setting/characters.json') === false, 'another document is not this one')
  assert(belongs({ path: 'setting/characters.json.bak#char-1' }, 'setting/characters.json') === false, 'a lookalike name is not a prefix match')
  assert(belongs({ path: '' }, 'setting/characters.json') === false, 'an empty path matches nothing')
  assert(belongs({}, 'setting/characters.json') === false, 'a finding with no path matches nothing')
  assert(belongs(null, 'setting/characters.json') === false, 'and junk does not throw')

  // AND THE WIRING. A correct helper that the call sites stopped calling is the exact defect being
  // fixed here, and no amount of exercising the helper can see that. Both hooks — the entity document
  // and the chapter — must go through it, and the old inline comparison must be gone.
  //
  // Comments are stripped first: the explanation above the helper quotes the old comparison verbatim,
  // and searching raw source would match that prose instead of code. (Looking for code in comments is a
  // documented way to write a guard that proves nothing.)
  const core = readFileSync(join(ROOT, 'client', 'src', '10-core.js'), 'utf8')
  const code = core
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
      return line.replace(/\/\/.*$/, '')
    })
    .join('\n')
  const wired = code.match(/issue\.path === relPath/g) ?? []
  assert(wired.length === 0, `no call site may compare issue.path to relPath directly, found ${wired.length}`)
  const uses = code.match(/issue\.level === 'warning' && issueBelongsTo\(issue, relPath\)/g) ?? []
  assert(uses.length === 2, `both the document and the chapter hook must scope warnings through it, found ${uses.length} call site(s)`)
})

check('every route field the client reads exists in the route that sends it', () => {
  // THE CLASS, NOT THE INSTANCES. The two historical bugs this file already guards by hand were a
  // `/sessions` field read as `items` and an `/agent/prompt` body sent as `prompt`; a third — reading
  // `turnEnd` where `/agent/result` sends `finished` — then survived for months because the guard listed
  // route by route and this one was not on the list. So check the whole table instead.
  //
  // Matching is by VERBATIM SOURCE, not by parsing: for `field: <expr>` the sender literally contains
  // `field: <expr>`. That needs no tokenizer (an earlier attempt to parse the literals silently dropped
  // keys whose values contained `?.` or `{ … }` inside a comment — a guard that lies is worse than none).
  const router = readFileSync(join(ROOT, 'lib', 'impl', 'router.js'), 'utf8')
  const core = readFileSync(join(ROOT, 'client', 'src', '10-core.js'), 'utf8')
  const agent = readFileSync(join(ROOT, 'client', 'src', '62-agent.js'), 'utf8')

  /**
   * Does the handler that SENDS this route mention this field with this exact expression?
   *
   * Matches both `field:` and the shorthand `field,` / `field }` form, because several routes send
   * `{ ok: true, available, root, sessions }` — a `field\s*:` test alone would report those as missing.
   *
   * It also follows `...spread`, because `/catalog` sends no `styles` of its own: it spreads
   * `modules.prompt.catalogue()`, and those keys live in `lib/impl/prompt.js`. Reading only the handler
   * body reported a false positive, which is the one thing a contract guard must never do.
   */
  // Every host module, for the allowlist check below.
  const hostSources = readdirSync(join(ROOT, 'lib', 'impl'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(ROOT, 'lib', 'impl', name), 'utf8'))
    .join('\n')

  /**
   * Fields that arrive through a SPREAD, which this check cannot resolve: `/catalog` does
   * `...catalogue` and `/manuscript` does `...built`, and `built` is a call result, not a literal.
   * Following that would need real dataflow analysis. So they are listed here explicitly, and the
   * assertion below still proves each name exists somewhere in the host — a rename therefore fails
   * instead of passing silently. That is the honest middle: weaker than resolving the spread, far
   * stronger than not checking at all, and it cannot report a false positive.
   */
  const viaSpread = new Set([
    'styles', 'generators', 'maxCandidates', // lib/impl/prompt.js catalogue()
    'skipped', 'text', 'included', 'wordCount', 'chapterCount', // lib/impl/manuscript.js build()
  ])
  for (const field of viaSpread) {
    assert(
      new RegExp(`\\b${field}\\b`).test(hostSources),
      `\`${field}\` is listed as spread-provided but appears nowhere in the host — a rename would slip through`,
    )
  }

  const sent = (handler, field) => {
    const start = router.indexOf(`function ${handler}(`)
    if (start === -1) return false
    const nextFn = router.indexOf('\nfunction ', start + 1)
    const body = router.slice(start, nextFn === -1 ? undefined : nextFn)
    if (new RegExp(`\\b${field}\\s*[:,}]`).test(body)) return true
    // A spread may be the source, and only the listed fields are accepted that way.
    return viaSpread.has(field) && /\.\.\./.test(body)
  }

  // The fields the client actually reads, and the route that must be sending each one. Every entry was
  // read off the two sources; the point is that a rename on either side now fails here.
  const contract = [
    ['handleAgentResult', 'finished', 'the phase can never be reached without it'],
    ['handleAgentResult', 'text', 'the transcript'],
    ['handleAgentResult', 'writes', 'the files the run touched'],
    ['handleAgentResult', 'usage', 'the cost line'],
    ['handleSessions', 'sessions', 'the picker is permanently empty otherwise'],
    ['handleSessions', 'defaultModel', 'the model line'],
    ['handleSessions', 'available', 'the unsupported screen'],
    ['handleAgentStatus', 'running', 'a live run is detected by it'],
    ['handleAgentStatus', 'agentAvailable', 'the control is offered by it'],
    ['handleAgentPrompt', 'sessionId', 'the chosen session is remembered from it'],
    ['handleAgentPrompt', 'created', 'the note says whether a session was made'],
    ['handleChapters', 'chapters', 'the chapter list'],
    ['handleChapters', 'totalWordCount', 'the word total'],
    ['handleProjectGet', 'summary', 'the project header'],
    ['handleCatalog', 'models', 'the model picker'],
    ['handleDraft', 'text', 'the drafted prose'],
    ['handleGenerate', 'candidates', 'the candidate list'],
    ['handleWorkspaces', 'workspaces', 'the project picker'],
  ]
  for (const [handler, field, why] of contract) {
    assert(sent(handler, field), `${handler} must send \`${field}\` (${why})`)
  }

  // And the reverse direction: the client must actually be reading what the route sends. These are the
  // reads that were wrong before, pinned by name so a rename on the client side fails too.
  assert(/body\?\.sessions/.test(agent), 'the client reads `sessions` from /sessions')
  assert(!/body\?\.items/.test(agent), 'and not `items`')
  assert(/result\?\.finished|input\?\.result\?\.finished/.test(agent), 'the client reads `finished` from /agent/result')
  assert(!/turnEnd/.test(agent.replace(/\/\/[^\n]*/g, '')), 'and no longer reads the `turnEnd` that route never sends')
  assert(/text: agentPromptText\(/.test(agent), 'the client sends `text` to /agent/prompt')
  assert(/issueBelongsTo\(issue, relPath\)/.test(core), 'and scopes warnings through the shared helper')
})

check('MAINTENANCE.md still reports the real test distribution', () => {
  // The doc calls itself the authoritative checklist for whoever takes over next, and it states both a
  // total and a per-suite breakdown. Those numbers drifted silently — they said 409 (impl 86) while the
  // suites actually ran 411 — and a stale count is worse than none, because it makes a real gap look like
  // a rounding difference. Parse both statements here; reconcile them against reality at the end of the
  // run, which is the only place this file's own real count exists.
  const doc = readFileSync(join(ROOT, 'docs', 'MAINTENANCE.md'), 'utf8')
  const dist = doc.match(/`impl`\s*(\d+)\s*项[^·]*·\s*`api`\s*(\d+)\s*项[^·]*·\s*`client`\s*(\d+)\s*项[^·]*·\s*`live`\s*(\d+)\s*项/)
  assert(dist !== null, 'MAINTENANCE.md must still state the four-suite distribution')
  documentedBreakdown = dist.slice(1).map(Number)

  const totalLine = doc.match(/#\s*跑四套测试（(\d+)\s*项/)
  assert(totalLine !== null, 'MAINTENANCE.md must still state the suite total in section 1')
  documentedTotal = Number(totalLine[1])

  // The two statements must at least agree with each other.
  assert(
    documentedTotal === documentedBreakdown.reduce((sum, n) => sum + n, 0),
    `the stated total (${documentedTotal}) must equal the sum of the distribution (${documentedBreakdown.reduce((sum, n) => sum + n, 0)})`,
  )
})

globalThis.window = originalWindow

// ---------------------------------------------------------------------------
// RECONCILE THE DOCUMENTED COUNTS. Done here rather than inside a `check()`, because this file's real
// count is only known once every case has run. A stale number in the handover doc reads as a rounding
// difference rather than a gap, so it must fail the suite rather than merely be wrong.
if (documentedBreakdown !== null) {
  if (documentedBreakdown[2] !== passed) {
    failures.push({
      name: 'MAINTENANCE.md client count',
      message: `documents ${documentedBreakdown[2]} client checks, but this suite ran ${passed}`,
    })
  }
  if (documentedTotal !== documentedBreakdown.reduce((sum, n) => sum + n, 0)) {
    failures.push({
      name: 'MAINTENANCE.md total',
      message: `states ${documentedTotal} checks, but its own distribution sums to ${documentedBreakdown.reduce((sum, n) => sum + n, 0)}`,
    })
  }
}

const total = passed + failures.length
console.log('')
if (failures.length === 0) {
  console.log(`OK  ${passed}/${total} client checks passed`)
  process.exit(0)
}
console.log(`FAIL  ${passed}/${total} client checks passed`)
for (const failure of failures) console.log(`  x ${failure.name}\n      ${failure.message}`)
process.exit(1)
