/**
 * Integration test for the plugin's HTTP surface, run outside DSH.
 *
 * `router.handle(request, response, load)` depends on nothing but node:http and
 * the impl modules, so the whole API can be driven from a throwaway server. That
 * matters here because the alternative feedback loop is a full host restart,
 * which interrupts whatever the user is doing.
 *
 * Run: node tools/api-selftest.mjs
 */

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const implDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'impl')

const cache = new Map()
async function load(relative) {
  const abs = join(implDir, relative)
  const { mtimeMs } = statSync(abs)
  const hit = cache.get(abs)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.mod
  const mod = await import(`${pathToFileURL(abs).href}?v=${mtimeMs}`)
  cache.set(abs, { mtimeMs, mod })
  return mod
}

const router = await load('./router.js')

/** Mutable so tests can add and remove optional host services. */
const services = Object.create(null)

const server = createServer((request, response) => {
  router.handle(request, response, load, services).catch((error) => {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
  })
})

await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
const base = `http://127.0.0.1:${server.address().port}/dsh-novel`

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, message: error.message })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Always sends the write header; individual cases override it. */
async function call(method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { 'content-type': 'application/json', 'x-dsh-novel': '1', ...headers } }
  if (raw !== undefined) init.body = raw
  else if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body kept as text for the assertion message */
  }
  return { status: response.status, json, text, headers: response.headers }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-novel-api-'))
const projectDir = join(root, 'novel')

try {
  // ---- project lifecycle --------------------------------------------------
  await check('GET /health reports the impl tree', async () => {
    const r = await call('GET', '/health')
    assert(r.status === 200, `status ${r.status}`)
    assert(r.json.plugin === 'dsh-novel', 'wrong plugin name')
    assert(Array.isArray(r.json.impl.files) && r.json.impl.files.length >= 6, `impl files not reported: ${r.text}`)
  })

  await check('GET /catalog degrades when the host composes no llm service', async () => {
    // The offline suite runs without services bound, which is also what a host
    // missing the llm plugin looks like. The catalogue must still describe the
    // styles and generators, and say plainly that model generation is unavailable —
    // rather than 500ing, which would leave the pane with no explanation.
    const r = await call('GET', '/catalog')
    assert(r.status === 200, `status ${r.status}: ${r.text}`)
    assert(r.json.available === false, 'no llm service should report unavailable')
    assert(Array.isArray(r.json.styles) && r.json.styles.length > 0, `styles missing: ${r.text}`)
    assert(Array.isArray(r.json.generators) && r.json.generators.length === 5, `generators missing: ${r.text}`)
    assert(r.json.models !== undefined, 'the models field must be present even when empty')
  })

  await check('POST /generate refuses cleanly without an llm service', async () => {
    const r = await call('POST', '/generate', { body: { kind: 'item' } })
    assert(r.status === 503, `expected 503, got ${r.status}: ${r.text}`)
    assert(r.json.code === 'llm-unavailable', `wrong code: ${r.json.code}`)
    // The cause must be stated in the response, not only in the host log.
    assert(typeof r.json.error === 'string' && r.json.error.includes('llm'), `unhelpful error: ${r.json.error}`)
  })

  await check('POST /generate rejects an unknown kind before calling a model', async () => {
    const r = await call('POST', '/generate', { body: { kind: 'dragon' } })
    assert(r.status === 400, `expected 400, got ${r.status}: ${r.text}`)
    assert(r.json.code === 'unknown-generator', `wrong code: ${r.json.code}`)
    // The message must say what IS available, so the caller need not guess.
    assert(r.json.error.includes('item'), `the error should list valid kinds: ${r.json.error}`)
  })

  await check('POST /generate requires the write header', async () => {
    // It spends the author's quota, so it is a write in every sense that matters.
    // Overriding with an empty header does not remove it, so the helper's default
    // is replaced explicitly rather than omitted.
    const r = await call('POST', '/generate', { body: { kind: 'item' }, headers: { 'x-dsh-novel': '' } })
    assert(r.status === 403, `expected 403 without the header, got ${r.status}: ${r.text}`)
  })

  await check('GET /models is gone, replaced by /catalog', async () => {
    // Guards against two endpoints answering the same question.
    const r = await call('GET', '/models')
    assert(r.status === 404, `expected 404, got ${r.status}: ${r.text}`)
  })

  await check('POST /project/create scaffolds the project', async () => {
    const r = await call('POST', '/project/create', { body: { root, title: '青云记' } })
    assert(r.status === 201, `status ${r.status}: ${r.text}`)
    assert(r.json.validation.counts.errors === 0, `scaffold should be clean: ${r.text}`)
    for (const rel of ['project.json', 'relations.json', 'setting/world.json', 'outline/timeline.json', 'draft', 'views']) {
      assert(existsSync(join(projectDir, rel)), `missing scaffolded path: ${rel}`)
    }
  })

  await check('create refuses to overwrite an existing project', async () => {
    const r = await call('POST', '/project/create', { body: { root, title: '再来一次' } })
    assert(r.status === 409, `expected 409, got ${r.status}`)
    assert(r.json.code === 'project-exists', `wrong code: ${r.json.code}`)
  })

  await check('GET /project summarizes it', async () => {
    const r = await call('GET', `/project?root=${encodeURIComponent(root)}`)
    assert(r.status === 200, `status ${r.status}: ${r.text}`)
    assert(r.json.summary.title === '青云记', `wrong title: ${r.text}`)
    assert(r.json.summary.schemaVersion === 1, 'wrong schemaVersion')
  })

  await check('GET /validate reports a clean project', async () => {
    const r = await call('GET', `/validate?root=${encodeURIComponent(root)}`)
    assert(r.status === 200, `status ${r.status}`)
    assert(r.json.counts.errors === 0, `unexpected errors: ${r.text}`)
  })

  // ---- chapters -----------------------------------------------------------
  await check('POST /chapter creates ch-0001 with front matter', async () => {
    const r = await call('POST', '/chapter', { body: { root, title: '第一章 青云山下' } })
    assert(r.status === 201, `status ${r.status}: ${r.text}`)
    assert(r.json.path === 'draft/ch-0001.md', `wrong path: ${r.json.path}`)
    const file = readFileSync(join(projectDir, r.json.path), 'utf8')
    assert(file.startsWith('---\n'), 'file has no front matter')
    assert(file.includes('第一章 青云山下'), 'title not written')
  })

  await check('GET /document reads the chapter back, prose intact', async () => {
    const r = await call('GET', `/document?root=${encodeURIComponent(root)}&path=draft/ch-0001.md`)
    assert(r.status === 200, `status ${r.status}: ${r.text}`)
    assert(r.json.kind === 'chapter', 'wrong kind')
    assert(r.json.meta.title === '第一章 青云山下', `title lost: ${r.text}`)
    assert(r.json.frontMatterError === null, `front matter error: ${r.json.frontMatterError}`)
  })

  // ---- validation gate ----------------------------------------------------
  await check('a chapter naming an unknown character is ACCEPTED with a warning', async () => {
    // The asymmetry is deliberate: authors name characters before formalising the
    // card, so this must not block the save. It is reported so the editor can show
    // it, not enforced.
    const r = await call('POST', '/document', {
      body: {
        root,
        path: 'draft/ch-0001.md',
        meta: { id: 'ch-0001', title: '第一章 青云山下', order: 10, characters: ['char-ghost'], places: [] },
        body: '正文\n',
      },
    })
    assert(r.status === 200, `expected 200, got ${r.status}: ${r.text}`)
    assert(r.json.introducedErrors === 0, `must not introduce errors: ${r.text}`)
    assert(
      (r.json.validation.issues ?? []).some((issue) => issue.code === 'unresolved-chapter-reference'),
      `the warning should still be reported: ${r.text}`,
    )
  })

  await check('a dangling relation endpoint is still refused', async () => {
    // Where structural integrity actually depends on it, the strict rule stays:
    // a relationship graph with a missing node is a broken document.
    const relations = {
      types: [{ id: 'ally', label: '同盟', directed: false, color: null, excludes: [] }],
      edges: [{ id: 'rel-1', from: 'char-linyuan', to: 'char-ghost', type: 'ally', since: { year: 1 }, until: null }],
    }
    const r = await call('POST', '/document', { body: { root, path: 'relations.json', value: relations } })
    assert(r.status === 409, `expected 409, got ${r.status}: ${r.text}`)
    assert(r.json.code === 'validation-failed', `wrong code: ${r.json.code}`)
    assert(
      r.json.issues.some((issue) => issue.code === 'dangling-reference'),
      `dangling-reference not reported: ${r.text}`,
    )
  })

  await check('the relation refusal left the file untouched', async () => {
    const relations = JSON.parse(readFileSync(join(projectDir, 'relations.json'), 'utf8'))
    assert((relations.edges ?? []).length === 0, 'the refused relation still reached disk')
  })

  await check('creating the character makes the reference resolve', async () => {
    const characters = JSON.parse(readFileSync(join(projectDir, 'setting/characters.json'), 'utf8'))
    characters.characters.push({ id: 'char-linyuan', name: '林渊', gender: '男', status: 'alive', born: { year: 1318 }, custom: {} })
    const created = await call('POST', '/document', { body: { root, path: 'setting/characters.json', value: characters } })
    assert(created.status === 200, `character write failed: ${created.text}`)

    const chapter = await call('POST', '/document', {
      body: {
        root,
        path: 'draft/ch-0001.md',
        meta: { id: 'ch-0001', title: '第一章 青云山下', order: 10, characters: ['char-linyuan'], places: [] },
        body: '他抬头，看见山崩了。\n',
      },
    })
    assert(chapter.status === 200, `chapter write failed: ${chapter.text}`)
    const file = readFileSync(join(projectDir, 'draft/ch-0001.md'), 'utf8')
    assert(file.includes('他抬头'), 'prose not written')
    assert(file.includes('char-linyuan'), 'reference not written')
  })

  await check('force overrides the validation gate', async () => {
    const r = await call('POST', '/document', {
      body: {
        root,
        path: 'setting/characters.json',
        value: { characters: [{ id: 'char-x', name: 'X', firstAppearance: 'ch-9999' }] },
        force: true,
      },
    })
    assert(r.status === 200, `force should write: ${r.text}`)
    assert(r.json.introducedErrors > 0, 'force should still report what it introduced')
  })

  await check('a blank custom key is refused rather than persisted', async () => {
    const characters = JSON.parse(readFileSync(join(projectDir, 'setting/characters.json'), 'utf8'))
    characters.characters[0].custom = { '': '', 性格: '外冷内热' }
    const r = await call('POST', '/document', { body: { root, path: 'setting/characters.json', value: characters } })
    assert(r.status === 409, `expected 409, got ${r.status}: ${r.text}`)
    assert(r.json.issues.some((issue) => issue.code === 'blank-map-key'), `blank-map-key not reported: ${r.text}`)
  })

  await check('the blank-key refusal left the file untouched', async () => {
    const characters = JSON.parse(readFileSync(join(projectDir, 'setting/characters.json'), 'utf8'))
    assert(
      !Object.prototype.hasOwnProperty.call(characters.characters[0].custom ?? {}, ''),
      'a blank key reached disk despite the refusal',
    )
  })

  // ---- write guards -------------------------------------------------------
  await check('a write without the custom header is refused', async () => {
    const r = await call('POST', '/chapter', { body: { root, title: 'x' }, headers: { 'x-dsh-novel': '0' } })
    assert(r.status === 403, `expected 403, got ${r.status}`)
    assert(r.json.code === 'write-header-missing', `wrong code: ${r.json.code}`)
  })

  await check('GET needs no write header', async () => {
    const r = await fetch(`${base}/health`)
    assert(r.status === 200, `GET refused: ${r.status}`)
  })

  await check('path traversal is refused', async () => {
    const r = await call('POST', '/document', { body: { root, path: '../escape.json', value: {} } })
    assert(r.status === 400, `expected 400, got ${r.status}`)
    assert(String(r.json.code).startsWith('path-'), `wrong code: ${r.json.code}`)
  })

  await check('alternate data stream path is refused', async () => {
    const r = await call('POST', '/document', { body: { root, path: 'draft/ch-0001.md:secret', value: {} } })
    assert(r.status === 400, `expected 400, got ${r.status}`)
    assert(r.json.code === 'path-colon', `wrong code: ${r.json.code}`)
  })

  await check('a path outside the known documents is refused', async () => {
    const r = await call('POST', '/document', { body: { root, path: 'lib/index.js', value: {} } })
    assert(r.status === 400, `expected 400, got ${r.status}`)
    assert(r.json.code === 'path-not-a-document', `wrong code: ${r.json.code}`)
  })

  await check('a nonexistent root is refused', async () => {
    const r = await call('GET', `/project?root=${encodeURIComponent(join(root, 'nope'))}`)
    assert(r.status === 400, `expected 400, got ${r.status}`)
    assert(r.json.code === 'root-missing', `wrong code: ${r.json.code}`)
  })

  await check('a relative root is refused', async () => {
    const r = await call('GET', '/project?root=novel')
    assert(r.status === 400, `expected 400, got ${r.status}`)
    assert(r.json.code === 'root-not-absolute', `wrong code: ${r.json.code}`)
  })

  // ---- routing ------------------------------------------------------------
  await check('GET /chapters returns parsed metadata and a derived word count', async () => {
    const r = await call('GET', `/chapters?root=${encodeURIComponent(root)}`)
    assert(r.status === 200, `status ${r.status}: ${r.text}`)
    assert(Array.isArray(r.json.chapters), 'chapters must be an array')
    assert(r.json.chapters.length === 1, `expected 1 chapter, got ${r.json.chapters.length}`)
    const chapter = r.json.chapters[0]
    assert(chapter.title === '第一章 青云山下', `title not parsed: ${JSON.stringify(chapter.title)}`)
    assert(chapter.id === 'ch-0001', `id not parsed: ${chapter.id}`)
    assert(chapter.order === 10, `order not parsed: ${chapter.order}`)
    // An earlier case rewrote this chapter without a `status`, so the endpoint
    // must report that absence rather than inventing the 'draft' default — the
    // list is a faithful read of the file, not a normalising one.
    assert(chapter.status === null, `status must reflect the file, got ${JSON.stringify(chapter.status)}`)
    assert(chapter.frontMatterError === null, `front matter error: ${chapter.frontMatterError}`)
    // Body was 他抬头，看见山崩了。 — eight CJK characters, punctuation excluded.
    assert(chapter.wordCount === 8, `wordCount wrong: ${chapter.wordCount}`)
    assert(r.json.totalWordCount === 8, `totalWordCount wrong: ${r.json.totalWordCount}`)
  })

  await check('GET /manuscript assembles the book over HTTP', async () => {
    const r = await call('GET', `/manuscript?root=${encodeURIComponent(root)}`)
    assert(r.status === 200, `status ${r.status}: ${r.text}`)
    assert(r.json.ok === true && r.json.route === 'manuscript', 'the route identifies itself')
    // The project is titled 青云记, and the chapter written above is 第一章 青云山下.
    assert(r.json.text.startsWith('# 青云记'), `the title page must lead, got ${JSON.stringify(r.json.text.slice(0, 40))}`)
    assert(r.json.text.includes('第一章 青云山下'), 'and the chapter must be in it')
    assert(r.json.text.includes('他抬头，看见山崩了。'), 'with its body')
    assert(r.json.chapterCount === 1, `expected 1 chapter, got ${r.json.chapterCount}`)
    assert(r.json.wordCount === 8, `the length must match /chapters, got ${r.json.wordCount}`)
    assert(r.json.skipped.length === 0, 'nothing skipped in a healthy project')
    assert(/\.md$/.test(r.json.name), `a download name is offered, got ${r.json.name}`)
    // The options are query parameters, and they change the text.
    const bare = await call('GET', `/manuscript?root=${encodeURIComponent(root)}&titlePage=0`)
    assert(!bare.json.text.startsWith('# 青云记'), 'the title page can be turned off')
    // A root that is not a project must say so, exactly as /chapters does.
    const missing = await call('GET', '/manuscript?root=' + encodeURIComponent(join(tmpdir(), 'no-such-project-xyz')))
    assert(missing.status === 400 || missing.status === 404, `a bad root must be refused, got ${missing.status}`)
  })

  await check('POST /manuscript writes the book into the project and gives its ADDRESS', async () => {
    // REPORTED: 「导出的文件没有给出地址，无法找到」. A download lands somewhere a page is not allowed to know,
    // so the only way a file can have an address is to put it inside the project — which is what this route is
    // for, and why it is the primary button rather than the download.
    const r = await call('POST', '/manuscript', { body: { root, summary: true } })
    assert(r.status === 200, `status ${r.status}: ${r.text}`)
    assert(typeof r.json.absolute === 'string' && r.json.absolute !== '', 'an absolute path must come back')
    assert(r.json.relative === 'novel/export/青云记.md', `the relative path, got ${r.json.relative}`)
    // IT MUST BE INSIDE THE PROJECT. `resolveInside` is the same fence every other write goes through.
    assert(r.json.absolute.startsWith(root), `the file must land inside the project, got ${r.json.absolute}`)
    assert(r.json.absolute.includes(`${sep}export${sep}`), 'in novel/export/')
    assert(r.json.bytes > 0, 'with a byte count')
    // THE FILE IS REALLY THERE, with the book in it — the whole point of returning a path is that the path works.
    assert(existsSync(r.json.absolute), `no file at ${r.json.absolute}`)
    const text = readFileSync(r.json.absolute, 'utf8')
    assert(text.startsWith('# 青云记'), 'titled')
    assert(text.includes('第一章 青云山下'), 'and containing the chapter')
    assert(text.includes('他抬头，看见山崩了。'), 'and its body')
    assert(Buffer.byteLength(text, 'utf8') === r.json.bytes, 'the reported size is the real size')
    // The word count matches /chapters, because both use `text.js`.
    assert(r.json.wordCount === 8, `the length must agree with /chapters, got ${r.json.wordCount}`)

    // RE-EXPORTING OVERWRITES, which is correct for a derived file — and `.prev` still keeps one generation.
    const again = await call('POST', '/manuscript', { body: { root } })
    assert(again.status === 200, `a second export must work: ${again.text}`)
    assert(existsSync(`${r.json.absolute}.prev`), 'the previous export is kept as .prev')
    // The options travel in the BODY here, not the query string.
    assert(!readFileSync(r.json.absolute, 'utf8').includes('梗概'), 'the second call used its own options')

    // And the GET still returns the text without writing anything.
    const got = await call('GET', `/manuscript?root=${encodeURIComponent(root)}`)
    assert(got.status === 200 && typeof got.json.text === 'string', 'the GET still assembles without writing')
  })

  await check('the manuscript route refuses a root outside the project', async () => {
    const missing = await call('POST', '/manuscript', { body: { root: join(tmpdir(), 'no-such-project-xyz') } })
    assert(missing.status === 400 || missing.status === 404, `a bad root must be refused, got ${missing.status}`)
    // It is a write route, so it must demand the write header like every other one.
    const bare = await fetch(`${base}/manuscript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root }),
    })
    assert(bare.status === 403 || bare.status === 400, `a write without the header must be refused, got ${bare.status}`)
  })

  await check('an unknown route 404s and lists the real ones', async () => {
    const r = await call('GET', '/nope')
    assert(r.status === 404, `expected 404, got ${r.status}`)
    assert(Array.isArray(r.json.routes) && r.json.routes.length >= 7, 'route list not returned')
  })

  await check('a wrong method 405s with an Allow header', async () => {
    const r = await call('POST', '/health', { body: {} })
    assert(r.status === 405, `expected 405, got ${r.status}`)
    assert(String(r.headers.get('allow')).includes('GET'), `bad Allow: ${r.headers.get('allow')}`)
  })

  await check('a malformed JSON body is a 400, not a 500', async () => {
    const r = await call('POST', '/chapter', { raw: '{not json' })
    assert(r.status === 400, `expected 400, got ${r.status}`)
    assert(r.json.code === 'body-invalid', `wrong code: ${r.json.code}`)
  })

  await check('a missing document is a 404', async () => {
    const r = await call('GET', `/document?root=${encodeURIComponent(root)}&path=draft/ch-9999.md`)
    assert(r.status === 404, `expected 404, got ${r.status}`)
    assert(r.json.code === 'document-missing', `wrong code: ${r.json.code}`)
  })

  await check('the registered prefix matches real request paths', async () => {
    // Regression guard. The host's matcher (dsh-host-webserver match()) is:
    //   pathname === prefix || pathname.startsWith(`${prefix}/`)
    // so a prefix registered WITH a trailing slash can never match — every
    // request 404s, silently, with nothing in any log. That cost a full host
    // restart to diagnose once; it must not happen twice.
    const source = readFileSync(join(implDir, '..', 'index.js'), 'utf8')
    const found = /path:\s*'([^']+)'/.exec(source)
    assert(found !== null, 'could not find the registered route path in lib/index.js')
    const prefix = found[1]
    const matches = (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    assert(!prefix.endsWith('/'), `prefix "${prefix}" must not end with a slash — the host appends one`)
    assert(matches('/dsh-novel/health'), `prefix "${prefix}" never matches /dsh-novel/health`)
    assert(matches('/dsh-novel'), `prefix "${prefix}" never matches /dsh-novel`)
  })

  await check('workspaces degrades cleanly when no registry is composed', async () => {
    delete services.workspaceRegistry
    const r = await call('GET', '/workspaces')
    assert(r.status === 200, `expected 200, got ${r.status}: ${r.text}`)
    assert(r.json.available === false, 'must report unavailability rather than failing')
    assert(Array.isArray(r.json.workspaces) && r.json.workspaces.length === 0, 'must return an empty list')
  })

  await check('workspaces maps registry entities and flags initialized projects', async () => {
    services.workspaceRegistry = {
      list: () => [
        { id: 'ws-1', path: root, title: '青云记', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['s-1', 's-2'] },
        { id: 'ws-2', path: join(root, 'nope'), title: '空目录', createdAt: null, sessionIds: [] },
      ],
    }
    const r = await call('GET', '/workspaces')
    assert(r.status === 200, `status ${r.status}: ${r.text}`)
    assert(r.json.available === true, 'should be available')
    const [first, second] = r.json.workspaces
    assert(first.id === 'ws-1' && first.title === '青云记', `first mapping wrong: ${r.text}`)
    assert(first.sessionCount === 2, 'sessionCount not mapped')
    assert(first.project.initialized === true, 'existing project not detected as initialized')
    assert(second.project.initialized === false, 'missing project must not read as initialized')
    assert(first.project.dir === join(root, 'novel'), `project dir wrong: ${first.project.dir}`)
  })

  await check('atomic write left no temp files in the project', async () => {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [entry.name])
    const leftovers = walk(projectDir).filter((name) => name.includes('.tmp-'))
    assert(leftovers.length === 0, `temp files left: ${leftovers.join(', ')}`)
  })

  // ---- model-backed endpoints, driven by a stub llm ------------------------
  //
  // The whole generation path — chunk collection, JSON extraction, sanitising,
  // candidates, error mapping — was previously untestable offline, and that is
  // exactly how a wrong chunk discriminator shipped while silently collecting
  // nothing. The stub emits chunks in the REAL host shape (discriminated by
  // `type`, NOT `kind`) so the collector is exercised against reality.

  const llmStub = {
    script: [],
    calls: [],
    providers: [{ id: 'test-provider', name: 'Test' }],
    models: ['test-model'],
    async listProviders() {
      return this.providers
    },
    async listModels(id) {
      return id === 'test-provider' ? this.models : []
    },
    async stream(options) {
      this.calls.push(options)
      const script = this.script
      return (async function* emit() {
        // Reasoning brackets the answer in real streams and must NOT be collected.
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: 'REASONING-MUST-NOT-APPEAR' }
        yield { type: 'block-start', index: 1, blockType: 'text' }
        for (const chunk of script) {
          yield chunk
          if (chunk.type === 'error' || chunk.type === 'aborted') return
        }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
        yield { type: 'finish' }
      })()
    },
  }

  /** Run a case with the stub installed, then always remove it. */
  const withLlm = async (script, fn) => {
    llmStub.script = script
    llmStub.calls = []
    llmStub.providers = [{ id: 'test-provider', name: 'Test' }]
    services.llm = llmStub
    try {
      await fn()
    } finally {
      delete services.llm
    }
  }

  const text = (value) => [{ type: 'text-delta', index: 1, text: value }]

  await check('POST /generate collects text-delta and ignores reasoning', async () => {
    await withLlm(text('{"name":"霜啼","rarity":"灵品"}'), async () => {
      const r = await call('POST', '/generate', { body: { kind: 'item', root } })
      assert(r.status === 200, `status ${r.status}: ${r.text}`)
      assert(r.json.value.name === '霜啼', `value not parsed: ${r.text}`)
      // The stub emits reasoning first; collecting it would corrupt the JSON.
      assert(!r.text.includes('REASONING-MUST-NOT-APPEAR'), 'reasoning leaked into the result')
      assert(r.json.usage.totalTokens === 30, 'usage not read from the terminal chunks')
      assert(r.json.provider === 'test-provider' && r.json.model === 'test-model', 'default provider/model not chosen')
    })
  })

  await check('POST /generate reads JSON out of prose and fences', async () => {
    await withLlm(text('好的，这是结果：\n```json\n{"name":"照雪","tags":["剑"]}\n```\n以上。'), async () => {
      const r = await call('POST', '/generate', { body: { kind: 'item', root } })
      assert(r.status === 200, `status ${r.status}: ${r.text}`)
      assert(r.json.value.name === '照雪', `fenced JSON not extracted: ${r.text}`)
    })
  })

  await check('POST /generate returns several candidates when asked', async () => {
    const payload = '{"candidates":[{"name":"甲"},{"name":"乙"},{"name":"丙"}]}'
    await withLlm(text(payload), async () => {
      const r = await call('POST', '/generate', { body: { kind: 'item', count: 3, root } })
      assert(r.status === 200, `status ${r.status}: ${r.text}`)
      assert(Array.isArray(r.json.candidates) && r.json.candidates.length === 3, `candidates: ${r.text}`)
      assert(r.json.value.name === '甲', 'the first candidate must also be exposed as `value`')
      assert(r.json.candidates[2].name === '丙', 'every candidate must be sanitised')
    })
  })

  await check('POST /generate accepts a bare object when the wrapper is ignored', async () => {
    // A model that ignores the wrapper is a worse result, not a failed request.
    await withLlm(text('{"name":"沉渊"}'), async () => {
      const r = await call('POST', '/generate', { body: { kind: 'item', count: 3, root } })
      assert(r.status === 200, `status ${r.status}: ${r.text}`)
      assert(r.json.candidates.length === 1, `expected one candidate, got ${r.json.candidates.length}`)
    })
  })

  await check('POST /generate strips undeclared fields from the model output', async () => {
    await withLlm(text('{"name":"甲","evil":"drop","id":"hijacked","tags":"not-an-array"}'), async () => {
      const r = await call('POST', '/generate', { body: { kind: 'item', base: { id: 'item-1' }, root } })
      assert(r.status === 200, `status ${r.status}: ${r.text}`)
      assert(r.json.value.evil === undefined, 'an undeclared field reached the response')
      assert(r.json.value.id === 'item-1', 'the model must not re-key the entity')
      assert(Array.isArray(r.json.value.tags), 'a wrong-typed field must be coerced')
    })
  })

  await check('POST /generate reports an unparseable response with diagnostics', async () => {
    await withLlm(text('我没有生成 JSON，抱歉。'), async () => {
      const r = await call('POST', '/generate', { body: { kind: 'item', root } })
      assert(r.status === 502, `expected 502, got ${r.status}: ${r.text}`)
      assert(r.json.code === 'unparseable-response', `wrong code: ${r.json.code}`)
      // The chunk vocabulary is what made this class of failure findable; it must
      // travel WITH the failure, not only with success.
      assert(Array.isArray(r.json.details.chunkTypes), `chunkTypes missing: ${r.text}`)
      assert(r.json.details.raw.includes('没有生成'), 'the raw response must be attached for diagnosis')
    })
  })

  await check('POST /generate maps a model failure to 502', async () => {
    await withLlm([{ type: 'error', failure: { code: 'RATE_LIMITED' } }], async () => {
      const r = await call('POST', '/generate', { body: { kind: 'item', root } })
      assert(r.status === 502, `expected 502, got ${r.status}: ${r.text}`)
      assert(r.json.code === 'model-failed', `wrong code: ${r.json.code}`)
      assert(r.json.error.includes('RATE_LIMITED'), `the upstream code must survive: ${r.json.error}`)
    })
  })

  await check('POST /generate reports no-model when the host offers none', async () => {
    await withLlm(text('{}'), async () => {
      llmStub.providers = []
      const r = await call('POST', '/generate', { body: { kind: 'item', root } })
      assert(r.status === 503, `expected 503, got ${r.status}: ${r.text}`)
      assert(r.json.code === 'no-model', `wrong code: ${r.json.code}`)
    })
  })

  await check('POST /generate grounds the prompt in the project setting', async () => {
    // Exercises the whole context path: read the documents, digest them, put them in
    // the prompt. Unit tests cover the digest; this covers the wiring.
    await call('POST', '/document', {
      body: {
        root,
        path: 'setting/world.json',
        value: {
          sections: [{ id: 'sec-power', title: '力量体系', order: 10, body: '灵气分九品。' }],
          rules: [{ id: 'rule-001', scope: 'global', title: '灵气守恒', body: '灵气只能转移。', tags: [] }],
        },
      },
    })
    await withLlm(text('{"name":"甲"}'), async () => {
      const r = await call('POST', '/generate', { body: { kind: 'item', root } })
      assert(r.status === 200, `status ${r.status}: ${r.text}`)
      assert(r.json.contextUsed === true, 'the project context was not used')
      assert(r.json.prompt.user.includes('灵气守恒'), `the rule never reached the prompt: ${r.json.prompt.user}`)
      assert(r.json.prompt.user.includes('力量体系'), 'the section titles never reached the prompt')
    })
  })

  await check('POST /generate can decline the project context', async () => {
    await withLlm(text('{"name":"甲"}'), async () => {
      const r = await call('POST', '/generate', { body: { kind: 'item', root, useContext: false } })
      assert(r.status === 200, `status ${r.status}: ${r.text}`)
      assert(r.json.contextUsed === false, 'the context should have been skipped')
      assert(!r.json.prompt.user.includes('灵气守恒'), 'the rule must not reach the prompt when declined')
    })
  })

  /** Create a chapter with prose and return the path it actually landed at. */
  const freshChapter = async (title, prose) => {
    const created = await call('POST', '/chapter', { body: { root, title, body: prose } })
    assert(created.status === 201 || created.status === 200, `chapter create failed: ${created.text}`)
    // The id is chosen by the host, so the path must be read back rather than assumed:
    // an earlier test already owns ch-0001, and guessing it silently targeted the wrong
    // chapter — which is how this suite first "proved" the context was empty.
    return created.json.path
  }

  await check('POST /draft writes prose and reports its length', async () => {
    const target = await freshChapter('续写测试', '他推开门。')
    await withLlm(text('雪灌了进来，落在他的肩上。'), async () => {
      const r = await call('POST', '/draft', { body: { root, path: target, mode: 'continue' } })
      assert(r.status === 200, `status ${r.status}: ${r.text}`)
      assert(r.json.text.includes('雪灌了进来'), `prose not returned: ${r.text}`)
      assert(r.json.wordCount > 0, 'the word count must be computed')
      assert(r.json.mode === 'continue', `mode not echoed: ${r.json.mode}`)
      // The chapter's own existing prose must reach the prompt as continuity.
      assert(r.json.prompt.user.includes('他推开门'), `the existing prose is missing from the prompt: ${r.json.prompt.user}`)
    })
  })

  await check('POST /draft carries the previous chapter ending into the prompt', async () => {
    const first = await freshChapter('前章', '上一章到此为止。')
    const second = await freshChapter('后章', '本章开头。')
    assert(first !== second, 'the two chapters must be distinct files')
    await withLlm(text('续写。'), async () => {
      const r = await call('POST', '/draft', { body: { root, path: second, mode: 'continue' } })
      assert(r.status === 200, `status ${r.status}: ${r.text}`)
      // Continuity is the whole reason to read the previous chapter at all.
      assert(r.json.prompt.user.includes('上一章到此为止'), `the previous ending is missing: ${r.json.prompt.user}`)
      assert(r.json.prompt.user.includes('本章开头'), `the current tail is missing: ${r.json.prompt.user}`)
    })
  })

  await check('POST /draft asks for the whole chapter only when rewriting', async () => {
    const target = await freshChapter('重写测试', '原本的正文在这里。')
    await withLlm(text('重写后的正文。'), async () => {
      const cont = await call('POST', '/draft', { body: { root, path: target, mode: 'continue' } })
      assert(!cont.json.prompt.user.includes('已有正文'), '接着写 must not inline the whole chapter')
      const rewrite = await call('POST', '/draft', { body: { root, path: target, mode: 'rewrite' } })
      assert(rewrite.json.prompt.user.includes('已有正文'), '重写 must receive the text it rewrites')
      assert(rewrite.json.prompt.user.includes('原本的正文'), 'the existing prose must be inlined for a rewrite')
    })
  })

  await check('POST /draft refuses an empty model response', async () => {
    // Prose has no JSON to fail parsing, so an empty answer is its own failure mode.
    const target = await freshChapter('空响应测试', '')
    await withLlm([], async () => {
      const r = await call('POST', '/draft', { body: { root, path: target } })
      assert(r.status === 502, `expected 502, got ${r.status}: ${r.text}`)
      assert(r.json.code === 'empty-draft', `wrong code: ${r.json.code}`)
      assert(Array.isArray(r.json.details.chunkTypes), 'the chunk vocabulary must be attached')
    })
  })

  await check('POST /draft maps a model failure to 502', async () => {
    const target = await freshChapter('模型失败测试', '')
    await withLlm([{ type: 'error', failure: { code: 'OVERLOADED' } }], async () => {
      const r = await call('POST', '/draft', { body: { root, path: target } })
      assert(r.status === 502, `expected 502, got ${r.status}: ${r.text}`)
      assert(r.json.code === 'model-failed', `wrong code: ${r.json.code}`)
    })
  })

  await check('POST /draft validates its target before calling a model', async () => {
    await withLlm(text('不该被调用'), async () => {
      const missing = await call('POST', '/draft', { body: { root, path: 'draft/nope.md' } })
      assert(missing.status === 404, `expected 404, got ${missing.status}: ${missing.text}`)
      assert(missing.json.code === 'chapter-missing', `wrong code: ${missing.json.code}`)

      const noPath = await call('POST', '/draft', { body: { root } })
      assert(noPath.status === 400, `expected 400, got ${noPath.status}: ${noPath.text}`)
      assert(noPath.json.code === 'path-required', `wrong code: ${noPath.json.code}`)

      // A bad target must not have cost the author a model call.
      assert(llmStub.calls.length === 0, `a model was called for an invalid request (${llmStub.calls.length} times)`)
    })
  })

  await check('POST /draft refuses a chapter whose front matter is unreadable', async () => {
    // Without readable front matter there is no cast, no beat and no summary, so a
    // draft would ignore this chapter's own setup. Refusing beats writing something
    // generic that looks like it used them.
    const broken = join(projectDir, 'draft', 'ch-broken.md')
    writeFileSync(broken, '---\ntitle: [unclosed\n---\n\n正文。\n', 'utf8')
    await withLlm(text('不该被调用'), async () => {
      const r = await call('POST', '/draft', { body: { root, path: 'draft/ch-broken.md' } })
      assert(r.status === 422, `expected 422, got ${r.status}: ${r.text}`)
      assert(r.json.code === 'front-matter-unreadable', `wrong code: ${r.json.code}`)
      assert(llmStub.calls.length === 0, 'a model was called for a chapter it cannot read')
    })
    rmSync(broken, { force: true })
  })

  // ---- request-shape errors -------------------------------------------------

  await check('a request with no body is refused with a reason', async () => {
    const r = await call('POST', '/generate', { raw: '' })
    assert(r.status === 400, `expected 400, got ${r.status}: ${r.text}`)
    assert(r.json.code === 'body-required', `wrong code: ${r.json.code}`)
  })

  await check('a wrong-typed chapter content is refused, not coerced', async () => {
    // `String({})` is "[object Object]": coercing replaced the whole chapter — front
    // matter and prose — with that one word, answered 200, and reported no validation
    // error, because a file with no front matter is not itself an error.
    const target = await freshChapter('内容类型测试', '原本的正文。')
    for (const content of [{}, [], 42, null, true]) {
      const r = await call('POST', '/document', { body: { root, path: target, content } })
      assert(r.status === 400, `content=${JSON.stringify(content)} should be refused, got ${r.status}`)
      assert(r.json.code === 'bad-content', `wrong code for ${JSON.stringify(content)}: ${r.json.code}`)
    }
    // And the chapter must be untouched by the refusals.
    const ok = await call('POST', '/document', {
      body: {
        root,
        path: target,
        content: `---\nid: ch-content-test\ntitle: 内容类型测试\norder: 99\nstatus: draft\ncharacters: []\nplaces: []\nsummary: ''\ncustom: {}\n---\n\n新的正文。\n`,
      },
    })
    assert(ok.status === 200, `a string content must be accepted: ${ok.text}`)
  })

  await check('a chapter with no front-matter id is reported, not silently accepted', async () => {
    // Such a chapter cannot be referenced, cannot be selected reliably, and used to make
    // chapter creation fail forever with 409. It is now an error the author can act on.
    const target = await freshChapter('无 id 测试', '原本的正文。')
    const r = await call('POST', '/document', { body: { root, path: target, content: '没有 front matter 的正文。' } })
    assert(r.status === 409, `expected the write gate to refuse, got ${r.status}: ${r.text}`)
    assert(r.json.code === 'validation-failed', `wrong code: ${r.json.code}`)
    const codes = (r.json.issues ?? []).map((issue) => issue.code)
    assert(codes.includes('missing-id'), `expected a missing-id issue, got ${codes.join(', ')}`)
  })

  await check('a wrong-typed document value is refused, not written', async () => {
    // `value: []` used to be written verbatim, wiping every entity, while the
    // validator's `list()` skipped the non-arrays in silence and reported zero errors.
    for (const value of [[], 'x', 42, null, true]) {
      const r = await call('POST', '/document', { body: { root, path: 'setting/characters.json', value } })
      assert(r.status === 400, `value=${JSON.stringify(value)} should be refused, got ${r.status}: ${r.text}`)
      assert(r.json.code === 'bad-value', `wrong code for ${JSON.stringify(value)}: ${r.json.code}`)
    }
    // The document must still be intact afterwards.
    const read = await call('GET', `/document?root=${encodeURIComponent(root)}&path=setting%2Fcharacters.json`)
    assert(read.status === 200, `the document must still be readable: ${read.text}`)
    assert(Array.isArray(read.json.value.characters), 'the characters collection must survive the refusals')
  })

  await check('a malformed document opens with a 422, not a 500', async () => {
    // The one file that needs hand-repair must be the file the editor CAN open. A 500 with
    // a raw parser error told the author nothing and gave the GUI no code to branch on.
    writeFileSync(join(projectDir, 'setting', 'items.json'), '{ "items": [ }', 'utf8')
    const r = await call('GET', `/document?root=${encodeURIComponent(root)}&path=setting%2Fitems.json`)
    assert(r.status === 422, `expected 422, got ${r.status}: ${r.text}`)
    assert(r.json.code === 'document-unparseable', `wrong code: ${r.json.code}`)
    assert(typeof r.json.error === 'string' && r.json.error.length > 0, 'the parser error must be included')
    // And the same file must still be reported as broken by /validate, not crash it.
    const check = await call('GET', `/validate?root=${encodeURIComponent(root)}`)
    assert(check.status === 200, `/validate must survive a broken document: ${check.text}`)
    // The property that matters: ONE corrupt document must not block work on the others.
    // `loadDocuments` catches the parse failure into `broken`, so unrelated writes proceed.
    const other = await call('POST', '/document', {
      body: { root, path: 'setting/world.json', value: { sections: [], rules: [] } },
    })
    assert(other.status === 200, `an unrelated write must still succeed, got ${other.status}: ${other.text}`)
    // And the corrupt file itself can be REPAIRED through the API, which is the whole point.
    const repair = await call('POST', '/document', {
      body: { root, path: 'setting/items.json', value: { categories: [], items: [] } },
    })
    assert(repair.status === 200, `the broken file must be repairable, got ${repair.status}: ${repair.text}`)
    const reopen = await call('GET', `/document?root=${encodeURIComponent(root)}&path=setting%2Fitems.json`)
    assert(reopen.status === 200, `the repaired file must open again: ${reopen.text}`)
  })

  await check('one unreadable chapter does not break every other write', async () => {
    // `loadChapters` is called by every write path, so an unreadable chapter used to make
    // EVERY save fail with a 500 — one bad file bricking the whole document set.
    const locked = join(projectDir, 'draft', 'ch-locked.md')
    writeFileSync(locked, '---\nid: ch-locked\ntitle: 锁住\n---\n\n正文。\n', 'utf8')
    // Deny-read is not reliably available in a test, so simulate the failing read by
    // making the path a DIRECTORY: `readText` on a directory throws EISDIR.
    rmSync(locked, { force: true })
    mkdirSync(locked, { recursive: true })
    try {
      const write = await call('POST', '/document', {
        body: { root, path: 'setting/world.json', value: { sections: [], rules: [] } },
      })
      assert(write.status === 200, `an unrelated write must still succeed, got ${write.status}: ${write.text}`)
      const list = await call('GET', `/chapters?root=${encodeURIComponent(root)}`)
      assert(list.status === 200, `the chapter list must still answer: ${list.text}`)
    } finally {
      rmSync(locked, { recursive: true, force: true })
    }
  })

  await check('a request body over the limit is refused', async () => {
    // Guard against a runaway client; the limit must produce a clear 413, not a hang.
    // The body has to exceed the host's 8 MiB ceiling to reach the branch at all.
    const huge = JSON.stringify({ kind: 'item', padding: 'x'.repeat(9 * 1024 * 1024) })
    const r = await call('POST', '/generate', { raw: huge })
    assert(r.status === 413, `expected 413, got ${r.status}: ${r.text}`)
    assert(r.json.code === 'body-too-large', `wrong code: ${r.json.code}`)
  })

  await check('a project may not be created over an existing one', async () => {
    const r = await call('POST', '/project/create', { body: { root, title: 'again' } })
    assert(r.status === 409, `expected 409, got ${r.status}: ${r.text}`)
    assert(r.json.code === 'project-exists', `wrong code: ${r.json.code}`)
  })

  await check('a missing project is reported as missing, not as unreadable', async () => {
    // Regression guard: `/chapters` used to answer 200 with an empty list for a
    // directory that is not a project, which made the client's specific guidance
    // ("点上方的「在此新建小说项目」") unreachable — the user just saw "0 章".
    const empty = mkdtempSync(join(tmpdir(), 'dsh-novel-empty-'))
    try {
      const r = await call('GET', `/chapters?root=${encodeURIComponent(empty)}`)
      assert(r.status === 404, `expected 404, got ${r.status}: ${r.text}`)
      assert(r.json.code === 'project-missing', `wrong code: ${r.json.code}`)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  await check('a chapter id that already exists is not overwritten', async () => {
    // Creating by an explicit id must refuse rather than clobber existing prose.
    const created = await call('POST', '/chapter', { body: { root, title: '撞名', id: 'ch-0001' } })
    assert(created.status === 409, `expected 409, got ${created.status}: ${created.text}`)
    assert(created.json.code === 'chapter-exists', `wrong code: ${created.json.code}`)
  })

  await check('a chapter with no id gets the next free one', async () => {
    // The counterpart: without an id the host must pick a free one, never reuse.
    const first = await call('POST', '/chapter', { body: { root, title: '自动编号甲' } })
    const second = await call('POST', '/chapter', { body: { root, title: '自动编号乙' } })
    assert(first.status === 201 && second.status === 201, `creates failed: ${first.status}/${second.status}`)
    assert(first.json.path !== second.json.path, 'two chapters must not share a path')
    const existing = readdirSync(join(projectDir, 'draft'))
    assert(existing.includes('ch-0001.md'), `unexpected draft contents: ${existing.join(', ')}`)
  })

  // ---- image assets (the map's imported backgrounds) ----------------------

  // A 1x1 PNG. Small, real, and exactly the shape a FileReader hands the client.
  const PNG_1X1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

  await check('an image can be imported and served back', async () => {
    const up = await call('POST', '/asset', { body: { root, name: 'world.png', data: PNG_1X1 } })
    assert(up.status === 200, `status ${up.status}: ${up.text}`)
    assert(up.json.asset === 'world.png', `wrong asset name: ${up.json.asset}`)
    assert(up.json.contentType === 'image/png', `wrong content type: ${up.json.contentType}`)
    // It must be on disk as real bytes, not a data URL in a text file.
    const abs = join(projectDir, 'setting', 'map', 'assets', 'world.png')
    const onDisk = readFileSync(abs)
    assert(onDisk.length === up.json.bytes, `size mismatch: file ${onDisk.length}, reported ${up.json.bytes}`)
    assert(onDisk.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'the PNG signature must survive the round trip')

    const got = await call('GET', `/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent('setting/map/assets/world.png')}`)
    assert(got.status === 200, `serve failed: ${got.status} ${got.text}`)
    assert(got.headers.get('content-type') === 'image/png', `wrong served type: ${got.headers.get('content-type')}`)
    // `call` parses JSON, so the binary body shows up as null; the text is the decoded bytes.
    assert(got.text.length > 0, 'the served body must not be empty')
  })

  await check('bare base64 is accepted, not only a data URL', async () => {
    // Both forms reach us in practice, and refusing the bare one would be a pointless papercut.
    const bare = PNG_1X1.slice(PNG_1X1.indexOf(',') + 1)
    const up = await call('POST', '/asset', { body: { root, name: 'bare.png', data: bare } })
    assert(up.status === 200, `status ${up.status}: ${up.text}`)
    assert(up.json.bytes > 0, 'bytes were decoded')
  })

  await check('the asset route refuses everything outside its one directory', async () => {
    // This route serves bytes to a browser, so the allow-list matters more here than anywhere
    // else in the API: without it, any project file becomes fetchable through an image URL.
    const cases = [
      ['project.json', 'asset-path-not-allowed'],
      ['setting/characters.json', 'asset-path-not-allowed'],
      ['../outside.png', 'asset-path-not-allowed'],
      ['setting/map/assets/../characters.json', 'asset-name-invalid'],
      ['setting/map/assets/deep.png', 'asset-missing'],
      ['setting/map/assets/x.exe', 'asset-type-not-allowed'],
      ['setting/map/assets/noextension', 'asset-type-not-allowed'],
      ['setting/map/assets/a:b.png', 'asset-name-invalid'],
    ]
    for (const [path, code] of cases) {
      const r = await call('GET', `/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
      assert(r.status !== 200, `${path} must not be served (got ${r.status})`)
      assert(r.json?.code === code, `${path}: expected ${code}, got ${r.json?.code ?? r.text.slice(0, 80)}`)
    }
  })

  await check('an import is refused unless it is a usable image', async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')
    const cases = [
      [{ name: 'x.png' }, 400, 'asset-data-required'],
      [{ name: 'x.png', data: '' }, 400, 'asset-data-required'],
      [{ name: 'x.png', data: 'not base64 !!!' }, 400, 'asset-data-invalid'],
      [{ name: 'x.png', data: '====' }, 400, 'asset-data-invalid'],
      [{ name: 'x.gif', data: PNG_1X1 }, 200, null],
      [{ name: 'x.exe', data: PNG_1X1 }, 400, 'asset-type-not-allowed'],
      [{ name: 'sub/x.png', data: PNG_1X1 }, 400, 'asset-name-invalid'],
      [{ name: 'x.png', data: oversized }, 413, 'asset-too-large'],
      [{ data: PNG_1X1 }, 400, 'asset-name-required'],
    ]
    for (const [body, status, code] of cases) {
      const r = await call('POST', '/asset', { body: { root, ...body } })
      assert(r.status === status, `${JSON.stringify(body).slice(0, 60)}: expected ${status}, got ${r.status} ${r.text.slice(0, 100)}`)
      if (code !== null) assert(r.json?.code === code, `${JSON.stringify(body).slice(0, 40)}: expected ${code}, got ${r.json?.code}`)
    }
  })

  await check('an import needs the write header', async () => {
    // Same gate as every other mutation: a cross-origin page must not be able to write files.
    const r = await call('POST', '/asset', { body: { root, name: 'x.png', data: PNG_1X1 }, headers: { 'x-dsh-novel': '' } })
    assert(r.status === 403, `status ${r.status}: ${r.text}`)
    assert(r.json.code === 'write-header-missing', `wrong code: ${r.json.code}`)
  })
  await check('a map pin pointing at a missing place is refused, and can be forced', async () => {
    // The map is new, so its validation coverage is worth pinning down: a pin's `placeId` is a
    // reference like any other, and `force` remains the author's escape hatch.
    const pinning = (placeId) => ({
      canvas: { width: 800, height: 600 },
      background: { kind: 'blank', asset: null },
      layers: [{ id: 'layer-1', name: '地形', strokes: [[[0, 0], [10, 10]]] }],
      pins: [{ id: 'pin-1', placeId, x: 10, y: 10, label: '山门' }],
    })
    const missing = await call('POST', '/document', { body: { root, path: 'setting/map/index.json', value: pinning('place-ghost') } })
    assert(missing.status === 409, `expected a refusal, got ${missing.status}: ${missing.text.slice(0, 160)}`)
    assert(missing.json.code === 'validation-failed', `wrong code: ${missing.json.code}`)
    assert(
      (missing.json.issues ?? []).some((issue) => issue.code === 'dangling-reference'),
      `the dangling pin must be named: ${JSON.stringify(missing.json.issues ?? []).slice(0, 200)}`,
    )

    const forced = await call('POST', '/document', { body: { root, path: 'setting/map/index.json', value: pinning('place-ghost'), force: true } })
    assert(forced.status === 200, `force should override: ${forced.status} ${forced.text.slice(0, 160)}`)

    // And a pin that names a real place is accepted without any override.
    const created = await call('POST', '/document', { body: { root, path: 'setting/places.json', value: { places: [{ id: 'place-real', name: '山门' }] } } })
    assert(created.status === 200, `place write failed: ${created.status} ${created.text.slice(0, 160)}`)
    const good = await call('POST', '/document', { body: { root, path: 'setting/map/index.json', value: pinning('place-real') } })
    assert(good.status === 200, `a valid pin must be accepted: ${good.status} ${good.text.slice(0, 160)}`)

    // The stroke and canvas survive the round trip unchanged — the map is the one document with
    // nested numeric arrays, so it is the one that could quietly reshape.
    const read = await call('GET', `/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent('setting/map/index.json')}`)
    assert(read.json.value.layers[0].strokes[0][1][0] === 10, `stroke coordinates were altered: ${JSON.stringify(read.json.value.layers)}`)
    assert(read.json.value.canvas.width === 800, 'the canvas width must round-trip')
  })
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}

const total = passed + failures.length
if (failures.length === 0) {
  console.log(`OK  ${passed}/${total} API checks passed`)
  process.exit(0)
}
console.log(`FAIL  ${passed}/${total} API checks passed`)
for (const failure of failures) {
  console.log(`\n  ✗ ${failure.name}\n    ${failure.message}`)
}
process.exit(1)
