/**
 * The map (世界 · 地图): hand-drawn maps with location pins.
 *
 * ONE DOCUMENT, SEVERAL MAPS, EACH VIEWED ON ITS OWN.
 *
 * The first version nested `layers` — stacked transparency sheets over a shared canvas. That was
 * the wrong model and the author said so: different maps are different PLACES, not overlays, and
 * stacking them meant every map shared one canvas, one background and one pin list, while a new
 * "layer" appeared to inherit the previous one's drawing. So the document holds a list of maps and
 * shows exactly one at a time.
 *
 * Data (`novel/setting/map/index.json`):
 *   {
 *     version: 2,
 *     activeMapId: 'map-1',
 *     maps: [{
 *       id, name,
 *       canvas:     { width, height },          the world extent, in world units
 *       background: { kind: 'blank'|'image', asset },
 *       strokes:    [{ color, points: [[x,y], …] }],
 *       pins:       [{ id, placeId, x, y, label, color, size }],
 *       labelSize:  number,                     pin label size, in WORLD units
 *       labelFixed: boolean,                    true keeps labels a constant pixel size instead
 *     }]
 *   }
 *
 * The legacy shape (`canvas`/`background`/`layers`/`pins` at the top level) is still READ and is
 * migrated in memory: each old layer becomes a map, and the top-level pins go to the first one, so
 * nothing an author already drew is lost. The new shape is what gets written.
 *
 * Pan and zoom live in `views/layout.json`, per map.
 *
 * TESTABILITY, the split the relation graph uses and for the same reason: `renderToString` runs no
 * effects and no event handlers, so no pointer interaction can be verified. Everything that CAN be
 * pure therefore is — migration, screen→world conversion, zoom-about-a-point, the whole gesture
 * state machine, stroke and label geometry, id minting, and every guard against a hand-edited file.
 * Only two things are taken on faith: reading an element's rectangle, and that a handler fires.
 */

const MAP_DOC = 'setting/map/index.json'
const MAP_LAYOUT_DOC = 'views/layout.json'

/** Zoom limits. Below the minimum the whole canvas is a speck; above the maximum it is unusable. */
const MAP_ZOOM_MIN = 0.2
const MAP_ZOOM_MAX = 8

/** The pen's palette. A stroke stores its own colour, so changing the pen never recolours history. */
const MAP_PEN_COLORS = ['#c0504d', '#4a9e6f', '#4a7fd0', '#c99a3a', '#8a5ad0', '#3a3a3a']
const MAP_DEFAULT_COLOR = MAP_PEN_COLORS[0]

/** Pin label sizes, in the same units the map is drawn in. */
const MAP_LABEL_SIZES = [24, 34, 48, 64]
const MAP_DEFAULT_LABEL_SIZE = 34

/** Export scales offered, as multiples of the canvas. 2× is a printable map. */
const MAP_EXPORT_SCALES = [1, 2, 3]

/**
 * The pixel size an export will produce.
 *
 * The canvas is in WORLD units, which have nothing to do with pixels: a 2000-wide canvas at 2× is a
 * 4000-pixel image. Pure, because the arithmetic is the part worth checking — the drawing itself can
 * only be verified in a browser.
 */
function mapExportSize(canvas, scale) {
  const multiple = Number.isFinite(scale) && scale > 0 ? scale : 1
  const width = Number(canvas?.width)
  const height = Number(canvas?.height)
  return {
    width: Math.max(1, Math.round((Number.isFinite(width) && width > 0 ? width : 2000) * multiple)),
    height: Math.max(1, Math.round((Number.isFinite(height) && height > 0 ? height : 1500) * multiple)),
  }
}

/**
 * A file name for an exported image.
 *
 * A map called `大陆/全图` would otherwise produce a path, and Windows forbids several of these
 * characters outright — so they are replaced rather than passed through into a download.
 */
function mapExportName(mapName, extension = 'png') {
  const cleaned = String(mapName ?? '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const ext = /^[a-z0-9]+$/i.test(extension) ? extension.toLowerCase() : 'png'
  return `${cleaned === '' ? 'map' : cleaned}.${ext}`
}

/** How close a click must be to a pin to count as hitting it, in screen pixels. */
const MAP_PIN_HIT_PX = 18

/** The stroke colour to draw with, falling back when a stroke carries none. */
function mapStrokeColor(stroke, fallback = MAP_DEFAULT_COLOR) {
  const color = stroke?.color
  if (typeof color === 'string' && color !== '') return color
  return fallback === null ? MAP_DEFAULT_COLOR : fallback
}

/**
 * Clean a point list into `[{x, y}, …]`, dropping anything unusable.
 *
 * Accepts BOTH `[x, y]` pairs and `{x, y}` records, and that is not tidiness: the document stores
 * pairs, while the normaliser hands the renderer records. Accepting only pairs meant that reading
 * back anything the normaliser had produced silently dropped EVERY stroke — so a map survived until
 * its second save and then came back empty. A test that migrates twice caught it.
 */
function cleanPoints(points) {
  return (Array.isArray(points) ? points : [])
    .map((point) =>
      Array.isArray(point)
        ? { x: Number(point[0]), y: Number(point[1]) }
        : { x: Number(point?.x), y: Number(point?.y) },
    )
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
}

/**
 * A map's strokes, normalised.
 *
 * Accepts BOTH the legacy form (a bare `[[x,y], …]` list, from when strokes lived on a layer) and
 * the current `{color, points}` record. A stroke needs two usable points: one point draws nothing,
 * and storing something invisible would make the count disagree with the screen.
 */
function mapStrokes(value) {
  const raw = Array.isArray(value?.strokes) ? value.strokes : []
  const out = []
  for (const stroke of raw) {
    const isLegacy = Array.isArray(stroke)
    const points = cleanPoints(isLegacy ? stroke : stroke?.points)
    if (points.length < 2) continue
    // A fill is a property of the OUTLINE, preserved with it — including the difference between "not
    // filled" (null) and a fill that happens to be blank.
    const fill = isLegacy ? null : typeof stroke?.fill === 'string' && stroke.fill !== '' ? stroke.fill : null
    // The width is stored WITH the stroke, exactly as the colour is, so changing the pen never redraws
    // what is already drawn. A stroke written before widths existed has none and takes the default.
    out.push({
      color: isLegacy ? null : stroke?.color ?? null,
      width: isLegacy ? null : normalisePenWidth(stroke?.width),
      fill,
      points,
    })
  }
  return out
}

/** The pen widths offered, in SCREEN pixels — a pen is a pen, so it does not scale with the map. */
const MAP_PEN_WIDTHS = [2, 4, 8, 16, 32]
const MAP_PEN_DEFAULT = MAP_PEN_WIDTHS[0]

/** A usable pen width, or null when the stroke predates widths and should use the pen's own. */
function normalisePenWidth(value) {
  const width = Number(value)
  if (!Number.isFinite(width) || width <= 0) return null
  return Math.min(64, Math.max(0.5, Math.round(width * 10) / 10))
}

/** The width a stroke is drawn with: its own, or the fallback the caller passes. */
function mapStrokeWidth(stroke, fallback = MAP_PEN_DEFAULT) {
  const own = normalisePenWidth(stroke?.width)
  if (own !== null) return own
  const other = normalisePenWidth(fallback)
  return other === null ? MAP_PEN_DEFAULT : other
}

/** Pins with a usable id. A pin without one cannot be selected, moved, or deleted. */
function mapPins(value) {
  return objectList(value?.pins).filter((pin) => !isBlank(pin.id))
}

/** The marker sizes offered, in SCREEN pixels of DIAMETER. A marker is a handle, so it stays legible. */
const MAP_PIN_SIZES = [8, 12, 14, 20, 28]
const MAP_PIN_DEFAULT_SIZE = 14

/** A usable marker diameter, or the map's default. */
function mapPinDiameter(map, pin) {
  const own = Number(pin?.dot)
  if (Number.isFinite(own) && own > 0) return Math.min(80, Math.max(2, own))
  const fallback = Number(map?.pinSize)
  if (Number.isFinite(fallback) && fallback > 0) return Math.min(80, Math.max(2, fallback))
  return MAP_PIN_DEFAULT_SIZE
}

/** A marker's radius, in the world units the SVG is drawn in — a constant SIZE ON SCREEN at any zoom. */
function mapPinRadius(map, pin, zoom) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return mapPinDiameter(map, pin) / 2 / safeZoom
}

/** A marker's colour: its own when set, else the theme's. */
function mapPinColor(pin, fallback = 'currentColor') {
  const color = pin?.color
  return typeof color === 'string' && color !== '' ? color : fallback
}

/**
 * Every pin id in the document.
 *
 * PIN IDS ARE UNIQUE ACROSS THE WHOLE DOCUMENT, not per map — the host validator registers them in
 * one table and refuses a document that reuses any. So anything minting a pin must avoid every pin
 * everywhere, not merely the pins of the map it is adding to. Getting this wrong produced a write the
 * validator rejected outright: a generated map whose `pin-1` collided with another map's.
 */
function allPinIds(maps) {
  return allIdsOf(maps, 'pins')
}

/**
 * Every path id in the document, for the same reason as the pins.
 *
 * Path ids are not validated today, but they are minted document-wide anyway: a per-map rule that
 * happens to be safe now becomes a blocked save the moment validation is extended, and the author would
 * have no way to tell why.
 */
function allPathIds(maps) {
  return allIdsOf(maps, 'paths')
}

/** Every `id` in a given list field, across every map. */
function allIdsOf(maps, key) {
  const out = []
  for (const map of objectList(maps)) {
    for (const entry of objectList(map?.[key])) {
      const id = entry?.id
      if (typeof id === 'string' && id !== '') out.push(id)
    }
  }
  return out
}

/** The canvas extent, guarded. A zero or negative or missing size would make every ratio NaN. */
function mapCanvas(value) {
  const usable = (size, fallback) => (Number.isFinite(size) && size > 0 ? size : fallback)
  return {
    width: usable(value?.canvas?.width, 2000),
    height: usable(value?.canvas?.height, 1500),
  }
}

/** Is this a background image we know how to display? */
function isMapImage(background) {
  if (background?.kind !== 'image') return false
  const asset = background?.asset
  return typeof asset === 'string' && /\.(png|jpe?g|gif|webp|svg)$/i.test(asset)
}

/** A background image we can display, or a plain blank sheet. */
function mapBackground(value) {
  const background = value?.background
  if (isMapImage(background)) return { kind: 'image', asset: background.asset }
  return { kind: 'blank', asset: null }
}

/** One map, with every field normalised and all junk removed. */
function normalizeMap(value, index = 0) {
  const id = typeof value?.id === 'string' && value.id !== '' ? value.id : `map-${index + 1}`
  const name = typeof value?.name === 'string' ? value.name : ''
  const labelSize = Number.isFinite(value?.labelSize) && value.labelSize > 0 ? value.labelSize : MAP_DEFAULT_LABEL_SIZE
  const pinSize = Number.isFinite(value?.pinSize) && value.pinSize > 0 ? Math.min(80, Math.max(2, value.pinSize)) : MAP_PIN_DEFAULT_SIZE
  return {
    id,
    name,
    canvas: mapCanvas(value),
    background: mapBackground(value),
    strokes: mapStrokes(value),
    shapes: mapShapes(value),
    paths: mapAllPaths(value),
    pins: mapPins(value),
    // Free text and stamps are PRESERVED like everything else here: normalisation substitutes for display,
    // never in the data.
    texts: mapTexts(value),
    stamps: mapStamps(value),
    theme: mapThemeId(value),
    labelSize,
    pinSize,
    labelFixed: value?.labelFixed === true,
  }
}

/**
 * Every map in the document, migrating the legacy shape when it is found.
 *
 * The migration is deliberately lossless and in-memory: the old top level held ONE canvas, ONE
 * background, a list of layers and a list of pins. Each layer becomes a map in its own right (that
 * is what its strokes were drawn on), and the shared canvas, background and pins go to the first
 * one. Nothing is written until the author saves.
 *
 * AN EMPTY MODERN SHAPE MUST NOT HIDE REAL LEGACY CONTENT. A document was found on disk holding both
 * shapes: `layers` with three strokes and `pins` with eight marks, alongside `maps` holding a single
 * EMPTY map. Reading `maps` unconditionally made the author's work vanish from the UI while it was
 * still sitting in the file — the worst kind of failure, because nothing looks broken.
 *
 * So an entirely empty `maps` list yields to legacy content when that content exists. This can only
 * happen for a document written before `withMaps` stopped leaving the legacy keys behind, so it is a
 * one-time recovery rather than a permanent ambiguity.
 */
function mapMaps(doc) {
  const modern = Array.isArray(doc?.maps) ? objectList(doc.maps).map((value, index) => normalizeMap(value, index)) : null
  const migrated = migrateLegacyMaps(doc)
  if (modern === null) return migrated

  // EVERY CONTENT LIST COUNTS. A map holding only stamps and captions is still work, and leaving them out of
  // this test would let the legacy migration discard it as "empty".
  const hasWork = (map) => map.strokes.length > 0 || map.pins.length > 0 || map.shapes.length > 0 || map.paths.length > 0 || map.texts.length > 0 || map.stamps.length > 0
  const modernHasContent = modern.some(hasWork)
  const legacyHasContent = migrated.some(hasWork)
  // Only when the modern shape is BOTH non-empty in maps and empty in content is anything given up,
  // and even then the legacy content is real work that was never migrated.
  if (!modernHasContent && legacyHasContent) return migrated
  return modern
}

/** The legacy shape (`canvas`/`background`/`layers`/`pins`) read as a list of maps. */
function migrateLegacyMaps(doc) {
  const layers = objectList(doc?.layers)
  const shared = { canvas: mapCanvas(doc), background: mapBackground(doc), pins: objectList(doc?.pins) }
  if (layers.length === 0) {
    // A legacy document with no layers at all: one map, carrying whatever it had.
    return [normalizeMap({ ...shared, id: 'map-1', name: '地图 1' }, 0)]
  }
  return layers.map((layer, index) =>
    normalizeMap(
      {
        id: typeof layer?.id === 'string' && layer.id !== '' ? layer.id : `map-${index + 1}`,
        name: typeof layer?.name === 'string' && layer.name !== '' ? layer.name : `地图 ${index + 1}`,
        canvas: shared.canvas,
        background: shared.background,
        strokes: layer?.strokes,
        // The pins belonged to the document, not to any one layer, so they land on the first map
        // rather than being duplicated across all of them.
        pins: index === 0 ? shared.pins : [],
      },
      index,
    ),
  )
}

/** The map being shown: the chosen one if it still exists, else the first, else null. */
function resolveActiveMap(doc, activeId) {
  const maps = mapMaps(doc)
  if (maps.length === 0) return null
  return maps.find((map) => map.id === activeId) ?? maps[0]
}

/**
 * Rebuild the document around a new list of maps.
 *
 * THE LEGACY KEYS ARE DROPPED, and that is the point. Keeping them produced documents holding BOTH
 * shapes at once — a real one was found on disk with `layers`/`pins` full of work and a `maps` key
 * holding one empty map. Since `mapMaps` reads `maps` first, the author's strokes and pins were
 * silently invisible in the UI while still sitting in the file. Migration is not finished until the
 * old keys are gone; `mapMaps` can then never be in doubt about which shape is authoritative.
 *
 * Everything else in the document is preserved: a project may hold keys this plugin knows nothing
 * about, and dropping those would be silent data loss of a different kind.
 *
 * `maps` may be `null`, which means THE LIST IS NOT CHANGING — reuse the document's own array. That
 * case exists because normalisation substitutes for display and must never reach the file: the list
 * the UI holds has `pinSize`/`labelSize`/`theme` filled in by `normalizeMap`, so writing it back turns
 * a display default into a stored one and makes "the author chose 14" and "nobody chose" the same
 * value. Switching which map you are LOOKING at therefore used to write those defaults out — and
 * `schema.js` seeds a new project's map without `pinSize`, so the first click on the map list added
 * `"pinSize": 14` to the author's file.
 */
function withMaps(doc, maps, activeMapId) {
  const base = isRecord(doc) ? doc : {}
  // null = keep the stored list byte for byte, defaults and all.
  const list = maps === null ? objectList(base.maps) : objectList(maps)
  const active = typeof activeMapId === 'string' && list.some((map) => map.id === activeMapId)
    ? activeMapId
    : list.length > 0
      ? list[0].id
      : null
  const { layers: _migratedLayers, pins: _migratedPins, ...rest } = base
  return { ...rest, version: 2, activeMapId: active, maps: list }
}

/**
 * The stored view for one map.
 *
 * Per map, because two maps of different places should not share a viewpoint. A flat legacy value
 * (`{centerX, centerY, zoom}`) is accepted and used for every map until the author moves one.
 */
function mapViewFor(layout, mapId) {
  const stored = layout?.mapView
  if (!isRecord(stored)) return null
  if (isRecord(stored[mapId])) return stored[mapId]
  if (Number.isFinite(stored.centerX) || Number.isFinite(stored.zoom)) return stored
  return null
}

/** Merge one map's view into the stored set, leaving the other maps' views alone. */
function withMapView(layout, mapId, view) {
  const base = isRecord(layout) ? layout : {}
  const stored = isRecord(base.mapView) ? base.mapView : {}
  return { ...base, mapView: { ...stored, [mapId]: view } }
}

/**
 * Normalise EITHER view shape into a canonical view state `{ centerX, centerY, zoom }`.
 *
 * The map has two representations of "where we are looking":
 *
 *   view state  { centerX, centerY, zoom }   persisted in `views/layout.json`
 *   box         { x, y, w, h, zoom }         what an SVG `viewBox` needs
 *
 * Handing one to a function that expected the other produced THREE separately reported faults,
 * because every helper silently fell back to a default instead of complaining:
 *
 *   * panning did nothing — `MapSurface` re-derived a box from a box, discarding the centre
 *   * marks offset by a constant — the render origin and the pointer origin disagreed by a fixed
 *     amount, so every click landed the same distance away
 *   * zooming dragged the top-left corner to the middle — `mapZoomAt` read `centerX` off a box, got
 *     `undefined`, and fell back to (0,0), the canvas corner
 *
 * Patching each call site is exactly what allowed the next instance. So EVERY view function
 * normalises through here first, and either shape now works everywhere. `canvas` is optional: both
 * real shapes can find their own centre, and it is only needed for the junk fallback.
 */
function mapViewState(value, canvas) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const width = Number.isFinite(canvas?.width) && canvas.width > 0 ? canvas.width : 0
  const height = Number.isFinite(canvas?.height) && canvas.height > 0 ? canvas.height : 0
  const zoom = Number.isFinite(source.zoom) && source.zoom > 0
    ? Math.max(MAP_ZOOM_MIN, Math.min(MAP_ZOOM_MAX, source.zoom))
    : 1
  // `centerX`/`centerY` for a view state; a box's own origin for a box; the middle otherwise.
  const centerX = Number.isFinite(source.centerX)
    ? source.centerX
    : isMapBox(source)
      ? source.x + source.w / 2
      : width / 2
  const centerY = Number.isFinite(source.centerY)
    ? source.centerY
    : isMapBox(source)
      ? source.y + source.h / 2
      : height / 2
  return { centerX, centerY, zoom }
}

/**
 * Is this already a DERIVED box rather than a persisted view state? Told apart by `x`/`w` versus
 * `centerX`.
 */
function isMapBox(value) {
  return Number.isFinite(value?.x) && Number.isFinite(value?.y) && value?.w > 0 && value?.h > 0
}

/**
 * The window onto the canvas, as an SVG viewBox.
 *
 * IDEMPOTENT BY CONSTRUCTION: given a box, it returns that box. Deriving twice is therefore
 * harmless rather than silently wrong — and "silently wrong" is the failure mode this file keeps
 * producing.
 */
function mapViewBox(value, canvas) {
  const state = mapViewState(value, canvas)
  const width = (Number.isFinite(canvas?.width) && canvas.width > 0 ? canvas.width : 0) / state.zoom
  const height = (Number.isFinite(canvas?.height) && canvas.height > 0 ? canvas.height : 0) / state.zoom
  return { x: state.centerX - width / 2, y: state.centerY - height / 2, w: width, h: height, zoom: state.zoom }
}

/** The `viewBox` attribute value. */
function viewBoxString(box) {
  return `${box.x} ${box.y} ${box.w} ${box.h}`
}

/**
 * Where a path's NAME goes, and how far out to push it: the middle of the course, offset to one side.
 *
 * The midpoint is measured along the course rather than taken as the middle waypoint — a course whose
 * waypoints are bunched at one end would otherwise have its name sitting on top of them.
 */
function mapPathAnchor(points, width) {
  const clean = (Array.isArray(points) ? points : []).filter(
    (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y),
  )
  if (clean.length === 0) return null
  if (clean.length === 1) return { x: clean[0].x, y: clean[0].y, angle: 0, offset: 0 }
  const segments = []
  let total = 0
  for (let i = 0; i < clean.length - 1; i += 1) {
    const length = Math.hypot(clean[i + 1].x - clean[i].x, clean[i + 1].y - clean[i].y)
    segments.push(length)
    total += length
  }
  if (total === 0) return { x: clean[0].x, y: clean[0].y, angle: 0, offset: 0 }
  let walked = 0
  for (let i = 0; i < segments.length; i += 1) {
    if (walked + segments[i] >= total / 2) {
      const t = segments[i] === 0 ? 0 : (total / 2 - walked) / segments[i]
      const a = clean[i]
      const b = clean[i + 1]
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        // Far enough out to clear the widest part of the course, so the name is not written over it.
        offset: Math.max(6, (Number.isFinite(width) ? width : 20) / 2 + 4),
      }
    }
    walked += segments[i]
  }
  const last = clean[clean.length - 1]
  return { x: last.x, y: last.y, angle: 0, offset: 0 }
}

/**
 * The peaks of a mountain range, along its course.
 *
 * A range is drawn as a row of triangles rather than as a thick line, because a thick line reads as a
 * wall. Peaks are spaced by the width setting, so making a range wider also spreads it out, and every
 * other peak is drawn smaller so the row does not look like a saw blade.
 *
 * Pure and deterministic — no randomness — so the range does not shimmer between renders.
 */
function mapMountainPeaks(points, width) {
  const clean = (Array.isArray(points) ? points : []).filter(
    (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y),
  )
  if (clean.length < 2) return []
  const size = Number.isFinite(width) && width > 0 ? Math.min(width, MAP_PATH_MAX_WIDTH) : MAP_PATH_KINDS.mountain.width
  const step = Math.max(4, size * 0.72)
  const peaks = []
  let carry = 0
  for (let i = 0; i < clean.length - 1; i += 1) {
    const a = clean[i]
    const b = clean[i + 1]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) continue
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    let walked = carry
    while (walked <= length) {
      const t = walked / length
      // Alternating heights, on a fixed pattern, so the row looks natural and stays reproducible.
      const scale = peaks.length % 2 === 0 ? 1 : 0.62
      peaks.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle,
        size: size * scale,
      })
      walked += step
    }
    carry = walked - length
  }
  return peaks
}

/** One peak as an SVG polygon, apex up, base across the range's direction. */
function mapMountainGlyph(peak) {
  const half = (Number.isFinite(peak?.size) ? peak.size : 20) / 2
  const x = Number(peak?.x) || 0
  const y = Number(peak?.y) || 0
  return `${Math.round((x - half) * 100) / 100},${Math.round((y + half * 0.7) * 100) / 100} ${Math.round(x * 100) / 100},${Math.round((y - half) * 100) / 100} ${Math.round((x + half) * 100) / 100},${Math.round((y + half * 0.7) * 100) / 100}`
}

/**
 * The uniform scale an SVG with `preserveAspectRatio="xMidYMid meet"` uses to fit `box` into
 * `rect`.
 *
 * ONE definition, shared by screen→world conversion and panning. Two independent derivations of the
 * same scale is exactly how a canvas ends up putting marks slightly off from the cursor: the two
 * numbers drift apart, and nothing reports it.
 */
function mapScale(rect, box) {
  if (!(rect?.width > 0) || !(rect?.height > 0)) return null
  if (!(box?.w > 0) || !(box?.h > 0)) return null
  const scale = Math.min(rect.width / box.w, rect.height / box.h)
  return Number.isFinite(scale) && scale > 0 ? scale : null
}

/**
 * A pointer position → world coordinates, accounting for how the viewBox is actually fitted.
 *
 * An SVG with a viewBox maps its content into the element through `preserveAspectRatio` — by
 * default `xMidYMid meet`, which LETTERBOXES: the content is scaled to fit inside the element and
 * centred, leaving bands on two sides. Ignoring the bands puts every click in the wrong place.
 *
 * Pure, and separated for the same reason as the graph's: reading the element's rectangle is the
 * one part that cannot be tested, because there is no layout in a server render.
 */
function mapScreenToWorld(point, rect, box) {
  const scale = mapScale(rect, box)
  if (scale === null) return null
  const offsetX = (rect.width - box.w * scale) / 2
  const offsetY = (rect.height - box.h * scale) / 2
  const x = box.x + (point.clientX - rect.left - offsetX) / scale
  const y = box.y + (point.clientY - rect.top - offsetY) / scale
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/** Centre the view somewhere else, keeping the zoom. */
function mapPanTo(value, centerX, centerY) {
  // Normalised, so a view state or a box both work — the third fault of this family was a box
  // reaching a function that read `centerX` off it and silently got `undefined`.
  const { zoom } = mapViewState(value)
  return {
    zoom,
    centerX: Number.isFinite(centerX) ? centerX : 0,
    centerY: Number.isFinite(centerY) ? centerY : 0,
  }
}

/**
 * Zoom about a world point, so that point stays under the cursor.
 *
 * The naive `zoom *= factor` moves the centre and the map appears to slide away from the pointer,
 * which is the single most jarring thing a zoomable canvas can do.
 */
function mapZoomAt(value, factor, focus) {
  // The centre MUST come from the normaliser. Reading `view.centerX` directly is what broke wheel
  // zooming: a box has no `centerX`, so it fell back to (0,0) — the canvas top-left — and that
  // corner flew to the middle of the screen while the map scaled around it.
  const { centerX, centerY, zoom: current } = mapViewState(value)
  const zoom = Math.max(MAP_ZOOM_MIN, Math.min(MAP_ZOOM_MAX, current * factor))
  // The actual applied ratio, which differs from `factor` once a limit clamps it.
  const applied = zoom / current
  const focusX = Number.isFinite(focus?.x) ? focus.x : centerX
  const focusY = Number.isFinite(focus?.y) ? focus.y : centerY
  return {
    zoom,
    centerX: focusX + (centerX - focusX) / applied,
    centerY: focusY + (centerY - focusY) / applied,
  }
}

/** The same, for a river's or road's waypoint. Slightly larger, since a waypoint is a smaller target. */
function mapPathHitRadius(zoom) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return MAP_PATH_HIT_PX / safeZoom
}

/** How close a click must be to a pin, in world units — a constant SIZE ON SCREEN at any zoom. */
function mapPinHitRadius(zoom) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return MAP_PIN_HIT_PX / safeZoom
}

/** Points → an SVG path `d`. Guards junk so one bad point cannot blank the whole stroke. */
function strokePath(points) {
  const clean = (Array.isArray(points) ? points : []).filter(
    (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y),
  )
  if (clean.length === 0) return ''
  if (clean.length === 1) {
    // A dot: a zero-length line renders nothing, so nudge a round cap into existence.
    const only = clean[0]
    return `M ${only.x} ${only.y} L ${only.x} ${only.y}`
  }
  return clean.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
}

/** The pin under a world point, nearest first, or null. */
function pinAt(pins, world, radius) {
  if (!Number.isFinite(world?.x) || !Number.isFinite(world?.y)) return null
  const limit = Number.isFinite(radius) && radius > 0 ? radius : MAP_PIN_HIT_PX
  let best = null
  let bestDistance = Infinity
  // `objectList`, not a bare loop: this runs inside the click handler, and a null list would throw
  // there — turning a stray click into a dead canvas.
  for (const pin of objectList(pins)) {
    const x = Number(pin?.x)
    const y = Number(pin?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const distance = Math.hypot(x - world.x, y - world.y)
    if (distance <= limit && distance < bestDistance) {
      best = pin
      bestDistance = distance
    }
  }
  return best
}

/**
 * The pin under a world point, counting its NAME as part of it.
 *
 * REPORTED: "光标点击点的名称时应该进入编辑页面而不是重新打点". A name is drawn offset to the right of its
 * marker and is often wider than the marker's hit radius, so clicking the text was treated as clicking
 * empty space — which, in 打点 mode, placed a NEW marker on top of the one the author was trying to open.
 *
 * The boxes come from `mapLabelLayout`, the same function the renderer uses, with the same arguments.
 * That is what makes what you see and what you can click the same thing: a separate estimate would drift
 * from the drawing and put the clickable area somewhere other than the visible text.
 *
 * The marker itself wins over any name, so a name that has been pushed away cannot steal a click that
 * was aimed at a marker.
 */
function mapPinHit(pins, labels, world, radius) {
  const direct = pinAt(pins, world, radius)
  if (direct !== null) return direct
  if (!Number.isFinite(world?.x) || !Number.isFinite(world?.y)) return null
  const byId = new Map(objectList(pins).map((pin) => [pin.id, pin]))
  let best = null
  let bestArea = Infinity
  for (const label of objectList(labels)) {
    const box = label?.box
    if (box === null || box === undefined) continue
    if (world.x < box.x0 || world.x > box.x1 || world.y < box.y0 || world.y > box.y1) continue
    const pin = byId.get(label.id)
    if (pin === undefined) continue
    const area = (box.x1 - box.x0) * (box.y1 - box.y0)
    // The SMALLEST box wins, so overlapping names do not make the choice depend on draw order.
    if (area < bestArea) {
      best = pin
      bestArea = area
    }
  }
  return best
}

/**
 * Mint an unused id with the given prefix.
 *
 * Ids in use are accepted EITHER as records (`{id}`) or as bare id strings, because both forms exist at
 * the call sites — `allPinIds` returns strings while the map list holds records. Reading only `.id`
 * silently discarded every bare string, so nothing was actually avoided, which is the same defect that
 * made a generated map collide with an existing one.
 */
function mintMapId(prefix, existing) {
  const taken = new Set()
  for (const entry of Array.isArray(existing) ? existing : []) {
    if (typeof entry === 'string' && entry !== '') taken.add(entry)
    else if (entry !== null && typeof entry === 'object') taken.add(String(entry.id ?? ''))
  }
  let index = 1
  while (taken.has(`${prefix}${index}`)) index += 1
  return `${prefix}${index}`
}

/**
 * A pin label's size, in SVG user units, for a given zoom.
 *
 * `labelFixed` false (the default) keeps the label a fixed size ON THE MAP: it is drawn in world
 * units, so it grows and shrinks with the map exactly as the strokes do — which is what the author
 * asked for after seeing labels stay put while the map shrank around them. `labelFixed` true keeps
 * a constant size ON SCREEN instead: readable at any zoom, but crowding the map when zoomed out.
 *
 * A per-pin `size` overrides the map's, so one important label can be larger than the rest.
 */
function mapLabelSize(map, zoom, pin) {
  const base = Number.isFinite(pin?.size) && pin.size > 0 ? pin.size : map?.labelSize
  const size = Number.isFinite(base) && base > 0 ? base : MAP_DEFAULT_LABEL_SIZE
  if (map?.labelFixed !== true) return size
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return size / safeZoom
}

/** Where a label sits relative to its pin: proportional to the label, so it never collides. */
function mapLabelOffset(labelSize) {
  const size = Number.isFinite(labelSize) && labelSize > 0 ? labelSize : MAP_DEFAULT_LABEL_SIZE
  return { x: size * 0.55, y: size * 0.35 }
}

/**
 * A label's width in world units, estimated from its characters.
 *
 * A CJK character is about one em wide and a Latin one about 0.58, which is close enough to lay labels
 * out without measuring text — and measuring is impossible here, because there is no layout in a server
 * render and no font metrics without a canvas.
 */
function mapLabelWidth(text, size) {
  const em = Number.isFinite(size) && size > 0 ? size : MAP_DEFAULT_LABEL_SIZE
  let units = 0
  for (const character of String(text ?? '')) {
    units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(character) ? 1 : 0.58
  }
  return units * em
}

/**
 * The placements a label may use, in order of preference: right, left, above, below, then the corners.
 *
 * Eight, because a settlement can be hemmed in on any side, and because trying is cheap.
 */
function mapLabelAnchors(size) {
  const em = Number.isFinite(size) && size > 0 ? size : MAP_DEFAULT_LABEL_SIZE
  const gap = em * 0.42
  const rows = [
    { x: gap, y: em * 0.35, anchor: 'start' },
    { x: -gap, y: em * 0.35, anchor: 'end' },
    { x: 0, y: -em * 0.5, anchor: 'middle' },
    { x: 0, y: em * 1.2, anchor: 'middle' },
    { x: gap, y: -em * 0.45, anchor: 'start' },
    { x: -gap, y: -em * 0.45, anchor: 'end' },
    { x: gap, y: em * 1.15, anchor: 'start' },
    { x: -gap, y: em * 1.15, anchor: 'end' },
  ]
  return rows
}

/**
 * The rectangle a label occupies.
 *
 * `y` is a text BASELINE, so the box sits mostly ABOVE it. Treating it as a top edge would let labels
 * overlap while the layout believed they were clear.
 */
function mapLabelBox(pin, text, size, anchor) {
  const width = mapLabelWidth(text, size)
  const height = size * 1.15
  const left =
    anchor.anchor === 'start'
      ? pin.x + anchor.x
      : anchor.anchor === 'end'
        ? pin.x + anchor.x - width
        : pin.x + anchor.x - width / 2
  const top = pin.y + anchor.y - height * 0.78
  return { x0: left, y0: top, x1: left + width, y1: top + height }
}

/** Do two boxes overlap, allowing a margin? Touching exactly does not count. */
function mapBoxesOverlap(a, b, pad = 0) {
  if (a === null || b === null) return false
  return a.x0 - pad < b.x1 && b.x0 - pad < a.x1 && a.y0 - pad < b.y1 && b.y0 - pad < a.y1
}

/**
 * Place every pin's label so that they do not overlap.
 *
 * REPORTED: "点的名称会重叠" — the names of the marks overlap. Labels were always drawn at one fixed
 * offset to the right of their pin, so two settlements close together produced two names on top of each
 * other, and neither could be read.
 *
 * Each label is tried at eight placements, and each of those at three distances — because a three
 * character name at size 34 is 102 world units wide, so two pins 40 units apart cannot both be labelled
 * at the first distance no matter which side each takes. Pushing one further out resolves it while
 * keeping the label on the side it chose, which keeps it obviously attached to its own pin.
 *
 * When nothing clears — a genuinely impossible cluster — the default placement is used anyway and the
 * entry is marked `crowded`. Drawing an unreadable label is bad; silently drawing NO label is worse,
 * because the name is data and the author cannot tell that it is missing.
 *
 * Pure, so the placement can be tested without a browser. The geometry is the part that can be wrong.
 *
 * @returns one `{ id, text, size, anchor, box, crowded }` per labelled pin, in input order.
 */
function mapLabelLayout(pins, map, zoom, options = {}) {
  const { pad = 0, labelOf = null, pushes = [1, 2, 3] } = options
  const placed = []
  const out = []
  for (const pin of objectList(pins)) {
    const text = typeof labelOf === 'function' ? labelOf(pin) : pin.label
    const label = typeof text === 'string' && text !== '' ? text : typeof pin.id === 'string' ? pin.id : ''
    if (label === '') continue
    const size = mapLabelSize(map, zoom, pin)
    // THE SAME COERCION THE RENDERER USES, and it matters: the renderer draws a pin at
    // `Number(pin.x) || 0`, so a junk position is drawn at the origin. Computing its label box from
    // NaN would describe a rectangle at nowhere, and a collision test against nowhere always says
    // "clear" — so a label could be placed on top of one that IS drawn.
    const at = { x: Number(pin.x) || 0, y: Number(pin.y) || 0 }
    const candidates = mapLabelAnchors(size)
    let chosen = null
    for (const push of pushes) {
      for (const base of candidates) {
        // Scaling BOTH components keeps the label on the side it picked; scaling only the vertical
        // would slide a "left" label onto the pin it belongs to.
        const anchor = { x: base.x * push, y: base.y * push, anchor: base.anchor }
        const box = mapLabelBox(at, label, size, anchor)
        if (!placed.some((other) => mapBoxesOverlap(box, other.box, pad))) {
          chosen = { anchor, box, crowded: false }
          break
        }
      }
      if (chosen !== null) break
    }
    if (chosen === null) {
      const anchor = candidates[0]
      chosen = { anchor, box: mapLabelBox(at, label, size, anchor), crowded: true }
    }
    placed.push(chosen)
    out.push({ id: pin.id, text: label, size, anchor: chosen.anchor, box: chosen.box, crowded: chosen.crowded })
  }
  return out
}

/**
 * A picked filename → one this project will accept, or null if nothing usable is left.
 *
 * Mirrors the host's rule, deliberately: a file called `我的 地图 (1).png` must not come back as a
 * 400 the author cannot act on. Pure, so the mapping is testable even though the picker is not.
 */
function mapAssetName(input) {
  const base = String(input ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, '-')
    // A leading dot, dash or underscore is rejected by the host, so strip the run.
    .replace(/^[^A-Za-z0-9\u4e00-\u9fff]+/, '')
  if (cleaned === '' || !/\.[A-Za-z0-9]+$/.test(cleaned)) return null
  if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(cleaned)) return null
  return cleaned.slice(0, 120)
}

/**
 * The URL an imported background is served from.
 *
 * The renderer cannot read the host's filesystem, so the image is fetched through the plugin's own
 * route — the same reason every other document goes through it.
 */
function mapAssetUrl(root, asset) {
  if (isBlank(root) || isBlank(asset)) return null
  return api(`${API}/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(`setting/map/assets/${asset}`)}`)
}

/**
 * Parse a CSS colour into channels, or null.
 *
 * Only the forms a theme can realistically produce: `#rgb`, `#rrggbb`, and `rgb()`/`rgba()`.
 * Anything else returns null, and every caller treats null as "no opinion".
 */
function mapParseColor(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === '') return null
  const short = /^#([0-9a-f]{3})$/.exec(text)
  if (short !== null) {
    const [r, g, b] = short[1].split('')
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) }
  }
  const long = /^#([0-9a-f]{6})$/.exec(text)
  if (long !== null) {
    return {
      r: parseInt(long[1].slice(0, 2), 16),
      g: parseInt(long[1].slice(2, 4), 16),
      b: parseInt(long[1].slice(4, 6), 16),
    }
  }
  const rgb = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/.exec(text)
  if (rgb === null) return null
  const channel = (part) => Math.max(0, Math.min(255, Math.round(Number(part))))
  return { r: channel(rgb[1]), g: channel(rgb[2]), b: channel(rgb[3]) }
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 *
 * Accepts a parsed `{r, g, b}` or any string `mapParseColor` understands. Returns null when the
 * colour cannot be read, so a caller can tell "no opinion" from "black".
 */
function mapLuminance(color) {
  const channels = typeof color === 'string' ? mapParseColor(color) : color
  if (channels === null || channels === undefined) return null
  const linear = (value) => {
    const c = Math.max(0, Math.min(255, Number(value))) / 255
    return Number.isFinite(c) ? (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) : null
  }
  const r = linear(channels.r)
  const g = linear(channels.g)
  const b = linear(channels.b)
  if (r === null || g === null || b === null) return null
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The WCAG contrast ratio between two colours, 1 (identical) to 21 (black on white).
 *
 * Null when either colour cannot be parsed, so a missing colour is never mistaken for an invisible
 * one — that distinction is the whole point of returning null instead of 1.
 */
function mapContrast(a, b) {
  const first = mapLuminance(a)
  const second = mapLuminance(b)
  if (first === null || second === null) return null
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Which markers link to a 地点, and on which maps.
 *
 * THE OTHER HALF OF THE LINK. A pin could name a 地点, but nothing went the other way: standing in the 地点
 * branch there was no way to learn that a marker on 「大陆」 points at it. The only symptom was that deleting
 * the place was REFUSED, with a message the author could not act on.
 *
 * @returns `[{ mapId, mapName, pinId, label }]`, one entry per linked marker.
 */
function mapPlaceLinks(maps, placeId) {
  const wanted = typeof placeId === 'string' && placeId !== '' ? placeId : null
  if (wanted === null) return []
  const out = []
  for (const map of objectList(maps)) {
    for (const pin of objectList(map?.pins)) {
      if (pin?.placeId !== wanted) continue
      out.push({
        mapId: typeof map?.id === 'string' ? map.id : '',
        mapName: mapDisplayName(map),
        pinId: typeof pin?.id === 'string' ? pin.id : '',
        label: typeof pin?.label === 'string' ? pin.label : '',
      })
    }
  }
  return out
}

/**
 * Clear every marker's link to a 地点, so that place can then be deleted.
 *
 * The PINS are kept: a marker is the author's work on the map, and a place being removed is no reason to
 * lose it. Only the link goes — which is precisely what the host's refusal asks for.
 */
function mapUnlinkPlace(maps, placeId) {
  const wanted = typeof placeId === 'string' && placeId !== '' ? placeId : null
  if (wanted === null) return objectList(maps)
  return objectList(maps).map((map) => ({
    ...map,
    pins: objectList(map?.pins).map((pin) => (pin?.placeId === wanted ? { ...pin, placeId: null } : pin)),
  }))
}

/**
 * A spot on a map where a new marker will be visible and not on top of an existing one.
 *
 * The centre first, then a widening ring. Dropping every new marker at the exact centre would stack them
 * invisibly — the second one would look like nothing happened, which is the same complaint as a button that
 * does nothing.
 */
function mapFreeSpot(map) {
  const canvas = mapCanvas(map)
  const pins = mapPins(map)
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  const gap = Math.max(30, Math.min(canvas.width, canvas.height) * 0.06)
  const clear = (x, y) => !pins.some((pin) => Math.hypot((Number(pin.x) || 0) - x, (Number(pin.y) || 0) - y) < gap)
  if (clear(cx, cy)) return { x: Math.round(cx), y: Math.round(cy) }
  const directions = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]
  for (let ring = 1; ring <= 12; ring += 1) {
    for (const [dx, dy] of directions) {
      const x = cx + dx * gap * ring
      const y = cy + dy * gap * ring
      if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) continue
      if (clear(x, y)) return { x: Math.round(x), y: Math.round(y) }
    }
  }
  return { x: Math.round(cx), y: Math.round(cy) }
}

/**
 * Put a marker for a 地点 on a chosen map.
 *
 * REQUESTED: "加「在地图上标出这个地点」". The link only worked from the map's side — you had to have a marker
 * already, open it, and pick a 地点 from a list. For an author holding a place and wondering where it is on the
 * map, that is backwards. This is the other direction, and it is the one that makes a 地点 and its marker into
 * one thing rather than two that happen to share an id.
 *
 * The marker gets NO label of its own, so the map draws the 地点's own name and keeps following it if the
 * place is renamed — see `mapLabelLayout`'s resolver.
 *
 * @returns `{ maps, pinId, x, y }`; `pinId` is null when that map no longer exists.
 */
function mapMarkPlace(maps, mapId, placeId) {
  const list = objectList(maps)
  const target = list.find((map) => map?.id === mapId)
  if (target === undefined || typeof placeId !== 'string' || placeId === '') {
    return { maps: list, pinId: null, x: null, y: null }
  }
  // Pin ids are unique across the WHOLE document, so they are minted from every pin everywhere.
  const id = mintMapId('pin-', allPinIds(list))
  const spot = mapFreeSpot(target)
  return {
    maps: list.map((map) =>
      map.id === mapId
        ? {
            ...map,
            pins: [
              ...objectList(map.pins),
              { id, placeId, x: spot.x, y: spot.y, label: '', color: null, size: null, dot: null },
            ],
          }
        : map,
    ),
    pinId: id,
    x: spot.x,
    y: spot.y,
  }
}

/**
 * The ink an export should draw with.
 *
 * THE DEFECT THIS FIXES. The map draws its uncoloured strokes and all of its pin labels with
 * `currentColor`, which comes from the app's theme. The export fills the sheet WHITE — so in a dark
 * theme the ink is light grey on white and the exported map is very nearly blank. Measured, the dark
 * theme's `#d8d8d8` on white is a contrast ratio of about 1.3:1, far under the 3:1 that graphics
 * need and the 4.5:1 that text needs.
 *
 * So the theme's colour is used WHEN IT IS LEGIBLE on the sheet, and dark ink when it is not. Either
 * way the author gets a readable map without having to think about the theme.
 */
function mapExportInk(resolved, background = '#ffffff') {
  const dark = '#333333'
  const ratio = mapContrast(resolved, background)
  // An unreadable colour is "no opinion", not "invisible": use the ink that always works.
  return ratio !== null && ratio >= 4.5 ? resolved : dark
}

/** A grid of world-space lines, so a drawn map still shows scale and orientation. */
function mapGridLines(canvas, step = 200) {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 200
  const vertical = []
  for (let x = 0; x <= canvas.width; x += safeStep) vertical.push(x)
  const horizontal = []
  for (let y = 0; y <= canvas.height; y += safeStep) horizontal.push(y)
  return { vertical, horizontal }
}

/** Place-name endings, so a generated settlement reads as a place rather than as a person. */
const MAP_PLACE_SUFFIX = ['城', '镇', '关', '港', '渡', '堡', '驿', '村']

/**
 * A plausible starting map: a coastline, some rivers, and a few settlements.
 *
 * Written from scratch, deliberately. Hex-Cartographer and Nortantis both do this and both are
 * copyleft — GPL-3.0 and AGPL-3.0 — and Hex-Cartographer does not even publish source, only a
 * minified bundle. So the IDEA is borrowed (generate a world, then fine-tune it, which is how
 * Nortantis describes itself) and none of the code or artwork is.
 *
 * Not a simulation: no tectonic plates, no erosion. It draws something an author can look at and
 * then edit, which is the whole point of a starting map.
 *
 * DETERMINISTIC from the seed, so the same seed always gives the same map. That is what makes it
 * testable, and it is also the feature: an author can keep reseeding until they like what they see.
 *
 * @param seed - any number; the same seed and canvas always give the same map.
 * @param canvas - `{width, height}` in world units.
 * @param taken - ids already in use, so generated pins never collide with existing ones.
 * @returns `{ strokes, pins }`, ready to drop into a map.
 */
function generateRandomMap(seed, canvas, taken = []) {
  const rng = makeRng(seed)
  const width = Number.isFinite(canvas?.width) && canvas.width > 0 ? canvas.width : 2000
  const height = Number.isFinite(canvas?.height) && canvas.height > 0 ? canvas.height : 1500
  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(width, height) * 0.34
  // Squashed vertically so a landmass fills a landscape canvas instead of sitting in a circle.
  const flatten = 0.78

  // --- the coastline, as a closed ring of harmonics: smooth, but not a circle ---
  const harmonics = [
    { k: 2, amp: 0.14 },
    { k: 3, amp: 0.11 },
    { k: 5, amp: 0.08 },
    { k: 7, amp: 0.05 },
    { k: 11, amp: 0.03 },
  ]
  const phase = harmonics.map(() => rng() * Math.PI * 2)
  const shapeAt = (angle) => {
    let r = 1
    for (let i = 0; i < harmonics.length; i += 1) {
      r += harmonics[i].amp * Math.sin(harmonics[i].k * angle + phase[i])
    }
    return r
  }
  const steps = 240
  const coastline = []
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2
    const r = shapeAt(angle) * radius
    coastline.push([Math.round(cx + Math.cos(angle) * r), Math.round(cy + Math.sin(angle) * r * flatten)])
  }
  const strokes = [{ color: '#3f4a5a', points: coastline }]

  // --- rivers, from inland out to the coast, wandering rather than radiating ---
  //
  // Emitted as PATHS rather than strokes, so they come out TAPERED. An SVG stroke has one width for
  // its whole length, so a river drawn as a stroke reads as a wire; the bank polygon does not.
  const paths = []
  const rivers = 3 + Math.floor(rng() * 3)
  for (let i = 0; i < rivers; i += 1) {
    const angle = rng() * Math.PI * 2
    const coastR = shapeAt(angle) * radius
    const startR = coastR * (0.12 + rng() * 0.28)
    const segments = 26
    const points = []
    let drift = angle
    for (let s = 0; s <= segments; s += 1) {
      const t = s / segments
      drift += (rng() - 0.5) * 0.24
      const r = startR + (coastR - startR) * t
      points.push({ x: Math.round(cx + Math.cos(drift) * r), y: Math.round(cy + Math.sin(drift) * r * flatten) })
    }
    paths.push({
      id: `path-${i + 1}`,
      kind: 'river',
      color: MAP_PATH_KINDS.river.color,
      // Widest at the mouth, which here is on the coast.
      width: 14 + Math.round(rng() * 22),
      taper: 0.9,
      dash: 'solid',
      points,
    })
  }

  // --- settlements, placed on land, named from the project's own tables ---
  // Ids in use are accepted EITHER as records (`{id}`) or as bare id strings. Reading only `.id`
  // silently discarded every bare string, so nothing was actually avoided — caught by a test that
  // generated into a list of ids already in use.
  const ids = new Set()
  for (const entry of Array.isArray(taken) ? taken : []) {
    if (typeof entry === 'string' && entry !== '') ids.add(entry)
    else if (entry !== null && typeof entry === 'object') ids.add(String(entry.id ?? ''))
  }
  const pins = []
  const count = 4 + Math.floor(rng() * 4)
  let next = 1
  for (let i = 0; i < count; i += 1) {
    const angle = rng() * Math.PI * 2
    const r = shapeAt(angle) * radius * (0.18 + rng() * 0.6)
    let id = `pin-${next}`
    while (ids.has(id)) {
      next += 1
      id = `pin-${next}`
    }
    ids.add(id)
    next += 1
    pins.push({
      id,
      placeId: null,
      x: Math.round(cx + Math.cos(angle) * r),
      y: Math.round(cy + Math.sin(angle) * r * flatten),
      // A settlement reads as a place: 姓 + 名 + 城/关/港…
      label: `${pick(rng, TABLES.surname)}${pick(rng, TABLES.givenMale)}${pick(rng, MAP_PLACE_SUFFIX)}`,
      color: null,
      size: null,
    })
  }

  // --- a few roads between the settlements, drawn as UNIFORM paths so the difference is visible ---
  for (let i = 0; i + 1 < pins.length; i += 1) {
    const a = pins[i]
    const b = pins[i + 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) > radius * 1.1) continue
    // One bend, so a road is not a ruler line between two dots.
    const mid = { x: Math.round((a.x + b.x) / 2 + (rng() - 0.5) * 90), y: Math.round((a.y + b.y) / 2 + (rng() - 0.5) * 90) }
    paths.push({
      id: `path-road-${i + 1}`,
      kind: 'road',
      color: MAP_PATH_KINDS.road.color,
      width: MAP_PATH_KINDS.road.width,
      taper: 0,
      dash: 'dashed',
      points: [{ x: a.x, y: a.y }, mid, { x: b.x, y: b.y }],
    })
  }

  return { strokes, paths, pins }
}

// --- rivers and roads, drawn from waypoints --------------------------------
//
// WHY PATHS ARE NOT STROKES. A hand-drawn river looks like a scribble, because it is one: an SVG
// stroke has a single width for its whole length. A river narrows to nothing at its source and widens
// toward its mouth, and that taper is most of what makes it read as a river.
//
// THE TECHNIQUE IS BORROWED, THE CODE IS NOT. Azgaar's Fantasy-Map-Generator (MIT) states it plainly
// in its own river renderer: "the polygon is the course inflated by its width, which peaks at the
// mouth". So the course — the polyline through the waypoints — is offset perpendicular to itself on
// both sides by a half-width that grows along its length, and the two banks are joined into one
// closed filled polygon. `mapBankPath` below is that idea, reimplemented: their width is driven by a
// hydrological simulation (discharge in m³/s) that this project has no equivalent of, so the width
// here grows with POSITION ALONG THE COURSE instead, which needs no invented physics.
//
// Azgaar also smooths with d3's `curveCatmullRom`. There is no d3 here and this client is buildless
// by design, so `mapSmoothPath` converts Catmull-Rom to cubic Béziers directly — a standard, short
// conversion.

/** How a path is drawn. `taper` 0 is a uniform road; 1 narrows to nothing at the source. */
const MAP_PATH_KINDS = {
  river: { label: '河流', color: '#5b8fb0', width: 26, taper: 0.85, dash: 'solid' },
  road: { label: '道路', color: '#a8763e', width: 8, taper: 0, dash: 'dashed' },
  border: { label: '边界', color: '#8a5ad0', width: 10, taper: 0, dash: 'dotted' },
  // 山脉 is a COURSE, not a point: a range runs along a ridge. Drawing it from waypoints means the
  // existing editing — placing, dragging, erasing, naming — works on it with no second mechanism.
  mountain: { label: '山脉', color: '#8a6a4a', width: 46, taper: 0, dash: 'solid' },
}
const MAP_PATH_KIND_IDS = ['river', 'road', 'border', 'mountain']
const MAP_PATH_WIDTHS = [6, 10, 18, 26, 40]
const MAP_DASHES = { solid: null, dashed: [12, 8], dotted: [3, 7] }

/**
 * A halo drawn UNDER text so it stays readable on whatever it lands on.
 *
 * It must CONTRAST with the paper, so it deliberately does NOT go through `mapInkFor` — that returns the
 * theme's ink, which is the same colour as the text and therefore no halo at all. On a printed map the halo
 * is white; on a dark theme it has to be black, which is why this asks the paper's luminance.
 */
function mapHaloColor(value, alpha = null) {
  const paper = mapPaper(value)
  const luminance = mapLuminance(paper)
  const dark = luminance !== null && luminance < 0.5
  const a = Number.isFinite(alpha) ? alpha : dark ? 0.55 : 0.5
  return dark ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`
}

/**
 * The panel anchor for a thing on the map — the `data-item` value of its row.
 *
 * The panel and the canvas name the same object two ways: a stroke is `{ kind: 'stroke', index: 2 }` for the
 * pointer but `stroke-2` for its row. One function decides the translation, so a jump cannot land on the
 * wrong row.
 */
function mapFocusAnchor(target) {
  if (target === null || target === undefined) return null
  if (target.kind === 'stroke') return `stroke-${Number(target.index)}`
  if (typeof target.id !== 'string' || target.id === '') return null
  return target.id
}

/** Which panel group holds a thing, so the jump can open it before scrolling. */
function mapFocusGroup(target) {
  if (target === null || target === undefined) return null
  if (target.kind === 'stroke') return 'strokes'
  if (target.kind === 'pin') return 'pins'
  if (target.kind === 'shape') return 'shapes'
  if (target.kind === 'text') return 'texts'
  if (target.kind === 'stamp') return 'stamps'
  // A course's group is its KIND — 河流, 道路, 边界, 山脉 — because that is how the panel lists them.
  if (target.kind === 'path') return typeof target.pathKind === 'string' && target.pathKind !== '' ? target.pathKind : null
  return null
}

/**
 * Whether a run of points actually closes on itself.
 *
 * THE ONE TEST, shared by the spray, by the fills and by the panel. The fills used to close EVERY filled
 * outline by force — `mapSmoothPath(points, true)` — so an open road, border, mountain range or pen stroke
 * with a fill got a skin stretched across its whole span. Reported as "「山脉」「道路」「边界」中间会自动喷漆".
 *
 * A gap of `MAP_CLOSED_GAP` counts as closed, because a hand-drawn coastline will not meet to the pixel.
 */
function mapOutlineClosed(points) {
  const list = objectList(points)
  if (list.length < 3) return false
  const first = list[0]
  const last = list[list.length - 1]
  return Math.hypot((Number(last.x) || 0) - (Number(first.x) || 0), (Number(last.y) || 0) - (Number(first.y) || 0)) <= MAP_CLOSED_GAP
}

/** A fill is a colour or nothing. `undefined` counts as nothing, as `null` does. */
function mapFillOf(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * What the panel should say about a fill the author set on an outline that no longer closes.
 *
 * The fill is NOT deleted — the outline may only be open because a point was dragged, and closing it again
 * brings the colour back. The author is told why nothing is painted and offered the way out.
 */
function mapFillAdvice(kind, fill, points) {
  if (mapFillOf(fill) === null) return null
  if (kind === 'shape') return null
  if (mapOutlineClosed(points)) return null
  return '这条线没有闭合，填充不会显示。首尾接上（差距 40 以内）就会显示，或按「清除填充」。'
}

/**
 * The widest a path may be drawn, so a typo cannot fill the canvas with one shape. */
const MAP_PATH_MAX_WIDTH = 400

// --- free text and symbol stamps --------------------------------------------
//
// ASKED FOR, and the last two items of the original drawing list: "自由文字标注" and "符号图章".
//
// Both are placed objects like a marker: a point on the map plus some content. They differ from a marker in
// that a marker means "a 地点 is here" and these mean "write this" and "draw this symbol here" — so they are
// separate lists rather than a growing union inside `pins`.

/** Sizes a free text label may take. */
const MAP_TEXT_SIZES = [10, 14, 18, 24, 32, 48, 72]

/**
 * The stamp glyphs.
 *
 * Each is drawn from PRIMITIVES in a normalised 0..1 box, so one definition serves the screen, the export
 * and the hit test, and scaling is a single multiplication. Writing them as SVG path strings would put the
 * geometry where nothing else could reuse it, and a stamp's clickable area would then have to be guessed.
 *
 * `fill: true` means the part is painted in the stamp's ink; `fill: false` means outlined in it.
 */
const MAP_SYMBOLS = {
  tree: {
    label: '树',
    parts: [
      { kind: 'poly', fill: true, points: [[0.5, 0.02], [0.95, 0.62], [0.05, 0.62]] },
      { kind: 'poly', fill: true, points: [[0.5, 0.3], [1, 0.92], [0, 0.92]] },
      { kind: 'poly', fill: true, points: [[0.42, 0.86], [0.58, 0.86], [0.58, 1], [0.42, 1]] },
    ],
  },
  mountain: {
    label: '山',
    parts: [
      { kind: 'poly', fill: true, points: [[0.42, 0.06], [0.92, 0.96], [0, 0.96]] },
      { kind: 'poly', fill: false, points: [[0.42, 0.06], [0.56, 0.34], [0.46, 0.44], [0.6, 0.56]] },
    ],
  },
  town: {
    label: '城镇',
    // A WALLED TOWN. The crenellated curtain wall is what makes it unmistakably a town and not a village:
    // reported as "把「城镇」和「村庄」再区分地明显一些", and two clusters of houses are not distinguishable.
    parts: [
      {
        kind: 'poly',
        fill: false,
        points: [[0.04, 0.52], [0.04, 0.96], [0.96, 0.96], [0.96, 0.52], [0.88, 0.52], [0.88, 0.44], [0.78, 0.44], [0.78, 0.52], [0.66, 0.52], [0.66, 0.44], [0.56, 0.44], [0.56, 0.52], [0.44, 0.52], [0.44, 0.44], [0.34, 0.44], [0.34, 0.52], [0.22, 0.52], [0.22, 0.44], [0.12, 0.44], [0.12, 0.52]],
      },
      { kind: 'poly', fill: false, points: [[0.36, 0.1], [0.64, 0.1], [0.64, 0.52], [0.36, 0.52]] },
      { kind: 'poly', fill: true, points: [[0.3, 0.12], [0.7, 0.12], [0.5, 0]] },
      { kind: 'poly', fill: false, points: [[0.4, 0.96], [0.4, 0.76], [0.6, 0.76], [0.6, 0.96]] },
    ],
  },
  village: {
    label: '村庄',
    // THREE SMALL HOUSES, and nothing else — no wall, no keep. Deliberately unlike the town's silhouette.
    parts: [
      { kind: 'poly', fill: true, points: [[0.08, 0.6], [0.3, 0.6], [0.3, 0.94], [0.08, 0.94]] },
      { kind: 'poly', fill: true, points: [[0.02, 0.6], [0.36, 0.6], [0.19, 0.4]] },
      { kind: 'poly', fill: true, points: [[0.38, 0.7], [0.58, 0.7], [0.58, 0.94], [0.38, 0.94]] },
      { kind: 'poly', fill: true, points: [[0.33, 0.7], [0.63, 0.7], [0.48, 0.52]] },
      { kind: 'poly', fill: true, points: [[0.66, 0.64], [0.9, 0.64], [0.9, 0.94], [0.66, 0.94]] },
      { kind: 'poly', fill: true, points: [[0.6, 0.64], [0.96, 0.64], [0.78, 0.44]] },
    ],
  },
  bridge: {
    label: '桥',
    parts: [
      // A LINE, not a polygon. A two-point `<polygon>` has no area and draws NOTHING — every stroke-only
      // part of a glyph has to say `line` and render as a `<polyline>`.
      { kind: 'line', fill: false, points: [[0.02, 0.62], [0.98, 0.62]] },
      { kind: 'line', fill: false, points: [[0.12, 0.62], [0.3, 0.28], [0.7, 0.28], [0.88, 0.62]] },
      { kind: 'poly', fill: true, points: [[0.06, 0.62], [0.14, 0.62], [0.14, 0.86], [0.06, 0.86]] },
      { kind: 'poly', fill: true, points: [[0.86, 0.62], [0.94, 0.62], [0.94, 0.86], [0.86, 0.86]] },
    ],
  },
  anchor: {
    label: '港口',
    parts: [
      { kind: 'line', fill: false, points: [[0.5, 0.1], [0.5, 0.86]] },
      { kind: 'line', fill: false, points: [[0.3, 0.26], [0.7, 0.26]] },
      { kind: 'line', fill: false, points: [[0.12, 0.5], [0.12, 0.72], [0.5, 0.98], [0.88, 0.72], [0.88, 0.5]] },
      { kind: 'poly', fill: true, points: [[0.5, 0.02], [0.62, 0.14], [0.5, 0.26], [0.38, 0.14]] },
    ],
  },
  ruin: {
    // Was 遗迹, drawn as broken columns. Now a QUESTION MARK, which is what a map means by it: not explored
    // yet. The id stays `ruin` so stamps already placed on a map keep their glyph.
    label: '未知',
    parts: [
      { kind: 'line', fill: false, points: [[0.16, 0.26], [0.22, 0.12], [0.38, 0.04], [0.58, 0.04], [0.74, 0.12], [0.82, 0.28], [0.8, 0.44], [0.68, 0.56], [0.52, 0.68], [0.48, 0.78], [0.48, 0.84]] },
      { kind: 'poly', fill: true, points: [[0.38, 0.9], [0.58, 0.9], [0.58, 1], [0.38, 1]] },
    ],
  },
  star: {
    label: '星',
    parts: [
      {
        kind: 'poly',
        fill: true,
        points: [[0.5, 0], [0.62, 0.36], [1, 0.36], [0.69, 0.58], [0.81, 0.95], [0.5, 0.72], [0.19, 0.95], [0.31, 0.58], [0, 0.36], [0.38, 0.36]],
      },
    ],
  },
  danger: {
    // Was a triangle, which could not be told apart from 山. Reported exactly that way.
    label: '危险',
    parts: [
      // A SKULL. The cranium and jaw are OUTLINES, so the sockets can be filled dark inside them — a filled
      // skull with filled eyes would be a solid blob.
      { kind: 'poly', fill: false, points: [[0.5, 0.04], [0.8, 0.12], [0.96, 0.34], [0.94, 0.56], [0.8, 0.66], [0.2, 0.66], [0.06, 0.56], [0.04, 0.34], [0.2, 0.12]] },
      { kind: 'poly', fill: false, points: [[0.3, 0.66], [0.7, 0.66], [0.68, 0.86], [0.6, 0.96], [0.4, 0.96], [0.32, 0.86]] },
      { kind: 'poly', fill: true, points: [[0.22, 0.28], [0.42, 0.26], [0.44, 0.44], [0.24, 0.46]] },
      { kind: 'poly', fill: true, points: [[0.58, 0.26], [0.78, 0.28], [0.76, 0.46], [0.56, 0.44]] },
      { kind: 'poly', fill: true, points: [[0.5, 0.46], [0.57, 0.6], [0.43, 0.6]] },
      { kind: 'line', fill: false, points: [[0.42, 0.72], [0.42, 0.9]] },
      { kind: 'line', fill: false, points: [[0.58, 0.72], [0.58, 0.9]] },
    ],
  },
}
const MAP_SYMBOL_IDS = ['tree', 'mountain', 'town', 'village', 'bridge', 'anchor', 'ruin', 'star', 'danger']

/** Multiples of the base stamp size, so one number sizes every glyph. */
const MAP_STAMP_SIZES = [18, 26, 36, 52, 72]
const MAP_STAMP_DEFAULT_SIZE = 36
const MAP_STAMP_DEFAULT_COLOR = '#4a3b2a'
const MAP_TEXT_DEFAULT_SIZE = 24
const MAP_TEXT_DEFAULT_COLOR = '#3a3a3a'

/**
 * The colour themes.
 *
 * A theme paints the PAPER, the grid and the frame, and supplies the ink for anything that declares no
 * colour of its own. It NEVER overrides a colour the author chose: a themed parchment map keeps every
 * stroke exactly the colour it was drawn in, which is the only way a theme can be tried and removed without
 * losing work.
 */
const MAP_THEMES = {
  plain: { label: '原色', paper: '#ffffff', ink: '#3a3a3a', grid: '#e6e6e6', edge: '#cccccc' },
  parchment: { label: '羊皮纸', paper: '#f2e4c6', ink: '#5b4632', grid: '#ddc9a0', edge: '#b99f74' },
  ink: { label: '水墨', paper: '#f7f5ef', ink: '#3a3a38', grid: '#dcd8cc', edge: '#b8b2a4' },
  blueprint: { label: '蓝图', paper: '#12314f', ink: '#dce9f5', grid: '#2f5677', edge: '#4a7ea6' },
  night: { label: '夜航', paper: '#1b1f2a', ink: '#cfd8e8', grid: '#2e3546', edge: '#49536b' },
}
const MAP_THEME_IDS = ['plain', 'parchment', 'ink', 'blueprint', 'night']
const MAP_THEME_DEFAULT = 'plain'

/** The theme a map uses. A missing or unknown id falls back to 原色 rather than to nothing. */
function mapTheme(value) {
  const id = typeof value?.theme === 'string' && MAP_THEME_IDS.includes(value.theme) ? value.theme : MAP_THEME_DEFAULT
  return MAP_THEMES[id]
}

/** The theme's id, for the picker to compare against. */
function mapThemeId(value) {
  return typeof value?.theme === 'string' && MAP_THEME_IDS.includes(value.theme) ? value.theme : MAP_THEME_DEFAULT
}

/** The paper a map is drawn on: the theme's, unless the map has an imported image behind it. */
function mapPaper(value) {
  return mapTheme(value).paper
}

/**
 * The ink to draw something in when the author has not chosen one.
 *
 * Same rule as `mapExportInk`: an explicit colour always wins, and the theme only fills the gap. That is
 * what keeps a theme a change of PAPER rather than a repaint of the author's work.
 */
function mapInkFor(value, own, fallback = MAP_DEFAULT_COLOR) {
  if (typeof own === 'string' && own !== '') return own
  const theme = mapTheme(value)
  if (typeof theme?.ink === 'string' && theme.ink !== '') return theme.ink
  return fallback === null ? MAP_DEFAULT_COLOR : fallback
}


/** A waypoint counts as hit within this many screen pixels, as a pin does. */
const MAP_PATH_HIT_PX = 14

/**
 * A path's half-width at `t` (0 at the source, 1 at the mouth).
 *
 * `taper` 0 gives a constant half-width — a road. `taper` 1 grows from nothing to full, convexly, so
 * the widening is visible along the middle rather than only at the very end. The exponent is what
 * makes a river look like a river rather than a wedge.
 */
function mapPathHalfWidth(t, width, taper) {
  const half = (Number.isFinite(width) && width > 0 ? Math.min(width, MAP_PATH_MAX_WIDTH) : 20) / 2
  const amount = Number.isFinite(taper) ? Math.max(0, Math.min(1, taper)) : 0
  const along = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0
  return half * ((1 - amount) + amount * along ** 1.6)
}

/**
 * Points → an SVG `d` through every one of them, smoothed.
 *
 * Catmull-Rom, converted to cubic Béziers: the control points of the segment from `p1` to `p2` are
 * `p1 + (p2 - p0)/6` and `p2 - (p3 - p1)/6`. That conversion is why the curve PASSES THROUGH each
 * waypoint — the property that matters, because a waypoint the author dragged must end up under the
 * drawn line. Endpoints clamp their missing neighbour, so the curve is defined at the ends instead of
 * swinging past them.
 */
function mapSmoothPath(points, closed = false) {
  const pts = (Array.isArray(points) ? points : []).filter(
    (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y),
  )
  if (pts.length === 0) return ''
  const round = (value) => Math.round(value * 100) / 100
  if (pts.length === 1) return `M ${round(pts[0].x)} ${round(pts[0].y)}`
  if (pts.length === 2) {
    return `M ${round(pts[0].x)} ${round(pts[0].y)} L ${round(pts[1].x)} ${round(pts[1].y)}`
  }
  const at = (index) => {
    if (closed) return pts[((index % pts.length) + pts.length) % pts.length]
    return pts[Math.max(0, Math.min(pts.length - 1, index))]
  }
  let d = `M ${round(pts[0].x)} ${round(pts[0].y)}`
  const segments = closed ? pts.length : pts.length - 1
  for (let i = 0; i < segments; i += 1) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(p2.x)} ${round(p2.y)}`
  }
  return closed ? `${d} Z` : d
}

/**
 * A path's course inflated into a closed polygon — the two banks, joined.
 *
 * The perpendicular at each waypoint comes from `atan2(prev - next)`; its sine and cosine are the two
 * components of the direction at right angles to the course. That is the trick Azgaar's river
 * generator uses, and it is worth stating because the more obvious `atan2(next - prev)` puts the
 * banks on the wrong sides and folds the polygon through itself.
 *
 * EACH BANK IS SMOOTHED AS AN OPEN CURVE, and the two end caps are straight lines. Smoothing the whole
 * ring at once rounds every cap too, and a cap is a 180° turn — the worst case for Catmull-Rom, which
 * overshoots it. Measured on a straight width-40 course, the ring bulged to ±26.7 instead of ±20: a
 * third too wide at BOTH ends. Smoothed open, each end clamps its missing neighbour and the width is
 * exact.
 */
function mapBankPath(points, width, taper) {
  const clean = []
  for (const point of Array.isArray(points) ? points : []) {
    const x = Number(point?.x)
    const y = Number(point?.y)
    if (Number.isFinite(x) && Number.isFinite(y)) clean.push({ x, y })
  }
  if (clean.length < 2) return ''
  const left = []
  const right = []
  for (let i = 0; i < clean.length; i += 1) {
    const previous = clean[i - 1] ?? clean[i]
    const next = clean[i + 1] ?? clean[i]
    const here = clean[i]
    const t = clean.length === 1 ? 1 : i / (clean.length - 1)
    const half = mapPathHalfWidth(t, width, taper)
    const angle = Math.atan2(previous.y - next.y, previous.x - next.x)
    const sin = Math.sin(angle) * half
    const cos = Math.cos(angle) * half
    left.push({ x: here.x - sin, y: here.y + cos })
    right.push({ x: here.x + sin, y: here.y - cos })
  }
  const round = (value) => Math.round(value * 100) / 100
  // Down the right bank from source to mouth...
  const forward = mapSmoothPath(right)
  // ...straight across the mouth, then back up the left bank. Dropping the second curve's own `M` is
  // what joins the two into one continuous outline.
  const backward = mapSmoothPath([...left].reverse())
  const curves = backward.slice(backward.indexOf('C'))
  const mouth = left[left.length - 1]
  const across = ` L ${round(mouth.x)} ${round(mouth.y)}`
  // `Z` closes the source cap, from the left bank's first point back to the right bank's.
  return curves === '' ? `${forward}${across} Z` : `${forward}${across}${curves} Z`
}

/**
 * One path, normalised, or null when there are fewer than `minPoints` usable points.
 *
 * `minPoints` exists because a path has TWO views and they need different answers. Drawing needs two
 * points — one point draws nothing. Editing needs one — a course is started by its first click, and
 * that draft has to survive long enough to receive a second.
 */
function normalizePath(value, index = 0, taken = new Set(), minPoints = 2) {
  const kind = MAP_PATH_KIND_IDS.includes(value?.kind) ? value.kind : 'river'
  const preset = MAP_PATH_KINDS[kind]
  let id = typeof value?.id === 'string' && value.id !== '' ? value.id : `path-${index + 1}`
  // Ids must be unique within a map, or dragging one waypoint would move another path's.
  let suffix = 1
  while (taken.has(id)) {
    suffix += 1
    id = `path-${index + 1}-${suffix}`
  }
  taken.add(id)
  // Points are accepted as `[x, y]` PAIRS (the compact form the document uses, and what the stroke
  // code writes) or as `{x, y}` records. Mapping pairs through `point.x` first, as this once did,
  // silently reduced every pair to nothing and dropped the whole path — so a saved map came back with
  // no rivers. `cleanPoints` handles both forms, so it is handed the value directly.
  const points = cleanPoints(value?.points)
  if (points.length < minPoints) return null
  const width = Number(value?.width)
  const taper = Number(value?.taper)
  return {
    id,
    kind,
    // The NAME is preserved exactly, including blank, for the same reason a map's is: the field is
    // bound to this value, so substituting anything would put it back into the input while typing.
    name: typeof value?.name === 'string' ? value.name : '',
    points,
    color: typeof value?.color === 'string' && value.color !== '' ? value.color : preset.color,
    width: Number.isFinite(width) && width > 0 ? Math.min(width, MAP_PATH_MAX_WIDTH) : preset.width,
    taper: Number.isFinite(taper) ? Math.max(0, Math.min(1, taper)) : preset.taper,
    dash: Object.prototype.hasOwnProperty.call(MAP_DASHES, value?.dash) ? value.dash : preset.dash,
    // THE FILL WAS MISSING HERE, so a sprayed course's colour was silently thrown away the moment the
    // document was read back — the spray appeared to work and then the fill was gone, and no control could
    // set or clear one. Shapes carried their fill and courses did not, which is the inconsistency that made
    // "中间会自动喷漆" impossible to pin down.
    fill: mapFillOf(value?.fill),
  }
}

/** Every path in a map, normalised. Unfinished paths are dropped, because one point draws nothing. */
function mapPaths(map) {
  return pathList(map, 2)
}

/**
 * Every path in a map INCLUDING unfinished ones — the EDITING view.
 *
 * These two views are not interchangeable, and using the drawing one to edit produced a defect the
 * author reported exactly: existing rivers could be opened and changed, but a NEW one could never be
 * drawn. The first click wrote a one-point draft; the second click looked for that draft in the
 * drawing view, which had filtered it out, found nothing, and did nothing. Any other edit in between
 * was worse — `updatePaths` rewrote the list from the drawing view and erased the draft outright.
 *
 * So: DRAW with `mapPaths`, EDIT with `mapAllPaths`.
 */
function mapAllPaths(map) {
  return pathList(map, 1)
}

/** The shared normaliser behind both views. */
function pathList(map, minPoints) {
  const taken = new Set()
  const out = []
  for (const [index, value] of objectList(map?.paths).entries()) {
    const path = normalizePath(value, index, taken, minPoints)
    if (path !== null) out.push(path)
  }
  return out
}

/** Which path and which waypoint of it is under a world point, nearest first. */
function pathPointAt(paths, world, radius) {
  if (!Number.isFinite(world?.x) || !Number.isFinite(world?.y)) return null
  const limit = Number.isFinite(radius) && radius > 0 ? radius : MAP_PATH_HIT_PX
  let best = null
  let bestDistance = Infinity
  for (const path of objectList(paths)) {
    const points = Array.isArray(path?.points) ? path.points : []
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue
      const distance = Math.hypot(point.x - world.x, point.y - world.y)
      if (distance <= limit && distance < bestDistance) {
        best = { id: path.id, index }
        bestDistance = distance
      }
    }
  }
  return best
}

/**
 * Where a new waypoint belongs on an existing course: after the nearest SEGMENT, not the nearest
 * waypoint.
 *
 * Using the nearest waypoint would always insert beside one, so clicking halfway along a long straight
 * stretch would put the point at one end and the shape would not follow the pointer.
 */
function pathInsertIndex(points, world) {
  const clean = (Array.isArray(points) ? points : []).filter(
    (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y),
  )
  if (clean.length === 0) return 0
  if (!Number.isFinite(world?.x) || !Number.isFinite(world?.y)) return clean.length
  let best = clean.length
  let bestDistance = Infinity
  for (let i = 0; i < clean.length - 1; i += 1) {
    const a = clean[i]
    const b = clean[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    // Project onto the segment and clamp, so the distance is to the segment and not to its infinite line.
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((world.x - a.x) * dx + (world.y - a.y) * dy) / lengthSquared))
    const distance = Math.hypot(world.x - (a.x + t * dx), world.y - (a.y + t * dy))
    if (distance < bestDistance) {
      bestDistance = distance
      // WHERE the click belongs, by which side of the segment it fell:
      //   at or before `a` → before a      (index i)
      //   inside it        → between a and b (index i + 1)
      //   at or beyond `b` → after b       (index i + 2)
      // Returning `i + 1` for all three put a click past the END into the middle of the course, and a
      // click before the START likewise — both caught by tests, both invisible until you noticed the
      // waypoint was not where you clicked.
      best = t <= 0 ? i : t >= 1 ? i + 2 : i + 1
    }
  }
  return Math.min(best, clean.length)
}

/** The path with a new waypoint inserted where the course actually runs. */
function mapPathInsert(paths, id, world) {
  const point = { x: Math.round(Number(world?.x) || 0), y: Math.round(Number(world?.y) || 0) }
  return objectList(paths).map((path) => {
    if (path.id !== id) return path
    const at = pathInsertIndex(path.points, point)
    return { ...path, points: [...path.points.slice(0, at), point, ...path.points.slice(at)] }
  })
}

/** Move one waypoint — what dragging one does. */
function mapPathMovePoint(paths, id, index, world) {
  const x = Math.round(Number(world?.x))
  const y = Math.round(Number(world?.y))
  if (!Number.isFinite(x) || !Number.isFinite(y)) return objectList(paths)
  return objectList(paths).map((path) =>
    path.id === id && Number.isInteger(index) && index >= 0 && index < path.points.length
      ? { ...path, points: path.points.map((point, at) => (at === index ? { x, y } : point)) }
      : path,
  )
}

/**
 * Remove one waypoint.
 *
 * A path left with fewer than two points is REMOVED: it draws nothing, and keeping it would leave an
 * invisible object that can still be selected and still counts in the map's total.
 */
function mapPathRemovePoint(paths, id, index) {
  const out = []
  for (const path of objectList(paths)) {
    if (path.id !== id) {
      out.push(path)
      continue
    }
    const points = path.points.filter((_point, at) => at !== index)
    if (points.length >= 2) out.push({ ...path, points })
  }
  return out
}

/** A new path from one waypoint. Not yet drawable — the second click completes it. */
function mapPathStart(paths, id, world, kind = 'river') {
  const preset = MAP_PATH_KINDS[kind] ?? MAP_PATH_KINDS.river
  const point = { x: Math.round(Number(world?.x) || 0), y: Math.round(Number(world?.y) || 0) }
  return [
    ...objectList(paths),
    { id, kind, name: '', points: [point], color: preset.color, width: preset.width, taper: preset.taper, dash: preset.dash },
  ]
}

/** Append a waypoint to the end of a path, which is what each click along a course does. */
function mapPathAppend(paths, id, world) {
  const point = { x: Math.round(Number(world?.x) || 0), y: Math.round(Number(world?.y) || 0) }
  return objectList(paths).map((path) => (path.id === id ? { ...path, points: [...path.points, point] } : path))
}

/** Change one path's settings. */
function mapPathUpdate(paths, id, patch) {
  const changes = patch !== null && typeof patch === 'object' ? patch : {}
  return objectList(paths).map((path) => {
    if (path.id !== id) return path
    const preset = MAP_PATH_KINDS[changes.kind] ?? MAP_PATH_KINDS[path.kind] ?? MAP_PATH_KINDS.river
    // SWITCHING KIND ADOPTS THE NEW KIND'S LOOK, unless the patch says otherwise. Keeping the old style
    // meant pressing 河流 on a road produced `kind: 'river'` with `taper: 0` — a river by name, drawn as
    // an untapered line, which is precisely what the author was trying to stop seeing.
    const restyled =
      typeof changes.kind === 'string' && changes.kind !== path.kind
        ? { color: preset.color, width: preset.width, taper: preset.taper, dash: preset.dash }
        : {}
    const next = { ...path, ...restyled, ...changes }
    const width = Number(next.width)
    const taper = Number(next.taper)
    return {
      ...next,
      color: typeof next.color === 'string' && next.color !== '' ? next.color : preset.color,
      width: Number.isFinite(width) && width > 0 ? Math.min(width, MAP_PATH_MAX_WIDTH) : preset.width,
      taper: Number.isFinite(taper) ? Math.max(0, Math.min(1, taper)) : preset.taper,
      dash: Object.prototype.hasOwnProperty.call(MAP_DASHES, next.dash) ? next.dash : preset.dash,
    }
  })
}

/**
 * What to CALL a course: its name if it has one, else its kind and size.
 *
 * A display fallback, deliberately — `normalizePath` stores exactly what was typed, so clearing the
 * name field leaves it clear and the next keystroke is not appended to an invented title.
 */
function mapPathTitle(path) {
  const name = typeof path?.name === 'string' ? path.name.trim() : ''
  if (name !== '') return name
  const kind = MAP_PATH_KINDS[path?.kind]?.label ?? '路径'
  const points = Array.isArray(path?.points) ? path.points.length : 0
  return `${kind} · ${points} 个路点`
}

/** Rename one course, storing exactly what was typed. */
function mapPathRename(paths, id, name) {
  const text = typeof name === 'string' ? name.slice(0, 120) : ''
  return objectList(paths).map((path) => (path.id === id ? { ...path, name: text } : path))
}

/** Remove one path. A half-drawn one goes away the same way, which is how a cancelled course ends. */
function mapPathRemove(paths, id) {
  return objectList(paths).filter((path) => path.id !== id)
}

// --- shapes, and filling a closed region -----------------------------------
//
// REQUESTED: "新增「图形工具」,可以绘制出任意大小和颜色的几何图形,例如:矩形,圆形等等" and "新增喷漆工具,可以
// 将任意封闭图形内部填充满任意颜色".
//
// SHAPES AND FILLS SHARE ONE DEFINITION OF "THE OUTLINE". A rectangle could be drawn as `<rect>` and hit
// tested from its corners, and the two would drift the moment either changed. Instead every shape becomes
// a POLYGON by `mapShapePoints` — used to draw it, to test whether a point is inside it, and to work out
// its area — so a shape cannot disagree with itself.
//
// A FILL IS A PROPERTY OF AN OUTLINE, not an object of its own: a stroke, a course or a shape may each
// carry one. That is what lets the spray work on a hand-drawn coastline as well as on a rectangle — a
// coastline whose last point meets its first IS a closed region.

/** The geometric kinds offered. */
const MAP_SHAPE_KINDS = {
  rect: { label: '矩形' },
  ellipse: { label: '圆形' },
}
const MAP_SHAPE_KIND_IDS = ['rect', 'ellipse']

/** How many points approximate a curve — enough that a circle looks round at any usable zoom. */
const MAP_SHAPE_STEPS = 48

/** The smallest shape a drag may produce, in world units. Below this it is a click, not a shape. */
const MAP_SHAPE_MIN_SIZE = 6

/**
 * A shape's outline as a polygon.
 *
 * One function for drawing, hit testing and area, so the three cannot disagree. An ellipse becomes a
 * polygon rather than staying an `<ellipse>` for exactly that reason.
 */
function mapShapePoints(shape) {
  const x = Number(shape?.x)
  const y = Number(shape?.y)
  const w = Number(shape?.w)
  const h = Number(shape?.h)
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return []
  if (shape?.kind === 'ellipse') {
    const cx = x + w / 2
    const cy = y + h / 2
    const out = []
    for (let i = 0; i < MAP_SHAPE_STEPS; i += 1) {
      const angle = (i / MAP_SHAPE_STEPS) * Math.PI * 2
      out.push({ x: cx + Math.cos(angle) * (w / 2), y: cy + Math.sin(angle) * (h / 2) })
    }
    return out
  }
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

/** One shape, normalised, or null when it has no area to draw. */
function normalizeShape(value, index = 0, taken = new Set()) {
  const kind = MAP_SHAPE_KIND_IDS.includes(value?.kind) ? value.kind : 'rect'
  let id = typeof value?.id === 'string' && value.id !== '' ? value.id : `shape-${index + 1}`
  let suffix = 1
  while (taken.has(id)) {
    suffix += 1
    id = `shape-${index + 1}-${suffix}`
  }
  taken.add(id)
  const shape = {
    id,
    kind,
    x: Number(value?.x) || 0,
    y: Number(value?.y) || 0,
    // Absolute values, because a drag up and to the left is as natural as down and to the right.
    w: Math.abs(Number(value?.w) || 0),
    h: Math.abs(Number(value?.h) || 0),
    color: typeof value?.color === 'string' && value.color !== '' ? value.color : '#4a7fd0',
    // `null` means "not filled", which is different from a fill of no colour.
    fill: typeof value?.fill === 'string' && value.fill !== '' ? value.fill : null,
    width: normalisePenWidth(value?.width) ?? 3,
    dash: Object.prototype.hasOwnProperty.call(MAP_DASHES, value?.dash) ? value.dash : 'solid',
  }
  return shape.w > 0 && shape.h > 0 ? shape : null
}

/**
 * A free text label: a point, some words, and how to set them.
 *
 * `size` is the label's own, not the map's `labelSize` — that one sizes the names of markers, and a caption
 * over a sea should not be resized by the pin settings.
 */
function normalizeMapText(value, index = 0, taken = new Set()) {
  let id = typeof value?.id === 'string' && value.id !== '' ? value.id : `text-${index + 1}`
  let suffix = 1
  while (taken.has(id)) {
    suffix += 1
    id = `text-${index + 1}-${suffix}`
  }
  taken.add(id)
  const size = Number(value?.size)
  const text = typeof value?.text === 'string' ? value.text : ''
  return {
    id,
    x: Number(value?.x) || 0,
    y: Number(value?.y) || 0,
    // AN EMPTY LABEL IS KEPT, unlike an empty shape. It is a draft the author is still typing, and dropping
    // it would delete the box out from under the cursor mid-edit.
    text,
    size: Number.isFinite(size) && size > 0 ? Math.min(400, Math.max(4, size)) : MAP_TEXT_DEFAULT_SIZE,
    color: typeof value?.color === 'string' && value.color !== '' ? value.color : null,
    bold: value?.bold === true,
  }
}

/** Every free text label on a map, normalised. */
function mapTexts(map) {
  const taken = new Set()
  const out = []
  for (const [index, value] of objectList(map?.texts).entries()) out.push(normalizeMapText(value, index, taken))
  return out
}

/** A symbol stamp: a glyph, a point, a size and an ink. */
function normalizeMapStamp(value, index = 0, taken = new Set()) {
  let id = typeof value?.id === 'string' && value.id !== '' ? value.id : `stamp-${index + 1}`
  let suffix = 1
  while (taken.has(id)) {
    suffix += 1
    id = `stamp-${index + 1}-${suffix}`
  }
  taken.add(id)
  const size = Number(value?.size)
  return {
    id,
    symbol: MAP_SYMBOL_IDS.includes(value?.symbol) ? value.symbol : MAP_SYMBOL_IDS[0],
    x: Number(value?.x) || 0,
    y: Number(value?.y) || 0,
    size: Number.isFinite(size) && size > 0 ? Math.min(4000, Math.max(4, size)) : MAP_STAMP_DEFAULT_SIZE,
    color: typeof value?.color === 'string' && value.color !== '' ? value.color : null,
  }
}

/** Every symbol stamp on a map, normalised. */
function mapStamps(map) {
  const taken = new Set()
  const out = []
  for (const [index, value] of objectList(map?.stamps).entries()) out.push(normalizeMapStamp(value, index, taken))
  return out
}

/** The ink a label or stamp draws in: its own, else the theme's. */
const mapTextColor = (text) => (typeof text?.color === 'string' && text.color !== '' ? text.color : MAP_TEXT_DEFAULT_COLOR)
const mapStampColor = (stamp) => (typeof stamp?.color === 'string' && stamp.color !== '' ? stamp.color : MAP_STAMP_DEFAULT_COLOR)

/** A label's font size in world units, clamped so a stray value cannot cover the map. */
function mapTextSize(text) {
  const size = Number(text?.size)
  return Number.isFinite(size) && size > 0 ? Math.min(400, Math.max(4, size)) : MAP_TEXT_DEFAULT_SIZE
}

/** A stamp's size in world units. */
function mapStampSize(stamp) {
  const size = Number(stamp?.size)
  return Number.isFinite(size) && size > 0 ? Math.min(4000, Math.max(4, size)) : MAP_STAMP_DEFAULT_SIZE
}

/**
 * An estimate of how wide a label is, used for its box and its hit test.
 *
 * CJK characters are about one em wide and Latin ones about half, so counting by code point and weighting
 * the two differently is close enough to place a box around it — and it is the SAME estimate everywhere, so
 * the box and the hit test cannot disagree.
 */
function mapTextWidth(text) {
  const content = String(text?.text ?? '')
  let units = 0
  for (const character of content) units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(character) ? 1 : 0.55
  const size = mapTextSize(text)
  return Math.max(size * 0.6, units * size)
}

/** The box a label occupies, in world units, anchored top-left at its point. */
function mapTextBox(text, pad = 0) {
  const size = mapTextSize(text)
  return {
    x: (Number(text?.x) || 0) - pad,
    y: (Number(text?.y) || 0) - pad,
    w: mapTextWidth(text) + pad * 2,
    h: size * 1.25 + pad * 2,
  }
}

/**
 * A stamp's parts in world coordinates.
 *
 * THE ONE PLACE THE GLYPHS ARE SCALED. Drawing, the export and the hit test all ask this, so a stamp's
 * clickable area is by construction the area it is drawn in.
 */
function mapStampParts(stamp) {
  const spec = MAP_SYMBOLS[stamp?.symbol] ?? MAP_SYMBOLS[MAP_SYMBOL_IDS[0]]
  const size = mapStampSize(stamp)
  const x = Number(stamp?.x) || 0
  const y = Number(stamp?.y) || 0
  // NOT `objectList`: the glyph points are PAIRS (`[0.5, 0.02]`), and `objectList` keeps only records, so it
  // silently dropped every one of them. The stamps then rendered as `<polygon points="">` — elements that
  // exist, occupy nothing, and are invisible. A test that counts elements passes; one that reads them does
  // not.
  const pairs = (value) => (Array.isArray(value) ? value : [])
  return pairs(spec?.parts).map((part) => ({
    kind: part?.kind === 'line' ? 'line' : 'poly',
    fill: part?.fill === true,
    points: pairs(part?.points).map((point) => ({
      x: x + (Number(point?.[0]) || 0) * size,
      y: y + (Number(point?.[1]) || 0) * size,
    })),
  }))
}

/** The box a stamp occupies. A glyph is drawn in a unit square, so the box is its size. */
function mapStampBox(stamp, pad = 0) {
  const size = mapStampSize(stamp)
  return {
    x: (Number(stamp?.x) || 0) - pad,
    y: (Number(stamp?.y) || 0) - pad,
    w: size + pad * 2,
    h: size + pad * 2,
  }
}

/** Every shape in a map, normalised. A shape with no area draws nothing and is dropped. */
function mapShapes(map) {
  const taken = new Set()
  const out = []
  for (const [index, value] of objectList(map?.shapes).entries()) {
    const shape = normalizeShape(value, index, taken)
    if (shape !== null) out.push(shape)
  }
  return out
}

/**
 * The box a drag has produced, with `w` and `h` made positive.
 *
 * `square` makes it a circle or a square, which is how every drawing tool behaves and the only way to get
 * a true circle from a freehand drag.
 */
function mapShapeFromDrag(from, to, kind, options = {}) {
  const min = Number.isFinite(options.min) && options.min > 0 ? options.min : MAP_SHAPE_MIN_SIZE
  const x0 = Number(from?.x)
  const y0 = Number(from?.y)
  const x1 = Number(to?.x)
  const y1 = Number(to?.y)
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null
  let box = {
    kind: MAP_SHAPE_KIND_IDS.includes(kind) ? kind : 'rect',
    x: Math.round(Math.min(x0, x1)),
    y: Math.round(Math.min(y0, y1)),
    w: Math.round(Math.abs(x1 - x0)),
    h: Math.round(Math.abs(y1 - y0)),
  }
  // A click is not a shape: a zero-size one would be invisible AND impossible to select and delete.
  if (box.w < min || box.h < min) return null
  if (options.square === true) {
    const side = Math.max(box.w, box.h)
    box = {
      ...box,
      x: x1 >= x0 ? box.x : box.x - (side - box.w),
      y: y1 >= y0 ? box.y : box.y - (side - box.h),
      w: side,
      h: side,
    }
  }
  return box
}

/**
 * Is a point inside a polygon? Ray casting, with the usual care about edges.
 *
 * A point exactly on an edge counts as inside, because clicking a region's border to fill it is what
 * anyone would expect to work.
 */
function mapPointInPolygon(point, polygon) {
  const x = Number(point?.x)
  const y = Number(point?.y)
  const ring = (Array.isArray(polygon) ? polygon : []).filter(
    (corner) => Number.isFinite(corner?.x) && Number.isFinite(corner?.y),
  )
  if (!Number.isFinite(x) || !Number.isFinite(y) || ring.length < 3) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]
    const b = ring[j]
    if (mapPointToSegment({ x, y }, a, b) < 0.0001) return true
    const straddles = a.y > y !== b.y > y
    if (straddles && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** The area of a polygon, unsigned. Used to pick the SMALLEST region containing a point. */
function mapPolygonArea(polygon) {
  const ring = (Array.isArray(polygon) ? polygon : []).filter(
    (corner) => Number.isFinite(corner?.x) && Number.isFinite(corner?.y),
  )
  if (ring.length < 3) return 0
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  }
  return Math.abs(sum / 2)
}

/** How far apart a drawn loop's ends may be and still count as closed, in world units. */
const MAP_CLOSED_GAP = 40

/**
 * Every closed region on the map: the shapes, and any stroke or course that comes back to its start.
 *
 * That is what lets the spray work on a hand-drawn coastline: a coastline whose last point meets its first
 * IS a closed region, with no special "closed" tool needed.
 */
function mapClosedLoops(map) {
  const out = []
  for (const shape of mapShapes(map)) {
    const points = mapShapePoints(shape)
    if (points.length >= 3) {
      out.push({
        key: `shape:${shape.id}`,
        id: shape.id,
        kind: 'shape',
        label: MAP_SHAPE_KINDS[shape.kind]?.label ?? '图形',
        color: shape.color,
        fill: shape.fill,
        points,
      })
    }
  }
  // The closing test lives in `mapOutlineClosed`, so the spray and the fills use the SAME rule. Two
  // estimates would let the author spray a region that then draws nothing, or draw a fill they cannot spray.
  const closable = (points) => mapOutlineClosed(points)
  for (const [index, stroke] of mapStrokes(map).entries()) {
    if (!closable(stroke.points)) continue
    out.push({ key: `stroke:${index}`, id: `stroke-${index}`, kind: 'stroke', label: '笔迹', color: mapStrokeColor(stroke), fill: stroke.fill ?? null, points: stroke.points })
  }
  for (const path of mapAllPaths(map)) {
    if (!closable(path.points)) continue
    out.push({ key: `path:${path.id}`, id: path.id, kind: 'path', label: MAP_PATH_KINDS[path.kind]?.label ?? '路径', color: path.color, fill: path.fill ?? null, points: path.points })
  }
  return out
}

/**
 * Spray whatever closed region is under a point.
 *
 * The SMALLEST region containing the point wins, so a lake drawn inside an island fills the lake rather
 * than the whole island. A colour of `null` CLEARS the fill instead of painting it, which is how a region
 * is un-filled without erasing its outline.
 *
 * @returns `{ map, filled }` — `filled` is null when the point lies in no closed region.
 */
function mapFillAt(map, world, color) {
  let best = null
  let bestArea = Infinity
  for (const loop of mapClosedLoops(map)) {
    if (!mapPointInPolygon(world, loop.points)) continue
    const area = mapPolygonArea(loop.points)
    if (area < bestArea) {
      best = loop
      bestArea = area
    }
  }
  if (best === null) return { map, filled: null }
  const fill = typeof color === 'string' && color !== '' ? color : null
  if (best.kind === 'shape') {
    return {
      map: { ...map, shapes: objectList(map?.shapes).map((shape) => (shape?.id === best.id ? { ...shape, fill } : shape)) },
      filled: { kind: 'shape', id: best.id, label: best.label },
    }
  }
  if (best.kind === 'path') {
    return {
      map: { ...map, paths: objectList(map?.paths).map((path) => (path?.id === best.id ? { ...path, fill } : path)) },
      filled: { kind: 'path', id: best.id, label: best.label },
    }
  }
  const index = Number(String(best.id).replace('stroke-', ''))
  return {
    map: { ...map, strokes: objectList(map?.strokes).map((stroke, at) => (at === index ? { ...stroke, fill } : stroke)) },
    filled: { kind: 'stroke', id: best.id, label: best.label },
  }
}

// --- the cursor: pick anything up and put it somewhere else -----------------
//
// ASKED FOR: "新增工具「光标」,可以点击画布上任意笔迹(标记点/手绘/图形/地形等)进行编辑,也可拖拽移动其位置".
//
// Picking is by the same geometry that DRAWS each thing, in the reverse of the drawing order, so whatever
// looks like it is on top is what a click lands on. A separate estimate of "what is under the pointer" would
// drift from what is drawn, and the clickable area would end up somewhere other than the visible shape.

/**
 * What lies under a point, if anything.
 *
 * Order is the REVERSE OF THE DRAW ORDER — markers are drawn last so they are picked first, then courses,
 * then shapes, then freehand ink. Within one kind the nearest is not chosen; the first drawn on top wins,
 * which is what "click the thing you can see" means.
 *
 * `tolerance` widens every test by a screen-derived slop, so a thin line stays clickable when zoomed out.
 *
 * @returns `null` or `{ kind, id, index }` — `index` is set for strokes, which are addressed by position
 *   because they carry no id of their own.
 */
function mapPickAt(map, world, tolerance = 0) {
  if (world === null || world === undefined || !Number.isFinite(world.x) || !Number.isFinite(world.y)) return null
  const slop = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0
  for (const pin of mapPins(map)) {
    if (Math.hypot((Number(pin.x) || 0) - world.x, (Number(pin.y) || 0) - world.y) <= mapPinRadius(pin) + slop) {
      return { kind: 'pin', id: pin.id, index: null }
    }
  }
  // Courses with at least two points: a one-point draft is not something to grab.
  for (const path of mapPaths(map)) {
    if (mapDistanceToCourse(path.points, world) <= mapPathHalfWidth(path) + slop) {
      return { kind: 'path', id: path.id, index: null }
    }
  }
  for (const shape of mapShapes(map)) {
    const points = mapShapePoints(shape)
    if (points.length < 3) continue
    // INSIDE COUNTS, not just the outline: a rectangle drawn as an unfilled border is still the thing you
    // mean when you click in the middle of it. NOTE THE ARGUMENT ORDER: `mapPointInPolygon(point, polygon)`
    // — point first. Reversing it does not throw, it just answers false, and clicking inside a shape would
    // silently select nothing.
    const edge = mapDistanceToCourse([...points, points[0]], world)
    if (mapPointInPolygon(world, points) || edge <= (Number(shape.width) || 0) / 2 + slop) {
      return { kind: 'shape', id: shape.id, index: null }
    }
  }
  // Free text and stamps are picked before the courses: they are drawn on top, and a caption is exactly the
  // thing an author wants to grab and move. Their boxes come from the same helpers that draw them.
  for (const text of [...mapTexts(map)].reverse()) {
    const box = mapTextBox(text, slop)
    if (world.x >= box.x && world.x <= box.x + box.w && world.y >= box.y && world.y <= box.y + box.h) {
      return { kind: 'text', id: text.id, index: null }
    }
  }
  for (const stamp of [...mapStamps(map)].reverse()) {
    const box = mapStampBox(stamp, slop)
    if (world.x >= box.x && world.x <= box.x + box.w && world.y >= box.y && world.y <= box.y + box.h) {
      return { kind: 'stamp', id: stamp.id, index: null }
    }
  }
  const strokes = mapStrokes(map)
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index]
    if (mapDistanceToCourse(stroke.points, world) <= mapStrokeWidth(stroke) / 2 + slop) {
      return { kind: 'stroke', id: `stroke-${index}`, index }
    }
  }
  return null
}

/**
 * Move what the cursor is holding.
 *
 * Applied to a SNAPSHOT of the map taken when the drag began, with the total offset so far — never to the
 * running document. Accumulating small deltas would let rounding drift, so a long drag would slowly lag
 * behind the pointer.
 */
function mapMoveTarget(map, target, dx, dy) {
  if (map === null || map === undefined || target === null || target === undefined) return map
  const sx = Number.isFinite(dx) ? dx : 0
  const sy = Number.isFinite(dy) ? dy : 0
  const moved = (points) => objectList(points).map((point) => ({ x: Math.round((Number(point?.x) || 0) + sx), y: Math.round((Number(point?.y) || 0) + sy) }))
  if (target.kind === 'pin') {
    return { ...map, pins: mapPins(map).map((pin) => (pin.id === target.id ? { ...pin, x: Math.round((Number(pin.x) || 0) + sx), y: Math.round((Number(pin.y) || 0) + sy) } : pin)) }
  }
  if (target.kind === 'shape') {
    return { ...map, shapes: mapShapes(map).map((shape) => (shape.id === target.id ? { ...shape, x: Math.round((Number(shape.x) || 0) + sx), y: Math.round((Number(shape.y) || 0) + sy) } : shape)) }
  }
  if (target.kind === 'path') {
    return { ...map, paths: mapAllPaths(map).map((path) => (path.id === target.id ? { ...path, points: moved(path.points) } : path)) }
  }
  if (target.kind === 'stroke') {
    const index = Number(target.index)
    return { ...map, strokes: mapStrokes(map).map((stroke, at) => (at === index ? { ...stroke, points: moved(stroke.points) } : stroke)) }
  }
  if (target.kind === 'text') {
    return { ...map, texts: mapTexts(map).map((text) => (text.id === target.id ? { ...text, x: Math.round((Number(text.x) || 0) + sx), y: Math.round((Number(text.y) || 0) + sy) } : text)) }
  }
  if (target.kind === 'stamp') {
    return { ...map, stamps: mapStamps(map).map((stamp) => (stamp.id === target.id ? { ...stamp, x: Math.round((Number(stamp.x) || 0) + sx), y: Math.round((Number(stamp.y) || 0) + sy) } : stamp)) }
  }
  return map
}

/** The points a picked element occupies, so a caller can draw a box or a bounding frame around it. */
function mapTargetPoints(map, target) {
  if (map === null || map === undefined || target === null || target === undefined) return []
  if (target.kind === 'pin') {
    const pin = mapPins(map).find((entry) => entry.id === target.id)
    if (pin === undefined) return []
    const radius = mapPinRadius(pin)
    const x = Number(pin.x) || 0
    const y = Number(pin.y) || 0
    return [{ x: x - radius, y: y - radius }, { x: x + radius, y: y + radius }]
  }
  if (target.kind === 'shape') {
    const shape = mapShapes(map).find((entry) => entry.id === target.id)
    return shape === undefined ? [] : mapShapePoints(shape)
  }
  if (target.kind === 'path') {
    const path = mapAllPaths(map).find((entry) => entry.id === target.id)
    return path === undefined ? [] : objectList(path.points)
  }
  if (target.kind === 'stroke') {
    const stroke = mapStrokes(map)[Number(target.index)]
    return stroke === undefined ? [] : objectList(stroke.points)
  }
  if (target.kind === 'text') {
    const text = mapTexts(map).find((entry) => entry.id === target.id)
    if (text === undefined) return []
    const box = mapTextBox(text)
    return [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h }]
  }
  if (target.kind === 'stamp') {
    const stamp = mapStamps(map).find((entry) => entry.id === target.id)
    if (stamp === undefined) return []
    const box = mapStampBox(stamp)
    return [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h }]
  }
  return []
}

/**
 * The box an element occupies, padded so the selection outline is visible around it.
 *
 * @returns `null` when the target is gone — after a delete, or after the map changed underneath it.
 */
function mapTargetBox(map, target, pad = 6) {
  const points = mapTargetPoints(map, target)
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    const x = Number(point?.x)
    const y = Number(point?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null
  const grow = Number.isFinite(pad) ? Math.max(0, pad) : 0
  return { x: minX - grow, y: minY - grow, w: maxX - minX + grow * 2, h: maxY - minY + grow * 2 }
}

/** What to call a picked element, for the line of feedback under the toolbar. */
function mapTargetName(map, target) {
  if (map === null || map === undefined || target === null || target === undefined) return ''
  if (target.kind === 'pin') {
    const pin = mapPins(map).find((entry) => entry.id === target.id)
    return pin === undefined ? '' : `标记点 ${pin.id}`
  }
  if (target.kind === 'shape') {
    const shape = mapShapes(map).find((entry) => entry.id === target.id)
    if (shape === undefined) return ''
    const spec = MAP_SHAPE_KINDS[shape.kind]
    return `${spec === undefined ? '图形' : spec.label}${shape.id === '' ? '' : ` ${shape.id}`}`
  }
  if (target.kind === 'path') {
    const path = mapAllPaths(map).find((entry) => entry.id === target.id)
    if (path === undefined) return ''
    const spec = MAP_PATH_KINDS[path.kind]
    const kindLabel = spec === undefined ? '地形' : spec.label
    return path.name === '' || path.name === null || path.name === undefined ? `${kindLabel} ${path.id}` : `${kindLabel}「${path.name}」`
  }
  if (target.kind === 'stroke') {
    return `笔迹 ${Number(target.index) + 1}`
  }
  if (target.kind === 'text') {
    const text = mapTexts(map).find((entry) => entry.id === target.id)
    if (text === undefined) return ''
    return text.text === '' ? `文字 ${text.id}` : `文字「${text.text}」`
  }
  if (target.kind === 'stamp') {
    const stamp = mapStamps(map).find((entry) => entry.id === target.id)
    if (stamp === undefined) return ''
    return `图章「${MAP_SYMBOLS[stamp.symbol]?.label ?? stamp.symbol}」`
  }
  return ''
}

// --- the eraser -------------------------------------------------------------
//
// ASKED FOR: "新增橡皮功能,可以删除地图上的痕迹". A separate MODE rather than a modifier key, because on a
// map there is no obvious "undo this thing" gesture and an explicit tool is discoverable.
//
// The rule is one OBJECT per press: the nearest marker, or the nearest course, or the nearest stroke.
// Deleting by proximity along a line would remove a whole carefully drawn coastline because the pointer
// came within a few units of one of its points, which is not what anyone means by rubbing something out.

/** How far from a stroke a click must be to count as erasing it, in world units. */
function mapEraseRadius(zoom) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return 16 / safeZoom
}

/** The distance from a point to a segment, which is how close a stroke passes to the pointer. */
function mapPointToSegment(point, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/** How close a point comes to a course, or Infinity when the course has no usable points. */
function mapDistanceToCourse(points, world) {
  const clean = (Array.isArray(points) ? points : []).filter(
    (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y),
  )
  if (clean.length === 0 || !Number.isFinite(world?.x) || !Number.isFinite(world?.y)) return Infinity
  if (clean.length === 1) return Math.hypot(clean[0].x - world.x, clean[0].y - world.y)
  let best = Infinity
  for (let i = 0; i < clean.length - 1; i += 1) {
    const distance = mapPointToSegment(world, clean[i], clean[i + 1])
    if (distance < best) best = distance
  }
  return best
}

/**
 * Erase whatever is under a world point, and report what went.
 *
 * ONE object, the NEAREST of the three kinds — so pressing the eraser over a marker that happens to sit
 * on a river removes the marker, not both. A marker is preferred when it is within its own hit radius,
 * because markers are small and are what the pointer is usually aimed at.
 *
 * @returns `{ map, erased }` where `erased` is `null` or `{ kind, id, label }`.
 */
function mapEraseAt(map, world, options = {}) {
  const radius = Number.isFinite(options.radius) && options.radius > 0 ? options.radius : mapEraseRadius(options.zoom)
  const pins = mapPins(map)
  const paths = mapAllPaths(map)
  const strokes = mapStrokes(map)

  const hit = mapPinHit(pins, objectList(options.labels), world, radius)
  if (hit !== null) {
    return {
      map: { ...map, pins: objectList(map?.pins).filter((pin) => pin?.id !== hit.id) },
      erased: { kind: 'pin', id: hit.id, label: '地点标记' },
    }
  }

  // A shape is a REGION, so "inside it" is the test — not distance to an outline, which would make a
  // large filled rectangle impossible to erase without touching its exact border.
  let bestShape = null
  let bestShapeArea = Infinity
  for (const shape of mapShapes(map)) {
    if (!mapPointInPolygon(world, mapShapePoints(shape))) continue
    const area = shape.w * shape.h
    if (area < bestShapeArea) {
      bestShape = shape
      bestShapeArea = area
    }
  }
  if (bestShape !== null) {
    return {
      map: { ...map, shapes: objectList(map?.shapes).filter((shape) => shape?.id !== bestShape.id) },
      erased: { kind: 'shape', id: bestShape.id, label: MAP_SHAPE_KINDS[bestShape.kind]?.label ?? '图形' },
    }
  }

  let bestPath = null
  let bestPathDistance = Infinity
  for (const path of paths) {
    const distance = mapDistanceToCourse(path.points, world)
    if (distance <= radius && distance < bestPathDistance) {
      bestPath = path
      bestPathDistance = distance
    }
  }
  let bestStroke = null
  let bestStrokeDistance = Infinity
  for (const [index, stroke] of strokes.entries()) {
    const distance = mapDistanceToCourse(stroke.points, world)
    if (distance <= radius && distance < bestStrokeDistance) {
      bestStroke = index
      bestStrokeDistance = distance
    }
  }

  // Whichever kind the pointer is CLOSER to. A course is usually drawn on top of a coastline, so
  // preferring one kind by type rather than by distance would make the other impossible to erase there.
  if (bestPath !== null && bestPathDistance <= bestStrokeDistance) {
    return {
      map: { ...map, paths: mapPathRemove(paths, bestPath.id) },
      erased: { kind: 'path', id: bestPath.id, label: MAP_PATH_KINDS[bestPath.kind]?.label ?? '路径' },
    }
  }
  if (bestStroke !== null) {
    const kind = strokes[bestStroke].width === null ? '笔迹' : '笔迹'
    return {
      map: { ...map, strokes: strokes.filter((_stroke, index) => index !== bestStroke) },
      erased: { kind: 'stroke', id: `stroke-${bestStroke}`, label: kind },
    }
  }
  return { map, erased: null }
}

// --- undo and redo ---------------------------------------------------------
//
// THE PATTERN IS BORROWED FROM DSH ITSELF, from the history plugin behind its own editor
// (`@deepseek-ai/dsh-client-ui-conversation`): a snapshot of the present plus an undo stack and a
// redo stack, and — the part worth copying — a MERGE WINDOW. An edit that arrives within the window
// and carries the same merge key REPLACES the present entry instead of pushing a new one.
//
// That is what makes history usable on a canvas. Without it, dragging a waypoint across the map would
// leave one undo step per pointer move, and pressing 撤销 would appear to do nothing sixty times. With
// it, one drag is one step.
//
// Snapshots rather than inverse operations: a map document is small JSON, and a snapshot cannot be
// wrong the way a hand-written inverse can.

const MAP_HISTORY_LIMIT = 60
const MAP_HISTORY_MERGE_MS = 800

/** A history holding one state and nothing to undo. */
function mapHistoryNew(snapshot) {
  return { undoStack: [], redoStack: [], current: { snapshot, mergeKey: null, at: 0 } }
}

/** The state the history currently represents. */
function mapHistorySnapshot(history) {
  return history?.current?.snapshot ?? null
}

// `Array.isArray`, not `.length > 0`: a STRING has a length too, so a corrupted history holding
// `{undoStack: "x"}` reported 撤销 as available. The button then did nothing, which reads as a broken
// button rather than as broken data.
function mapHistoryCanUndo(history) {
  return Array.isArray(history?.undoStack) && history.undoStack.length > 0
}

function mapHistoryCanRedo(history) {
  return Array.isArray(history?.redoStack) && history.redoStack.length > 0
}

/**
 * Record a new state.
 *
 * A merge key matching the present entry, within the window, coalesces — see above. A different key,
 * or any edit after the window closes, starts a new undo step. Either way the redo stack is cleared:
 * once you edit, the future you had undone is no longer reachable.
 */
function mapHistoryPush(history, snapshot, options = {}) {
  const { mergeKey = null, at = 0, limit = MAP_HISTORY_LIMIT } = options
  const current = history?.current
  if (current === null || current === undefined) return mapHistoryNew(snapshot)
  const merges =
    mergeKey !== null &&
    mergeKey === current.mergeKey &&
    Number.isFinite(at) &&
    Number.isFinite(current.at) &&
    at - current.at < MAP_HISTORY_MERGE_MS
  if (merges) return { ...history, redoStack: [], current: { snapshot, mergeKey, at } }
  const size = Number.isFinite(limit) && limit > 0 ? limit : MAP_HISTORY_LIMIT
  return {
    undoStack: [...(Array.isArray(history.undoStack) ? history.undoStack : []), current].slice(-size),
    redoStack: [],
    current: { snapshot, mergeKey, at },
  }
}

/** Step back one state. A no-op at the beginning rather than an error. */
function mapHistoryUndo(history) {
  const undoStack = Array.isArray(history?.undoStack) ? history.undoStack : []
  if (undoStack.length === 0) return history
  return {
    undoStack: undoStack.slice(0, -1),
    redoStack: [...(Array.isArray(history.redoStack) ? history.redoStack : []), history.current],
    current: undoStack[undoStack.length - 1],
  }
}

/** Step forward again, through states that were undone. */
function mapHistoryRedo(history) {
  const redoStack = Array.isArray(history?.redoStack) ? history.redoStack : []
  if (redoStack.length === 0) return history
  return {
    undoStack: [...(Array.isArray(history.undoStack) ? history.undoStack : []), history.current],
    redoStack: redoStack.slice(0, -1),
    current: redoStack[redoStack.length - 1],
  }
}

// --- the drag state machine, as pure functions ------------------------------
//
// WHY THIS IS SEPARATED. Interaction cannot be verified by a server render — no effects, no
// handlers — and four defects shipped in this file because of it. Pulling every decision out of the
// handlers shrinks the unverifiable part to one question — *did the DOM deliver the event* — and
// leaves the arithmetic and the transitions testable, which is the larger part.
//
// These three functions ARE the gesture model. The handlers only read the DOM, call one of them,
// and apply the returned intent.

/**
 * Begin a gesture, or decline it.
 *
 * Declining matters: a right-click, or a pointer whose position could not be measured, must not
 * start a drag. A `pointerdown` handler that returns early for the wrong reason is how a canvas
 * ends up permanently stuck, so the conditions are explicit and tested.
 *
 * @returns the drag state to remember, or null when this gesture is not ours.
 */
function mapDragStart(input) {
  const { button, pointerId, world, screen, mode, pins, hitRadius, canvas, view, rect } = input
  if (button !== 0) return null
  if (!Number.isFinite(world?.x) || !Number.isFinite(world?.y)) return null

  if (mode === 'draw') return { kind: 'draw', pointerId, points: [{ x: world.x, y: world.y }] }

  if (mode === 'shape') {
    // A shape is DRAGGED OUT from a corner, which is what every drawing tool does and the only way to
    // choose both the size and the position in one gesture.
    return { kind: 'shape', pointerId, shapeKind: input.shapeKind, from: { x: world.x, y: world.y } }
  }

  if (mode === 'pan') {
    // PANNING IS MEASURED IN SCREEN PIXELS, NOT WORLD UNITS, and that is not a detail.
    //
    // The world point under the cursor CHANGES as the view pans — that is what panning is. So a
    // world-space baseline is self-referential: every move compares against a coordinate the
    // previous move just invalidated, and the view runs away or jitters instead of following the
    // hand. Screen coordinates are invariant for the duration of the gesture, so the total pan is
    // simply (screen delta ÷ scale) added to the centre the gesture started from.
    //
    // DSH's own draggable pane resizer does the same thing: it stores `clientX`, never a
    // coordinate derived from the thing it is moving.
    const scale = mapScale(rect, view)
    if (scale === null) return null
    // A pan whose screen baseline is unusable could never move, so decline it here rather than
    // start a gesture that silently does nothing on every subsequent move.
    if (!Number.isFinite(screen?.x) || !Number.isFinite(screen?.y)) return null
    return {
      kind: 'pan',
      pointerId,
      scale,
      screen: { x: screen.x, y: screen.y },
      center: { x: view.x + view.w / 2, y: view.y + view.h / 2 },
    }
  }

  // Pin mode: an existing pin is picked up, otherwise a new one is placed.
  const hit = pinAt(pins, world, hitRadius)
  if (hit !== null) {
    return {
      kind: 'pin',
      pointerId,
      id: hit.id,
      offsetX: (Number(hit.x) || 0) - world.x,
      offsetY: (Number(hit.y) || 0) - world.y,
    }
  }
  const point = clampToBox(world, canvas.width, canvas.height)
  return { kind: 'new-pin', pointerId, point: { x: point.x, y: point.y }, offsetX: 0, offsetY: 0 }
}

/**
 * Apply a move. Returns an INTENT — what the caller should do — or null for "nothing changes".
 *
 * The `pointerId` guard is why a stray second pointer cannot hijack a drag already in progress.
 */
function mapDragMove(input) {
  const { drag, pointerId, world, screen, view, canvas, sampleStep } = input
  if (drag === null || drag === undefined) return null
  if (drag.pointerId !== pointerId) return null
  if (!Number.isFinite(world?.x) || !Number.isFinite(world?.y)) return null

  if (drag.kind === 'pan') {
    // Screen delta over the scale RECORDED AT DRAG START — not the current box, which is being
    // changed by this very gesture. Using the live box feeds the pan back into itself.
    if (!Number.isFinite(screen?.x) || !Number.isFinite(screen?.y)) return null
    if (!Number.isFinite(drag.scale) || drag.scale <= 0) return null
    const centerX = drag.center.x + (drag.screen.x - screen.x) / drag.scale
    const centerY = drag.center.y + (drag.screen.y - screen.y) / drag.scale
    return { view: mapPanTo({ zoom: view.zoom }, centerX, centerY) }
  }

  if (drag.kind === 'draw') {
    // Sample rather than store every event: a stroke of ten thousand points is a document nobody
    // can read, and the extra detail is invisible at any zoom.
    const last = drag.points[drag.points.length - 1]
    const step = Number.isFinite(sampleStep) && sampleStep > 0 ? sampleStep : 3
    if (last !== undefined && Math.hypot(last.x - world.x, last.y - world.y) < step) return null
    return { points: [...drag.points, { x: world.x, y: world.y }] }
  }

  if (drag.kind === 'shape') {
    // `shiftKey` comes from the event, so a circle is drawn by holding shift rather than by a mode.
    const box = mapShapeFromDrag(drag.from, world, drag.shapeKind, { square: input.square === true })
    // The box AND the position are both returned: the caller records the position on the gesture, so the
    // release can commit even if it cannot measure the pointer itself.
    return box === null ? { shape: null, last: { x: world.x, y: world.y } } : { shape: box, last: { x: world.x, y: world.y } }
  }

  if (drag.kind === 'waypoint') {
    // Dragging a river's or road's waypoint, which reshapes the course through it.
    const point = clampToBox(world, canvas.width, canvas.height)
    return { waypoint: { id: drag.id, index: drag.index, x: point.x, y: point.y } }
  }

  // pin / new-pin: clamped so a pin cannot be dragged off the canvas and lost.
  const point = clampToBox(
    { x: world.x + (drag.offsetX ?? 0), y: world.y + (drag.offsetY ?? 0) },
    canvas.width,
    canvas.height,
  )
  return { pin: { id: drag.id ?? null, x: point.x, y: point.y } }
}

/**
 * Finish a gesture. Returns what to commit, or null when the gesture was not ours.
 *
 * A drawn stroke needs TWO points: one point draws nothing, and storing something invisible would
 * make the count disagree with the screen. A tap in 手绘 mode is a no-op — 打点 marks one point.
 */
function mapDragEnd(input) {
  const { drag, pointerId, cancelled } = input
  if (drag === null || drag === undefined) return null
  if (drag.pointerId !== pointerId) return null
  // A cancelled gesture — the OS took the pointer, or capture was lost — discards the draft rather
  // than committing a half-drawn stroke.
  if (cancelled === true) return { cancelled: true, stroke: null }
  if (drag.kind === 'shape') {
    // FALL BACK TO THE POSITION THE GESTURE ITSELF RECORDED. The caller used to pass no `to` at all, so
    // the box came out of NaN and NOTHING was ever committed — the preview appeared and the shape did not.
    // Measuring at the release point is preferable; not depending on it is what makes this robust.
    const to = input.to ?? drag.last ?? drag.from
    const box = mapShapeFromDrag(drag.from, to, drag.shapeKind, { square: input.square === true })
    return { cancelled: false, stroke: null, shape: box }
  }
  if (drag.kind !== 'draw') return { cancelled: false, stroke: null }
  if (drag.points.length < 2) return { cancelled: false, stroke: null }
  return {
    cancelled: false,
    stroke: drag.points.map((point) => [Math.round(point.x), Math.round(point.y)]),
  }
}

// --- map edits, as pure functions -------------------------------------------
//
// Each takes the raw list and returns a NEW list. Kept pure because "it looked right and changed
// the wrong one" is the failure this file produces: every operation is asserted on WHICH map it
// touched, not merely that something changed.

/** Append a drawn stroke to one map. Ignored when that map is gone. */
function mapAppendStroke(maps, id, stroke) {
  return objectList(maps).map((map) => (map.id === id ? { ...map, strokes: [...mapStrokes(map), stroke] } : map))
}

/** Drop the most recent stroke of one map. */
function mapUndoStroke(maps, id) {
  return objectList(maps).map((map) => (map.id === id ? { ...map, strokes: mapStrokes(map).slice(0, -1) } : map))
}

/** Empty one map's strokes without removing the map. */
function mapClearStrokes(maps, id) {
  return objectList(maps).map((map) => (map.id === id ? { ...map, strokes: [] } : map))
}

/** Empty one map's pins. */
function mapClearPins(maps, id) {
  return objectList(maps).map((map) => (map.id === id ? { ...map, pins: [] } : map))
}

/**
 * Rename one map, storing EXACTLY what was typed.
 *
 * It used to substitute the map's id for a blank name, which was meant as a kindness and was a defect:
 * the field is bound to this value, so clearing the name immediately put `map-1` back INTO the input,
 * and the next keystroke produced `map-1你好`. Reported exactly that way. What a name FALLS BACK TO for
 * display is a separate question — see `mapDisplayName`.
 *
 * The length is capped so one paste cannot make the document unreadable.
 */
function mapRenameMap(maps, id, name) {
  const text = typeof name === 'string' ? name.slice(0, 120) : ''
  return objectList(maps).map((map) => (map.id === id ? { ...map, name: text } : map))
}

/**
 * The name to SHOW for a map: what the author typed, or a marker that they have not named it.
 *
 * Displaying is the ONLY place a substitution belongs. A map with no name must still be identifiable in
 * a list without writing anything into the document — and the fallback must not look like a name the
 * author might have typed, or the next edit appears to "keep" it.
 */
function mapDisplayName(map) {
  const name = typeof map?.name === 'string' ? map.name.trim() : ''
  if (name !== '') return name
  const id = typeof map?.id === 'string' && map.id !== '' ? map.id : ''
  return id === '' ? '（未命名）' : `（未命名 · ${id}）`
}

/** Remove one map, strokes and pins and all. */
function mapRemoveMap(maps, id) {
  return objectList(maps).filter((map) => map.id !== id)
}

/** Set the pin-label size of one map. */
function mapSetLabelSize(maps, id, size) {
  const value = Number(size)
  return objectList(maps).map((map) =>
    map.id === id ? { ...map, labelSize: Number.isFinite(value) && value > 0 ? value : MAP_DEFAULT_LABEL_SIZE } : map,
  )
}

/** Set whether one map's labels keep a constant pixel size instead of scaling with the map. */
function mapSetLabelFixed(maps, id, fixed) {
  return objectList(maps).map((map) => (map.id === id ? { ...map, labelFixed: fixed === true } : map))
}

/** Change one pin's fields. */
function mapUpdatePin(maps, mapId, pinId, patch) {
  return objectList(maps).map((map) =>
    map.id === mapId
      ? { ...map, pins: objectList(map.pins).map((pin) => (pin.id === pinId ? { ...pin, ...patch } : pin)) }
      : map,
  )
}

/** An empty map that is ready to draw on, used when the last one is deleted. */
function freshMap(id, canvas, name = '地图 1') {
  return {
    id,
    name,
    canvas: { width: canvas?.width ?? 2000, height: canvas?.height ?? 1500 },
    background: { kind: 'blank', asset: null },
    strokes: [],
    shapes: [],
    pins: [],
    labelSize: MAP_DEFAULT_LABEL_SIZE,
    pinSize: MAP_PIN_DEFAULT_SIZE,
    labelFixed: false,
  }
}

/**
 * The SVG surface, as a body-only component.
 *
 * Extracted so the suite can render it directly: the branch wraps it in a SplitPane, and asserting
 * through the wrapper would test the wrapper. Every handler comes in as a prop.
 */
function MapSurface(props) {
  const {
    root, map, view, mode, draft, draftColor, penWidth, draftShape, selectionId, selectedShapeId, cursorTarget, svgRef, started, editingPathId, placeTitles, labelOf,
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture, onPointerLeave, onWheel, onDoubleClick,
  } = props
  const canvas = mapCanvas(map)
  // `view` is ALREADY a box: MapBranch derives it once per render. Deriving it again used to
  // discard the pan and shift every mark by a constant. `mapViewBox` is now idempotent as a second
  // line of defence, but the honest fix is not to derive twice.
  const box = isMapBox(view) ? view : mapViewBox(view, canvas)
  const strokes = mapStrokes(map)
  const paths = mapPaths(map)
  const shapes = mapShapes(map)
  const texts = mapTexts(map)
  const stamps = mapStamps(map)
  const pins = mapPins(map)
  const background = mapBackground(map)
  const assetUrl = isMapImage(background) ? mapAssetUrl(root, background.asset) : null

  // BLANK UNTIL THE AUTHOR STARTS. Reported twice: first the GRID read as "a background covered in
  // dots", then the PINS did — 33 of them from testing 打点, drawn on an otherwise empty canvas. The
  // request was explicit: before anything is drawn, the map is blank, nothing at all. `started` is
  // supplied by the branch so that a deliberately NEW map is immediately usable while a legacy
  // document's leftovers are not mistaken for a base map.
  const visible = started === true || strokes.length > 0 || pins.length > 0 || paths.length > 0 || shapes.length > 0 || texts.length > 0 || stamps.length > 0
  const children = []
  // THE THEME PAINTS THE PAPER, never the author's work. `mapTheme` supplies the sheet, the grid lines and
  // the frame; every stroke keeps the colour it was drawn in.
  const theme = mapTheme(map)

  if (visible) {
    children.push(h('rect', { key: 'sheet', x: 0, y: 0, width: canvas.width, height: canvas.height, fill: theme.paper }))
    if (assetUrl === null) {
      // A faint GUIDE, never content: it helps judge scale while drawing.
      const grid = mapGridLines(canvas)
      for (const x of grid.vertical) {
        children.push(h('line', { key: `v${x}`, x1: x, y1: 0, x2: x, y2: canvas.height, stroke: theme.grid, strokeWidth: 1 / box.zoom }))
      }
      for (const y of grid.horizontal) {
        children.push(h('line', { key: `h${y}`, x1: 0, y1: y, x2: canvas.width, y2: y, stroke: theme.grid, strokeWidth: 1 / box.zoom }))
      }
    } else {
      children.push(h('image', { key: 'bg', href: assetUrl, x: 0, y: 0, width: canvas.width, height: canvas.height, preserveAspectRatio: 'none' }))
    }
    children.push(h('rect', { key: 'edge', x: 0, y: 0, width: canvas.width, height: canvas.height, fill: 'none', stroke: theme.edge, strokeWidth: 2 / box.zoom }))

  // FILLS FIRST. A region's colour is painted under every outline, so a stroke drawn over a filled sea
  // is still a stroke and not a stripe of sea. The fill comes from the SAME points the outline uses.
  for (const shape of shapes) {
    if (shape.fill === null) continue
    const points = mapShapePoints(shape)
    if (points.length < 3) continue
    children.push(
      h('polygon', {
        key: 'shape-fill-' + shape.id,
        points: points.map((point) => Math.round(point.x * 100) / 100 + ',' + Math.round(point.y * 100) / 100).join(' '),
        fill: shape.fill,
        stroke: 'none',
      }),
    )
  }
  for (const path of paths) {
    // ONLY A CLOSED OUTLINE ENCLOSES A REGION. A road, a border or a mountain range that does not close is a
    // LINE, and closing it by force painted a skin across everything it spanned — the reported "中间会自动
    // 喷漆". `mapOutlineClosed` is the same test the spray uses, so what CAN be filled and what is DRAWN
    // filled cannot disagree. `mapFillOf` also treats `undefined` as no fill, which `=== null` did not.
    if (mapFillOf(path.fill) === null || !mapOutlineClosed(path.points)) continue
    const d = path.taper > 0 ? mapBankPath(path.points, path.width, path.taper) : mapSmoothPath(path.points, true)
    if (d === '') continue
    children.push(h('path', { key: 'path-fill-' + path.id, d, fill: path.fill, stroke: 'none' }))
  }
  for (const [index, stroke] of strokes.entries()) {
    if (mapFillOf(stroke.fill) === null || !mapOutlineClosed(stroke.points)) continue
    const d = mapSmoothPath(stroke.points, true)
    if (d === '') continue
    children.push(h('path', { key: 'stroke-fill-' + index, d, fill: stroke.fill, stroke: 'none' }))
  }

    strokes.forEach((stroke, index) => {
      const d = strokePath(stroke.points)
      if (d === '') return
      children.push(
        h('path', {
          key: `stroke-${index}`,
          d,
          fill: 'none',
          // The stroke's OWN colour, so changing the pen never recolours what is already drawn.
          // The fill is painted separately, UNDER everything.
          stroke: mapStrokeColor(stroke),
          // The stroke's OWN width, so changing the pen never redraws what is already drawn.
          strokeWidth: mapStrokeWidth(stroke, penWidth) / box.zoom,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: 0.9,
        }),
      )
    })

    // The stroke being drawn right now, so the line follows the pointer instead of appearing only
    // on release.
    if (Array.isArray(draft) && draft.length >= 2) {
      children.push(
        h('path', {
          key: 'draft',
          d: strokePath(draft),
          fill: 'none',
          stroke: typeof draftColor === 'string' && draftColor !== '' ? draftColor : MAP_DEFAULT_COLOR,
          strokeWidth: mapStrokeWidth(null, penWidth) / box.zoom,
          strokeLinecap: 'round',
          strokeDasharray: `${6 / box.zoom} ${4 / box.zoom}`,
          opacity: 0.7,
        }),
      )
    }

    // The shape being dragged out, so it is visible before it is committed.
  if (draftShape !== null && draftShape !== undefined) {
    const points = mapShapePoints(draftShape)
    if (points.length >= 3) {
      children.push(
        h('polygon', {
          key: 'draft-shape',
          points: points.map((point) => Math.round(point.x * 100) / 100 + ',' + Math.round(point.y * 100) / 100).join(' '),
          fill: 'none',
          // `draftColor`, which is this component's prop — NOT `penColor`, which belongs to the branch.
          stroke: mapStrokeColor({ color: draftColor }),
          strokeWidth: 2 / box.zoom,
          strokeDasharray: (6 / box.zoom) + ' ' + (4 / box.zoom),
        }),
      )
    }
  }

  // --- shapes: rectangles and circles, filled or not ---
  for (const shape of shapes) {
    const points = mapShapePoints(shape)
    if (points.length < 3) continue
    children.push(
      h('polygon', {
        key: 'shape-' + shape.id,
        points: points.map((point) => Math.round(point.x * 100) / 100 + ',' + Math.round(point.y * 100) / 100).join(' '),
        fill: 'none',
        stroke: shape.color,
        strokeWidth: Math.max(0.5, shape.width) / box.zoom,
        strokeLinejoin: 'round',
        ...(Array.isArray(MAP_DASHES[shape.dash]) ? { strokeDasharray: MAP_DASHES[shape.dash].map((n) => n / box.zoom).join(' ') } : {}),
        opacity: 0.95,
      }),
    )
    if (shape.id === selectedShapeId) {
      for (const [index, corner] of points.entries()) {
        children.push(h('circle', { key: 'shape-handle-' + shape.id + '-' + index, cx: corner.x, cy: corner.y, r: 4 / box.zoom, fill: 'rgba(255,255,255,0.9)', stroke: 'currentColor', strokeWidth: 1.5 / box.zoom }))
      }
    }
  }

  // --- rivers, roads, borders and ranges, before the pins so a settlement sits on top of its river ---
  for (const path of paths) {
    // A MOUNTAIN RANGE is a row of peaks, not a thick line: a thick line reads as a wall. Each peak is
    // its own polygon so the row follows the ridge and the width setting spreads it out.
    if (path.kind === 'mountain') {
      for (const [index, peak] of mapMountainPeaks(path.points, path.width).entries()) {
        children.push(
          h('polygon', {
            key: 'peak-' + path.id + '-' + index,
            points: mapMountainGlyph(peak),
            fill: path.color,
            stroke: path.color,
            strokeWidth: 1 / box.zoom,
            strokeLinejoin: 'round',
            opacity: 0.9,
          }),
        )
      }
      // The ridge itself, faint, so the course is visible while it is being edited.
      if (path.id === editingPathId) {
        children.push(
          h('path', {
            key: 'ridge-' + path.id,
            d: mapSmoothPath(path.points),
            fill: 'none',
            stroke: 'rgba(128,128,128,0.5)',
            strokeWidth: 1 / box.zoom,
            strokeDasharray: (6 / box.zoom) + ' ' + (4 / box.zoom),
          }),
        )
      }
      continue
    }
    // A TAPERED path is its own outline: the bank polygon is filled. A UNIFORM one is drawn as a
    // stroked centre line instead, because that is what carries dashes and rounded ends properly —
    // a dotted border made of a filled polygon would come out as a row of slivers.
    const tapered = path.taper > 0
    const d = tapered ? mapBankPath(path.points, path.width, path.taper) : mapSmoothPath(path.points)
    if (d === '') continue
    const dash = MAP_DASHES[path.dash]
    if (tapered) {
      children.push(
        h('path', {
          key: `path-${path.id}`,
          d,
          fill: path.color,
          stroke: path.color,
          strokeWidth: 1 / box.zoom,
          strokeLinejoin: 'round',
          opacity: 0.92,
        }),
      )
    } else {
      children.push(
        h('path', {
          key: `path-${path.id}`,
          d,
          fill: 'none',
          stroke: path.color,
          strokeWidth: Math.max(0.5, path.width) / box.zoom,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          ...(Array.isArray(dash) ? { strokeDasharray: dash.map((length) => length / box.zoom).join(' ') } : {}),
        }),
      )
    }
  }

  // A course's NAME, on the map. Naming a river and then not seeing the name would make the name a
  // private note rather than a map label, which is not what naming a river is for.
  for (const path of paths) {
    const name = typeof path.name === 'string' ? path.name.trim() : ''
    if (name === '') continue
    const spot = mapPathAnchor(path.points, path.width)
    if (spot === null) continue
    const size = Math.max(10, Math.min(path.width * 0.9, MAP_DEFAULT_LABEL_SIZE * 1.1))
    // Offset to one side of the course, perpendicular to it, so the name is not written over the line.
    const nx = -Math.sin(spot.angle)
    const ny = Math.cos(spot.angle)
    children.push(
      h(
        'text',
        {
          key: 'name-' + path.id,
          x: spot.x + nx * (spot.offset + size * 0.6),
          y: spot.y + ny * (spot.offset + size * 0.6),
          textAnchor: 'middle',
          fontSize: size,
          fill: path.color,
          style: { paintOrder: 'stroke', stroke: 'rgba(255,255,255,0.65)', strokeWidth: size * 0.18 },
        },
        name,
      ),
    )
  }

  // The waypoints of the path being edited — drawn OUTSIDE the loop above, and from `mapAllPaths`.
  // A course that has been started but not finished is not in the drawing view, so drawing its handles
  // from there meant the first click of a new river gave NO feedback whatsoever: nothing appeared, and
  // the author had no way to tell whether the click had registered.
  if (editingPathId !== null) {
    const editing = mapAllPaths(map).find((entry) => entry.id === editingPathId)
    for (const [index, point] of (editing?.points ?? []).entries()) {
      children.push(
        h('circle', {
          key: `wp-${editingPathId}-${index}`,
          cx: point.x,
          cy: point.y,
          // Deliberately larger than the pin radius, because these are drag handles.
          r: mapPinRadius(map, null, box.zoom) * 1.15,
          fill: 'rgba(255,255,255,0.9)',
          stroke: 'currentColor',
          strokeWidth: 2 / box.zoom,
        }),
      )
    }
  }

  // Labels are PLACED, not merely drawn: each one takes the first of eight placements that clears
  // every label already placed, because a fixed offset put two settlements' names on top of each other
  // whenever the settlements were close.
  const labels = mapLabelLayout(pins, map, box.zoom, {
    // The caller may pass the resolver it uses for hit testing, so what is DRAWN and what can be
    // CLICKED are the same thing. When it does not, the same resolver is built here from `placeTitles`
    // — a surface that stopped resolving names because a prop was missing would show raw ids.
    labelOf:
      typeof labelOf === 'function'
        ? labelOf
        : (pin) => {
            if (typeof pin?.label === 'string' && pin.label !== '') return pin.label
            const title = typeof placeTitles?.[pin?.placeId] === 'string' ? placeTitles[pin.placeId] : ''
            return title !== '' ? title : pin?.placeId ?? pin?.id ?? ''
          },
  })
  // --- symbol stamps, then free text on top --------------------------------
  //
  // Stamps sit above the courses because a settlement drawn over a river is how a map reads. Captions are
  // drawn LAST, after the markers, because a label that a marker can cover is a label the author has to move
  // for no good reason.
  for (const stamp of stamps) {
    const ink = mapInkFor(map, stamp.color, MAP_STAMP_DEFAULT_COLOR)
    for (const [partIndex, part] of mapStampParts(stamp).entries()) {
      const points = part.points.map((point) => `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`).join(' ')
      children.push(
        h(part.kind === 'line' ? 'polyline' : 'polygon', {
          key: `stamp-${stamp.id}-${partIndex}`,
          points,
          fill: part.fill ? ink : 'none',
          stroke: ink,
          strokeWidth: Math.max(1, mapStampSize(stamp) * 0.075),
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      )
    }
  }

  const labelById = new Map(labels.map((label) => [label.id, label]))
  pins.forEach((pin) => {
    const size = mapLabelSize(map, box.zoom, pin)
    const label = labelById.get(pin.id)
    const offset = label?.anchor ?? mapLabelOffset(size)
    children.push(
      h(
        'g',
        { key: pin.id, transform: `translate(${Number(pin.x) || 0} ${Number(pin.y) || 0})` },
        h('circle', {
          // SIZE and COLOUR are the marker's own, both customisable. They were hardcoded to a radius of
          // 7 screen pixels and to the theme colour, so neither could be changed at all.
          r: mapPinRadius(map, pin, box.zoom),
          fill: pin.id === selectionId ? mapPinColor(pin) : 'rgba(128,128,128,0.35)',
          stroke: mapPinColor(pin),
          strokeWidth: Math.max(1, mapPinRadius(map, pin, box.zoom) * 0.2),
        }),
        label === undefined
          ? null
          : h(
              'text',
              {
                x: offset.x,
                y: offset.y,
                // `middle`/`end` are what let a label sit to the LEFT of or centred on its pin, which is
                // half of how a collision is avoided.
                textAnchor: offset.anchor ?? 'start',
                fontSize: size,
                fill: typeof pin.color === 'string' && pin.color !== '' ? pin.color : 'currentColor',
                // A thin dark outline keeps the label readable over a background image.
                style: { paintOrder: 'stroke', stroke: mapHaloColor(map, 0.35), strokeWidth: size * 0.06 },
              },
              label.text,
            ),
      ),
    )
  })

  // FREE TEXT LAST, over the markers. It is the author's own caption, and one that a marker can cover is a
  // caption they have to move for no reason.
  for (const text of texts) {
    const size = mapTextSize(text)
    const ink = mapInkFor(map, text.color, MAP_TEXT_DEFAULT_COLOR)
    children.push(
      h(
        'text',
        {
          key: `text-${text.id}`,
          x: Number(text.x) || 0,
          y: (Number(text.y) || 0) + size,
          fontSize: size,
          fontWeight: text.bold ? 700 : 400,
          fill: ink,
          // Readable over both a light sheet and a dark one, and over an imported background image.
          style: { paintOrder: 'stroke', stroke: mapHaloColor(map, 0.6), strokeWidth: size * 0.09 },
        },
        text.text,
      ),
    )
  }
  // Closes `if (visible)`. Everything above draws the map's CONTENT; the selection frame and the svg element
  // itself sit outside it, because a frame around nothing is still a state the author should see.
}

  // THE CURSOR'S SELECTION OUTLINE, on top of everything so it is never hidden behind what it frames.
  // A dashed box rather than a recolour: recolouring would mean guessing at a visible alternative for every
  // element, and would change how the map looks rather than just saying what is selected.
  if (mode === 'cursor' && cursorTarget !== null && cursorTarget !== undefined) {
    const frame = mapTargetBox(map, cursorTarget, 6 / Math.max(0.05, box.zoom))
    if (frame !== null) {
      children.push(
        h('rect', {
          key: 'cursor-frame',
          x: frame.x,
          y: frame.y,
          width: frame.w,
          height: frame.h,
          fill: 'none',
          stroke: '#e5534b',
          strokeWidth: 1.5 / Math.max(0.05, box.zoom),
          strokeDasharray: `${6 / Math.max(0.05, box.zoom)} ${4 / Math.max(0.05, box.zoom)}`,
          vectorEffect: 'non-scaling-stroke',
          style: { pointerEvents: 'none' },
        }),
      )
    }
  }

  return h(
    'svg',
    {
      // The ref is on the SVG, not on its wrapper: the wrapper is a flex item of a different size,
      // and measuring the wrong element offsets every click.
      ref: svgRef,
      viewBox: viewBoxString(box),
      // Pinned explicitly, because `mapScreenToWorld` inverts exactly this and an inherited default
      // that changed would silently move every click.
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': `地图：${pins.length} 个地点标记，${paths.length} 条河流道路，${strokes.length} 笔`,
      style: {
        // The SVG covers its container EXACTLY, and this is the only sizing that guarantees it.
        // `height: auto` made the element taller than its `overflow: hidden` wrapper whenever the
        // pane was wider than the canvas aspect: it was then CLIPPED, yet `getBoundingClientRect`
        // still reported the full height — so every click mapped below what the pointer could reach
        // and marks landed offset from the cursor. `height: 100%` alone collapsed inside the flex
        // column and nothing could be clicked at all. Absolute fill needs no cooperation from the
        // ancestor chain.
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        color: 'inherit',
        background: 'transparent',
        cursor: mode === 'pan' ? 'grab' : mode === 'draw' ? 'crosshair' : mode === 'erase' ? 'not-allowed' : mode === 'path' ? 'copy' : 'default',
        touchAction: 'none',
      },
      onPointerDown,
      onPointerMove,
      onPointerUp,
      // NOT `onPointerLeave`. That fires the moment the pointer leaves the element's hit-test
      // boundary, which would end every drag as soon as it left the SVG — the reason pan and 手绘
      // did nothing while a single click (打点) worked. Pointer capture replaces it:
      // `pointercancel` and `lostpointercapture` are the real "the gesture is over" signals.
      onPointerCancel,
      onLostPointerCapture,
      onPointerLeave,
      onWheel,
      // 光标 needs a double click to open an editor; the other tools have nothing to open.
      onDoubleClick,
    },
    ...children,
  )
}

/**
 * A collapsible branch in the map's panel.
 *
 * REQUESTED: the panel needed 地图 as a top level with 标记点/河流/道路/边界 as branches, each item with its
 * own editor that can be hidden. A flat column of everything could not be read once a map held a dozen
 * courses, and there was no way to put a part of it away.
 *
 * A closed group does not render its children at all, so a large map costs nothing while a branch is shut.
 */
function MapGroup(props) {
  const { title, count, open, onToggle, children } = props
  const body = (Array.isArray(children) ? children : [children]).filter(
    (child) => child !== null && child !== undefined && child !== false,
  )
  return h(
    'div',
    { style: { marginTop: '10px' } },
    h(
      'button',
      {
        type: 'button',
        title: open ? `收起「${title}」` : `展开「${title}」`,
        style: { ...buttonStyle, width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
        onClick: onToggle,
      },
      h('span', null, `${open ? '▾' : '▸'} ${title}`),
      h('span', { style: { color: muted } }, String(count)),
    ),
    open ? h('div', { style: { marginTop: '4px' } }, ...body) : null,
  )
}

/** A labelled control in a toolbar. */
function MapButton(props) {
  const { label, active, title, onClick, style } = props
  return h(
    'button',
    {
      type: 'button',
      title: title ?? label,
      style: { ...buttonStyle, ...(active === true ? { borderColor: 'currentColor', fontWeight: 600 } : {}), ...(style ?? {}) },
      onClick,
    },
    label,
  )
}

/** The pen colours, as swatches. */
function ColorPicker(props) {
  const { value, onChange } = props
  return h(
    'div',
    { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
    ...MAP_PEN_COLORS.map((color) =>
      h('button', {
        key: color,
        type: 'button',
        title: color,
        'aria-label': `颜色 ${color}`,
        style: {
          width: '18px',
          height: '18px',
          padding: 0,
          borderRadius: '50%',
          border: value === color ? '2px solid currentColor' : `1px solid ${muted}`,
          background: color,
          cursor: 'pointer',
        },
        onClick: () => onChange(color),
      }),
    ),
  )
}

/**
 * The map branch: the drawing surface, with the maps and their settings beside it.
 *
 * Two documents are written: the maps to the map document, and each map's pan/zoom to
 * `views/layout.json`. The view is saved on a short delay so a wheel gesture does not issue a write
 * per frame.
 */
function MapBranch(props) {
  const { root } = props
  const map = useDocument(root, MAP_DOC)
  const layout = useDocument(root, MAP_LAYOUT_DOC)
  const [mode, setMode] = react.useState('pan')
  const [penColor, setPenColor] = react.useState(MAP_DEFAULT_COLOR)
  const [selectionId, setSelectionId] = react.useState(null)
  const [activeMapId, setActiveMapId] = react.useState(null)
  const [draft, setDraft] = react.useState([])
  const [importNote, setImportNote] = react.useState(null)
  /** What the last eraser stroke removed, so a press that hits nothing is visible rather than silent. */
  const [eraseNote, setEraseNote] = react.useState(null)
  /** The shape being dragged out right now, so it is visible before it is committed. */
  const [draftShape, setDraftShape] = react.useState(null)
  const [detailOpen, setDetailOpen] = react.useState(true)
  const [exportScale, setExportScale] = react.useState(2)
  /** Which panel groups are OPEN. Only the closed ones are remembered, so the default is open. */
  const [closedGroups, setClosedGroups] = react.useState({})
  const groupOpen = (key) => closedGroups[key] !== true
  const toggleGroup = (key) => setClosedGroups((current) => ({ ...current, [key]: current[key] !== true }))
  /** Which kind of course a new path is: a river tapers, a road and a border do not. */
  const [pathKind, setPathKind] = react.useState('river')
  /** Which geometric shape the 图形 tool draws. */
  const [shapeKind, setShapeKind] = react.useState('rect')
  /** The fill a NEW shape gets. `null` means an outline only, which is the safer default. */
  const [shapeFill, setShapeFill] = react.useState(null)
  /** Which shape is selected, so its handles show. */
  const [selectedShapeId, setSelectedShapeId] = react.useState(null)
  /**
   * What the 光标 tool has picked: `{ kind, id, index }` or null.
   *
   * REQUESTED: "新增工具「光标」,可以点击画布上任意笔迹…进行编辑,也可拖拽移动其位置". One target rather than
   * four separate selections, because the tool is about "the thing I clicked" — and the per-kind selection
   * states below are set from it so the right editor opens.
   */
  const [cursorTarget, setCursorTarget] = react.useState(null)
  /** Which freehand stroke the cursor picked. Strokes carry no id, so they are addressed by position. */
  const [selectedStrokeIndex, setSelectedStrokeIndex] = react.useState(null)
  /** What a NEW free text label is set to. Each label then keeps its own copy — see `normalizeMapText`. */
  const [textSize, setTextSize] = react.useState(MAP_TEXT_DEFAULT_SIZE)
  const [textColor, setTextColor] = react.useState(MAP_TEXT_DEFAULT_COLOR)
  const [textBold, setTextBold] = react.useState(false)
  /** What a NEW stamp is set to. */
  const [stampSymbol, setStampSymbol] = react.useState(MAP_SYMBOL_IDS[0])
  const [stampSize, setStampSize] = react.useState(MAP_STAMP_DEFAULT_SIZE)
  const [stampColor, setStampColor] = react.useState(MAP_STAMP_DEFAULT_COLOR)
  /** What the last spray did, so a press that hit no region is visible rather than silent. */
  const [sprayNote, setSprayNote] = react.useState(null)
  /** The freehand pen's width, in screen pixels. Stored per stroke, so changing it never redraws. */
  const [penWidth, setPenWidth] = react.useState(MAP_PEN_DEFAULT)
  /** The path whose waypoints are shown and being edited, or null. */
  const [editingPathId, setEditingPathId] = react.useState(null)
  /**
   * Undo history, as STATE rather than a ref so the 撤销 / 重做 buttons re-render when it changes. See
   * `mapHistoryPush` for the merge window that makes one drag one undo step.
   */
  const [history, setHistory] = react.useState(null)
  // The live view is component state, not the document: a drag must not round-trip through disk to
  // look smooth. It is pushed to the layout document on a delay.
  const [viewState, setViewState] = react.useState(null)
  const drag = react.useRef(null)
  const viewTimer = react.useRef(null)
  const surface = react.useRef(null)
  const fileInput = react.useRef(null)

  const doc = map.state.value
  const maps = mapMaps(doc)
  // The document's own `activeMapId` is the source of truth once set; the local override exists so
  // switching is instant.
  const chosenId = activeMapId ?? doc?.activeMapId ?? null
  const active = resolveActiveMap(doc, chosenId)
  const canvas = mapCanvas(active)
  const strokes = mapStrokes(active)
  const paths = mapPaths(active)
  const shapes = mapShapes(active)
  const pins = mapPins(active)
  const texts = mapTexts(active)
  const stamps = mapStamps(active)
  // `MapSurface` declares its own copies of these two. Declaring them HERE as well is what the panel needs —
  // and their absence was a ReferenceError the moment the panel rendered, which unmounted the whole plugin
  // and left the 世界 window blank. Both names exist in the file, just in the wrong function: a name declared
  // in one component and used in another looks declared to every grep and to every string-matching test.

  /**
   * Whether the surface should draw anything.
   *
   * Blank until the author starts: a brand-new project has one empty map and shows a clean sheet —
   * nothing at all, which is what was asked for. As soon as there is a stroke, a pin, or a SECOND
   * map (which means the author is deliberately working), the sheet and its guide appear.
   */
  const started = strokes.length > 0 || pins.length > 0 || maps.length > 1

  const persisted = mapViewFor(layout.state.value, active?.id)
  /**
   * The SVG box, DERIVED every render.
   *
   * Two shapes lived under one name here — the persisted `{centerX, centerY, zoom}` and this box
   * `{x, y, w, h, zoom}` — and mixing them broke panning, placement and zooming in three separate
   * reports. The box is never stored.
   */
  const box = mapViewBox(viewState ?? persisted, canvas)

  const commitView = (next) => {
    setViewState(next)
    if (viewTimer.current !== null) clearTimeout(viewTimer.current)
    viewTimer.current = setTimeout(() => {
      layout.update((current) => withMapView(current, active?.id, next))
      layout.save()
    }, 500)
  }

  /**
   * Write a new list of maps, and record it in the history.
   *
   * The history is pushed from HERE rather than inside the transform handed to `map.update`: a
   * transform is expected to be pure and React is allowed to call it twice, so a side effect in there
   * could record one edit as two steps.
   *
   * `mergeKey` coalesces continuous edits — a drag, or a run of clicks along one course — into a
   * single undo step. Null makes every call its own step.
   */
  const applyMaps = (nextMaps, mergeKey = null) => {
    const base = map.state.value
    const next = withMaps(base, nextMaps, base?.activeMapId)
    setHistory((current) =>
      current === null || mapHistorySnapshot(current) === null
        ? mapHistoryNew(next)
        : mapHistoryPush(current, next, { mergeKey, at: Date.now() }),
    )
    map.update(() => next)
  }

  /** Apply a pure transform to the LIST OF MAPS, keeping the document's other fields. */
  const updateMaps = (mutator, mergeKey = null) => {
    applyMaps(mutator(mapMaps(map.state.value)), mergeKey)
  }

  /** Step back, or forward, through the recorded states. */
  const stepHistory = (direction) => {
    setHistory((current) => {
      if (current === null) return current
      const next = direction === 'undo' ? mapHistoryUndo(current) : mapHistoryRedo(current)
      const snapshot = mapHistorySnapshot(next)
      // A snapshot identical to the present one means the stack was empty and nothing moved.
      if (snapshot !== null && snapshot !== mapHistorySnapshot(current)) map.update(() => snapshot)
      return next
    })
  }

  /**
   * Erase whatever is under a world point on the ACTIVE map.
   *
   * The decision is made by `mapEraseAt`, which is pure and therefore tested; this only applies its
   * answer and reports what went, so a press that hits nothing is visible rather than silent.
   */
  const eraseAt = (world) => {
    const id = active?.id
    if (id === undefined || world === null) return
    const base = mapMaps(map.state.value).find((entry) => entry.id === id)
    if (base === undefined) return
    const labels = mapLabelLayout(mapPins(base), base, box.zoom, { labelOf })
    const outcome = mapEraseAt(base, world, { zoom: box.zoom, labels })
    if (outcome.erased === null) {
      setEraseNote('橡皮：这里没有东西')
      return
    }
    setEraseNote(`橡皮：擦掉了${outcome.erased.label}`)
    // The whole map is substituted, so a drag erases repeatedly without re-deriving from a stale copy.
    updateMaps((list) => list.map((entry) => (entry.id === id ? outcome.map : entry)), 'erase')
  }

  /**
   * Spray the closed region under a world point on the ACTIVE map.
   *
   * The decision is `mapFillAt`, which is pure and tested; this applies its answer and reports what it
   * did, because a press that lands in no region must be visible rather than silent.
   */
  const sprayAt = (world) => {
    const id = active?.id
    if (id === undefined || world === null) return
    const base = mapMaps(map.state.value).find((entry) => entry.id === id)
    if (base === undefined) return
    const outcome = mapFillAt(base, world, penColor)
    if (outcome.filled === null) {
      setSprayNote('喷漆：这里不是封闭区域')
      return
    }
    setSprayNote('喷漆：填好了' + outcome.filled.label)
    updateMaps((list) => list.map((entry) => (entry.id === id ? outcome.map : entry)), 'spray')
  }

  /** Replace the active map's paths, through the pure helpers so which one changes is explicit. */
  const updatePaths = (mutator, mergeKey = null) => {
    const id = active?.id
    if (id === undefined) return
    updateMaps(
      // `mapAllPaths`, not `mapPaths`: rewriting from the drawing view would erase a course the
      // author has started but not yet finished, and drop every waypoint drag on a draft.
      (list) => list.map((entry) => (entry.id === id ? { ...entry, paths: mutator(mapAllPaths(entry)) } : entry)),
      mergeKey,
    )
  }

  /** Switch which map is shown, remembering it in the document so it survives a reload. */
  const selectMap = (id) => {
    setActiveMapId(id)
    setSelectionId(null)
    setDraft([])
    drag.current = null
    // Reset the local view so the newly chosen map uses its OWN stored viewpoint.
    setViewState(null)
    // `null` = the LIST is not changing, only which one is shown. Passing the normalised list here
    // would write the display defaults (`pinSize`, `labelSize`, ...) into every map, so merely looking
    // around the project edited it.
    map.update((current) => withMaps(current, null, id))
  }

  const addMap = () => {
    const existing = objectList(maps)
    const id = mintMapId('map-', existing)
    updateMaps((list) => [
      ...objectList(list),
      {
        ...freshMap(id, canvas, `地图 ${objectList(list).length + 1}`),
        // A new map starts with the same extent and background as the one you were looking at,
        // because a second map of the same world is the common case.
        canvas,
        background: mapBackground(active),
      },
    ])
    selectMap(id)
  }

  /**
   * Generate a starting map.
   *
   * A NEW map, never a replacement: the author's own drawing must not be overwritten by a button
   * whose whole purpose is to be pressed repeatedly until the result is liked.
   */
  const generateMap = () => {
    const existing = objectList(maps)
    const id = mintMapId('map-', existing)
    // Pin ids are document-global, so a new map must avoid every pin in EVERY map.
    const generated = generateRandomMap(Date.now(), canvas, allPinIds(existing))
    updateMaps((list) => [
      ...objectList(list),
      {
        ...freshMap(id, canvas, `示例地图 ${objectList(list).length + 1}`),
        // ALL THREE groups, from one call. Carrying only strokes and pins silently dropped every
        // generated river on the floor, so the button produced a map with no rivers at all.
        strokes: generated.strokes,
        paths: generated.paths,
        pins: generated.pins,
      },
    ])
    selectMap(id)
    setImportNote(`已生成一张示例地图（${generated.strokes.length} 笔 · ${generated.pins.length} 个地点）。`)
  }

  const removeMap = (id) => {
    const remaining = mapRemoveMap(maps, id)
    if (remaining.length === 0) {
      // Never leave the document with no map: an empty one keeps there being a sheet to draw on.
      const fresh = freshMap(mintMapId('map-', []), canvas)
      map.update((current) => withMaps(current, [fresh], fresh.id))
      setActiveMapId(fresh.id)
      setSelectionId(null)
      setViewState(null)
      return
    }
    map.update((current) => withMaps(current, remaining, remaining[0].id))
    if (id === active?.id) {
      setActiveMapId(remaining[0].id)
      setSelectionId(null)
      setViewState(null)
    }
  }

  const rectOf = () => surface.current?.getBoundingClientRect?.() ?? null
  const worldOf = (event) => mapScreenToWorld(event, rectOf(), box)

  /**
   * Take POINTER CAPTURE for the duration of the gesture.
   *
   * This is the fix for pan and 手绘 doing nothing. Without capture the browser delivers
   * `pointermove` only while the pointer is over the element, and fires `pointerleave` the instant
   * it is not — and an earlier version wired `pointerleave` to the end of the drag. So a drag ended
   * the moment it left the SVG, which for a downward drag was immediately. A single click (打点)
   * never noticed, which is why only the sustained gestures broke.
   *
   * Every DSH client plugin that drags does this: `setPointerCapture(e.pointerId)` on
   * `pointerdown`, a `pointerId` guard on every subsequent event, and `pointercancel` /
   * `lostpointercapture` treated as the end of the gesture.
   */
  const capturePointer = (event) => {
    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId)
    } catch {
      // A pointer that is already gone cannot be captured; the drag then behaves the pre-capture
      // way rather than throwing out of the handler.
    }
  }

  const releasePointer = (event) => {
    try {
      if (event.currentTarget?.hasPointerCapture?.(event.pointerId) === true) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      /* already released */
    }
  }

  const onPointerDown = (event) => {
    // Left button only, and never a second gesture on top of a live one.
    if (event.button !== 0 || drag.current !== null) return
    if (active === null) return
    const world = worldOf(event)

    // --- a shape is dragged out from a corner ---
    if (mode === 'shape') {
      const started = mapDragStart({
        button: event.button,
        pointerId: event.pointerId,
        world,
        screen: { x: event.clientX, y: event.clientY },
        mode: 'shape',
        shapeKind,
        pins,
        hitRadius: mapPinHitRadius(box.zoom),
        canvas,
        view: box,
        rect: rectOf(),
      })
      if (started === null) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      capturePointer(event)
      drag.current = started
      setSelectedShapeId(null)
      return
    }

    // --- the spray: fill the closed region under the pointer ---
    if (mode === 'fill') {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      sprayAt(world)
      return
    }

    // --- the eraser: one object per press, and dragging keeps erasing ---
    if (mode === 'erase') {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      capturePointer(event)
      drag.current = { kind: 'erase', pointerId: event.pointerId }
      eraseAt(world)
      return
    }

    // --- 文字 and 图章: place one where the pointer is ---
    if (mode === 'text') {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      addText(world)
      return
    }
    if (mode === 'stamp') {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      addStamp(world)
      return
    }

    // --- 光标: pick anything up, and drag it ---
    if (mode === 'cursor') {
      // The slop grows as the view zooms out, so a thin coastline stays clickable on a zoomed-out map —
      // the same reasoning as `mapPinHitRadius`.
      const target = mapPickAt(active, world, 4 / box.zoom)
      if (target === null) {
        // A press on empty space clears the selection, which is how you put something down.
        setCursorTarget(null)
        setSelectionId(null)
        setSelectedShapeId(null)
        setSelectedStrokeIndex(null)
        return
      }
      setCursorTarget(target)
      // Open the editor that belongs to this kind of thing.
      setSelectionId(target.kind === 'pin' ? target.id : null)
      setSelectedShapeId(target.kind === 'shape' ? target.id : null)
      setSelectedStrokeIndex(target.kind === 'stroke' ? target.index : null)
      if (target.kind === 'path') setEditingPathId(target.id)
      // A SINGLE click already selects; it does NOT move the panel, because clicking around the canvas to
      // look at things would then drag the panel with it. Double-click is the explicit "take me there".
      if (typeof event.preventDefault === 'function') event.preventDefault()
      capturePointer(event)
      // THE SNAPSHOT IS THE POINT. Every move applies the TOTAL offset to the map as it was when the drag
      // began, so a long drag cannot accumulate rounding drift and lag behind the pointer.
      drag.current = {
        kind: 'move',
        pointerId: event.pointerId,
        target,
        startWorld: { x: world.x, y: world.y },
        snapshot: active,
      }
      return
    }

    // --- rivers and roads: pick up a waypoint, or extend the course ---
    if (mode === 'path') {
      // Again the editing view: the first waypoint of a draft must be grabbable.
      const hitWaypoint = pathPointAt(mapAllPaths(active), world, mapPathHitRadius(box.zoom))
      if (hitWaypoint !== null) {
        // Dragging a waypoint reshapes the course through it. One drag is one undo step, which is what
        // the merge key on the move buys.
        setEditingPathId(hitWaypoint.id)
        if (typeof event.preventDefault === 'function') event.preventDefault()
        capturePointer(event)
        drag.current = { kind: 'waypoint', pointerId: event.pointerId, id: hitWaypoint.id, index: hitWaypoint.index }
        return
      }
      const inside = clampToBox(world, canvas.width, canvas.height)
      // AND AGAIN, and this is the one that broke drawing a new course: the draft written by the
      // first click is not in the drawing view, so looking for it there found nothing and the second
      // click did nothing at all.
      const course = mapAllPaths(active)
      if (editingPathId === null) {
        // A NEW course, one waypoint long. It becomes drawable on the next click.
        const id = mintMapId('path-', allPathIds(maps))
        updatePaths((list) => mapPathStart(list, id, inside, pathKind))
        setEditingPathId(id)
        // A new course opens its editor too, so it can be named while it is being drawn.
        focusOn({ kind: 'path', id, pathKind })
        return
      }
      if (course.some((entry) => entry.id === editingPathId)) {
        // Extending. A click near the course INSERTS there, and a click anywhere else APPENDS, so a
        // long straight stretch can be broken in the middle instead of only at its end.
        const target = course.find((entry) => entry.id === editingPathId)
        const reach = mapPathHitRadius(box.zoom) * 3
        const near = target.points.some((point) => Math.hypot(point.x - inside.x, point.y - inside.y) < reach)
        updatePaths(
          (list) => (near ? mapPathInsert(list, editingPathId, inside) : mapPathAppend(list, editingPathId, inside)),
          `path-extend-${editingPathId}`,
        )
      }
      return
    }

    // Select a pin in ANY mode. Previously only 打点 ran a hit test, so a pin placed earlier could
    // not be reopened for editing without switching modes.
    const touched = mapPinHit(pins, mapLabelLayout(pins, active, box.zoom, { labelOf }), world, mapPinHitRadius(box.zoom))
    if (touched !== null) setSelectionId(touched.id)
    const started = mapDragStart({
      button: event.button,
      pointerId: event.pointerId,
      world,
      screen: { x: event.clientX, y: event.clientY },
      mode,
      pins,
      hitRadius: mapPinHitRadius(box.zoom),
      canvas,
      view: box,
      rect: rectOf(),
    })
    if (started === null) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    capturePointer(event)
    drag.current = started

    if (started.kind === 'draw') {
      setDraft(started.points)
      return
    }
    if (started.kind === 'new-pin') {
      // Every pin in the DOCUMENT, not merely this map's: the host registers pin ids in one table and
      // refuses a document that reuses any of them, so a per-map mint here blocked every later save.
      const id = mintMapId('pin-', allPinIds(maps))
      const point = { x: Math.round(started.point.x), y: Math.round(started.point.y) }
      updateMaps((list) =>
        list.map((entry) =>
          entry.id === active.id
            ? { ...entry, pins: [...objectList(entry.pins), { id, placeId: null, x: point.x, y: point.y, label: '', color: null, size: null, dot: null }] }
            : entry,
        ),
      )
      setSelectionId(id)
      // Open its editor in the panel, so a new marker is named where the author is already looking.
      focusOn({ kind: 'pin', id })
      // Remember the new id so the very same gesture can drag it.
      drag.current = { ...started, kind: 'pin', id, offsetX: 0, offsetY: 0 }
      return
    }
    if (started.kind === 'pin') {
      setSelectionId(started.id)
      focusOn({ kind: 'pin', id: started.id })
    }
  }

  const onPointerMove = (event) => {
    const state = drag.current
    // Guarded on `pointerId` before anything else: a second pointer must not drive this drag.
    if (state === null || state.pointerId !== event.pointerId) return
    const intent = mapDragMove({
      drag: state,
      pointerId: event.pointerId,
      world: worldOf(event),
      screen: { x: event.clientX, y: event.clientY },
      view: box,
      canvas,
      sampleStep: 3 / box.zoom,
      // Shift makes it square, and it must reach the preview as well as the committed shape.
      square: event.shiftKey === true,
    })
    // The eraser is the one gesture with no intent to compute: every move erases at the pointer.
    if (state.kind === 'erase') {
      eraseAt(worldOf(event))
      return
    }
    // 光标: move what was picked, applying the TOTAL offset to the snapshot taken when the drag began.
    if (state.kind === 'move') {
      const world = worldOf(event)
      const moved = mapMoveTarget(state.snapshot, state.target, world.x - state.startWorld.x, world.y - state.startWorld.y)
      // One merge key per drag, so the whole movement is ONE undo step rather than one per pointer event.
      updateMaps(
        (list) => list.map((entry) => (entry.id === active.id ? { ...moved, id: entry.id } : entry)),
        `move-${state.target.kind}-${state.target.id ?? state.target.index}`,
      )
      return
    }
    if (intent === null) return
    if (intent.view !== undefined) {
      commitView(intent.view)
      return
    }
    if (intent.points !== undefined) {
      drag.current = { ...state, points: intent.points }
      setDraft(intent.points)
      return
    }
    if (intent.shape !== undefined) {
      // Drawn live while dragging, so the shape is visible as it is pulled out. `intent.shape` is null
      // while the box is still too small; the recorded position still moves, so release can commit.
      drag.current = { ...state, last: intent.last ?? state.last }
      setDraftShape(intent.shape)
      return
    }
    if (intent.waypoint !== undefined) {
      const target = intent.waypoint
      // The merge key ties every move of THIS waypoint together, so one drag is one undo step.
      updatePaths(
        (list) => mapPathMovePoint(list, target.id, target.index, { x: target.x, y: target.y }),
        `path-point-${target.id}-${target.index}`,
      )
      return
    }
    if (intent.pin !== undefined) {
      const target = intent.pin
      updateMaps((list) =>
        list.map((entry) =>
          entry.id === active.id
            ? {
                ...entry,
                pins: objectList(entry.pins).map((pin) =>
                  pin.id === target.id ? { ...pin, x: Math.round(target.x), y: Math.round(target.y) } : pin,
                ),
              }
            : entry,
        ),
      )
    }
  }

  /**
   * End the gesture. `cancelled` distinguishes a real release from the pointer being taken away, so
   * a half-drawn stroke is discarded rather than committed.
   */
  const endDrag = (event, cancelled) => {
    const state = drag.current
    if (state === null || state.pointerId !== event.pointerId) return
    drag.current = null
    if (cancelled !== true) releasePointer(event)

    const outcome = mapDragEnd({
      drag: state,
      pointerId: event.pointerId,
      cancelled,
      // The release point and the shift key are PART OF THE GESTURE. Neither was passed, which is why a
      // dragged shape was never added and why holding shift did nothing at all.
      to: worldOf(event),
      square: event.shiftKey === true,
    })

    // A dragged shape is committed on release, and the draft cleared either way so it never lingers.
    // THIS MUST COME BEFORE the "only a draw continues" guard below: that guard used to sit first, so a
    // shape drag returned there and was NEVER added — the drag looked like it worked and then vanished.
    if (state.kind === 'shape') {
      setDraftShape(null)
      if (outcome === null || outcome.cancelled === true || outcome.shape === null || outcome.shape === undefined) return
      if (active === null) return
      const id = mintMapId('shape-', mapShapes(active))
      applyMaps(
        mapMaps(map.state.value).map((entry) =>
          entry.id === active.id
            ? {
                ...entry,
                shapes: [
                  ...objectList(entry.shapes),
                  { ...outcome.shape, id, color: penColor, fill: shapeFill, width: 3, dash: 'solid' },
                ],
              }
            : entry,
        ),
      )
      setSelectedShapeId(id)
      focusOn({ kind: 'shape', id })
      setSprayNote('图形：已添加，可在右侧「图形」分支里改颜色和大小')
      return
    }

    if (outcome === null) return
    if (state.kind !== 'draw') return
    setDraft([])
    // Nothing is stored for a cancelled gesture or a tap.
    if (outcome.cancelled === true || outcome.stroke === null) return
    if (active === null) return
    // The stroke carries the pen colour it was drawn with, so changing the pen later never
    // recolours existing work.
    updateMaps((list) => mapAppendStroke(list, active.id, { color: penColor, width: penWidth, points: outcome.stroke }))
    // ADDED REQUEST: "输入任何笔迹后右边栏应该自动跳转到对应编辑页面". The new stroke is the LAST one, and
    // strokes are addressed by position — so its index is the length before the append.
    const strokeIndex = mapStrokes(active).length
    setSelectedStrokeIndex(strokeIndex)
    focusOn({ kind: 'stroke', index: strokeIndex })
  }

  const onPointerUp = (event) => endDrag(event, false)
  const onPointerCancel = (event) => endDrag(event, true)

  /**
   * Double-click with the 光标: take the author to that thing's editor.
   *
   * REQUESTED: "用光标双击任意笔迹后右边栏应该跳转到对应编辑页面". A single click selects and drags; a double
   * click is the deliberate "open this". The pick runs again rather than reusing `cursorTarget`, so the
   * gesture works even when the first click landed on empty space.
   */
  const onDoubleClick = (event) => {
    if (mode !== 'cursor' || active === null) return
    const world = worldOf(event)
    const target = mapPickAt(active, world, 4 / box.zoom)
    if (target === null) return
    // A course has to carry its KIND, because the panel groups courses by kind and `mapPickAt` speaks only
    // of ids. Without it the jump would not know which group to open.
    const enriched = target.kind === 'path'
      ? { ...target, pathKind: (mapAllPaths(active).find((entry) => entry.id === target.id) ?? {}).kind ?? null }
      : target
    setCursorTarget(enriched)
    setSelectionId(enriched.kind === 'pin' ? enriched.id : null)
    setSelectedShapeId(enriched.kind === 'shape' ? enriched.id : null)
    setSelectedStrokeIndex(enriched.kind === 'stroke' ? enriched.index : null)
    if (enriched.kind === 'path') setEditingPathId(enriched.id)
    focusOn(enriched)
  }
  // Capture is released automatically on pointerup, which fires this afterwards; the guard in
  // `endDrag` makes the second call a no-op, so the stroke is never committed twice.
  const onLostPointerCapture = (event) => endDrag(event, true)

  /**
   * A FALLBACK, not the mechanism.
   *
   * `setPointerCapture` can fail — a pointer that is already gone, or a hostile environment — and
   * then neither `pointerup` nor `lostpointercapture` arrives once the pointer leaves the element.
   * Without this the drag state would stay set forever and the canvas would be permanently stuck.
   *
   * While capture IS held, leaving the element is meaningless and MUST be ignored: that was the
   * bug, because leave fires the instant the pointer crosses the hit-test boundary.
   */
  const onPointerLeave = (event) => {
    if (event.currentTarget?.hasPointerCapture?.(event.pointerId) === true) return
    endDrag(event, true)
  }

  const onWheel = (event) => {
    // A wheel over the canvas should zoom, not scroll the page behind it.
    if (typeof event.preventDefault === 'function') event.preventDefault()
    const world = worldOf(event)
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
    commitView(mapZoomAt(box, factor, world))
  }

  const undoStroke = () => active !== null && updateMaps((list) => mapUndoStroke(list, active.id))
  const clearStrokes = () => active !== null && updateMaps((list) => mapClearStrokes(list, active.id))
  const clearPins = () => active !== null && updateMaps((list) => mapClearPins(list, active.id))
  /**
   * Update ONE pin. Takes the id rather than reading the selection, because the editor now lives inside
   * the item it belongs to — a panel that edited "whatever is selected" would edit the wrong marker the
   * moment the selection changed while its editor was open.
   */
  const patchPin = (pinId, patch) => {
    if (active === null || typeof pinId !== 'string') return
    updateMaps((list) => mapUpdatePin(list, active.id, pinId, patch), 'pin-' + pinId)
  }

  /** Replace the active map's shapes, through pure transforms so which one changes is explicit. */
  const updateShapes = (mutator) => {
    const id = active?.id
    if (id === undefined) return
    updateMaps((list) => list.map((entry) => (entry.id === id ? { ...entry, shapes: mutator(mapShapes(entry)) } : entry)))
  }

  const updateTexts = (mutator) => {
    const id = active?.id
    if (id === undefined) return
    updateMaps((list) => list.map((entry) => (entry.id === id ? { ...entry, texts: mutator(mapTexts(entry)) } : entry)))
  }

  const updateStamps = (mutator) => {
    const id = active?.id
    if (id === undefined) return
    updateMaps((list) => list.map((entry) => (entry.id === id ? { ...entry, stamps: mutator(mapStamps(entry)) } : entry)))
  }

  /** Freehand strokes. Addressed by index, because a stroke carries no id of its own. */
  const updateStrokes = (mutator) => {
    const id = active?.id
    if (id === undefined) return
    updateMaps((list) => list.map((entry) => (entry.id === id ? { ...entry, strokes: mutator(mapStrokes(entry)) } : entry)))
  }

  /**
   * Move the panel to whatever was just drawn or clicked.
   *
   * REQUESTED twice: "输入任何笔迹后右边栏应该自动跳转到对应编辑页面" and "用光标双击任意笔迹后右边栏应该跳转到对应
   * 编辑页面". One state and one effect serve both, so the two routes cannot drift apart.
   */
  const [focusTarget, setFocusTarget] = react.useState(null)
  const focusOn = (target) => setFocusTarget(target === null || target === undefined ? null : { ...target })

  /**
   * Open the group holding the target, then scroll its row into view.
   *
   * TWO PASSES ON PURPOSE. A row only exists once its group is open, so the first pass opens the group and
   * returns; the state change re-runs this effect, and the second pass finds the row. The target is cleared
   * after a successful scroll, or the effect would fight the author every time they collapsed a group.
   */
  react.useEffect(() => {
    if (focusTarget === null) return
    const group = mapFocusGroup(focusTarget)
    if (group !== null && closedGroups[group] === true) {
      setClosedGroups((current) => ({ ...current, [group]: false }))
      return
    }
    const anchor = mapFocusAnchor(focusTarget)
    if (anchor === null || typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      setFocusTarget(null)
      return
    }
    // Scoped to this panel, because `data-item` is only unique within it.
    const node = document.querySelector(`[data-item="${anchor}"]`)
    if (node !== null && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' })
    }
    setFocusTarget(null)
  }, [focusTarget, closedGroups])

  /** The colour theme is one field on the map, so it needs no list to walk. */
  const setTheme = (theme) => {
    const id = active?.id
    if (id === undefined) return
    updateMaps((list) => list.map((entry) => (entry.id === id ? { ...entry, theme } : entry)))
  }

  /**
   * Put a free text label on the map, and select it so the author can type straight away.
   *
   * REQUESTED: "自由文字标注". No dialog box: the runtimes here do not implement `window.prompt` — that is what
   * made 重命名 look dead once — so the text is edited in the panel and the map just gets an empty box.
   */
  const addText = (world) => {
    const id = active?.id
    if (id === undefined) return
    const newId = mintMapId('text-', mapTexts(active).map((entry) => entry.id))
    updateTexts((list) => [...list, { id: newId, x: Math.round(world.x), y: Math.round(world.y), text: '', size: textSize, color: textColor, bold: textBold }])
    setCursorTarget({ kind: 'text', id: newId })
    setSelectionId(null)
    setSelectedShapeId(null)
    focusOn({ kind: 'text', id: newId })
    setSprayNote('文字：已在点击处放置，请在右侧「文字」里输入内容')
  }

  /** Stamp the chosen symbol where the pointer is. */
  const addStamp = (world) => {
    const id = active?.id
    if (id === undefined) return
    const newId = mintMapId('stamp-', mapStamps(active).map((entry) => entry.id))
    updateStamps((list) => [...list, { id: newId, symbol: stampSymbol, x: Math.round(world.x), y: Math.round(world.y), size: stampSize, color: stampColor }])
    setCursorTarget({ kind: 'stamp', id: newId })
    setSelectionId(null)
    setSelectedShapeId(null)
    focusOn({ kind: 'stamp', id: newId })
    setSprayNote(`图章：已放置「${MAP_SYMBOLS[stampSymbol]?.label ?? stampSymbol}」`)
  }

  /** Change one shape's box, ignoring a nonsense entry rather than storing it. */
  const resizeShape = (shape, patch) => {
    const next = {}
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!(key in patch)) continue
      const value = Number(patch[key])
      if (!Number.isFinite(value)) return
      // A shape with no area is invisible AND impossible to select, so a size below the minimum is refused.
      if ((key === 'w' || key === 'h') && value < MAP_SHAPE_MIN_SIZE) return
      next[key] = value
    }
    if (Object.keys(next).length === 0) return
    updateShapes((list) => list.map((entry) => (entry.id === shape.id ? { ...entry, ...next } : entry)))
  }

  /** Delete one pin by id, for the same reason. */
  const deletePinById = (pinId) => {
    if (active === null || typeof pinId !== 'string') return
    updateMaps((list) =>
      list.map((entry) =>
        entry.id === active.id ? { ...entry, pins: objectList(entry.pins).filter((pin) => pin.id !== pinId) } : entry,
      ),
    )
    if (selectionId === pinId) setSelectionId(null)
  }

  /**
   * Import a background image.
   *
   * The file is read as a data URL and POSTed as base64 so it travels the same JSON path as every
   * other request — one body reader, one limit, one error shape. The canvas is then sized to the
   * image's own pixels, because the alternative is stretching the artwork to the existing canvas.
   */
  const importBackground = (file) => {
    const name = mapAssetName(file?.name)
    if (name === null) {
      setImportNote('只支持 png / jpg / gif / webp / svg 图片。')
      return
    }
    setImportNote('正在导入…')
    const reader = new FileReader()
    reader.onerror = () => setImportNote('读取文件失败。')
    reader.onload = () => {
      const data = String(reader.result ?? '')
      fetch(api(`${API}/asset`), { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify({ root, name, data }) })
        .then(async (response) => {
          const body = await response.json().catch(() => null)
          if (!response.ok) {
            setImportNote(body?.error ?? `导入失败（HTTP ${response.status}）`)
            return
          }
          const apply = (size) => {
            updateMaps((list) =>
              list.map((entry) =>
                entry.id === active?.id ? { ...entry, background: { kind: 'image', asset: name }, ...(size ?? {}) } : entry,
              ),
            )
            setImportNote(`已导入 ${name}（${body?.bytes ?? '?'} 字节）。记得保存。`)
          }
          // Measure the image so the canvas can match it. `Image` does not exist in a server render,
          // so this path is only ever taken in a browser.
          const probe = new Image()
          probe.onload = () =>
            apply({ canvas: { width: probe.naturalWidth || canvas.width, height: probe.naturalHeight || canvas.height } })
          probe.onerror = () => apply(null)
          probe.src = data
        })
        .catch((error) => setImportNote(String(error?.message ?? error)))
    }
    reader.readAsDataURL(file)
  }

  /**
   * Export the map as a PNG.
   *
   * The SVG is serialised, drawn into a canvas at the chosen scale, and downloaded. Three details
   * matter and each of them is a way this silently produces a wrong or blank image:
   *
   *   * `currentColor` CANNOT RESOLVE once the SVG is detached from the document, so the strokes and
   *     labels would come out black. The live element's computed colour is written onto the clone.
   *   * the clone needs explicit `width`/`height`, or a detached SVG has no intrinsic size to draw.
   *   * the background image is same-origin (`/dsh-novel/asset`), so it does NOT taint the canvas and
   *     `toBlob` keeps working. A cross-origin image would make the export fail with a security
   *     error instead.
   */
  const exportPng = (scale) => {
    const svg = surface.current
    if (svg === null || svg === undefined || typeof document === 'undefined') return
    const size = mapExportSize(canvas, scale)
    try {
      const clone = svg.cloneNode(true)
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
      clone.setAttribute('width', String(size.width))
      // Resolve the inherited colour BEFORE detaching, or every currentColor stroke exports black.
      const resolved = typeof getComputedStyle === 'function' ? getComputedStyle(svg).color : ''
      // NOT the theme's colour verbatim: a light-on-dark ink on a LIGHT sheet would export nearly blank, so
      // the contrast is measured against the paper it will actually land on — the theme's paper, not a
      // hardcoded white. A dark theme would otherwise export a black sheet with invisible text.
      clone.style.color = mapExportInk(resolved, mapPaper(active))
      clone.setAttribute('height', String(size.height))
      // Resolve the inherited colour BEFORE detaching, or every currentColor stroke exports black.
      clone.style.background = mapPaper(active)
      const markup = new XMLSerializer().serializeToString(clone)
      const source = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
      const image = new Image()
      image.onload = () => {
        try {
          const target = document.createElement('canvas')
          target.width = size.width
          target.height = size.height
          const ctx = target.getContext('2d')
          // The theme's paper, so the pixels behind the SVG match the sheet on top of them.
          ctx.fillStyle = mapPaper(active)
          ctx.fillRect(0, 0, size.width, size.height)
          ctx.drawImage(image, 0, 0, size.width, size.height)
          target.toBlob((blob) => {
            URL.revokeObjectURL(source)
            if (blob === null) {
              setImportNote('导出失败：无法生成图片。')
              return
            }
            const link = document.createElement('a')
            link.href = URL.createObjectURL(blob)
            link.download = mapExportName(active === null ? null : mapDisplayName(active), 'png')
            link.click()
            // Revoked on the next tick: revoking immediately can cancel the download in some browsers.
            setTimeout(() => URL.revokeObjectURL(link.href), 10000)
            setImportNote(`已导出 ${size.width}×${size.height} PNG。`)
          }, 'image/png')
        } catch (error) {
          URL.revokeObjectURL(source)
          setImportNote(`导出失败：${error?.message ?? error}`)
        }
      }
      image.onerror = () => {
        URL.revokeObjectURL(source)
        setImportNote('导出失败：无法渲染这张地图。')
      }
      image.src = source
    } catch (error) {
      setImportNote(`导出失败：${error?.message ?? error}`)
    }
  }

  const selectedPin = pins.find((pin) => pin.id === selectionId) ?? null
  const placeOptions = useRefOptions(root, ['place'])
  /**
   * id → name for every 地点, so a pin with no text of its own shows the name of the place it is linked
   * to rather than the raw id (`place-1`), which was technically informative and practically useless.
   */
  const placeTitles = {}
  for (const option of Array.isArray(placeOptions?.place) ? placeOptions.place : []) {
    if (typeof option?.id === 'string' && option.id !== '') placeTitles[option.id] = option.title
  }
  /**
   * What a marker is CALLED — its own text, else the name of the 地点 it links to, else its id.
   *
   * One resolver, used BOTH to draw the names and to decide what a click landed on. Two estimates would
   * drift, and the clickable area would end up somewhere other than the visible text.
   */
  const labelOf = (pin) => {
    if (typeof pin?.label === 'string' && pin.label !== '') return pin.label
    const title = typeof placeTitles?.[pin?.placeId] === 'string' ? placeTitles[pin.placeId] : ''
    return title !== '' ? title : pin?.placeId ?? pin?.id ?? ''
  }

  if (doc === null) {
    return h('div', { style: { padding: '18px' } }, h(Note, { text: map.state.error ?? '地图文档不可用。', tone: map.state.error === null ? undefined : 'error' }))
  }

  const toolbar = h(
    'div',
    { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px', flex: '0 0 auto' } },
    h(MapButton, {
      label: '文字',
      active: mode === 'text',
      title: '文字：点画布上任意位置放一段自由文字，再到右侧「文字」里输入内容',
      onClick: () => setMode('text'),
    }),
    h(MapButton, {
      label: '图章',
      active: mode === 'stamp',
      title: '图章：点画布上任意位置盖一个符号（树、山、城镇、塔、桥、港口、遗迹、星、危险）',
      onClick: () => setMode('stamp'),
    }),
    h(MapButton, {
      label: '光标',
      active: mode === 'cursor',
      title: '光标：点画布上的标记点、笔迹、图形或地形选中它，直接拖动就能移动位置',
      onClick: () => setMode('cursor'),
    }),
    h(MapButton, { label: '平移', active: mode === 'pan', onClick: () => setMode('pan') }),
    h(MapButton, { label: '打点', active: mode === 'pin', onClick: () => setMode('pin') }),
    h(MapButton, { label: '手绘', active: mode === 'draw', onClick: () => setMode('draw') }),
    h(MapButton, {
      label: '橡皮',
      active: mode === 'erase',
      title: '橡皮：点或拖过地图上的标记、河流、道路、笔迹，就会擦掉它',
      onClick: () => {
        setMode('erase')
        setSelectionId(null)
        setEditingPathId(null)
      },
    }),
    h(MapButton, {
      label: '图形',
      active: mode === 'shape',
      title: '图形工具：在画布上拖出一个矩形或圆形（按住 Shift 画正方形/正圆）',
      onClick: () => {
        setMode('shape')
        setSelectionId(null)
        setEditingPathId(null)
      },
    }),
    h(MapButton, {
      label: '喷漆',
      active: mode === 'fill',
      title: '喷漆：点任意封闭区域（矩形、圆形，或首尾相接的笔迹/边界）填色',
      onClick: () => {
        setMode('fill')
        setSelectionId(null)
        setEditingPathId(null)
      },
    }),
    h(MapButton, {
      label: '地形',
      active: mode === 'path',
      title: '地形：河流、道路、边界、山脉。点一下起点，再点着走；拖动路点可以改形状',
      onClick: () => {
        setMode('path')
        setSelectionId(null)
      },
    }),
    h('span', { style: { width: '1px', height: '18px', background: muted } }),
    mode === 'shape'
      ? h(
          'span',
          { style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
          ...MAP_SHAPE_KIND_IDS.map((kind) =>
            h(MapButton, { key: kind, label: MAP_SHAPE_KINDS[kind].label, active: shapeKind === kind, onClick: () => setShapeKind(kind) }),
          ),
          h('span', { style: { fontSize: '12px', color: muted } }, '描边'),
          h(ColorPicker, { value: penColor, onChange: setPenColor }),
          h('span', { style: { fontSize: '12px', color: muted } }, '填充'),
          h(ColorPicker, { value: shapeFill, onChange: setShapeFill }),
          h(MapButton, { label: '不填充', active: shapeFill === null, onClick: () => setShapeFill(null) }),
        )
      : mode === 'fill'
        ? h(
            'span',
            { style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '12px', color: muted } }, '喷漆颜色'),
            h(ColorPicker, { value: penColor, onChange: setPenColor }),
            h('span', { style: { fontSize: '12px', color: muted } }, '（点封闭区域内部填色）'),
          )
        : null,
    mode === 'path'
      ? h(
          'span',
          { style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
          ...MAP_PATH_KIND_IDS.map((kind) =>
            h(MapButton, {
              key: kind,
              label: MAP_PATH_KINDS[kind].label,
              active: pathKind === kind,
              title: `画${MAP_PATH_KINDS[kind].label}`,
              onClick: () => {
                setPathKind(kind)
                // A course already being edited CHANGES kind rather than being abandoned, which is
                // what pressing 道路 while drawing a river obviously means.
                if (editingPathId !== null) {
                  updatePaths((list) => mapPathUpdate(list, editingPathId, { kind }), `path-kind-${editingPathId}`)
                }
              },
            }),
          ),
          editingPathId === null
            ? h('span', { style: { fontSize: '12px', color: muted } }, '点一下开始一条新路径')
            : h(MapButton, { label: '完成', title: '结束这条路径', onClick: () => setEditingPathId(null) }),
        )
      : h(
          'span',
          { style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12px', color: muted } }, '画笔'),
          h(ColorPicker, { value: penColor, onChange: setPenColor }),
          h('span', { style: { fontSize: '12px', color: muted } }, '粗细'),
          ...MAP_PEN_WIDTHS.map((width) =>
            h(MapButton, {
              key: width,
              label: String(width),
              active: penWidth === width,
              title: `画笔粗细 ${width}`,
              onClick: () => setPenWidth(width),
            }),
          ),
        ),
    // WHAT THE CURRENT TOOL WILL PLACE. Shown only for that tool: a toolbar that shows every setting at once
    // is what the panel was reorganised to get away from.
    mode === 'text'
      ? h(
          'span',
          { style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12px', color: muted } }, '新文字'),
          ...MAP_TEXT_SIZES.map((size) => h(MapButton, { key: size, label: String(size), active: textSize === size, title: `字号 ${size}`, onClick: () => setTextSize(size) })),
          h(MapButton, { label: '粗', active: textBold, title: '粗体', onClick: () => setTextBold(!textBold) }),
          h(ColorPicker, { value: textColor, onChange: setTextColor }),
        )
      : null,
    mode === 'stamp'
      ? h(
          'span',
          { style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12px', color: muted } }, '新图章'),
          ...MAP_SYMBOL_IDS.map((symbol) =>
            h(MapButton, { key: symbol, label: MAP_SYMBOLS[symbol].label, active: stampSymbol === symbol, title: `盖一个${MAP_SYMBOLS[symbol].label}`, onClick: () => setStampSymbol(symbol) }),
          ),
          ...MAP_STAMP_SIZES.map((size) => h(MapButton, { key: size, label: String(size), active: stampSize === size, title: `大小 ${size}`, onClick: () => setStampSize(size) })),
          h(ColorPicker, { value: stampColor, onChange: setStampColor }),
        )
      : null,
    h('span', { style: { width: '1px', height: '18px', background: muted } }),
    h(MapButton, { label: '缩小', onClick: () => commitView(mapZoomAt(box, 1 / 1.3, null)) }),
    h(MapButton, { label: '放大', onClick: () => commitView(mapZoomAt(box, 1.3, null)) }),
    h(MapButton, { label: '适应窗口', title: '回到整幅地图', onClick: () => commitView(mapPanTo({ zoom: 1 }, canvas.width / 2, canvas.height / 2)) }),
    h('span', { style: { color: muted, fontSize: '12px' } }, `${Math.round(box.zoom * 100)}%`),
    h('span', { style: { width: '1px', height: '18px', background: muted } }),
    h(MapButton, {
      label: '撤销',
      title: '撤销上一步（一次拖动算一步）',
      onClick: () => stepHistory('undo'),
      style: mapHistoryCanUndo(history) ? undefined : { opacity: 0.45 },
    }),
    h(MapButton, {
      label: '重做',
      title: '重做',
      onClick: () => stepHistory('redo'),
      style: mapHistoryCanRedo(history) ? undefined : { opacity: 0.45 },
    }),
    h(MapButton, { label: '清空笔迹', onClick: clearStrokes }),
    h(MapButton, { label: '导入底图', title: '把一张图片作为这张地图的底图', onClick: () => fileInput.current?.click?.() }),
    h(
      'span',
      { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
      h('select', {
        value: String(exportScale),
        title: '导出倍率',
        style: { ...inputStyle, padding: '2px 4px' },
        onChange: (event) => setExportScale(Number(event.target.value)),
      }, ...MAP_EXPORT_SCALES.map((scale) => h('option', { key: scale, value: String(scale) }, `${scale}×`))),
      h(MapButton, { label: '导出 PNG', title: '把这张地图导出为图片', onClick: () => exportPng(exportScale) }),
    ),
    isMapImage(active?.background)
      ? h(MapButton, {
          label: '移除底图',
          onClick: () => updateMaps((list) => list.map((entry) => (entry.id === active?.id ? { ...entry, background: { kind: 'blank', asset: null } } : entry))),
        })
      : null,
    // Kept out of the layout: the button above is the visible control, and a bare file input cannot
    // be styled to match the rest of the toolbar.
    h('input', {
      ref: fileInput,
      type: 'file',
      accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml',
      style: { display: 'none' },
      onChange: (event) => {
        const file = event.target.files?.[0]
        if (file !== undefined) importBackground(file)
        // So picking the same file twice fires `change` again.
        event.target.value = ''
      },
    }),
    importNote === null ? null : h('span', { style: { color: muted, fontSize: '12px' } }, importNote),
  )

  /**
   * The rivers and roads of the active map, with their settings.
   *
   * A LIST rather than canvas-only editing, because clicking a course on the canvas is ambiguous — a
   * click near a line could mean "extend this", "insert here" or "select this". The canvas therefore
   * only ever extends the course being edited, and selecting one to edit happens here, unambiguously.
   */
  /**
   * The editor for ONE marker, as a list of nodes so it can be shown inside its row.
   *
   * REQUESTED: "地图为一级目录,下设分支为标记点/河流/道路/边界等,每一个...应该有单独的编辑界面(可隐藏)".
   * So the editor belongs to the ITEM and lives inside it, rather than in a second place that has to be
   * kept in step with the selection.
   */
  const pinEditor = (pin) => [
    h(FieldLabel, { key: 'place-label', text: '对应地点' }),
    h(FieldControl, {
      key: 'place',
      // `emptyLabel` because a bare 「（未设）」 gave no clue what the field was. The author asked exactly
      // that — "编辑点的时候有「未设」是什么?" — which is a field failing to explain itself.
      field: { key: 'placeId', type: 'ref', refKind: 'place', label: '对应地点', emptyLabel: '（未关联地点）' },
      value: pin.placeId,
      // THE PROPS `FieldControl` ACTUALLY TAKES. This call passed `options` and `onChange`, which the
      // component does not read — so the 地点 list was ALWAYS EMPTY and no marker could ever be linked to a
      // place. That is the whole of the reported "标记点的关联问题": not a broken link, but a control that
      // silently did nothing. A wrong prop name is invisible: nothing errors, the list is just empty.
      refOptions: placeOptions,
      onPatch: (patch) => {
        const next = patch?.placeId
        patchPin(pin.id, { placeId: next === '' || next === undefined ? null : next })
      },
    }),
    // AN OPTION THAT NO LONGER EXISTS IS WORSE THAN NONE: a `<select>` whose value is not among its options
    // falls back to showing the FIRST one, so a marker linked to a deleted 地点 looks UNLINKED — which is
    // exactly how it was reported. Saying so is the only way the author can tell the two apart.
    pin.placeId !== null && pin.placeId !== undefined && placeTitles[pin.placeId] === undefined
      ? h(
          'div',
          { key: 'place-stale', style: { fontSize: '12px', color: '#e5534b', marginTop: '2px', marginBottom: '6px' } },
          `关联的地点「${pin.placeId}」已不存在（可能被删除了）。请重新选择，或按下面的「清除关联」。`,
        )
      : null,
    h(
      'div',
      { key: 'place-note', style: { fontSize: '12px', color: muted, marginTop: '2px', marginBottom: '6px' } },
      pin.placeId === null || pin.placeId === undefined
        ? '未关联：这个标记是独立的，名称用下面的「标记文字」。'
        : `已关联到「${placeTitles[pin.placeId] ?? pin.placeId}」：标记文字留空时就显示这个地点的名字。`,
    ),
    h(FieldLabel, { key: 'text-label', text: '标记文字' }),
    h('input', {
      key: 'text',
      type: 'text',
      style: { ...inputStyle, width: '100%' },
      value: typeof pin.label === 'string' ? pin.label : '',
      onChange: (event) => patchPin(pin.id, { label: event.target.value }),
    }),
    h(FieldLabel, { key: 'size-label', text: '点的大小' }),
    h(
      'div',
      { key: 'size', style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } },
      h(MapButton, {
        label: '跟随地图',
        active: !Number.isFinite(Number(pin.dot)) || Number(pin.dot) <= 0,
        title: '使用上面的「标记大小」设置',
        onClick: () => patchPin(pin.id, { dot: null }),
      }),
      ...MAP_PIN_SIZES.map((size) =>
        h(MapButton, {
          key: size,
          label: String(size),
          active: Number(pin.dot) === size,
          title: `这个点直径 ${size}`,
          onClick: () => patchPin(pin.id, { dot: size }),
        }),
      ),
    ),
    h(FieldLabel, { key: 'color-label', text: '点的颜色（同时用于名称）' }),
    h(ColorPicker, {
      key: 'color',
      // The marker's own colour. It used to colour only the text while the dot stayed grey, which is why
      // the marker could not be recoloured at all.
      value: mapPinColor(pin, '#3a3a3a'),
      onChange: (color) => patchPin(pin.id, { color }),
    }),
    h(
      'div',
      { key: 'actions', style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h(MapButton, { label: '删除这个点', onClick: () => deletePinById(pin.id) }),
    ),
  ]

  /** The editor for ONE course, inside its row. */
  const pathEditor = (path) => [
    // NAMING, because a river with no name cannot be referred to in the prose, and a name that never
    // appears on the map is a private note rather than a map label.
    h(FieldLabel, { key: 'name-label', text: '名称' }),
    h('input', {
      key: 'name',
      type: 'text',
      style: { ...inputStyle, width: '100%' },
      placeholder: MAP_PATH_KINDS[path.kind]?.label ?? '路径',
      value: typeof path.name === 'string' ? path.name : '',
      onChange: (event) => updatePaths((list) => mapPathRename(list, path.id, event.target.value), 'path-name-' + path.id),
    }),
    h(FieldLabel, { key: 'width-label', text: '宽度' }),
    h(
      'div',
      { key: 'width', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      ...MAP_PATH_WIDTHS.map((width) =>
        h(MapButton, { key: width, label: String(width), active: path.width === width, onClick: () => updatePaths((list) => mapPathUpdate(list, path.id, { width })) }),
      ),
    ),
    h(FieldLabel, { key: 'taper-label', text: '沿线收窄（河流：源头细、入海口宽）' }),
    h(
      'div',
      { key: 'taper', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      ...[0, 0.5, 0.85, 1].map((taper) =>
        h(MapButton, {
          key: taper,
          label: taper === 0 ? '不变' : `${Math.round(taper * 100)}%`,
          active: path.taper === taper,
          title: taper === 0 ? '等宽，像道路' : `源头为入海口的 ${Math.round((1 - taper) * 100)}%`,
          onClick: () => updatePaths((list) => mapPathUpdate(list, path.id, { taper })),
        }),
      ),
    ),
    h(FieldLabel, { key: 'dash-label', text: '线型' }),
    h(
      'div',
      { key: 'dash', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      ...Object.keys(MAP_DASHES).map((dash) =>
        h(MapButton, {
          key: dash,
          label: dash === 'solid' ? '实线' : dash === 'dashed' ? '虚线' : '点线',
          active: path.dash === dash,
          onClick: () => updatePaths((list) => mapPathUpdate(list, path.id, { dash })),
        }),
      ),
    ),
    h(FieldLabel, { key: 'kind-label', text: '类型（换类型会采用该类型的样子）' }),
    h(
      'div',
      { key: 'kind', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      ...MAP_PATH_KIND_IDS.map((kind) =>
        h(MapButton, { key: kind, label: MAP_PATH_KINDS[kind].label, active: path.kind === kind, onClick: () => updatePaths((list) => mapPathUpdate(list, path.id, { kind })) }),
      ),
    ),
    h(FieldLabel, { key: 'color-label', text: '颜色' }),
    h(ColorPicker, { key: 'color', value: path.color, onChange: (color) => updatePaths((list) => mapPathUpdate(list, path.id, { color })) }),
    // FILL, WHICH THE SPRAY CAN SET AND ONLY THE SPRAY COULD CLEAR. Reported as "中间会自动喷漆" — the fill
    // was there and invisible, with no control to remove it. Now it is an editable property like any other.
    h(FieldLabel, { key: 'fill-label', text: '填充颜色' }),
    h(
      'div',
      { key: 'fill', style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
      h(ColorPicker, {
        value: mapFillOf(path.fill) ?? path.color,
        onChange: (fill) => updatePaths((list) => mapPathUpdate(list, path.id, { fill })),
      }),
      h(MapButton, {
        label: '不填充',
        active: mapFillOf(path.fill) === null,
        onClick: () => updatePaths((list) => mapPathUpdate(list, path.id, { fill: null })),
      }),
    ),
    mapFillAdvice('path', path.fill, path.points) === null
      ? null
      : h('div', { key: 'fill-advice', style: { fontSize: '11px', color: '#e5534b', marginTop: '4px', lineHeight: 1.7 } }, mapFillAdvice('path', path.fill, path.points)),
    h(
      'div',
      { key: 'actions', style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h(MapButton, {
        label: '删除最后一个路点',
        title: '删掉这条线路的最后一个路点；少于两个路点时整条删除',
        onClick: () => updatePaths((list) => mapPathRemovePoint(list, path.id, path.points.length - 1)),
      }),
      h(MapButton, {
        label: '反转方向',
        title: '调换源头与入海口，收窄方向随之反转',
        onClick: () => updatePaths((list) => list.map((entry) => (entry.id === path.id ? { ...entry, points: [...entry.points].reverse() } : entry))),
      }),
      h(MapButton, { label: '删除整条', onClick: () => {
        updatePaths((list) => mapPathRemove(list, path.id))
        if (editingPathId === path.id) setEditingPathId(null)
      } }),
    ),
  ]

  /** One item row: a header that opens the item's own editor, and that editor when it is open. */
  const itemRow = (key, dotColor, title, detail, open, onToggle, onDelete) =>
    h(
      'div',
      {
        key,
        // THE ANCHOR THE CANVAS JUMPS TO. A row is found by this attribute when something drawn on the map
        // has to open its own editor, so the panel and the canvas agree on one name per object.
        'data-item': key,
        style: { marginBottom: '6px', padding: '6px', border: `1px solid ${open ? 'currentColor' : muted}`, borderRadius: '4px' },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: { width: '12px', height: '12px', borderRadius: '50%', background: dotColor, flex: '0 0 auto' } }),
        h('span', { style: { flex: '1 1 auto', fontSize: '12px' } }, title),
        h(MapButton, { label: open ? '收起' : '编辑', onClick: onToggle }),
        onDelete === null ? null : h(MapButton, { label: '删除', onClick: onDelete }),
      ),
      // The editor is COLLAPSED by default and lives inside the row, so a map with twenty items stays
      // readable and each one is still individually editable.
      open ? h('div', { style: { marginTop: '6px' } }, ...detail.filter(Boolean)) : null,
    )

  const mapPanel = h(
    'div',
    null,
    h(DetailHeading, { title: '地图' }),
    h('div', { style: { fontSize: '12px', color: muted, marginBottom: '6px' } }, '每张地图有各自的范围、底图、笔迹与标记，一次只看一张。'),
    ...maps.map((entry) =>
      h(
        'div',
        { key: entry.id, style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' } },
        h(
          'button',
          {
            type: 'button',
            style: {
              ...buttonStyle,
              flex: '1 1 auto',
              textAlign: 'left',
              borderColor: entry.id === active?.id ? 'currentColor' : muted,
              background: entry.id === active?.id ? 'rgba(128,128,128,0.16)' : 'transparent',
            },
            onClick: () => selectMap(entry.id),
          },
          `${entry.id === active?.id ? '● ' : ''}${mapDisplayName(entry)}（${entry.strokes.length} 笔 · ${entry.pins.length} 点）`,
        ),
        h(MapButton, { label: '删除', title: `删除「${mapDisplayName(entry)}」`, onClick: () => removeMap(entry.id) }),
      ),
    ),
    h(
      'div',
      { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h(MapButton, { label: '新建地图', onClick: addMap }),
      h(MapButton, { label: '随机生成', title: '生成一张新的示例地图（不会覆盖已有地图）', onClick: generateMap }),
      pins.length > 0 ? h(MapButton, { label: `清空标记（${pins.length}）`, onClick: clearPins }) : null,
    ),
    // RENAMING IS AN INLINE FIELD, not a dialog. It used to call `window.prompt`, which ELECTRON DOES
    // NOT IMPLEMENT: the button appeared to do nothing at all, because the call returned without ever
    // showing a box. Reported exactly that way — "重命名按钮无用,点上去没有反应".
    active === null
      ? null
      : h(
          'div',
          { style: { marginTop: '8px' } },
          h(FieldLabel, { text: '地图名称' }),
          h('input', {
            type: 'text',
            style: { ...inputStyle, width: '100%' },
            value: active.name,
            placeholder: '给这张地图起个名字',
            onChange: (event) => updateMaps((list) => mapRenameMap(list, active.id, event.target.value), `map-name-${active.id}`),
          }),
        ),
    active === null
      ? null
      : h(
          'div',
          { style: { marginTop: '12px' } },
          // 配色主题. It repaints the PAPER, the grid and the frame, and supplies the ink for anything with no
          // colour of its own — never the colour the author chose. That is what makes a theme safe to try and
          // safe to remove.
          h(DetailHeading, { title: '配色主题' }),
          h(
            'div',
            { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } },
            ...MAP_THEME_IDS.map((id) =>
              h(MapButton, {
                key: id,
                label: MAP_THEMES[id].label,
                active: mapThemeId(active) === id,
                title: `${MAP_THEMES[id].label}：纸色 ${MAP_THEMES[id].paper}`,
                onClick: () => setTheme(id),
              }),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } },
            h('span', { style: { width: '34px', height: '20px', background: mapTheme(active).paper, border: `1px solid ${mapTheme(active).edge}`, display: 'inline-block' } }),
            h('span', { style: { width: '34px', height: '20px', background: mapTheme(active).ink, display: 'inline-block' } }),
            h('span', { style: { fontSize: '11px', color: muted, lineHeight: 1.6 } }, '纸色与墨色。主题只改纸、网格和边框，以及「没有自己颜色」的文字；你画过的颜色一律不动。'),
          ),
          h(DetailHeading, { title: '标记大小' }),
          h(
            'div',
            { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } },
            ...MAP_PIN_SIZES.map((size) =>
              h(MapButton, {
                key: size,
                label: String(size),
                active: active.pinSize === size,
                title: `标记直径 ${size}`,
                onClick: () => updateMaps((list) => list.map((entry) => (entry.id === active.id ? { ...entry, pinSize: size } : entry))),
              }),
            ),
            h('span', { style: { fontSize: '12px', color: muted } }, '（也可在单个标记里覆盖）'),
          ),
          h(DetailHeading, { title: '标点名称' }),
          h(
            'div',
            { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } },
            ...MAP_LABEL_SIZES.map((size) =>
              h(MapButton, {
                key: size,
                label: String(size),
                active: active.labelSize === size,
                title: `名称大小 ${size}`,
                onClick: () => updateMaps((list) => mapSetLabelSize(list, active.id, size)),
              }),
            ),
            h(MapButton, { label: '＋', title: '更大一号', onClick: () => updateMaps((list) => mapSetLabelSize(list, active.id, Math.min(400, active.labelSize + 8))) }),
            h(MapButton, { label: '－', title: '更小一号', onClick: () => updateMaps((list) => mapSetLabelSize(list, active.id, Math.max(8, active.labelSize - 8))) }),
          ),
          h(
            'div',
            { style: { marginTop: '6px', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
            h(MapButton, {
              label: active.labelFixed ? '固定像素' : '随地图缩放',
              title: '「随地图缩放」让名称与笔迹一起放大缩小；「固定像素」让它在任何缩放下都一样大',
              onClick: () => updateMaps((list) => mapSetLabelFixed(list, active.id, !active.labelFixed)),
            }),
            h('span', { style: { fontSize: '12px', color: muted } }, active.labelFixed ? '名称在任何缩放下都一样大' : '名称与笔迹一起缩放'),
          ),
        ),
  )

  const main = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '12px' } },
    // The save control, in the same shape every other branch uses.
    h(CommitRow, {
      label: `${MAP_DOC}${active === null ? '' : ` · ${mapDisplayName(active)}`}`,
      status: { dirty: map.state.dirty, saving: map.state.saving, savedAt: map.state.savedAt },
      actions: { save: map.save, revert: map.reload },
      detailOpen,
      onToggleDetail: () => setDetailOpen((open) => !open),
    }),
    toolbar,
    h(
      'div',
      {
        // The positioning context for the absolutely-filled SVG. No ref here: `MapSurface` measures
        // its own SVG, because a wrapper of a different size would shift every coordinate.
        style: { position: 'relative', flex: '1 1 auto', minHeight: '240px', overflow: 'hidden', border: `1px solid ${muted}` },
      },
      h(MapSurface, {
        root,
        map: active,
        view: box,
        mode,
        draft,
        draftColor: penColor,
        penWidth,
        draftShape,
        selectedShapeId,
        // What the 光标 tool has picked, so its outline can be drawn around it.
        cursorTarget,
        selectionId,
        svgRef: surface,
        started,
        // Which path's waypoints to show. A finished map therefore stays clean.
        editingPathId,
        // id → name for the 地点 a pin is linked to, so an unlabelled pin shows a real name.
        placeTitles,
        labelOf,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onLostPointerCapture,
        onPointerLeave,
        onWheel,
        onDoubleClick,
      }),
    ),
    h(
      'div',
      { style: { flex: '0 0 auto', marginTop: '8px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
      h('span', { style: { color: muted, fontSize: '12px' } }, `${strokes.length} 笔 · ${paths.length} 条地形 · ${shapes.length} 个图形 · ${pins.length} 个地点 · ${maps.length} 张地图`),
      // Refusals and advisories from the last write. The props are `{error, issues, warnings}`.
      h(WriteFeedback, { error: map.state.error, issues: map.state.issues, warnings: map.warnings }),
      eraseNote === null ? null : h('span', { style: { color: muted, fontSize: '12px' } }, eraseNote),
      sprayNote === null ? null : h('span', { style: { color: muted, fontSize: '12px' } }, sprayNote),
      layout.state.dirty ? h('span', { style: { color: muted, fontSize: '12px' } }, '视图位置待保存') : null,
    ),
  )

  /**
   * The panel: 地图 as the top level, then one branch per KIND, and each item with its own editor.
   *
   * REQUESTED: "地图为一级目录,下设分支为标记点/河流/道路/边界等,每一个...应该有单独的编辑界面(可隐藏)".
   * It was a flat list — every marker and every course in one column — with a SECOND panel appearing
   * elsewhere when something was selected. A dozen courses made it unreadable, and neither branch could be
   * put away. Now each kind is a branch, and each item's editor lives inside that item and collapses.
   */
  /**
   * The panel: 地图 as the top level, its OWN branches nested inside it, and a branch only once it has
   * something in it.
   *
   * REQUESTED: "河流/标记点/道路/边界应该为地图的下级分支... 新建地图后,呈现区为空白画布,右边栏只能对地图
   * 名称和一些全局设定进行编辑,没有河流/标记点/道路/边界;当用户在画布上打点后,右边栏出现标记点目录... 河流道路/
   * 边界同理".
   *
   * So a NEW map shows its name and the global settings and nothing else. Placing the first marker makes
   * the 标记点 branch appear. An empty branch is not shown at all — four empty headings are noise, and
   * they imply there is something to configure when there is not.
   */
  /** The editor for ONE shape. */
  const shapeEditor = (shape) => [
    h(FieldLabel, { key: 'stroke-label', text: '描边颜色' }),
    h(ColorPicker, { key: 'stroke', value: shape.color, onChange: (color) => updateShapes((list) => list.map((entry) => (entry.id === shape.id ? { ...entry, color } : entry))) }),
    h(FieldLabel, { key: 'fill-label', text: '填充颜色' }),
    h(
      'div',
      { key: 'fill', style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
      h(ColorPicker, { value: shape.fill ?? '#4a7fd0', onChange: (fill) => updateShapes((list) => list.map((entry) => (entry.id === shape.id ? { ...entry, fill } : entry))) }),
      h(MapButton, { label: '不填充', active: shape.fill === null, onClick: () => updateShapes((list) => list.map((entry) => (entry.id === shape.id ? { ...entry, fill: null } : entry))) }),
    ),
    h(FieldLabel, { key: 'width-label', text: '描边粗细' }),
    h(
      'div',
      { key: 'width', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      ...MAP_PEN_WIDTHS.map((width) =>
        h(MapButton, { key: width, label: String(width), active: shape.width === width, onClick: () => updateShapes((list) => list.map((entry) => (entry.id === shape.id ? { ...entry, width } : entry))) }),
      ),
    ),
    h(FieldLabel, { key: 'size-label', text: '大小与位置' }),
    h(
      'div',
      { key: 'size', style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
      h('span', { style: { fontSize: '12px', color: muted } }, '宽'),
      h('input', { type: 'number', style: { ...inputStyle, width: '70px' }, value: shape.w, onChange: (event) => resizeShape(shape, { w: Number(event.target.value) }) }),
      h('span', { style: { fontSize: '12px', color: muted } }, '高'),
      h('input', { type: 'number', style: { ...inputStyle, width: '70px' }, value: shape.h, onChange: (event) => resizeShape(shape, { h: Number(event.target.value) }) }),
      h('span', { style: { fontSize: '12px', color: muted } }, 'x'),
      h('input', { type: 'number', style: { ...inputStyle, width: '70px' }, value: shape.x, onChange: (event) => resizeShape(shape, { x: Number(event.target.value) }) }),
      h('span', { style: { fontSize: '12px', color: muted } }, 'y'),
      h('input', { type: 'number', style: { ...inputStyle, width: '70px' }, value: shape.y, onChange: (event) => resizeShape(shape, { y: Number(event.target.value) }) }),
    ),
    h(
      'div',
      { key: 'actions', style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h(MapButton, { label: '删除这个图形', onClick: () => {
        updateShapes((list) => list.filter((entry) => entry.id !== shape.id))
        if (selectedShapeId === shape.id) setSelectedShapeId(null)
      } }),
    ),
  ]

  /** A free text label's own settings. */
  const textEditor = (text) => [
    h(FieldLabel, { key: 'content-label', text: '文字内容' }),
    h('input', {
      key: 'content',
      type: 'text',
      value: text.text,
      placeholder: '在这张地图上写点什么',
      style: inputStyle,
      onChange: (event) => updateTexts((list) => list.map((entry) => (entry.id === text.id ? { ...entry, text: event.target.value } : entry))),
    }),
    h(FieldLabel, { key: 'size-label', text: '字号' }),
    h(
      'div',
      { key: 'size', style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } },
      ...MAP_TEXT_SIZES.map((size) =>
        h(MapButton, { key: size, label: String(size), active: mapTextSize(text) === size, onClick: () => updateTexts((list) => list.map((entry) => (entry.id === text.id ? { ...entry, size } : entry))) }),
      ),
      h(MapButton, { label: '粗', active: text.bold === true, onClick: () => updateTexts((list) => list.map((entry) => (entry.id === text.id ? { ...entry, bold: !entry.bold } : entry))) }),
    ),
    h(FieldLabel, { key: 'color-label', text: '颜色' }),
    h(
      'div',
      { key: 'color', style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
      h(ColorPicker, { value: mapTextColor(text), onChange: (color) => updateTexts((list) => list.map((entry) => (entry.id === text.id ? { ...entry, color } : entry))) }),
      h(MapButton, { label: '跟随主题', active: text.color === null, onClick: () => updateTexts((list) => list.map((entry) => (entry.id === text.id ? { ...entry, color: null } : entry))) }),
    ),
    h(FieldLabel, { key: 'position-label', text: '位置' }),
    h(
      'div',
      { key: 'position', style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
      h('span', { style: { fontSize: '12px', color: muted } }, 'x'),
      h('input', { type: 'number', style: { ...inputStyle, width: '70px' }, value: text.x, onChange: (event) => updateTexts((list) => list.map((entry) => (entry.id === text.id ? { ...entry, x: Number(event.target.value) || 0 } : entry))) }),
      h('span', { style: { fontSize: '12px', color: muted } }, 'y'),
      h('input', { type: 'number', style: { ...inputStyle, width: '70px' }, value: text.y, onChange: (event) => updateTexts((list) => list.map((entry) => (entry.id === text.id ? { ...entry, y: Number(event.target.value) || 0 } : entry))) }),
    ),
    h(
      'div',
      { key: 'actions', style: { marginTop: '8px' } },
      h(MapButton, { label: '删除这条文字', onClick: () => {
        updateTexts((list) => list.filter((entry) => entry.id !== text.id))
        if (cursorTarget?.kind === 'text' && cursorTarget.id === text.id) setCursorTarget(null)
      } }),
    ),
  ]

  /** A stamp's own settings, including which glyph it is. */
  const stampEditor = (stamp) => [
    h(FieldLabel, { key: 'symbol-label', text: '符号' }),
    h(
      'div',
      { key: 'symbol', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      ...MAP_SYMBOL_IDS.map((symbol) =>
        h(MapButton, { key: symbol, label: MAP_SYMBOLS[symbol].label, active: stamp.symbol === symbol, onClick: () => updateStamps((list) => list.map((entry) => (entry.id === stamp.id ? { ...entry, symbol } : entry))) }),
      ),
    ),
    h(FieldLabel, { key: 'size-label', text: '大小' }),
    h(
      'div',
      { key: 'size', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      ...MAP_STAMP_SIZES.map((size) =>
        h(MapButton, { key: size, label: String(size), active: mapStampSize(stamp) === size, onClick: () => updateStamps((list) => list.map((entry) => (entry.id === stamp.id ? { ...entry, size } : entry))) }),
      ),
    ),
    h(FieldLabel, { key: 'color-label', text: '颜色' }),
    h(
      'div',
      { key: 'color', style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
      h(ColorPicker, { value: mapStampColor(stamp), onChange: (color) => updateStamps((list) => list.map((entry) => (entry.id === stamp.id ? { ...entry, color } : entry))) }),
      h(MapButton, { label: '默认', active: stamp.color === null, onClick: () => updateStamps((list) => list.map((entry) => (entry.id === stamp.id ? { ...entry, color: null } : entry))) }),
    ),
    h(FieldLabel, { key: 'position-label', text: '位置' }),
    h(
      'div',
      { key: 'position', style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
      h('span', { style: { fontSize: '12px', color: muted } }, 'x'),
      h('input', { type: 'number', style: { ...inputStyle, width: '70px' }, value: stamp.x, onChange: (event) => updateStamps((list) => list.map((entry) => (entry.id === stamp.id ? { ...entry, x: Number(event.target.value) || 0 } : entry))) }),
      h('span', { style: { fontSize: '12px', color: muted } }, 'y'),
      h('input', { type: 'number', style: { ...inputStyle, width: '70px' }, value: stamp.y, onChange: (event) => updateStamps((list) => list.map((entry) => (entry.id === stamp.id ? { ...entry, y: Number(event.target.value) || 0 } : entry))) }),
    ),
    h(
      'div',
      { key: 'actions', style: { marginTop: '8px' } },
      h(MapButton, { label: '删除这个图章', onClick: () => {
        updateStamps((list) => list.filter((entry) => entry.id !== stamp.id))
        if (cursorTarget?.kind === 'stamp' && cursorTarget.id === stamp.id) setCursorTarget(null)
      } }),
    ),
  ]

  /**
   * A freehand stroke's own settings.
   *
   * REQUESTED: "输入任何笔迹后右边栏应该自动跳转到对应编辑页面". A stroke had NO editor in the panel at all —
   * every other kind had one — so this is what the jump lands on. Strokes carry no id, so they are addressed
   * by index, which is also why deleting one renumbers the ones after it.
   */
  const strokeEditor = (stroke, index) => [
    h(FieldLabel, { key: 'color-label', text: '笔迹颜色' }),
    h(ColorPicker, {
      key: 'color',
      value: mapStrokeColor(stroke),
      onChange: (color) => updateStrokes((list) => list.map((entry, at) => (at === index ? { ...entry, color } : entry))),
    }),
    h(FieldLabel, { key: 'width-label', text: '笔迹粗细' }),
    h(
      'div',
      { key: 'width', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      ...MAP_PEN_WIDTHS.map((width) =>
        h(MapButton, {
          key: width,
          label: String(width),
          active: mapStrokeWidth(stroke) === width,
          onClick: () => updateStrokes((list) => list.map((entry, at) => (at === index ? { ...entry, width } : entry))),
        }),
      ),
    ),
    h(FieldLabel, { key: 'fill-label', text: '填充颜色' }),
    h(
      'div',
      { key: 'fill', style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } },
      h(ColorPicker, {
        value: stroke.fill ?? '#4a7fd0',
        onChange: (fill) => updateStrokes((list) => list.map((entry, at) => (at === index ? { ...entry, fill } : entry))),
      }),
      h(MapButton, {
        label: '不填充',
        active: stroke.fill === null || stroke.fill === undefined,
        onClick: () => updateStrokes((list) => list.map((entry, at) => (at === index ? { ...entry, fill: null } : entry))),
      }),
    ),
    // AN OPEN OUTLINE WITH A FILL PAINTS NOTHING, and saying so is the only way to tell it apart from a
    // colour that did not take.
    mapFillAdvice('stroke', stroke.fill, stroke.points) === null
      ? null
      : h('div', { key: 'fill-advice', style: { fontSize: '11px', color: '#e5534b', marginTop: '4px', lineHeight: 1.7 } }, mapFillAdvice('stroke', stroke.fill, stroke.points)),
    h(
      'div',
      { key: 'meta', style: { fontSize: '11px', color: muted, marginTop: '6px' } },
      `${objectList(stroke.points).length} 个点`,
    ),
    h(
      'div',
      { key: 'actions', style: { marginTop: '8px' } },
      h(MapButton, {
        label: '删除这笔画迹',
        onClick: () => {
          updateStrokes((list) => list.filter((_, at) => at !== index))
          if (selectedStrokeIndex === index) setSelectedStrokeIndex(null)
        },
      }),
    ),
  ]

  const kindBranches = [
    {
      key: 'strokes',
      title: '笔迹',
      count: strokes.length,
      body: strokes.map((stroke, index) =>
        itemRow(
          `stroke-${index}`,
          mapStrokeColor(stroke),
          `笔迹 ${index + 1} · ${objectList(stroke.points).length} 个点`,
          strokeEditor(stroke, index),
          selectedStrokeIndex === index,
          () => setSelectedStrokeIndex(selectedStrokeIndex === index ? null : index),
          null,
        ),
      ),
    },
    {
      key: 'texts',
      title: '文字',
      count: texts.length,
      body: texts.map((text) =>
        itemRow(
          text.id,
          mapTextColor(text),
          text.text === '' ? '（还没输入内容）' : text.text,
          textEditor(text),
          cursorTarget?.kind === 'text' && cursorTarget.id === text.id,
          () => {
            const chosen = cursorTarget?.kind === 'text' && cursorTarget.id === text.id
            setCursorTarget(chosen ? null : { kind: 'text', id: text.id })
            setSelectionId(null)
            setSelectedShapeId(null)
          },
          null,
        ),
      ),
    },
    {
      key: 'stamps',
      title: '图章',
      count: stamps.length,
      body: stamps.map((stamp) =>
        itemRow(
          stamp.id,
          mapStampColor(stamp),
          `${MAP_SYMBOLS[stamp.symbol]?.label ?? stamp.symbol} · ${mapStampSize(stamp)}`,
          stampEditor(stamp),
          cursorTarget?.kind === 'stamp' && cursorTarget.id === stamp.id,
          () => {
            const chosen = cursorTarget?.kind === 'stamp' && cursorTarget.id === stamp.id
            setCursorTarget(chosen ? null : { kind: 'stamp', id: stamp.id })
            setSelectionId(null)
            setSelectedShapeId(null)
          },
          null,
        ),
      ),
    },
    {
      key: 'shapes',
      title: '图形',
      count: shapes.length,
      body: shapes.map((shape) =>
        itemRow(
          shape.id,
          shape.fill ?? shape.color,
          (MAP_SHAPE_KINDS[shape.kind]?.label ?? '图形') + ' · ' + shape.w + '×' + shape.h,
          shapeEditor(shape),
          selectedShapeId === shape.id,
          () => {
            setSelectedShapeId(selectedShapeId === shape.id ? null : shape.id)
            setSelectionId(null)
            setEditingPathId(null)
          },
          null,
        ),
      ),
    },
    {
      key: 'pins',
      title: '标记点',
      count: pins.length,
      body: pins.map((pin) =>
        itemRow(
          pin.id,
          mapPinColor(pin, '#8a8a8a'),
          labelOf(pin),
          pinEditor(pin),
          selectionId === pin.id,
          () => {
            setSelectionId(selectionId === pin.id ? null : pin.id)
            setEditingPathId(null)
          },
          () => deletePinById(pin.id),
        ),
      ),
    },
    ...MAP_PATH_KIND_IDS.map((kind) => {
      const ofKind = paths.filter((path) => path.kind === kind)
      return {
        key: kind,
        title: MAP_PATH_KINDS[kind].label,
        count: ofKind.length,
        body: ofKind.map((path) =>
          itemRow(
            path.id,
            path.color,
            mapPathTitle(path),
            pathEditor(path),
            editingPathId === path.id,
            () => {
              setEditingPathId(editingPathId === path.id ? null : path.id)
              setSelectionId(null)
            },
            null,
          ),
        ),
      }
    }),
  ].filter((branch) => branch.count > 0)

  const sections = [
    // 地图 is the parent, so its children render INSIDE it — and indented, so the nesting is visible
    // rather than merely implied by the order of the headings.
    {
      key: 'maps',
      title: '地图',
      count: maps.length,
      body: [
        mapPanel,
        h(
          'div',
          { style: { marginLeft: '10px', borderLeft: `2px solid ${muted}`, paddingLeft: '8px' } },
          kindBranches.length === 0
            ? h(
                'div',
                { key: 'blank', style: { fontSize: '12px', color: muted, marginTop: '8px' } },
                '这张地图还是空白的。切到「打点」「地形」「图形」「手绘」后在地图上动手，对应的目录就会出现在这里。',
              )
            : kindBranches.map((branch) =>
                h(
                  MapGroup,
                  {
                    key: branch.key,
                    title: branch.title,
                    count: branch.count,
                    open: groupOpen(branch.key),
                    onToggle: () => toggleGroup(branch.key),
                  },
                  branch.body,
                ),
              ),
        ),
      ],
    },
  ]

  const detail = h(
    'div',
    { style: { padding: '12px' } },
    // What the current mode does, so the panel explains the canvas rather than only listing it.
    h(Note, {
      text:
        mode === 'draw'
          ? '按住左键手绘，颜色和粗细取工具栏的画笔。'
          : mode === 'pin'
            ? '点击空白处新增地点标记，拖动标记可移动；点名称也能打开它。'
            : mode === 'erase'
              ? '橡皮：点或拖过标记、河流、道路、山脉、笔迹，就会擦掉它。'
              : mode === 'cursor'
                ? cursorTarget === null
                  ? '光标：点画布上的标记点、文字、图章、笔迹、图形、地形选中它，按住拖动即可移动位置；双击打开它的编辑页面。'
                  : `光标：已选中${mapTargetName(active, cursorTarget)}，拖动可移动；点空白处取消选择。`
                : mode === 'text'
                  ? '文字：点画布上任意位置放一段自由文字，然后到右侧「文字」里输入内容。'
                  : mode === 'stamp'
                    ? '图章：先在上面选一个符号，再点画布上任意位置盖下去。'
                    : mode === 'path'
                ? '点一下起点，再点着走；拖动路点改形状，按「完成」结束。'
                : '拖动平移，滚轮在光标处缩放。',
    }),
    ...sections.map((section) =>
      h(
        MapGroup,
        {
          key: section.key,
          title: section.title,
          count: section.count,
          open: groupOpen(section.key),
          onToggle: () => toggleGroup(section.key),
        },
        section.body,
      ),
    ),
  )
  return h(SplitPane, { main, detail, open: detailOpen })
}
