/**
 * The enumerable fields, and the values each accepts.
 *
 * Mirrors the `F.select` options in the client's entity table. The duplication is
 * deliberate and cross-checked: `client-selftest.mjs` asserts every entry here matches
 * the control the author actually sees, so the two cannot drift.
 *
 * The validator needs its own copy because the AI skills write these documents directly.
 * Without a check, a generated value the `<select>` has no option for persists in the
 * file while the UI shows nothing selected — value invisible on screen, present on disk,
 * and silently overwritten by the first interaction.
 */
export const ENUMS = {
  'character.gender': ['男', '女', '其他', '未定'],
  'character.status': ['alive', 'dead', 'missing', 'unknown'],
  'organization.status': ['active', 'dissolved', 'unknown'],
  'chapter.status': ['draft', 'revised', 'final'],
  'timeline-line.kind': ['main', 'branch'],
  'outline-node.kind': ['volume', 'chapter', 'beat'],
  'world-rule.scope': ['global', 'branch'],
}

/**
 * Is a time CERTAINLY outside `[start, end]`?
 *
 * Deliberately conservative, because a false positive here tells the author to widen a
 * calendar that is already correct. A partial time spans what it leaves out: `{year: 1}`
 * means "sometime in year 1", so it is NOT before a calendar beginning 元年1月1日 — comparing
 * the encoded keys directly reported exactly that, because a missing month encodes as 0.
 * The fine-grained comparison is only applied when BOTH sides specify the part being compared.
 */
export function certainlyOutside(value, start, end) {
  if (value === null || value === undefined || start === null || end === null) return false
  const year = value.year
  if (!Number.isFinite(year)) return false
  if (year < start.year || year > end.year) return true
  const finer = (a, b, comparison) => {
    // Only compare months/days when both sides have a usable one; otherwise the answer is
    // unknown. `timeKey` returns null for an out-of-range part, and `null < x` coerces to
    // `0 < x` — which is how an absent month first slipped through as "before January".
    if (a.month === null || a.month === undefined || b.month === null || b.month === undefined) return false
    const keyA = timeKey(a)
    const keyB = timeKey(b)
    if (keyA === null || keyB === null) return false
    return comparison(keyA, keyB)
  }
  if (year === start.year && finer(value, start, (a, b) => a < b)) return true
  if (year === end.year && finer(value, end, (a, b) => a > b)) return true
  return false
}

/**
 * Structural validation of a whole project.
 *
 * Split of responsibility (docs/data-model.md §5): this module owns *structure*
 * — dangling references, cycles, malformed or overlapping time intervals. The
 * `novel-consistency` skill owns *meaning* — a character acting out of
 * character, a foreshadowing never paid off. Neither repeats the other.
 *
 * Pure: takes parsed documents, returns issues. No I/O, no throwing on bad
 * data — a project with problems is exactly the case this exists to describe,
 * so every problem becomes an issue rather than an exception.
 */

/**
 * Coerce an optional numeric field, treating null/blank/boolean/object as absent.
 *
 * `Number(null)` is `0` and `Number('')` is `0`, so coercing blindly reads a
 * cleared year as year 0 — silently teleporting an event to the start of history
 * instead of reporting it as unusable. Numeric strings stay accepted, because
 * hand-written project files (and the AI skills that edit them) produce them.
 */
function optionalNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'object') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Compare two `{year,month,day}` times. Missing month/day compare as 0. */
export function timeKey(time) {
  if (time === null || typeof time !== 'object' || Array.isArray(time)) return null
  const year = optionalNumber(time.year)
  if (year === null) return null
  const month = optionalNumber(time.month)
  const day = optionalNumber(time.day)
  // An out-of-range part makes the WHOLE time unusable, rather than encoding into a key that
  // sorts as a different date: `month: 0` encoded as January-minus-one, so an event with a
  // nonsense month silently sorted before the calendar's own start, and `month: 13` sorted
  // into the following year. Returning null means every existing `bad-time` check catches it,
  // instead of six call sites each needing their own range test.
  if (month !== null && (month < 1 || month > 12)) return null
  if (day !== null && (day < 1 || day > 31)) return null
  return year * 10000 + (month ?? 0) * 100 + (day ?? 0)
}

const OPEN_END = Number.POSITIVE_INFINITY

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd
}

/**
 * Validate a project.
 *
 * @param docs - project-relative path -> parsed document (missing files absent).
 * @param chapters - `{ path, meta }` for every chapter file found.
 * @returns `{ issues, counts }` where each issue is
 *   `{ level, code, path, message, ids }`.
 */
export function validateProject({ docs, chapters = [] }) {
  const issues = []
  const add = (level, code, path, message, ids = []) => {
    issues.push({ level, code, path, message, ids })
  }

  // ---- gather ids -------------------------------------------------------
  const ids = new Map() // id -> { kind, path }
  const register = (id, kind, path) => {
    if (typeof id !== 'string' || id === '') {
      // Reported, not skipped. An entity with no id cannot be referenced, cannot be
      // selected reliably, and cannot be addressed by the writing skills — and because
      // registration is what makes references resolve, skipping it silently made every
      // legitimate reference to that entity report as dangling, pointing the author at
      // the wrong file. The AI skills write these documents directly, so this is a
      // first-class writer, not a hypothetical one.
      if (id !== undefined && id !== null) {
        add('error', 'bad-id', path, `${kind} id must be a non-empty string (received ${JSON.stringify(id)})`)
      } else {
        add('error', 'missing-id', path, `a ${kind} has no id`)
      }
      return false
    }
    const existing = ids.get(id)
    if (existing !== undefined) {
      add('error', 'duplicate-id', path, `id "${id}" is already used by ${existing.kind} at ${existing.path}`, [id])
      return false
    }
    ids.set(id, { kind, path })
    return true
  }

  const list = (doc, key) => (Array.isArray(doc?.[key]) ? doc[key] : [])

  /**
   * An enumerable field must hold one of its declared values.
   *
   * Only a non-empty string is judged: absent is "not set", which is legitimate, and a
   * non-string is already an error of its own kind.
   */
  const checkEnum = (key, value, at, ownerIds) => {
    const allowed = ENUMS[key]
    if (allowed === undefined) return
    if (value === null || value === undefined || value === '') return
    if (typeof value !== 'string' || !allowed.includes(value)) {
      add('error', 'bad-enum', at,
        `${key} must be one of ${allowed.join(' / ')} (received ${JSON.stringify(value)})`, ownerIds)
    }
  }

  const characters = list(docs['setting/characters.json'], 'characters')
  const organizations = list(docs['setting/organizations.json'], 'organizations')
  const items = list(docs['setting/items.json'], 'items')
  const categories = list(docs['setting/items.json'], 'categories')
  const places = list(docs['setting/places.json'], 'places')
  const outlineNodes = list(docs['outline/outline.json'], 'nodes')
  const events = list(docs['outline/timeline.json'], 'events')
  const lines = list(docs['outline/timeline.json'], 'lines')
  const relations = docs['relations.json'] ?? { types: [], edges: [] }
  const edges = Array.isArray(relations.edges) ? relations.edges : []
  const relationTypes = Array.isArray(relations.types) ? relations.types : []

  const world = docs['setting/world.json'] ?? {}
  const sections = list(world, 'sections')
  const rules = list(world, 'rules')

  for (const c of characters) register(c?.id, 'character', 'setting/characters.json')
  for (const o of organizations) register(o?.id, 'organization', 'setting/organizations.json')
  for (const i of items) register(i?.id, 'item', 'setting/items.json')
  for (const c of categories) register(c?.id, 'item-category', 'setting/items.json')
  for (const p of places) register(p?.id, 'place', 'setting/places.json')
  for (const n of outlineNodes) register(n?.id, 'outline-node', 'outline/outline.json')
  for (const e of events) register(e?.id, 'event', 'outline/timeline.json')
  for (const l of lines) register(l?.id, 'timeline-line', 'outline/timeline.json')
  for (const c of chapters) register(c?.meta?.id, 'chapter', c.path)
  // World sections and rules share the namespace like everything else: §4.2 promises a
  // rule can be cited unambiguously ("违反 rule-003"), which a duplicate id breaks.
  for (const s of sections) register(s?.id, 'world-section', 'setting/world.json')
  for (const r of rules) register(r?.id, 'world-rule', 'setting/world.json')
  // Relation types are looked up by id, and a duplicate silently changes semantics:
  // the renderer keeps the LAST while the type set collapses to one, so `directed` and
  // `excludes` can flip with no diagnostic at all.
  for (const t of relationTypes) register(t?.id, 'relation-type', 'relations.json')
  const positions = new Map() // positionId -> organizationId
  for (const o of organizations) {
    for (const p of list(o, 'structure')) {
      if (typeof p?.id !== 'string' || p.id === '') {
        add('error', 'missing-id', 'setting/organizations.json',
          `a position in organization "${o?.id ?? '?'}" has no usable id`, [o?.id])
        continue
      }
      if (positions.has(p.id)) {
        add('error', 'duplicate-position-id', 'setting/organizations.json',
          `position id "${p.id}" is declared more than once (in "${o?.id ?? '?'}" and "${positions.get(p.id)}")`, [p.id])
      } else {
        positions.set(p.id, o.id)
      }
    }
  }
  // Duplicate edge ids only; the missing-id case is reported in the per-edge loop below,
  // so checking it here as well would double-report the same fault.
  const edgeIds = new Set()
  for (const edge of edges) {
    if (typeof edge?.id !== 'string' || edge.id === '') continue
    if (edgeIds.has(edge.id)) {
      add('error', 'duplicate-id', 'relations.json', `edge id "${edge.id}" is declared more than once`, [edge.id])
    }
    edgeIds.add(edge.id)
  }
  // Pins live inside each map now. The legacy top-level list is still read, because an author's
  // existing file has not been rewritten yet and its pins must keep being validated.
  const mapDoc = docs['setting/map/index.json']
  const pins = [
    ...list(mapDoc, 'maps').flatMap((entry) => list(entry, 'pins')),
    ...list(mapDoc, 'pins'),
  ]
  for (const pin of pins) register(pin?.id, 'map-pin', 'setting/map/index.json')

  const typeIds = new Set(relationTypes.map((t) => t?.id).filter((id) => typeof id === 'string'))
  const refExists = (id) => typeof id === 'string' && ids.has(id)

  /**
   * A blank key in a free-form map is always a bug: the editor filters such rows
   * out, so they are invisible and unremovable, yet they persist in the file.
   * They came from a form that appended a placeholder row to the data instead of
   * holding it in component state.
   *
   * A hoisted declaration because it is used both by the chapter loop above and
   * the entity collections below.
   */
  function checkBlankKeys(record, path, what, ownerIds) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return
    for (const key of Object.keys(record)) {
      if (String(key).trim() === '') {
        add('error', 'blank-map-key', path,
          `${what} contains a blank key — invisible in the editor but persisted in the file`, ownerIds)
      }
    }
  }

  /**
   * Chapter front-matter references are validated as WARNINGS, not errors.
   *
   * A novelist names a character in the prose long before formalising the
   * character card, and the AI skills write chapters from an outline — so an
   * unresolved name here is a normal stage of authoring, not a defect. Refusing
   * the save makes the editor unusable for exactly the workflow it exists for.
   *
   * The strict rule still applies where structural integrity actually depends on
   * it: `relations.json` endpoints, `parentId` links, and entity `categoryId`
   * remain errors, because a relationship graph or a tree with a missing node is
   * not a temporary state — it is a broken document.
   */
  const checkChapterRef = (value, path, what, ownerIds) => {
    if (value === null || value === undefined) return
    if (typeof value !== 'string' || value === '') return
    if (!refExists(value)) {
      add('warning', 'unresolved-chapter-reference', path,
        `${what} names "${value}", which no entity defines yet — create it, or correct the name`,
        [value, ...ownerIds])
    }
  }
  const checkChapterRefList = (values, path, what, ownerIds) => {
    if (!Array.isArray(values)) return
    for (const value of values) checkChapterRef(value, path, what, ownerIds)
  }

  /**
   * A reference must point at something that exists.
   *
   * `where` names the REFERRER in the author's terms — which map, which marker — because a refusal the
   * author cannot act on is barely better than a silent one. It is optional so the many call sites that
   * already read clearly are untouched.
   */
  const checkRef = (value, path, what, ownerIds, where) => {
    if (value === null || value === undefined) return
    if (typeof value !== 'string' || value === '') {
      add('error', 'bad-reference', path, `${what} must be a non-empty string or null`, ownerIds)
      return
    }
    if (!refExists(value)) {
      const location = typeof where === 'string' && where !== '' ? ` (${where})` : ''
      add('error', 'dangling-reference', path, `${what} points at "${value}", which does not exist${location}`, [value, ...ownerIds])
    }
  }

  const checkRefList = (values, path, what, ownerIds) => {
    if (values === null || values === undefined) return
    if (!Array.isArray(values)) {
      add('error', 'bad-reference-list', path, `${what} must be an array`, ownerIds)
      return
    }
    for (const value of values) checkRef(value, path, what, ownerIds)
  }

  // ---- required documents ----------------------------------------------
  const required = [
    'project.json',
    'relations.json',
    'setting/world.json',
    'setting/places.json',
    'setting/characters.json',
    'setting/organizations.json',
    'setting/items.json',
    'setting/map/index.json',
    'outline/timeline.json',
    'outline/outline.json',
    'views/layout.json',
  ]
  for (const rel of required) {
    if (docs[rel] === undefined) {
      add('warning', 'missing-document', rel, `${rel} is missing; run project create or restore it`)
    }
  }

  // ---- hierarchy cycles -------------------------------------------------
  const checkCycle = (nodes, label, path) => {
    const parentOf = new Map()
    for (const node of nodes) {
      if (typeof node?.id !== 'string') continue
      const parent = node.parentId ?? null
      if (parent !== null && typeof parent === 'string') parentOf.set(node.id, parent)
    }
    for (const start of parentOf.keys()) {
      const seen = new Set([start])
      let current = parentOf.get(start)
      while (current !== undefined) {
        if (seen.has(current)) {
          add('error', 'parent-cycle', path, `${label} hierarchy contains a cycle through "${start}"`, [start, current])
          break
        }
        seen.add(current)
        current = parentOf.get(current)
      }
    }
  }
  checkCycle(organizations, 'organization', 'setting/organizations.json')
  checkCycle(categories, 'item category', 'setting/items.json')
  checkCycle(places, 'place', 'setting/places.json')
  checkCycle(outlineNodes, 'outline', 'outline/outline.json')
  for (const o of organizations) {
    checkCycle(list(o, 'structure'), `position (${o?.id ?? '?'})`, 'setting/organizations.json')
  }

  // ---- per-entity references -------------------------------------------
  for (const c of characters) {
    const at = `setting/characters.json#${c?.id ?? '?'}`
    checkRef(c?.firstAppearance, at, 'firstAppearance', [c?.id])
    if (c?.born !== null && c?.born !== undefined && timeKey(c.born) === null) {
      add('error', 'bad-time', at, 'born must be a time object with a numeric year or null', [c?.id])
    }
    checkEnum('character.gender', c?.gender, at, [c?.id])
    checkEnum('character.status', c?.status, at, [c?.id])
  }
  for (const o of organizations) {
    const at = `setting/organizations.json#${o?.id ?? '?'}`
    checkRef(o?.parentId, at, 'parentId', [o?.id])
    // `founded` is a time like `born` and `at`; it was the one time field with no check.
    // Only the skills can produce a malformed one (both UI writers yield null), which is
    // exactly why it matters: the skills are a first-class writer in this design.
    if (o?.founded !== null && o?.founded !== undefined && timeKey(o.founded) === null) {
      add('error', 'bad-time', at, 'founded must be a time object with a numeric year or null', [o?.id])
    }
    checkEnum('organization.status', o?.status, at, [o?.id])
    // A position's parent is another position in the SAME organization, so the global
    // entity index is the wrong namespace to test against: `pos-*` ids are never
    // top-level entities and never appear in it, which made EVERY subordinate
    // position report as a dangling reference and refused the write.
    const localPositions = new Set(
      list(o, 'structure')
        .map((p) => p?.id)
        .filter((id) => typeof id === 'string' && id !== ''),
    )
    for (const p of list(o, 'structure')) {
      const parent = p?.parentId
      if (parent === null || parent === undefined) continue
      if (typeof parent !== 'string' || parent === '') {
        add('error', 'bad-reference', at, 'position parentId must be a non-empty string or null', [p?.id])
        continue
      }
      if (!localPositions.has(parent)) {
        add('error', 'dangling-reference', at,
          `position parentId points at "${parent}", which is not a position in this organization`, [parent, p?.id])
      }
    }
  }
  for (const i of items) {
    checkRef(i?.categoryId, `setting/items.json#${i?.id ?? '?'}`, 'categoryId', [i?.id])
  }
  for (const c of categories) {
    checkRef(c?.parentId, `setting/items.json#${c?.id ?? '?'}`, 'category parentId', [c?.id])
  }
  for (const p of places) {
    checkRef(p?.parentId, `setting/places.json#${p?.id ?? '?'}`, 'parentId', [p?.id])
  }
  for (const n of outlineNodes) {
    const at = `outline/outline.json#${n?.id ?? '?'}`
    checkRef(n?.parentId, at, 'parentId', [n?.id])
    checkRef(n?.timelineRef, at, 'timelineRef', [n?.id])
    checkRef(n?.chapterId, at, 'chapterId', [n?.id])
    checkEnum('outline-node.kind', n?.kind, at, [n?.id])
  }
  // Timeline lines and world rules have no other per-item loop, so their enum values are
  // judged here rather than left unchecked purely for want of a convenient place.
  for (const l of lines) {
    checkEnum('timeline-line.kind', l?.kind, `outline/timeline.json#${l?.id ?? '?'}`, [l?.id])
  }
  for (const r of rules) {
    checkEnum('world-rule.scope', r?.scope, `setting/world.json#${r?.id ?? '?'}`, [r?.id])
  }
  // The style archive is agent-maintained (`novel-style`), and `status` is what tells
  // `novel-writer` whether to treat it as a reference or as a hard constraint. A bogus value
  // leaves that ambiguous, and the writer would have to guess — the one thing the skills are
  // written to avoid. Absent is fine (an archive written before this field existed).
  const styleStatus = docs['project.json']?.settings?.style?.status
  if (styleStatus !== undefined && styleStatus !== null && styleStatus !== '') {
    if (styleStatus !== 'proposed' && styleStatus !== 'confirmed') {
      add('error', 'bad-enum', 'project.json',
        `settings.style.status must be "proposed" or "confirmed" (received ${JSON.stringify(styleStatus)})`)
    }
  }
  const lineIds = new Set(lines.map((l) => l?.id))
  // The declared calendar, for the range check below.
  const calendar = (docs['outline/timeline.json'] ?? {}).calendar ?? null
  for (const e of events) {
    const at = `outline/timeline.json#${e?.id ?? '?'}`
    if (timeKey(e?.at) === null) {
      add('error', 'bad-time', at, 'at must be a time object with a numeric year', [e?.id])
    }
    if (e?.spanEnd !== null && e?.spanEnd !== undefined && timeKey(e.spanEnd) === null) {
      add('error', 'bad-time', at, 'spanEnd must be a time object or null', [e?.id])
    }
    if (e?.lineId !== undefined && e?.lineId !== null && !lineIds.has(e.lineId)) {
      add('error', 'dangling-reference', at, `lineId points at "${e.lineId}", which is not a timeline line`, [e?.lineId])
    }
    checkRef(e?.outlineRef, at, 'outlineRef', [e?.id])
    // The identically-named field on a relation edge was checked while this one was not,
    // and the form presents it as a raw text box rather than a picker — so a typo
    // persisted forever and "why did this happen" silently resolved to nothing.
    checkRef(e?.causeEventId, at, 'causeEventId', [e?.id])
    checkRefList(e?.characters, at, 'characters', [e?.id])
    checkRefList(e?.places, at, 'places', [e?.id])
    // An event outside the declared calendar is a warning, not an error: a timeline may
    // legitimately be drafted beyond the current range before the calendar is widened. But
    // NOTHING checked it — the calendar was read only by the timeline's axis, so an event in
    // year 1234 with `calendar.end` at 1000 was silently unreachable on the axis and reported
    // by nobody. A skill test found the case; the check belongs here.
    if (timeKey(e?.at) !== null && certainlyOutside(e?.at, calendar?.start ?? null, calendar?.end ?? null)) {
      add('warning', 'event-outside-calendar', at,
        `at (${e?.at?.year ?? '?'}) falls outside the declared calendar ` +
        `(${calendar?.start?.year ?? '?'}–${calendar?.end?.year ?? '?'}); the timeline axis extends to cover it, ` +
        `but the calendar should probably be widened`,
        [e?.id])
    }
  }
  // A pin's placeId is a reference like any other, wherever the pin lives.
  //
  // THE MESSAGE MUST NAME THE REFERRER. The client's delete button tells the author "the host will refuse
  // and list the referrers" — and for this reference it listed nothing: the whole message was
  // `pin placeId points at "place-青云峰", which does not exist`, naming neither the map nor the marker. So
  // deleting a 地点 that any marker was linked to produced an unexplainable refusal with no way to find the
  // culprit. Each marker is now reported with the map it sits on.
  const mapDocForRefs = docs['setting/map/index.json']
  for (const map of list(mapDocForRefs, 'maps')) {
    const where = `map "${map?.name || map?.id || '?'}"`
    for (const p of list(map, 'pins')) {
      checkRef(p?.placeId, 'setting/map/index.json', 'pin placeId', [p?.id], `${where}, marker "${p?.id ?? '?'}"`)
    }
  }
  for (const p of list(mapDocForRefs, 'pins')) {
    checkRef(p?.placeId, 'setting/map/index.json', 'pin placeId', [p?.id], `marker "${p?.id ?? '?'}"`)
  }
  // These five gain a `custom` bag the moment they are edited through the schema form,
  // because `CustomSection` renders unconditionally — yet only some entity types were
  // scanned for the invisible blank row. The check's coverage was incomplete, not wrong.
  for (const n of outlineNodes) checkBlankKeys(n?.custom, `outline/outline.json#${n?.id ?? '?'}`, [n?.id])
  for (const l of lines) checkBlankKeys(l?.custom, `outline/timeline.json#${l?.id ?? '?'}`, [l?.id])
  for (const e of events) checkBlankKeys(e?.custom, `outline/timeline.json#${e?.id ?? '?'}`, [e?.id])
  for (const s of sections) checkBlankKeys(s?.custom, `setting/world.json#${s?.id ?? '?'}`, [s?.id])
  for (const r of rules) checkBlankKeys(r?.custom, `setting/world.json#${r?.id ?? '?'}`, [r?.id])

  for (const c of chapters) {
    if (c?.meta?.error) {
      add('error', 'bad-front-matter', c.path, String(c.meta.error), [])
      continue
    }
    const at = c.path
    checkChapterRefList(c?.meta?.characters, at, 'characters', [c?.meta?.id])
    checkChapterRefList(c?.meta?.places, at, 'places', [c?.meta?.id])
    checkChapterRef(c?.meta?.volumeRef, at, 'volumeRef', [c?.meta?.id])
    checkChapterRef(c?.meta?.outlineRef, at, 'outlineRef', [c?.meta?.id])
    checkBlankKeys(c?.meta?.custom, at, `chapter "${c?.meta?.id ?? '?'}" custom`, [c?.meta?.id])
    if (c?.meta?.order !== undefined && !Number.isFinite(Number(c.meta.order))) {
      add('error', 'bad-order', at, 'order must be a number', [c?.meta?.id])
    }
    checkEnum('chapter.status', c?.meta?.status, at, [c?.meta?.id])
  }

  // ---- free-form maps must not carry blank keys ---------------------------
  // (`checkBlankKeys` lives above, beside the other reference checks.)
  for (const [path, collection, label] of [
    ['setting/characters.json', characters, 'character'],
    ['setting/organizations.json', organizations, 'organization'],
    ['setting/items.json', items, 'item'],
    ['setting/items.json', categories, 'item category'],
    ['setting/places.json', places, 'place'],
  ]) {
    for (const entity of collection) {
      checkBlankKeys(entity?.custom, path, `${label} "${entity?.id ?? '?'}" custom`, [entity?.id])
      if (entity?.attrs !== undefined) {
        checkBlankKeys(entity.attrs, path, `${label} "${entity?.id ?? '?'}" attrs`, [entity?.id])
      }
    }
  }

  // ---- relations: references, intervals, exclusivity -------------------
  const typesById = new Map(relationTypes.map((t) => [t?.id, t]))
  const intervalsByPairType = new Map() // key -> { pair, type, items: [{ edge, start, end }] }

  for (const edge of edges) {
    const at = `relations.json#${edge?.id ?? '?'}`
    const owner = [edge?.id]
    if (typeof edge?.id !== 'string' || edge.id === '') {
      add('error', 'edge-missing-id', 'relations.json', 'every relation edge needs an id', [])
      continue
    }
    checkRef(edge.from, at, 'from', owner)
    checkRef(edge.to, at, 'to', owner)
    // The form offers the same node list in both 起点 and 终点, so a self-relation is one
    // mis-click away. It is not harmless: the layout drops zero-length links, so the
    // edge is counted in the total but drawn as a type label sitting on top of the node.
    if (edge.from !== null && edge.from !== undefined && edge.from === edge.to) {
      add('error', 'self-relation', at,
        `a relation from "${edge.from}" to itself is not a relationship`, owner)
    }
    checkRef(edge.causeEventId, at, 'causeEventId', owner)

    const type = typesById.get(edge.type)
    if (type === undefined) {
      add('error', 'unknown-relation-type', at,
        `type "${edge.type}" is not declared in relations.json types`, owner)
    }
    if (edge.positionId !== undefined && edge.positionId !== null) {
      if (!positions.has(edge.positionId)) {
        add('error', 'dangling-reference', at,
          `positionId "${edge.positionId}" does not exist in any organization`, owner)
      } else if (refExists(edge.to) && positions.get(edge.positionId) !== edge.to) {
        add('warning', 'position-org-mismatch', at,
          `positionId "${edge.positionId}" belongs to ${positions.get(edge.positionId)}, not ${edge.to}`, owner)
      }
    }

    const start = timeKey(edge.since)
    const end = edge.until === null || edge.until === undefined ? OPEN_END : timeKey(edge.until)
    if (start === null) {
      add('error', 'bad-time', at, 'since must be a time object with a numeric year', owner)
      continue
    }
    if (edge.until !== null && edge.until !== undefined && end === null) {
      add('error', 'bad-time', at, 'until must be a time object or null', owner)
      continue
    }
    if (end !== OPEN_END && !(start < end)) {
      add('error', 'interval-inverted', at, 'since must be earlier than until', owner)
      continue
    }

    // Undirected types treat (A,B) and (B,A) as the same pair.
    const undirected = type !== undefined && type.directed === false
    const pair = undirected && typeof edge.from === 'string' && typeof edge.to === 'string'
      ? [edge.from, edge.to].sort().join('\u0000')
      : `${edge.from}\u0000${edge.to}`
    const key = `${pair}\u0000${edge.type}`
    const bucket = intervalsByPairType.get(key) ?? { pair, type: edge.type, items: [] }
    bucket.items.push({ edge, start, end })
    intervalsByPairType.set(key, bucket)
  }

  for (const bucket of intervalsByPairType.values()) {
    for (let i = 0; i < bucket.items.length; i += 1) {
      for (let j = i + 1; j < bucket.items.length; j += 1) {
        const a = bucket.items[i]
        const b = bucket.items[j]
        if (intervalsOverlap(a.start, a.end, b.start, b.end)) {
          add('error', 'interval-overlap', `relations.json#${b.edge.id}`,
            `overlaps "${a.edge.id}" — the same pair cannot hold "${a.edge.type}" twice at once`,
            [a.edge.id, b.edge.id])
        }
      }
    }
  }

  // Exclusivity, per declared pair. Both directions are checked because a type
  // only names what it excludes, not what excludes it.
  for (const bucketA of intervalsByPairType.values()) {
    const excludesA = typesById.get(bucketA.type)?.excludes
    if (!Array.isArray(excludesA) || excludesA.length === 0) continue
    for (const bucketB of intervalsByPairType.values()) {
      if (bucketB.pair !== bucketA.pair) continue
      if (!excludesA.includes(bucketB.type)) continue
      for (const a of bucketA.items) {
        for (const b of bucketB.items) {
          if (intervalsOverlap(a.start, a.end, b.start, b.end)) {
            add('error', 'exclusive-relation-overlap', `relations.json#${b.edge.id}`,
              `"${bucketB.type}" and "${bucketA.type}" exclude each other but overlap in time`,
              [a.edge.id, b.edge.id])
          }
        }
      }
    }
  }

  // ---- warnings that are legal but usually a mistake -------------------
  const deadAt = new Map()
  for (const c of characters) {
    if (c?.status === 'dead' && typeof c.id === 'string') deadAt.set(c.id, c.id)
  }
  for (const edge of edges) {
    const open = edge?.until === null || edge?.until === undefined
    if (!open) continue
    for (const side of [edge?.from, edge?.to]) {
      if (deadAt.has(side)) {
        add('warning', 'open-relation-to-dead', `relations.json#${edge?.id}`,
          `"${side}" is marked dead, yet this relation is still open`, [edge?.id, side])
      }
    }
  }

  const errors = issues.filter((issue) => issue.level === 'error').length
  return {
    issues,
    counts: {
      errors,
      warnings: issues.length - errors,
      entities: ids.size,
      edges: edges.length,
      chapters: chapters.length,
    },
  }
}
