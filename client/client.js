/**
 * GENERATED FILE — do not edit.
 *
 * Built from client/src/*.js by tools/build-client.mjs; edit those parts and
 * re-run the build. Hand edits here are lost on the next build.
 *
 * Loaded by the host's client module system: running this script only registers
 * the factory below, and its module body runs at first materialization. The
 * platform module table supplies `require` values, so `react` is the host's own
 * copy rather than a second one.
 */
window.__ModuleLoader__.load({
  id: 'dsh-novelsupport',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement

      // ==== 10-core.js ========================================================
/**
 * Core: host access, shared project selection, small presentational atoms.
 *
 * A "part" is a fragment of the client factory body, concatenated by
 * tools/build-client.mjs into one closure. Order is by filename, and top-level
 * bindings are shared across parts — there are no imports and no module
 * boundaries to respect, only `const` initialisation order.
 */

// ---------------------------------------------------------------------------
// Host access
// ---------------------------------------------------------------------------

const API = '/dsh-novel'
const WRITE_HEADERS = { 'x-dsh-novel': '1', 'content-type': 'application/json; charset=utf-8' }

/**
 * Resolve a host route against the directory the UI is served from, not the
 * origin — a bare `/dsh-novel/...` resolves against the ORIGIN, so behind a
 * reverse proxy that mounts dsh under a prefix every call would 404.
 *
 * `pathname + search`, NOT `pathname` alone. Dropping the query silently strips
 * every parameter: `/document?root=…&path=…` arrives as `/document`, and the
 * host answers "root is required" for a request the caller believes it filled
 * in. Query-less routes keep working, which is what made this so quiet.
 */
function api(path) {
  const relative = String(path).replace(/^\/+/, '')
  if (typeof document === 'undefined') return `/${relative}`
  try {
    const url = new URL(relative, document.baseURI)
    return `${url.pathname}${url.search}`
  } catch {
    return `/${relative}`
  }
}

// ---------------------------------------------------------------------------
// Guarding shapes
//
// The code guarded CONTAINERS consistently (`Array.isArray(doc.lines)`) and ELEMENTS
// almost never. That is a whole class of blank panel: any project file with a `null`
// or a string inside a list takes the view down, and hand-editing a file is a normal
// thing for an author to do. Both halves must be checked — these are the element half.
// ---------------------------------------------------------------------------

/** Is this a usable object element? */
function isRecord(value) {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A list of usable object elements, tolerating a non-array AND junk entries.
 *
 * Use this wherever a document list is read. `Array.isArray(x) ? x : []` is only half
 * the guard: `{"categories":[null]}`, `{"events":[null]}`, `{"edges":[null]}`,
 * `{"types":[null]}`, `{"sections":[null]}` and `{"structure":[null]}` all pass the
 * container check and then crash on the element.
 */
function objectList(value) {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/**
 * Every usable object value of a free-form map.
 *
 * For maps keyed by id — `relations.graphs`, a `layout.json` positions bag — where the
 * keys are data and the values are what get read.
 */
function objectValues(value) {
  return isRecord(value) ? Object.values(value).filter(isRecord) : []
}

/** Absent, either way. A 200 response may omit `value` entirely rather than null it. */
function isMissing(value) {
  return value === null || value === undefined
}

/**
 * Does this validator finding belong to the document at `relPath`?
 *
 * The validator marks a finding two ways: plain `setting/world.json` for the document as a whole, and
 * `setting/characters.json#char-1` for one entity inside it (validate.js:634 and friends). Comparing
 * `issue.path === relPath` therefore matched only the first kind, and every ENTITY-level warning was
 * dropped in silence — including the one the call site names in its own comment, an open relation to a
 * dead character. A save that reported "1 warning" showed none of them.
 */
function issueBelongsTo(issue, relPath) {
  const path = issue?.path
  return typeof path === 'string' && (path === relPath || path.startsWith(`${relPath}#`))
}

// ---------------------------------------------------------------------------
// Shared project selection
//
// Module scope on purpose: the seven branch panels are separate component
// instances, and the selection must not reset when the user switches branches.
// localStorage makes it survive a reload too.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'dsh-novel.projectRoot'

/**
 * "No project selected", in every form it can arrive.
 *
 * A single predicate because the alternative — `=== null` scattered across
 * guards — is what produced a `root is required` error from the host: an empty
 * string from localStorage is not `null`, so it slipped past every guard and was
 * sent as `?root=`. `??` does not catch it either, since `''` is not nullish.
 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

const projectStore = {
  root: null,
  listeners: new Set(),
  load() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      projectStore.root = isBlank(stored) ? null : stored
    } catch {
      projectStore.root = null
    }
    return projectStore.root
  },
  set(root) {
    // Normalise on the way in, so a blank value can never be persisted and then
    // come back on the next reload as a third state.
    const next = isBlank(root) ? null : root
    projectStore.root = next
    try {
      if (next === null) window.localStorage.removeItem(STORAGE_KEY)
      else window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* private mode or a hostile origin: selection stays in memory only */
    }
    for (const listener of projectStore.listeners) listener()
  },
  subscribe(listener) {
    projectStore.listeners.add(listener)
    return () => projectStore.listeners.delete(listener)
  },
}
projectStore.load()

function useProjectRoot() {
  const [root, setRootState] = react.useState(projectStore.root)
  react.useEffect(() => projectStore.subscribe(() => setRootState(projectStore.root)), [])
  return [root, projectStore.set]
}

// ---------------------------------------------------------------------------
// Fetch hooks
// ---------------------------------------------------------------------------

/** GET a host route, re-fetching when `path` changes or `reload()` is called. */
function useEndpoint(path) {
  const [state, setState] = react.useState({ loading: true, error: null, code: null, data: null })
  const [nonce, setNonce] = react.useState(0)
  react.useEffect(() => {
    if (path === null) {
      setState({ loading: false, error: null, code: null, data: null })
      return undefined
    }
    let live = true
    setState((previous) => ({ loading: true, error: null, code: null, data: previous.data }))
    fetch(api(path))
      .then(async (response) => {
        const text = await response.text()
        let body = null
        try {
          body = JSON.parse(text)
        } catch {
          /* keep null; the error path reports the raw text */
        }
        if (!live) return
        if (!response.ok) {
          setState({
            loading: false,
            // The machine-readable code is kept alongside the message, so a
            // caller can turn a known state into guidance rather than showing
            // the user a raw error string.
            code: body?.code ?? null,
            error: `${response.status} ${body?.error ?? text.slice(0, 200)}`,
            data: null,
          })
        } else {
          setState({ loading: false, error: null, code: null, data: body })
        }
      })
      .catch((error) => {
        if (live) setState({ loading: false, code: null, error: String(error?.message ?? error), data: null })
      })
    return () => {
      live = false
    }
  }, [path, nonce])
  return [state, () => setNonce((n) => n + 1)]
}

/**
 * Load a project document into editable state, and write it back.
 *
 * Kept separate from `useEndpoint` because a document is *edited*: the caller
 * mutates a working copy, sees whether it is dirty, and saves explicitly. An
 * implicit save-on-change would put a write on every keystroke.
 */
function useDocument(root, relPath) {
  const [state, setState] = react.useState({
    loading: true, error: null, code: null, value: null, dirty: false, saving: false, issues: null, savedAt: null,
  })
  const [nonce, setNonce] = react.useState(0)
  // Advisory findings from the last write, kept apart from `issues` (which is what
  // blocked it) and cleared on reload so a stale warning cannot outlive its fix.
  const [warnings, setWarnings] = react.useState([])

  react.useEffect(() => {
    setWarnings([])
    if (isBlank(root) || isBlank(relPath)) {
      setState({ loading: false, error: null, code: null, value: null, dirty: false, saving: false, issues: null, savedAt: null })
      return undefined
    }
    let live = true
    setState((previous) => ({ ...previous, loading: true, error: null, code: null }))
    fetch(api(`${API}/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!live) return
        if (!response.ok) {
          setState({ loading: false, error: body?.error ?? `HTTP ${response.status}`, code: body?.code ?? null, value: null, dirty: false, saving: false, issues: null, savedAt: null })
        } else {
          setState({ loading: false, error: null, code: null, value: body.value, dirty: false, saving: false, issues: null, savedAt: null })
        }
      })
      .catch((error) => {
        if (live) setState({ loading: false, error: String(error?.message ?? error), code: null, value: null, dirty: false, saving: false, issues: null, savedAt: null })
      })
    return () => {
      live = false
    }
  }, [root, relPath, nonce])

  /** Apply a pure transform to the working copy and mark it dirty. */
  const update = react.useCallback((mutator) => {
    setState((previous) => {
      if (previous.value === null) return previous
      try {
        return { ...previous, value: mutator(previous.value), dirty: true, issues: null }
      } catch (error) {
        return { ...previous, error: String(error?.message ?? error) }
      }
    })
  }, [])

  const save = react.useCallback(() => {
    setState((previous) => {
      if (previous.value === null || previous.saving) return previous
      const body = JSON.stringify({ root, path: relPath, value: previous.value })
      fetch(api(`${API}/document`), { method: 'POST', headers: WRITE_HEADERS, body })
        .then(async (response) => {
          const result = await response.json().catch(() => null)
          setState((current) => {
            if (!response.ok) {
              return { ...current, saving: false, code: result?.code ?? null, error: result?.error ?? `HTTP ${response.status}`, issues: result?.issues ?? null }
            }
            return { ...current, saving: false, dirty: false, error: null, code: null, issues: null, savedAt: new Date().toLocaleTimeString() }
          })
          if (response.ok) {
            // Advisory findings scoped to this document, so e.g. an open relation
            // to a dead character is visible without re-reading the whole project.
            setWarnings(
              (result?.validation?.issues ?? []).filter(
                (issue) => issue.level === 'warning' && issueBelongsTo(issue, relPath),
              ),
            )
          }
        })
        .catch((error) => {
          setState((current) => ({ ...current, saving: false, error: String(error?.message ?? error) }))
        })
      return { ...previous, saving: true, error: null }
    })
  }, [root, relPath])

  const reload = react.useCallback(() => setNonce((n) => n + 1), [])
  return { state, update, save, reload, warnings }
}

/** Revert the working copy to what is on disk. */
function documentRevert(reload) {
  reload()
}

/**
 * Where each reference kind lives, so a `ref`/`reflist` field can be populated
 * without its branch hard-coding a document path.
 *
 * One table rather than per-branch loading: several branches reference the same
 * kinds (a chapter and a timeline event both name characters and places), and
 * `useRefOptions` fetches each distinct document once regardless of how many
 * kinds point into it.
 */
const REF_COLLECTIONS = {
  character: { doc: 'setting/characters.json', key: 'characters', label: (entity) => entity.name || entity.id },
  place: { doc: 'setting/places.json', key: 'places', label: (entity) => entity.name || entity.id },
  organization: { doc: 'setting/organizations.json', key: 'organizations', label: (entity) => entity.name || entity.id },
  item: { doc: 'setting/items.json', key: 'items', label: (entity) => entity.name || entity.id },
  'item-category': { doc: 'setting/items.json', key: 'categories', label: (entity) => entity.name || entity.id },
  'outline-node': { doc: 'outline/outline.json', key: 'nodes', label: (node) => node.title || node.id },
  'timeline-line': { doc: 'outline/timeline.json', key: 'lines', label: (line) => line.name || line.id },
  'timeline-event': { doc: 'outline/timeline.json', key: 'events', label: (event) => event.title || event.id },
  'relation-type': { doc: 'relations.json', key: 'types', label: (type) => type.label || type.id },
  // Composite: a relation edge may join any entity, so there is no single
  // document to read. `doc: null` makes `useRefOptions` skip it, and the graph
  // branch supplies the candidates from the node set it has already assembled.
  'graph-node': { doc: null, key: null, label: (entity) => entity.name || entity.title || entity.id },
}

/**
 * Candidate `{ id, title }` lists for the reference kinds a branch needs.
 *
 * Read-only by design: this is a picker's data source, not a second editing path
 * for those documents — a branch still saves only its own document.
 */
function useRefOptions(root, kinds) {
  const [options, setOptions] = react.useState({})
  const kindKey = kinds.join(',')

  react.useEffect(() => {
    if (isBlank(root)) {
      setOptions({})
      return undefined
    }
    let live = true
    const docs = [...new Set(kinds.map((kind) => REF_COLLECTIONS[kind]?.doc).filter(Boolean))]
    Promise.all(
      docs.map((doc) =>
        fetch(api(`${API}/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(doc)}`))
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      ),
    ).then((results) => {
      if (!live) return
      const byDoc = new Map(docs.map((doc, index) => [doc, results[index]?.value ?? null]))
      const next = {}
      for (const kind of kinds) {
        const spec = REF_COLLECTIONS[kind]
        if (spec === undefined) continue
        const value = byDoc.get(spec.doc)
        // `objectList` on the elements as well as the container: one `null` entry in
        // characters.json used to throw here, and because this `.then` had no catch the
        // rejection was swallowed — leaving EVERY reference picker in the branch
        // silently empty for the rest of the session, with nothing on screen to say so.
        next[kind] = objectList(isRecord(value) ? value[spec.key] : null).map((entity) => ({
          id: entity.id,
          title: spec.label(entity),
        }))
      }
      setOptions(next)
    })
      // Belt and braces: whatever else goes wrong, an empty picker is a worse outcome
      // than an unchanged one, and a silent rejection is the worst of all.
      .catch(() => {
        if (live) setOptions({})
      })
    return () => {
      live = false
    }
  }, [root, kindKey])

  return options
}

/**
 * The project's calendar, read from `outline/timeline.json`.
 *
 * The graph needs it to label its time cursor in the author's own epoch, but the
 * calendar is not a reference *collection*, so it does not belong in
 * `REF_COLLECTIONS` — hence a small hook rather than a table entry.
 */
function useCalendar(root) {
  const [calendar, setCalendar] = react.useState(null)
  react.useEffect(() => {
    if (isBlank(root)) {
      setCalendar(null)
      return undefined
    }
    let live = true
    fetch(api(`${API}/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent('outline/timeline.json')}`))
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (live) setCalendar(body?.value?.calendar ?? null)
      })
      .catch(() => {
        if (live) setCalendar(null)
      })
    return () => {
      live = false
    }
  }, [root])
  return calendar
}

/** Word count for a mixed Chinese/Latin manuscript.
 *
 * `lib/impl/text.js` computes the same number for the chapter list. The two are
 * separate bundles with no shared import path, so the rule is duplicated —
 * `client-selftest.mjs` cross-checks the copies on shared inputs, the same guard
 * the time helpers use.
 */
function countWords(text) {
  const body = String(text ?? '')
  const cjk = body.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g)
  const latin = body.match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g)
  return (cjk === null ? 0 : cjk.length) + (latin === null ? 0 : latin.length)
}

/**
 * Load a chapter for editing.
 *
 * Separate from `useDocument` because a chapter is not a JSON document: the
 * endpoint returns `{ meta, body }` and the write sends the same pair, rather
 * than a `value`. Conflating the two would mean the form had to know which shape
 * it was holding.
 */
function useChapter(root, relPath) {
  const [state, setState] = react.useState({
    loading: true, error: null, code: null, meta: null, body: '',
    dirty: false, saving: false, issues: null, savedAt: null, frontMatterError: null, wordCount: 0,
  })
  const [nonce, setNonce] = react.useState(0)
  // Warnings are kept apart from `issues`: they are advisory (an unresolved name
  // is a normal stage of authoring) while `issues` is what blocked a write. They
  // are cleared on every reload so a stale warning cannot outlive its fix.
  const [warnings, setWarnings] = react.useState([])

  react.useEffect(() => {
    setWarnings([])
    if (isBlank(root) || isBlank(relPath)) {
      setState({
        loading: false, error: null, code: null, meta: null, body: '',
        dirty: false, saving: false, issues: null, savedAt: null, frontMatterError: null, wordCount: 0,
      })
      return undefined
    }
    let live = true
    setState((previous) => ({ ...previous, loading: true, error: null, code: null }))
    fetch(api(`${API}/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!live) return
        if (!response.ok) {
          setState({
            loading: false, error: body?.error ?? `HTTP ${response.status}`, code: body?.code ?? null,
            meta: null, body: '', dirty: false, saving: false, issues: null, savedAt: null,
            frontMatterError: null, wordCount: 0,
          })
        } else {
          setState({
            loading: false, error: null, code: null,
            meta: body.meta ?? {}, body: body.body ?? '',
            dirty: false, saving: false, issues: null, savedAt: null,
            frontMatterError: body.frontMatterError ?? null,
            wordCount: countWords(body.body ?? ''),
          })
        }
      })
      .catch((error) => {
        if (live) {
          setState({
            loading: false, error: String(error?.message ?? error), code: null,
            meta: null, body: '', dirty: false, saving: false, issues: null, savedAt: null,
            frontMatterError: null, wordCount: 0,
          })
        }
      })
    return () => {
      live = false
    }
  }, [root, relPath, nonce])

  const patchMeta = react.useCallback((patch) => {
    setState((previous) => (previous.meta === null ? previous : { ...previous, meta: { ...previous.meta, ...patch }, dirty: true, issues: null }))
  }, [])

  const setBody = react.useCallback((next) => {
    // A FUNCTION is accepted as well as a value, and that is load-bearing: a drafted
    // passage joins the prose a second or two after the request starts, and merging it
    // against a body captured at render time discards whatever the author typed in
    // between. The updater reads the CURRENT body, so nothing is lost.
    setState((previous) => {
      const value = typeof next === 'function' ? String(next(previous.body) ?? '') : String(next ?? '')
      return { ...previous, body: value, dirty: true, issues: null, wordCount: countWords(value) }
    })
  }, [])

  const save = react.useCallback(() => {
    setState((previous) => {
      if (previous.meta === null || previous.saving) return previous
      const payload = JSON.stringify({ root, path: relPath, meta: previous.meta, body: previous.body })
      fetch(api(`${API}/document`), { method: 'POST', headers: WRITE_HEADERS, body: payload })
        .then(async (response) => {
          const result = await response.json().catch(() => null)
          setState((current) => {
            if (!response.ok) {
              return {
                ...current, saving: false, code: result?.code ?? null,
                error: result?.error ?? `HTTP ${response.status}`, issues: result?.issues ?? null,
              }
            }
            return { ...current, saving: false, dirty: false, error: null, code: null, issues: null, savedAt: new Date().toLocaleTimeString() }
          })
          if (response.ok) {
            // Advisory findings for this chapter only, so the author sees e.g. a
            // character name no entity defines yet, without a second request.
            setWarnings(
              (result?.validation?.issues ?? []).filter(
                (issue) => issue.level === 'warning' && issueBelongsTo(issue, relPath),
              ),
            )
          }
        })
        .catch((error) => {
          setState((current) => ({ ...current, saving: false, error: String(error?.message ?? error) }))
        })
      return { ...previous, saving: true, error: null }
    })
  }, [root, relPath])

  const reload = react.useCallback(() => setNonce((n) => n + 1), [])
  return { state, patchMeta, setBody, save, reload, warnings }
}

// ---------------------------------------------------------------------------
// Presentational atoms
// ---------------------------------------------------------------------------

const muted = 'var(--dsh-border-subtle, rgba(128,128,128,0.3))'
const buttonStyle = {
  font: 'inherit',
  fontSize: '12px',
  padding: '3px 10px',
  borderRadius: '6px',
  border: `1px solid ${muted}`,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const inputStyle = {
  font: 'inherit',
  fontSize: '12px',
  padding: '4px 6px',
  borderRadius: '6px',
  border: `1px solid ${muted}`,
  background: 'transparent',
  color: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
}

function Note(props) {
  return h(
    'div',
    {
      style: {
        fontSize: '13px',
        lineHeight: 1.8,
        maxWidth: '52em',
        opacity: props.tone === 'error' ? 1 : 0.7,
        color: props.tone === 'error' ? '#e5534b' : 'inherit',
      },
    },
    props.text,
  )
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** One mark per branch, `currentColor` so the host owns colour. */
const GLYPHS = {
  world: [
    'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5Z',
    'M1.9 8h12.2',
    'M8 1.75c1.7 1.8 2.6 4 2.6 6.25S9.7 12.45 8 14.25C6.3 12.45 5.4 10.25 5.4 8S6.3 3.55 8 1.75Z',
  ],
  timeline: ['M2 8h12', 'M4.5 5.5v5', 'M8 4.5v7', 'M11.5 5.5v5'],
  orgs: ['M6 2.5h4v3H6z', 'M2 10.5h4v3H2z', 'M10 10.5h4v3h-4z', 'M8 5.5v2.5', 'M4 10.5V8h8v2.5'],
  chars: ['M8 2.2a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z', 'M2.8 13.6c0-2.6 2.3-4.2 5.2-4.2s5.2 1.6 5.2 4.2'],
  items: ['M8 1.9 13.6 5v6L8 14.1 2.4 11V5L8 1.9Z', 'M2.4 5 8 8.1 13.6 5', 'M8 8.1v6'],
  outline: ['M2.5 3.5h11', 'M2.5 7h7', 'M2.5 10.5h9', 'M2.5 14h5'],
  chapters: [
    'M3.5 2.2h6.2a2 2 0 0 1 2 2v9.6H5.5a2 2 0 0 1-2-2V2.2Z',
    'M11.7 5.4h.8a.7.7 0 0 1 .7.7v6.1a1.6 1.6 0 0 1-1.6 1.6h-.4',
  ],
}

function Glyph(props) {
  const paths = GLYPHS[props.name] ?? GLYPHS.chapters
  return h(
    'svg',
    {
      width: props.size ?? 16,
      height: props.size ?? 16,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    ...paths.map((d, index) =>
      h('path', { key: index, d, stroke: 'currentColor', strokeWidth: '1.2', strokeLinejoin: 'round', strokeLinecap: 'round' }),
    ),
  )
}

      // ==== 20-schema.js ======================================================
/**
 * Descriptor layer: fields, entities, and branches.
 *
 * This is the module that makes a branch a *configuration* rather than code.
 * A branch declares which document it edits, which collections live in it, how
 * those collections nest, and which entity schemas its cards use; the views
 * (`EntityTree`, `SchemaForm`) read those declarations and know nothing about
 * items, characters, or organizations specifically. Adding the 人物 branch later
 * is a descriptor entry, not a new component.
 */

/** Field builders. `type` selects the control `SchemaForm` renders. */
const F = {
  text: (key, label, extra) => ({ key, label, type: 'text', ...extra }),
  long: (key, label, extra) => ({ key, label, type: 'longtext', ...extra }),
  num: (key, label, extra) => ({ key, label, type: 'number', ...extra }),
  time: (key, label, extra) => ({ key, label, type: 'time', ...extra }),
  select: (key, label, options, extra) => ({ key, label, type: 'select', options, ...extra }),
  stringList: (key, label, extra) => ({ key, label, type: 'stringlist', ...extra }),
  stringMap: (key, label, extra) => ({ key, label, type: 'stringmap', ...extra }),
  ref: (key, label, refKind, extra) => ({ key, label, type: 'ref', refKind, ...extra }),
  refList: (key, label, refKind, extra) => ({ key, label, type: 'reflist', refKind, ...extra }),
  /** A flat, self-nested-by-`parentId` array edited as a small tree. */
  structure: (key, label, extra) => ({ key, label, type: 'structure', ...extra }),
}

/**
 * Turn a display name into a stable id segment.
 *
 * The id is minted once, from whatever the entity was first called, and never
 * follows a rename: `docs/data-model.md` requires ids to be rename-proof, with
 * `aliases` carrying former names for the consistency checker to match on.
 */
function idSegment(name, fallback) {
  const cleaned = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? fallback : cleaned
}

/** A project-unique id, avoiding collisions already present in `taken`. */
function mintId(prefix, name, taken) {
  // Tolerate a prefix written with or without its trailing dash. Ids are
  // permanent (see idSegment), so `cat--weapon` would be baked into the user's
  // data for good — normalise here rather than trusting every call site.
  const cleanPrefix = String(prefix).replace(/-+$/, '')
  const base = `${cleanPrefix}-${idSegment(name, 'untitled')}`
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * Entity schemas. Structural keys (`id`, `parentId`, `categoryId`, `custom`) are
 * NOT declared here: the tree owns parentage and the form owns `custom`, so
 * declaring them as fields would render them twice.
 */
const ENTITIES = {
  'item-category': {
    label: '分类',
    idPrefix: 'cat-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [F.text('name', '名称'), F.num('order', '排序')],
    blank: () => ({ name: '新分类', order: 10 }),
  },
  item: {
    label: '物品',
    idPrefix: 'item-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [
      F.text('name', '名称'),
      F.text('rarity', '品阶'),
      F.long('description', '描述'),
      F.long('history', '来历'),
      F.stringMap('attrs', '属性'),
      F.stringList('tags', '标签'),
    ],
    // A model-backed generator this entity offers. Declaring it here turns the
    // control on in the detail pane; a second generator is a line like this one,
    // not new UI. `hintField` seeds the direction from the author's own draft.
    generate: { kind: 'item', hintField: 'name' },
    blank: () => ({ name: '新物品', rarity: '', description: '', history: '', attrs: {}, tags: [] }),
  },
  'timeline-line': {
    label: '时间线',
    idPrefix: 'tl-',
    titleOf: (line) => line.name || line.id,
    fields: [
      F.text('name', '名称'),
      F.select('kind', '类型', [
        { value: 'main', label: '主线' },
        { value: 'branch', label: '支线' },
      ]),
      F.num('order', '排序'),
    ],
    blank: () => ({ name: '新时间线', kind: 'branch', order: 10 }),
  },
  'timeline-event': {
    label: '事件',
    idPrefix: 'evt-',
    titleOf: (event) => event.title || event.id,
    fields: [
      F.text('title', '标题'),
      F.ref('lineId', '所属线', 'timeline-line'),
      F.time('at', '发生时间'),
      F.time('spanEnd', '结束时间（时段）'),
      F.text('atLabel', '模糊时间说明'),
      F.long('impact', '影响'),
      F.refList('characters', '涉及人物', 'character'),
      F.refList('places', '涉及地点', 'place'),
      F.ref('outlineRef', '对应大纲条目', 'outline-node'),
      // A picker, like every other reference on this entity. It used to be a free-text
      // box, so a typo persisted forever and "why did this happen" silently resolved to
      // nothing — the one reference field on the entity that no check and no picker
      // covered.
      F.ref('causeEventId', '诱因事件', 'timeline-event'),
    ],
    // A model can propose a title, a time and an impact, but never a reference:
    // invented ids would point at entities that do not exist, so the author picks
    // 涉及人物/地点/所属线 themselves. The generator's field list omits them too.
    generate: { kind: 'timeline-event', hintField: 'title' },
    blank: () => ({
      title: '新事件',
      lineId: null,
      at: { year: 1, month: null, day: null },
      spanEnd: null,
      atLabel: '',
      impact: '',
      characters: [],
      places: [],
      outlineRef: null,
      causeEventId: null,
    }),
  },
  'outline-node': {
    label: '大纲条目',
    idPrefix: 'out-',
    titleOf: (node) => node.title || node.id,
    fields: [
      F.text('title', '标题'),
      F.select('kind', '层级', [
        { value: 'volume', label: '卷' },
        { value: 'chapter', label: '章' },
        { value: 'beat', label: '节拍' },
      ]),
      F.num('order', '排序'),
      F.long('summary', '概要'),
      F.ref('timelineRef', '对应事件', 'timeline-event'),
      F.text('chapterId', '对应章节'),
    ],
    blank: () => ({ title: '新条目', kind: 'chapter', order: 10, summary: '', timelineRef: null, chapterId: null }),
  },
  character: {
    label: '人物',
    idPrefix: 'char-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [
      F.text('name', '姓名'),
      F.stringList('aliases', '别名'),
      F.select('gender', '性别', [
        { value: '男', label: '男' },
        { value: '女', label: '女' },
        { value: '其他', label: '其他' },
        { value: '未定', label: '未定' },
      ]),
      F.text('race', '种族'),
      // Birth time rather than an age number: the timeline spans centuries and a
      // stored age is wrong the moment the story moves (docs/data-model.md §4.3).
      F.time('born', '出生时间'),
      F.text('ageNote', '年龄说明'),
      F.select('status', '状态', [
        { value: 'alive', label: '在世' },
        { value: 'dead', label: '已故' },
        { value: 'missing', label: '失踪' },
        { value: 'unknown', label: '未知' },
      ]),
      F.long('appearance', '外貌'),
      F.long('personality', '性格'),
      F.long('background', '背景'),
      F.text('firstAppearance', '首次出场（章节 id）'),
      F.stringList('tags', '标签'),
    ],
    generate: { kind: 'character', hintField: 'name' },
    blank: () => ({
      name: '新人物',
      aliases: [],
      gender: '未定',
      race: '',
      born: null,
      ageNote: '',
      status: 'alive',
      appearance: '',
      personality: '',
      background: '',
      firstAppearance: null,
      tags: [],
      custom: {},
    }),
  },
  place: {
    label: '地点',
    idPrefix: 'place-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [
      F.text('name', '名称'),
      F.text('kind', '类型'),
      F.long('summary', '简介'),
      F.stringList('tags', '标签'),
    ],
    // `parentId` is not a field: the tree owns parentage, so declaring it here
    // would render the same fact twice.
    generate: { kind: 'place', hintField: 'name' },
    blank: () => ({ name: '新地点', kind: '', summary: '', tags: [], custom: {} }),
  },
  /**
   * A position in an organization's structure.
   *
   * Only the shape of the hierarchy lives here — who holds a position is a
   * `member-of` relation edge, so "the post is filled" and "the person is a member"
   * cannot disagree (docs/data-model.md §4.4).
   */
  'org-position': {
    label: '职位',
    idPrefix: 'pos-',
    titleOf: (position) => position.title || position.id,
    fields: [F.text('title', '职位名称'), F.num('order', '排序')],
    blank: () => ({ title: '新职位', parentId: null, order: 10 }),
  },
  organization: {
    label: '组织',
    idPrefix: 'org-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [
      F.text('name', '名称'),
      F.stringList('aliases', '别名'),
      F.text('kind', '类型'),
      F.time('founded', '成立时间'),
      F.select('status', '状态', [
        { value: 'active', label: '存续' },
        { value: 'dissolved', label: '已解散' },
        { value: 'unknown', label: '未知' },
      ]),
      F.long('summary', '简介'),
      // A flat array self-nested by `parentId`, like item categories — so it reuses
      // the same tree component rather than needing a bespoke editor.
      F.structure('structure', '组织架构'),
      F.stringList('tags', '标签'),
    ],
    generate: { kind: 'organization', hintField: 'name' },
    blank: () => ({ name: '新组织', aliases: [], kind: '', founded: null, status: 'active', summary: '', structure: [], tags: [], custom: {} }),
  },
  /**
   * A relationship edge. Lives in `relations.json`, which is the one document the
   * relationship graph owns and writes — every other branch reads it.
   */
  'relation-edge': {
    label: '关系',
    idPrefix: 'rel-',
    titleOf: (edge) => edge.id,
    fields: [
      F.ref('from', '起点', 'graph-node'),
      F.ref('to', '终点', 'graph-node'),
      F.ref('type', '类型', 'relation-type'),
      F.time('since', '起始'),
      F.time('until', '结束'),
      F.ref('causeEventId', '诱发事件', 'timeline-event'),
      F.long('note', '备注'),
    ],
    // `since` is required and must precede `until`; a fresh edge starts at year 1
    // and the author narrows it. A half-filled edge simply cannot be saved, which
    // is the validator doing its job rather than a form that lies.
    blank: () => ({ from: null, to: null, type: '', since: { year: 1, month: null, day: null }, until: null, note: '', causeEventId: null }),
  },
  /**
   * A section of the world setting. Prose, so `body` is long-form.
   */
  'world-section': {
    label: '分节',
    idPrefix: 'sec-',
    titleOf: (section) => section.title || section.id,
    fields: [F.text('title', '标题'), F.num('order', '排序'), F.long('body', '正文')],
    blank: () => ({ title: '新分节', order: 10, body: '' }),
  },
  /**
   * A world rule as its own entry, not buried in a paragraph — so consistency
   * checking can say "violates rule-003" instead of quoting prose.
   *
   * `scope` decides whether `branch` applies: a global rule governs the whole
   * book, a branch rule only its own 时间线 or region.
   */
  'world-rule': {
    label: '规则',
    idPrefix: 'rule-',
    titleOf: (rule) => rule.title || rule.id,
    fields: [
      F.text('title', '规则名称'),
      F.select('scope', '范围', [
        { value: 'global', label: '总规则（全书）' },
        { value: 'branch', label: '分支规则（限某地/某线）' },
      ]),
      F.text('branch', '适用分支（范围选「分支规则」时填）'),
      F.long('body', '规则内容'),
      F.stringList('tags', '标签'),
    ],
    // `generate` is deliberately absent: a rule is a constraint the author must
    // decide, and a model inventing one would constrain the book for them.
    blank: () => ({ title: '新规则', scope: 'global', branch: '', body: '', tags: [] }),
  },
  /**
   * Chapter front matter. Not a JSON document — the prose lives in the file body —
   * but the metadata half edits exactly like any other entity, so it reuses the
   * same form.
   */
  chapter: {
    label: '章节',
    idPrefix: 'ch-',
    titleOf: (meta) => meta.title || meta.id,
    fields: [
      F.text('title', '标题'),
      F.num('order', '排序'),
      F.select('status', '状态', [
        { value: 'draft', label: '草稿' },
        { value: 'revised', label: '已修' },
        { value: 'final', label: '定稿' },
      ]),
      F.ref('volumeRef', '所属卷', 'outline-node'),
      F.ref('outlineRef', '对应大纲条目', 'outline-node'),
      // Pickers, not typed names: the front matter stores entity ids, which is
      // what the consistency checker and the relationship graph need. A name
      // typed before the entity existed stays visible as an unresolved chip and
      // is reported as `unresolved-chapter-reference`.
      F.refList('characters', '涉及人物', 'character'),
      F.refList('places', '涉及地点', 'place'),
      F.long('summary', '概要'),
    ],
    blank: () => ({
      title: '新章节',
      order: 10,
      status: 'draft',
      volumeRef: null,
      outlineRef: null,
      characters: [],
      places: [],
      summary: '',
      custom: {},
    }),
  },
}

/**
 * Branches. One entry per activity-bar icon; `view` selects the center view.
 *
 * `planned` is shown verbatim for branches whose view has not landed yet —
 * an honest empty state beats a fake one, and it keeps the navigation complete
 * while the views arrive one at a time.
 */
const BRANCHES = [
  {
    id: 'world',
    label: '世界',
    hint: '世界观总设定、地点与地图',
    // 地点 lives here rather than as an eighth activity icon, because the brief
    // puts it under 世界 alongside 总设定 and 地图. A tab strip keeps the seven
    // icons the navigation was designed around.
    view: 'tabs',
    tabs: [
      {
        id: 'places',
        label: '地点',
        view: 'tree',
        doc: 'setting/places.json',
        tree: {
          groups: [{ key: 'places', entity: 'place', parentKey: 'parentId', label: '地点', idPrefix: 'place-' }],
          leaves: [],
        },
        // Ask this branch to also read the map document, so a 地点 can show WHICH markers on WHICH maps
        // point at it. Only this branch pays for it.
        placeLinks: true,
      },
      {
        id: 'settings',
        label: '总设定',
        view: 'tree',
        doc: 'setting/world.json',
        // Two flat collections rather than a tree: sections and rules are separate
        // lists in one document, with no nesting between them.
        collections: [
          { key: 'sections', entity: 'world-section', label: '分节', idPrefix: 'sec-' },
          { key: 'rules', entity: 'world-rule', label: '规则', idPrefix: 'rule-' },
        ],
      },
      {
        id: 'map',
        label: '地图',
        view: 'map',
        doc: 'setting/map/index.json',
        hint: '手绘或导入的 2D 地图',
      },
    ],
  },
  {
    id: 'timeline',
    label: '时间轴',
    hint: '事件、主线与支线',
    view: 'timeline',
    doc: 'outline/timeline.json',
    // Two flat collections rather than a tree, so the detail lookup needs the
    // collection keys spelled out.
    collections: [
      { key: 'lines', entity: 'timeline-line' },
      { key: 'events', entity: 'timeline-event' },
    ],
    // Reference candidates the event form offers.
    refKinds: ['timeline-line', 'outline-node', 'timeline-event', 'character', 'place'],
  },
  {
    id: 'orgs',
    label: '组织',
    hint: '组织架构与关系网',
    view: 'tabs',
    tabs: [
      {
        id: 'cards',
        label: '组织树',
        view: 'tree',
        doc: 'setting/organizations.json',
        tree: {
          groups: [
            { key: 'organizations', entity: 'organization', parentKey: 'parentId', label: '组织', idPrefix: 'org-' },
          ],
          leaves: [],
        },
      },
      {
        id: 'graph',
        label: '关系网',
        view: 'graph',
        doc: 'relations.json',
        // The graph edits edges, so it must declare where they live or the detail
        // lookup finds nothing and the pane silently shows a generic hint.
        collections: [{ key: 'edges', entity: 'relation-edge' }],
        // Both tabs read the same edge document; what distinguishes them is which
        // nodes each is centred on.
        focusKinds: ['organization'],
        nodeKinds: ['character', 'organization', 'place'],
      },
    ],
  },
  {
    id: 'chars',
    label: '人物',
    hint: '人物卡与关系网',
    view: 'tabs',
    tabs: [
      {
        id: 'cards',
        label: '人物卡',
        view: 'tree',
        doc: 'setting/characters.json',
        tree: {
          // Characters have no parent in the model, so every one is a root and the
          // tree renders a flat list. Declaring the parent key anyway means adding
          // grouping later (by faction, say) needs no new component.
          groups: [
            { key: 'characters', entity: 'character', parentKey: 'parentId', label: '人物', idPrefix: 'char-' },
          ],
          leaves: [],
        },
      },
      {
        id: 'graph',
        label: '关系网',
        view: 'graph',
        doc: 'relations.json',
        // See the 组织 tab: the graph edits edges, so it must declare them.
        collections: [{ key: 'edges', entity: 'relation-edge' }],
        focusKinds: ['character'],
        nodeKinds: ['character', 'organization', 'place'],
      },
    ],
  },
  {
    id: 'items',
    label: '物品',
    hint: '物品分类树与物品卡',
    view: 'tree',
    doc: 'setting/items.json',
    tree: {
      // A forest of categories joined by `parentId`, with items hanging off a
      // category by `categoryId`. Depth is unbounded, so 总类别/副类别/分支类别
      // are just the first three levels rather than a fixed shape.
      groups: [{ key: 'categories', entity: 'item-category', parentKey: 'parentId', label: '分类', idPrefix: 'cat-' }],
      leaves: [{ key: 'items', entity: 'item', parentKey: 'categoryId', label: '物品', idPrefix: 'item-' }],
    },
  },
  {
    id: 'outline',
    label: '剧情大纲',
    hint: '卷章结构与进度',
    view: 'tree',
    doc: 'outline/outline.json',
    // A groups-only forest: outline nodes nest by `parentId` and have no leaf
    // collection. EntityTree tolerates the missing `leaves`, which is what lets
    // the same component serve a tree of items and a tree of outline nodes.
    tree: {
      groups: [{ key: 'nodes', entity: 'outline-node', parentKey: 'parentId', label: '大纲条目', idPrefix: 'out-' }],
      leaves: [],
    },
  },
  {
    id: 'chapters',
    label: '章节',
    hint: '章节正文',
    view: 'chapters',
  },
]

const panelIdFor = (branchId) => `dsh-novel.${branchId}`
const DETAIL_KIND = 'novel.detail'
const DETAIL_ID = 'dsh-novel.detail'

      // ==== 30-form.js ========================================================
/**
 * SchemaForm — a detail editor driven entirely by an entity descriptor.
 *
 * Two halves, and the second is the one that matters product-wise:
 *
 *   1. The declared fields, each rendered by its `type`.
 *   2. A free-form 自定义信息 section over `entity.custom`.
 *
 * (2) is what makes "用户在人物卡上新建一个信息：性格" work without a code change
 * and without a migration — `custom` is a flat bag of scalars on every entity
 * precisely so a new field costs nothing (docs/data-model.md §7). The promotion
 * rule is stated in the UI: anything needing a type, validation, filtering, or a
 * relationship should become a declared field instead.
 *
 * Fields render as controlled inputs and report upward through `onPatch`; the
 * form holds no state of its own beyond an uncommitted key/value draft row.
 */

const CUSTOM_VALUE_LIMIT = 400

function FieldLabel(props) {
  // BOTH FORMS, deliberately. `children` is the usual one and `text` is used by every field label in the map
  // panel — and because the component read only `children`, all fifteen of those rendered an EMPTY label.
  // A blank caption looks like a spacing choice, so nothing ever reported it.
  return h(
    'label',
    { style: { fontSize: '11px', opacity: 0.55, display: 'block', marginBottom: '3px' } },
    props.text ?? props.children,
  )
}

function FieldRow(props) {
  return h('div', { style: { marginBottom: '10px' } }, props.children)
}

/** year / month / day, kept as three numeric inputs — the calendar is in-world. */
function TimeInput(props) {
  const value = props.value ?? {}
  const set = (part, raw) => {
    const next = { ...value }
    next[part] = raw === '' ? null : Number(raw)
    // An empty year means the whole time is unset. Emitting `{year:null,…}` would
    // be a "time object" the host's validator rightly rejects as unusable, so
    // widening a field back to blank has to produce `null`, not a partial object.
    props.onChange(Number.isFinite(next.year) ? next : null)
  }
  const parts = ['year', 'month', 'day']
  return h(
    'div',
    { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
    ...parts.map((part) =>
      h('input', {
        key: part,
        type: 'number',
        value: value[part] ?? '',
        placeholder: part === 'year' ? '年' : part === 'month' ? '月' : '日',
        onChange: (event) => set(part, event.target.value),
        style: { ...inputStyle, width: part === 'year' ? '80px' : '56px' },
      }),
    ),
  )
}

/** Drop keys that are blank or whitespace-only — they are not representable. */
function withoutBlankKeys(record) {
  return Object.fromEntries(
    Object.entries(record ?? {}).filter(([key]) => String(key).trim() !== ''),
  )
}

/**
 * A key→value editor that never persists an uncommitted row.
 *
 * The draft row lives in component state, NOT in the object being edited. The
 * obvious implementation — append `{'': ''}` to the data and let the renderer
 * filter it out — writes an entry the UI then hides: invisible, unremovable junk
 * in the user's file. That is exactly what shipped, and it reached a real novel
 * project before anyone noticed.
 */
function KeyValueEditor(props) {
  const { value, onChange, addLabel } = props
  const entries = Object.entries(withoutBlankKeys(value))
  const [draft, setDraft] = react.useState({ key: '', value: '' })

  const renameKey = (index, nextKey) => {
    const next = {}
    entries.forEach(([key, entryValue], i) => {
      next[i === index ? nextKey : key] = entryValue
    })
    onChange(withoutBlankKeys(next))
  }

  const commitDraft = () => {
    if (draft.key.trim() === '') return
    onChange({ ...withoutBlankKeys(value), [draft.key.trim()]: draft.value })
    setDraft({ key: '', value: '' })
  }

  const removeAt = (index) => {
    const next = {}
    entries.forEach(([key, entryValue], i) => {
      if (i !== index) next[key] = entryValue
    })
    onChange(next)
  }

  return h(
    'div',
    null,
    ...entries.map(([key, entryValue], index) =>
      h(
        'div',
        { key: index, style: { display: 'flex', gap: '4px', marginBottom: '4px' } },
        h('input', {
          value: key,
          placeholder: props.keyPlaceholder ?? '键',
          onChange: (event) => renameKey(index, event.target.value),
          style: { ...inputStyle, width: '38%' },
        }),
        h('input', {
          value: String(entryValue ?? ''),
          placeholder: props.valuePlaceholder ?? '值',
          maxLength: CUSTOM_VALUE_LIMIT,
          onChange: (event) => onChange({ ...withoutBlankKeys(value), [key]: event.target.value }),
          style: inputStyle,
        }),
        h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 7px' }, onClick: () => removeAt(index) }, '×'),
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', gap: '4px', marginTop: '4px' } },
      h('input', {
        value: draft.key,
        placeholder: props.keyPlaceholder ?? '键',
        onChange: (event) => setDraft((current) => ({ ...current, key: event.target.value })),
        onKeyDown: (event) => {
          if (event.key === 'Enter') commitDraft()
        },
        style: { ...inputStyle, width: '38%' },
      }),
      h('input', {
        value: draft.value,
        placeholder: props.valuePlaceholder ?? '值',
        maxLength: CUSTOM_VALUE_LIMIT,
        onChange: (event) => setDraft((current) => ({ ...current, value: event.target.value })),
        onKeyDown: (event) => {
          if (event.key === 'Enter') commitDraft()
        },
        style: inputStyle,
      }),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 9px' }, disabled: draft.key.trim() === '', onClick: commitDraft }, '＋'),
    ),
  )
}

/** Lines → the normalized list. Blank lines are not values. */
function parseStringList(text) {
  return String(text ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * What the textarea should display.
 *
 * While editing it shows the RAW buffer, not a round-trip through the parsed
 * list. Rendering the normalized value is the obvious implementation and it
 * breaks typing outright: pressing Enter adds a trailing empty line, the parser
 * drops it, the joined value has no trailing newline, and the controlled
 * textarea snaps back — so the cursor never reaches line two and 「每行一个」
 * cannot be used at all. On blur the normalized value takes over again, which is
 * what keeps blank lines out of the file.
 */
function stringListDisplay(editing, draft, value) {
  if (editing) return draft
  return Array.isArray(value) ? value.join('\n') : ''
}

function StringListInput(props) {
  const [draft, setDraft] = react.useState('')
  const [editing, setEditing] = react.useState(false)
  return h('textarea', {
    value: stringListDisplay(editing, draft, props.value),
    rows: 3,
    placeholder: '每行一个',
    onChange: (event) => {
      setEditing(true)
      setDraft(event.target.value)
      props.onChange(parseStringList(event.target.value))
    },
    onBlur: () => {
      setEditing(false)
      setDraft('')
    },
    style: { ...inputStyle, resize: 'vertical', fontFamily: 'inherit' },
  })
}

/**
 * A multi-select picker over existing entities.
 *
 * This is the "click a character and pull them in" affordance: chosen entries are
 * chips, candidates come from a dropdown, and anything already in the data that no
 * longer resolves is shown as an unresolved chip rather than silently dropped —
 * which is how a name typed before the entity existed stays visible and fixable.
 */
function MultiSelect(props) {
  const { value, onChange, options, addLabel } = props
  const selected = Array.isArray(value) ? value : []
  const candidates = Array.isArray(options) ? options : []
  const titleOf = new Map(candidates.map((option) => [option.id, option.title]))
  const [pending, setPending] = react.useState('')

  const remaining = candidates.filter((option) => !selected.includes(option.id))

  return h(
    'div',
    null,
    selected.length === 0
      ? h('div', { style: { fontSize: '11px', opacity: 0.45, marginBottom: '4px' } }, '（未选）')
      : h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' } },
          ...selected.map((id) =>
            h(
              'span',
              {
                key: id,
                title: titleOf.has(id) ? id : `${id} —— 没有对应实体`,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '11px',
                  padding: '1px 4px 1px 8px',
                  borderRadius: '999px',
                  border: `1px solid ${titleOf.has(id) ? muted : '#c98a2b'}`,
                },
              },
              titleOf.get(id) ?? id,
              h(
                'button',
                {
                  type: 'button',
                  style: { ...buttonStyle, padding: '0 5px', border: 'none', opacity: 0.7 },
                  onClick: () => onChange(selected.filter((entry) => entry !== id)),
                },
                '×',
              ),
            ),
          ),
        ),
    h(
      'select',
      {
        value: pending,
        onChange: (event) => {
          if (event.target.value === '') return
          onChange([...selected, event.target.value])
          setPending('')
        },
        style: inputStyle,
      },
      h(
        'option',
        { value: '' },
        remaining.length === 0
          ? candidates.length === 0
            ? '暂无可选项 —— 先在该分支创建'
            : '全部已选'
          : (addLabel ?? '＋ 添加…'),
      ),
      ...remaining.map((option) => h('option', { key: option.id, value: option.id }, option.title)),
    ),
  )
}

function FieldControl(props) {
  const { field, value, onPatch, refOptions } = props
  const set = (next) => onPatch({ [field.key]: next })

  switch (field.type) {
    case 'longtext':
      return h('textarea', {
        value: value ?? '',
        rows: field.rows ?? 4,
        onChange: (event) => set(event.target.value),
        style: { ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 },
      })
    case 'number':
      return h('input', {
        type: 'number',
        value: value ?? '',
        onChange: (event) => {
          if (event.target.value === '') return set(null)
          const parsed = Number(event.target.value)
          // Infinity (from `1e999`) serialises to null, so storing it silently empties the
          // field. A non-finite entry keeps the last good value instead.
          if (!Number.isFinite(parsed)) return
          set(parsed)
        },
        style: inputStyle,
      })
    case 'time':
      return h(TimeInput, { value, onChange: set })
    case 'select':
      return h(
        'select',
        { value: value ?? '', onChange: (event) => set(event.target.value), style: inputStyle },
        // `emptyLabel` lets a caller say WHAT is unset. A pin's 「对应地点」 showing a bare
        // 「（未设）」 left the author asking what the field even was; the default is kept so every
        // other branch reads as before.
        h('option', { value: '' }, field.emptyLabel ?? '（未设）'),
        ...(field.options ?? []).map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    case 'stringlist':
      return h(StringListInput, { value, onChange: set })
    case 'stringmap':
      return h(KeyValueEditor, { value, onChange: set })
    case 'ref':
      return h(
        'select',
        {
          value: value ?? '',
          onChange: (event) => set(event.target.value === '' ? null : event.target.value),
          style: inputStyle,
        },
        h('option', { value: '' }, field.emptyLabel ?? '（未设）'),
        ...(refOptions?.[field.refKind] ?? []).map((option) => h('option', { key: option.id, value: option.id }, option.title)),
      )
    case 'reflist':
      return h(MultiSelect, { value, onChange: set, options: refOptions?.[field.refKind] })
    case 'structure':
      return h(StructureInput, { value, onChange: set })
    case 'text':
    default:
      return h('input', { value: value ?? '', onChange: (event) => set(event.target.value), style: inputStyle })
  }
}

/** The 自定义信息 section: a flat bag of scalars, the zero-migration escape hatch. */
function CustomSection(props) {
  return h(
    'div',
    { style: { marginTop: '18px', paddingTop: '14px', borderTop: `1px dashed ${muted}` } },
    h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } }, '自定义信息'),
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.5, lineHeight: 1.7, marginBottom: '10px' } },
      '随手加的字段放这里，不需要改代码、不需要迁移。需要类型约束、筛选，或要让 AI 校验的，应提升为正式字段。',
    ),
    h(KeyValueEditor, {
      value: props.value,
      onChange: props.onChange,
      keyPlaceholder: '名称',
      valuePlaceholder: '内容',
    }),
  )
}

/**
 * @param entity - the entity descriptor from `ENTITIES`.
 * @param value - the entity being edited.
 * @param onPatch - receives a partial update to merge into the entity.
 * @param refOptions - `{ [refKind]: [{ id, title }] }` for `ref`/`reflist` fields.
 */
function SchemaForm(props) {
  const { entity, value, onPatch, refOptions } = props
  if (value === null || value === undefined) return null
  return h(
    'div',
    null,
    ...entity.fields.map((field) =>
      h(
        FieldRow,
        { key: field.key },
        h(FieldLabel, null, field.label),
        h(FieldControl, { field, value: value[field.key], onPatch, refOptions }),
      ),
    ),
    h(CustomSection, { value: value.custom, onChange: (custom) => onPatch({ custom }) }),
  )
}

      // ==== 35-generate.js ====================================================
/**
 * The generator control: model-backed or local-template.
 *
 * Four deliberate properties:
 *
 *   - **It fills the form; it does not save.** The result is a draft the author
 *     reviews before the write. A generator that saved directly would put
 *     unreviewed output into a novel.
 *   - **It says what it did.** Which model ran and how many tokens it used are
 *     shown afterwards. A button that quietly spends the author's quota is not
 *     acceptable, and the cost is otherwise invisible.
 *   - **It is declared by the entity.** `ENTITIES[x].generate` turns the control
 *     on, so a second generator is a descriptor line rather than new UI.
 *   - **Two modes, honestly labelled.** The model writes prose and costs tokens;
 *     the local tables produce names and classifications instantly and for free.
 *     Neither pretends to be the other.
 */

/** The choice of mode/provider/model/style/count, persisted per browser. */
const GENERATE_SETTINGS_KEY = 'dsh-novel.generate.settings'

function readGenerateSettings() {
  try {
    const raw = window.localStorage.getItem(GENERATE_SETTINGS_KEY)
    const parsed = raw === null ? null : JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    // A browser with storage disabled must still be able to generate.
    return {}
  }
}

function writeGenerateSettings(settings) {
  try {
    window.localStorage.setItem(GENERATE_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* preference only; losing it is not worth an error */
  }
}

/**
 * The generation catalogue, fetched once per control from the host.
 *
 * Style labels and generator kinds come from the host rather than a copy here:
 * a duplicated preset table would drift from the wording the host actually sends,
 * and a generator kind the host does not implement would fail only at click time.
 */
function useCatalog(enabled) {
  const [state, setState] = react.useState({
    loading: enabled === true,
    available: false,
    providers: [],
    models: {},
    styles: [],
    generators: [],
  })
  react.useEffect(() => {
    if (enabled !== true) return undefined
    let live = true
    fetch(api(`${API}/catalog`))
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!live) return
        setState({
          loading: false,
          available: body?.available === true,
          providers: body?.providers ?? [],
          models: body?.models ?? {},
          styles: body?.styles ?? [],
          generators: body?.generators ?? [],
        })
      })
      .catch(() => {
        if (live) setState((previous) => ({ ...previous, loading: false, available: false }))
      })
    return () => {
      live = false
    }
  }, [enabled])
  return state
}

/** `provider · model`, flattened, with the model's own name for display. */
function modelChoices(models) {
  const out = []
  for (const [provider, list] of Object.entries(models ?? {})) {
    if (!Array.isArray(list)) continue
    for (const model of list) {
      if (model?.id === null || model?.id === undefined) continue
      out.push({ provider, model: model.id, label: `${provider} · ${model.name ?? model.id}` })
    }
  }
  return out
}

/** The option rows, kept out of the way behind a disclosure. */
function GenerateOptions(props) {
  const { settings, onChange, catalog } = props
  const choices = modelChoices(catalog.models)
  const styles = catalog.styles
  const mode = settings.mode ?? 'model'

  return h(
    'details',
    { style: { marginTop: '6px', fontSize: '11px' } },
    h('summary', { style: { cursor: 'pointer', opacity: 0.55 } }, '生成选项'),
    h(
      'div',
      { style: { paddingTop: '6px', display: 'flex', flexDirection: 'column', gap: '5px' } },
      h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: { width: '46px', opacity: 0.6 } }, '方式'),
        h(
          'select',
          {
            value: settings.mode ?? 'model',
            onChange: (event) => onChange({ mode: event.target.value }),
            style: { ...inputStyle, padding: '2px 4px', flex: 1 },
          },
          h('option', { value: 'model' }, '模型生成（花额度）'),
          h('option', { value: 'local' }, '本地模板（离线免费）'),
        ),
      ),
      (settings.mode ?? 'model') === 'model'
        ? h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { width: '46px', opacity: 0.6 } }, '模型'),
            h(
              'select',
              {
                value: settings.modelKey ?? '',
                onChange: (event) => onChange({ modelKey: event.target.value }),
                style: { ...inputStyle, padding: '2px 4px', flex: 1 },
              },
              // Empty means "let the host choose", which is also the fallback when
              // /catalog is unavailable.
              h('option', { value: '' }, catalog.loading === true ? '载入中…' : '自动（宿主决定）'),
              ...choices.map((choice) =>
                h('option', { key: `${choice.provider}/${choice.model}`, value: `${choice.provider}/${choice.model}` }, choice.label),
              ),
            ),
          )
        : null,
      mode === 'model'
        ? h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { width: '46px', opacity: 0.6 } }, '风格'),
            h(
              'select',
              {
                value: settings.styleId ?? '',
                onChange: (event) => onChange({ styleId: event.target.value }),
                style: { ...inputStyle, padding: '2px 4px', flex: 1 },
              },
              h('option', { value: '' }, '不限'),
              ...styles.map((style) => h('option', { key: style.id, value: style.id }, style.label)),
            ),
          )
        : null,
      mode === 'model'
        ? h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { width: '46px', opacity: 0.6 } }, '备选'),
            h(
              'select',
              {
                value: String(settings.count ?? 1),
                onChange: (event) => onChange({ count: Number(event.target.value) }),
                style: { ...inputStyle, padding: '2px 4px', flex: 1 },
              },
              h('option', { value: '1' }, '1 份，直接填入'),
              h('option', { value: '3' }, '3 份，挑一份'),
              h('option', { value: '5' }, '5 份，挑一份'),
            ),
          )
        : null,
      h(
        'div',
        { style: { opacity: 0.45, lineHeight: 1.6 } },
        mode === 'model'
          ? '模型生成会读取本项目的设定，内容有文采但会消耗额度。'
          : '本地模板从内置表里取名字与分类，不联网、不花额度，但不会写描述性文字。',
      ),
      mode === 'model' && catalog.available !== true && catalog.loading !== true
        ? h('div', { style: { color: '#e5534b', lineHeight: 1.6 } }, '宿主没有可用的模型服务，请改用本地模板。')
        : null,
    ),
  )
}

/**
 * How a drafted passage joins what is already in the editor.
 *
 * Pure, because the three modes differ in a way that is easy to get subtly wrong:
 * 重写 replaces, while 接着写 and 扩写 append — and appending to an empty chapter must
 * not leave leading blank lines.
 */
function mergeDraft(current, text, mode) {
  const base = typeof current === 'string' ? current.trimEnd() : ''
  const draft = typeof text === 'string' ? text.trim() : ''
  if (draft === '') return base
  if (mode === 'rewrite') return draft
  return base === '' ? draft : `${base}\n\n${draft}`
}

/** The drafting modes, mirroring the host's `DRAFT_MODES` ids. */
const DRAFT_MODE_LABELS = [
  { id: 'continue', label: '接着写' },
  { id: 'expand', label: '扩写' },
  { id: 'rewrite', label: '重写' },
]

/**
 * The chapter drafting control.
 *
 * Distinct from `GenerateControl` on purpose: that one fills an entity's fields from
 * JSON, this one appends prose. Both leave the result for review rather than saving,
 * and both report the model and the cost.
 */
function DraftControl(props) {
  const { root, path, onDrafted } = props
  const [settings, setSettings] = react.useState(readGenerateSettings)
  const [instruction, setInstruction] = react.useState('')
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState(null)
  const [receipt, setReceipt] = react.useState(null)
  const catalog = useCatalog(true)
  const mode = settings.draftMode ?? 'continue'

  const update = (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    writeGenerateSettings(next)
  }

  const run = () => {
    setBusy(true)
    setError(null)
    setReceipt(null)
    const [provider, model] = (settings.modelKey ?? '').split('/')
    fetch(api(`${API}/draft`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({
        root,
        path,
        mode,
        instruction,
        styleId: settings.styleId ?? '',
        provider: provider === '' || provider === undefined ? null : provider,
        model: model === '' || model === undefined ? null : model,
      }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        onDrafted(body.text, body.mode ?? mode)
        setReceipt({
          model: `${body.provider} · ${body.model}`,
          tokens: body.usage?.totalTokens ?? null,
          words: body.wordCount ?? null,
          contextUsed: body.contextUsed !== false,
        })
      })
      .catch((failure) => setError(String(failure?.message ?? failure)))
      .finally(() => setBusy(false))
  }

  if (isBlank(path)) return null

  return h(
    'div',
    { style: { marginBottom: '12px', padding: '10px', border: `1px solid ${muted}`, borderRadius: '6px' } },
    h('div', { style: { fontSize: '12px', opacity: 0.6, marginBottom: '6px' } }, '让 AI 写这一章'),
    h('input', {
      type: 'text',
      value: instruction,
      placeholder: '本次要求，例如「写主角走进荒废的山门」',
      onChange: (event) => setInstruction(event.target.value),
      style: { ...inputStyle, width: '100%', marginBottom: '6px', boxSizing: 'border-box' },
    }),
    h(
      'div',
      { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', fontSize: '11px' } },
      h(
        'select',
        {
          value: mode,
          onChange: (event) => update({ draftMode: event.target.value }),
          style: { ...inputStyle, padding: '2px 4px' },
        },
        ...DRAFT_MODE_LABELS.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
      ),
      h(
        'select',
        {
          value: settings.styleId ?? '',
          onChange: (event) => update({ styleId: event.target.value }),
          style: { ...inputStyle, padding: '2px 4px' },
        },
        h('option', { value: '' }, '不限风格'),
        ...catalog.styles.map((style) => h('option', { key: style.id, value: style.id }, style.label)),
      ),
      h(
        'select',
        {
          value: settings.modelKey ?? '',
          onChange: (event) => update({ modelKey: event.target.value }),
          style: { ...inputStyle, padding: '2px 4px' },
        },
        h('option', { value: '' }, catalog.loading === true ? '载入中…' : '自动选模型'),
        ...modelChoices(catalog.models).map((choice) =>
          h('option', { key: `${choice.provider}/${choice.model}`, value: `${choice.provider}/${choice.model}` }, choice.label),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, marginLeft: 'auto' },
          disabled: busy === true,
          onClick: run,
        },
        busy === true ? '写作中…（可能要十几秒）' : '生成正文',
      ),
    ),
    error !== null
      ? h('div', { style: { fontSize: '11px', color: '#e5534b', marginTop: '6px', lineHeight: 1.6 } }, error)
      : null,
    receipt !== null
      ? h(
          'div',
          { style: { fontSize: '10px', opacity: 0.45, marginTop: '6px', lineHeight: 1.6 } },
          `由 ${receipt.model} 写入${receipt.words === null || receipt.words === undefined ? '' : ` ${receipt.words} 字`}${
            receipt.tokens === null || receipt.tokens === undefined ? '' : ` · ${receipt.tokens} tokens`
          } · ${receipt.contextUsed === false ? '未结合作品设定' : '已结合本章设定与前文'} · 尚未保存，请检查后再保存`,
        )
      : null,
  )
}

/**
 * The candidates, when more than one was produced. Picking one fills the form; the
 * author still has to save.
 */
function CandidateList(props) {
  const { candidates, onPick, labelOf } = props
  if (!Array.isArray(candidates) || candidates.length < 2) return null
  return h(
    'div',
    { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' } },
    h('div', { style: { fontSize: '11px', opacity: 0.55 } }, `${candidates.length} 个备选，点一个填入：`),
    ...candidates.map((candidate, index) =>
      h(
        'div',
        {
          key: index,
          onClick: () => onPick(candidate),
          style: {
            padding: '5px 8px',
            borderRadius: '6px',
            cursor: 'pointer',
            border: `1px solid ${muted}`,
            fontSize: '12px',
            lineHeight: 1.6,
          },
        },
        h('div', { style: { fontWeight: 600 } }, labelOf(candidate)),
        candidate.description !== undefined && candidate.description !== ''
          ? h('div', { style: { fontSize: '11px', opacity: 0.6 } }, candidate.description.slice(0, 60))
          : null,
      ),
    ),
  )
}

function GenerateReceipt(props) {
  const { error, receipt } = props
  if (error === null || error === undefined) {
    if (receipt === null || receipt === undefined) return null
    if (receipt.local === true) {
      return h(
        'div',
        { style: { fontSize: '10px', opacity: 0.45, marginTop: '6px', lineHeight: 1.6 } },
        '本地模板生成 · 未消耗额度 · 内容为草稿，请检查后保存',
      )
    }
    // Saying whether the project setting was used matters: the author asked for a
    // result that fits THIS novel, and "ungrounded" is a different (weaker) thing.
    const grounded = receipt.contextUsed === false ? '未结合作品设定' : '已结合作品设定'
    return h(
      'div',
      { style: { fontSize: '10px', opacity: 0.45, marginTop: '6px', lineHeight: 1.6 } },
      `由 ${receipt.model} 生成${receipt.tokens === null || receipt.tokens === undefined ? '' : ` · ${receipt.tokens} tokens`} · ${grounded} · 内容为草稿，请检查后保存`,
    )
  }
  return h('div', { style: { fontSize: '11px', color: '#e5534b', marginTop: '6px', lineHeight: 1.6 } }, error)
}

function GenerateControl(props) {
  const { generator, hint, base, root, taken, onGenerated } = props
  const [settings, setSettings] = react.useState(readGenerateSettings)
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState(null)
  const [receipt, setReceipt] = react.useState(null)
  const [candidates, setCandidates] = react.useState(null)
  const mode = settings.mode ?? 'model'
  const catalog = useCatalog(mode === 'model')

  const update = (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    writeGenerateSettings(next)
  }

  const runLocal = () => {
    const rng = makeRng(Date.now() % 2147483647)
    const draft = generateLocalDraft(generator.kind, rng, { taken })
    onGenerated({ ...base, ...draft })
    setCandidates(null)
    setReceipt({ local: true })
  }

  const run = () => {
    if (mode === 'local') {
      runLocal()
      return
    }
    setBusy(true)
    setError(null)
    setReceipt(null)
    setCandidates(null)

    const [provider, model] = (settings.modelKey ?? '').split('/')

    fetch(api(`${API}/generate`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      // `root` grounds the prompt in this project's setting: existing names,
      // existing vocabulary, the calendar. Without it the model invents a world.
      body: JSON.stringify({
        kind: generator.kind,
        hint: hint ?? '',
        base: base ?? {},
        root,
        useContext: !isBlank(root),
        provider: provider === '' || provider === undefined ? null : provider,
        model: model === '' || model === undefined ? null : model,
        // The id, not the wording: the host owns the instruction.
        styleId: settings.styleId ?? '',
        count: settings.count ?? 1,
      }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          // The host explains itself (model failure, unparseable response, no
          // model available); surface its words rather than a status code.
          throw new Error(body?.error ?? `HTTP ${response.status}`)
        }
        const produced = Array.isArray(body.candidates) && body.candidates.length > 0 ? body.candidates : [body.value]
        onGenerated(produced[0])
        setCandidates(produced.length > 1 ? produced : null)
        setReceipt({
          model: `${body.provider} · ${body.model}`,
          tokens: body.usage?.totalTokens ?? null,
          contextUsed: body.contextUsed !== false,
        })
      })
      .catch((failure) => setError(String(failure?.message ?? failure)))
      .finally(() => setBusy(false))
  }

  return h(
    'div',
    { style: { marginBottom: '12px' } },
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, width: '100%' },
        disabled: busy === true,
        title:
          mode === 'local'
            ? '用内置表生成一个草稿，不联网、不花额度'
            : hint === '' || hint === undefined
              ? '让模型即兴生成一份草稿'
              : `以「${hint}」为方向生成`,
        onClick: run,
      },
      busy === true ? '生成中…（可能要几秒）' : mode === 'local' ? '随机生成（本地模板）' : '随机生成',
    ),
    h(GenerateOptions, { settings, onChange: update, catalog }),
    h(GenerateReceipt, { error, receipt }),
    h(CandidateList, {
      candidates,
      onPick: (chosen) => {
        onGenerated(chosen)
        setCandidates(null)
      },
      labelOf: (candidate) => candidate.name ?? candidate.title ?? candidate.id ?? '(未命名)',
    }),
  )
}

      // ==== 36-templates.js ===================================================
/**
 * 本地模板生成器 — offline, free, and deterministic.
 *
 * The model path is good at flavour and bad at being free, instant, and
 * repeatable. This is the other tool: composing names and values from tables,
 * which is what "randomly generate an item" usually means for a novelist who
 * wants twenty plausible names to choose between rather than one paragraph of
 * prose.
 *
 * Everything here is a pure function of a seed, so a generation is reproducible
 * and the suite can assert on it. `makeRng` is seeded per click, not per session,
 * so consecutive clicks differ.
 *
 * The tables ARE the "database" — edit them directly, or see README for the
 * planned per-project override.
 */

/** mulberry32: small, fast, and good enough for picking names. */
function makeRng(seed) {
  let state = (Number(seed) >>> 0) || 1
  // Guard against a seeded zero producing a constant stream.
  if (state === 0) state = 0x9e3779b9
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One entry at random. */
function pick(rng, list) {
  // The tables are documented as directly editable, so an EMPTIED table is reachable.
  // Returning undefined interpolated the word "undefined" into a generated name.
  if (!Array.isArray(list) || list.length === 0) return ''
  return list[Math.floor(rng() * list.length) % list.length]
}

/** `count` distinct entries, or as many as the list holds. */
function pickSome(rng, list, count) {
  const pool = [...list]
  const out = []
  while (out.length < count && pool.length > 0) {
    out.push(pool.splice(Math.floor(rng() * pool.length) % pool.length, 1)[0])
  }
  return out
}

/** An integer in `[min, max]`. */
function pickInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1))
}

const TABLES = {
  surname: ['李', '王', '顾', '沈', '裴', '萧', '谢', '陆', '苏', '韩', '崔', '秦', '柳', '孟', '姜', '慕容', '上官', '独孤', '南宫', '司徒'],
  givenMale: ['渊', '邈', '峥', '玄', '霖', '珩', '彦', '晏', '衍', '宸', '砚', '舟', '尘', '策', '铮', '朔', '岐', '琅'],
  givenFemale: ['霜', '宁', '棠', '筝', '绾', '婳', '昭', '珺', '漪', '菱', '若', '莞', '岚', '笺', '绫', '蘅'],
  givenTail: ['之', '卿', '生', '客', '子', '君', '翁', '娘', '郎'],
  placePrefix: ['青云', '寒鸦', '碧水', '落霞', '苍梧', '玄冰', '断魂', '望川', '孤山', '赤霄', '白帝', '枯荣', '照影', '暮云', '碎星', '沉钟'],
  placeSuffix: ['城', '关', '谷', '潭', '峰', '宗', '门', '驿', '渡', '原', '林', '窟', '海', '台', '川', '渊'],
  orgPrefix: ['天', '玄', '青', '赤', '九', '太', '幽', '灵', '苍', '寒', '白', '无'],
  orgMid: ['云', '霄', '墟', '冥', '阳', '阴', '极', '元', '华', '清', '寂', '照'],
  orgSuffix: ['宗', '门', '殿', '阁', '盟', '会', '谷', '教', '楼', '堂', '府', '司'],
  itemMaterial: ['玄铁', '寒玉', '赤铜', '乌木', '霜晶', '龙骨', '雷击木', '沉银'],
  itemForm: ['剑', '刀', '枪', '镜', '灯', '印', '铃', '扇', '鼎', '幡', '琴', '笔'],
  itemQualifier: ['霜啼', '照雪', '断虹', '沉渊', '残夜', '离尘', '不周', '青冥', '照影', '碎星', '无咎', '重华'],
  rarity: ['凡品', '灵品', '玄品', '地阶', '天阶', '神品'],
  placeKind: ['城池', '山门', '秘境', '渡口', '关隘', '废墟', '洞天'],
  orgKind: ['宗门', '王朝', '商会', '义军', '世家', '教派'],
  eventVerb: ['倒戈', '围城', '失守', '缔约', '叛离', '登位', '屠戮', '封禅', '沉没', '开山'],
  eventNoun: ['寒鸦关', '青云宗', '北境', '雁回关', '落日原', '王城', '寒潭', '旧盟', '长夜'],
}

/** A name that is not already in use, if one can be found quickly. */
function novelName(rng, taken, build) {
  const used = new Set(taken ?? [])
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const name = build()
    if (!used.has(name)) return name
  }
  // Better a duplicate than an infinite loop; the author can rename.
  return build()
}

/** 姓 + 名, one or two characters. */
function personName(rng, taken) {
  return novelName(rng, taken, () => {
    const surname = pick(rng, TABLES.surname)
    const pool = rng() < 0.5 ? TABLES.givenMale : TABLES.givenFemale
    let given
    if (rng() < 0.35) {
      given = pick(rng, TABLES.givenTail)
    } else if (rng() < 0.4) {
      // A two-character given name must not repeat a character: 萧朔朔 is not a
      // name, it is a bug the author would have to notice and fix.
      const [first, second] = pickSome(rng, pool, 2)
      given = second === undefined ? first : `${first}${second}`
    } else {
      given = pick(rng, pool)
    }
    return `${surname}${given}`
  })
}

/** A place name: prefix + suffix, with an occasional 之 in between. */
function placeName(rng, taken) {
  return novelName(rng, taken, () => {
    const prefix = pick(rng, TABLES.placePrefix)
    const suffix = pick(rng, TABLES.placeSuffix)
    return rng() < 0.25 ? `${prefix}之${suffix}` : `${prefix}${suffix}`
  })
}

/** An organization name: prefix + middle + suffix. */
function orgName(rng, taken) {
  return novelName(rng, taken, () => {
    const prefix = pick(rng, TABLES.orgPrefix)
    const mid = rng() < 0.6 ? pick(rng, TABLES.orgMid) : ''
    return `${prefix}${mid}${pick(rng, TABLES.orgSuffix)}`
  })
}

/** An event title: noun + verb, e.g. 寒鸦关倒戈. */
function eventTitle(rng, taken) {
  return novelName(rng, taken, () => `${pick(rng, TABLES.eventNoun)}${pick(rng, TABLES.eventVerb)}`)
}

/**
 * An item draft whose parts agree with each other.
 *
 * The form (剑/灯/印) is chosen ONCE and used for the name, the 器型 attribute, and
 * the tag. Picking it independently in each place produced items like 「重华剑」
 * with 器型 灯 and tag 印 — three fields contradicting each other in one draft.
 *
 * This does not use `novelName`: deciding 材质 outside the retry meant the
 * material-named branch returned the same string on every attempt, so a taken name
 * was "retried" twelve times identically and then accepted. The material has to be
 * re-picked per attempt AND be the one the name actually uses, which is a coupled
 * constraint the shared helper cannot express.
 */
function itemDraft(rng, taken) {
  const form = pick(rng, TABLES.itemForm)
  const used = new Set(taken ?? [])
  let material = pick(rng, TABLES.itemMaterial)
  let name = ''
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (rng() < 0.5) {
      name = `${pick(rng, TABLES.itemQualifier)}${form}`
    } else {
      material = pick(rng, TABLES.itemMaterial)
      name = `${material}${form}`
    }
    if (!used.has(name)) break
  }
  return {
    name,
    rarity: pick(rng, TABLES.rarity),
    attrs: { 材质: material, 器型: form },
    tags: [form],
  }
}

/**
 * A draft entity of `kind` filled from the tables.
 *
 * Only the fields the local tables can honestly fill: prose fields (外貌, 性格,
 * 影响) are deliberately left as the author's own, because a template cannot write
 * them without pretending to be the model. The value of this path is names and
 * classifications, not description.
 */
function generateLocalDraft(kind, rng, options = {}) {
  const taken = Array.isArray(options.taken) ? options.taken : []

  if (kind === 'item') return itemDraft(rng, taken)
  if (kind === 'character') {
    return {
      name: personName(rng, taken),
      gender: rng() < 0.5 ? '男' : '女',
      // 人类 weighted, because a novel's cast usually is; the tables are meant to
      // be edited to match the author's world.
      race: pick(rng, ['人类', '人类', '人类', '妖族', '灵族']),
      ageNote: `${pickInt(rng, 16, 70)} 岁上下`,
      tags: pickSome(rng, ['老成', '孤僻', '果决', '温和', '多疑', '重诺', '悍勇', '沉稳'], 2),
    }
  }
  if (kind === 'place') {
    return {
      name: placeName(rng, taken),
      kind: pick(rng, TABLES.placeKind),
      tags: pickSome(rng, ['险要', '幽深', '荒废', '繁华', '苦寒', '灵脉'], 2),
    }
  }
  if (kind === 'organization') {
    return {
      name: orgName(rng, taken),
      kind: pick(rng, TABLES.orgKind),
      founded: { year: pickInt(rng, 1, 900), month: null, day: null },
      tags: pickSome(rng, ['尚武', '重商', '隐秘', '古老', '新兴', '正统'], 2),
    }
  }
  if (kind === 'timeline-event') {
    return {
      title: eventTitle(rng, taken),
      at: { year: pickInt(rng, options.minYear ?? 1, options.maxYear ?? 1000), month: pickInt(rng, 1, 12), day: null },
      spanEnd: null,
      atLabel: '',
    }
  }
  return {}
}

/** Whether a kind has a local generator. Mirrors the host's generator table. */
const LOCAL_KINDS = ['item', 'character', 'place', 'organization', 'timeline-event']

      // ==== 40-tree.js ========================================================
/**
 * EntityTree — a forest of groups with leaves hanging off them.
 *
 * Generic over the descriptor: `tree.groups` are joined into a forest by their
 * `parentKey` and `tree.leaves` attach to a group by theirs, so the component
 * never learns what an "item" or a "category" is. That is what lets 人物/组织 later
 * reuse it with a different descriptor instead of a second tree implementation.
 *
 * Selection is reported as `{ entity, id }` — the entity kind, not just an id —
 * because the detail pane has to pick a schema, and an id alone cannot say
 * whether it names a category or an item.
 */

/** Index a document against its tree descriptor. */
function indexTree(doc, tree) {
  const groupSpec = tree.groups[0]
  // A groups-only forest is legitimate — outline nodes nest by `parentId` and
  // have no leaf collection — so the leaf spec is optional rather than required.
  const leafSpec = Array.isArray(tree.leaves) && tree.leaves.length > 0 ? tree.leaves[0] : null
  // `objectList`, not `Array.isArray ? x : []`: a hand-edited file with a null or a
  // string in the list passes the container check and then crashes every read below.
  const groups = objectList(doc[groupSpec.key])
  const leaves = leafSpec === null ? [] : objectList(doc[leafSpec.key])

  const groupChildren = new Map()
  for (const group of groups) {
    const parent = group[groupSpec.parentKey] ?? null
    if (!groupChildren.has(parent)) groupChildren.set(parent, [])
    groupChildren.get(parent).push(group)
  }
  const leavesByGroup = new Map()
  for (const leaf of leaves) {
    const parent = leaf[leafSpec.parentKey] ?? null
    if (!leavesByGroup.has(parent)) leavesByGroup.set(parent, [])
    leavesByGroup.get(parent).push(leaf)
  }

  const byOrder = (a, b) => (Number(a.order ?? 0) - Number(b.order ?? 0)) || String(a.id).localeCompare(String(b.id))
  for (const list of groupChildren.values()) list.sort(byOrder)
  for (const list of leavesByGroup.values()) list.sort(byOrder)

  return { groupSpec, leafSpec, groups, leaves, groupChildren, leavesByGroup }
}

function TreeRow(props) {
  const { depth, title, badge, selected, hasChildren, expanded, onToggle, onClick, dim } = props
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        paddingLeft: `${8 + depth * 14}px`,
        borderRadius: '6px',
        fontSize: '13px',
        cursor: 'pointer',
        background: selected ? 'rgba(128,128,128,0.16)' : 'transparent',
        opacity: dim ? 0.6 : 1,
      },
      onClick,
    },
    hasChildren
      ? h(
          'span',
          {
            style: { width: '12px', display: 'inline-block', opacity: 0.6, userSelect: 'none' },
            onClick: (event) => {
              event.stopPropagation()
              onToggle()
            },
          },
          expanded ? '▾' : '▸',
        )
      : h('span', { style: { width: '12px', display: 'inline-block' } }),
    h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
    badge !== undefined && badge !== null ? h('span', { style: { fontSize: '11px', opacity: 0.45 } }, badge) : null,
  )
}

/**
 * @param doc - the whole document (e.g. `setting/items.json`).
 * @param tree - the branch's `tree` descriptor.
 * @param selection - `{ entity, id }` or null.
 * @param onSelect - called with `{ entity, id }`.
 * @param onMutate - receives a pure transform of the document.
 */
/**
 * Whether a spec says which field holds the parent.
 *
 * Nesting is only offered when it does. Without this, the "new child" action would
 * append a node with no parent link — it would look like it worked and then appear
 * at the top level.
 */
function supportsNesting(spec) {
  return spec !== null && spec !== undefined && typeof spec.parentKey === 'string' && spec.parentKey !== ''
}

/**
 * The node a "new child" action should append.
 *
 * Pure, and it guards a real trap: the parent link is written as
 * `created[spec.parentKey] = parentId`. A spec declaring no `parentKey` would
 * therefore write a key literally named `undefined` — harmless only as long as every
 * spec happened to declare one, and silently corrupting the document the moment one
 * did not.
 */
function childNodeFor(spec, entity, parentId, taken) {
  const blank = entity.blank()
  const id = mintId(spec.idPrefix ?? entity.idPrefix, blank.name ?? blank.title ?? 'entry', taken)
  const created = { id, ...blank }
  if (supportsNesting(spec)) {
    // Explicit `null` for a root, not an absent key: `JSON.stringify` drops
    // `undefined`, so the field would vanish from the file and "at the top level"
    // would be indistinguishable from "field not written". The documented shape
    // shows `"parentId": null`.
    created[spec.parentKey] = parentId === undefined ? null : parentId
  }
  return created
}

/**
 * The tree half: groups and their leaves.
 *
 * Split out of `EntityTree` so a branch may declare flat `collections` beside its
 * tree, or instead of one. `taken` is passed in because ids must not collide
 * across a branch's lists, not merely within one of them.
 */
function TreePane(props) {
  const { doc, tree, selection, onSelect, onMutate, taken } = props
  const [collapsed, setCollapsed] = react.useState(() => new Set())
  const index = indexTree(doc, tree)
  const { groupSpec, leafSpec, groupChildren, leavesByGroup } = index

  const toggle = (id) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const isSelected = (entity, id) => selection !== null && selection.entity === entity && selection.id === id

  const addGroup = (parentId) => {
    const created = childNodeFor(groupSpec, ENTITIES[groupSpec.entity], parentId, taken)
    onMutate((current) => ({
      ...current,
      [groupSpec.key]: [...(current[groupSpec.key] ?? []), created],
    }))
    onSelect({ entity: groupSpec.entity, id: created.id })
  }

  const addLeaf = (groupId) => {
    if (leafSpec === null) return
    const created = childNodeFor(leafSpec, ENTITIES[leafSpec.entity], groupId, taken)
    onMutate((current) => ({
      ...current,
      [leafSpec.key]: [...(current[leafSpec.key] ?? []), created],
    }))
    onSelect({ entity: leafSpec.entity, id: created.id })
  }

  const renderGroup = (group, depth) => {
    const children = groupChildren.get(group.id) ?? []
    const leaves = leavesByGroup.get(group.id) ?? []
    const hasChildren = children.length > 0 || leaves.length > 0
    const expanded = !collapsed.has(group.id)
    return h(
      react.Fragment,
      { key: group.id },
      h(TreeRow, {
        depth,
        title: ENTITIES[groupSpec.entity].titleOf(group),
        badge: leaves.length > 0 ? leaves.length : null,
        selected: isSelected(groupSpec.entity, group.id),
        hasChildren,
        expanded,
        onToggle: () => toggle(group.id),
        onClick: () => onSelect({ entity: groupSpec.entity, id: group.id }),
      }),
      expanded
        ? h(
            react.Fragment,
            null,
            ...children.map((child) => renderGroup(child, depth + 1)),
            ...leaves.map((leaf) =>
              h(TreeRow, {
                key: leaf.id,
                depth: depth + 1,
                title: ENTITIES[leafSpec.entity].titleOf(leaf),
                selected: isSelected(leafSpec.entity, leaf.id),
                hasChildren: false,
                dim: true,
                onClick: () => onSelect({ entity: leafSpec.entity, id: leaf.id }),
              }),
            ),
          )
        : null,
    )
  }

  const roots = groupChildren.get(null) ?? []
  const orphanLeaves = leavesByGroup.get(null) ?? []
  const selectedGroupId =
    selection !== null && selection.entity === groupSpec.entity ? selection.id : null

  return h(
    'div',
    null,
    h(
      'div',
      { style: { display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' } },
      h('button', { type: 'button', style: buttonStyle, onClick: () => addGroup(null) }, `新建${groupSpec.label}`),
      // Nesting was supported by the data model and by the renderer, but there was no
      // control to create a child — so a sub-category, a sub-place, a sub-organization
      // or a subordinate position could not be created in ANY branch. One button
      // fixes all of them, because they all walk this component.
      supportsNesting(groupSpec)
        ? h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle, opacity: selectedGroupId === null ? 0.5 : 1 },
              disabled: selectedGroupId === null,
              title: selectedGroupId === null ? `先在列表里选中一个上级${groupSpec.label}` : '',
              onClick: () => addGroup(selectedGroupId),
            },
            selectedGroupId === null ? `在选中${groupSpec.label}下新建` : `在选中${groupSpec.label}下新建下级`,
          )
        : null,
      leafSpec === null
        ? null
        : h(
            'button',
            { type: 'button', style: buttonStyle, onClick: () => addLeaf(selectedGroupId) },
            selectedGroupId === null ? `新建${leafSpec.label}（未归类）` : `在选中分类下新建${leafSpec.label}`,
          ),
    ),
    roots.length === 0 && orphanLeaves.length === 0
      ? h(Note, { text: `还没有${groupSpec.label}。${leafSpec === null ? '' : '先建一个分类，再往里添加。'}` })
      : h(
          'div',
          null,
          ...roots.map((group) => renderGroup(group, 0)),
          ...orphanLeaves.map((leaf) =>
            h(TreeRow, {
              key: leaf.id,
              depth: 0,
              title: ENTITIES[leafSpec.entity].titleOf(leaf),
              selected: isSelected(leafSpec.entity, leaf.id),
              hasChildren: false,
              dim: true,
              onClick: () => onSelect({ entity: leafSpec.entity, id: leaf.id }),
            }),
          ),
        ),
  )
}

/**
 * A flat collection: a heading, a count, an add button, and one row per entity.
 *
 * This is what makes a branch's `collections` declaration real. They previously
 * only fed the detail-pane lookup, so a descriptor could promise a list that no
 * view ever drew — a silent trap for the next entity kind.
 */
function CollectionPane(props) {
  const { doc, spec, selection, onSelect, onMutate, taken } = props
  const entity = ENTITIES[spec.entity]
  const label = spec.label ?? entity.label
  const list = objectList(doc[spec.key])
  const sorted = [...list].sort(
    (a, b) => (Number(a.order ?? 0) - Number(b.order ?? 0)) || String(a.id).localeCompare(String(b.id)),
  )

  const add = () => {
    const blank = entity.blank()
    const id = mintId(spec.idPrefix ?? entity.idPrefix, blank.name ?? blank.title ?? 'entry', taken)
    onMutate((current) => ({ ...current, [spec.key]: [...(current[spec.key] ?? []), { id, ...blank }] }))
    onSelect({ entity: spec.entity, id })
  }

  return h(
    'div',
    { style: { marginBottom: '12px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
      h('span', { style: { fontSize: '11px', opacity: 0.5 } }, `${label}（${list.length}）`),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, padding: '1px 7px', fontSize: '11px' },
          title: `新建${label}`,
          onClick: add,
        },
        '＋',
      ),
    ),
    sorted.length === 0
      ? h(Note, { text: `还没有${label}。` })
      : h(
          'div',
          null,
          ...sorted.map((entry) =>
            h(TreeRow, {
              key: entry.id,
              depth: 0,
              title: entity.titleOf(entry),
              selected: selection !== null && selection.entity === spec.entity && selection.id === entry.id,
              hasChildren: false,
              onClick: () => onSelect({ entity: spec.entity, id: entry.id }),
            }),
          ),
        ),
  )
}

/**
 * Remove a position and everything beneath it.
 *
 * Pure, and separated out because the subtle part is the subtree: deleting only the
 * node would leave children whose `parentId` points at nothing, which the tree
 * cannot place and the validator reports as a dangling reference.
 */
function removePositionSubtree(positions, id) {
  const list = objectList(positions)
  const doomed = new Set([id])
  // Repeat until no new descendants are found: a single pass would miss a
  // grandchild whose parent was added later in the same loop.
  let grew = true
  while (grew) {
    grew = false
    for (const position of list) {
      if (doomed.has(position.parentId) && !doomed.has(position.id)) {
        doomed.add(position.id)
        grew = true
      }
    }
  }
  return list.filter((position) => !doomed.has(position.id))
}

/** The selected position's fields plus a delete control. */
function PositionEditor(props) {
  const { position, onPatch, onRemove } = props
  return h(
    'div',
    { style: { marginTop: '10px', borderTop: `1px solid ${muted}`, paddingTop: '10px' } },
    h(SchemaForm, {
      entity: { fields: ENTITIES['org-position'].fields },
      value: position,
      onPatch,
    }),
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, marginTop: '10px', color: '#e5534b', borderColor: muted },
        onClick: onRemove,
      },
      '删除这个职位（含下属）',
    ),
  )
}

/**
 * Editor for an array that self-nests by `parentId` — an organization's positions.
 *
 * It reuses `TreePane` by handing it a synthetic one-collection document, because
 * `structure` has exactly the shape `TreePane` already walks: a flat array plus a
 * parent key. Writing a second tree would have meant a second place to get
 * add/indent/order wrong.
 *
 * The only thing `TreePane` does not do is delete: at the branch level, deletion
 * lives in the detail pane's form. Here the selected position gets its own small
 * form and a delete control, so nothing has to be removed by editing JSON.
 */
function StructureInput(props) {
  const { value, onChange } = props
  const [selectedId, setSelectedId] = react.useState(null)
  const positions = objectList(value)
  const doc = { positions }
  const tree = {
    groups: [{ key: 'positions', entity: 'org-position', parentKey: 'parentId', label: '职位', idPrefix: 'pos-' }],
    leaves: [],
  }
  const selected = positions.find((position) => position.id === selectedId) ?? null
  const taken = new Set(positions.map((position) => position.id))

  // TreePane mutates a document; this field owns only the array inside it.
  const mutate = (mutator) => {
    const next = mutator(doc)
    onChange(Array.isArray(next.positions) ? next.positions : [])
  }

  const patchSelected = (patch) => {
    if (selected === null) return
    mutate((current) => ({
      positions: current.positions.map((position) =>
        position.id === selected.id ? { ...position, ...patch } : position,
      ),
    }))
  }

  const removeSelected = () => {
    if (selected === null) return
    mutate((current) => ({ positions: removePositionSubtree(current.positions, selected.id) }))
    setSelectedId(null)
  }

  return h(
    'div',
    null,
    h(TreePane, {
      doc,
      tree,
      selection: selectedId === null ? null : { entity: 'org-position', id: selectedId },
      onSelect: (next) => setSelectedId(next === null ? null : next.id),
      onMutate: mutate,
      taken,
    }),
    selected === null
      ? h(
          'div',
          { style: { marginTop: '8px', fontSize: '11px', opacity: 0.45, lineHeight: 1.7 } },
          '选中一个职位可改名、调序或删除。任职者用「关系网」里的成员关系表示——职位定义与任职是两件事，各只有一个真相源。',
        )
      : h(PositionEditor, { position: selected, onPatch: patchSelected, onRemove: removeSelected }),
  )
}

/**
 * The entity tree for a branch: its hierarchy and/or its flat collections.
 *
 * @param tree - optional; a branch may declare only `collections`.
 * @param collections - `[{ key, entity, label, idPrefix }]`.
 */
function EntityTree(props) {
  const { doc, tree, collections, selection, onSelect, onMutate } = props
  const lists = Array.isArray(collections) ? collections : []
  const hasTree = tree !== undefined && tree !== null && Array.isArray(tree.groups) && tree.groups.length > 0

  // Ids already in use anywhere in this branch, so a minted id cannot collide
  // with a sibling collection.
  const taken = react.useMemo(() => {
    const set = new Set()
    if (hasTree) {
      const index = indexTree(doc, tree)
      for (const group of index.groups) set.add(group.id)
      for (const leaf of index.leaves) set.add(leaf.id)
    }
    for (const spec of lists) {
      for (const entry of objectList(doc[spec.key])) set.add(entry.id)
    }
    return set
  }, [doc, tree, collections])

  return h(
    'div',
    null,
    hasTree ? h(TreePane, { doc, tree, selection, onSelect, onMutate, taken }) : null,
    ...lists.map((spec) =>
      h(CollectionPane, { key: spec.key, doc, spec, selection, onSelect, onMutate, taken }),
    ),
  )
}

      // ==== 45-graph.js =======================================================
/**
 * RelationGraph — the relationship network over `relations.json`.
 *
 * Two things make this more than a drawing:
 *
 *   - **Time.** Edge intervals are the model's whole point (docs/data-model.md
 *     §4.8): "who is allied with whom" is only answerable relative to a moment, so
 *     the view carries a cursor and shows only the relations in force at it.
 *     Everything at or before the cursor is real; later ones are not yet.
 *
 *   - **Determinism.** The layout is a pure function of its inputs — no random
 *     seed, no animation loop, no DOM measurement — so the same data always draws
 *     the same picture and the suite can assert on it. A physics loop that
 *     measured the DOM could not be tested outside a browser, which is exactly how
 *     earlier layout bugs reached the user.
 *
 * `timeKey` and its helpers are shared with `50-timeline.js` (same closure, so no
 * import), and `client-selftest.mjs` cross-checks them against the host's copy.
 */

/**
 * The edges in force at a moment.
 *
 * `since` is inclusive and `until` exclusive, so an edge ending exactly when
 * another begins leaves no gap and no overlap — the handover convention the
 * validator enforces.
 */
function edgesActiveAt(edges, cursorKey) {
  if (cursorKey === null || cursorKey === undefined) return edges
  return edges.filter((edge) => {
    const start = timeKey(edge.since)
    // An unusable `since` keeps the edge visible rather than silently dropping it:
    // hiding data because it is malformed makes the malformation unfindable.
    if (start !== null && start > cursorKey) return false
    const end = edge.until === null || edge.until === undefined ? null : timeKey(edge.until)
    if (end === null) return true
    return cursorKey < end
  })
}

/**
 * The part of the network a view should draw.
 *
 * Defaults to the focus kinds ALONE — the 人物 graph is about people, the 组织
 * graph is about organizations. An earlier version instead kept every node kind
 * and only filtered which *edges* to show, so a neighbour dragged organizations
 * and places into the character graph: the view was centred on people but its
 * contents were whatever happened to be attached.
 *
 * `includeOthers` widens it to the focus kinds plus everything directly joined to
 * them, which is how a membership (`人物 —隶属→ 组织`) becomes visible. Off by
 * default, because that is a different question from "who relates to whom".
 *
 * An edge is only drawn when BOTH ends are present: an edge to a node the view
 * excludes cannot be placed, and counting it would misreport the totals.
 */
function visibleNetwork(nodes, edges, options = {}) {
  const focusKinds = Array.isArray(options.focusKinds) ? options.focusKinds : []
  const includeOthers = options.includeOthers === true

  const focusNodes = focusKinds.length === 0 ? nodes : nodes.filter((node) => focusKinds.includes(node.kind))
  const focusIds = new Set(focusNodes.map((node) => node.id))

  const touching = edges.filter((edge) => focusIds.has(edge.from) || focusIds.has(edge.to))
  const keepIds = new Set(focusIds)
  if (includeOthers) {
    for (const edge of touching) {
      keepIds.add(edge.from)
      keepIds.add(edge.to)
    }
  }

  const keptNodes = nodes.filter((node) => keepIds.has(node.id))
  const keptEdges = edges.filter((edge) => keepIds.has(edge.from) && keepIds.has(edge.to))
  return { nodes: keptNodes, edges: keptEdges }
}

/**
 * Force-directed layout, deterministic and self-contained.
 *
 * Fruchterman–Reingold in spirit: every pair repels, every edge pulls, and a
 * cooling schedule bounds how far a node may move per step. Nodes start on a
 * circle in input order, which is what makes the result reproducible — a random
 * start would draw a different picture on every render and make the output
 * untestable.
 *
 * Iterations scale down with node count, because the repulsion pass is O(n²):
 * a few hundred steps for a handful of characters, a few dozen for a saga, where
 * the layout is approximate anyway and responsiveness matters more.
 */
function layoutForce(nodes, edges, options = {}) {
  const width = options.width ?? 720
  const height = options.height ?? 480
  const count = nodes.length
  const positions = new Map()
  if (count === 0) return positions
  if (count === 1) {
    positions.set(nodes[0].id, { x: width / 2, y: height / 2 })
    return positions
  }

  const iterations = options.iterations ?? Math.max(60, Math.min(300, Math.round(6000 / count)))
  const area = width * height
  const k = Math.sqrt(area / count)
  const radius = Math.min(width, height) * 0.32

  nodes.forEach((node, index) => {
    const angle = (index / count) * Math.PI * 2
    positions.set(node.id, {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    })
  })

  const ids = nodes.map((node) => node.id)
  const links = edges
    .map((edge) => ({ from: edge.from, to: edge.to }))
    .filter((link) => positions.has(link.from) && positions.has(link.to) && link.from !== link.to)

  const margin = 26
  let temperature = Math.min(width, height) * 0.1

  for (let step = 0; step < iterations; step += 1) {
    const disp = new Map(ids.map((id) => [id, { x: 0, y: 0 }]))

    // Repulsion between every pair.
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions.get(ids[i])
        const b = positions.get(ids[j])
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distance = Math.hypot(dx, dy)
        if (distance < 0.01) {
          // Coincident nodes would divide by zero; nudge deterministically.
          dx = (i - j) * 0.01
          dy = 0.01
          distance = Math.hypot(dx, dy)
        }
        const force = (k * k) / distance
        const ux = (dx / distance) * force
        const uy = (dy / distance) * force
        const da = disp.get(ids[i])
        const db = disp.get(ids[j])
        da.x += ux
        da.y += uy
        db.x -= ux
        db.y -= uy
      }
    }

    // Attraction along edges.
    for (const link of links) {
      const a = positions.get(link.from)
      const b = positions.get(link.to)
      const dx = a.x - b.x
      const dy = a.y - b.y
      const distance = Math.max(0.01, Math.hypot(dx, dy))
      const force = (distance * distance) / k
      const ux = (dx / distance) * force
      const uy = (dy / distance) * force
      const da = disp.get(link.from)
      const db = disp.get(link.to)
      da.x -= ux
      da.y -= uy
      db.x += ux
      db.y += uy
    }

    for (const id of ids) {
      const point = positions.get(id)
      const delta = disp.get(id)
      const length = Math.max(0.01, Math.hypot(delta.x, delta.y))
      const limited = Math.min(length, temperature)
      point.x += (delta.x / length) * limited
      point.y += (delta.y / length) * limited
      point.x = Math.max(margin, Math.min(width - margin, point.x))
      point.y = Math.max(margin, Math.min(height - margin, point.y))
    }

    temperature *= 0.97
  }

  return positions
}

/** Incident edges for a node, for the read-only node summary. */
function edgesTouching(edges, nodeId) {
  return edges.filter((edge) => edge.from === nodeId || edge.to === nodeId)
}

/**
 * The key under which the relationship network's manual positions are stored in
 * `views/layout.json` (`{ graphs: { relations: { positions: { id: {x,y} } } } }`).
 *
 * One key for both the 人物 and 组织 tabs: positions belong to NODES, and the two
 * tabs show overlapping sets of the same nodes. Per-tab keys would let the same
 * person sit in two places.
 */
const GRAPH_LAYOUT_KEY = 'relations'

/**
 * Convert a pointer position into SVG viewBox coordinates.
 *
 * Pure, and separated out on purpose: the ONE part of dragging that cannot be
 * tested is reading the element's rectangle, because `renderToString` has no
 * layout. Keeping the arithmetic here means the arithmetic is still verified, and
 * only the measurement is taken on faith.
 */
function clientToViewBox(point, rect, width, height) {
  if (rect === null || rect === undefined || rect.width === 0 || rect.height === 0) return null
  const x = ((point.clientX - rect.left) / rect.width) * width
  const y = ((point.clientY - rect.top) / rect.height) * height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/** Keep a dragged node inside the canvas, so it cannot be lost off-screen. */
function clampToBox(point, width, height, margin = 14) {
  // `Math.min`/`Math.max` propagate NaN, and `JSON.stringify` turns NaN into null — so a
  // NaN placement was written, then rejected on reload, losing it with no explanation.
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return { x: width / 2, y: height / 2 }
  return {
    x: Math.max(margin, Math.min(width - margin, point.x)),
    y: Math.max(margin, Math.min(height - margin, point.y)),
  }
}

/**
 * Final positions: a manual placement wins over the computed layout.
 *
 * Nodes without a manual position keep their force-layout place, so dropping one
 * node does not disturb the rest — which is the whole reason to move one by hand.
 */
function mergePositions(forcePositions, manual, nodeIds) {
  const merged = new Map()
  const placed = manual !== null && typeof manual === 'object' ? manual : {}
  for (const id of nodeIds) {
    const override = placed[id]
    const usable =
      override !== null &&
      override !== undefined &&
      Number.isFinite(override.x) &&
      Number.isFinite(override.y)
    const point = usable ? { x: override.x, y: override.y } : forcePositions.get(id)
    if (point !== undefined) merged.set(id, point)
  }
  return merged
}

/** Record a manual placement, dropping anything unusable. */
function setManualPosition(manual, nodeId, point) {
  const placed = manual !== null && typeof manual === 'object' ? manual : {}
  if (point === null || point === undefined || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return placed
  }
  return { ...placed, [nodeId]: { x: point.x, y: point.y } }
}

/**
 * Forget the manual placements for the given nodes, leaving other nodes' alone.
 *
 * The graph is shown one focus at a time, so "reset" must not silently throw away
 * placements made in the other tab.
 */
function clearManualPositions(manual, nodeIds) {
  const placed = manual !== null && typeof manual === 'object' ? manual : {}
  const next = { ...placed }
  for (const id of nodeIds) delete next[id]
  return next
}

/** How many of the given nodes have a manual placement. */
function countManualPositions(manual, nodeIds) {
  const placed = manual !== null && typeof manual === 'object' ? manual : {}
  let count = 0
  for (const id of nodeIds) {
    const point = placed[id]
    if (point !== null && point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y)) count += 1
  }
  return count
}

/**
 * @param nodes - `{ id, title, kind }`.
 * @param edges - raw edges from `relations.json`.
 * @param types - the document's type registry, for labels and direction.
 */
function RelationGraph(props) {
  const {
    types, positions, width, height, selection, onSelect,
    svgRef, dragging, onNodePointerDown, onPointerMove, onPointerUp,
  } = props
  // Guarded here as well as at the call site: a component that only survives when its
  // caller pre-filters is one refactor away from taking the panel down again.
  const nodes = objectList(props.nodes)
  const edges = objectList(props.edges)
  const typeById = new Map(objectList(types).map((type) => [type.id, type]))
  const titleOf = new Map(nodes.map((node) => [node.id, node.title]))
  const selectedEdge = selection !== null && selection.entity === 'relation-edge' ? selection.id : null
  const selectedNode = selection !== null && selection.entity === 'graph-node' ? selection.id : null

  return h(
    'svg',
    {
      ref: svgRef,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': `关系网：${nodes.length} 个节点，${edges.length} 条关系`,
      onPointerMove,
      onPointerUp,
      // Leaving the canvas must end the drag, or the node would keep following the
      // pointer after the button was released outside it.
      onPointerLeave: onPointerUp,
      style: {
        width: '100%',
        height: 'auto',
        maxHeight: '70vh',
        color: 'inherit',
        background: 'transparent',
        // Without this a drag scrolls the pane on touch devices instead of moving
        // the node.
        touchAction: 'none',
      },
    },
    ...edges.map((edge) => {
      const a = positions.get(edge.from)
      const b = positions.get(edge.to)
      if (a === undefined || b === undefined) return null
      const type = typeById.get(edge.type)
      const active = edge.id === selectedEdge
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      return h(
        'g',
        { key: edge.id },
        h('line', {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          stroke: 'currentColor',
          strokeWidth: active ? 2.4 : 1.2,
          // Undirected types are dashed, so the graph says which relations have a
          // direction without needing a legend.
          strokeDasharray: type?.directed === false ? '5 4' : undefined,
          opacity: active ? 0.95 : 0.4,
        }),
        h(
          'text',
          {
            x: midX,
            y: midY - 4,
            fontSize: 10,
            textAnchor: 'middle',
            fill: 'currentColor',
            opacity: active ? 0.95 : 0.55,
          },
          type?.label ?? edge.type,
        ),
        // A line is a hard click target; this transparent disc at the midpoint is
        // what actually opens the edge.
        h('circle', {
          cx: midX,
          cy: midY,
          r: 9,
          fill: 'transparent',
          style: { cursor: 'pointer' },
          onClick: () => onSelect({ entity: 'relation-edge', id: edge.id }),
        }),
        h('title', null, `${titleOf.get(edge.from) ?? edge.from} — ${titleOf.get(edge.to) ?? edge.to}：${type?.label ?? edge.type}`),
      )
    }),
    ...nodes.map((node) => {
      const point = positions.get(node.id)
      if (point === undefined) return null
      const active = node.id === selectedNode
      const held = node.id === dragging
      return h(
        'g',
        {
          key: node.id,
          style: { cursor: held === true ? 'grabbing' : 'grab' },
          onClick: () => onSelect({ entity: 'graph-node', id: node.id }),
          onPointerDown: (event) => onNodePointerDown(node.id, event),
        },
        // A generous invisible disc under the visible one: the label sits below the
        // circle, and a 12px target is not comfortable to grab.
        h('circle', { cx: point.x, cy: point.y, r: 16, fill: 'transparent' }),
        h('circle', {
          cx: point.x,
          cy: point.y,
          r: active ? 15 : 12,
          fill: held === true ? 'currentColor' : 'transparent',
          fillOpacity: held === true ? 0.25 : 0,
          stroke: 'currentColor',
          strokeWidth: active ? 2.4 : 1.2,
          opacity: active ? 1 : 0.75,
        }),
        h(
          'text',
          {
            x: point.x,
            y: point.y + 26,
            fontSize: 11,
            textAnchor: 'middle',
            fill: 'currentColor',
            // Organizations are square-ish in prose but here they are marked by
            // weight: distinguishing node kinds by shape would need a legend.
            fontWeight: node.kind === 'organization' ? 600 : 400,
          },
          node.title,
        ),
      )
    }),
  )
}

      // ==== 50-timeline.js ====================================================
/**
 * TimelineView — in-world time along a horizontal axis, one lane per timeline.
 *
 * The axis is proportional to `timeKey`, so an event's position reflects how far
 * into the story's history it happens rather than how early it was written.
 *
 * Two things make this more than a row of labels:
 *
 *   - **The time cursor.** Relationships and events are time-varying
 *     (docs/data-model.md §4.8), so "what is true" is only answerable relative to
 *     a moment. The cursor marks that moment; events at or before it are solid,
 *     later ones dimmed; stepping walks the story. Without it the view could only
 *     draw "now", which a thousand-year calendar does not define.
 *
 *   - **Vertical stacking.** Events are positioned by time, so three events in
 *     the same year land on the same pixel and hide each other. Chips are
 *     therefore laid out in rows alternating above and below the axis line.
 *
 * `timeKey` is duplicated from the host's `validate.js` — the two halves are
 * separate bundles with no shared import path. `client-selftest.mjs` cross-checks
 * the copies on the same inputs so they cannot drift silently.
 */

/**
 * Coerce an optional numeric field, treating null/blank/boolean/object as absent.
 *
 * `Number(null)` is `0`, so coercing blindly reads a cleared year as year 0 —
 * silently teleporting an event to the start of history rather than treating it
 * as unset. Kept in step with the host's `validate.js` by a cross-check test.
 */
function optionalNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'object') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** `{year,month,day}` → a sortable integer, or null when the time is unusable.
 *
 * Must stay byte-for-byte equivalent to the host's copy in `lib/impl/validate.js`: the two
 * are cross-checked by a test, so a change here without the same change there fails loudly.
 * An out-of-range month or day makes the whole time unusable rather than encoding into a key
 * that sorts as a different date (`month: 0` used to sort before January).
 */
function timeKey(time) {
  if (time === null || time === undefined || typeof time !== 'object' || Array.isArray(time)) return null
  const year = optionalNumber(time.year)
  if (year === null) return null
  const month = optionalNumber(time.month)
  const day = optionalNumber(time.day)
  if (month !== null && (month < 1 || month > 12)) return null
  if (day !== null && (day < 1 || day > 31)) return null
  return year * 10000 + (month ?? 0) * 100 + (day ?? 0)
}

/** The inverse of `timeKey`, for display. */
function timeKeyParts(key) {
  return { year: Math.floor(key / 10000), month: Math.floor(key / 100) % 100, day: key % 100 }
}

/** Render a key in the project's own calendar, e.g. 「创世历 1345 年 3 月 2 日」. */
function formatTimeKey(calendar, key) {
  if (key === null) return '—'
  const { year, month, day } = timeKeyParts(key)
  const parts = [`${year} 年`]
  if (month > 0) parts.push(`${month} 月`)
  if (day > 0) parts.push(`${day} 日`)
  const epoch = calendar?.epochLabel ? `${calendar.epochLabel} ` : ''
  return `${epoch}${parts.join(' ')}`
}

/**
 * Whether an event lies after the cursor — i.e. has not happened yet as of it.
 *
 * Named and exported rather than inlined because it is the whole meaning of the
 * cursor: everything at or before it is true, everything after is the future.
 */
function isAfterCursor(cursorKey, event) {
  const key = timeKey(event?.at)
  if (key === null || cursorKey === null || cursorKey === undefined) return false
  return key > cursorKey
}

/**
 * Horizontal gutter reserved at each end of the axis, in pixels.
 *
 * Event chips are centred on their moment (`translateX(-50%)`), so a chip at 0%
 * or 100% would put half of itself outside the scroll container and be clipped —
 * the label at either end of the timeline becomes unreadable exactly where the
 * story starts and ends. Positions are mapped into an inset region instead.
 * The value must exceed half the widest chip (see `CHIP_MAX_WIDTH`).
 */
const GUTTER_PX = 58
const CHIP_MAX_WIDTH = 110
const CHIP_HEIGHT = 20
/** Vertical distance between stacking rows. */
const ROW_HEIGHT = 24

/**
 * Two chips share a row only if they are at least this far apart, as a fraction
 * of the axis width.
 *
 * Deliberately NOT measured from the DOM: measuring needs a ref, an effect and a
 * layout pass, which cannot be tested outside a browser — and an untestable
 * layout rule is how the edge-clipping bug survived. A fraction threshold is
 * approximate but deterministic, and `assignRows` is a pure function the suite
 * can pin down. ~14% keeps the widest chip (110px) clear of its neighbour on a
 * panel around 800px wide, which is the common case.
 */
const ROW_SEPARATION = 0.14

/** CSS `left` for a 0..1 position, inside the gutters. */
function axisLeft(fraction) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  return `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX * 2}px) * ${clamped})`
}

/**
 * Assign each position a stacking row so nearby chips do not overlap.
 *
 * Greedy first-fit over positions sorted by time: each chip takes the first row
 * whose last chip is far enough to the left, opening a new row only when none
 * fits. Greedy is enough here — a timeline lane holds tens of events, and the
 * alternative (optimal interval partitioning) would only ever save a row in
 * contrived cases.
 *
 * @param fractions - positions as 0..1, in their original order.
 * @returns `{ rowOf, rowCount }` where `rowOf[i]` is the row for `fractions[i]`.
 */
function assignRows(fractions, minSeparation = ROW_SEPARATION) {
  const sorted = fractions
    .map((fraction, index) => ({ fraction, index }))
    .sort((a, b) => a.fraction - b.fraction || a.index - b.index)

  const rowRightEdge = []
  const rowOf = new Array(fractions.length).fill(0)

  for (const item of sorted) {
    let row = rowRightEdge.findIndex((right) => item.fraction - right >= minSeparation)
    if (row === -1) {
      row = rowRightEdge.length
      rowRightEdge.push(Number.NEGATIVE_INFINITY)
    }
    rowRightEdge[row] = item.fraction
    rowOf[item.index] = row
  }

  return { rowOf, rowCount: rowRightEdge.length }
}

function TimelineView(props) {
  const { doc, selection, onSelect } = props
  const calendar = doc.calendar ?? {}
  // Elements as well as containers: `{"events":[null]}` passes `Array.isArray`.
  const lines = objectList(doc.lines)
  const events = objectList(doc.events)

  const distinctKeys = [...new Set(events.map((event) => timeKey(event.at)).filter((key) => key !== null))].sort(
    (a, b) => a - b,
  )

  // Default the cursor to the latest written moment — the closest thing a novel
  // has to "now".
  const [cursorKey, setCursorKey] = react.useState(() =>
    distinctKeys.length > 0 ? distinctKeys[distinctKeys.length - 1] : null,
  )

  const declaredStart = timeKey(calendar.start)
  const declaredEnd = timeKey(calendar.end)
  const declaredUsable = declaredStart !== null && declaredEnd !== null && declaredEnd > declaredStart

  // The axis spans the UNION of the declared calendar and every event time.
  //
  // Clamping to the declared range instead is the obvious implementation and it
  // breaks the view: an event dated outside those bounds is pinned to the very
  // edge, and the cursor — mapped from a fraction of the declared span — can
  // never reach it, so every event reads as "future" and dims at once.
  const bounds = [...(declaredUsable ? [declaredStart, declaredEnd] : []), ...distinctKeys]
  const lo = bounds.length > 0 ? Math.min(...bounds) : 0
  const hi = bounds.length > 0 ? Math.max(...bounds) : 1
  const span = hi > lo ? hi - lo : 1

  const pctOf = (key) => Math.max(0, Math.min(100, ((key - lo) / span) * 100))
  const fractionOf = (key) => (key === null ? 0 : pctOf(key) / 100)

  const declaredWiderThanContent = declaredUsable && (declaredStart > lo || declaredEnd < hi)

  // Lanes: the declared lines, plus synthetic ones so an event whose lineId is
  // unknown or absent is still shown rather than silently dropped.
  const declaredIds = new Set(lines.map((line) => line.id))
  const orphanIds = [...new Set(events.map((event) => event.lineId ?? null))].filter(
    (id) => id !== null && !declaredIds.has(id),
  )
  const lanes = [
    ...lines,
    ...orphanIds.map((id) => ({ id, name: `未定义线 ${id}`, kind: 'branch', synthetic: true })),
    ...(events.some((event) => event.lineId === null || event.lineId === undefined)
      ? [{ id: null, name: '未归线', kind: 'branch', synthetic: true }]
      : []),
  ]

  const eventsOfLane = (laneId) => events.filter((event) => (event.lineId ?? null) === laneId)

  const step = (direction) => {
    if (distinctKeys.length === 0) return
    const current = cursorKey
    if (current === null) {
      setCursorKey(distinctKeys[distinctKeys.length - 1])
      return
    }
    const at = distinctKeys.indexOf(current)
    if (at === -1) {
      const next = distinctKeys.find((key) => key > current)
      setCursorKey(direction > 0 ? next ?? current : current)
      return
    }
    const target = Math.max(0, Math.min(distinctKeys.length - 1, at + direction))
    setCursorKey(distinctKeys[target])
  }

  // Whether the cursor sits at the latest written moment — the default. Labelled
  // so that "nothing is dimmed" reads as the intended state, not a broken cursor.
  const atLatest = distinctKeys.length === 0 || cursorKey === distinctKeys[distinctKeys.length - 1]

  return h(
    'div',
    null,
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          marginBottom: '10px',
          fontSize: '12px',
        },
      },
      h('span', { style: { opacity: 0.55 } }, '时间游标'),
      h('strong', { style: { fontWeight: 600 } }, `${formatTimeKey(calendar, cursorKey)}${atLatest ? '（最新）' : ''}`),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: () => step(-1) }, '← 上一事件'),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: () => step(1) }, '下一事件 →'),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, padding: '2px 8px' },
          disabled: distinctKeys.length === 0,
          onClick: () => setCursorKey(distinctKeys[distinctKeys.length - 1] ?? null),
        },
        '回到最新',
      ),
      h('span', { style: { opacity: 0.45 } }, `${events.length} 个事件 · ${lines.length} 条线`),
    ),

    // Click strip: the axis itself, where the cursor is placed.
    h(
      'div',
      {
        title: '点击此处设置时间游标',
        onClick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const usable = rect.width - GUTTER_PX * 2
          if (usable <= 0) return
          // Subtract the gutter so the click lands where the tick it aims at
          // actually is; without this the cursor drifts toward the centre.
          const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - GUTTER_PX) / usable))
          setCursorKey(Math.round(lo + fraction * span))
        },
        style: {
          position: 'relative',
          height: '20px',
          borderBottom: `1px solid ${muted}`,
          cursor: 'crosshair',
          fontSize: '11px',
          opacity: 0.6,
        },
      },
      h('span', { style: { position: 'absolute', left: 0 } }, formatTimeKey(calendar, lo)),
      h('span', { style: { position: 'absolute', right: 0 } }, formatTimeKey(calendar, hi)),
    ),

    declaredWiderThanContent
      ? h(
          'div',
          { style: { fontSize: '11px', opacity: 0.45, marginTop: '2px' } },
          `历法区间：${formatTimeKey(calendar, declaredStart)} ~ ${formatTimeKey(calendar, declaredEnd)}（轴已扩展到含全部事件）`,
        )
      : null,

    events.length === 0
      ? h(
          'div',
          { style: { marginTop: '14px' } },
          h(Note, { text: '还没有事件。事件是时间轴上的条目；关系变化由事件触发时可在事件上注明。' }),
        )
      : null,

    lanes.length > 0 && events.length > 0
      ? h(
          'div',
          { style: { marginTop: '6px' } },
          ...lanes.map((lane) => {
            const laneEvents = eventsOfLane(lane.id)
            const fractions = laneEvents.map((event) => fractionOf(timeKey(event.at)))
            const { rowOf, rowCount } = assignRows(fractions)

            // Rows alternate above and below the axis: row 0 above, row 1 below,
            // row 2 further above, and so on. The axis line is drawn through the
            // middle, so "before and after this moment" reads spatially.
            const maxDepth = Math.max(0, Math.ceil(rowCount / 2) - 1) + 1
            const laneHeight = 2 * maxDepth * ROW_HEIGHT + CHIP_HEIGHT
            const axisY = laneHeight / 2

            return h(
              'div',
              { key: lane.id ?? '__none__', style: { marginBottom: '10px' } },
              // The lane caption is its own line rather than an overlay: an
              // overlaid label collides with the topmost row of chips.
              h(
                'div',
                {
                  style: {
                    fontSize: '11px',
                    opacity: 0.5,
                    fontWeight: lane.kind === 'main' ? 600 : 400,
                  },
                },
                `${lane.kind === 'main' ? '主线' : '支线'} · ${lane.name}`,
              ),
              h(
                'div',
                { style: { position: 'relative', height: `${laneHeight}px` } },
                // The axis line itself.
                h('div', {
                  style: {
                    position: 'absolute',
                    top: `${axisY}px`,
                    left: 0,
                    right: 0,
                    height: '1px',
                    background: muted,
                  },
                }),
                cursorKey !== null
                  ? h('div', {
                      style: {
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: axisLeft(fractionOf(cursorKey)),
                        width: '1px',
                        background: 'currentColor',
                        opacity: 0.45,
                        pointerEvents: 'none',
                      },
                    })
                  : null,
                ...laneEvents.map((event, index) => {
                  const future = isAfterCursor(cursorKey, event)
                  const selected =
                    selection !== null && selection.entity === 'timeline-event' && selection.id === event.id
                  const side = rowOf[index] % 2 === 0 ? -1 : 1
                  const depth = Math.floor(rowOf[index] / 2) + 1
                  const centerY = axisY + side * depth * ROW_HEIGHT
                  return h(
                    'button',
                    {
                      key: event.id,
                      type: 'button',
                      title: `${formatTimeKey(calendar, timeKey(event.at))}　${event.title ?? event.id}`,
                      onClick: () => onSelect({ entity: 'timeline-event', id: event.id }),
                      style: {
                        position: 'absolute',
                        left: axisLeft(fractions[index]),
                        top: `${centerY}px`,
                        transform: 'translate(-50%, -50%)',
                        maxWidth: `${CHIP_MAX_WIDTH}px`,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        font: 'inherit',
                        fontSize: '11px',
                        lineHeight: `${CHIP_HEIGHT - 4}px`,
                        padding: '0 7px',
                        borderRadius: '999px',
                        border: `1px solid ${selected ? 'currentColor' : muted}`,
                        background: selected ? 'rgba(128,128,128,0.2)' : 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        // Events after the cursor are the future: still visible, so
                        // the whole story stays legible, but clearly not yet true.
                        opacity: future ? 0.35 : 1,
                      },
                    },
                    event.title ?? event.id,
                  )
                }),
              ),
            )
          }),
        )
      : null,
  )
}

/**
 * The calendar editor: an in-world epoch name and the axis endpoints.
 *
 * Needed as a first-class control rather than a hidden default because character
 * ages are derived from `born` against this calendar (docs/data-model.md §6.2) —
 * with no usable calendar there is no reference point to compute them from.
 */
function CalendarEditor(props) {
  const { calendar, onChange } = props
  const current = calendar ?? {}
  return h(
    'div',
    null,
    h(DetailHeading, null, '历法'),
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.5, lineHeight: 1.7, marginBottom: '10px' } },
      '时间轴的起点与终点，以及纪元名称。人物年龄由出生时间按这套历法推算，因此它必须可用。轴会自动扩展到包含全部事件。',
    ),
    h(
      'div',
      { style: { marginBottom: '10px' } },
      h(FieldLabel, null, '纪元名称'),
      h('input', {
        value: current.epochLabel ?? '',
        onChange: (event) => onChange({ ...current, epochLabel: event.target.value }),
        style: inputStyle,
      }),
    ),
    h(
      'div',
      { style: { marginBottom: '10px' } },
      h(FieldLabel, null, '起点'),
      h(TimeInput, { value: current.start, onChange: (next) => onChange({ ...current, start: next }) }),
    ),
    h(
      'div',
      null,
      h(FieldLabel, null, '终点'),
      h(TimeInput, { value: current.end, onChange: (next) => onChange({ ...current, end: next }) }),
    ),
  )
}

      // ==== 60-shell.js =======================================================
/**
 * Panel shell: the project bar, the in-panel split, and the frame each branch
 * renders into.
 *
 * The detail pane is drawn HERE rather than delegated to the host's right
 * column. That is not a preference: an activity-bar branch panel is a *global*
 * `main` panel, which replaces the Conversation, and the host's right column is
 * session-scoped — `ctx.sidebarRight.mounted` is `undefined` while a global
 * panel fills the center, and the column has "no surface without a session".
 * So the 细节扩展区 has to live inside the panel.
 */

function ProjectBar(props) {
  const { root, setRoot, onCreate, creating, status } = props
  const [state, reload] = useEndpoint(`${API}/workspaces`)
  const workspaces = state.data?.workspaces ?? []
  const available = state.data?.available !== false

  // Convenience, not magic: with exactly one initialized project there is
  // nothing to choose, so opening on it beats showing an empty picker.
  react.useEffect(() => {
    if (!isBlank(root) || state.loading || !available) return
    const initialized = workspaces.filter((workspace) => workspace.project.initialized)
    if (initialized.length === 1) setRoot(initialized[0].path)
  }, [root, state.loading, available, workspaces.length, setRoot])

  const selected = workspaces.find((workspace) => workspace.path === root) ?? null

  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
    h('span', { style: { fontSize: '12px', opacity: 0.55 } }, '项目'),
    h(
      'select',
      {
        value: root ?? '',
        disabled: state.loading,
        onChange: (event) => setRoot(event.target.value === '' ? null : event.target.value),
        style: { ...inputStyle, width: 'auto', maxWidth: '240px' },
      },
      h('option', { value: '' }, state.loading ? '载入中…' : '未选择'),
      ...workspaces.map((workspace) =>
        h(
          'option',
          { key: workspace.id, value: workspace.path },
          `${workspace.title || workspace.path}${workspace.project.initialized ? '' : '（无小说数据）'}`,
        ),
      ),
    ),
    h('button', { type: 'button', style: buttonStyle, onClick: reload }, '刷新'),
    selected !== null && !selected.project.initialized
      ? h(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, borderColor: 'currentColor' },
            disabled: creating,
            onClick: () => onCreate(selected.path, selected.title),
          },
          creating ? '创建中…' : '在此新建小说项目',
        )
      : null,
    status !== null ? h('span', { style: { fontSize: '12px', opacity: 0.7 } }, status) : null,
    !available && !state.loading ? h('span', { style: { fontSize: '12px', opacity: 0.6 } }, '宿主未提供项目列表') : null,
  )
}

/** The branch's own toolbar row, below the header. */
function BranchToolbar(props) {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } },
    props.children,
  )
}

/**
 * Center content plus an optional detail pane.
 *
 * `open` is owned by the branch body, because only it knows whether there is
 * anything worth showing.
 */
function SplitPane(props) {
  return h(
    'div',
    { style: { display: 'flex', height: '100%', minHeight: 0, gap: '0' } },
    h('div', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'auto' } }, props.main),
    props.open && props.detail
      ? h(
          'div',
          {
            style: {
              flex: '0 0 330px',
              width: '330px',
              borderLeft: `1px solid ${muted}`,
              overflow: 'auto',
              padding: '14px 16px',
              boxSizing: 'border-box',
            },
          },
          props.detail,
        )
      : null,
  )
}

/**
 * A narrow list beside a wide content area.
 *
 * The mirror of `SplitPane`: that one puts a detail inspector on the right and
 * is sized for forms, this one puts a chooser on the left and gives the rest to
 * the work — which is what prose needs. Both exist because a chapter editor and
 * an entity inspector want opposite proportions.
 */
function MasterDetail(props) {
  return h(
    'div',
    { style: { display: 'flex', height: '100%', minHeight: 0 } },
    h(
      'div',
      {
        style: {
          flex: '0 0 230px',
          width: '230px',
          borderRight: `1px solid ${muted}`,
          overflow: 'auto',
          paddingRight: '12px',
          boxSizing: 'border-box',
        },
      },
      props.list,
    ),
    h(
      'div',
      {
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'auto',
          paddingLeft: '16px',
          boxSizing: 'border-box',
        },
      },
      props.content,
    ),
  )
}

/**
 * The commit row every editable branch shows: which document, whether it is dirty,
 * save, revert.
 *
 * Shared rather than repeated so the three branches cannot drift apart, and so a
 * body component can be rendered in a test with one `status` + `actions` pair
 * instead of a dozen loose props.
 *
 * @param status - `{ dirty, saving, savedAt }`.
 * @param actions - `{ save, revert }`.
 * @param extra - branch-specific controls, placed before the detail toggle.
 */
function CommitRow(props) {
  const { label, status, actions, extra, detailOpen, onToggleDetail } = props
  return h(
    BranchToolbar,
    null,
    h('span', { style: { fontSize: '12px', opacity: 0.55 } }, label),
    status.dirty ? h('span', { style: { fontSize: '12px', color: '#e5a34b' } }, '未保存') : null,
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, borderColor: status.dirty ? 'currentColor' : muted },
        disabled: !status.dirty || status.saving,
        onClick: actions.save,
      },
      status.saving ? '保存中…' : '保存',
    ),
    h('button', { type: 'button', style: buttonStyle, disabled: !status.dirty, onClick: actions.revert }, '还原'),
    ...(extra ?? []),
    status.savedAt !== null && status.savedAt !== undefined && !status.dirty
      ? h('span', { style: { fontSize: '12px', opacity: 0.5 } }, `已保存 ${status.savedAt}`)
      : null,
    // A FUNCTION, not merely "not undefined". `onToggleDetail: null` used to render a live-looking
    // 收起详情 button that was bound to nothing — the click did nothing and the pane could not be
    // collapsed. Requiring callable makes `null` mean "no toggle", which is what a caller means.
    typeof onToggleDetail === 'function'
      ? h(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, marginLeft: 'auto' },
            onClick: onToggleDetail,
          },
          detailOpen ? '收起详情' : '展开详情',
        )
      : null,
  )
}

/** The findings a refused or questionable write produced, in one block. */
function WriteFeedback(props) {
  const { error, issues, warnings } = props
  // `Array.isArray` hardened the CONTAINER, not the elements: an `issues` array holding
  // a `null` still reaches `issue.code` below and takes the pane down. This is the same
  // shape as the bug that shipped, one level deeper.
  const list = (value) => (Array.isArray(value) ? value.filter(isRecord) : [])
  const raw = (value) => (Array.isArray(value) ? value : [])
  const refused = list(issues)
  const cautioned = list(warnings)
  // The length of the RAW list decides whether a refusal happened: `[null]` is still a
  // refusal with a malformed payload, and rendering nothing would hide it entirely.
  if (raw(issues).length === 0 && raw(warnings).length === 0 && isMissing(error)) return null

  return h(
    'div',
    { style: { marginBottom: '10px', fontSize: '12px', lineHeight: 1.7 } },
    !isMissing(error) ? h(Note, { text: String(error), tone: 'error' }) : null,
    refused.length > 0
      ? h(
          'div',
          { style: { color: '#e5534b' } },
          h('div', null, '宿主拒绝了这次写入，因为会引入以下问题：'),
          ...refused.map((issue, index) =>
            h(
              'div',
              { key: index, style: { paddingLeft: '10px' } },
              // A malformed issue is still worth showing: silently dropping it would
              // hide the fact that the write was refused.
              `· ${isMissing(issue.code) ? '(无代码)' : issue.code} ${isMissing(issue.message) ? '' : issue.message}`,
            ),
          ),
        )
      : raw(issues).length > 0
        ? h(
            'div',
            { style: { color: '#e5534b' } },
            h('div', null, '宿主拒绝了这次写入，但没有给出可读的原因。'),
          )
        : null,
    cautioned.length > 0
      ? h(
          'div',
          { style: { color: '#c98a2b' } },
          ...cautioned.map((issue, index) =>
            h('div', { key: index }, `· ${isMissing(issue.message) ? '(无说明)' : issue.message}`),
          ),
        )
      : null,
  )
}

/** A labelled block used inside the detail pane. */
function DetailHeading(props) {
  // `title` FIRST, because that is what every caller passes. Rendering only `children` made all four
  // headings in the map panel — 地图, 标记大小, 标点名称, 地图标注 — invisible, silently: a div with no text
  // looks exactly like a layout gap, so nobody reports it. `children` is kept as the fallback.
  return h(
    'div',
    { style: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' } },
    props.title ?? props.children,
  )
}

/**
 * A crash in one view shows a message instead of a blank window.
 *
 * ADDED AFTER TWO WHITE SCREENS. React unmounts the WHOLE tree when a render throws, so a single wrong
 * variable name — `penColor` in `MapSurface`, `texts` in `MapBranch` — did not break one panel, it broke
 * every panel, and the author's report was necessarily "整个插件白屏" with nothing to go on. The mistake is
 * always cheap to fix once it can be READ, so this turns the blank page into the error and a 重试 button.
 *
 * A class, because React has no hook for this and the boundary must catch render-phase errors.
 */
class ViewBoundary extends react.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    // Also to the console, so the full stack is available where the author can copy it.
    console.error('[dsh-novel] view failed to render:', error)
  }

  render() {
    if (this.state.error === null) return this.props.children
    return h(
      'div',
      { style: { padding: '16px', fontSize: '13px', lineHeight: 1.8 } },
      h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, `${this.props.label ?? '这个视图'}出错了`),
      h('div', { style: { opacity: 0.6, marginBottom: '10px' } }, '其余部分仍可用；右侧的面板列表可以切到别的视图。'),
      h(
        'pre',
        {
          style: {
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'rgba(128,128,128,0.12)',
            padding: '8px',
            margin: '0 0 10px 0',
            fontSize: '12px',
          },
        },
        String(this.state.error?.stack ?? this.state.error?.message ?? this.state.error),
      ),
      h(
        'button',
        { type: 'button', style: buttonStyle, onClick: () => this.setState({ error: null }) },
        '重试',
      ),
    )
  }
}

function createPanel(ctx, branch) {
  return function BranchPanel() {
    const [root, setRoot] = useProjectRoot()
    const [creating, setCreating] = react.useState(false)
    const [status, setStatus] = react.useState(null)

    const createProject = (target, title) => {
      // Guard locally. `JSON.stringify` DROPS an undefined value, so a blank
      // target would reach the host as a body with no `root` key at all and come
      // back as "root is required and must be an absolute path" — a true
      // statement that explains nothing about what the user did wrong.
      if (isBlank(target)) {
        setStatus('没有选中的项目目录，请先在左侧下拉里选一个。')
        return
      }
      setCreating(true)
      setStatus(null)
      fetch(api(`${API}/project/create`), {
        method: 'POST',
        headers: WRITE_HEADERS,
        // Seed the project title from the workspace's own title, so a project
        // created from the picker is named rather than blank.
        body: JSON.stringify({ root: target, title: title ?? '' }),
      })
        .then(async (response) => {
          const body = await response.json().catch(() => null)
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setStatus(`已创建 ${body.created.length} 个文档`)
          setRoot(target)
        })
        .catch((error) => setStatus(`创建失败：${String(error?.message ?? error)}`))
        .finally(() => setCreating(false))
    }

    return h(
      'div',
      {
        style: {
          height: '100%',
          boxSizing: 'border-box',
          // Entry pages pad by the frame's reserved strip so nothing lands under
          // the Windows caption. Zero on plain web documents.
          paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
          display: 'flex',
          flexDirection: 'column',
          color: 'inherit',
        },
      },
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
            padding: '10px 20px',
            borderBottom: `1px solid ${muted}`,
          },
        },
        h('strong', { style: { fontSize: '14px', fontWeight: 600 } }, `小说 · ${branch.label}`),
        h('span', { style: { width: '1px', height: '18px', background: muted } }),
        h(ProjectBar, { root, setRoot, onCreate: createProject, creating, status }),
        h(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, marginLeft: 'auto' },
            onClick: () => ctx.layout.selectPanel(null),
          },
          '返回对话',
        ),
      ),
      h('div', { style: { padding: '20px', overflow: 'hidden', flex: '1 1 auto', minHeight: 0 } }, h(ViewBoundary, { label: `小说 · ${branch.label}` }, h(BranchRouter, { branch, root }))),
    )
  }
}

      // ==== 62-agent.js =======================================================
/**
 * Driving an agent from the chapter editor — the CLIENT half of Phase 5c.
 *
 * WHY THE HOST HALF WAS ALREADY DONE. `lib/impl/router.js` registers `/agent/prompt`,
 * `/agent/status`, `/agent/result` and `/agent/cancel`, calls the host with the semantically correct
 * arguments, and reports the known host defect as its own code (`agent-prompt-unsupported`, 501) so
 * that nothing here has to change when the host is fixed. `tools/patch-asar.mjs` applies that one-line
 * host fix. What was missing was this: there was no way to START a run, WATCH it, or TAKE its result.
 *
 * WHY AN AGENT AT ALL, when `ctx.llm` already writes chapters. They are different tools. `ctx.llm`
 * answers one question with one reply. An agent reads the setting, follows a skill, writes FILES and
 * can run the validator — that is what "写一整章并按技能校验" needs, and it cannot be done through a
 * single completion. The two sit side by side in the editor; neither pretends to be the other.
 *
 * THE ONE RULE THAT MATTERS: the agent writes to `novel/` with its own file tools, which BYPASS this
 * plugin's validation gate. So its prose goes into the editor UNSAVED — exactly as `ctx.llm` output
 * does — and what it touched is REPORTED rather than silently reloaded over the author's unsaved text.
 */

/**
 * The prompt one chapter's run is given.
 *
 * Built here, in the client, so the wording is visible where the button is — but it is DELIBERATELY a
 * pure function of what the author typed, because a prompt assembled at the call site from four
 * closures is a prompt nobody can test.
 */
function agentPromptText(chapterTitle, instruction) {
  const title = String(chapterTitle ?? '').trim()
  const ask = String(instruction ?? '').trim()
  return [
    `请写小说章节${title === '' ? '' : `《${title}》`}的正文。`,
    ask === '' ? '' : `本次要求：${ask}`,
    '按 novel-writer 技能的要求做：先读这一章相关的设定与上一章结尾，再落笔，直接写进这一章的正文。',
    '写完后用 novel-consistency 技能跑一次一致性校验，并在回复里报告：改了哪个文件、写了多少字、校验结果如何。',
    '不要改动 novel/setting/ 与 novel/outline/ 下的任何文件。',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * What is happening, from the two endpoints, in ONE place.
 *
 * A UI that decides this itself from `running` and `text` in several spots drifts: it shows "writing"
 * forever when a run ends without a `turn/end`, or "done" before the result was read.
 *
 * `finished` is the route's own word for it — `GET /agent/result` sends `finished` (router.js:1477-1492).
 * Reading a different key here is silent: the phase simply never reaches 'done', `status.running` has
 * already gone false, and the caller that polls on `phase === 'reading'` keeps asking forever.
 *
 * @returns `'idle' | 'unsupported' | 'failed' | 'running' | 'reading' | 'done'`
 *   `reading` is the gap between "the run stopped" and "we have its result" — real, and short.
 */
function agentPhase(input) {
  const started = input?.started === true
  const error = input?.error ?? null
  if (error !== null) {
    return error?.code === 'agent-prompt-unsupported' || error?.unsupported === true ? 'unsupported' : 'failed'
  }
  if (!started) return 'idle'
  if (input?.result?.finished === true) return 'done'
  if (input?.status?.running === true) return 'running'
  return 'reading'
}

/** The project files a run touched, as a tidy sorted list. Never used to decide what to reload. */
function agentWrites(result) {
  const raw = result?.writes
  const list = Array.isArray(raw) ? raw : []
  return [...new Set(list.filter((entry) => typeof entry === 'string' && entry !== ''))].sort()
}

/** The usage, as one line, or null when the host reported none. */
function agentUsageLine(usage) {
  if (usage === null || usage === undefined || typeof usage !== 'object') return null
  const parts = []
  for (const [key, label] of [['inputTokens', '输入'], ['outputTokens', '输出'], ['totalTokens', '合计']]) {
    const value = Number(usage[key])
    if (Number.isFinite(value) && value > 0) parts.push(`${label} ${value.toLocaleString('en-US')}`)
  }
  return parts.length === 0 ? null : parts.join(' · ')
}

/** The default model, as one line. */
function agentModelLine(defaultModel) {
  if (defaultModel === null || defaultModel === undefined) return null
  if (typeof defaultModel === 'string') return defaultModel
  const provider = typeof defaultModel.provider === 'string' ? defaultModel.provider : ''
  const model = typeof defaultModel.model === 'string' ? defaultModel.model : ''
  const joined = [provider, model].filter((part) => part !== '').join(' / ')
  return joined === '' ? null : joined
}

/**
 * The sessions a run could be given, filtered to THIS project.
 *
 * The host matches on `cwd`, so a session rooted anywhere else would write into another novel. The
 * filter is here as well as there, because a session that appears in this list is one a click can
 * drive, and a click must not be able to write into the wrong project.
 */
function agentSessionsFor(items, root) {
  const wanted = String(root ?? '')
  return objectList(items).filter((item) => {
    if (typeof item?.sessionId !== 'string' || item.sessionId === '') return false
    const cwd = item?.cwd
    if (typeof cwd !== 'string') return true
    return cwd.toLowerCase() === wanted.toLowerCase()
  })
}

/**
 * How long ago, in words. Pure, and `now` is a parameter so a test never depends on the clock.
 *
 * REPORTED: 「会话全是一串数字和字母是什么意思」. The host's `/sessions` rows carry `updatedAt` (and `blank`,
 * `running`) but NO title, so the picker fell back to `title ?? sessionId` and every row was a bare
 * `session-60825a3f-6c57-4458-8baf-4be2e195c381`. "When did I last use this" is the thing that makes one row
 * choosable over another, and the host does tell us that.
 */
function agentRelativeTime(updatedAt, now) {
  // TYPED, NOT COERCED. `Number(null)` is 0 and `Number('')` is 0, so coercing turned a MISSING timestamp into
  // 「56 年前」 — the epoch. The host sends a number, so anything else is "no answer".
  const then = typeof updatedAt === 'number' ? updatedAt : NaN
  const current = typeof now === 'number' ? now : NaN
  if (!Number.isFinite(then) || !Number.isFinite(current)) return null
  const seconds = Math.max(0, Math.round((current - then) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.round(months / 12)} 年前`
}

/**
 * The label for one session row.
 *
 * The id stays, because it is what identifies a session when something goes wrong — but as a SHORT SUFFIX, not
 * as the whole label. A title is used when the host provides one (it does not today), so a row reads
 * 「3 小时前 · …4be2e195」 rather than a wall of hex.
 */
function agentSessionLabel(row, now) {
  const parts = []
  const id = typeof row?.sessionId === 'string' ? row.sessionId : ''
  const title = typeof row?.title === 'string' ? row.title.trim() : ''
  if (title !== '') parts.push(title)
  else if (row?.blank === true) parts.push('空会话')
  const when = agentRelativeTime(row?.updatedAt, now)
  if (when !== null) parts.push(when)
  if (row?.running === true) parts.push('进行中')
  // The last 8 characters are enough to tell two rows apart, and short enough to read.
  if (id !== '') parts.push(`…${id.slice(-8)}`)
  return parts.length === 0 ? id : parts.join(' · ')
}

/** Newest first, so the session an author just used is the first one offered. */
function agentSessionsSorted(items) {
  return items.slice().sort((left, right) => Number(right?.updatedAt ?? 0) - Number(left?.updatedAt ?? 0))
}

/** Loads the project's sessions once, plus the host's default model. */
function useAgentSessions(root) {
  const [state, setState] = react.useState({ loading: true, error: null, items: [], defaultModel: null, available: false })
  react.useEffect(() => {
    if (isBlank(root)) {
      setState({ loading: false, error: null, items: [], defaultModel: null, available: false })
      return undefined
    }
    let live = true
    setState((current) => ({ ...current, loading: true, error: null }))
    fetch(api(`${API}/sessions?root=${encodeURIComponent(root)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        if (!live) return
        setState({
          loading: false,
          error: null,
          // THE HOST'S FIELD IS `sessions`, not `items`. Reading `items` found nothing, so the picker was
          // permanently empty and the button permanently disabled — a dead end that reports no error, which
          // is why it has to be asserted against the real route rather than against a plausible shape.
          items: agentSessionsSorted(agentSessionsFor(Array.isArray(body?.sessions) ? body.sessions : [], root)),
          defaultModel: body?.defaultModel ?? null,
          available: body?.available === true,
        })
      })
      .catch((failure) => {
        if (live) setState({ loading: false, error: String(failure?.message ?? failure), items: [], defaultModel: null, available: false })
      })
    return () => {
      live = false
    }
  }, [root])
  return state
}

/**
 * The agent control's presentation, props-driven.
 *
 * Extracted for the same reason every other branch's body is: `renderToString` does not run effects, so
 * a fetch-driven component renders only its loading state and everything after the guard is untestable.
 * All of the meaning lives here; the wrapper below only owns the network.
 */
function AgentDraftBody(props) {
  const {
    sessions, sessionId, onPickSession, instruction, onInstruction,
    phase, error, note, usage, writes, defaultModel,
    onStart, onCancel, onTake, canTake,
  } = props

  const heading = h('div', { style: { fontSize: '12px', opacity: 0.6, marginBottom: '6px' } }, '交给 agent 写这一章')

  // THE HOST LIMITATION, told plainly — and told DIFFERENTLY depending on which one it is, because after the
  // first patch they stopped being the same thing:
  //
  //   host-signal-required    the host still demands an AbortSignal it cannot serialize → apply the patch
  //   lossless-json-required  the session log refused the event because a field was not LOSSLESSLY serializable
  //
  // The second used to be described here as a host defect. It was OURS: an omitted `requestId` became
  // `source.rpcId = undefined` inside the event, and the log refuses an `undefined` field because JSON would
  // drop it. So this text no longer accuses the host — it says what the rule is.
  if (phase === 'unsupported') {
    const hostSignal = error?.reason === 'host-signal-required'
    return h(
      'div',
      { style: { marginBottom: '12px', padding: '10px', border: `1px solid ${muted}`, borderRadius: '6px' } },
      heading,
      h(Note, {
        tone: 'error',
        text: hostSignal
          ? '宿主还没打好补丁：sessionController.prompt 把取消信号当成必需参数，而它自己又不能被序列化。'
          : '这次提问没能写进会话日志：事件里有一个字段不是「无损 JSON 可序列化」的。',
      }),
      h(
        'div',
        { style: { fontSize: '12px', opacity: 0.7, marginTop: '4px', lineHeight: 1.8 } },
        hostSignal
          ? '这不是本项目的数据或参数问题。修法是给宿主打一行补丁（需要先关掉 DSH）：'
          : '会话日志拒绝的是值为 undefined 的字段（JSON 会把它丢掉，所以往返之后不是同一个值）。本插件每次提问都会生成 requestId，因此这条错误通常来自宿主侧缺失的字段。',
      ),
      hostSignal
        ? h(
            'pre',
            {
              style: {
                margin: '6px 0 0 0',
                padding: '8px',
                background: 'rgba(128,128,128,0.12)',
                fontSize: '12px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              },
            },
            'tools\\apply-host-patch.cmd',
          )
        : null,
      h(
        'div',
        { style: { fontSize: '12px', opacity: 0.7, marginTop: '6px', lineHeight: 1.8 } },
        hostSignal
          ? '打完补丁、重启 DSH，这个按钮就会自己开始工作——这边不用再改任何东西。'
          : '在它修好之前，这一章可以先用上面的「让 AI 写这一章」。',
      ),
    )
  }

  return h(
    'div',
    { style: { marginBottom: '12px', padding: '10px', border: `1px solid ${muted}`, borderRadius: '6px' } },
    heading,
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.6, marginBottom: '6px', lineHeight: 1.8 } },
      '和上面「让 AI 写这一章」不同：那条走模型，一次一问一答；这条会把整章交给 agent——它读设定、照技能写、直接落到章节文件里，并跑一次校验。',
    ),
    sessions === null || sessions.length === 0
      ? h(Note, {
          text: sessions === null
            ? '正在读取本项目的会话…'
            : // NOT A DEAD END. With no sessionId the host picks the project's single session, or creates one —
              // so a project that has never been chatted in is exactly where this tool is most useful.
              '这个项目还没有会话。直接开始即可：宿主会为它新建一个。',
        })
      : h(
          'div',
          { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '6px' } },
          h('span', { style: { fontSize: '12px', opacity: 0.6 } }, '会话'),
          h(
            'select',
            {
              value: sessionId ?? '',
              onChange: (event) => onPickSession(event.target.value),
              style: { ...inputStyle, flex: '1 1 220px' },
            },
            // LABELLED, NOT RAW. The host's session rows carry no title, so this used to be a list of
            // `session-60825a3f-6c57-4458-8baf-4be2e195c381` and the only way to tell two apart was to guess.
            ...sessions.map((item) =>
              h('option', { key: item.sessionId, value: item.sessionId }, agentSessionLabel(item, Date.now())),
            ),
          ),
          h(
            'span',
            { style: { fontSize: '11px', opacity: 0.45, width: '100%' } },
            `本项目共 ${sessions.length} 个会话，按最近使用排序；末尾是编号后 8 位（宿主不提供标题）。标着「进行中」的会话正在忙，选它会被拒绝。`,
          ),
        ),
    h('input', {
      type: 'text',
      value: instruction,
      placeholder: '本次要求，例如「写主角走进荒废的山门」',
      onChange: (event) => onInstruction(event.target.value),
      style: { ...inputStyle, width: '100%', marginBottom: '6px' },
    }),
    h(
      'div',
      { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
      phase === 'running' || phase === 'reading'
        ? h('button', { type: 'button', style: buttonStyle, onClick: onCancel }, '取消')
        : // ENABLED EVEN WITH NO SESSION CHOSEN. The host resolves it: one session for this project is used,
          // several make it ask which, none makes one. Disabling the button here — as it first did — turned a
          // project without a session into a dead end with nothing to click and no error to read.
          h(
            'button',
            { type: 'button', style: buttonStyle, onClick: onStart },
            sessionId === null ? '交给 agent 写（新建会话）' : '交给 agent 写',
          ),
      canTake ? h('button', { type: 'button', style: buttonStyle, onClick: onTake }, '把结果放进编辑框') : null,
      agentModelLine(defaultModel) === null
        ? null
        : h('span', { style: { fontSize: '11px', opacity: 0.55 } }, `默认模型 ${agentModelLine(defaultModel)}`),
    ),
    // WHAT IS HAPPENING, always, so a long run never looks like a dead button.
    phase === 'running'
      ? h('div', { style: { fontSize: '12px', marginTop: '6px', opacity: 0.75 } }, 'agent 正在写。可以继续干别的，写完后这里会报告结果。')
      : null,
    phase === 'reading'
      ? h('div', { style: { fontSize: '12px', marginTop: '6px', opacity: 0.75 } }, 'agent 停了，正在读它的结果…')
      : null,
    error !== null && phase === 'failed'
      ? h(Note, { tone: 'error', text: `调用失败：${error.message ?? error}` })
      : null,
    note === null ? null : h('div', { style: { fontSize: '12px', marginTop: '6px', opacity: 0.75 } }, note),
    agentUsageLine(usage) === null
      ? null
      : h('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '4px' } }, agentUsageLine(usage)),
    // WHICH FILES IT TOUCHED. Reported, never acted on: the agent writes with its own tools, which bypass
    // this plugin's validation gate, so the author decides what to do about it.
    writes.length === 0
      ? null
      : h(
          'div',
          { style: { fontSize: '11px', opacity: 0.6, marginTop: '4px', lineHeight: 1.8 } },
          '它写过的文件：' + writes.join('、'),
        ),
  )
}

/**
 * The control itself: owns the network, hands everything readable to `AgentDraftBody`.
 *
 * The result goes into the editor through `onDrafted` and is NOT saved — the same rule as the model
 * path, for a stronger reason: an agent writes the file itself, so anything this control also saved
 * would be a second writer on the same file.
 */
function AgentDraftControl(props) {
  const { root, chapterTitle, onDrafted } = props
  const sessionsState = useAgentSessions(root)
  const [sessionId, setSessionId] = react.useState(null)
  const [instruction, setInstruction] = react.useState('')
  const [started, setStarted] = react.useState(false)
  const [status, setStatus] = react.useState(null)
  const [result, setResult] = react.useState(null)
  const [error, setError] = react.useState(null)
  const [note, setNote] = react.useState(null)

  // Default to the most recently used IDLE session.
  //
  // NOT a running one, which is what this used to prefer: `/agent/prompt` refuses a busy session with 409
  // `session-busy`, so defaulting to the one session that cannot accept a prompt made the first click fail
  // every time — and the session the author is most likely to be sitting in is precisely the running one.
  // The list arrives newest first, so `find` gives the latest idle one.
  react.useEffect(() => {
    if (sessionId !== null) return
    const items = sessionsState.items
    if (items.length === 0) return
    const idle = items.find((item) => item.running !== true)
    // No idle session leaves the choice open, and the host then creates one — see `start`, which omits
    // `sessionId` rather than sending a null.
    if (idle !== undefined) setSessionId(idle.sessionId)
  }, [sessionsState.items, sessionId])

  const phase = agentPhase({ started, status, result, error })

  // POLLING, and only while a run is live. `inspect` transfers a whole transcript, which is why the status
  // endpoint exists at all — so this asks the cheap one and reads the transcript exactly once.
  react.useEffect(() => {
    if (sessionId === null || !started || phase !== 'running') return undefined
    const timer = setInterval(() => {
      fetch(api(`${API}/agent/status?sessionId=${encodeURIComponent(sessionId)}`))
        .then(async (response) => {
          const body = await response.json().catch(() => null)
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setStatus(body)
        })
        .catch((failure) => setError({ message: String(failure?.message ?? failure) }))
    }, 1500)
    return () => clearInterval(timer)
  }, [sessionId, started, phase])

  // Read the result ONCE, when the run has stopped.
  react.useEffect(() => {
    if (sessionId === null || !started || phase !== 'reading') return undefined
    let live = true
    fetch(api(`${API}/agent/result?sessionId=${encodeURIComponent(sessionId)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        if (!live) return
        setResult(body)
        const text = typeof body?.text === 'string' ? body.text.trim() : ''
        const touched = agentWrites(body)
        setNote(
          text === ''
            ? touched.length === 0
              ? 'agent 结束了，但没有回复文本，也没有写文件。'
              : `agent 直接改了文件：${touched.join('、')}。请自己打开确认后保存。`
            : 'agent 的回复已读回。正文不会自动进编辑框——按「把结果放进编辑框」再由你决定保存。',
        )
      })
      .catch((failure) => {
        if (live) setError({ message: String(failure?.message ?? failure) })
      })
    return () => {
      live = false
    }
  }, [sessionId, started, phase])

  const start = () => {
    setStarted(true)
    setStatus(null)
    setResult(null)
    setError(null)
    setNote(null)
    // THE FIELD IS `text`, NOT `prompt`: the route reads `body.text` and answers 400 `prompt-required`
    // otherwise. And `sessionId` travels only when one was chosen — with none, the host picks the project's
    // single session or creates one, which is the only way out of a project that has no session yet.
    const payload = { root, text: agentPromptText(chapterTitle, instruction) }
    if (sessionId !== null) payload.sessionId = sessionId
    fetch(api(`${API}/agent/prompt`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify(payload),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          const failure = new Error(body?.error ?? `HTTP ${response.status}`)
          failure.code = body?.code ?? null
          // The route names WHICH of the two 501 causes it was; the screen must not guess.
          failure.reason = body?.details?.reason ?? null
          throw failure
        }
        if (typeof body?.sessionId === 'string' && body.sessionId !== '') setSessionId(body.sessionId)
        setStatus({ running: true })
        setNote(body?.created === true ? '已建了一个新会话并交给 agent。' : '已交给 agent。')
      })
      .catch((failure) => {
        setError({ message: String(failure?.message ?? failure), code: failure?.code ?? null, reason: failure?.reason ?? null })
      })
  }

  const cancel = () => {
    if (sessionId === null) return
    fetch(api(`${API}/agent/cancel`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ root, sessionId }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        setNote('已请求取消。')
      })
      .catch((failure) => setError({ message: String(failure?.message ?? failure) }))
  }

  const resultText = typeof result?.text === 'string' ? result.text.trim() : ''

  return h(AgentDraftBody, {
    sessions: sessionsState.loading ? null : sessionsState.items,
    sessionId,
    onPickSession: (next) => setSessionId(next === '' ? null : next),
    instruction,
    onInstruction: setInstruction,
    phase,
    error,
    note: sessionsState.error === null ? note : `读取会话失败：${sessionsState.error}`,
    usage: result?.usage ?? null,
    writes: agentWrites(result),
    defaultModel: sessionsState.defaultModel,
    onStart: start,
    onCancel: cancel,
    onTake: () => {
      if (resultText !== '') onDrafted(resultText, 'continue')
    },
    canTake: resultText !== '',
  })
}

      // ==== 65-map.js =========================================================
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
 * Reconcile one edited map with the version stored in the document.
 *
 * THE OTHER HALF OF THE DISPLAY/DATA SPLIT. `normalizeMap` runs on READ and fills display defaults
 * (`pinSize`, `labelSize`, `theme`, a default canvas and background) into the object the UI works with.
 * Every map-field helper then builds `{ ...normalizedMap, <the change> }`, so writing that object back
 * persisted all the filled-in defaults beside the one field the author actually touched — one edit, and
 * the file gained `"pinSize": 14` plus whatever else the map had been missing.
 *
 * So the STORED map is the base, and only fields that differ from the normalised view are taken from the
 * edit. A field the author never set is absent from the base, is not a change, and therefore stays
 * absent. A field they did set equals the base, is not a change, and is carried over untouched.
 *
 * Lists are taken from the edit as a whole when they differ at all (a drawn stroke, an added pin): those
 * are the author's work, and the elements reaching here already arrive normalised, so writing them needs
 * no further reconciliation. Nested records are merged recursively for the same reason as the top level.
 */
const MAP_MUTABLE_FIELDS = ['name', 'canvas', 'background', 'strokes', 'shapes', 'paths', 'pins', 'texts', 'stamps', 'theme', 'labelSize', 'labelFixed']

/** Is this a plain record, as opposed to an array, a scalar, or null? */
function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameStoredValue(a, b) {
  if (a === b) return true
  if (plainRecord(a) && plainRecord(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length || !aKeys.every((key) => key in b)) return false
    return aKeys.every((key) => sameStoredValue(a[key], b[key]))
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, at) => sameStoredValue(entry, b[at]))
  }
  return false
}

function reconcileMap(stored, edited) {
  if (!plainRecord(stored) || !plainRecord(edited)) return edited
  const out = { ...stored }
  for (const key of MAP_MUTABLE_FIELDS) {
    if (!Object.hasOwn(edited, key)) continue
    const next = edited[key]
    if (!Object.hasOwn(stored, key)) {
      // The stored map never had it, so it is there only because normalisation filled it in. Keep it
      // out unless the helper really changed it — which, with nothing to compare against, we cannot know.
      continue
    }
    if (sameStoredValue(stored[key], next)) continue
    out[key] = next
  }
  return out
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
 *
 * A list that IS being written is reconciled against the stored maps by `reconcileMap`, for the same
 * reason one step further in: an edit arrives as `{ ...normalizedMap, <change> }`, and writing that
 * wholesale carried every default along with the change.
 */
function withMaps(doc, maps, activeMapId) {
  const base = isRecord(doc) ? doc : {}
  const stored = objectList(base.maps)
  // null = keep the stored list byte for byte, defaults and all.
  const list =
    maps === null
      ? stored
      : objectList(maps).map((map) => {
          const was = stored.find((entry) => entry.id === map.id)
          return was === undefined ? map : reconcileMap(was, map)
        })
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

      // ==== 66-import.js ======================================================
/**
 * 纯文本批量导入 —— Phase 6 的第二件。
 *
 * WHY PLAIN TEXT, AND WHY THIS IS THE WHOLE FEATURE. The author's real material lives in notes, chat logs and
 * bullet lists. What is wanted at that moment is not a mapping wizard but "these are the names, put them in" —
 * the details get filled in later, from the entity's own form. So the format is one name per line, and the
 * importer's job is to be predictable about everything else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not invent ids (it uses `mintId`, the same one the ＋ button uses),
 * does not merge into an existing entity, and does not overwrite a field. Two names that differ only by
 * whitespace or case are the same person to a novelist, so the second is SKIPPED and reported rather than
 * imported twice — which is why the plan is shown before anything is written.
 *
 * NO HOST WORK. Entities are created in the document and saved the way every other edit is, so an import
 * cannot bypass the validator or the `.prev` backup. The parser is pure, so the whole of the interesting
 * behaviour is asserted in `client-selftest.mjs`.
 */

/** How many lines one paste may import, so a runaway paste cannot write a 50,000-entry document. */
const IMPORT_MAX_NAMES = 500

/** Bullet and numbering markers, which is what a name pasted from a list arrives with. */
const IMPORT_MARKER = /^\s*(?:[-*•·–—]+|\d+\s*[.、)）:：])\s*/

/**
 * Extra ways to write a field's name, beyond the label the form shows.
 *
 * The labels come from the schema, so `种族：` and `性别：` work for any entity with no code here. These are
 * the words people actually type that the form does not use: the form says 年龄说明 because AGE IS NOT
 * STORED (see `docs/data-model.md` — a stored age is wrong the moment the story moves), and it says
 * 出生时间 where a note says 出生.
 */
const IMPORT_FIELD_ALIASES = {
  姓名: 'name',
  名字: 'name',
  名称: 'name',
  标题: 'title',
  年龄: 'ageNote',
  年纪: 'ageNote',
  出生: 'born',
  生日: 'born',
  简介: 'summary',
  介绍: 'summary',
  说明: 'summary',
  类型: 'kind',
  类别: 'kind',
  种类: 'kind',
  品阶: 'rarity',
  稀有度: 'rarity',
  状态: 'status',
  性别: 'gender',
  种族: 'race',
  外貌: 'appearance',
  性格: 'personality',
  别名: 'aliases',
  别称: 'aliases',
}

/** The fields an import may fill. A `ref`, a `refList` or a `structure` needs the author, not a parser. */
const IMPORT_FILLABLE = new Set(['text', 'longtext', 'number', 'time', 'select', 'stringlist'])

/** The separators a list value is written with. */
const IMPORT_LIST_SPLIT = /[、,，;；/|]+/

/** Punctuation that sits between a name and the rest of a sentence. */
const IMPORT_LEAD = /^[\s是叫名为「『“"']+|[\s，,。；;：:、]+$/g

/** The fields that carry a whole sentence, where a line the parser only half understood is preserved. */
const IMPORT_SUMMARY_KEYS = ['summary', 'description', 'background', 'intro', 'body', 'note']

/** Whether a schema value looks like a field descriptor. */
const isFieldDescriptor = (value) => value !== null && typeof value === 'object' && typeof value.key === 'string'

/** The fields of an entity an import may fill, with every label that addresses them. */
function importFields(entityKey) {
  const entity = ENTITIES[entityKey]
  const fields = objectList(entity?.fields).filter(isFieldDescriptor).filter((field) => IMPORT_FILLABLE.has(field.type))
  const byLabel = new Map()
  for (const field of fields) {
    if (typeof field.label === 'string' && field.label !== '') byLabel.set(field.label, field)
  }
  for (const [alias, key] of Object.entries(IMPORT_FIELD_ALIASES)) {
    const field = fields.find((entry) => entry.key === key)
    if (field !== undefined && !byLabel.has(alias)) byLabel.set(alias, field)
  }
  return { fields, byLabel }
}

/**
 * The declared option a piece of text is talking about, if any.
 *
 * GENERIC, and that is the whole point: `性别` declares 男/女/其他/未定, so 「男性」 finds 男 with no per-entity
 * table anywhere. Longest first, so 「半精灵」 is not read as 「精灵」. The same inclusion rule the generators
 * apply to model output.
 */
function matchOption(field, text) {
  if (!Array.isArray(field?.options)) return null
  const haystack = String(text ?? '')
  let best = null
  for (const option of field.options) {
    if (option === null || typeof option !== 'object') continue
    for (const candidate of [option.label, option.value]) {
      if (typeof candidate !== 'string' || candidate === '') continue
      if (!haystack.includes(candidate)) continue
      if (best === null || candidate.length > best.length) best = candidate
    }
  }
  if (best === null) return null
  const hit = field.options.find((option) => option?.label === best || option?.value === best)
  return hit?.value ?? best
}

/**
 * A value the document already uses, found inside the line.
 *
 * THE AUTHOR'S OWN WORDS ARE THE VOCABULARY. `race` is free text, so nothing declares that 人类 is a race —
 * but the project already contains it. `context.js` reads the same way when it builds a prompt, for the same
 * reason: a new entry should read like the same book. Longest first, so 「半精灵」 wins over 「精灵」.
 */
function matchVocabulary(text, vocabulary) {
  const haystack = String(text ?? '')
  const list = (Array.isArray(vocabulary) ? vocabulary : [])
    .map((value) => String(value ?? '').trim())
    .filter((value) => value !== '')
    .sort((left, right) => right.length - left.length)
  for (const value of list) {
    if (haystack.includes(value)) return value
  }
  return null
}

/** A year written in the line, as `{ year }` — the only form in which an age can be stored. */
function matchYear(text) {
  const match = /(\d{1,6})\s*年/.exec(String(text ?? ''))
  if (match === null) return null
  const year = Number(match[1])
  return Number.isFinite(year) ? { year } : null
}

/** One `字段：值` pair's value, in the type that field declares. `undefined` means "not understood". */
function coerceImportValue(field, raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return undefined
  if (field.type === 'select') return matchOption(field, value) ?? undefined
  if (field.type === 'stringlist') {
    const parts = value.split(IMPORT_LIST_SPLIT).map((part) => part.trim()).filter((part) => part !== '')
    return parts.length === 0 ? undefined : parts
  }
  if (field.type === 'time') return matchYear(value) ?? undefined
  if (field.type === 'number') {
    const match = /-?\d+(?:\.\d+)?/.exec(value)
    return match === null ? undefined : Number(match[0])
  }
  // `年龄：23` reads better as 「23岁」 in a field whose whole purpose is to describe an age in words.
  if (field.key === 'ageNote' && /^\d+$/.test(value)) return `${value}岁`
  return value
}

/**
 * Everything one pasted line says about one entity.
 *
 * @param {string} line
 * @param {string} entityKey
 * @param {object} [vocabulary] - `{ race: [...], kind: [...], rarity: [...] }`: values already in the
 *   project, so the parser recognises the author's own words for things.
 * @returns `{ name, fields, matched }` — `fields` is what would be filled in, and `matched` is what the
 *   preview shows, so the author can read the parser's mind before agreeing to it.
 */
function parseEntityLine(line, entityKey, vocabulary) {
  // STRINGS ONLY, like `parseNameList`: a line is text, and `String(42)` turning a stray number into a
  // character named 「42」 is the kind of help nobody asked for.
  const text = typeof line === 'string' ? line.trim() : ''
  const { fields, byLabel } = importFields(entityKey)
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const out = {}
  const matched = []
  let rest = text

  // 1. EXPLICIT `字段：值` PAIRS, addressed by the schema's own labels — the most reliable signal there is, and
  //    the one an author can use deliberately: 「姓名：小明 年龄：23 种族：人类」.
  const labelPattern = [...byLabel.keys()]
    .sort((left, right) => right.length - left.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (labelPattern.length > 0 && /[:：=]/.test(text)) {
    // THE VALUE ENDS WHERE THE NEXT LABEL BEGINS, not at the next comma. 「姓名：小明 年龄：23 种族：人类」 has
    // no commas at all — one greedy value swallowed the whole line and the entry came out named
    // 「小明 年龄：23 种族：人类 状态：在世」. A name may contain a space; only the NEXT LABEL ends a value.
    const labels = labelPattern.join('|')
    const stop = `(?=\\s*(?:${labels})\\s*[:：=]|[,，;；。\\n]|$)`
    const pair = new RegExp(`(${labels})\\s*[:：=]\\s*(.*?)${stop}`, 'g')
    for (const found of text.matchAll(pair)) {
      const field = byLabel.get(found[1])
      if (field === undefined || out[field.key] !== undefined) continue
      const value = coerceImportValue(field, found[2])
      if (value === undefined) continue
      out[field.key] = value
      matched.push({ key: field.key, label: field.label, value })
      rest = rest.replace(found[0], ' ')
    }
  }

  // 2. THE NAME: `姓名：` answered it above; otherwise it is the subject of the sentence (before 是/叫/，),
  //    and only then the whole line.
  if (typeof out.name !== 'string' || out.name === '') {
    const head = /^([^，,。；;：:（(]{1,40}?)(?:是|叫|名为|，|,|。|；|;|：|:|（|\(|$)/.exec(rest)
    const candidate = (head === null ? rest : head[1]).replace(IMPORT_LEAD, '').trim()
    if (candidate !== '') {
      out.name = candidate
      rest = rest.slice(head === null ? 0 : head[0].length)
    }
  }

  // 3. WHAT IS LEFT, read against the values the project already uses and against each `select`'s options.
  for (const field of fields) {
    if (out[field.key] !== undefined) continue
    if (field.key === 'name' || field.key === 'title') continue
    if (field.type === 'select') {
      const option = matchOption(field, rest)
      if (option !== null) {
        out[field.key] = option
        matched.push({ key: field.key, label: field.label, value: option })
      }
      continue
    }
    if (field.type === 'time') {
      const time = matchYear(rest)
      if (time !== null) {
        out[field.key] = time
        matched.push({ key: field.key, label: field.label, value: `${time.year}年` })
      }
      continue
    }
    if (field.type !== 'text') continue
    const known = matchVocabulary(rest, vocabulary?.[field.key])
    if (known !== null) {
      out[field.key] = known
      matched.push({ key: field.key, label: field.label, value: known })
    }
  }

  // 4. AN AGE IN WORDS, which has nowhere structured to go — see the note on `ageNote` above.
  if (out.ageNote === undefined && byKey.has('ageNote')) {
    const age = /(\d{1,3})\s*岁/.exec(rest)
    if (age !== null) {
      out.ageNote = `${age[1]}岁`
      matched.push({ key: 'ageNote', label: byKey.get('ageNote').label, value: `${age[1]}岁` })
    }
  }

  // 5. WHAT IS LEFT IS KEPT as the entity's own sentence, in whichever field carries prose. A parser that
  //    understood four words of six and discarded the rest would throw away the author's own description of
  //    their own character; keeping it means the worst case is a sentence they can edit, in the field they
  //    would have written it in anyway.
  const leftover = rest.replace(IMPORT_LEAD, '').trim()
  if (leftover.length >= 6) {
    const summaryKey = IMPORT_SUMMARY_KEYS.find((key) => byKey.has(key))
    if (summaryKey !== undefined && out[summaryKey] === undefined) out[summaryKey] = leftover
  }
  return { name: typeof out.name === 'string' ? out.name : '', fields: out, matched }
}

/**
 * Split a paste into entity entries: a name per line, plus whatever else the line says.
 *
 * @returns `{ entries, ignored }` — `entries` in first-seen order, de-duplicated by name; `ignored` names
 *   every line left out and why, so "I pasted 40 lines and got 38" always has an answer.
 */
function parseEntityLines(text, entityKey, vocabulary) {
  const raw = typeof text === 'string' ? text : ''
  const entries = []
  const ignored = []
  const seen = new Set()
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const lineNumber = index + 1
    const trimmed = line.replace(IMPORT_MARKER, '').trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) {
      ignored.push({ line: lineNumber, text: trimmed, reason: 'comment' })
      continue
    }
    const parsed = parseEntityLine(trimmed, entityKey, vocabulary)
    const name = parsed.name.trim()
    if (name === '') {
      ignored.push({ line: lineNumber, text: trimmed, reason: 'no-name' })
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      ignored.push({ line: lineNumber, text: trimmed, reason: 'duplicate' })
      continue
    }
    if (entries.length >= IMPORT_MAX_NAMES) {
      ignored.push({ line: lineNumber, text: trimmed, reason: 'too-many' })
      continue
    }
    seen.add(key)
    entries.push({ line: lineNumber, source: trimmed, name, fields: parsed.fields, matched: parsed.matched })
  }
  return { entries, ignored }
}

/**
 * Split a pasted list into names. Kept for a name-only paste; `parseEntityLines` is the general one.
 *
 * @returns `{ names, ignored }` — `names` in first-seen order, de-duplicated; `ignored` names every line left
 *   out and why, so "I pasted 40 lines and got 38" always has an answer.
 */
function parseNameList(text) {
  // STRINGS ONLY. A paste is text; anything else is a caller bug, and `String(42)` quietly turning a stray
  // number into a character named 「42」 is the kind of help nobody asked for.
  const raw = typeof text === 'string' ? text : ''
  const names = []
  const ignored = []
  const seen = new Set()
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const lineNumber = index + 1
    const withoutMarker = line.replace(IMPORT_MARKER, '')
    const name = withoutMarker.trim()
    if (name === '') continue
    // `#` starts a comment, so a note pasted along with the names does not become a character.
    if (name.startsWith('#')) {
      ignored.push({ line: lineNumber, text: name, reason: 'comment' })
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      ignored.push({ line: lineNumber, text: name, reason: 'duplicate' })
      continue
    }
    if (names.length >= IMPORT_MAX_NAMES) {
      ignored.push({ line: lineNumber, text: name, reason: 'too-many' })
      continue
    }
    seen.add(key)
    names.push(name)
  }
  return { names, ignored }
}

/**
 * What an import would do, before it does anything.
 *
 * Accepts entries (`{ name, fields }`) or bare names, so a name-only paste behaves exactly as it did.
 *
 * @returns `{ create, duplicates, taken }` — `create` is what the author is agreeing to, and it carries the
 *   parsed fields so the preview can show the parser's reading rather than only the names.
 */
function planImport(input) {
  const raw = Array.isArray(input?.entries) ? input.entries : Array.isArray(input?.names) ? input.names : []
  const existing = new Set(
    (Array.isArray(input?.existing) ? input.existing : [])
      .map((name) => String(name ?? '').trim().toLowerCase())
      .filter((name) => name !== ''),
  )
  const create = []
  const duplicates = []
  for (const item of raw) {
    const isRecord = item !== null && typeof item === 'object'
    const name = String(isRecord ? item.name ?? '' : item ?? '').trim()
    if (name === '') continue
    // Case- and whitespace-insensitive: 「李明」 and 「李明 」 are one person, and an importer that treats them as
    // two leaves the author with a duplicate they only notice much later.
    if (existing.has(name.toLowerCase())) {
      duplicates.push(name)
      continue
    }
    create.push({
      name,
      fields: isRecord && item.fields !== null && typeof item.fields === 'object' ? item.fields : {},
      source: isRecord && typeof item.source === 'string' ? item.source : name,
      matched: isRecord && Array.isArray(item.matched) ? item.matched : [],
    })
  }
  return { create, duplicates, taken: existing }
}

/**
 * The values the project already uses for a target's text fields.
 *
 * THE AUTHOR'S OWN WORDS, read the way `context.js` reads them when it writes a prompt. `race` is free text,
 * so nothing declares that 人类 is one — but the project's own characters do, and that is a better source than
 * any list this file could carry. It also means the parser gets better as the book grows.
 */
function importVocabulary(doc, target) {
  const { fields } = importFields(target?.entity)
  const out = {}
  for (const field of fields) {
    if (field.type !== 'text') continue
    const values = objectList(doc?.[target?.key])
      .map((entry) => entry?.[field.key])
      .filter((value) => typeof value === 'string' && value.trim() !== '')
    if (values.length > 0) out[field.key] = [...new Set(values)]
  }
  return out
}

/**
 * The lists a branch can import into, from its own descriptor.
 *
 * Driven by the declarations rather than a hard-coded list of branches: any branch that declares a collection
 * or a tree of entities gets the control, including ones added later. `blank` decides the entity's default
 * shape, so a spec without a `blank` factory cannot create anything and is not offered.
 */
function importTargets(branch) {
  const slots = [
    ...(Array.isArray(branch?.tree?.groups) ? branch.tree.groups : []),
    ...(Array.isArray(branch?.tree?.leaves) ? branch.tree.leaves : []),
    ...(Array.isArray(branch?.collections) ? branch.collections : []),
  ]
  const out = []
  const seen = new Set()
  for (const slot of slots) {
    const entityKey = slot?.entity
    if (typeof entityKey !== 'string' || entityKey === '') continue
    if (seen.has(slot.key)) continue
    const entity = ENTITIES[entityKey]
    if (entity === undefined || typeof entity.blank !== 'function') continue
    seen.add(slot.key)
    out.push({ key: slot.key, entity: entityKey, label: entity.label ?? slot.label ?? entityKey, spec: slot })
  }
  return out
}

/**
 * Every id already in use anywhere in a branch, so a minted one cannot collide across its lists.
 *
 * The same rule `EntityTree` applies: ids must be unique across a branch, not merely within one collection.
 */
function branchTakenIds(branch, doc) {
  const set = new Set()
  const slots = [
    ...(Array.isArray(branch?.tree?.groups) ? branch.tree.groups : []),
    ...(Array.isArray(branch?.tree?.leaves) ? branch.tree.leaves : []),
    ...(Array.isArray(branch?.collections) ? branch.collections : []),
  ]
  for (const slot of slots) {
    for (const entry of objectList(doc?.[slot?.key])) {
      if (typeof entry?.id === 'string' && entry.id !== '') set.add(entry.id)
    }
  }
  return set
}

/** The names already in one list, for duplicate detection. */
function existingNamesIn(doc, key, entityKey) {
  const entity = ENTITIES[entityKey]
  const titleOf = typeof entity?.titleOf === 'function' ? entity.titleOf : (entry) => entry?.name ?? entry?.title ?? ''
  return objectList(doc?.[key]).map((entry) => String(titleOf(entry) ?? ''))
}

/** The entities one paste would create, built by the SAME factory the ＋ button uses. */
function buildImportedEntities(spec, entityKey, entries, taken) {
  const entity = ENTITIES[entityKey]
  if (entity === undefined || typeof entity.blank !== 'function') return []
  // NOT `objectList`: it keeps RECORDS only, and a list of names is a list of STRINGS — it would have
  // silently dropped every one of them, and the import would report success having created nothing. This is
  // the second time that helper has eaten a string array in this project (the first was the stamp glyph
  // points), so the rule is worth stating: `objectList` is for lists of objects, never for scalars.
  const list = Array.isArray(entries) ? entries : []
  const created = []
  for (const entry of list) {
    const isRecord = entry !== null && typeof entry === 'object'
    const name = String(isRecord ? entry.name ?? '' : entry ?? '').trim()
    if (name === '') continue
    const node = childNodeFor(spec, entity, null, taken)
    // THE PARSED FIELDS, applied over the blank — and ONLY keys the entity declares. Writing a field the
    // schema does not know would put a key in the author's document that no form can edit and no validator
    // expects; the same rule the model-output sanitiser follows.
    const fields = isRecord && entry.fields !== null && typeof entry.fields === 'object' ? entry.fields : {}
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'id' || key === 'name' || key === 'title') continue
      if (!(key in node)) continue
      node[key] = value
    }
    // The name is what was typed. `blank()` supplies the default (「新人物」 and so on), which is right for a
    // hand-created entry and wrong here: the author already gave the name.
    const nameKey = 'name' in node ? 'name' : 'title' in node ? 'title' : null
    if (nameKey !== null) node[nameKey] = name
    // An id minted from the default name would read `char-新人物`, and the id is what a chapter's 人物引用
    // stores — so it is re-minted from the real name.
    node.id = mintId(spec?.idPrefix ?? entity.idPrefix, name, taken)
    // `mintId` only CHECKS `taken`; it never records the id it hands out. Recording it here is what keeps two
    // entries in one paste from being minted the same id. The app never hit this because it re-derives
    // `taken` from the document between two presses, and an import creates everything in a single pass.
    taken.add(node.id)
    created.push(node)
  }
  return created
}

/**
 * The import control: pick a list, paste, see what would happen, then do it.
 *
 * The preview is not a nicety — it is the project's rule everywhere else that generated content is shown
 * before it lands. Here it is cheap and it is the only chance to notice that the paste contained eight lines
 * of notes and four names.
 */
function BulkImport(props) {
  const { branch, doc, onMutate } = props
  const targets = react.useMemo(() => importTargets(branch), [branch])
  const [targetKey, setTargetKey] = react.useState(null)
  const [text, setText] = react.useState('')
  const [open, setOpen] = react.useState(false)
  const [receipt, setReceipt] = react.useState(null)

  if (targets.length === 0) return null
  const target = targets.find((entry) => entry.key === targetKey) ?? targets[0]
  // THE VOCABULARY IS THE PROJECT'S OWN WORDS, read per target — so 人类 is recognised because this book's
  // characters are already human, not because a list in this file says so.
  const vocabulary = importVocabulary(doc, target)
  const parsed = parseEntityLines(text, target.entity, vocabulary)
  const plan = planImport({ entries: parsed.entries, existing: existingNamesIn(doc, target.key, target.entity) })

  const [error, setError] = react.useState(null)

  const run = () => {
    if (plan.create.length === 0) return
    const taken = branchTakenIds(branch, doc)
    const created = buildImportedEntities(target.spec, target.entity, plan.create, taken)
    // NOT A SILENT RETURN. `buildImportedEntities` refuses when the entity is unknown or its `blank` factory is
    // missing, and a click that produces nothing with no explanation is the family of bug this file has already
    // cost once (「按钮没有任何效果」). The button cannot be pressed in this state, so reaching it is a real fault.
    if (created.length === 0) {
      setError(`没能为「${target.label}」建成条目——这类实体的定义可能不完整（缺少 blank()）。`)
      return
    }
    setError(null)
    onMutate((current) => ({ ...current, [target.key]: [...objectList(current[target.key]), ...created] }))
    setReceipt({
      created: created.length,
      duplicates: plan.duplicates.length,
      ignored: parsed.ignored.length,
      label: target.label,
    })
    setText('')
  }

  return h(
    'div',
    { style: { marginBottom: '10px', padding: '8px', border: `1px solid ${muted}`, borderRadius: '6px' } },
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
        onClick: () => setOpen((value) => !value),
      },
      h('span', null, `${open ? '▾' : '▸'} 批量导入名字`),
      h('span', { style: { color: muted, fontSize: '11px' } }, '一行一个'),
    ),
    open
      ? h(
          'div',
          { style: { marginTop: '6px' } },
          targets.length === 1
            ? null
            : h(
                'div',
                { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
                h('span', { style: { fontSize: '12px', opacity: 0.6 } }, '导入到'),
                h(
                  'select',
                  {
                    value: target.key,
                    onChange: (event) => setTargetKey(event.target.value),
                    style: { ...inputStyle, flex: '1 1 auto' },
                  },
                  ...targets.map((entry) => h('option', { key: entry.key, value: entry.key }, entry.label)),
                ),
              ),
          h('textarea', {
            value: text,
            rows: 6,
            placeholder:
              '每行一个。可以只写名字，也可以带上已知的信息：\n小明是一个人类男性，今年23岁。\n姓名：小明 种族：人类 状态：在世\n以 # 开头的行是注释；行首的 -、*、1. 这类列表符号会被去掉。',
            onChange: (event) => {
              setText(event.target.value)
              setReceipt(null)
            },
            style: { ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 },
          }),
          // WHAT WOULD HAPPEN, before it happens — including WHAT THE PARSER READ, because a heuristic that
          // only reports "12 entries" gives the author no chance to see that it read 人类 as a name.
          h(
            'div',
            { style: { fontSize: '12px', margin: '6px 0', lineHeight: 1.8, opacity: 0.8 } },
            parsed.entries.length === 0
              ? '还没有可导入的内容。'
              : `将新建 ${plan.create.length} 个${target.label}` +
                (plan.duplicates.length === 0 ? '' : `；跳过 ${plan.duplicates.length} 个已存在（${plan.duplicates.slice(0, 4).join('、')}${plan.duplicates.length > 4 ? '…' : ''}）`) +
                (parsed.ignored.length === 0 ? '' : `；忽略 ${parsed.ignored.length} 行`),
          ),
          plan.create.length === 0
            ? null
            : h(
                'div',
                { style: { fontSize: '11px', marginBottom: '6px', lineHeight: 1.9, opacity: 0.7 } },
                ...plan.create.slice(0, 6).map((entry, index) =>
                  h(
                    'div',
                    { key: `${entry.name}-${index}` },
                    `· ${entry.name}` +
                      (entry.matched.length === 0
                        ? '（只有名字）'
                        : ' → ' + entry.matched.map((hit) => `${hit.label} ${String(hit.value)}`).join(' · ')),
                  ),
                ),
                plan.create.length > 6 ? h('div', null, `…还有 ${plan.create.length - 6} 个`) : null,
              ),
          h(
            'div',
            { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h(
              'button',
              {
                type: 'button',
                style: { ...buttonStyle, opacity: plan.create.length === 0 ? 0.5 : 1 },
                disabled: plan.create.length === 0,
                onClick: run,
              },
              `导入 ${plan.create.length} 个`,
            ),
            h('span', { style: { fontSize: '11px', opacity: 0.5 } }, '导入后记得保存。'),
          ),
          error === null ? null : h(Note, { tone: 'error', text: error }),
          receipt === null
            ? null
            : h(
                'div',
                { style: { fontSize: '12px', marginTop: '6px', opacity: 0.75, lineHeight: 1.8 } },
                `已新建 ${receipt.created} 个${receipt.label}。` +
                  (receipt.duplicates === 0 ? '' : `跳过 ${receipt.duplicates} 个重名，`) +
                  (receipt.ignored === 0 ? '' : `忽略 ${receipt.ignored} 行，`) +
                  '按「保存」写进项目。',
              ),
        )
      : null,
  )
}

      // ==== 68-export.js ======================================================
/**
 * 导出全书 —— Phase 6 的第一件，也是写作这条闭环的终点。
 *
 * WHY IT IS A HOST CALL AND NOT A CLIENT LOOP. Every chapter is a file. Asking the browser for forty of them
 * and pasting them together would read on the slow side of the boundary and assemble outside the offline
 * suite — so the host assembles (`lib/impl/manuscript.js`) and this only chooses the options and downloads
 * the result. The client's whole job is two pure functions and a button.
 */

/** The query string for the options. Pure, so the mapping is assertable without a server. */
function manuscriptQuery(options) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const flag = (value, fallback) => (value === undefined || value === null ? fallback : value === true)
  const parts = [
    `titlePage=${flag(source.titlePage, true) ? 1 : 0}`,
    `summary=${flag(source.summary, false) ? 1 : 0}`,
    `meta=${flag(source.meta, false) ? 1 : 0}`,
    // The chapters are `##` under the book's `#`; that is the shape a manuscript is read in.
    `headingLevel=2`,
  ]
  return parts.join('&')
}

/**
 * One line describing what was exported, plus every chapter left out.
 *
 * THE SKIPPED LIST IS THE POINT. A manuscript that quietly omits chapter twelve is worse than one that
 * refuses to export, so an unreadable chapter is named here rather than hoped about.
 */
function manuscriptReceipt(result) {
  const chapters = Number(result?.chapterCount)
  const words = Number(result?.wordCount)
  const skipped = Array.isArray(result?.skipped) ? result.skipped : []
  const head = `已导出 ${Number.isFinite(chapters) ? chapters : 0} 章 · ${Number.isFinite(words) ? words : 0} 字`
  if (skipped.length === 0) return { text: head, tone: 'ok' }
  const names = skipped.map((entry) => String(entry?.path ?? '?').replace(/^draft\//, '')).join('、')
  return {
    text: `${head}。但有 ${skipped.length} 章没能读出来，不在文件里：${names}`,
    tone: 'error',
  }
}
/**
 * The export control: three options, a path, and a download as the second choice.
 *
 * REORDERED AFTER THE FIRST VERSION WAS UNFINDABLE. 「导出的文件没有给出地址，无法找到」 — and that is a design
 * fault, not a user error: a Blob download lands in a directory the page is not allowed to know. So saving into
 * the project is now the primary action, because that is the one whose result has an address, and the download
 * is labelled with where it actually goes.
 */
function ManuscriptExport(props) {
  const { root } = props
  const [options, setOptions] = react.useState({ titlePage: true, summary: false, meta: false })
  const [busy, setBusy] = react.useState(null)
  const [error, setError] = react.useState(null)
  const [receipt, setReceipt] = react.useState(null)
  const [copied, setCopied] = react.useState(false)

  const toggle = (key) => setOptions((current) => ({ ...current, [key]: current[key] !== true }))

  /** A Blob and a synthetic click — the only way a page hands a file over without a server round trip. */
  const download = (text, name) => {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  /** 保存到项目里: writes the book into novel/export/ and answers with its real path. */
  const save = () => {
    // A CLICK MUST NEVER DO NOTHING. This returned early when `root` was empty — which is exactly what
    // happened when the pane was never given it, and the report was 「点击按钮没有任何效果」 with nothing on
    // screen to explain it. A missing root is a bug in how this was rendered, so it says so.
    if (isBlank(root)) {
      setError('这一栏没有拿到项目路径，按钮无法工作（界面接线的问题，不是你操作错了）。请刷新页面。')
      return
    }
    setBusy('project')
    setError(null)
    setReceipt(null)
    setCopied(false)
    fetch(api(`${API}/manuscript`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ root, ...options }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        setReceipt({
          ...manuscriptReceipt(body),
          kind: 'project',
          absolute: typeof body?.absolute === 'string' ? body.absolute : '',
          relative: typeof body?.relative === 'string' ? body.relative : '',
          bytes: Number(body?.bytes) || 0,
        })
      })
      .catch((failure) => setError(String(failure?.message ?? failure)))
      .finally(() => setBusy(null))
  }

  /** 下载: assembles over the wire and hands the text to the browser. */
  const fetchAndDownload = () => {
    // Same rule as `save`: a click that cannot do its job says why, rather than looking broken.
    if (isBlank(root)) {
      setError('这一栏没有拿到项目路径，按钮无法工作（界面接线的问题，不是你操作错了）。请刷新页面。')
      return
    }
    setBusy('download')
    setError(null)
    setReceipt(null)
    fetch(api(`${API}/manuscript?root=${encodeURIComponent(root)}&${manuscriptQuery(options)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        const text = typeof body?.text === 'string' ? body.text : ''
        if (text === '') throw new Error('宿主返回了空的手稿')
        download(text, typeof body?.name === 'string' && body.name !== '' ? body.name : 'manuscript.md')
        setReceipt({ ...manuscriptReceipt(body), kind: 'download', name: body?.name, absolute: '', relative: '', bytes: 0 })
      })
      .catch((failure) => setError(String(failure?.message ?? failure)))
      .finally(() => setBusy(null))
  }

  const copy = () => {
    const path = receipt?.absolute ?? ''
    if (path === '' || typeof navigator === 'undefined' || navigator.clipboard === undefined) return
    navigator.clipboard.writeText(path).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  const option = (key, label, title) =>
    h(
      'button',
      {
        key,
        type: 'button',
        title,
        style: { ...buttonStyle, opacity: options[key] === true ? 1 : 0.55 },
        onClick: () => toggle(key),
      },
      `${options[key] === true ? '✓ ' : ''}${label}`,
    )

  const saved = receipt !== null && receipt.kind === 'project' && receipt.absolute !== ''

  return h(
    'div',
    { style: { marginBottom: '12px', padding: '10px', border: `1px solid ${muted}`, borderRadius: '6px' } },
    h('div', { style: { fontSize: '12px', opacity: 0.6, marginBottom: '6px' } }, '导出全书'),
    h(
      'div',
      { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' } },
      option('titlePage', '标题页', '以书名开头'),
      option('summary', '章节梗概', '每章标题下附一句梗概'),
      option('meta', '章节状态与人物', '每章标题下附状态与出场人物'),
    ),
    h(
      'div',
      { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
      h(
        'button',
        { type: 'button', style: { ...buttonStyle, opacity: busy === null ? 1 : 0.5 }, disabled: busy !== null, onClick: save },
        busy === 'project' ? '正在保存…' : '保存到项目里',
      ),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, opacity: busy === null ? 1 : 0.5 },
          disabled: busy !== null,
          title: '下载到浏览器的下载目录；具体位置由浏览器决定，页面看不到',
          onClick: fetchAndDownload,
        },
        busy === 'download' ? '正在下载…' : '下载',
      ),
    ),
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.5, marginTop: '4px', lineHeight: 1.8 } },
      '「保存到项目里」写进 novel/export/ 并给出完整路径；「下载」的去处由浏览器决定，页面看不到。',
    ),
    error === null ? null : h(Note, { tone: 'error', text: `导出失败：${error}` }),
    receipt === null
      ? null
      : h(
          'div',
          { style: { fontSize: '12px', marginTop: '6px', lineHeight: 1.9 } },
          // THE PATH COMES FIRST, because that is the question this screen exists to answer.
          saved
            ? h(
                'div',
                { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { opacity: 0.6 } }, '已保存到'),
                h(
                  'code',
                  { style: { wordBreak: 'break-all', background: 'rgba(128,128,128,0.12)', padding: '1px 4px' } },
                  receipt.relative,
                ),
                h('button', { type: 'button', style: { ...buttonStyle, fontSize: '11px' }, onClick: copy }, copied ? '已复制' : '复制完整路径'),
              )
            : null,
          saved ? h('div', { style: { fontSize: '11px', opacity: 0.55, wordBreak: 'break-all' } }, receipt.absolute) : null,
          receipt.kind === 'download'
            ? h('div', { style: { opacity: 0.75 } }, `已下载 ${receipt.name ?? 'manuscript.md'}——在浏览器的下载目录里，页面看不到它具体在哪。`)
            : null,
          h(
            'div',
            {
              style: {
                marginTop: '2px',
                color: receipt.tone === 'error' ? '#e5534b' : undefined,
                opacity: receipt.tone === 'error' ? 1 : 0.75,
              },
            },
            saved && receipt.bytes > 0 ? `${receipt.text} · ${(receipt.bytes / 1024).toFixed(1)} KB` : receipt.text,
          ),
        ),
  )
}

      // ==== 70-branches.js ====================================================
/**
 * Branch bodies and the router that picks one.
 *
 * Each body owns its own toolbar and its own detail pane; the shell only
 * supplies the frame. Bodies that have not landed yet render `PlannedBranch`,
 * which states what will go there — a visible, honest placeholder beats a
 * silent blank panel, and it keeps navigation complete while views arrive one
 * at a time.
 */

function PlannedBranch(props) {
  const { branch } = props
  return h(
    'div',
    null,
    h(Note, { text: `${branch.hint}。` }),
    h(
      'div',
      { style: { marginTop: '14px', fontSize: '12px', opacity: 0.5, lineHeight: 1.9 } },
      h('div', null, `分支标识：${branch.id}`),
      h('div', null, branch.planned ?? '待实现。'),
    ),
  )
}

/**
 * The chapter list. Props-driven, so the suite renders it directly.
 */
function ChapterListPane(props) {
  const { selected, onSelect, onCreate, creating, createError, totalWordCount } = props
  // A hand-edited project can hold a null entry; the pane must not depend on its
  // caller having filtered it.
  const chapters = objectList(props.chapters)
  return h(
    'div',
    null,
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, width: '100%', marginBottom: '10px' },
        disabled: creating === true,
        onClick: onCreate,
      },
      creating === true ? '创建中…' : '＋ 新建章节',
    ),
    createError !== null && createError !== undefined
      ? h('div', { style: { fontSize: '11px', color: '#e5534b', marginBottom: '8px' } }, createError)
      : null,
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.5, marginBottom: '8px' } },
      `${chapters.length} 章 · ${totalWordCount ?? 0} 字`,
    ),
    // 导出全书 belongs with the list: it is about the whole book, not the chapter that happens to be open.
    h(ManuscriptExport, { root: props.root }),
    chapters.length === 0
      ? h(Note, { text: '还没有章节。' })
      : h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          ...chapters.map((entry) => {
            const active = entry.path === selected
            return h(
              'div',
              {
                key: entry.path,
                onClick: () => onSelect(entry.path),
                title: entry.path,
                style: {
                  padding: '5px 8px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  background: active ? 'rgba(128,128,128,0.16)' : 'transparent',
                },
              },
              h(
                'div',
                {
                  style: {
                    fontSize: '12px',
                    fontWeight: active ? 600 : 400,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                entry.title || entry.id || entry.path.replace(/^draft\//, ''),
              ),
              h(
                'div',
                { style: { fontSize: '10px', opacity: 0.5 } },
                `${entry.wordCount} 字${entry.status ? ` · ${entry.status}` : ''}${
                  entry.frontMatterError !== null && entry.frontMatterError !== undefined ? ' · front matter 有问题' : ''
                }`,
              ),
            )
          }),
        ),
  )
}

/**
 * The prose editor. Props-driven, so the suite can render a loaded chapter — the
 * state that no fetch-driven test could reach.
 */
function ChapterEditorPane(props) {
  const {
    loading, placeholder, path, root, meta, body, wordCount, refOptions,
    status, actions, onPatchMeta, onSetBody, onDrafted, frontMatterError, feedback,
  } = props

  if (loading === true) return h(Note, { text: '载入中…' })
  if (meta === null) {
    // A placeholder is a normal state (nothing chosen yet), not a failure.
    if (placeholder !== undefined && placeholder !== null) return h(Note, { text: placeholder })
    return h(Note, { text: status.error ?? '章节不可用。', tone: 'error' })
  }

  return h(
    'div',
    null,
    h(CommitRow, {
      label: path,
      status,
      actions,
      extra: [h('span', { key: 'count', style: { fontSize: '12px', opacity: 0.6 } }, `${wordCount} 字`)],
    }),
    frontMatterError !== null && frontMatterError !== undefined
      ? h(
          'div',
          { style: { fontSize: '12px', color: '#e5a34b', marginBottom: '10px' } },
          `front matter 解析失败，正文仍可编辑：${frontMatterError}`,
        )
      : null,
    h(WriteFeedback, feedback),
    h(SchemaForm, { entity: ENTITIES.chapter, value: meta, onPatch: onPatchMeta, refOptions }),
    onDrafted !== undefined ? h(DraftControl, { root, path, onDrafted }) : null,
    // PHASE 5c, the client half. `DraftControl` above is one question to the model; this hands the whole
    // chapter to an agent, which reads the setting, follows a skill and writes the file itself. It reports
    // the known host limitation rather than failing silently when that call is unavailable.
    onDrafted !== undefined ? h(AgentDraftControl, { root, chapterTitle: meta?.title ?? '', onDrafted }) : null,
    h(
      'div',
      { style: { marginTop: '6px' } },
      h(FieldLabel, null, '正文'),
      h('textarea', {
        value: body,
        onChange: (event) => onSetBody(event.target.value),
        rows: 20,
        spellCheck: false,
        placeholder: '正文……支持 Markdown。',
        style: {
          ...inputStyle,
          fontFamily: 'inherit',
          fontSize: '13px',
          lineHeight: 1.9,
          resize: 'vertical',
          minHeight: '320px',
        },
      }),
    ),
  )
}

/** The chapters branch's presentation: list on the left, editor on the right. */
function ChapterBody(props) {
  return h(MasterDetail, { list: h(ChapterListPane, props.list), content: h(ChapterEditorPane, props.editor) })
}

/**
 * The chapters branch: a chapter list beside the prose editor.
 *
 * The one place the plugin writes something a human typed at length, so saves
 * are explicit rather than per-keystroke (the host validates every write against
 * the whole project), and the word count is recomputed from the buffer as you
 * type — it is derived data and never stored (docs/data-model.md principle 2).
 */
function ChapterBranch(props) {
  const { root } = props
  const [selected, setSelected] = react.useState(null)
  const [creating, setCreating] = react.useState(false)
  const [createError, setCreateError] = react.useState(null)
  const [listState, reloadList] = useEndpoint(
    isBlank(root) ? null : `${API}/chapters?root=${encodeURIComponent(root)}`,
  )
  const chapter = useChapter(root, selected)
  // Reference candidates for the metadata form — characters, places and the
  // outline nodes a chapter can point at. Read-only; this branch saves only its
  // own chapter files.
  const refOptions = useRefOptions(root, ['character', 'place', 'outline-node'])

  const chapters = objectList(listState.data?.chapters)

  // Open the first chapter once the list arrives, rather than showing an empty
  // editor while a manuscript sits behind it.
  react.useEffect(() => {
    if (selected !== null) return
    if (chapters.length > 0) setSelected(chapters[0].path)
  }, [selected, chapters.length])

  if (isBlank(root)) return h(Note, { text: '先在上方选择一个项目。' })
  if (listState.loading) return h(Note, { text: '载入中…' })
  if (listState.error !== null) {
    // A project with no data yet is a normal step on the way to creating one,
    // not a failure — say what to do instead of showing a code.
    if (listState.code === 'project-missing') {
      return h(Note, { text: '这个目录里还没有小说数据。点上方的「在此新建小说项目」，会创建 novel/ 目录与初始文档。' })
    }
    return h(Note, { text: listState.error, tone: 'error' })
  }

  const createChapter = () => {
    setCreating(true)
    setCreateError(null)
    fetch(api(`${API}/chapter`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ root, title: '新章节' }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        setSelected(body.path)
        reloadList()
      })
      .catch((error) => setCreateError(String(error?.message ?? error)))
      .finally(() => setCreating(false))
  }

  // `editorProps` rather than a rendered element: `ChapterBody` is pure and takes
  // each pane's props, so a test can drive either pane with a fixture.
  const editorProps =
    selected === null
      ? { loading: false, placeholder: '左侧选择一章开始编辑，或点「新建章节」。', meta: null, status: { error: null } }
      : chapter.state.loading
        ? { loading: true, meta: null, status: { error: null } }
        : {
            loading: false,
            path: selected,
            root,
            meta: chapter.state.meta,
            body: chapter.state.body,
            wordCount: chapter.state.wordCount,
            refOptions,
            status: chapter.state,
            actions: { save: chapter.save, revert: chapter.reload },
            onPatchMeta: chapter.patchMeta,
            onSetBody: chapter.setBody,
            // The draft joins the editor as UNSAVED text, so a generation can never
            // overwrite prose the author has not committed.
            // The updater form matters: the response arrives seconds later, and merging
            // against the body captured when the request started would silently discard
            // anything typed since.
            onDrafted: (text, mode) => chapter.setBody((current) => mergeDraft(current, text, mode)),
            frontMatterError: chapter.state.frontMatterError,
            feedback: { error: null, issues: chapter.state.issues, warnings: chapter.warnings },
          }

  return h(ChapterBody, {
    list: {
      // `root` travels with the list because 导出全书 lives in this pane and every one of its calls needs it.
      // Without it the export buttons did NOTHING AT ALL — `isBlank(root)` returned early — and the omission
      // was invisible because the call site `h(ManuscriptExport, { root: props.root })` looked right.
      root,
      chapters,
      selected,
      onSelect: setSelected,
      onCreate: createChapter,
      creating,
      createError,
      totalWordCount: listState.data?.totalWordCount,
    },
    editor: editorProps,
  })
}

/**
 * A branch that hosts sub-views as tabs.
 *
 * Each tab is itself a branch-shaped descriptor, so `BranchRouter` renders it with
 * no special case: a tab can be any view the router already knows (tree, timeline,
 * planned), and adding one is data.
 */
/**
 * A branch that hosts sub-views behind a tab strip.
 *
 * The wrapper is a full-height flex column, and that is load-bearing rather than
 * decoration: the views inside are `SplitPane`s, whose own `height:100%` only
 * resolves against a parent with a DEFINITE height. An auto-height wrapper here
 * made the pane grow to its content and get clipped by the host's
 * `overflow:hidden` frame — with no scrollbar, so a long form like a character
 * card was simply unreachable past the fold.
 *
 * That is why only the tab hosts (人物 / 组织 / 世界) were affected and a plain
 * tree branch (物品) was fine.
 */
function TabsBranch(props) {
  const { branch, root } = props
  const tabs = Array.isArray(branch.tabs) ? branch.tabs : []
  const [activeId, setActiveId] = react.useState(tabs.length > 0 ? tabs[0].id : null)
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null

  if (active === null) return h(Note, { text: '这个分支还没有子视图。' })

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h(
      'div',
      { style: { display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap', flex: '0 0 auto' } },
      ...tabs.map((tab) =>
        h(
          'button',
          {
            key: tab.id,
            type: 'button',
            style: {
              ...buttonStyle,
              ...(tab.id === active.id ? { borderColor: 'currentColor', fontWeight: 600 } : {}),
            },
            onClick: () => setActiveId(tab.id),
          },
          tab.label,
        ),
      ),
    ),
    // `minHeight: 0` so the child may shrink below its content and scroll instead
    // of pushing the strip off-screen.
    // A sub-tab is wrapped too, so one broken view inside 世界 does not take the tab strip with it —
    // which is exactly what made the blank window so hard to describe.
    h('div', { style: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden' } }, h(ViewBoundary, { label: `小说 · ${active.label ?? active.id}` }, h(BranchRouter, { branch: active, root }))),
  )
}

/** Resolve an entity key to its schema plus the document key it lives under. */
function entitySpecFor(branch, entityKey) {
  // A branch declares its entities either as a tree (groups + leaves) or as flat
  // collections; both shapes flow through here so the detail pane has one lookup.
  const slots = [
    ...(branch.tree?.groups ?? []),
    ...(branch.tree?.leaves ?? []),
    ...(branch.collections ?? []),
  ]
  const slot = slots.find((candidate) => candidate.entity === entityKey)
  if (slot === undefined) return null
  const entity = ENTITIES[entityKey]
  return { key: slot.key, entity: entityKey, label: entity.label, fields: entity.fields, titleOf: entity.titleOf }
}

/**
 * The tree branch's presentation, props-driven.
 *
 * Extracted from `EntityTreeBranch` because that component is fetch-driven and
 * effects do not run under `renderToString`: it always renders its loading state,
 * so everything below the guard — the toolbar, the tree, the detail form, the
 * delete flow — was unreachable from a test. Three of the bugs reported from
 * live use lived in exactly that region.
 */
function EntityTreeBody(props) {
  const {
    branch, root, doc, refOptions, selection, onSelect, onMutate,
    status, actions, detailOpen, onToggleDetail, feedback, placeLinks,
  } = props

  const spec = selection === null ? null : entitySpecFor(branch, selection.entity)
  const current = spec === null ? null : objectList(doc[spec.key]).find((entity) => entity.id === selection.id) ?? null
  /** Which map the author chose to mark this 地点 on. Null means "the first one", chosen at render. */
  const [markMapId, setMarkMapId] = react.useState(null)

  const patchEntity = (patch) => {
    if (spec === null) return
    onMutate((currentDoc) => ({
      ...currentDoc,
      [spec.key]: objectList(currentDoc[spec.key]).map((entity) =>
        entity.id === selection.id ? { ...entity, ...patch } : entity,
      ),
    }))
  }

  const removeEntity = () => {
    if (spec === null) return
    // Deleting something still referenced is refused by the host's validator,
    // which lists the referrers — so the UI does not have to guess whether this
    // is safe, it just reports what comes back.
    onMutate((currentDoc) => ({
      ...currentDoc,
      [spec.key]: (currentDoc[spec.key] ?? []).filter((entity) => entity.id !== selection.id),
    }))
    onSelect(null)
  }

  const main = h(
    'div',
    null,
    h(CommitRow, { label: branch.doc, status, actions, detailOpen, onToggleDetail }),
    h(WriteFeedback, feedback),
    // 批量导入 names, driven by the branch's own descriptor: any branch that declares collections or a tree
    // gets it, including ones added later.
    h(BulkImport, { branch, doc, onMutate }),
    h(EntityTree, { doc, tree: branch.tree, collections: branch.collections, selection, onSelect, onMutate }),
  )

  const detail =
    spec === null || current === null
      ? h(Note, { text: '选中左侧一项即可在此编辑。' })
      : h(
          'div',
          null,
          h(DetailHeading, null, `${spec.label} · ${spec.titleOf(current)}`),
          h('div', { style: { fontSize: '11px', opacity: 0.45, marginBottom: '12px' } }, current.id),
          // Only entities that declare a generator offer one.
          ENTITIES[spec.entity]?.generate !== undefined
            ? h(GenerateControl, {
                generator: ENTITIES[spec.entity].generate,
                hint: current[ENTITIES[spec.entity].generate.hintField] ?? '',
                base: current,
                root,
                onGenerated: patchEntity,
              })
            : null,
          h(SchemaForm, { entity: { fields: spec.fields }, value: current, onPatch: patchEntity, refOptions }),
          // WHERE THIS ENTITY IS MARKED ON A MAP, and how to mark it. The link ran one way only, so a 地点
          // could not say that a marker pointed at it — and the sole symptom of the link was a refused
          // delete that named nothing. Now a place can also PUT a marker on a map, which is the direction an
          // author actually thinks in: "where is 青云峰?" rather than "which place is this dot?".
          placeLinks !== undefined
            ? h(
                'div',
                { style: { marginTop: '14px', borderTop: `1px solid ${muted}`, paddingTop: '10px' } },
                h(DetailHeading, { title: `地图标注（${placeLinks.links.length}）` }),
                ...placeLinks.links.map((link) =>
                  h(
                    'div',
                    { key: link.mapId + ':' + link.pinId, style: { fontSize: '12px', marginBottom: '3px' } },
                    link.mapName + ' · ' + link.pinId + (link.label === '' ? '' : '「' + link.label + '」'),
                  ),
                ),
                placeLinks.links.length === 0
                  ? h('div', { style: { fontSize: '12px', opacity: 0.6 } }, '还没有在任何地图上标出。')
                  : h(
                      'div',
                      { style: { fontSize: '11px', opacity: 0.45, margin: '6px 0', lineHeight: 1.7 } },
                      '删除这个地点会被宿主拒绝，直到没有标记点关联它。清除标注只去掉关联，地图上的标记点会保留。',
                    ),
                placeLinks.links.length === 0
                  ? null
                  : h(
                      'button',
                      { type: 'button', style: { ...buttonStyle, marginTop: '4px' }, onClick: () => placeLinks.onUnlink(selection.id) },
                      '清除这些地图标注（' + placeLinks.links.length + '）',
                    ),
                // THE OTHER DIRECTION, which is the one an author reaches for.
                placeLinks.maps.length === 0
                  ? null
                  : h(
                      'div',
                      { style: { marginTop: '12px' } },
                      h(FieldLabel, null, '在地图上标出这个地点'),
                      h(
                        'div',
                        { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                        h(
                          'select',
                          {
                            value: markMapId ?? (placeLinks.maps[0]?.id ?? ''),
                            onChange: (event) => setMarkMapId(event.target.value),
                            style: inputStyle,
                          },
                          ...placeLinks.maps.map((map) => h('option', { key: map.id, value: map.id }, map.name)),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: buttonStyle,
                            onClick: () => placeLinks.onMark(selection.id, markMapId ?? (placeLinks.maps[0]?.id ?? '')),
                          },
                          '新建标记点',
                        ),
                      ),
                      h(
                        'div',
                        { style: { fontSize: '11px', opacity: 0.45, marginTop: '6px', lineHeight: 1.7 } },
                        '会在这张地图的空白处放一个标记点，名称自动跟着这个地点；地图已保存，切过去把它拖到正确位置即可。',
                      ),
                    ),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle, marginTop: '16px', color: '#e5534b', borderColor: muted },
              onClick: removeEntity,
            },
            `删除这个${spec.label}`,
          ),
          h(
            'div',
            { style: { marginTop: '10px', fontSize: '11px', opacity: 0.45, lineHeight: 1.7 } },
            '删除后记得保存。若仍有其他条目引用它，宿主会拒绝并列出引用者。',
          ),
        )

  return h(SplitPane, { main, detail, open: detailOpen })
}

/**
 * A tree on the left, the selected entity's detail on the right.
 *
 * Saves are explicit rather than per-keystroke: the host validates every write
 * against the whole project, and firing one per character would put the
 * validator on the typing path.
 */
function EntityTreeBranch(props) {
  const { branch, root } = props
  const { state, update, save, reload, warnings } = useDocument(root, branch.doc)
  /**
   * The map document, read ONLY by a branch that asks for it.
   *
   * A 地点 needs to know which markers point at it — that is the other half of the link, and without it the
   * only symptom of a link is a refused delete. `useDocument` treats a blank path as "no document", so every
   * other branch is unaffected.
   */
  const maps = useDocument(root, branch.placeLinks === true ? MAP_DOC : null)
  const refOptions = useRefOptions(root, Array.isArray(branch.refKinds) ? branch.refKinds : [])
  const [selection, setSelection] = react.useState(null)
  const [detailOpen, setDetailOpen] = react.useState(true)

  /** Which markers link to the selected 地点, and a way to clear them so the place can be deleted. */
  const placeLinks =
    branch.placeLinks !== true || selection === null || maps.state.value === null
      ? undefined
      : {
          links: mapPlaceLinks(mapMaps(maps.state.value), selection.id),
          /** The maps a marker could be placed on, so the author can choose. */
          maps: mapMaps(maps.state.value).map((map) => ({ id: map.id, name: mapDisplayName(map) })),
          /**
           * Put a marker for this 地点 on a chosen map.
           *
           * The map is written AND saved: the whole point is to go and drag the new marker into place, so
           * leaving the document dirty would let the author set off with the marker only in memory.
           */
          onMark: (placeId, mapId) => {
            const marked = mapMarkPlace(mapMaps(maps.state.value), mapId, placeId)
            if (marked.pinId === null) return
            maps.update((current) => withMaps(current, marked.maps, current?.activeMapId))
            maps.save()
          },
          onUnlink: (placeId) => {
            // The map is written AND saved, because the point of clearing the link is to make the delete
            // legal straight away — leaving it dirty would let the author save the places document first.
            maps.update((current) => withMaps(current, mapUnlinkPlace(mapMaps(current), placeId), current?.activeMapId))
            maps.save()
          },
          dirty: maps.state.dirty,
        }

  if (isBlank(root)) return h(Note, { text: '先在上方选择一个项目。' })
  if (state.loading) return h(Note, { text: '载入中…' })
  if (state.value === null) {
    if (state.code === 'document-missing') {
      return h(Note, { text: `${branch.doc} 不存在。点上方的「在此新建小说项目」创建项目文档。` })
    }
    return h(Note, { text: state.error ?? '文档不可用。', tone: 'error' })
  }

  return h(EntityTreeBody, {
    branch,
    root,
    doc: state.value,
    refOptions,
    placeLinks,
    selection,
    onSelect: setSelection,
    onMutate: update,
    status: state,
    actions: { save, revert: reload },
    detailOpen,
    onToggleDetail: () => setDetailOpen((open) => !open),
    feedback: { error: null, issues: state.issues, warnings },
  })
}

/**
 * The timeline branch's presentation, props-driven. Extracted for the same reason
 * as `EntityTreeBody`: the fetch guard made everything below it untestable.
 */
function TimelineBody(props) {
  const {
    branch, root, doc, refOptions, selection, onSelect, onMutate,
    status, actions, detailOpen, onToggleDetail, feedback,
  } = props

  const spec = selection === null ? null : entitySpecFor(branch, selection.entity)
  const current = spec === null ? null : objectList(doc[spec.key]).find((entity) => entity.id === selection.id) ?? null

  const patchEntity = (patch) => {
    if (spec === null) return
    onMutate((currentDoc) => ({
      ...currentDoc,
      [spec.key]: objectList(currentDoc[spec.key]).map((entity) =>
        entity.id === selection.id ? { ...entity, ...patch } : entity,
      ),
    }))
  }

  const removeEntity = () => {
    if (spec === null) return
    onMutate((currentDoc) => ({
      ...currentDoc,
      [spec.key]: (currentDoc[spec.key] ?? []).filter((entity) => entity.id !== selection.id),
    }))
    onSelect(null)
  }

  const takenIds = new Set([
    ...objectList(doc.lines).map((line) => line.id),
    ...objectList(doc.events).map((event) => event.id),
  ])

  const addEntity = (entityKey) => {
    const entity = ENTITIES[entityKey]
    const blank = entity.blank()
    const id = mintId(entity.idPrefix, blank.name ?? blank.title ?? 'entry', takenIds)
    const collection = entitySpecFor(branch, entityKey).key
    onMutate((currentDoc) => ({ ...currentDoc, [collection]: [...(currentDoc[collection] ?? []), { id, ...blank }] }))
    onSelect({ entity: entityKey, id })
  }

  const main = h(
    'div',
    null,
    h(CommitRow, {
      label: branch.doc,
      status,
      actions,
      detailOpen,
      onToggleDetail,
      extra: [
        h('button', { key: 'event', type: 'button', style: buttonStyle, onClick: () => addEntity('timeline-event') }, '新建事件'),
        h('button', { key: 'line', type: 'button', style: buttonStyle, onClick: () => addEntity('timeline-line') }, '新建时间线'),
      ],
    }),
    h(WriteFeedback, feedback),
    h(TimelineView, { doc, selection, onSelect }),
  )

  const detail =
    spec !== null && current !== null
      ? h(
          'div',
          null,
          h(DetailHeading, null, `${spec.label} · ${spec.titleOf(current)}`),
          h('div', { style: { fontSize: '11px', opacity: 0.45, marginBottom: '12px' } }, current.id),
          ENTITIES[spec.entity]?.generate !== undefined
            ? h(GenerateControl, {
                generator: ENTITIES[spec.entity].generate,
                hint: current[ENTITIES[spec.entity].generate.hintField] ?? '',
                base: current,
                root,
                onGenerated: patchEntity,
              })
            : null,
          h(SchemaForm, { entity: { fields: spec.fields }, value: current, onPatch: patchEntity, refOptions }),
          h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle, marginTop: '16px', color: '#e5534b', borderColor: muted },
              onClick: removeEntity,
            },
            `删除这个${spec.label}`,
          ),
        )
      : h(
          'div',
          null,
          h(Note, { text: '选中轴线上的事件即可编辑；未选中时可编辑历法。' }),
          h(
            'div',
            { style: { marginTop: '18px' } },
            h(CalendarEditor, {
              calendar: doc.calendar,
              onChange: (next) => onMutate((currentDoc) => ({ ...currentDoc, calendar: next })),
            }),
          ),
        )

  return h(SplitPane, { main, detail, open: detailOpen })
}

/**
 * The timeline branch: a shared time axis over `timeline.json`, with the selected
 * event or line edited on the right and the calendar itself edited when nothing
 * is selected.
 */
function TimelineBranch(props) {
  const { branch, root } = props
  const { state, update, save, reload, warnings } = useDocument(root, branch.doc)
  const refOptions = useRefOptions(root, Array.isArray(branch.refKinds) ? branch.refKinds : [])
  const [selection, setSelection] = react.useState(null)
  const [detailOpen, setDetailOpen] = react.useState(true)

  if (isBlank(root)) return h(Note, { text: '先在上方选择一个项目。' })
  if (state.loading) return h(Note, { text: '载入中…' })
  if (state.value === null) {
    if (state.code === 'document-missing') {
      return h(Note, { text: `${branch.doc} 不存在。点上方的「在此新建小说项目」创建项目文档。` })
    }
    return h(Note, { text: state.error ?? '文档不可用。', tone: 'error' })
  }

  return h(TimelineBody, {
    branch,
    root,
    doc: state.value,
    refOptions,
    selection,
    onSelect: setSelection,
    onMutate: update,
    status: state,
    actions: { save, revert: reload },
    detailOpen,
    onToggleDetail: () => setDetailOpen((open) => !open),
    feedback: { error: null, issues: state.issues, warnings },
  })
}

/**
 * The relationship graph.
 *
 * Owns `relations.json` — the one document no other branch writes — and reads the
 * node collections through `useRefOptions`, so a character created in the 人物 tab
 * shows up here without this branch knowing where characters live.
 *
 * The time cursor is the point: relations carry intervals, so "who is allied with
 * whom" is a question about a moment, not a fact about the book.
 */
/**
 * The graph's presentation: the cursor bar plus the drawing, props-driven.
 *
 * Extracted from `GraphBranch` on purpose. That component is fetch-driven, and
 * effects do not run under `renderToString` — so it always renders its loading
 * state and everything below that guard is unreachable from a test. A misplaced
 * props object in the cursor bar shipped as a blank panel for exactly that reason.
 */
function GraphView(props) {
  const {
    nodes, edges, types, calendar, cursorKey, onStep, onLatest, totalEdges,
    selection, onSelect, positions, width, height, includeOthers, onToggleOthers,
    svgRef, dragging, onNodePointerDown, onPointerMove, onPointerUp,
    manualCount, onResetPositions, layoutDirty, onSaveLayout, onRevertLayout, layoutSaving,
  } = props

  return h(
    'div',
    null,
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          fontSize: '12px',
          marginBottom: '8px',
        },
      },
      h('span', { style: { opacity: 0.55 } }, '时间游标'),
      h('strong', null, cursorKey === null ? '（最新）' : formatTimeKey(calendar, cursorKey)),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: () => onStep(-1) }, '← 上一变化'),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: () => onStep(1) }, '下一变化 →'),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: onLatest }, '回到最新'),
      h(
        'label',
        {
          style: { display: 'inline-flex', alignItems: 'center', gap: '4px', opacity: 0.75, cursor: 'pointer' },
          title: '打开后会把与同类实体直接相连的其他实体（如人物所属的组织）也画出来',
        },
        h('input', { type: 'checkbox', checked: includeOthers === true, onChange: (event) => onToggleOthers(event.target.checked) }),
        '含跨类关系',
      ),
      h(
        'span',
        { style: { opacity: 0.5 } },
        `${nodes.length} 个节点 · 当前成立 ${edges.length} 条 / 共 ${totalEdges} 条`,
      ),
    ),
    // Placement is its own document (`views/layout.json`) with its own save, kept
    // separate from the edges' save: moving a node must not mark the relationship
    // data dirty, and vice versa.
    manualCount > 0 || layoutDirty === true
      ? h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '11px', marginBottom: '8px' } },
          manualCount > 0
            ? h('span', { style: { opacity: 0.55 } }, `已手工摆位 ${manualCount} 个节点`)
            : null,
          manualCount > 0
            ? h('button', { type: 'button', style: { ...buttonStyle, padding: '1px 7px' }, onClick: onResetPositions }, '重置为自动布局')
            : null,
          layoutDirty === true
            ? h('span', { style: { color: '#e5a34b' } }, '摆位未保存')
            : null,
          layoutDirty === true
            ? h(
                'button',
                { type: 'button', style: { ...buttonStyle, padding: '1px 7px' }, disabled: layoutSaving === true, onClick: onSaveLayout },
                layoutSaving === true ? '保存中…' : '保存摆位',
              )
            : null,
          layoutDirty === true
            ? h('button', { type: 'button', style: { ...buttonStyle, padding: '1px 7px' }, onClick: onRevertLayout }, '还原摆位')
            : null,
        )
      : null,
    nodes.length === 0
      ? h(Note, { text: '还没有可入网的实体。先在「人物卡」或「组织树」里创建。' })
      : edges.length === 0
        ? h(Note, { text: '这些实体之间还没有关系。点「新建关系」，选起点、终点与类型。' })
        : h(RelationGraph, {
            nodes,
            edges,
            types,
            positions,
            width,
            height,
            selection,
            onSelect,
            svgRef,
            dragging,
            onNodePointerDown,
            onPointerMove,
            onPointerUp,
          }),
  )
}

function GraphBranch(props) {
  const { branch, root } = props
  const { state, update, save, reload, warnings } = useDocument(root, branch.doc)
  // Manual placement lives in its own document, so moving a node and editing an edge
  // are independent edits with independent saves.
  const layout = useDocument(root, 'views/layout.json')
  const nodeKinds = Array.isArray(branch.nodeKinds) ? branch.nodeKinds : ['character']
  const candidates = useRefOptions(root, [...nodeKinds, 'relation-type', 'timeline-event'])
  const calendar = useCalendar(root)
  const [selection, setSelection] = react.useState(null)
  const [detailOpen, setDetailOpen] = react.useState(true)
  // Same-kind only by default: the 人物 graph is about people. Widening it is a
  // deliberate question ("what is attached to these people?"), not the default.
  const [includeOthers, setIncludeOthers] = react.useState(false)
  // `null` means "as of the latest written moment" — every edge is in force.
  const [cursorKey, setCursorKey] = react.useState(null)
  // Drag state. `dragPoint` is an overlay only; nothing is written until release.
  const [dragging, setDragging] = react.useState(null)
  const [dragPoint, setDragPoint] = react.useState(null)
  const svgRef = react.useRef(null)

  const doc = state.value
  const types = objectList(doc?.types)
  const allEdges = objectList(doc?.edges)

  // Every entity the graph may join, tagged with its kind so the focus filter can
  // tell a character from an organization.
  const allNodes = nodeKinds.flatMap((kind) =>
    (candidates[kind] ?? []).map((option) => ({ id: option.id, title: option.title, kind })),
  )

  const activeEdges = edgesActiveAt(allEdges, cursorKey)
  const subgraph = visibleNetwork(allNodes, activeEdges, { focusKinds: branch.focusKinds, includeOthers })

  const WIDTH = 720
  const HEIGHT = 480
  const nodeKey = subgraph.nodes.map((node) => node.id).join('|')
  const edgeKey = subgraph.edges.map((edge) => `${edge.id}:${edge.from}:${edge.to}:${edge.type}`).join('|')
  const forcePositions = react.useMemo(
    () => layoutForce(subgraph.nodes, subgraph.edges, { width: WIDTH, height: HEIGHT }),
    [nodeKey, edgeKey],
  )

  const manual = layout.state.value?.graphs?.[GRAPH_LAYOUT_KEY]?.positions ?? {}
  const nodeIds = subgraph.nodes.map((node) => node.id)
  // The node being dragged is drawn from local state so the gesture stays
  // responsive; it joins the saved placement only on pointer release.
  const overlay = dragPoint === null ? manual : setManualPosition(manual, dragPoint.id, dragPoint.point)
  const positions = react.useMemo(
    () => mergePositions(forcePositions, overlay, nodeIds),
    [forcePositions, overlay, nodeKey],
  )

  const manualCount = countManualPositions(manual, nodeIds)

  const pointerToView = (event) => {
    const element = svgRef.current
    const rect = element !== null && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null
    const point = clientToViewBox({ clientX: event.clientX, clientY: event.clientY }, rect, WIDTH, HEIGHT)
    return point === null ? null : clampToBox(point, WIDTH, HEIGHT)
  }

  const onNodePointerDown = (id, event) => {
    // Without this the browser starts a text selection and the drag is cancelled.
    if (typeof event.preventDefault === 'function') event.preventDefault()
    setDragging(id)
    const point = pointerToView(event)
    if (point !== null) setDragPoint({ id, point })
  }

  const onPointerMove = (event) => {
    if (dragging === null) return
    const point = pointerToView(event)
    if (point !== null) setDragPoint({ id: dragging, point })
  }

  const onPointerUp = () => {
    if (dragging !== null && dragPoint !== null && dragPoint.id === dragging) {
      const moved = dragPoint.point
      layout.update((current) => ({
        ...(current ?? {}),
        graphs: {
          ...((current ?? {}).graphs ?? {}),
          [GRAPH_LAYOUT_KEY]: {
            positions: setManualPosition(
              ((current ?? {}).graphs ?? {})[GRAPH_LAYOUT_KEY]?.positions ?? {},
              dragging,
              moved,
            ),
          },
        },
      }))
    }
    setDragging(null)
    setDragPoint(null)
  }

  const resetPositions = () => {
    // Reads the CURRENT placements from the updater argument, not the `manual` captured
    // when this handler was created — otherwise a layout loaded in the meantime is
    // discarded, and in the other tab's placements along with it.
    layout.update((current) => {
      const graphs = (current ?? {}).graphs ?? {}
      return {
        ...(current ?? {}),
        graphs: {
          ...graphs,
          [GRAPH_LAYOUT_KEY]: {
            positions: clearManualPositions(graphs[GRAPH_LAYOUT_KEY]?.positions ?? {}, nodeIds),
          },
        },
      }
    })
  }

  if (isBlank(root)) return h(Note, { text: '先在上方选择一个项目。' })
  if (state.loading) return h(Note, { text: '载入中…' })
  if (doc === null) {
    if (state.code === 'document-missing') {
      return h(Note, { text: `${branch.doc} 不存在。点上方的「在此新建小说项目」创建项目文档。` })
    }
    return h(Note, { text: state.error ?? '文档不可用。', tone: 'error' })
  }

  const spec = selection === null ? null : entitySpecFor(branch, selection.entity)
  const currentEdge =
    selection !== null && selection.entity === 'relation-edge'
      ? allEdges.find((edge) => edge.id === selection.id) ?? null
      : null

  // The branch's own document wins over the registry copy, so unsaved type edits
  // are offered immediately.
  const refOptions = {
    ...candidates,
    'graph-node': allNodes.map((node) => ({ id: node.id, title: `${node.title}（${node.kind === 'organization' ? '组织' : node.kind === 'place' ? '地点' : '人物'}）` })),
    'relation-type': types.map((type) => ({ id: type.id, title: type.label || type.id })),
  }

  const patchEdge = (patch) => {
    update((current) => ({
      ...current,
      edges: objectList(current.edges).map((edge) => (edge.id === selection.id ? { ...edge, ...patch } : edge)),
    }))
  }

  const boundaryKeys = [
    ...new Set(
      allEdges
        .flatMap((edge) => [timeKey(edge.since), edge.until === null || edge.until === undefined ? null : timeKey(edge.until)])
        .filter((key) => key !== null),
    ),
  ].sort((a, b) => a - b)

  const stepCursor = (direction) => {
    if (boundaryKeys.length === 0) return
    if (cursorKey === null) {
      setCursorKey(boundaryKeys[boundaryKeys.length - 1])
      return
    }
    const at = boundaryKeys.indexOf(cursorKey)
    if (at === -1) {
      const next = boundaryKeys.find((key) => key > cursorKey)
      setCursorKey(direction > 0 ? next ?? cursorKey : cursorKey)
      return
    }
    const target = Math.max(0, Math.min(boundaryKeys.length - 1, at + direction))
    setCursorKey(boundaryKeys[target])
  }

  const addEdge = () => {
    const entity = ENTITIES['relation-edge']
    const blank = entity.blank()
    const taken = new Set(allEdges.map((edge) => edge.id))
    const id = mintId(entity.idPrefix, 'new', taken)
    update((current) => ({ ...current, edges: [...(current.edges ?? []), { id, ...blank }] }))
    setSelection({ entity: 'relation-edge', id })
  }

  const main = h(
    'div',
    null,
    h(
      BranchToolbar,
      null,
      h('span', { style: { fontSize: '12px', opacity: 0.55 } }, branch.doc),
      state.dirty ? h('span', { style: { fontSize: '12px', color: '#e5a34b' } }, '未保存') : null,
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, borderColor: state.dirty ? 'currentColor' : muted },
          disabled: !state.dirty || state.saving,
          onClick: save,
        },
        state.saving ? '保存中…' : '保存',
      ),
      h('button', { type: 'button', style: buttonStyle, disabled: !state.dirty, onClick: reload }, '还原'),
      // An edge joins two nodes, so with fewer than two there is nothing it could
      // connect; offering the button would only produce an unsaveable row.
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, opacity: allNodes.length < 2 ? 0.5 : 1 },
          disabled: allNodes.length < 2,
          title: allNodes.length < 2 ? '至少需要两个可入网的实体（人物或组织）' : '',
          onClick: addEdge,
        },
        '新建关系',
      ),
      h(
        'button',
        { type: 'button', style: { ...buttonStyle, marginLeft: 'auto' }, onClick: () => setDetailOpen((open) => !open) },
        detailOpen ? '收起详情' : '展开详情',
      ),
      state.savedAt !== null && !state.dirty
        ? h('span', { style: { fontSize: '12px', opacity: 0.5 } }, `已保存 ${state.savedAt}`)
        : null,
    ),

    // One implementation of the feedback block, shared with the tree and timeline
    // branches. This used to be hand-rolled here with a `!== null` check that
    // `undefined` slips past.
    h(WriteFeedback, { error: state.error, issues: state.issues, warnings }),

    h(GraphView, {
      nodes: subgraph.nodes,
      edges: subgraph.edges,
      types,
      calendar,
      cursorKey,
      onStep: stepCursor,
      onLatest: () => setCursorKey(null),
      totalEdges: allEdges.length,
      includeOthers,
      onToggleOthers: setIncludeOthers,
      selection,
      onSelect: setSelection,
      positions,
      width: WIDTH,
      height: HEIGHT,
      svgRef,
      dragging,
      onNodePointerDown,
      onPointerMove,
      onPointerUp,
      manualCount,
      onResetPositions: resetPositions,
      layoutDirty: layout.state.dirty,
      layoutSaving: layout.state.saving,
      onSaveLayout: layout.save,
      onRevertLayout: layout.reload,
    }),
  )

  let detail
  if (spec !== null && currentEdge !== null) {
    detail = h(
      'div',
      null,
      h(DetailHeading, null, '关系'),
      h('div', { style: { fontSize: '11px', opacity: 0.45, marginBottom: '12px' } }, currentEdge.id),
      h(SchemaForm, {
        entity: { fields: spec.fields },
        value: currentEdge,
        onPatch: patchEdge,
        refOptions,
      }),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, marginTop: '16px', color: '#e5534b', borderColor: muted },
          onClick: () => {
            update((current) => ({ ...current, edges: (current.edges ?? []).filter((edge) => edge.id !== selection.id) }))
            setSelection(null)
          },
        },
        '删除这条关系',
      ),
    )
  } else if (selection !== null && selection.entity === 'graph-node') {
    const node = allNodes.find((candidate) => candidate.id === selection.id) ?? null
    const touching = edgesTouching(activeEdges, selection.id)
    detail = h(
      'div',
      null,
      h(DetailHeading, null, node?.title ?? selection.id),
      h(
        'div',
        { style: { fontSize: '11px', opacity: 0.45, marginBottom: '10px' } },
        `${selection.id} · ${node?.kind === 'organization' ? '组织' : node?.kind === 'place' ? '地点' : '人物'}`,
      ),
      h('div', { style: { fontSize: '12px', opacity: 0.6, marginBottom: '6px' } }, `当前成立 ${touching.length} 条关系`),
      ...touching.map((edge) =>
        h(
          'div',
          {
            key: edge.id,
            style: { fontSize: '12px', lineHeight: 1.9, cursor: 'pointer' },
            onClick: () => setSelection({ entity: 'relation-edge', id: edge.id }),
          },
          `· ${edge.from === selection.id ? '→' : '←'} ${
            allNodes.find((candidate) => candidate.id === (edge.from === selection.id ? edge.to : edge.from))?.title ??
            (edge.from === selection.id ? edge.to : edge.from)
          }（${types.find((type) => type.id === edge.type)?.label ?? edge.type}）`,
        ),
      ),
      h(
        'div',
        { style: { marginTop: '14px', fontSize: '11px', opacity: 0.45, lineHeight: 1.7 } },
        '节点本身在这里只读：编辑人物或组织请到对应分支的卡片页签，改完刷新即可。',
      ),
    )
  } else {
    detail = h(Note, {
      text:
        allEdges.length === 0
          ? '点「新建关系」，选择起点、终点与类型。关系可以带起止时间——这正是时间游标的用处。'
          : '点网络里的节点或关系连线即可查看与编辑。虚线表示无方向的关系。',
    })
  }

  return h(SplitPane, { main, detail, open: detailOpen })
}

function BranchRouter(props) {
  const { branch, root } = props
  if (branch.view === 'tabs') return h(TabsBranch, { branch, root })
  if (branch.view === 'tree') return h(EntityTreeBranch, { branch, root })
  if (branch.view === 'timeline') return h(TimelineBranch, { branch, root })
  if (branch.view === 'graph') return h(GraphBranch, { branch, root })
  if (branch.view === 'map') return h(MapBranch, { root })
  if (branch.view === 'chapters') return h(ChapterBranch, { root })
  return h(PlannedBranch, { branch })
}

      // ==== 90-apply.js =======================================================
/**
 * Registration: one activity-bar icon and one center panel per branch.
 *
 * The `sidebar.panellist` entry's `id` and the `main` entry's `key` are both
 * derived from `panelIdFor(branch.id)`, so they cannot drift apart — a mismatch
 * would make the icon select a panel that does not exist, which throws inside
 * `selectPanel` and leaves the center column unchanged with no visible reason.
 */

/**
 * The right-column detail seat.
 *
 * Registered through a NESTED inject: naming `sidebarRightTabs` in the
 * module-level inject would keep the entire plugin unmounted on a host without
 * that service, taking branch navigation down with it. Nested, a missing service
 * costs only the detail tab.
 *
 * LIMITATION, and the reason the branch views do not rely on this seat: an
 * activity-bar branch panel is a *global* `main` panel, and while one fills the
 * center column the right column has no Session — `ctx.sidebarRight.mounted` is
 * `undefined`, the column has "no surface without a session", and `openTab`
 * throws rather than drawing into a surface nobody owns. This seat is therefore
 * reachable only alongside the Conversation (useful for "chat while browsing"),
 * never from inside a branch panel. Phase 3's detail pane is drawn in-panel
 * instead — see `60-shell.js` / `SplitPane`.
 */
function DetailBody() {
  return h(
    'div',
    { style: { padding: '14px', fontSize: '13px', lineHeight: 1.8 } },
    h('div', { style: { opacity: 0.75 } }, '详情位已就位。'),
    h(
      'div',
      { style: { marginTop: '10px', opacity: 0.55, fontSize: '12px' } },
      '这个标签页只在对话打开时可达；分支面板内的详情是面板自绘的（右栏在全局面板下没有会话）。',
    ),
  )
}

function registerDetailSeat(ctx) {
  ctx.inject(['sidebarRightTabs'], (scoped) => {
    const disposers = []
    try {
      disposers.push(scoped.sidebarRightTabs.register({
        id: DETAIL_ID,
        kind: DETAIL_KIND,
        title: () => '小说详情',
      }))
      disposers.push(scoped.slots.register({ name: 'sidebar.right.pane.tab', key: DETAIL_ID }, DetailBody))
    } catch (error) {
      console.warn('[dsh-novel] detail seat registration failed:', error)
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* already gone */
        }
      }
    }
  })
}

function apply(ctx) {
  for (const [index, branch] of BRANCHES.entries()) {
    const id = panelIdFor(branch.id)
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id }, createPanel(ctx, branch)))
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id, order: 5 + index, label: () => `小说·${branch.label}` },
        function BranchIcon(props) {
          return h(Glyph, { name: branch.id, size: props?.size })
        },
      ),
    )
  }
  registerDetailSeat(ctx)
}

/**
 * Testing seam.
 *
 * The host reads only `name`, `inject` and `apply`. These exports exist so
 * `tools/client-selftest.mjs` can render the pure views with plain props — the
 * only way to exercise them without a browser and a live host, and the
 * difference between catching a component bug here and catching it as a blank
 * panel in front of the user.
 */
exports.__test = {
  BRANCHES,
  ENTITIES,
  F,
  Glyph,
  Note,
  PlannedBranch,
  EntityTree,
  SchemaForm,
  SplitPane,
  indexTree,
  mintId,
  panelIdFor,
  isBlank,
  projectStore,
  api,
  withoutBlankKeys,
  timeKey,
  timeKeyParts,
  formatTimeKey,
  TimelineView,
  CalendarEditor,
  entitySpecFor,
  isAfterCursor,
  axisLeft,
  GUTTER_PX,
  CHIP_MAX_WIDTH,
  assignRows,
  ROW_SEPARATION,
  ROW_HEIGHT,
  countWords,
  MasterDetail,
  ChapterBranch,
  useChapter,
  parseStringList,
  stringListDisplay,
  MultiSelect,
  TabsBranch,
  ViewBoundary,
  AgentDraftBody,
  manuscriptReceipt,
  manuscriptQuery,
  ManuscriptExport,
  existingNamesIn,
  buildImportedEntities,
  branchTakenIds,
  importTargets,
  planImport,
  parseNameList,
  coerceImportValue,
  matchVocabulary,
  matchOption,
  importVocabulary,
  importFields,
  parseEntityLines,
  parseEntityLine,
  BulkImport,
  AgentDraftControl,
  agentPromptText,
  agentPhase,
  agentWrites,
  agentUsageLine,
  agentModelLine,
  agentSessionsFor,
  agentSessionsSorted,
  agentRelativeTime,
  agentSessionLabel,
  useRefOptions,
  REF_COLLECTIONS,
  edgesActiveAt,
  visibleNetwork,
  layoutForce,
  edgesTouching,
  clientToViewBox,
  clampToBox,
  mergePositions,
  setManualPosition,
  clearManualPositions,
  countManualPositions,
  GRAPH_LAYOUT_KEY,
  RelationGraph,
  GraphBranch,
  GraphView,
  EntityTreeBody,
  TimelineBody,
  ChapterBody,
  ChapterListPane,
  ChapterEditorPane,
  CommitRow,
  WriteFeedback,
  GenerateControl,
  GenerateReceipt,
  GenerateOptions,
  DraftControl,
  mergeDraft,
  DRAFT_MODE_LABELS,
  CandidateList,
  makeRng,
  generateLocalDraft,
  LOCAL_KINDS,
  CollectionPane,
  TreePane,
  StructureInput,
  removePositionSubtree,
  PositionEditor,
  childNodeFor,
  supportsNesting,
  isRecord,
  objectList,
  objectValues,
  issueBelongsTo,
  // --- the map ---
  MAP_DOC,
  MAP_LAYOUT_DOC,
  MAP_ZOOM_MIN,
  MAP_ZOOM_MAX,
  MAP_PEN_COLORS,
  MAP_DEFAULT_COLOR,
  MAP_LABEL_SIZES,
  MAP_DEFAULT_LABEL_SIZE,
  MAP_PIN_HIT_PX,
  mapStrokeColor,
  cleanPoints,
  mapStrokes,
  mapPins,
  allPinIds,
  allPathIds,
  allIdsOf,
  mapCanvas,
  mapBackground,
  normalizeMap,
  mapMaps,
  migrateLegacyMaps,
  resolveActiveMap,
  withMaps,
  mapViewFor,
  withMapView,
  mapViewState,
  isMapBox,
  mapViewBox,
  viewBoxString,
  mapScale,
  mapScreenToWorld,
  mapPanTo,
  mapZoomAt,
  mapPinHitRadius,
  strokePath,
  pinAt,
  mapPinHit,
  mintMapId,
  mapLabelSize,
  mapLabelOffset,
  mapFillAt,
  mapClosedLoops,
  mapPolygonArea,
  mapPointInPolygon,
  mapShapeFromDrag,
  mapShapes,
  normalizeShape,
  mapShapePoints,
  MAP_CLOSED_GAP,
  MAP_SHAPE_STEPS,
  MAP_SHAPE_MIN_SIZE,
  MAP_SHAPE_KIND_IDS,
  MAP_SHAPE_KINDS,
  mapPathRename,
  mapPathTitle,
  mapMountainGlyph,
  mapMountainPeaks,
  mapPathAnchor,
  mapEraseAt,
  mapDistanceToCourse,
  mapPointToSegment,
  mapEraseRadius,
  mapPinColor,
  mapPinRadius,
  mapPinDiameter,
  MAP_PIN_DEFAULT_SIZE,
  MAP_PIN_SIZES,
  mapStrokeWidth,
  normalisePenWidth,
  MAP_PEN_DEFAULT,
  MAP_PEN_WIDTHS,
  mapDisplayName,
  mapUnlinkPlace,
  mapMarkPlace,
  mapFreeSpot,
  MAP_STAMP_SIZES,
  MAP_TEXT_SIZES,
  MAP_THEME_IDS,
  MAP_THEMES,
  MAP_SYMBOL_IDS,
  MAP_SYMBOLS,
  mapInkFor,
  mapHaloColor,
  mapFocusGroup,
  mapFocusAnchor,
  mapOutlineClosed,
  mapFillOf,
  mapFillAdvice,
  mapPaper,
  mapThemeId,
  mapTheme,
  mapStampColor,
  mapTextColor,
  mapStampSize,
  mapTextSize,
  mapTextWidth,
  mapStampParts,
  mapStampBox,
  mapTextBox,
  normalizeMapStamp,
  normalizeMapText,
  mapStamps,
  mapTexts,
  mapTargetName,
  mapTargetBox,
  mapTargetPoints,
  mapMoveTarget,
  mapPickAt,
  mapPlaceLinks,
  mapLabelLayout,
  mapBoxesOverlap,
  mapLabelBox,
  mapLabelAnchors,
  mapLabelWidth,
  mapAssetName,
  isMapImage,
  mapAssetUrl,
  mapGridLines,
  MAP_PATH_KINDS,
  MAP_PATH_KIND_IDS,
  MAP_PATH_WIDTHS,
  MAP_DASHES,
  MAP_PATH_MAX_WIDTH,
  MAP_PATH_HIT_PX,
  mapPathHitRadius,
  mapPathHalfWidth,
  mapSmoothPath,
  mapBankPath,
  normalizePath,
  mapPaths,
  mapAllPaths,
  pathPointAt,
  pathInsertIndex,
  mapPathInsert,
  mapPathMovePoint,
  mapPathRemovePoint,
  mapPathStart,
  mapPathAppend,
  mapPathUpdate,
  mapPathRemove,
  MAP_HISTORY_LIMIT,
  MAP_HISTORY_MERGE_MS,
  mapHistoryNew,
  mapHistorySnapshot,
  mapHistoryCanUndo,
  mapHistoryCanRedo,
  mapHistoryPush,
  mapHistoryUndo,
  mapHistoryRedo,
  MAP_PLACE_SUFFIX,
  generateRandomMap,
  MAP_EXPORT_SCALES,
  mapExportSize,
  mapExportName,
  mapParseColor,
  mapLuminance,
  mapContrast,
  mapExportInk,
  mapDragStart,
  mapDragMove,
  mapDragEnd,
  mapAppendStroke,
  mapUndoStroke,
  mapClearStrokes,
  mapClearPins,
  mapRenameMap,
  mapRemoveMap,
  mapSetLabelSize,
  mapSetLabelFixed,
  mapUpdatePin,
  freshMap,
  MapSurface,
  MapButton,
  MapGroup,
  ColorPicker,
  MapBranch,
}

    exports.name = 'dsh-novelsupport'
    exports.inject = ['slots', 'layout']
    exports.apply = apply
    return module.exports
  },
})
