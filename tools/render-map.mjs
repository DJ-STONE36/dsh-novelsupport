/**
 * Render a generated map to a PNG, exactly the way the in-app export does.
 *
 * WHY THIS EXISTS. The export runs in a browser, so nothing in the offline suite can check what it
 * actually produces — the tests cover the arithmetic, the file name, and that the right calls happen.
 * This closes that gap from the outside: it renders the same `MapSurface` with the same React server
 * renderer, applies the same transformation the export applies, and rasterises it with headless
 * Chrome. The result can be looked at.
 *
 * Usage:
 *   node tools/render-map.mjs [--seed N] [--scale N] [--ink #rrggbb] [--size WxH] [--out file.png]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as react from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const seed = Number(flag('seed', Date.now() % 100000))
const scale = Number(flag('scale', 1))
// The colour the app's theme would resolve `currentColor` to. The default is the DARK theme's light
// text, because that is the case worth looking at.
const theme = flag('theme', '#d8d8d8')
// `--raw` reproduces the behaviour BEFORE the ink fix, so the defect can be seen rather than argued.
const raw = args.includes('--raw')
// `--paper <id>` picks a colour theme, so the themes can be looked at without a browser.
const paper = flag('paper', 'plain')
const out = flag('out', join(process.cwd(), `_map-render-${seed}${raw ? '-raw' : ''}.png`))
const [width, height] = String(flag('size', '1600x1200')).split('x').map(Number)

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))
if (CHROME === undefined) {
  console.error('no headless browser found')
  process.exit(1)
}

// --- load the built plugin, exactly as the suites do -----------------------------------------
let captured = null
new Function('window', 'react', readFileSync('client/client.js', 'utf8'))(
  { __ModuleLoader__: { load: (mod) => { captured = mod } } },
  react,
)
const plugin = captured.factory((id) => {
  if (id === 'react') return react
  throw new Error(id)
})
const api = plugin.__test

// --- build a map the way the 随机生成 button does ---------------------------------------------
const canvas = { width, height }
const generated = api.generateRandomMap(seed, canvas)
const map = {
  id: 'map-1',
  name: '示例地图',
  canvas,
  background: { kind: 'blank', asset: null },
  strokes: generated.strokes,
  paths: generated.paths,
  pins: generated.pins,
  labelSize: api.MAP_DEFAULT_LABEL_SIZE,
  labelFixed: false,
  theme: paper,
}
console.log(`seed ${seed} · canvas ${width}x${height} · ${generated.strokes.length} strokes · ${generated.pins.length} pins`)

// --- render the surface, then transform it AS THE EXPORT DOES --------------------------------
const markup = renderToStaticMarkup(
  react.createElement(api.MapSurface, {
    root: null,
    map,
    view: api.mapViewBox(null, canvas),
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
  }),
)

const size = api.mapExportSize(canvas, scale)
// Mirrors `exportPng` exactly: the namespace, an explicit size, and an ink chosen for the PAPER the map is
// drawn on rather than for a hardcoded white — because `currentColor` cannot resolve once the SVG is
// detached, and a light-on-dark theme would otherwise export a nearly blank map.
const sheet = api.mapPaper(map)
const ink = raw ? theme : api.mapExportInk(theme, sheet)
const standalone = markup
  .replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size.width}" height="${size.height}" `)
  .replace(/style="([^"]*)"/, (_match, style) => `style="color:${ink};${style}"`)

const page = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:${sheet}}
svg{display:block}</style>
${standalone}`

// A standalone SVG needs no browser, so this path works even where Chrome cannot start — which is
// the case under the DSH sandbox, where Chrome's Mojo IPC is denied named pipes.
const svgOut = flag('svg', null)
if (svgOut !== null) {
  writeFileSync(svgOut, standalone, 'utf8')
  console.log(`ink ${ink} · wrote ${svgOut}`)
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'dsh-map-render-'))
const html = join(work, 'map.html')
writeFileSync(html, page, 'utf8')

console.log(`rendering with headless Chrome at ${size.width}x${size.height} (ink ${ink}) ...`)
execFileSync(CHROME, [
  '--headless',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--window-size=${size.width},${size.height}`,
  `--screenshot=${out}`,
  `file:///${html.replace(/\\/g, '/')}`,
], { stdio: 'ignore', timeout: 120000 })

rmSync(work, { recursive: true, force: true })
if (!existsSync(out)) {
  console.error('the browser produced no screenshot')
  process.exit(1)
}
console.log(`wrote ${out}`)
