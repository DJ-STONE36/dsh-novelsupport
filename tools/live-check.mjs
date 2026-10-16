/**
 * End-to-end check against a RUNNING DSH host.
 *
 * Drives the real HTTP API over the real web server and inspects the real
 * files, with node as the only client. That matters for the UTF-8 assertions:
 * Windows PowerShell's `Invoke-RestMethod -Body <string>` re-encodes the body
 * with the system ANSI code page, so a Chinese payload sent from pwsh arrives
 * mangled and makes the plugin look guilty of a bug it does not have. Node's
 * fetch sends exactly the bytes it was given.
 *
 * Run: node tools/live-check.mjs [root]
 *   root defaults to <cwd>/.verify and must be an existing directory.
 *
 * SAFETY: this script creates a project and writes chapters, so it must never be pointed at a
 * root that already holds one. Passing the repository root is an easy mistake — it takes an
 * argument, and the repository root is the obvious thing to type — and it would write into the
 * author's real `novel/`. The guard below refuses that instead of relying on a later step
 * failing by luck; when it was absent, the run only stopped because a create happened to hit an
 * existing project.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.DSH_NOVEL_BASE ?? 'http://127.0.0.1:19387/dsh-novel'
const root = process.argv[2] ?? join(process.cwd(), '.verify')

if (existsSync(join(root, 'novel', 'project.json'))) {
  console.error(`refusing to run: ${root} already contains a novel project (novel/project.json).`)
  console.error('This check creates a project and writes chapters. Point it at a scratch')
  console.error('directory instead — the default is <cwd>/.verify, which is what you want.')
  process.exit(2)
}

const TITLE = '第一章 青云山下'
const PROSE = '他抬头，看见山崩了。云层裂开一道口子，像有人把天撕了。\n'
const CHAR_NAME = '林渊'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
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

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'x-dsh-novel': '1', 'content-type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* keep text */
  }
  return { status: response.status, json, text }
}

if (existsSync(root)) rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const projectDir = join(root, 'novel')

console.log(`live-check against ${BASE}\nroot: ${root}\n`)

await check('host answers /health', async () => {
  const r = await call('GET', '/health')
  assert(r.status === 200, `status ${r.status}`)
  assert(r.json.impl.files.length >= 6, 'impl tree not reported')
})

await check('project/create scaffolds', async () => {
  const r = await call('POST', '/project/create', { root, title: '青云记' })
  assert(r.status === 201, `status ${r.status}: ${r.text}`)
  assert(r.json.validation.counts.errors === 0, `scaffold errors: ${r.text}`)
})

await check('chapter title survives as exact UTF-8 on disk', async () => {
  const created = await call('POST', '/chapter', { root, title: TITLE })
  assert(created.status === 201, `status ${created.status}: ${created.text}`)
  const raw = readFileSync(join(projectDir, created.json.path), 'utf8')
  assert(raw.includes(TITLE), `title mangled on disk.\n  expected: ${TITLE}\n  file head: ${JSON.stringify(raw.slice(0, 120))}`)
  // Byte-level proof, not just a substring match against a possibly-mangled read.
  const expectedBytes = Buffer.from(`title: ${TITLE}`, 'utf8').toString('hex')
  const actualLine = raw.split('\n').find((line) => line.startsWith('title:')) ?? ''
  const actualBytes = Buffer.from(actualLine.trimEnd(), 'utf8').toString('hex')
  assert(actualBytes === expectedBytes, `title bytes differ\n  expected ${expectedBytes}\n  actual   ${actualBytes}`)
})

await check('chapter reads back with parsed front matter', async () => {
  const r = await call('GET', `/document?root=${encodeURIComponent(root)}&path=draft/ch-0001.md`)
  assert(r.status === 200, `status ${r.status}`)
  assert(r.json.meta.title === TITLE, `meta.title round trip failed: ${JSON.stringify(r.json.meta.title)}`)
  assert(r.json.frontMatterError === null, `front matter error: ${r.json.frontMatterError}`)
})

await check('Chinese prose survives a write/read round trip', async () => {
  const characters = await call('GET', `/document?root=${encodeURIComponent(root)}&path=setting/characters.json`)
  const value = characters.json.value
  value.characters.push({ id: 'char-linyuan', name: CHAR_NAME, gender: '男', race: '人族', status: 'alive', born: { year: 1318 }, custom: {} })
  const written = await call('POST', '/document', { root, path: 'setting/characters.json', value })
  assert(written.status === 200, `character write failed: ${written.text}`)

  const chapter = await call('POST', '/document', {
    root,
    path: 'draft/ch-0001.md',
    meta: { id: 'ch-0001', title: TITLE, order: 10, status: 'draft', characters: ['char-linyuan'], places: [] },
    body: PROSE,
  })
  assert(chapter.status === 200, `chapter write failed: ${chapter.text}`)
  assert(chapter.json.introducedErrors === 0, `unexpected errors: ${chapter.text}`)

  const raw = readFileSync(join(projectDir, 'draft/ch-0001.md'), 'utf8')
  assert(raw.includes(PROSE.trim()), `prose mangled.\n  file: ${JSON.stringify(raw.slice(-120))}`)

  const chars = JSON.parse(readFileSync(join(projectDir, 'setting/characters.json'), 'utf8'))
  assert(chars.characters[0].name === CHAR_NAME, `character name mangled: ${JSON.stringify(chars.characters[0].name)}`)
})

await check('a chapter naming an unknown character is accepted with a warning', async () => {
  // Deliberate asymmetry: authors name characters before formalising the card, so
  // this must not block the save — it is reported instead.
  const r = await call('POST', '/document', {
    root,
    path: 'draft/ch-0001.md',
    meta: { id: 'ch-0001', title: TITLE, order: 10, characters: ['char-ghost'], places: [] },
    body: PROSE,
  })
  assert(r.status === 200, `expected 200, got ${r.status}: ${r.text}`)
  assert(r.json.introducedErrors === 0, `must not introduce errors: ${r.text}`)
  assert(
    (r.json.validation.issues ?? []).some((issue) => issue.code === 'unresolved-chapter-reference'),
    `the warning should still be reported: ${r.text}`,
  )
})

await check('a dangling relation endpoint is refused and disk is untouched', async () => {
  const before = readFileSync(join(projectDir, 'relations.json'), 'utf8')
  const r = await call('POST', '/document', {
    root,
    path: 'relations.json',
    value: {
      types: [{ id: 'ally', label: '同盟', directed: false, color: null, excludes: [] }],
      edges: [{ id: 'rel-1', from: 'char-linyuan', to: 'char-ghost', type: 'ally', since: { year: 1 }, until: null }],
    },
  })
  assert(r.status === 409, `expected 409, got ${r.status}: ${r.text}`)
  assert(r.json.code === 'validation-failed', `wrong code: ${r.json.code}`)
  assert(r.json.issues.some((i) => i.code === 'dangling-reference'), 'dangling-reference not reported')
  const after = readFileSync(join(projectDir, 'relations.json'), 'utf8')
  assert(before === after, 'the refused write still changed the file')
})

await check('a timeline event and an outline node are accepted and round-trip', async () => {
  const timeline = await call('GET', `/document?root=${encodeURIComponent(root)}&path=outline/timeline.json`)
  const doc = timeline.json.value
  doc.events.push({
    id: 'evt-0001',
    lineId: 'tl-main',
    at: { year: 1345, month: 3, day: 2 },
    spanEnd: null,
    atLabel: '',
    title: '青云山崩',
    impact: '山门尽毁',
    characters: [],
    places: [],
    outlineRef: null,
    causeEventId: null,
  })
  const written = await call('POST', '/document', { root, path: 'outline/timeline.json', value: doc })
  assert(written.status === 200, `timeline write failed: ${written.text}`)
  assert(written.json.introducedErrors === 0, `timeline introduced errors: ${written.text}`)

  const outline = await call('GET', `/document?root=${encodeURIComponent(root)}&path=outline/outline.json`)
  const outlineDoc = outline.json.value
  outlineDoc.nodes.push({
    id: 'out-0001',
    title: '第一卷 青云山下',
    kind: 'volume',
    parentId: null,
    order: 10,
    summary: '',
    timelineRef: null,
    chapterId: null,
  })
  const outlineWritten = await call('POST', '/document', { root, path: 'outline/outline.json', value: outlineDoc })
  assert(outlineWritten.status === 200, `outline write failed: ${outlineWritten.text}`)
  assert(outlineWritten.json.introducedErrors === 0, `outline introduced errors: ${outlineWritten.text}`)

  const back = await call('GET', `/document?root=${encodeURIComponent(root)}&path=outline/timeline.json`)
  assert(back.json.value.events[0].title === '青云山崩', 'event title lost on the round trip')
  assert(back.json.value.events[0].at.year === 1345, 'event time lost on the round trip')
})

await check('a time object with a null year is refused', async () => {
  // The form emits `null` for a cleared time rather than `{year:null,…}`; a partial
  // object is a "time" the validator must reject, so prove that it does.
  const timeline = await call('GET', `/document?root=${encodeURIComponent(root)}&path=outline/timeline.json`)
  const doc = timeline.json.value
  doc.events.push({ id: 'evt-0002', lineId: 'tl-main', at: { year: null, month: null, day: null }, title: '坏时间' })
  const r = await call('POST', '/document', { root, path: 'outline/timeline.json', value: doc })
  assert(r.status === 409, `expected 409, got ${r.status}`)
  assert(r.json.issues.some((issue) => issue.code === 'bad-time'), `bad-time not reported: ${r.text}`)
})

await check('validate reports a clean project', async () => {
  const r = await call('GET', `/validate?root=${encodeURIComponent(root)}`)
  assert(r.status === 200, `status ${r.status}`)
  assert(r.json.counts.errors === 0, `errors: ${r.text}`)
  assert(r.json.counts.chapters === 1, `chapter count wrong: ${r.text}`)
})

console.log('')
if (failures.length === 0) {
  console.log(`OK  ${passed} live checks passed`)
  process.exit(0)
}
console.log(`FAIL  ${passed} passed, ${failures.length} failed`)
process.exit(1)
