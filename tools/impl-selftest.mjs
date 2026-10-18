/**
 * Offline self-test for the host-half impl modules.
 *
 * These modules are pure (or nearly so) by design, which means the interesting
 * logic — path containment, front-matter round-tripping, the structural
 * validator — can be exercised without a running host. That matters because the
 * only other way to test host-side code in this project is a full host restart.
 *
 * Run: node tools/impl-selftest.mjs
 * Exits non-zero on the first failed case, so it also works as a gate.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as yaml from 'js-yaml'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname as dirnameOf } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

import * as schema from '../lib/impl/schema.js'
import * as paths from '../lib/impl/paths.js'
import * as store from '../lib/impl/store.js'
import * as frontmatter from '../lib/impl/frontmatter.js'
import * as validate from '../lib/impl/validate.js'
import * as scaffold from '../lib/impl/scaffold.js'
import * as text from '../lib/impl/text.js'
import * as prompt from '../lib/impl/prompt.js'
import * as context from '../lib/impl/context.js'
import * as chapterContext from '../lib/impl/chapter-context.js'
import * as manuscript from '../lib/impl/manuscript.js'
import * as router from '../lib/impl/router.js'

let passed = 0
const failures = []

const ROOT = join(dirnameOf(fileURLToPath(import.meta.url)), '..')

function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name, message: error.message })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertThrows(fn, codeFragment, message) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert(thrown !== null, `${message}: expected a throw, got none`)
  if (codeFragment !== null) {
    assert(
      String(thrown.code ?? '').includes(codeFragment),
      `${message}: expected code containing "${codeFragment}", got "${thrown.code}" (${thrown.message})`,
    )
  }
}

// --- paths: containment ----------------------------------------------------
check('paths accepts a normal document path', () => {
  const result = paths.resolveInside('C:/proj/novel', 'setting/world.json')
  assert(result.rel === 'setting/world.json', `unexpected rel ${result.rel}`)
})

check('paths refuses traversal', () => {
  assertThrows(() => paths.normalizeRelative('../secrets.json'), 'path-traversal', 'traversal')
  assertThrows(() => paths.normalizeRelative('setting/../../x.json'), 'path-traversal', 'nested traversal')
})

check('paths refuses absolute and drive paths', () => {
  assertThrows(() => paths.normalizeRelative('C:/Windows/system32/x.txt'), 'path-absolute', 'drive path')
  assertThrows(() => paths.normalizeRelative('/etc/passwd'), 'path-absolute', 'posix absolute')
})

check('paths refuses alternate data streams and device names', () => {
  assertThrows(() => paths.normalizeRelative('draft/ch.md:secret'), 'path-colon', 'ADS')
  assertThrows(() => paths.normalizeRelative('setting/CON.json'), 'path-device', 'device name')
  assertThrows(() => paths.normalizeRelative('setting/nul'), 'path-device', 'nul')
})

check('paths refuses an empty path', () => {
  assertThrows(() => paths.normalizeRelative(''), 'path-required', 'empty')
  assertThrows(() => paths.normalizeRelative('   '), 'path-required', 'blank')
})

check('paths proves containment even for a cleaned-up path', () => {
  // `resolveInside` is the second, independent check; it must not be fooled by
  // a path that normalizeRelative let through on a technicality.
  const result = paths.resolveInside('C:/proj/novel', 'a/b/c.json')
  assert(result.abs.endsWith('c.json'), `unexpected abs ${result.abs}`)
})

// --- front matter ----------------------------------------------------------
check('front matter round-trips Chinese and lists', () => {
  const meta = frontmatter.newChapterMeta({ id: 'ch-0001', title: '第一章 青云山下', order: 10 })
  meta.characters = ['char-linyuan', 'char-shenyi']
  const text = frontmatter.serializeFrontMatter(meta, '他抬头，看见山崩了。\n')
  const parsed = frontmatter.parseFrontMatter(text)
  assert(parsed.error === null, `parse error: ${parsed.error}`)
  assert(parsed.meta.id === 'ch-0001', 'id lost')
  assert(parsed.meta.title === '第一章 青云山下', `title mangled: ${parsed.meta.title}`)
  assert(parsed.meta.characters.length === 2, 'list lost')
  assert(parsed.body.includes('山崩'), 'body lost')
  assert(parsed.body.includes('抬头'), 'body content wrong')
})

check('front matter key order is stable', () => {
  const meta = frontmatter.newChapterMeta({ id: 'ch-0002', title: 'T', order: 20 })
  const lines = frontmatter.serializeFrontMatter(meta, '').split('\n')
  const idLine = lines.findIndex((l) => l.startsWith('id:'))
  const titleLine = lines.findIndex((l) => l.startsWith('title:'))
  const orderLine = lines.findIndex((l) => l.startsWith('order:'))
  assert(idLine < titleLine && titleLine < orderLine, `field order wrong: id@${idLine} title@${titleLine} order@${orderLine}`)
})

check('malformed front matter degrades instead of throwing', () => {
  const parsed = frontmatter.parseFrontMatter('---\nid: [unclosed\n---\n\nbody\n')
  assert(parsed.error !== null, 'expected an error to be reported')
  assert(parsed.body.includes('body'), 'body must survive a front-matter failure')
})

check('missing front matter is not an error', () => {
  const parsed = frontmatter.parseFrontMatter('just prose, no front matter\n')
  assert(parsed.error === null, 'a plain markdown file is valid')
  assert(parsed.hasFrontMatter === false, 'hasFrontMatter should be false')
})

// --- schema / scaffold -----------------------------------------------------
check('empty documents cover every declared file', () => {
  const docs = schema.emptyDocuments({ title: '青云记' })
  for (const rel of Object.values(schema.FILES)) {
    assert(docs[rel] !== undefined, `emptyDocuments is missing ${rel}`)
  }
})

check('scaffold writes the default calendar (age derivation depends on it)', () => {
  const plan = scaffold.planScaffold({ schema, title: '青云记', now: '2026-01-01T00:00:00.000Z' })
  assert(plan.calendar?.epochLabel !== undefined, 'calendar missing from the plan')
  const timeline = plan.files.find((f) => f.rel === schema.FILES.timeline)
  assert(timeline.value.calendar.start.year === 1, 'timeline has no default calendar')
  assert(timeline.value.lines.length === 1, 'timeline should start with one main line')
})

check('project id is derived from the title and is idempotent', () => {
  assert(schema.projectIdFor('青云记') === schema.projectIdFor('青云记'), 'not deterministic')
  assert(schema.projectIdFor('') === 'proj-untitled', `empty title gave ${schema.projectIdFor('')}`)
})

// --- validator -------------------------------------------------------------
function baseDocs() {
  const docs = schema.emptyDocuments({ title: '测试', now: '2026-01-01T00:00:00.000Z' })
  docs[schema.FILES.characters].characters = [
    { id: 'char-a', name: '甲', status: 'alive', born: { year: 10 }, custom: {} },
    { id: 'char-b', name: '乙', status: 'alive', born: { year: 12 }, custom: {} },
  ]
  return docs
}

check('a clean minimal project has no errors', () => {
  const report = validate.validateProject({ docs: baseDocs(), chapters: [] })
  const errors = report.issues.filter((i) => i.level === 'error')
  assert(errors.length === 0, `unexpected errors: ${JSON.stringify(errors, null, 2)}`)
})

check('a dangling reference is an error, and NAMES whoever is holding it', () => {
  const docs = baseDocs()
  docs[schema.FILES.relations].edges = [
    { id: 'rel-1', from: 'char-a', to: 'char-ghost', type: 'ally', since: { year: 1 }, until: null },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  assert(
    report.issues.some((i) => i.code === 'dangling-reference'),
    `expected dangling-reference, got ${JSON.stringify(report.issues)}`,
  )

  // THE MESSAGE MUST BE ACTIONABLE. A refusal the author cannot act on is barely better than a silent one,
  // and the client's delete button explicitly promises that the host "lists the referrers". For a marker's
  // 地点 link it listed NOTHING — the whole message was `pin placeId points at "place-x", which does not
  // exist`, naming neither the map nor the marker, so deleting a linked 地点 produced an unexplainable
  // refusal with no way to find the culprit.
  const stale = baseDocs()
  stale[schema.FILES.places].places = []
  stale[schema.FILES.map].maps = [{
    id: 'map-1',
    name: '大陆',
    canvas: { width: 100, height: 100 },
    background: { kind: 'blank', asset: null },
    strokes: [],
    paths: [],
    pins: [{ id: 'pin-1', placeId: 'place-青云峰', x: 1, y: 1, label: '' }],
  }]
  const staleReport = validate.validateProject({ docs: stale, chapters: [] })
  const issue = staleReport.issues.find((i) => i.code === 'dangling-reference')
  assert(issue !== undefined, 'a marker pointing at a missing 地点 is refused')
  assert(issue.level === 'error', 'and it is an error, so the write really is blocked')
  assert(issue.message.includes('大陆'), `the message must name the MAP, got: ${issue.message}`)
  assert(issue.message.includes('pin-1'), `the message must name the MARKER, got: ${issue.message}`)
  assert(issue.message.includes('place-青云峰'), 'and the reference it cannot find')
  // The ids travel too, so a UI could render them as links.
  assert(Array.isArray(issue.ids) && issue.ids.includes('pin-1') && issue.ids.includes('place-青云峰'), `expected both ids, got ${JSON.stringify(issue.ids)}`)
  // A marker whose 地点 EXISTS is not an error — the check must not fire on a healthy link.
  const healthy = baseDocs()
  healthy[schema.FILES.places].places = [{ id: 'place-青云峰', name: '青云峰', kind: '', summary: '', tags: [], custom: {} }]
  healthy[schema.FILES.map].maps = [{ ...stale[schema.FILES.map].maps[0] }]
  const healthyReport = validate.validateProject({ docs: healthy, chapters: [] })
  assert(!healthyReport.issues.some((i) => i.code === 'dangling-reference'), 'a healthy link is not complained about')
  // The LEGACY top-level pin list is still checked, and still named.
  const legacy = baseDocs()
  legacy[schema.FILES.places].places = []
  legacy[schema.FILES.map] = { ...legacy[schema.FILES.map], maps: undefined, pins: [{ id: 'pin-9', placeId: 'place-幽灵', x: 0, y: 0 }] }
  const legacyIssue = validate.validateProject({ docs: legacy, chapters: [] }).issues.find((i) => i.code === 'dangling-reference')
  assert(legacyIssue !== undefined && legacyIssue.message.includes('pin-9'), `a legacy pin is named too, got ${legacyIssue?.message}`)
})

check('duplicate ids are an error', () => {
  const docs = baseDocs()
  docs[schema.FILES.characters].characters.push({ id: 'char-a', name: '重复' })
  const report = validate.validateProject({ docs, chapters: [] })
  assert(report.issues.some((i) => i.code === 'duplicate-id'), 'expected duplicate-id')
})

check('an inverted relation interval is an error', () => {
  const docs = baseDocs()
  docs[schema.FILES.relations].edges = [
    { id: 'rel-1', from: 'char-a', to: 'char-b', type: 'ally', since: { year: 50 }, until: { year: 10 } },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  assert(report.issues.some((i) => i.code === 'interval-inverted'), 'expected interval-inverted')
})

check('overlapping intervals for the same pair and type are an error', () => {
  const docs = baseDocs()
  docs[schema.FILES.relations].edges = [
    { id: 'rel-1', from: 'char-a', to: 'char-b', type: 'ally', since: { year: 10 }, until: { year: 20 } },
    { id: 'rel-2', from: 'char-a', to: 'char-b', type: 'ally', since: { year: 15 }, until: { year: 25 } },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  assert(report.issues.some((i) => i.code === 'interval-overlap'), 'expected interval-overlap')
})

check('a gap between intervals of the same pair and type is allowed', () => {
  const docs = baseDocs()
  docs[schema.FILES.relations].edges = [
    { id: 'rel-1', from: 'char-a', to: 'char-b', type: 'ally', since: { year: 10 }, until: { year: 20 } },
    { id: 'rel-2', from: 'char-a', to: 'char-b', type: 'ally', since: { year: 30 }, until: { year: 40 } },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  const errors = report.issues.filter((i) => i.level === 'error')
  assert(errors.length === 0, `a gap is legal, got ${JSON.stringify(errors)}`)
})

check('touching intervals do not overlap (since inclusive, until exclusive)', () => {
  const docs = baseDocs()
  docs[schema.FILES.relations].edges = [
    { id: 'rel-1', from: 'char-a', to: 'char-b', type: 'master-apprentice', since: { year: 10 }, until: { year: 20 } },
    { id: 'rel-2', from: 'char-a', to: 'char-b', type: 'hostile', since: { year: 20 }, until: null },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  const errors = report.issues.filter((i) => i.level === 'error')
  assert(errors.length === 0, `handover at one instant must be clean, got ${JSON.stringify(errors)}`)
})

check('mutually exclusive relation types cannot overlap', () => {
  const docs = baseDocs()
  docs[schema.FILES.relations].edges = [
    { id: 'rel-1', from: 'char-a', to: 'char-b', type: 'ally', since: { year: 10 }, until: { year: 30 } },
    { id: 'rel-2', from: 'char-a', to: 'char-b', type: 'hostile', since: { year: 20 }, until: { year: 40 } },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  assert(
    report.issues.some((i) => i.code === 'exclusive-relation-overlap'),
    `expected exclusive-relation-overlap, got ${JSON.stringify(report.issues)}`,
  )
})

check('an unknown relation type is an error', () => {
  const docs = baseDocs()
  docs[schema.FILES.relations].edges = [
    { id: 'rel-1', from: 'char-a', to: 'char-b', type: 'invented', since: { year: 1 }, until: null },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  assert(report.issues.some((i) => i.code === 'unknown-relation-type'), 'expected unknown-relation-type')
})

check('a parent cycle is an error', () => {
  const docs = baseDocs()
  docs[schema.FILES.places].places = [
    { id: 'place-x', name: 'X', parentId: 'place-y' },
    { id: 'place-y', name: 'Y', parentId: 'place-x' },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  assert(report.issues.some((i) => i.code === 'parent-cycle'), 'expected parent-cycle')
})

check('a chapter naming an unknown character warns rather than blocks', () => {
  // Deliberate asymmetry: a novelist names a character before formalising the
  // card, so this must not stop the save. Blocking it made the chapter editor
  // unusable for the workflow it exists for.
  const docs = baseDocs()
  const report = validate.validateProject({
    docs,
    chapters: [{ path: 'draft/ch-0001.md', meta: { id: 'ch-0001', characters: ['char-ghost'] } }],
  })
  const errors = report.issues.filter((i) => i.level === 'error')
  assert(errors.length === 0, `must not be an error: ${JSON.stringify(errors)}`)
  assert(
    report.issues.some((i) => i.code === 'unresolved-chapter-reference'),
    `expected unresolved-chapter-reference, got ${JSON.stringify(report.issues)}`,
  )
})

check('a dangling reference in relations.json is still an error', () => {
  // The strict rule survives where structural integrity depends on it: a graph
  // with a missing node is a broken document, not a stage of authoring.
  const docs = baseDocs()
  docs[schema.FILES.relations].edges = [
    { id: 'rel-1', from: 'char-a', to: 'char-ghost', type: 'ally', since: { year: 1 }, until: null },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  assert(report.issues.some((i) => i.level === 'error' && i.code === 'dangling-reference'), 'relations must stay strict')
})

check('an open relation to a dead character is a warning, not an error', () => {
  const docs = baseDocs()
  docs[schema.FILES.characters].characters[1].status = 'dead'
  docs[schema.FILES.relations].edges = [
    { id: 'rel-1', from: 'char-a', to: 'char-b', type: 'owns', since: { year: 1 }, until: null },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  const errors = report.issues.filter((i) => i.level === 'error')
  assert(errors.length === 0, `must not be an error: ${JSON.stringify(errors)}`)
  assert(report.issues.some((i) => i.code === 'open-relation-to-dead'), 'expected the warning')
})

check('a blank key in a free-form map is an error', () => {
  const docs = baseDocs()
  docs[schema.FILES.characters].characters[0].custom = { '': '', 性格: '外冷内热' }
  const report = validate.validateProject({ docs, chapters: [] })
  assert(
    report.issues.some((i) => i.code === 'blank-map-key'),
    `expected blank-map-key, got ${JSON.stringify(report.issues)}`,
  )
})

check('legitimate custom entries are not flagged', () => {
  const docs = baseDocs()
  docs[schema.FILES.characters].characters[0].custom = { 性格: '外冷内热', 本命法宝: '青锋剑' }
  const report = validate.validateProject({ docs, chapters: [] })
  const errors = report.issues.filter((i) => i.level === 'error')
  assert(errors.length === 0, `unexpected errors: ${JSON.stringify(errors)}`)
})

check('a time with a null year is unusable, not year zero', () => {
  // `Number(null)` is 0, so a blind coercion read a cleared year as year 0 and
  // moved the event to the start of history instead of flagging it.
  const docs = baseDocs()
  docs[schema.FILES.timeline].events = [
    { id: 'evt-1', lineId: 'tl-main', at: { year: null, month: null, day: null }, title: '坏时间' },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  assert(report.issues.some((i) => i.code === 'bad-time'), `expected bad-time, got ${JSON.stringify(report.issues)}`)
  assert(validate.timeKey({ year: null }) === null, 'timeKey({year:null}) must be null')
  assert(validate.timeKey({}) === null, 'timeKey({}) must be null')
  assert(validate.timeKey({ year: 0 }) === 0, 'a real year 0 is still valid')
  assert(validate.timeKey({ year: '1345', month: '3' }) === 13450300, 'numeric strings must stay accepted')
})

check('an event with a usable time passes', () => {
  const docs = baseDocs()
  docs[schema.FILES.timeline].events = [
    { id: 'evt-1', lineId: 'tl-main', at: { year: 1345, month: 3, day: 2 }, title: '青云山崩' },
  ]
  const report = validate.validateProject({ docs, chapters: [] })
  const errors = report.issues.filter((i) => i.level === 'error')
  assert(errors.length === 0, `unexpected errors: ${JSON.stringify(errors)}`)
})

// --- word count ------------------------------------------------------------

check('countWords counts each CJK character as one word', () => {
  // The point of the rule: a 5000-character Chinese chapter is 5000 words, not
  // one. A whitespace-token count would report 1 and make the number useless.
  assert(text.countWords('第一章 青云山下') === 7, `got ${text.countWords('第一章 青云山下')}`)
  assert(text.countWords('他抬头，看见山崩了。') === 8, `CJK punctuation must not count: ${text.countWords('他抬头，看见山崩了。')}`)
})

check('countWords counts Latin and digit runs as one word each', () => {
  assert(text.countWords('Hello world') === 2, `got ${text.countWords('Hello world')}`)
  assert(text.countWords('青云山 abc 123') === 5, `got ${text.countWords('青云山 abc 123')}`)
  assert(text.countWords("don't stop") === 2, `an apostrophe must not split a word: ${text.countWords("don't stop")}`)
})

check('countWords tolerates empty and missing input', () => {
  assert(text.countWords('') === 0, 'empty text is zero')
  assert(text.countWords(null) === 0, 'null is zero')
  assert(text.countWords(undefined) === 0, 'undefined is zero')
  assert(text.countWords('   \n\t ') === 0, 'whitespace only is zero')
})

// --- model prompts and output handling -------------------------------------

check('extractJsonObject finds JSON wrapped in prose and fences', () => {
  // Models add a sentence, a code fence, or both. The scan is for the matching
  // brace, not for the whole response.
  assert(prompt.extractJsonObject('{"a":1}').value.a === 1, 'bare JSON')
  assert(prompt.extractJsonObject('好的：\n{"a":1}\n以上。').value.a === 1, 'JSON surrounded by prose')
  assert(prompt.extractJsonObject('```json\n{"a":1}\n```').value.a === 1, 'JSON in a fence')
  assert(prompt.extractJsonObject('  \n {"a":{"b":[1,2]}} \n').value.a.b[1] === 2, 'nested JSON')
})

check('extractJsonObject is not fooled by braces inside strings', () => {
  // A naive first-{-to-last-} slice would truncate here.
  const text = '{"note":"a } brace","n":1}'
  const parsed = prompt.extractJsonObject(text)
  assert(parsed.error === null, `should parse: ${parsed.error}`)
  assert(parsed.value.note === 'a } brace', `string content mangled: ${parsed.value.note}`)
  assert(parsed.value.n === 1, 'the rest must survive')
})

check('extractJsonObject also handles escaped quotes', () => {
  const parsed = prompt.extractJsonObject('{"note":"say \\"hi\\"","n":2}')
  assert(parsed.error === null, `should parse: ${parsed.error}`)
  assert(parsed.value.n === 2, 'the escape must not end the string early')
})

check('extractJsonObject reports rather than throwing', () => {
  assert(prompt.extractJsonObject('完全没有 JSON').error !== null, 'no object is an error')
  assert(prompt.extractJsonObject('{"a":1').error !== null, 'an unterminated object is an error')
  assert(prompt.extractJsonObject('{oops}').error !== null, 'invalid JSON is an error')
  assert(prompt.extractJsonObject('').error !== null, 'empty text is an error')
})

const itemGenerator = prompt.GENERATORS.item

check('every generator is complete enough to be usable', () => {
  // A generator missing its collection cannot be grounded in the project (no
  // existing names to avoid), and one missing a nameField can produce an unnamed
  // entity. Both are silent failures, so they are asserted rather than assumed.
  const kinds = Object.keys(prompt.GENERATORS)
  assert(kinds.length === 5, `expected five generators, got ${kinds.join(', ')}`)
  for (const kind of ['item', 'character', 'place', 'organization', 'timeline-event']) {
    assert(kinds.includes(kind), `the ${kind} generator is missing`)
  }
  for (const [kind, generator] of Object.entries(prompt.GENERATORS)) {
    assert(typeof generator.label === 'string' && generator.label !== '', `${kind} has no label`)
    assert(typeof generator.scenario === 'string' && generator.scenario !== '', `${kind} has no scenario`)
    assert(Array.isArray(generator.fields) && generator.fields.length > 0, `${kind} declares no fields`)
    assert(typeof generator.nameField === 'string', `${kind} has no nameField`)
    assert(typeof generator.fallbackName === 'string' && generator.fallbackName !== '', `${kind} has no fallbackName`)
    assert(generator.collection !== undefined, `${kind} declares no collection, so it cannot be grounded`)
    assert(
      generator.fields.some((field) => field.key === generator.nameField),
      `${kind}'s nameField is not among its fields`,
    )
    // A model must never invent an entity id: references are the author's to pick.
    assert(
      !generator.fields.some((field) => field.key.endsWith('Id') || field.key === 'characters' || field.key === 'places'),
      `${kind} asks the model for a reference, which it must not do`,
    )
  }
})

check('resolveStyle maps an id to the instruction, and an unknown id to nothing', () => {
  // The client sends the id, never the wording, so there is no second copy of the
  // preset table to drift.
  const resolved = prompt.resolveStyle('eerie')
  assert(typeof resolved === 'string' && resolved.length > 0, 'a known preset must resolve to an instruction')
  assert(prompt.resolveStyle('nonsense') === '', 'an unknown id must resolve to no instruction')
  assert(prompt.resolveStyle(undefined) === '', 'a missing id must resolve to no instruction')
})

check('catalogue describes what generation can use, without leaking instructions', () => {
  const catalogue = prompt.catalogue()
  assert(Array.isArray(catalogue.styles) && catalogue.styles.length > 0, 'styles must be listed')
  for (const style of catalogue.styles) {
    assert(typeof style.id === 'string' && typeof style.label === 'string', `a style is malformed: ${JSON.stringify(style)}`)
    // Passing the instruction to the client would invite the client to send it
    // back, recreating exactly the duplication this design avoids.
    assert(style.instruction === undefined, `the catalogue leaked the instruction for "${style.id}"`)
  }
  const kinds = catalogue.generators.map((entry) => entry.kind)
  for (const kind of ['item', 'character', 'place', 'organization', 'timeline-event']) {
    assert(kinds.includes(kind), `the catalogue omits the ${kind} generator`)
  }
  assert(catalogue.maxCandidates >= 1, 'the candidate ceiling must be published')
})

check('extractCandidates handles the wrapper, a bare object, and junk', () => {
  assert(prompt.extractCandidates({ candidates: [{ a: 1 }, { a: 2 }] }).length === 2, 'the wrapper is unwrapped')
  // A model that ignores the wrapper is a worse result, not a failed request.
  assert(prompt.extractCandidates({ name: 'x' }).length === 1, 'a bare object is one candidate')
  assert(prompt.extractCandidates(null).length === 0, 'null yields nothing')
  assert(prompt.extractCandidates('text').length === 0, 'a string yields nothing')
  assert(prompt.extractCandidates({ candidates: [] }).length === 0, 'an empty wrapper yields nothing')
})

check('buildPrompt asks for several candidates only when asked', () => {
  const one = prompt.buildPrompt(itemGenerator, {})
  assert(one.system.includes('只输出一个 JSON 对象'), 'the default asks for one object')
  assert(!one.system.includes('candidates'), 'the default must not mention the wrapper')
  assert(one.count === 1, 'the resolved count must be reported back')

  const three = prompt.buildPrompt(itemGenerator, { count: 3 })
  assert(three.system.includes('candidates'), 'several candidates need the wrapper documented')
  assert(three.system.includes('3 个'), `the count must reach the prompt: ${three.system.slice(0, 200)}`)
  assert(three.count === 3, 'the count must be reported back')

  // The ceiling protects the author's quota from a client bug.
  assert(prompt.buildPrompt(itemGenerator, { count: 99 }).count === prompt.catalogue().maxCandidates, 'the ceiling must clamp')
  assert(prompt.buildPrompt(itemGenerator, { count: 0 }).count === 1, 'a nonsense count falls back to one')
  assert(prompt.buildPrompt(itemGenerator, { count: -3 }).count === 1, 'a negative count falls back to one')
})

check('buildPrompt carries the style instruction as its own paragraph', () => {
  const styled = prompt.buildPrompt(itemGenerator, { style: prompt.resolveStyle('concise') })
  assert(styled.user.includes('写作要求'), 'the style must be labelled')
  assert(styled.user.includes('简练'), 'the instruction must reach the prompt')
  const plain = prompt.buildPrompt(itemGenerator, {})
  assert(!plain.user.includes('写作要求'), 'no style, no dangling label')
})


check('sanitizeByFields keeps the id and drops everything undeclared', () => {
  // Model output is untrusted: a hallucinated key must never reach the document,
  // where every other view and the validator would then have to cope with it.
  const value = prompt.sanitizeByFields(
    { name: '霜啼', rarity: '灵品', description: '一柄剑', history: '来历', tags: ['古剑'], attrs: { 长度: '三尺' }, evil: 'drop me', id: 'hijacked' },
    { id: 'item-1', custom: { 本命: '是' } },
    itemGenerator,
  )
  assert(value.id === 'item-1', `the existing id must survive: ${value.id}`)
  assert(value.evil === undefined, 'an undeclared field must be dropped')
  assert(value.name === '霜啼' && value.rarity === '灵品', 'declared fields must survive')
  assert(value.attrs['长度'] === '三尺', 'attrs must survive')
  assert(JSON.stringify(value.custom) === '{"本命":"是"}', 'the author’s custom bag must survive a generation')
})

check('sanitizeByFields coerces wrong types instead of trusting them', () => {
  const value = prompt.sanitizeByFields(
    { name: 42, tags: 'not-an-array', attrs: 'not-an-object', description: null },
    {},
    itemGenerator,
  )
  assert(value.name === '42', `a numeric name becomes text: ${JSON.stringify(value.name)}`)
  assert(Array.isArray(value.tags) && value.tags.length === 0, 'a non-array tags becomes empty')
  assert(value.attrs !== null && typeof value.attrs === 'object' && Object.keys(value.attrs).length === 0, 'a non-object attrs becomes empty')
  assert(value.description === '', 'null becomes an empty string')
})

check('sanitizeByFields falls back to the draft name rather than an empty one', () => {
  const fromBase = prompt.sanitizeByFields({}, { id: 'item-1', name: '我起的名字' }, itemGenerator)
  assert(fromBase.name === '我起的名字', `the author's own name must win over a blank: ${fromBase.name}`)
  const fromNothing = prompt.sanitizeByFields({}, {}, itemGenerator)
  assert(fromNothing.name === '未命名物品', `a generic placeholder is the last resort: ${fromNothing.name}`)
})

check('sanitizeByFields keeps what the author already wrote when the model omits a field', () => {
  // ASKED FOR: the model path must not be a second writer that quietly empties the draft.
  //
  // A model routinely answers with only SOME of the declared keys — it is prose, not a form. Every other
  // field still has to come back exactly as the author wrote it. The old guard fed a base holding only
  // `id`/`name` and asserted only `name`, which is the single field with its own fallback, so all of the
  // wiping below happened with the guard green. The base must therefore be FULLY populated: an omitted key
  // and an empty key are different things, and only the second is the model saying "blank it".
  const draft = {
    id: 'item-1',
    name: '我起的名字',
    rarity: '三阶',
    description: '我亲手写的描述',
    history: '我亲手写的来历',
    attrs: { 材质: '寒铁' },
    tags: ['本命', '伏笔'],
  }
  const kept = prompt.sanitizeByFields({}, draft, itemGenerator)
  for (const key of ['rarity', 'description', 'history']) {
    assert(kept[key] === draft[key], `${key} must survive a generation that omitted it: ${JSON.stringify(kept[key])}`)
  }
  assert(JSON.stringify(kept.attrs) === JSON.stringify(draft.attrs), `attrs must survive: ${JSON.stringify(kept.attrs)}`)
  assert(JSON.stringify(kept.tags) === JSON.stringify(draft.tags), `tags must survive: ${JSON.stringify(kept.tags)}`)
  assert(kept.id === 'item-1', `the id is never the model's to change: ${kept.id}`)
})

check('sanitizeByFields still lets the model overwrite a field it did answer', () => {
  // The other half of the rule: "omitted" and "answered with something blank" are NOT the same thing, so
  // this fix must not turn into "the model can never change anything".
  const draft = { id: 'item-1', name: '旧名', description: '旧的描述', tags: ['旧标签'] }
  const answered = prompt.sanitizeByFields({ description: '模型写的新描述' }, draft, itemGenerator)
  assert(answered.description === '模型写的新描述', `an answered field is replaced: ${answered.description}`)
  assert(JSON.stringify(answered.tags) === JSON.stringify(draft.tags), `an unanswered list is kept: ${JSON.stringify(answered.tags)}`)
  const blanked = prompt.sanitizeByFields({ description: null }, draft, itemGenerator)
  assert(blanked.description === '', `an explicitly blank answer still clears: ${JSON.stringify(blanked.description)}`)
})

check('sanitizeByFields digs values out of nested noise', () => {
  const value = prompt.sanitizeByFields({ attrs: { a: 1, b: null, c: { nested: true }, '  ': 'blank key' } }, {}, itemGenerator)
  assert(value.attrs.a === '1', `a number becomes text: ${JSON.stringify(value.attrs.a)}`)
  assert(value.attrs.b === undefined, 'a null entry is dropped')
  assert(typeof value.attrs.c === 'string', 'a nested object is flattened to text, not stored as an object')
  assert(Object.keys(value.attrs).includes('') === false, 'a blank key is dropped')
})

check('sanitizeByFields never reads a blank year as year zero', () => {
  // The same defect as the old `timeKey`: `Number(null)` is 0, which would place a
  // generated event at the start of history instead of leaving it undated.
  const event = prompt.sanitizeByFields(
    { title: '山崩', at: { year: 1345, month: 3, day: 2 }, spanEnd: { year: null, month: 5 } },
    {},
    prompt.GENERATORS['timeline-event'],
  )
  assert(event.at.year === 1345 && event.at.month === 3 && event.at.day === 2, `at was mangled: ${JSON.stringify(event.at)}`)
  assert(event.spanEnd === null, `a blank year means no end, not year zero: ${JSON.stringify(event.spanEnd)}`)
  const coerced = prompt.sanitizeByFields({ at: { year: '1345' } }, {}, prompt.GENERATORS['timeline-event'])
  assert(coerced.at.year === 1345, 'a numeric string is accepted')
  const junk = prompt.sanitizeByFields({ at: 'yesterday' }, {}, prompt.GENERATORS['timeline-event'])
  assert(junk.at === null, 'a non-object time becomes no time')
})

check('buildPrompt carries the hint and the project context', () => {
  const withHint = prompt.buildPrompt(itemGenerator, { hint: '一柄古剑' })
  assert(withHint.user.includes('一柄古剑'), 'the hint must reach the prompt')
  assert(withHint.system.includes('JSON'), 'the JSON-only instruction must be present')
  assert(withHint.system.includes('rarity'), 'the declared fields must be listed for the model')

  const without = prompt.buildPrompt(itemGenerator, {})
  assert(!without.user.includes('方向是'), `an empty hint must not leave a dangling instruction: ${without.user}`)

  const grounded = prompt.buildPrompt(itemGenerator, { context: '已有的物品（不要重名）：青锋剑' })
  assert(grounded.user.includes('青锋剑'), 'the project context must reach the prompt')
  assert(grounded.user.includes('不要与之冲突'), 'the context must be framed as a constraint, not a suggestion')
})

// --- project context digest -------------------------------------------------

check('buildWorldContext digests rules, names, vocabulary, and the calendar', () => {
  const docs = {
    'setting/world.json': {
      sections: [{ id: 's1', title: '灵气' }],
      rules: [
        { id: 'r1', scope: 'global', title: '灵气守恒', body: '灵气总量不变。' },
        { id: 'r2', scope: 'branch', branch: '北境', title: '寒潮', body: '冬季灵气稀薄。' },
      ],
    },
    'setting/items.json': {
      items: [
        { id: 'item-1', name: '青锋剑', rarity: '灵品' },
        { id: 'item-2', name: '马车', rarity: '凡品' },
      ],
    },
    'outline/timeline.json': { calendar: { epochLabel: '创世历', start: { year: 1 }, end: { year: 1000 } } },
  }
  const text = context.buildWorldContext(docs, prompt.GENERATORS.item)
  assert(text.includes('灵气'), 'section titles must be included')
  assert(text.includes('灵气守恒'), 'rule titles must be included')
  assert(text.includes('北境'), 'a branch-scoped rule must name its branch')
  assert(text.includes('青锋剑') && text.includes('马车'), 'existing names must be included, to avoid duplicates')
  assert(text.includes('rarity=灵品'), 'existing vocabulary must be included so wording stays consistent')
  assert(text.includes('创世历') && text.includes('1000'), 'the calendar range must be included')
})

check('buildWorldContext tolerates a project with nothing in it yet', () => {
  // A brand-new project has no world document at all; generation must still work.
  assert(context.buildWorldContext({}, prompt.GENERATORS.item) === '', 'no documents, no context')
  assert(context.buildWorldContext({ 'setting/world.json': {} }, prompt.GENERATORS.item) === '', 'empty documents, no context')
  assert(
    context.buildWorldContext({ 'setting/items.json': { items: 'not-an-array' } }, prompt.GENERATORS.item) === '',
    'a malformed collection must not throw',
  )
})

check('buildWorldContext stays bounded however large the project is', () => {
  // Bounded by construction — a capped sample of names, vocabulary, and rules —
  // not merely by the character limit. A digest that grew with the manuscript
  // would crowd out the actual instruction. The first version of this test
  // asserted truncation and failed, because the caps already held.
  const many = { items: Array.from({ length: 4000 }, (_, index) => ({ id: `i-${index}`, name: `物品${index}`, rarity: '灵品' })) }
  const text = context.buildWorldContext({ 'setting/items.json': many }, prompt.GENERATORS.item)
  assert(text.length < 1000, `expected a small digest for a huge project, got ${text.length}`)
  assert(!text.includes('物品3999'), 'only a sample of names may be included')

  // The character limit is the backstop for pathologically long documents. It has
  // to be pushed below the digest's natural size to be exercised at all.
  const manySections = {
    'setting/world.json': { sections: Array.from({ length: 500 }, (_, index) => ({ id: `s${index}`, title: `分节${index}` })) },
  }
  const natural = context.buildWorldContext(manySections, prompt.GENERATORS.item)
  assert(natural.length > 100, `expected the fixture to produce a real digest, got ${natural.length}`)
  const clipped = context.buildWorldContext(manySections, prompt.GENERATORS.item, { limit: 100 })
  assert(clipped.length <= 101, `the character budget must hold: ${clipped.length}`)
  assert(clipped.endsWith('…'), 'a truncated digest must show that it was truncated')
})

// --- chapter drafting context ------------------------------------------------

const draftDocs = {
  'setting/characters.json': {
    characters: [
      { id: 'char-linyuan', name: '林渊', gender: '男', race: '人类', ageNote: '外观二十出头', status: 'alive', personality: '沉默', background: '北境遗孤。' },
      { id: 'char-shenyi', name: '沈逸', gender: '女', race: '人类', personality: '锋利' },
    ],
  },
  'setting/places.json': {
    places: [
      { id: 'place-guang', name: '寒鸦关', kind: '关隘', summary: '北境门户。' },
      { id: 'place-far', name: '南都城', kind: '城池', summary: '南方首府。' },
    ],
  },
  'setting/world.json': {
    rules: [
      { id: 'rule-001', scope: 'global', title: '灵气守恒', body: '灵气只能转移。' },
      { id: 'rule-014', scope: 'branch', branch: '寒鸦关', title: '北境无灵', body: '寒潮期间法术失效。' },
      { id: 'rule-020', scope: 'branch', branch: '南都城', title: '南都禁武', body: '城内不得动武。' },
    ],
  },
  'outline/outline.json': {
    nodes: [{ id: 'out-ch1', title: '夜访', summary: '林渊夜入寒鸦关。' }],
  },
}

const draftChapter = {
  id: 'ch-0002',
  title: '第二章 山门',
  summary: '林渊在荒废山门遇到先到之人。',
  characters: ['char-linyuan', 'char-shenyi'],
  places: ['place-guang'],
  outlineRef: 'out-ch1',
}

check('buildChapterContext gathers cast, place, beat, and rules', () => {
  const text = chapterContext.buildChapterContext(draftDocs, draftChapter, {})
  assert(text.includes('第二章 山门'), 'the chapter title must be present')
  assert(text.includes('林渊') && text.includes('沈逸'), 'the cast must be present')
  assert(text.includes('北境遗孤'), 'a character background must be carried, or the model writes a stranger')
  assert(text.includes('寒鸦关') && text.includes('北境门户'), 'the place must be present')
  assert(text.includes('夜访'), 'the outline beat this chapter delivers must be present')
  assert(text.includes('灵气守恒'), 'global rules always apply')
})

check('buildChapterContext applies only the branch rules in scope', () => {
  // A rule about a city nobody is in is noise, and noise in the digest costs the
  // author tokens on every draft.
  const text = chapterContext.buildChapterContext(draftDocs, draftChapter, {})
  assert(text.includes('北境无灵'), 'the rule for the place in this chapter must be included')
  assert(!text.includes('南都禁武'), 'a rule for an absent place must NOT be included')
})

check('buildChapterContext carries continuity from both directions', () => {
  const text = chapterContext.buildChapterContext(draftDocs, draftChapter, {
    previousTail: '他推开门，雪灌了进来。',
    currentTail: '他站在石阶的第三级上。',
  })
  assert(text.includes('他推开门'), 'the previous chapter ending must be present, for voice and situation')
  assert(text.includes('石阶的第三级'), 'where this chapter left off must be present')
})

check('buildChapterContext tolerates a bare chapter and an empty project', () => {
  // A brand-new chapter in a brand-new project: nothing to gather, and that must be
  // a short digest rather than a crash or a page of empty headings.
  assert(chapterContext.buildChapterContext({}, {}, {}) === '', 'nothing known, nothing said')
  const bare = chapterContext.buildChapterContext({}, { title: '第一章' }, {})
  assert(bare.includes('第一章'), 'a title alone is still worth saying')
  assert(!bare.includes('本章出场人物'), 'an empty cast must not produce an empty heading')
  assert(!bare.includes('必须遵守的规则'), 'no rules, no heading')
})

check('buildChapterContext stays inside its budget', () => {
  const many = {
    'setting/characters.json': {
      characters: Array.from({ length: 200 }, (_, index) => ({ id: `c-${index}`, name: `人物${index}`, background: '很长'.repeat(200) })),
    },
  }
  const chapter = { characters: Array.from({ length: 200 }, (_, index) => `c-${index}`) }
  const text = chapterContext.buildChapterContext(many, chapter, { limit: 400 })
  assert(text.length <= 401, `the digest must stay bounded, got ${text.length}`)
  assert(text.endsWith('…'), 'a truncated digest must say so')
})

check('buildDraftPrompt states the task, the style, and the story', () => {
  const prompt = chapterContext.buildDraftPrompt({
    mode: 'continue',
    instruction: '写主角走进荒废山门',
    style: '气氛诡谲',
    context: '本章：第二章',
  })
  assert(prompt.system.includes('直接输出正文'), 'the model must be told to emit prose, not commentary')
  assert(prompt.user.includes('接着'), 'the mode must be stated as a task')
  assert(prompt.user.includes('写主角走进荒废山门'), 'the author’s instruction must be present')
  assert(prompt.user.includes('气氛诡谲'), 'the style must be present')
  assert(prompt.user.includes('本章：第二章'), 'the story digest must be present')
  assert(prompt.mode === 'continue', 'the resolved mode must be reported back')
})

check('buildDraftPrompt does not send the whole chapter twice', () => {
  // 接着写 already receives the tail inside the digest; repeating the full text would
  // spend the window twice for no benefit. 重写 genuinely needs the whole thing.
  const existing = '这是已有的全部正文。'.repeat(50)
  const cont = chapterContext.buildDraftPrompt({ mode: 'continue', context: '本章：x', existing })
  assert(!cont.user.includes(existing), '接着写 must not inline the full chapter')
  const rewrite = chapterContext.buildDraftPrompt({ mode: 'rewrite', context: '本章：x', existing })
  assert(rewrite.user.includes(existing), '重写 must receive the text it is rewriting')
  assert(rewrite.user.includes('重写'), 'the rewrite instruction must be stated')
})

check('buildDraftPrompt falls back to a known mode rather than failing', () => {
  const prompt = chapterContext.buildDraftPrompt({ mode: 'nonsense', context: 'x' })
  assert(prompt.mode === 'continue', `an unknown mode should fall back, got ${prompt.mode}`)
  assert(prompt.user.includes('接着'), 'and be stated as the fallback task')
})

check('every drafting mode has a label and an instruction', () => {
  // The client renders labels; the host owns instructions. A mode without an
  // instruction would silently send the task as empty.
  const ids = chapterContext.DRAFT_MODES.map((mode) => mode.id)
  assert(ids.includes('continue') && ids.includes('expand') && ids.includes('rewrite'), `modes: ${ids.join(', ')}`)
  for (const mode of chapterContext.DRAFT_MODES) {
    assert(typeof mode.label === 'string' && mode.label !== '', `${mode.id} has no label`)
    assert(typeof mode.instruction === 'string' && mode.instruction.length > 4, `${mode.id} has no usable instruction`)
  }
})

// --- organization positions --------------------------------------------------

check('a position parent is resolved inside its own organization', () => {
  // Regression guard for a live refusal: this check compared the parent against the
  // GLOBAL entity index, where `pos-*` ids never appear, so every subordinate
  // position was reported as dangling and the write was rejected.
  const docs = {
    'setting/organizations.json': {
      organizations: [
        {
          id: 'org-qingyun',
          name: '青云宗',
          parentId: null,
          structure: [
            { id: 'pos-1', title: '掌门', parentId: null },
            { id: 'pos-2', title: '执剑长老', parentId: 'pos-1' },
            { id: 'pos-3', title: '首座弟子', parentId: 'pos-2' },
          ],
        },
      ],
    },
  }
  const { issues } = validate.validateProject({ docs, chapters: [] })
  const dangling = issues.filter((issue) => issue.code === 'dangling-reference')
  assert(dangling.length === 0, `a valid position tree must not be flagged: ${JSON.stringify(dangling)}`)
})

check('a position parent pointing outside its organization is still caught', () => {
  // Scoping the check must not weaken it: a parent that is not in this organization
  // is a real error, whether it is missing entirely or belongs to another one.
  const docs = {
    'setting/organizations.json': {
      organizations: [
        {
          id: 'org-a',
          name: '甲宗',
          parentId: null,
          structure: [{ id: 'pos-a1', title: '掌门', parentId: 'pos-b1' }],
        },
        {
          id: 'org-b',
          name: '乙宗',
          parentId: null,
          structure: [{ id: 'pos-b1', title: '掌门', parentId: null }],
        },
      ],
    },
  }
  const { issues } = validate.validateProject({ docs, chapters: [] })
  const dangling = issues.filter((issue) => issue.code === 'dangling-reference')
  assert(dangling.length === 1, `a cross-organization parent must be caught: ${JSON.stringify(issues)}`)
  assert(String(dangling[0].message).includes('pos-b1'), `the message must name the bad parent: ${dangling[0].message}`)

  const missing = {
    'setting/organizations.json': {
      organizations: [{ id: 'org-a', name: '甲宗', parentId: null, structure: [{ id: 'pos-a1', title: 'x', parentId: 'pos-nope' }] }],
    },
  }
  const result = validate.validateProject({ docs: missing, chapters: [] })
  assert(
    result.issues.some((issue) => issue.code === 'dangling-reference'),
    'a wholly missing parent must still be caught',
  )
})

check('a position parent of the wrong type is reported as such', () => {
  const docs = {
    'setting/organizations.json': {
      organizations: [{ id: 'org-a', name: '甲宗', parentId: null, structure: [{ id: 'pos-a1', title: 'x', parentId: 42 }] }],
    },
  }
  const { issues } = validate.validateProject({ docs, chapters: [] })
  assert(
    issues.some((issue) => issue.code === 'bad-reference'),
    `a non-string parent must be a bad-reference: ${JSON.stringify(issues.map((i) => i.code))}`,
  )
})

check('a junction inside the root cannot be used to escape it', () => {
  // The audit proved the lexical checks are blind to this: a link inside the project
  // resolves elsewhere, and `relative()` on the STRING is perfectly happy. A junction
  // needs no elevation on Windows, so this is the realistic attack, not a theoretical one.
  const outside = mkdtempSync(join(tmpdir(), 'dsh-novel-outside-'))
  const root = mkdtempSync(join(tmpdir(), 'dsh-novel-root-'))
  const link = join(root, 'escape')
  try {
    writeFileSync(join(outside, 'secret.json'), '{"secret":true}', 'utf8')
    let linked = false
    try {
      symlinkSync(outside, link, 'junction')
      linked = true
    } catch {
      /* link creation unavailable in this environment; the assertion below is skipped */
    }
    if (linked) {
      // Reading through the link must be refused...
      assertThrows(
        () => paths.resolveInside(root, 'escape/secret.json'),
        'path-link-escape',
        'a read through a junction must be refused',
      )
      // ...and so must writing one level deeper, including a file that does not exist yet.
      assertThrows(
        () => paths.resolveInside(root, 'escape/new.json'),
        'path-link-escape',
        'a write through a junction must be refused',
      )
      // The link itself is refused rather than replaced.
      assertThrows(() => paths.resolveInside(root, 'escape'), 'path-link-escape', 'the link itself must be refused')
    }
    // A normal path in the same root still works, so the check is not blanket.
    const ok = paths.resolveInside(root, 'novel/setting/items.json')
    assert(ok.rel === 'novel/setting/items.json', 'an ordinary path must still resolve')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

check('a rule-based tool check cannot see links, only the physical check can', () => {
  // Guards the reasoning above: without the physical check, the lexical result for a
  // junction path is INSIDE the root, which is what made this invisible.
  const root = mkdtempSync(join(tmpdir(), 'dsh-novel-lexical-'))
  try {
    const { abs } = paths.resolveInside(root, 'novel/setting/items.json')
    const rel = relative(root, abs)
    assert(!rel.startsWith('..'), 'the lexical check passes for this path, as it does for a junction path')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- write-time backup -------------------------------------------------------

check('a write keeps the previous version as .prev', () => {
  // Insurance against the class of loss this audit actually produced: an overwrite
  // becomes recoverable for one generation instead of being permanent.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-novel-backup-'))
  const target = join(dir, 'items.json')
  try {
    store.writeTextAtomic(target, '{"v":1}')
    assert(!existsSync(`${target}.prev`), 'a first write has no previous version to keep')
    store.writeTextAtomic(target, '{"v":2}')
    assert(existsSync(`${target}.prev`), 'the second write must keep the previous content')
    assert(readFileSync(`${target}.prev`, 'utf8') === '{"v":1}', 'the backup must hold the PREVIOUS content')
    assert(readFileSync(target, 'utf8') === '{"v":2}', 'the target must hold the new content')
    // A third write replaces the backup rather than accumulating files.
    store.writeTextAtomic(target, '{"v":3}')
    assert(readFileSync(`${target}.prev`, 'utf8') === '{"v":2}', 'only one generation is kept')
    const backups = readdirSync(dir).filter((name) => name.endsWith('.prev'))
    assert(backups.length === 1, `exactly one backup file is expected, found ${backups.join(', ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a backup file can never be mistaken for content', () => {
  // `.prev` is not `.md`, so a chapter listing cannot pick it up, and it is not in
  // FILES, so no document write can address it.
  const documented = Object.values(schema.FILES)
  assert(!documented.some((name) => name.endsWith('.prev')), 'no document path ends in .prev')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-novel-backup-chapters-'))
  try {
    const chaptersDir = join(dir, 'draft')
    mkdirSync(chaptersDir, { recursive: true })
    store.writeTextAtomic(join(chaptersDir, 'ch-0001.md'), 'first')
    store.writeTextAtomic(join(chaptersDir, 'ch-0001.md'), 'second')
    const listed = readdirSync(chaptersDir)
    assert(listed.includes('ch-0001.md.prev'), 'the backup should exist for this assertion to mean anything')
    // The chapter reader filters on `.md`; a `.prev` must not appear among chapters.
    const chapters = listed.filter((name) => name.toLowerCase().endsWith('.md'))
    assert(chapters.length === 1, `only real chapters may be listed, got ${chapters.join(', ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- the checks added by the audit ------------------------------------------

const codesOf = (docs, chapters = []) => validate.validateProject({ docs, chapters }).issues.map((issue) => issue.code)

check('an entity with no id is reported, not skipped', () => {
  // `register` used to return false in silence. Because registration is what makes
  // references resolve, skipping it made every legitimate reference to that entity
  // report as dangling — pointing the author at the wrong file entirely.
  const codes = codesOf({ 'setting/characters.json': { characters: [{ name: '无名氏' }] } })
  assert(codes.includes('missing-id'), `expected missing-id, got ${codes.join(', ')}`)
  const bad = codesOf({ 'setting/characters.json': { characters: [{ id: 42, name: 'x' }] } })
  assert(bad.includes('bad-id'), `expected bad-id for a numeric id, got ${bad.join(', ')}`)
})

check('a world section or rule with a duplicate id is caught', () => {
  // §4.2 promises a rule can be cited unambiguously; a duplicate id breaks that, and
  // nothing checked world.json's contents at all.
  const codes = codesOf({
    'setting/world.json': {
      sections: [{ id: 'sec-1', title: '甲' }],
      rules: [{ id: 'rule-1', title: '一', scope: 'global' }, { id: 'rule-1', title: '二', scope: 'global' }],
    },
  })
  assert(codes.includes('duplicate-id'), `expected duplicate-id, got ${codes.join(', ')}`)
  // A world id colliding with a character id is a collision too.
  const cross = codesOf({
    'setting/world.json': { sections: [{ id: 'char-a', title: '甲' }], rules: [] },
    'setting/characters.json': { characters: [{ id: 'char-a', name: '林渊' }] },
  })
  assert(cross.includes('duplicate-id'), `a cross-file collision must be caught, got ${cross.join(', ')}`)
})

check('duplicate edge and relation-type ids are caught', () => {
  const base = { 'setting/characters.json': { characters: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] } }
  const dupEdge = codesOf({
    ...base,
    'relations.json': {
      types: [{ id: 'ally', label: '同盟' }],
      edges: [
        { id: 'rel-1', from: 'a', to: 'b', type: 'ally', since: { year: 1 } },
        { id: 'rel-1', from: 'b', to: 'a', type: 'ally', since: { year: 5 } },
      ],
    },
  })
  assert(dupEdge.includes('duplicate-id'), `expected a duplicate edge id, got ${dupEdge.join(', ')}`)
  const dupType = codesOf({
    ...base,
    'relations.json': { types: [{ id: 'ally', label: '同盟' }, { id: 'ally', label: '敌对', directed: false }], edges: [] },
  })
  assert(dupType.includes('duplicate-id'), `expected a duplicate type id, got ${dupType.join(', ')}`)
})

check('a self-relation is caught', () => {
  // One mis-click away, and the layout drops zero-length links: the edge is counted in
  // the total but drawn as a type label sitting on top of the node.
  const codes = codesOf({
    'setting/characters.json': { characters: [{ id: 'a', name: '甲' }] },
    'relations.json': { types: [{ id: 'ally', label: '同盟' }], edges: [{ id: 'rel-1', from: 'a', to: 'a', type: 'ally', since: { year: 1 } }] },
  })
  assert(codes.includes('self-relation'), `expected self-relation, got ${codes.join(', ')}`)
})

check('a relation causeEventId is checked like the event one', () => {
  // The identically-named field on an edge was checked while the event's was not, and
  // the form presented the event's as a raw text box.
  const codes = codesOf({
    'outline/timeline.json': { lines: [{ id: 'tl-1', name: '线', kind: 'main' }], events: [{ id: 'evt-1', title: '事件', lineId: 'tl-1', at: { year: 1 }, causeEventId: 'evt-NOPE' }] },
  })
  assert(codes.includes('dangling-reference'), `expected dangling-reference, got ${codes.join(', ')}`)
  const good = codesOf({
    'outline/timeline.json': {
      lines: [{ id: 'tl-1', name: '线', kind: 'main' }],
      events: [{ id: 'evt-1', title: '甲', lineId: 'tl-1', at: { year: 1 } }, { id: 'evt-2', title: '乙', lineId: 'tl-1', at: { year: 2 }, causeEventId: 'evt-1' }],
    },
  })
  assert(!good.includes('dangling-reference'), `a valid chain must pass, got ${good.join(', ')}`)
})

check('enum values are checked', () => {
  // No enum check existed anywhere, so a generated 「男性（外表）」 persisted while the
  // select showed nothing selected.
  const cases = [
    ['setting/characters.json', { characters: [{ id: 'c', name: 'x', gender: '男性' }] }, 'character.gender'],
    ['setting/characters.json', { characters: [{ id: 'c', name: 'x', status: 'zombie' }] }, 'character.status'],
    ['setting/organizations.json', { organizations: [{ id: 'o', name: 'x', status: 'gone' }] }, 'organization.status'],
    ['setting/items.json', {}, undefined],
  ]
  for (const [path, doc, label] of cases.slice(0, 3)) {
    const codes = codesOf({ [path]: doc })
    assert(codes.includes('bad-enum'), `${label} must be caught, got ${codes.join(', ')}`)
  }
  // The declared values themselves must pass.
  const ok = codesOf({
    'setting/characters.json': { characters: [{ id: 'c', name: 'x', gender: '女', status: 'alive' }] },
    'setting/organizations.json': { organizations: [{ id: 'o', name: 'x', status: 'dissolved' }] },
    'outline/timeline.json': { lines: [{ id: 'l', name: 'x', kind: 'branch' }], events: [] },
    'outline/outline.json': { nodes: [{ id: 'n', title: 'x', kind: 'beat' }] },
    'setting/world.json': { sections: [], rules: [{ id: 'r', title: 'x', scope: 'branch' }] },
  })
  assert(!ok.includes('bad-enum'), `valid enum values must pass, got ${ok.join(', ')}`)
})

check('organization.founded is checked as a time', () => {
  const codes = codesOf({ 'setting/organizations.json': { organizations: [{ id: 'o', name: 'x', founded: { year: null } }] } })
  assert(codes.includes('bad-time'), `expected bad-time, got ${codes.join(', ')}`)
})

check('blank custom keys are caught on every entity type that can gain one', () => {
  // CustomSection renders unconditionally, so any entity edited through the form gains a
  // `custom` bag — but only some entity types were scanned for the invisible blank row.
  for (const [path, doc, label] of [
    ['outline/outline.json', { nodes: [{ id: 'n', title: 'x', custom: { '': '' } }] }, 'outline-node'],
    ['outline/timeline.json', { lines: [{ id: 'l', name: 'x', custom: { '': 'v' } }] }, 'timeline-line'],
    ['outline/timeline.json', { events: [{ id: 'e', title: 'x', at: { year: 1 }, custom: { '': '' } }] }, 'timeline-event'],
    ['setting/world.json', { sections: [{ id: 's', title: 'x', custom: { '': '' } }] }, 'world-section'],
    ['setting/world.json', { rules: [{ id: 'r', title: 'x', custom: { '': '' } }] }, 'world-rule'],
  ]) {
    const codes = codesOf({ [path]: doc })
    assert(codes.includes('blank-map-key'), `${label} must be caught, got ${codes.join(', ')}`)
  }
})

check('an event outside the calendar is reported, but a partial time is not', () => {
  // The first version of this check compared the encoded keys directly, so `{year: 1}` — a
  // time that means "sometime in year 1" — was reported as before a calendar beginning
  // 元年1月1日, because a missing month encodes as 0. A false positive here tells the author to
  // widen a calendar that is already correct, so the check must only fire when it is certain.
  const { certainlyOutside } = validate
  const start = { year: 1, month: 1, day: 1 }
  const end = { year: 1000, month: 12, day: 31 }

  // Certain cases.
  assert(certainlyOutside({ year: 1234 }, start, end) === true, 'a year past the end is outside')
  assert(certainlyOutside({ year: 0 }, start, end) === true, 'a year before the start is outside')
  assert(certainlyOutside({ year: 1000, month: 12, day: 31 }, start, end) === false, 'the exact end is inside')
  assert(certainlyOutside({ year: 1, month: 1, day: 1 }, start, end) === false, 'the exact start is inside')

  // The regression: a partial time spans what it leaves out.
  assert(certainlyOutside({ year: 1 }, start, end) === false, 'year 1 alone is not before 元年1月1日')
  assert(certainlyOutside({ year: 1000 }, start, end) === false, 'year 1000 alone is not after 1000年12月31日')
  assert(certainlyOutside({ year: 1, month: 6 }, start, end) === false, 'a year-1 month is certainly inside')

  // A same-year comparison only fires when both sides specify the month.
  assert(certainlyOutside({ year: 1, month: 0 }, start, end) === false, 'an absent month is not a month')
  assert(certainlyOutside({ year: 1000, month: 12 }, start, end) === false, 'month 12 is the last month')

  // Degenerate inputs must not produce a warning.
  assert(certainlyOutside(null, start, end) === false, 'no time, no claim')
  assert(certainlyOutside({ year: 5 }, null, end) === false, 'no calendar start, no claim')
  assert(certainlyOutside({ year: 5 }, start, null) === false, 'no calendar end, no claim')
  assert(certainlyOutside({ year: null }, start, end) === false, 'an unusable year makes no claim')
  assert(certainlyOutside({}, start, end) === false, 'an empty time makes no claim')
})

check('the calendar range is included in the validator report', () => {
  // The end-to-end shape: an event beyond the declared range shows up as a warning, which is
  // what makes the gap visible in the GUI rather than only on the timeline's axis.
  const docs = {
    'outline/timeline.json': {
      calendar: { epochLabel: '元年', start: { year: 1, month: 1, day: 1 }, end: { year: 1000, month: 12, day: 31 } },
      lines: [{ id: 'tl-1', name: '主线', kind: 'main' }],
      events: [
        { id: 'evt-in', title: '在范围内', lineId: 'tl-1', at: { year: 500 } },
        { id: 'evt-out', title: '超出范围', lineId: 'tl-1', at: { year: 1234 } },
      ],
    },
  }
  const { issues } = validate.validateProject({ docs, chapters: [] })
  const flagged = issues.filter((issue) => issue.code === 'event-outside-calendar')
  assert(flagged.length === 1, `exactly one event is outside the range, got ${flagged.length}`)
  assert(flagged[0].level === 'warning', 'it must be a warning, not a blocking error')
  assert(flagged[0].ids.includes('evt-out'), `the wrong event was flagged: ${JSON.stringify(flagged[0].ids)}`)
})

check('the style archive status is constrained to the two real values', () => {
  // `novel-writer` branches on this: `proposed` means "treat as a reference", `confirmed`
  // means "treat as a hard constraint". A third value would make it guess.
  const withStatus = (status) =>
    codesOf({
      'project.json': { settings: { wordCountGoal: 0, style: status === undefined ? { pov: '第三人称' } : { status, pov: '第三人称' } } },
    })
  assert(!withStatus('proposed').includes('bad-enum'), 'proposed must be accepted')
  assert(!withStatus('confirmed').includes('bad-enum'), 'confirmed must be accepted')
  // Absent is legitimate: an archive written before the field existed.
  assert(!withStatus(undefined).includes('bad-enum'), 'a missing status must be tolerated')
  assert(!withStatus('').includes('bad-enum'), 'an empty status is treated as absent')
  assert(withStatus('draft').includes('bad-enum'), 'an invented status must be reported')
  assert(withStatus(42).includes('bad-enum'), 'a non-string status must be reported')
})

check('every batch wrapper keeps CRLF line endings', () => {
  // cmd.exe mangles a .cmd file with bare LF endings: continuation and label lines get executed
  // as commands ("'m' is not recognized as an internal or external command"), and the failure
  // looks nothing like its cause. The file is easy to rewrite by accident, so assert it.
  //
  // EVERY .cmd, not just run.cmd: the rule is about cmd.exe, and a second wrapper would have been
  // written the same wrong way by default. Its own failure mode is silent, which is the worst kind.
  const batches = readdirSync(join(ROOT, 'tools')).filter((name) => name.endsWith('.cmd'))
  assert(batches.length > 0, 'there is at least one batch wrapper')
  for (const name of batches) {
    const batch = readFileSync(join(ROOT, 'tools', name))
    let bareLineFeeds = 0
    for (let i = 0; i < batch.length; i += 1) {
      if (batch[i] === 10 && batch[i - 1] !== 13) bareLineFeeds += 1
    }
    assert(bareLineFeeds === 0, `${name} has ${bareLineFeeds} bare LF line ending(s); cmd.exe needs CRLF`)
    assert(batch.length > 0, `${name} is empty`)
  }
  const run = readFileSync(join(ROOT, 'tools', 'run.cmd')).toString('utf8')
  // `%*` is deliberately not used: `shift` renumbers %1..%9 but leaves %* holding the ORIGINAL arguments,
  // so `%*` re-passes the script name.
  assert(run.includes('%1 %2'), 'run.cmd must forward the arguments after the script name')
  // COMMENTS ARE STRIPPED FIRST. The file explains at length why `%*` is not used, and reading that
  // explanation as code is a mistake this project has now made twice.
  const runCode = run
    .split(/\r?\n/)
    .filter((line) => !/^\s*(rem|@rem)\b/i.test(line))
    .join('\n')
  assert(!/%\*/.test(runCode), 'run.cmd must not use %* in a statement')
  // The second wrapper delegates node discovery to the first rather than repeating it, so a fix to one
  // cannot miss the other.
  const apply = readFileSync(join(ROOT, 'tools', 'apply-host-patch.cmd')).toString('utf8')
  assert(/call "%~dp0run\.cmd" wait-and-patch\.mjs %1 %2/.test(apply), 'apply-host-patch.cmd delegates to run.cmd')
  assert(!/where node|dsh-runtimes/.test(apply), 'and does not repeat the node discovery')
})

check('the live check refuses to run against a real project', () => {
  // It creates a project and writes chapters, and it takes a root argument, so pointing it at the
  // repository is an easy mistake that would write into the author's own novel/. The guard must
  // be present, because without it the run only stopped by luck.
  const source = readFileSync(join(ROOT, 'tools', 'live-check.mjs'), 'utf8')
  assert(source.includes("'project.json'"), 'live-check.mjs must detect an existing project')
  assert(/refusing to run/.test(source), 'live-check.mjs must refuse rather than warn')
})

// --- atomic write ----------------------------------------------------------
check('atomic write creates the file and leaves no temp files behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-novel-selftest-'))
  try {
    const target = join(dir, 'nested', 'doc.json')
    store.writeJsonAtomic(target, { hello: '世界' })
    const back = store.readJson(target)
    assert(back.hello === '世界', 'round trip lost content')
    const leftovers = store.listTree(dir, 3).entries.filter((e) => e.path.includes('.tmp-'))
    assert(leftovers.length === 0, `temp files left behind: ${JSON.stringify(leftovers)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('atomic write replaces existing content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-novel-selftest-'))
  try {
    const target = join(dir, 'doc.json')
    store.writeJsonAtomic(target, { n: 1 })
    store.writeJsonAtomic(target, { n: 2 })
    assert(store.readJson(target).n === 2, 'second write did not win')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('the manuscript is assembled in narrative order, and nothing is dropped silently', () => {
  // PHASE 6, and the end of the writing loop: a novel has to become a file the author can send someone.
  // The assembler is pure, so the exact bytes of a finished book are assertable here — including the parts
  // that are easy to get subtly wrong.
  const chapters = [
    { path: 'draft/ch-0002.md', meta: { id: 'ch-0002', title: '', order: 2 }, body: '第二章。' },
    { path: 'draft/ch-0001.md', meta: { id: 'ch-0001', title: '第一章 山门', order: 1 }, body: '第一章。' },
    { path: 'draft/ch-0003.md', meta: { error: 'EACCES' }, body: '', unreadable: true },
  ]
  const built = manuscript.buildManuscript({ chapters, projectTitle: '青云记' })
  // NARRATIVE ORDER, not directory order: the input is deliberately shuffled.
  const first = built.text.indexOf('第一章 山门')
  const second = built.text.indexOf('ch-0002')
  assert(first !== -1 && second !== -1 && first < second, 'chapters come out in `order`, not in file order')
  assert(built.text.startsWith('# 青云记'), 'the title page leads')
  assert(built.text.includes('## 第一章 山门'), 'each chapter is a heading')
  // A BLANK TITLE FALLS BACK TO THE ID, which is what the chapter list shows — not to an invented 「第 N 章」,
  // which would contradict a book whose numbering lives in its titles.
  assert(built.text.includes('## ch-0002'), 'a blank title falls back to the id')
  // AN UNREADABLE CHAPTER IS REPORTED, NOT OMITTED QUIETLY. A manuscript missing chapter twelve, sent
  // before anyone notices, is worse than one that refuses to export.
  assert(built.skipped.length === 1 && built.skipped[0].path === 'draft/ch-0003.md', 'the unreadable chapter is named')
  assert(built.skipped[0].reason === 'unreadable' && built.skipped[0].detail === 'EACCES', 'with why')
  assert(!built.text.includes('ch-0003'), 'and it is not in the text')
  assert(built.chapterCount === 2, 'the count is what was included')
  assert(built.wordCount === manuscript.buildManuscript({ chapters, projectTitle: '青云记' }).included.reduce((sum, c) => sum + c.words, 0), 'and the length agrees with the per-chapter counts')
  // THE WORD COUNT IS THE SAME FUNCTION the editor uses, or the author sees two lengths for one book.
  assert(built.included[0].words === text.countWords('第一章。'), 'words come from lib/impl/text.js')
  assert(built.wordCount === text.countWords('第一章。') + text.countWords('第二章。'), 'and add up')

  // OPTIONS CHANGE THE TEXT, and nothing else does.
  const plain = manuscript.buildManuscript({ chapters, projectTitle: '书', options: { titlePage: false } })
  assert(!plain.text.includes('# 书'), 'the title page can be left off')
  assert(plain.text.startsWith('## '), 'and the book then starts at chapter one')
  const one = manuscript.buildManuscript({ chapters, projectTitle: '书', options: { headingLevel: 1 } })
  assert(one.text.includes('\n# 第一章 山门'), 'the heading level is configurable')
  const summarised = manuscript.buildManuscript({
    chapters: [{ path: 'a.md', meta: { title: '一', order: 1, summary: '梗概', status: 'draft', characters: ['char-a'] }, body: '正文' }],
    projectTitle: '书',
    options: { summary: true, meta: true },
  })
  assert(summarised.text.includes('> 梗概'), 'summaries can be included')
  assert(summarised.text.includes('状态：draft') && summarised.text.includes('人物：char-a'), 'so can the metadata')
  const bare = manuscript.buildManuscript({ chapters: [{ path: 'a.md', meta: { title: '一', order: 1, summary: '梗概' }, body: '正文' }], projectTitle: '书' })
  assert(!bare.text.includes('梗概'), 'and both are off by default')

  // THE EDGES, where an export stops being a file someone can read.
  assert(manuscript.buildManuscript({}).text === '# 未命名\n', 'no chapters still yields a readable cover')
  assert(manuscript.buildManuscript({ chapters: [], projectTitle: '  ' }).text.startsWith('# 未命名'), 'a whitespace title is treated as blank')
  const empty = manuscript.buildManuscript({ chapters: [{ path: 'a.md', meta: { title: '空章', order: 1 }, body: '   ' }], projectTitle: '书' })
  // AN EMPTY CHAPTER IS KEPT. Dropping it renumbers the book in the reader's hands and hides the gap.
  assert(empty.text.includes('## 空章') && empty.chapterCount === 1, 'an empty chapter is kept, not dropped')
  assert(empty.included[0].empty === true, 'and flagged as empty so the UI can say so')
  // Every chapter missing an `order` must still come out in a deterministic order, or two exports of an
  // unchanged project differ.
  const unordered = manuscript.buildManuscript({
    chapters: [{ path: 'draft/ch-0002.md', meta: { title: 'b' }, body: 'b' }, { path: 'draft/ch-0001.md', meta: { title: 'a' }, body: 'a' }],
    projectTitle: '书',
  })
  assert(unordered.text.indexOf('a') < unordered.text.indexOf('b'), 'a missing order falls back to the path, deterministically')
  assert(manuscript.buildManuscript({ chapters: null }).text === '# 未命名\n', 'junk chapters are empty, not a throw')
  for (const junk of [null, undefined, 'x', 42]) {
    assert(typeof manuscript.buildManuscript(junk).text === 'string', `junk input yields text: ${JSON.stringify(junk)}`)
  }
  // The file name, sanitised the way the map export sanitises its own.
  assert(manuscript.manuscriptName('青云记') === '青云记.md', 'the name comes from the title')
  assert(!/[\\/:*?"<>|]/.test(manuscript.manuscriptName('a/b:c*d?e"f<g>h|i')), 'and can never contain a path separator')
  assert(manuscript.manuscriptName('') === 'manuscript.md', 'a blank title still yields a name')
  assert(manuscript.manuscriptName(null) === 'manuscript.md', 'and so does a missing one')
  assert(manuscript.manuscriptName('书', 'txt') === '书.txt', 'the extension is a parameter')
  assert(manuscript.manuscriptName('书', 'exe') === '书.exe', 'and is passed through when it is a plain token')
})

check('the agent is driven by the session resolver and followup, not by the patched prompt', () => {
  // WHY THIS SHAPE. `sessionController.prompt(request, signal)` dereferences its second parameter
  // before any null check — `signal?.throwIfAborted()` — and that parameter exists only because the
  // RPC layer declares it as a framework cancellation argument. Calling it in-process with one
  // argument threw `Cannot read properties of undefined`, and the only way through was
  // `tools/patch-asar.mjs`, a patch to the INSTALLED application. That is fine on this machine and
  // impossible to ship.
  //
  // `resolveAgent(sessionId)` is the host's own resolver — the first thing `prompt` itself calls —
  // and the returned agent's `followup(message)` is the documented way to drive a conversation. So
  // the plugin never touches the patched method, and no host patch is required to ship it.
  //
  // Asserted against the source, because the call needs a live sessionController and what must not
  // regress is the SHAPE of the call.
  const source = readFileSync(join(ROOT, 'lib', 'impl', 'router.js'), 'utf8')
  assert(/await controller\.resolveAgent\(sessionId\)/.test(source), 'the agent must be resolved through the session controller')
  assert(/agent\.followup\(\{/.test(source), 'and driven by followup')
  assert(/id: randomUUID\(\)/.test(source), 'each message carries its own id — that is what identifies it in the log')
  assert(/source: \{ kind: 'user' \}/.test(source), 'and its own `source`, which followup takes directly')
  // THE WHOLE POINT: the patched method is not called at all.
  assert(
    !/controller\.prompt\(/.test(source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'the patched sessionController.prompt must not be called anywhere',
  )
  // `followup` returns nothing, so there is no receipt to keep and no RPC id to mint.
  assert(!/promptReceipts/.test(source), 'the old prompt receipt map is gone with the call that produced it')
  assert(!/promptRpcId/.test(source), 'and so is the RPC id helper')
  // A host whose agent cannot be driven must say so plainly instead of failing obscurely.
  assert(/agent-followup-missing/.test(source), 'a missing followup is reported as its own condition')
  // `inspect` answers `{ meta, inheritedEventCount, events }` when the session is ATTACHED and a different shape
  // when it is not — so the result route reports which one came back instead of leaving an empty transcript a
  // mystery. This is the same two-shapes-one-name trap as `body.items` vs `body.sessions`.
  assert(/stateKeys: state === null \|\| typeof state !== 'object' \? \[\] : Object\.keys\(state\)/.test(source), 'the result route reports the shape inspect returned')
  assert(/totalEvents: Array\.isArray\(state\?\.events\) \? state\.events\.length : null/.test(source), 'and how many events it saw before filtering')
})

check('the package manifest promises only files that exist', () => {
  // PHASE 6's last piece. `tools/package-plugin.mjs` checks this at package time, but that only runs when
  // someone packages; this runs with everything else, so renaming a host module cannot quietly leave
  // `package.json` pointing at nothing.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  // THE NAME AND THE PATCH MUST AGREE. The patch's insert carries the module the profile
  // loads, so it has to be this package's name — resolving `dsh-novel` while the package is
  // called something else would mount nothing. (This used to assert a hardcoded name, which
  // also passed while the two files were free to drift apart.)
  const patch = yaml.load(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'))
  const inserted = Array.isArray(patch) ? patch.find((entry) => entry?.insert)?.insert?.[0] : null
  assert(inserted !== null && typeof inserted.name === 'string', 'cordis.patch.yml inserts this plugin')
  assert(
    inserted.name === pkg.name,
    `cordis.patch.yml mounts ${JSON.stringify(inserted.name)} but the package is named ${JSON.stringify(pkg.name)}`,
  )
  assert(inserted.id === 'dsh-novel', 'the plugin id stays dsh-novel — it is the route prefix and the skill namespace')
  assert(typeof pkg.version === 'string' && pkg.version !== '', 'it has a version')
  assert(pkg.type === 'module', 'the host half is ESM')
  for (const [label, value] of [['main', pkg.main], ['dsh.bundle.patch', pkg.dsh?.bundle?.patch]]) {
    assert(typeof value === 'string' && value !== '', `package.json declares ${label}`)
    assert(existsSync(join(ROOT, value)), `${label} points at ${value}, which must exist`)
  }
  assert(pkg.dsh?.client?.platform === 'web', 'the client half targets the web shell, or the host will not serve it')
  assert(existsSync(join(ROOT, 'client', 'client.js')), 'the built client bundle is present — a package without it loads no UI')
  assert(readFileSync(join(ROOT, 'client', 'client.js'), 'utf8').length > 10_000, 'and is not a stub')
  // `files` is the declarative ship list: an inferred one would sweep in tools/ and any scratch directory.
  assert(Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('client/client.js'), 'the ship list is declared')
  for (const entry of pkg.files) assert(existsSync(join(ROOT, entry)), `the declared ship entry ${entry} exists`)
  // AND THE PACKAGER MUST AGREE WITH IT. `npm publish` follows `files`; the tarball follows the
  // packager's own INCLUDED list. Nothing compared the two, so a file added to one and forgotten in
  // the other ships a package that installs and then fails to load — which is exactly what happened to
  // LICENSE and dsh.plugin.json the first time they were added.
  const packagerSource = readFileSync(join(ROOT, 'tools', 'package-plugin.mjs'), 'utf8')
  const included = packagerSource.match(/const INCLUDED = \[([^\]]*)\]/)
  assert(included !== null, 'the packager declares what it ships')
  const shipped = [...included[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  // EXACT MATCH, NO CARVE-OUT. The first version of this check exempted `docs` on the reasoning that
  // the packager narrows it to `docs/data-model.md`. That exemption is what let the two lists drift:
  // `files` still said `"docs"`, so `npm publish` shipped MAINTENANCE.md, both crash-forensics notes
  // and the host-bug history — this machine's profile paths, backup filenames and crash scenes — while
  // the tarball shipped one file. The fix is to name the file in BOTH lists and compare them literally.
  for (const entry of pkg.files) {
    assert(shipped.includes(entry), `the packager must ship ${entry}, which package.json's files lists`)
  }
  for (const entry of shipped) {
    // `package.json` is the one automatic exception: npm always includes it, so it is correctly absent
    // from `files` while the packager names it explicitly.
    if (entry === 'package.json') continue
    assert(pkg.files.includes(entry), `package.json's files must list ${entry}, which the packager ships`)
    assert(existsSync(join(ROOT, entry)), `the packager ships ${entry}, which must exist`)
  }
  // AND THE MACHINE-SPECIFIC NOTES MUST NOT SHIP. They are forensics about THIS installation, not
  // documentation for a user, and `"docs"` as a directory would sweep them in.
  for (const privateNote of ['docs/MAINTENANCE.md', 'docs/2026-10-16-启动故障复核.md', 'docs/2026-10-16-安装崩溃-三重身份.md', 'docs/host-bug-session-controller-prompt.md']) {
    assert(
      !pkg.files.includes(privateNote) && !shipped.includes(privateNote),
      `${privateNote} documents this machine and must not be distributed`,
    )
  }
  // The packager itself must be there, and must not package a red tree.
  const packager = readFileSync(join(ROOT, 'tools', 'package-plugin.mjs'), 'utf8')
  assert(/spawnSync\(process\.execPath/.test(packager), 'the packager runs the suites as children')
  assert(!/await import\(pathToFileURL\(join\(ROOT, 'tools', suite\)\)/.test(packager), 'and does NOT import them, which would exit on their process.exit')
  assert(/refusing to package a red tree/.test(packager), 'and refuses to package a failing build')

  // AND NO GENERATED ARTIFACT MAY BE TRACKED. `.gitignore` only stops UNTRACKED files from being
  // added; once something is committed it stays committed, and nothing was checking that. So
  // `dsh-novelsupport-0.1.0.tgz` and seventeen of the plugin's own backups under `novel/` shipped to
  // GitHub with a healthy green test suite — the rules were in `.gitignore` the whole time and simply
  // did not apply. This asserts against the INDEX (`git ls-files`), which is what a push carries.
  //
  // NO `try`/`catch` AROUND THE ASSERTIONS. `spawnSync` does not throw — it returns `{ error }` — so a
  // catch here could only ever swallow the assertions' own throws, which is exactly what the first
  // version of this guard did: it saw the tracked tarball, threw, caught itself, and reported PASS.
  // Git being absent is handled by inspecting `error` instead.
  const listed = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  if (listed.error === undefined && listed.status === 0 && typeof listed.stdout === 'string') {
    const tracked = listed.stdout.split('\n').filter((line) => line !== '')
    const junk = tracked.filter((path) => /\.tgz$/.test(path) || /\.prev$/.test(path) || /\.bak-/.test(path))
    assert(
      junk.length === 0,
      `these generated files are tracked and would be pushed: ${junk.join(', ')} — \`git rm --cached\` them`,
    )
    // The author's own content must still be tracked: excluding the churn must not exclude the work.
    assert(
      tracked.some((path) => path.startsWith('novel/') && path.endsWith('.md')),
      'the author\'s chapters must stay tracked — only the generated backups are excluded',
    )
  }
})

// --- request fence ---------------------------------------------------------
//
// The plugin mounts a raw prefix route BELOW the host's own token check and its
// Host/Origin fence (verified 2026-10-18: `/` and `/api` answered 401/403 for a
// foreign Host while `/dsh-novel/...` answered 200). These checks pin the policy
// the plugin now enforces itself — and each one fails if the fence is removed,
// which is the point: a rebinding page reaches the host under its own hostname.
const fakeRequest = (headers) => ({ headers })

check('fence accepts loopback hosts', () => {
  assert(router.isTrustedRequest(fakeRequest({ host: '127.0.0.1:27479' })) === true, '127.0.0.1 must be trusted')
  assert(router.isTrustedRequest(fakeRequest({ host: 'localhost:8080' })) === true, 'localhost must be trusted')
  assert(router.isTrustedRequest(fakeRequest({ host: '[::1]:27479' })) === true, 'the IPv6 loopback must be trusted')
  assert(router.isTrustedRequest(fakeRequest({ host: '127.9.9.9' })) === true, 'all of 127/8 is loopback')
})

check('fence refuses a forged or missing Host', () => {
  assert(router.isTrustedRequest(fakeRequest({ host: 'evil.example:27479' })) === false, 'a foreign Host must be refused')
  assert(router.isTrustedRequest(fakeRequest({ host: '127.0.0.1.evil.example:27479' })) === false, 'a look-alike host must be refused')
  assert(router.isTrustedRequest(fakeRequest({})) === false, 'a request without a Host must be refused')
})

check('fence refuses a cross-site request even from loopback', () => {
  const request = fakeRequest({ host: '127.0.0.1:27479', 'sec-fetch-site': 'cross-site' })
  assert(router.isTrustedRequest(request) === false, 'Sec-Fetch-Site: cross-site must be refused')
})

check('fence requires an attached Origin to be the same authority', () => {
  const good = fakeRequest({ host: '127.0.0.1:27479', origin: 'http://127.0.0.1:27479' })
  assert(router.isTrustedRequest(good) === true, 'the page\'s own origin must be accepted')
  const bad = fakeRequest({ host: '127.0.0.1:27479', origin: 'http://evil.example:27479' })
  assert(router.isTrustedRequest(bad) === false, 'a foreign Origin must be refused')
  const wrongPort = fakeRequest({ host: '127.0.0.1:27479', origin: 'http://127.0.0.1:3000' })
  assert(router.isTrustedRequest(wrongPort) === false, 'a different port is a different origin')
})

check('fence honours the deployment\'s own bind address and trusted hosts', () => {
  const startup = { host: '10.0.0.7', trustedHosts: ['app.example', 'studio.example:8443'] }
  assert(router.isTrustedRequest(fakeRequest({ host: '10.0.0.7:27479' }), startup) === true, 'the bind address must be trusted')
  assert(router.isTrustedRequest(fakeRequest({ host: 'app.example' }), startup) === true, 'a port-less trusted host matches any port')
  assert(router.isTrustedRequest(fakeRequest({ host: 'studio.example:8443' }), startup) === true, 'an exact trusted host:port matches')
  assert(router.isTrustedRequest(fakeRequest({ host: 'studio.example:9000' }), startup) === false, 'a trusted host on another port must not match')
  assert(router.isTrustedRequest(fakeRequest({ host: 'other.example' }), startup) === false, 'an unlisted host must be refused')
})

// --- front matter bounds ---------------------------------------------------
check('front matter refuses YAML aliases, which are the expansion bomb', () => {
  // 6 levels of ten references each: ~1 KB of text, 10^6 leaves if expanded.
  let text = 'a0: &a0 ["x","x","x","x","x","x","x","x","x","x"]\n'
  let prev = 'a0'
  for (let level = 1; level <= 6; level += 1) {
    text += `a${level}: &a${level} [${Array(10).fill(`*${prev}`).join(',')}]\n`
    prev = `a${level}`
  }
  const started = Date.now()
  const parsed = frontmatter.parseFrontMatter(`---\n${text}---\n正文\n`)
  const elapsed = Date.now() - started
  assert(parsed.error !== null && /alias/i.test(parsed.error), `an alias bomb must be refused, got: ${JSON.stringify(parsed.error)}`)
  assert(parsed.body === '正文\n', 'the prose must still come back so the author can open the file')
  assert(elapsed < 1000, `refusing must happen before expansion, took ${elapsed}ms`)
})

check('front matter still accepts a plain anchor with no alias', () => {
  const parsed = frontmatter.parseFrontMatter('---\ntitle: &t 第一章\norder: 10\n---\n正文\n')
  assert(parsed.error === null, `an anchor without an alias is harmless: ${parsed.error}`)
  assert(parsed.meta.title === '第一章', `unexpected title ${JSON.stringify(parsed.meta.title)}`)
})

check('front matter refuses an oversized block', () => {
  const huge = `title: ${'x'.repeat(200 * 1024)}\n`
  const parsed = frontmatter.parseFrontMatter(`---\n${huge}---\n正文\n`)
  assert(parsed.error !== null && /too large/.test(parsed.error), `expected a size refusal, got: ${JSON.stringify(parsed.error)}`)
  assert(parsed.body === '正文\n', 'the prose must still be readable')
})

// --- chapter path shape ----------------------------------------------------
check('a chapter path is one level, matching what the loader scans', () => {
  assert(schema.isChapterPath('draft/ch-0001.md') === true, 'a top-level chapter must be recognised')
  assert(schema.isChapterPath('draft/sub/ch-0001.md') === false, 'a nested chapter is invisible to loadChapters and must not count')
})

// --- report ----------------------------------------------------------------
const total = passed + failures.length
if (failures.length === 0) {
  console.log(`OK  ${passed}/${total} checks passed`)
  process.exit(0)
}
console.log(`FAIL  ${passed}/${total} checks passed`)
for (const failure of failures) {
  console.log(`\n  ✗ ${failure.name}\n    ${failure.message}`)
}
process.exit(1)
