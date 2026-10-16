/**
 * Schema constants and empty-document factories.
 *
 * Dependency-free on purpose: every `lib/impl/*.js` module is loaded through a
 * cache-busting loader (see `lib/index.js`), so a module that statically
 * imports a sibling would drag that sibling along uncached and defeat the whole
 * hot-reload arrangement. Wiring happens in `router.js`; everything else is
 * pure and receives what it needs as arguments.
 */

export const SCHEMA_VERSION = 1

/** Every document lives under this directory, inside the user-chosen root. */
export const DATA_DIR = 'novel'

/** Project-relative document paths — the single place these names are spelled. */
export const FILES = {
  project: 'project.json',
  relations: 'relations.json',
  world: 'setting/world.json',
  places: 'setting/places.json',
  characters: 'setting/characters.json',
  organizations: 'setting/organizations.json',
  items: 'setting/items.json',
  map: 'setting/map/index.json',
  timeline: 'outline/timeline.json',
  outline: 'outline/outline.json',
  layout: 'views/layout.json',
}

/** Directories to create. `draft/` holds the chapter markdown files. */
export const DIRS = ['setting/map/assets', 'outline', 'draft', 'views']

/**
 * Relation types a new project starts with. `excludes` declares mutual
 * exclusion so the rule is data-driven (see docs/data-model.md §4.8).
 */
export const DEFAULT_RELATION_TYPES = [
  { id: 'master-apprentice', label: '师徒', directed: true, color: '#4a8', excludes: [] },
  { id: 'parent-child', label: '亲缘', directed: false, color: null, excludes: [] },
  { id: 'ally', label: '同盟', directed: false, color: null, excludes: ['hostile'] },
  { id: 'hostile', label: '敌对', directed: false, color: null, excludes: ['ally'] },
  { id: 'member-of', label: '隶属', directed: true, color: null, excludes: [] },
  { id: 'owns', label: '持有', directed: true, color: null, excludes: [] },
]

/** The default timeline id, referenced by `project.json`. */
export const DEFAULT_TIMELINE_ID = 'tl-main'

/**
 * The calendar a new project starts with.
 *
 * Written at creation, not left optional: character ages are derived from
 * `born` against this calendar (docs/data-model.md §6.2), so without it age
 * cannot be computed at all.
 */
export function defaultCalendar() {
  return {
    epochLabel: '元年',
    start: { year: 1, month: 1, day: 1 },
    end: { year: 1000, month: 12, day: 31 },
  }
}

/** A fresh project id derived from the title, stable once written. */
export function projectIdFor(title, fallback = 'untitled') {
  const base = String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return `proj-${base === '' ? fallback : base}`
}

/**
 * Every document a new project starts with, keyed by project-relative path.
 * Empty but *valid*, so the UI never has to special-case a missing file.
 */
export function emptyDocuments({ title, now }) {
  const stamp = now ?? new Date().toISOString()
  return {
    [FILES.project]: {
      schemaVersion: SCHEMA_VERSION,
      id: projectIdFor(title),
      title: String(title ?? '').trim(),
      author: '',
      createdAt: stamp,
      updatedAt: stamp,
      defaultTimelineId: DEFAULT_TIMELINE_ID,
      settings: { wordCountGoal: 0 },
    },
    [FILES.relations]: {
      types: DEFAULT_RELATION_TYPES.map((type) => ({ ...type })),
      edges: [],
    },
    [FILES.world]: { sections: [], rules: [] },
    [FILES.places]: { places: [] },
    [FILES.characters]: { characters: [] },
    [FILES.organizations]: { organizations: [] },
    [FILES.items]: { categories: [], items: [] },
    // A LIST of maps, shown one at a time. Layers were the first model and the wrong one:
    // different maps are different places, not stacked sheets over one shared canvas.
    [FILES.map]: {
      version: 2,
      activeMapId: 'map-1',
      maps: [
        {
          id: 'map-1',
          name: '地图 1',
          canvas: { width: 2000, height: 1500 },
          background: { kind: 'blank', asset: null },
          strokes: [],
          shapes: [],
          paths: [],
          pins: [],
          texts: [],
          stamps: [],
          theme: 'plain',
          labelSize: 34,
          labelFixed: false,
        },
      ],
    },
    [FILES.timeline]: {
      calendar: defaultCalendar(),
      lines: [{ id: DEFAULT_TIMELINE_ID, name: '主线', kind: 'main', order: 0 }],
      events: [],
    },
    [FILES.outline]: { nodes: [] },
    [FILES.layout]: { graphs: {}, mapView: { centerX: 0, centerY: 0, zoom: 1 } },
  }
}

/** Documents that are JSON rather than Markdown, for the reader/writer branch. */
export const JSON_DOCUMENTS = new Set(Object.values(FILES))

/** Whether a project-relative path is a chapter markdown file. */
export function isChapterPath(relPath) {
  return /^draft\/.+\.md$/i.test(relPath)
}
