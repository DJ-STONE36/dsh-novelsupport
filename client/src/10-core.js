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

/**
 * Which project root a freshly-loaded workspace list implies.
 *
 * Returns:
 *   - `undefined` — leave the current selection alone (it is fine, or the list
 *     is unavailable and guessing would be worse);
 *   - a path — select it;
 *   - `null` — show the picker.
 *
 * WHY THIS EXISTS. `localStorage` stores an absolute path, and the workspace
 * directory can be renamed (this repository was: `my-project` →
 * `dsh-novelsupport`). The saved path then points at a directory that no longer
 * exists, every request answers `400 root does not exist`, and the UI looks
 * broken — but the old effect only ran for a BLANK root, so a stale non-blank
 * value was never repaired and there was no way out from the interface.
 *
 * A stale root is only replaced automatically when exactly ONE workspace has a
 * novel project; with several, choosing for the author would be a guess.
 *
 * @param root - current selection (may be null/blank).
 * @param workspaces - rows from `GET /workspaces`.
 * @param available - false when the host composes no workspaceRegistry.
 * @returns {string|null|undefined} see above.
 */
function projectRootFromWorkspaces(root, workspaces, available) {
  if (available === false) return undefined
  const list = Array.isArray(workspaces) ? workspaces : []
  if (list.length === 0) return undefined
  if (!isBlank(root) && list.some((workspace) => workspace?.path === root)) return undefined
  const initialized = list.filter((workspace) => workspace?.project?.initialized === true)
  if (initialized.length === 1) return initialized[0].path
  return isBlank(root) ? undefined : null
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
    // The mtime this working copy was read at, sent back on save so the host can
    // refuse a write that would discard an agent's (or another window's) edit.
    mtimeMs: null,
  })
  const [nonce, setNonce] = react.useState(0)
  // Advisory findings from the last write, kept apart from `issues` (which is what
  // blocked it) and cleared on reload so a stale warning cannot outlive its fix.
  const [warnings, setWarnings] = react.useState([])

  react.useEffect(() => {
    setWarnings([])
    if (isBlank(root) || isBlank(relPath)) {
      setState({ loading: false, error: null, code: null, value: null, dirty: false, saving: false, issues: null, savedAt: null, mtimeMs: null })
      return undefined
    }
    let live = true
    setState((previous) => ({ ...previous, loading: true, error: null, code: null }))
    fetch(api(`${API}/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!live) return
        if (!response.ok) {
          setState({ loading: false, error: body?.error ?? `HTTP ${response.status}`, code: body?.code ?? null, value: null, dirty: false, saving: false, issues: null, savedAt: null, mtimeMs: null })
        } else {
          setState({ loading: false, error: null, code: null, value: body.value, dirty: false, saving: false, issues: null, savedAt: null, mtimeMs: body.stat?.mtimeMs ?? null })
        }
      })
      .catch((error) => {
        if (live) setState({ loading: false, error: String(error?.message ?? error), code: null, value: null, dirty: false, saving: false, issues: null, savedAt: null, mtimeMs: null })
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
      const expected = typeof previous.mtimeMs === 'number' ? { expectedMtimeMs: previous.mtimeMs } : {}
      const body = JSON.stringify({ root, path: relPath, value: previous.value, ...expected })
      fetch(api(`${API}/document`), { method: 'POST', headers: WRITE_HEADERS, body })
        .then(async (response) => {
          const result = await response.json().catch(() => null)
          setState((current) => {
            if (!response.ok) {
              return { ...current, saving: false, code: result?.code ?? null, error: result?.error ?? `HTTP ${response.status}`, issues: result?.issues ?? null }
            }
            return {
              ...current,
              // The mtime of the file this write produced, so the NEXT save is
              // compared against what is actually on disk.
              mtimeMs: typeof result?.stat?.mtimeMs === 'number' ? result.stat.mtimeMs : current.mtimeMs,
              saving: false, dirty: false, error: null, code: null, issues: null, savedAt: new Date().toLocaleTimeString(),
            }
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
    mtimeMs: null,
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
        mtimeMs: null,
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
            frontMatterError: null, wordCount: 0, mtimeMs: null,
          })
        } else {
          setState({
            loading: false, error: null, code: null,
            meta: body.meta ?? {}, body: body.body ?? '',
            dirty: false, saving: false, issues: null, savedAt: null,
            frontMatterError: body.frontMatterError ?? null,
            wordCount: countWords(body.body ?? ''),
            mtimeMs: body.stat?.mtimeMs ?? null,
          })
        }
      })
      .catch((error) => {
        if (live) {
          setState({
            loading: false, error: String(error?.message ?? error), code: null,
            meta: null, body: '', dirty: false, saving: false, issues: null, savedAt: null,
            frontMatterError: null, wordCount: 0, mtimeMs: null,
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
      const expected = typeof previous.mtimeMs === 'number' ? { expectedMtimeMs: previous.mtimeMs } : {}
      const payload = JSON.stringify({ root, path: relPath, meta: previous.meta, body: previous.body, ...expected })
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
            return {
              ...current,
              mtimeMs: typeof result?.stat?.mtimeMs === 'number' ? result.stat.mtimeMs : current.mtimeMs,
              saving: false, dirty: false, error: null, code: null, issues: null, savedAt: new Date().toLocaleTimeString(),
            }
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
