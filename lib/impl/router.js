/**
 * The whole HTTP surface of the plugin.
 *
 * `lib/index.js` registers ONE prefix route and hands every request here, so
 * routing and logic both live inside the cache-busted impl tree: editing this
 * file (or any sibling) takes effect on the next request, with no host restart.
 * That is the whole reason the modules below import each other through the
 * injected `load` instead of a static `import`.
 *
 * Write safety, in the order the checks run:
 *   1. a custom header, so a cross-origin page cannot drive-by write;
 *   2. the root must be an existing absolute directory;
 *   3. the path must stay inside `<root>/novel/` (see paths.js);
 *   4. the path must be a document the schema knows about;
 *   5. the write must not introduce NEW validation errors.
 *
 * Step 5 compares before/after rather than demanding a clean project: a novel
 * under construction legitimately has dangling references, and refusing every
 * save until the whole world is consistent would make the app unusable.
 */

import { join, dirname } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PREFIX = '/dsh-novel'
/** Required on every mutation: forces a CORS preflight cross-origin. */
const WRITE_HEADER = 'x-dsh-novel'
const BODY_LIMIT = 8 * 1024 * 1024

/**
 * The last requests this router served, newest last.
 *
 * Bounded, in-memory, and exposed at `GET /requests`. It exists because the host
 * process's stdout is not reachable while the desktop app is running, so when a
 * request fails for a reason the user cannot describe precisely — a blank `root`
 * arriving from a client the developer cannot see — there is otherwise no way to
 * find out what actually arrived.
 */
const RECENT_LIMIT = 40
const recentRequests = []

function httpError(status, code, message, details) {
  const error = new Error(message)
  error.httpStatus = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function sendJson(response, status, body) {
  if (response.headersSent) {
    response.end()
    return
  }
  const text = JSON.stringify(body, null, 2)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * Read a request body, refusing anything past `limit`.
 *
 * The refusal is delivered by the same mechanism as every other error, which means
 * the socket must survive long enough to carry it. Two failed attempts are worth
 * recording, because both looked correct:
 *
 *   - `request.destroy()` immediately after rejecting tore the socket down before the
 *     413 could be written, so the caller saw a bare network error instead of the
 *     reason. Worse, `fetch` pools connections, so the NEXT request failed too.
 *   - `request.pause()` plus a destroy-on-finish delivered the 413 but still killed a
 *     pooled connection, breaking the following request.
 *
 * So the body is DRAINED but not accumulated: memory stays bounded (the chunks array
 * is dropped at the limit), the request completes normally, and the connection stays
 * healthy for reuse.
 */
function readBody(request, limit = BODY_LIMIT) {
  return new Promise((resolvePromise, rejectPromise) => {
    let chunks = []
    let size = 0
    let overflow = false
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        if (!overflow) {
          overflow = true
          chunks = []
        }
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (overflow) {
        rejectPromise(httpError(413, 'body-too-large', `request body exceeds ${limit} bytes`))
        return
      }
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', (error) => rejectPromise(error))
  })
}

async function readJsonBody(request) {
  const raw = await readBody(request)
  if (raw.trim() === '') throw httpError(400, 'body-required', 'a JSON body is required')
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object')
    }
    return parsed
  } catch (error) {
    throw httpError(400, 'body-invalid', `request body is not valid JSON: ${error.message}`)
  }
}

/** Mutations require the custom header. See the module comment, step 1. */
function assertWriteAllowed(request) {
  if (request.headers[WRITE_HEADER] !== '1') {
    throw httpError(403, 'write-header-missing',
      `mutating requests must send the "${WRITE_HEADER}: 1" header`)
  }
}

/** Project-relative paths a JSON write may target. */
function assertKnownDocument(schema, rel) {
  const known = new Set(Object.values(schema.FILES))
  if (!known.has(rel)) {
    throw httpError(400, 'path-not-a-document',
      `"${rel}" is not a project document; known documents: ${[...known].join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Project reading
// ---------------------------------------------------------------------------

function projectContext(modules, rawRoot) {
  const root = modules.paths.resolveRoot(rawRoot, {
    exists: modules.store.exists,
    isDirectory: modules.store.isDirectory,
  })
  return { root, projectDir: join(root, modules.schema.DATA_DIR) }
}

/** Read every JSON document that exists. Parse failures travel as `broken`. */
function loadDocuments(modules, projectDir) {
  const docs = {}
  const broken = []
  for (const rel of Object.values(modules.schema.FILES)) {
    const abs = join(projectDir, rel)
    if (!modules.store.exists(abs)) continue
    try {
      docs[rel] = modules.store.readJson(abs)
    } catch (error) {
      broken.push({ path: rel, error: error.message })
    }
  }
  return { docs, broken }
}

/** Read every `draft/*.md` chapter, with its front matter parsed. */
function loadChapters(modules, projectDir) {
  const dir = join(projectDir, 'draft')
  if (!modules.store.exists(dir)) return []
  const { entries } = modules.store.listTree(dir, 1, { maxEntries: 5000 })
  const chapters = []
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.path.toLowerCase().endsWith('.md')) continue
    // Read failures are contained PER FILE. `loadChapters` is called by every write path,
    // so one locked or unreadable chapter used to make EVERY save in the project fail with
    // a 500 — one bad file bricking the whole document set, with nothing to explain it.
    let text = null
    let readError = null
    try {
      text = modules.store.readText(join(dir, entry.path))
    } catch (error) {
      readError = String(error?.message ?? error)
    }
    if (readError !== null) {
      chapters.push({
        path: `draft/${entry.path}`,
        meta: { error: `无法读取这个章节文件：${readError}` },
        body: '',
        unreadable: true,
      })
      continue
    }
    const parsed = modules.frontmatter.parseFrontMatter(text)
    chapters.push({
      path: `draft/${entry.path}`,
      meta: { ...parsed.meta, error: parsed.error },
      body: parsed.body,
    })
  }
  return chapters
}

function validateState(modules, docs, chapters) {
  return modules.validate.validateProject({ docs, chapters })
}

const signature = (issue) => `${issue.code}|${issue.path}|${(issue.ids ?? []).join(',')}`

/** Errors present after a change that were not present before it. */
function newErrors(before, after) {
  const seen = new Set(before.issues.filter((i) => i.level === 'error').map(signature))
  return after.issues.filter((i) => i.level === 'error' && !seen.has(signature(i)))
}

/** Next free `ch-NNNN` id and its filename. */
/**
 * The next free chapter id.
 *
 * Scans the FILENAMES as well as the front-matter ids, because they can disagree: a
 * chapter whose front matter is missing or unreadable still owns `draft/ch-0001.md`, and
 * deriving the next id from front matter alone recomputes an id whose file already
 * exists — so `chapter-exists` fires, every retry recomputes the same id, and chapter
 * creation is blocked permanently with no way out from the UI.
 */
function nextChapterId(chapters) {
  let max = 0
  const taken = new Set()
  for (const chapter of chapters) {
    if (typeof chapter?.path === 'string') taken.add(chapter.path)
    const match = /^ch-(\d+)$/.exec(String(chapter?.meta?.id ?? ''))
    if (match) max = Math.max(max, Number(match[1]))
    const fromPath = /^draft\/ch-(\d+)\.md$/.exec(String(chapter?.path ?? ''))
    if (fromPath) max = Math.max(max, Number(fromPath[1]))
  }
  for (let n = max + 1; n < 100000; n += 1) {
    const id = `ch-${String(n).padStart(4, '0')}`
    const rel = `draft/${id}.md`
    if (!taken.has(rel)) return { id, rel }
  }
  // Practically unreachable, but a silent collision would be worse than an odd id.
  const id = `ch-${Date.now()}`
  return { id, rel: `draft/${id}.md` }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Impl module mtimes — the evidence that hot reload is working. */
function implInfo() {
  try {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { dir, files }
  } catch (error) {
    return { error: error.message }
  }
}

/**
 * What the optional host services actually offer.
 *
 * Reported rather than assumed: the plugin binds `workspaceRegistry`, `llm` and
 * `sessionController` independently, and a service that never resolved leaves no
 * trace anywhere else. Without this, "the AI button does nothing" would have no
 * diagnosable cause.
 */
function describeServices(services) {
  const report = {}
  for (const name of ['workspaceRegistry', 'llm', 'sessionController']) {
    const service = services[name]
    report[name] = service === undefined || service === null ? null : typeof service
  }
  const llm = services.llm
  if (llm !== undefined && llm !== null) {
    // The provider and model ids the composition actually offers, so a caller
    // never has to hard-code a guess like 'deepseek-account'.
    try {
      report.llmProviders = typeof llm.listProviders === 'function' ? llm.listProviders() : null
    } catch (error) {
      report.llmProviders = `error: ${error.message}`
    }
    report.llmMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(llm)).filter(
      (name) => name !== 'constructor' && typeof llm[name] === 'function',
    )
  }
  const controller = services.sessionController
  if (controller !== undefined && controller !== null) {
    report.sessionControllerMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(controller)).filter(
      (name) => name !== 'constructor' && typeof controller[name] === 'function',
    )
  }
  return report
}

function handleHealth({ response, modules, services }) {
  sendJson(response, 200, {
    ok: true,
    route: 'health',
    plugin: 'dsh-novel',
    schemaVersion: modules.schema.SCHEMA_VERSION,
    dataDir: modules.schema.DATA_DIR,
    writeHeader: WRITE_HEADER,
    host: {
      pid: process.pid,
      platform: process.platform,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      cwd: process.cwd(),
      dshHome: process.env.DSH_HOME ?? null,
    },
    services: describeServices(services),
    impl: implInfo(),
  })
}

async function handleProjectCreate({ request, response, modules }) {
  assertWriteAllowed(request)
  const body = await readJsonBody(request)
  const { root, projectDir } = projectContext(modules, body.root)

  const marker = join(projectDir, modules.schema.FILES.project)
  if (modules.store.exists(marker)) {
    throw httpError(409, 'project-exists',
      `a project already exists at ${projectDir}; refusing to overwrite it`)
  }

  const plan = modules.scaffold.planScaffold({
    schema: modules.schema,
    title: body.title ?? '',
    now: new Date().toISOString(),
  })

  for (const dir of plan.dirs) modules.store.ensureDir(join(projectDir, dir))
  for (const file of plan.files) {
    const target = modules.paths.resolveInside(projectDir, file.rel)
    modules.store.writeJsonAtomic(target.abs, file.value)
  }

  const { docs, broken } = loadDocuments(modules, projectDir)
  const chapters = loadChapters(modules, projectDir)
  const report = validateState(modules, docs, chapters)
  sendJson(response, 201, {
    ok: true,
    route: 'project/create',
    root,
    projectDir,
    created: plan.files.map((f) => f.rel),
    dirs: plan.dirs,
    calendar: plan.calendar,
    broken,
    validation: report,
  })
}

function handleProjectGet({ response, modules, url }) {
  const { root, projectDir } = projectContext(modules, url.searchParams.get('root'))
  if (!modules.store.exists(join(projectDir, modules.schema.FILES.project))) {
    throw httpError(404, 'project-missing', `no project.json under ${projectDir}`)
  }
  const { docs, broken } = loadDocuments(modules, projectDir)
  const chapters = loadChapters(modules, projectDir)
  const tree = modules.store.listTree(projectDir, 3)
  sendJson(response, 200, {
    ok: true,
    route: 'project',
    root,
    projectDir,
    summary: modules.scaffold.summarizeProject({
      project: docs[modules.schema.FILES.project],
      entries: tree.entries,
    }),
    tree,
    broken,
    chapterCount: chapters.length,
  })
}

function handleDocumentGet({ response, modules, url }) {
  const { projectDir } = projectContext(modules, url.searchParams.get('root'))
  const { abs, rel } = modules.paths.resolveInside(projectDir, url.searchParams.get('path'))
  if (!modules.store.exists(abs)) {
    throw httpError(404, 'document-missing', `no such document: ${rel}`)
  }
  const stat = modules.store.statOrNull(abs)
  if (modules.schema.isChapterPath(rel)) {
    let text = null
    try {
      text = modules.store.readText(abs)
    } catch (error) {
      throw httpError(422, 'document-unreadable',
        `无法读取 ${rel}：${error?.message ?? error}`, { path: rel })
    }
    const parsed = modules.frontmatter.parseFrontMatter(text)
    sendJson(response, 200, {
      ok: true, route: 'document', path: rel, kind: 'chapter', stat,
      meta: parsed.meta, body: parsed.body, frontMatterError: parsed.error,
    })
    return
  }
  let value = null
  try {
    value = modules.store.readJson(abs)
  } catch (error) {
    // 422 with the parser's own words, not a bare 500. A malformed document is precisely
    // the file an author needs to OPEN in order to repair it, and `loadDocuments` already
    // reports it as `broken` elsewhere — so a 500 here made the one file that needs fixing
    // the one file the editor could not open.
    throw httpError(422, 'document-unparseable',
      `${rel} 不是合法的 JSON，无法打开：${error?.message ?? error}`, { path: rel })
  }
  sendJson(response, 200, {
    ok: true, route: 'document', path: rel, kind: 'json', stat,
    value,
  })
}

async function handleDocumentPost({ request, response, modules }) {
  assertWriteAllowed(request)
  const body = await readJsonBody(request)
  const { projectDir } = projectContext(modules, body.root)
  const { abs, rel } = modules.paths.resolveInside(projectDir, body.path)

  const before = loadDocuments(modules, projectDir)
  const chaptersBefore = loadChapters(modules, projectDir)
  const beforeReport = validateState(modules, before.docs, chaptersBefore)

  let after
  if (modules.schema.isChapterPath(rel)) {
    if (body.meta === undefined && body.content === undefined) {
      throw httpError(400, 'body-incomplete', 'a chapter write needs "meta" (with optional "body") or "content"')
    }
    if (body.content !== undefined && typeof body.content !== 'string') {
      // `String({})` is `"[object Object]"` and `String(null)` is `"null"`. Coercing a
      // wrong type here REPLACES the whole chapter — front matter and prose — with that
      // one word, returns 200, and reports no validation error, because a file with no
      // front matter is not itself an error. Silent destruction of the author's work,
      // so it is refused by type instead.
      throw httpError(400, 'bad-content', `chapter "content" must be a string (received ${typeof body.content})`)
    }
    const text = body.content !== undefined
      ? body.content
      : modules.frontmatter.serializeFrontMatter(body.meta ?? {}, body.body ?? '')
    const parsed = modules.frontmatter.parseFrontMatter(text)
    const chaptersAfter = chaptersBefore
      .filter((chapter) => chapter.path !== rel)
      .concat([{ path: rel, meta: { ...parsed.meta, error: parsed.error }, body: parsed.body }])
    after = { text, report: validateState(modules, before.docs, chaptersAfter) }
  } else {
    assertKnownDocument(modules.schema, rel)
    if (body.value === undefined) {
      throw httpError(400, 'body-incomplete', 'a JSON document write needs "value"')
    }
    // Every document is an object with named collections. An array or a scalar is not a
    // document: `value: []` used to be written verbatim, wiping every entity, while
    // `list()` in the validator skipped the non-arrays in silence and reported ZERO
    // errors — so the API answered 200 to the loss of a whole file.
    if (body.value === null || typeof body.value !== 'object' || Array.isArray(body.value)) {
      throw httpError(400, 'bad-value', `document "value" must be a JSON object (received ${
        body.value === null ? 'null' : Array.isArray(body.value) ? 'array' : typeof body.value
      })`)
    }
    if (rel === modules.schema.FILES.project) {
      body.value.updatedAt = new Date().toISOString()
    }
    const docsAfter = { ...before.docs, [rel]: body.value }
    after = { text: `${JSON.stringify(body.value, null, 2)}\n`, report: validateState(modules, docsAfter, chaptersBefore) }
  }

  const introduced = newErrors(beforeReport, after.report)
  if (introduced.length > 0 && body.force !== true) {
    throw httpError(409, 'validation-failed',
      `refusing to write ${rel}: it would introduce ${introduced.length} validation error(s)`,
      { issues: introduced })
  }

  modules.store.writeTextAtomic(abs, after.text)
  sendJson(response, 200, {
    ok: true, route: 'document', path: rel,
    bytes: Buffer.byteLength(after.text),
    introducedErrors: introduced.length,
    validation: after.report,
    broken: before.broken,
  })
}

async function handleChapterCreate({ request, response, modules }) {
  assertWriteAllowed(request)
  const body = await readJsonBody(request)
  const { projectDir } = projectContext(modules, body.root)
  const chapters = loadChapters(modules, projectDir)

  const existing = body.id !== undefined
    ? { id: String(body.id), rel: `draft/${String(body.id)}.md` }
    : nextChapterId(chapters)
  const target = modules.paths.resolveInside(projectDir, existing.rel)
  if (modules.store.exists(target.abs)) {
    throw httpError(409, 'chapter-exists', `chapter already exists: ${existing.rel}`)
  }

  const meta = modules.frontmatter.newChapterMeta({
    id: existing.id,
    title: body.title ?? existing.id,
    order: body.order ?? (chapters.length + 1) * 10,
  })
  const text = modules.frontmatter.serializeFrontMatter(meta, body.body ?? '')
  modules.store.writeTextAtomic(target.abs, text)

  const chaptersAfter = chapters.concat([{ path: existing.rel, meta, body: body.body ?? '' }])
  const { docs } = loadDocuments(modules, projectDir)
  sendJson(response, 201, {
    ok: true, route: 'chapter/create', path: existing.rel, meta,
    validation: validateState(modules, docs, chaptersAfter),
  })
}

function handleValidate({ response, modules, url }) {
  const { root, projectDir } = projectContext(modules, url.searchParams.get('root'))
  const { docs, broken } = loadDocuments(modules, projectDir)
  const chapters = loadChapters(modules, projectDir)
  const report = validateState(modules, docs, chapters)
  // 200 either way: the request succeeded, and the findings are the payload.
  sendJson(response, 200, {
    ok: true, route: 'validate', root, projectDir, broken, ...report,
  })
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Candidate project roots: DSH's own registered workspaces.
 *
 * The plugin keeps no parallel project list. DSH's workspace registry already
 * provides an ordered, durable, titled list of project directories, and
 * sessions already group under it — so a novel project is simply a workspace
 * that contains `novel/project.json`. The user therefore reaches a novel
 * project from the same project list they already use, instead of maintaining
 * a second one that can disagree with it.
 */
function handleWorkspaces({ response, modules, services }) {
  const registry = services.workspaceRegistry
  if (registry === undefined || typeof registry.list !== 'function') {
    sendJson(response, 200, {
      ok: true,
      route: 'workspaces',
      available: false,
      reason: 'the host composes no workspaceRegistry service; pass an explicit root instead',
      workspaces: [],
    })
    return
  }
  let entities
  try {
    entities = registry.list()
  } catch (error) {
    throw httpError(500, 'workspace-list-failed', `workspaceRegistry.list() failed: ${error.message}`)
  }
  const workspaces = entities.map((workspace) => {
    const path = workspace.path
    const projectDir = join(path, modules.schema.DATA_DIR)
    return {
      id: workspace.id,
      path,
      title: workspace.title,
      createdAt: workspace.createdAt ?? null,
      sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : null,
      project: {
        dir: projectDir,
        initialized: modules.store.exists(join(projectDir, modules.schema.FILES.project)),
      },
    }
  })
  sendJson(response, 200, { ok: true, route: 'workspaces', available: true, workspaces })
}

/**
 * Every chapter with its parsed front matter and a derived word count.
 *
 * One request rather than one per chapter: a browser-side loop would cost N
 * round trips and re-implement front-matter parsing in a second place. Word
 * count is computed here because it is derived data and never stored
 * (docs/data-model.md principle 2).
 */
function handleChapters({ response, modules, url }) {
  const { root, projectDir } = projectContext(modules, url.searchParams.get('root'))
  // A directory that is not a project must SAY so. The client has a specific message
  // for this code ("点上方的「在此新建小说项目」"), and returning an empty list made
  // it unreachable: the user saw "0 章 · 0 字" with no hint of what to do next.
  if (!modules.store.exists(join(projectDir, modules.schema.FILES.project))) {
    throw httpError(404, 'project-missing', `no project.json under ${projectDir}`)
  }
  const chapters = loadChapters(modules, projectDir)
    .map((chapter) => ({
      path: chapter.path,
      id: chapter.meta?.id ?? null,
      title: chapter.meta?.title ?? '',
      order: Number.isFinite(Number(chapter.meta?.order)) ? Number(chapter.meta.order) : null,
      status: chapter.meta?.status ?? null,
      characters: Array.isArray(chapter.meta?.characters) ? chapter.meta.characters : [],
      places: Array.isArray(chapter.meta?.places) ? chapter.meta.places : [],
      summary: chapter.meta?.summary ?? '',
      wordCount: modules.text.countWords(chapter.body),
      frontMatterError: chapter.meta?.error ?? null,
    }))
    // Narrative order, not filename order: `order` is what the author controls
    // and it is spaced so chapters can be inserted between existing ones.
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.path).localeCompare(String(b.path)))

  const total = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0)
  sendJson(response, 200, {
    ok: true,
    route: 'chapters',
    root,
    projectDir,
    totalWordCount: total,
    chapters,
  })
}

/**
 * Resolve a generator by kind.
 *
 * Generators are declared once, in `prompt.js` — a kind is a table entry there,
 * not a prompt builder and a sanitiser here. This function only reports a bad kind
 * in terms the client can act on.
 */
function resolveGenerator(modules, kind) {
  const generators = modules.prompt.GENERATORS
  const generator = generators[kind]
  if (generator === undefined) {
    throw httpError(400, 'unknown-generator', `未知的生成类型：${kind}（可用：${Object.keys(generators).join(', ')}）`)
  }
  return generator
}

/** Every provider with the models it serves. Shared by `/models` and `/generate`. */
async function listModelsOf(llm) {
  const providers = typeof llm.listProviders === 'function' ? await llm.listProviders() : []
  const models = {}
  for (const provider of providers) {
    const id = provider?.id
    if (typeof id !== 'string') continue
    try {
      const listed = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
      models[id] = (Array.isArray(listed) ? listed : []).map((entry) =>
        typeof entry === 'string' ? { id: entry, name: entry } : { id: entry?.id ?? null, name: entry?.name ?? entry?.id ?? null },
      )
    } catch (error) {
      models[id] = { error: String(error?.message ?? error) }
    }
  }
  return { providers, models }
}

/**
 * Default provider and model when the caller names none.
 *
 * Prefers the account provider the agent itself uses — the credentials the user
 * already signed in with — and the cheaper model, because a one-shot generation
 * does not need the strong one.
 */
function pickDefaultModel(models) {
  const ids = Object.keys(models).filter((id) => Array.isArray(models[id]))
  if (ids.length === 0) return { provider: null, model: null }
  const provider = ids.find((id) => id.includes('account')) ?? ids[0]
  const list = models[provider]
  const model = list.find((entry) => String(entry.id).includes('flash')) ?? list[0]
  return { provider, model: model === null || model === undefined ? null : model.id }
}

/**
 * Run one completion and assemble its visible text.
 *
 * The chunk vocabulary belongs to the host, and the field is `type` — not `kind`,
 * which is what an earlier version assumed, collecting nothing and reporting only
 * "no JSON found". The stream is also observed here (`types`, `blockTypes`,
 * `samples`) because a plugin cannot read the host's source at the point of
 * failure: recording what actually arrived is what turned an unexplained empty
 * string into a one-line fix.
 *
 * Only `text-delta` is accumulated. Reasoning models emit `reasoning-delta` blocks
 * first, and the model's thinking is not the answer — collecting it would put
 * scratch work into a document.
 */
async function collectCompletion(llm, { provider, model, system, user }) {
  const stream = await llm.stream({
    provider,
    model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: system }] },
      { role: 'user', content: [{ type: 'text', text: user }] },
    ],
  })

  let text = ''
  let failure = null
  let usage = null
  const types = []
  const blockTypes = []
  const samples = []

  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') {
      if (samples.length < 2) samples.push({ nonObject: typeof chunk })
      continue
    }
    // `type` is the real discriminator; `kind` is accepted as a fallback so a
    // host that renames it degrades instead of silently collecting nothing.
    const type = chunk.type ?? chunk.kind ?? null
    if (!types.includes(type)) types.push(type)
    if (chunk.blockType !== undefined && !blockTypes.includes(chunk.blockType)) blockTypes.push(chunk.blockType)
    if (samples.length < 2) {
      let preview = null
      try {
        preview = JSON.stringify(chunk).slice(0, 400)
      } catch {
        preview = '<unserialisable>'
      }
      samples.push({ type, preview })
    }

    if (type === 'error' || type === 'aborted') {
      failure = chunk.failure ?? { code: type }
      break
    }
    if (type === 'usage') usage = chunk.usage ?? chunk
    if (type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }

  return { text, failure, usage, types, blockTypes, samples }
}

/**
 * Generate one entity with a model and return it for review.
 *
 * Deliberately does NOT write: the result goes back to the client as a draft that
 * the author accepts or discards. A generator that saved directly would put
 * unreviewed model output into a novel and consume quota without the author
 * seeing what they paid for.
 */
async function handleGenerate({ request, response, modules, services }) {
  assertWriteAllowed(request)
  const body = await readJsonBody(request)

  // Request validation BEFORE the dependency check: an unknown kind is a
  // malformed request whatever the host happens to have composed, and reporting
  // "no llm service" for a typo sends the caller after the wrong problem.
  const kind = typeof body.kind === 'string' && body.kind !== '' ? body.kind : 'item'
  const generator = resolveGenerator(modules, kind)

  const llm = services.llm
  if (llm === undefined || llm === null) {
    throw httpError(503, 'llm-unavailable', '宿主没有组合 llm 服务，无法调用模型')
  }

  let provider = typeof body.provider === 'string' && body.provider !== '' ? body.provider : null
  let model = typeof body.model === 'string' && body.model !== '' ? body.model : null
  if (provider === null || model === null) {
    const { models } = await listModelsOf(llm)
    const fallback = pickDefaultModel(models)
    provider = provider ?? fallback.provider
    model = model ?? fallback.model
  }
  if (provider === null || model === null) {
    throw httpError(503, 'no-model', '宿主没有提供任何可用模型')
  }

  // The project's own setting, so the result fits this novel. `useContext: false`
  // lets a caller generate something deliberately unrelated to it.
  let context = ''
  let contextError = null
  if (body.useContext !== false) {
    try {
      const { root } = projectContext(modules, body.root)
      const { docs } = loadDocuments(modules, join(root, modules.schema.DATA_DIR))
      context = modules.context.buildWorldContext(docs, generator)
    } catch (error) {
      // A missing or unreadable project must not break generation: an
      // ungrounded draft is useful, a hard failure is not.
      contextError = String(error?.message ?? error)
    }
  }

  const style =
    typeof body.style === 'string' && body.style !== '' ? body.style : modules.prompt.resolveStyle(body.styleId)

  const prompt = modules.prompt.buildPrompt(generator, {
    hint: body.hint ?? '',
    context,
    style,
    count: Number.isInteger(body.count) ? body.count : 1,
  })
  const completion = await collectCompletion(llm, { provider, model, system: prompt.system, user: prompt.user })

  if (completion.failure !== null) {
    const code = completion.failure?.code ?? completion.failure?.failure?.code ?? 'model-failed'
    throw httpError(502, 'model-failed', `模型调用失败：${code}`, { provider, model, failure: completion.failure })
  }

  const parsed = modules.prompt.extractJsonObject(completion.text)
  if (parsed.error !== null) {
    throw httpError(502, 'unparseable-response', `无法从模型响应里取出 JSON：${parsed.error}`, {
      provider,
      model,
      // The observed chunk vocabulary is the only thing that explains an empty
      // collection, so it travels with the failure rather than only with success.
      chunkTypes: completion.types,
      blockTypes: completion.blockTypes,
      chunkSamples: completion.samples,
      textLength: completion.text.length,
      usage: completion.usage,
      raw: completion.text.slice(0, 800),
    })
  }

  const base = body.base !== null && typeof body.base === 'object' && !Array.isArray(body.base) ? body.base : {}

  // Sanitise every candidate; `value` is the first so a single-candidate caller
  // need not know about the list.
  const candidates = modules.prompt
    .extractCandidates(parsed.value)
    .slice(0, prompt.count)
    .map((candidate) => modules.prompt.sanitizeByFields(candidate, base, generator))

  if (candidates.length === 0) {
    throw httpError(502, 'no-candidates', '模型返回了 JSON，但里面没有可用的候选', {
      provider,
      model,
      raw: completion.text.slice(0, 800),
    })
  }

  sendJson(response, 200, {
    ok: true,
    route: 'generate',
    kind,
    label: generator.label,
    provider,
    model,
    value: candidates[0],
    candidates,
    // The exact model-visible input, so a generated value stays auditable, and the
    // digest of the project setting it was grounded in.
    prompt: modules.prompt.promptRecord(prompt),
    contextUsed: context !== '',
    contextError,
    usage: completion.usage,
    diagnostics: {
      chunkTypes: completion.types,
      blockTypes: completion.blockTypes,
      textLength: completion.text.length,
      raw: completion.text.slice(0, 400),
    },
  })
}

/**
 * The whole book, assembled into one document.
 *
 * The chapters are read HERE, not in the browser: each is a file, and asking the browser for forty of them
 * to paste together would put the reading on the slow side of the boundary and the assembly outside the
 * offline suite. `buildManuscript` is a pure function of what is read, so the exact bytes of a finished
 * book are asserted in `impl-selftest.mjs`.
 *
 * `skipped` is not decoration: a chapter that could not be read must be visible. A manuscript that
 * silently omits chapter twelve is worse than one that refuses to export.
 */
function handleManuscript({ response, modules, url }) {
  const { projectDir } = projectContext(modules, url.searchParams.get('root'))
  if (!modules.store.exists(join(projectDir, modules.schema.FILES.project))) {
    throw httpError(404, 'project-missing', `no project.json under ${projectDir}`)
  }
  let projectTitle = ''
  try {
    const project = JSON.parse(modules.store.readText(join(projectDir, modules.schema.FILES.project)))
    projectTitle = typeof project?.title === 'string' ? project.title : ''
  } catch {
    // A project.json that cannot be read is no reason to refuse the manuscript: the chapters are what the
    // author asked for, and the title page falls back to 未命名.
  }
  const flag = (name, fallback) => {
    const value = url.searchParams.get(name)
    return value === null ? fallback : value === '1' || value === 'true'
  }
  const built = modules.manuscript.buildManuscript({
    chapters: loadChapters(modules, projectDir),
    projectTitle,
    options: {
      titlePage: flag('titlePage', true),
      summary: flag('summary', false),
      meta: flag('meta', false),
      headingLevel: Number(url.searchParams.get('headingLevel')) === 1 ? 1 : 2,
    },
  })
  sendJson(response, 200, {
    ok: true,
    route: 'manuscript',
    name: modules.manuscript.manuscriptName(projectTitle),
    ...built,
  })
}

/**
 * Write the assembled book into the project, and say where it went.
 *
 * WHY THIS EXISTS RATHER THAN A DOWNLOAD. The first version only handed the browser a Blob, and the author's
 * report was exactly right: 「导出的文件没有给出地址，无法找到」. A page cannot know the download directory, so
 * the only honest way to give a file an ADDRESS is to put it where an address means something — inside the
 * project, beside the novel it was made from. The download stays as the second option, labelled with where it
 * actually goes.
 *
 * It lands in `export/`, which is not in `FILES`, so nothing scans it: not the chapter loader (`.md` under
 * `draft/`), not the validator's allow-list, not the backup naming. Overwriting is correct here — the file is
 * derived, and re-exporting is how it is updated — and `.prev` still keeps one generation back.
 */
async function handleManuscriptWrite({ request, response, modules }) {
  assertWriteAllowed(request)
  const body = await readJsonBody(request)
  const { projectDir } = projectContext(modules, body.root)
  if (!modules.store.exists(join(projectDir, modules.schema.FILES.project))) {
    throw httpError(404, 'project-missing', `no project.json under ${projectDir}`)
  }
  let projectTitle = ''
  try {
    const project = JSON.parse(modules.store.readText(join(projectDir, modules.schema.FILES.project)))
    projectTitle = typeof project?.title === 'string' ? project.title : ''
  } catch {
    /* a title page of 未命名 beats refusing to write the chapters */
  }
  const flag = (name, fallback) => (body[name] === undefined || body[name] === null ? fallback : body[name] === true)
  const built = modules.manuscript.buildManuscript({
    chapters: loadChapters(modules, projectDir),
    projectTitle,
    options: {
      titlePage: flag('titlePage', true),
      summary: flag('summary', false),
      meta: flag('meta', false),
      headingLevel: Number(body.headingLevel) === 1 ? 1 : 2,
    },
  })
  // The name is sanitised (a title containing `/` would otherwise be a path), and `resolveInside` is the same
  // fence every other write goes through — so however the title reads, this cannot reach outside the project.
  const relative = `export/${modules.manuscript.manuscriptName(projectTitle)}`
  let absolute = null
  try {
    // `resolveInside` answers `{ abs, rel }` — it also normalises the path it checked, which is the one worth
    // reporting back.
    absolute = modules.paths.resolveInside(projectDir, relative).abs
  } catch (error) {
    throw httpError(400, 'bad-export-path', `cannot write the manuscript there: ${error?.message ?? error}`)
  }
  modules.store.ensureDir(dirname(absolute))
  modules.store.keepPrevious(absolute)
  modules.store.writeTextAtomic(absolute, built.text)
  sendJson(response, 200, {
    ok: true,
    route: 'manuscript',
    // BOTH FORMS. The relative one is what the rest of these docs use; the absolute one is what the author
    // needs in order to actually open the file.
    relative: `novel/${relative}`,
    absolute,
    bytes: Buffer.byteLength(built.text, 'utf8'),
    name: modules.manuscript.manuscriptName(projectTitle),
    ...built,
  })
}

/**
 * What generation can use: providers, models, style presets, and the kinds that
 * have a generator.
 *
 * One endpoint rather than three, because a pane that offers generation needs all
 * of it at once. Exposed rather than hard-coded into the client: a model id that
 * no adapter serves fails at call time with `NO_ADAPTER`, and a style preset
 * duplicated in the client would silently drift from the wording the host sends.
 */
async function handleCatalog({ response, modules, services }) {
  const catalogue = modules.prompt.catalogue()
  const llm = services.llm
  if (llm === undefined || llm === null) {
    sendJson(response, 200, {
      ok: true,
      route: 'catalog',
      available: false,
      reason: 'the host composes no llm service',
      providers: [],
      models: {},
      ...catalogue,
    })
    return
  }
  const { providers, models } = await listModelsOf(llm)
  sendJson(response, 200, { ok: true, route: 'catalog', available: true, providers, models, ...catalogue })
}

/** The last `limit` characters of a string, trimmed at a sentence-ish boundary. */
function tailOf(text, limit) {
  const source = typeof text === 'string' ? text.trim() : ''
  if (source.length <= limit) return source
  const cut = source.slice(source.length - limit)
  // Start at the first line break so the model does not receive half a sentence
  // as its opening context.
  const newline = cut.indexOf('\n')
  return newline === -1 ? cut : cut.slice(newline + 1)
}

/**
 * Draft a chapter's prose.
 *
 * Returns the text for review; it does NOT write the file. The author's editor
 * holds unsaved changes of their own, and a generator that wrote directly would
 * either clobber them or race with them. The prose lands in the textarea, dirty,
 * and the author saves it — the same contract as every other generator here.
 *
 * A later phase can hand the whole job to an agent through `ctx.sessionController`
 * so it can read the entire book and use the writing skills; that path needs a
 * session to drive and a way to reconcile with unsaved edits, which is a larger
 * question than this endpoint.
 */
async function handleDraft({ request, response, modules, services }) {
  assertWriteAllowed(request)
  const body = await readJsonBody(request)

  const llm = services.llm
  if (llm === undefined || llm === null) {
    throw httpError(503, 'llm-unavailable', '宿主没有组合 llm 服务，无法调用模型')
  }

  const { root, projectDir } = projectContext(modules, body.root)
  const target = typeof body.path === 'string' ? body.path : ''
  if (target === '') throw httpError(400, 'path-required', 'path 是必填的（要写哪一章）')

  const chapters = loadChapters(modules, projectDir).sort(
    (a, b) => (Number(a.meta?.order ?? 0) - Number(b.meta?.order ?? 0)) || String(a.path).localeCompare(String(b.path)),
  )
  const index = chapters.findIndex((chapter) => chapter.path === target)
  if (index === -1) throw httpError(404, 'chapter-missing', `找不到章节：${target}`)
  const chapter = chapters[index]
  const previous = index > 0 ? chapters[index - 1] : null

  if (chapter.meta?.error !== undefined && chapter.meta.error !== null) {
    // Without readable front matter there is no cast, no beat and no summary, so a
    // draft would ignore this chapter's own setup. Say so rather than silently
    // producing something generic.
    throw httpError(422, 'front-matter-unreadable', `本章 front matter 无法解析，先修好再让 AI 续写：${chapter.meta.error}`)
  }

  const { docs } = loadDocuments(modules, projectDir)
  const context = modules.chapterContext.buildChapterContext(docs, chapter.meta, {
    previousTail: previous === null ? '' : tailOf(previous.body, 900),
    // Only the tail: the author's editor is the source of truth for the full text,
    // and it may already contain unsaved edits this host has not seen.
    currentTail: tailOf(chapter.body, 900),
  })

  const mode = typeof body.mode === 'string' ? body.mode : 'continue'
  const prompt = modules.chapterContext.buildDraftPrompt({
    mode,
    instruction: body.instruction ?? '',
    style: typeof body.style === 'string' && body.style !== '' ? body.style : modules.prompt.resolveStyle(body.styleId),
    context,
    existing: mode === 'rewrite' ? chapter.body : '',
  })

  let provider = typeof body.provider === 'string' && body.provider !== '' ? body.provider : null
  let model = typeof body.model === 'string' && body.model !== '' ? body.model : null
  if (provider === null || model === null) {
    const { models } = await listModelsOf(llm)
    const fallback = pickDefaultModel(models)
    provider = provider ?? fallback.provider
    model = model ?? fallback.model
  }
  if (provider === null || model === null) throw httpError(503, 'no-model', '宿主没有提供任何可用模型')

  const completion = await collectCompletion(llm, { provider, model, system: prompt.system, user: prompt.user })

  if (completion.failure !== null) {
    const code = completion.failure?.code ?? completion.failure?.failure?.code ?? 'model-failed'
    throw httpError(502, 'model-failed', `模型调用失败：${code}`, { provider, model, failure: completion.failure })
  }

  const text = typeof completion.text === 'string' ? completion.text.trim() : ''
  if (text === '') {
    // Prose has no JSON to fail parsing, so an empty result is the failure mode
    // worth naming — with the observed chunk vocabulary attached, as with /generate.
    throw httpError(502, 'empty-draft', '模型没有返回任何正文', {
      provider,
      model,
      chunkTypes: completion.types,
      blockTypes: completion.blockTypes,
      chunkSamples: completion.samples,
    })
  }

  sendJson(response, 200, {
    ok: true,
    route: 'draft',
    path: target,
    mode: prompt.mode,
    provider,
    model,
    text,
    wordCount: modules.text.countWords(text),
    contextUsed: context !== '',
    prompt: modules.prompt.promptRecord(prompt),
    usage: completion.usage,
  })
}
// ---------------------------------------------------------------------------
// Driving the agent (Phase 5c)
//
// Handing a chapter to the agent instead of to a bare model call: the agent reads the whole
// book, follows the skills in `.dsh/skills/`, and writes the file itself.
//
// Every shape below was MEASURED before being relied on — a temporary read-only probe route
// (since removed) plus the event vocabulary read out of a real session log:
//
//   list()              -> { items: [{ sessionId, cwd, running, blank, updatedAt,
//                                     agentAvailable, projections }] }
//   create({})          -> { sessionId, agentPreset }
//   inspect(id)         -> { meta, inheritedEventCount, events: [{ type, seq, time, data }] }
//   prompt(obj, signal) -> obj needs a `content` array; signal is an AbortSignal
//   cancel(id)
//   modelCatalog()      -> { default: { provider, model, reasoningEffort }, ... }
//
// The event vocabulary that matters: `user/message` carries the prompt, `turn/end` with
// `reason.kind === 'completed'` marks the run finished, `assistant/message` carries the text.
// ---------------------------------------------------------------------------

/**
 * Abort controllers for in-flight runs, keyed by session.
 *
 * The prompt must NOT be tied to the HTTP request that started it: that request returns
 * immediately, and passing its signal through would cancel the run the moment the response was
 * written. The controller lives here until `/agent/cancel`.
 */
const agentRuns = new Map()

/** Do two paths name the same directory? Windows is case-insensitive and mixes separators. */
function sameDirectory(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const norm = (value) => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(left) === norm(right)
}

/**
 * The sessions that can work on this project.
 *
 * The `cwd` filter is a requirement, not a preference: the three writing skills live in the
 * workspace's `.dsh/skills/`, and a session only discovers the skills of its own workspace. A
 * session rooted anywhere else cannot see them, so it would write without the data-format
 * instructions those skills carry.
 */
async function handleSessions({ response, modules, services, url }) {
  const controller = services.sessionController
  if (controller === undefined || controller === null) {
    sendJson(response, 200, {
      ok: true,
      available: false,
      reason: 'the host composes no sessionController service',
      sessions: [],
    })
    return
  }
  const { root } = projectContext(modules, url.searchParams.get('root'))

  let rows = []
  try {
    const listed = await controller.list()
    rows = Array.isArray(listed?.items) ? listed.items : []
  } catch (error) {
    throw httpError(502, 'session-list-failed', `could not list sessions: ${error?.message ?? error}`)
  }

  const sessions = rows
    .filter((row) => sameDirectory(row?.cwd, root))
    .map((row) => ({
      sessionId: row?.sessionId ?? null,
      running: row?.running === true,
      blank: row?.blank === true,
      agentAvailable: row?.agentAvailable === true,
      updatedAt: row?.updatedAt ?? null,
    }))
    .filter((row) => row.sessionId !== null)

  // The default model, so the GUI can show what a click will actually spend.
  let defaultModel = null
  try {
    const catalog = await controller.modelCatalog()
    defaultModel = catalog?.default ?? null
  } catch {
    /* the catalog is a nicety; its absence must not block listing sessions */
  }

  sendJson(response, 200, { ok: true, available: true, root, defaultModel, sessions })
}

/**
 * Start one agent run. Returns as soon as the prompt is accepted; it does NOT wait.
 *
 * A run takes tens of seconds, and holding an HTTP response open that long invites proxy and
 * client timeouts while giving the GUI nothing to show. The caller polls `/agent/status`.
 */
async function handleAgentPrompt({ request, response, modules, services }) {
  assertWriteAllowed(request)
  const body = await readJsonBody(request)

  const controller = services.sessionController
  if (controller === undefined || controller === null) {
    throw httpError(503, 'session-unavailable', '宿主没有组合 sessionController 服务，无法驱动 agent')
  }

  const { root } = projectContext(modules, body.root)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (text === '') throw httpError(400, 'prompt-required', '需要 text（交给 agent 的任务说明）')

  let sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null
  const forceNew = body.create === true
  let created = false
  let rows = []
  try {
    const listed = await controller.list()
    rows = Array.isArray(listed?.items) ? listed.items : []
  } catch (error) {
    throw httpError(502, 'session-list-failed', `could not list sessions: ${error?.message ?? error}`)
  }

  // `create: true` starts a clean session for this project. It is the author's escape hatch
  // from a session whose context has filled up or gone wrong — and it is the only way to get
  // out of one, because the service exposes no delete.
  if (forceNew) {
    let result = null
    try {
      result = await controller.create({ cwd: root })
    } catch (error) {
      throw httpError(502, 'session-create-failed', `could not create a session: ${error?.message ?? error}`)
    }
    sessionId = result?.sessionId ?? null
    created = true
    if (sessionId === null) {
      throw httpError(502, 'session-create-failed', 'create() returned no sessionId', { result })
    }
  } else if (sessionId === null) {
    const matching = rows.filter((row) => sameDirectory(row?.cwd, root) && row?.sessionId)
    if (matching.length === 1) {
      sessionId = matching[0].sessionId
    } else if (matching.length > 1) {
      throw httpError(409, 'session-ambiguous',
        `这个项目下有 ${matching.length} 个会话，请指定 sessionId`,
        { sessions: matching.map((row) => ({ sessionId: row.sessionId, updatedAt: row.updatedAt })) })
    } else {
      // None exists: make one rooted at the project, so it can see the skills.
      let result = null
      try {
        result = await controller.create({ cwd: root })
      } catch (error) {
        throw httpError(502, 'session-create-failed', `could not create a session: ${error?.message ?? error}`)
      }
      sessionId = result?.sessionId ?? null
      created = true
      if (sessionId === null) {
        throw httpError(502, 'session-create-failed', 'create() returned no sessionId', { result })
      }
    }
  } else {
    // A caller-supplied id must belong to this project. Otherwise the run would happen in a
    // session that cannot read the skills and whose file tools point at another directory.
    const row = rows.find((entry) => entry?.sessionId === sessionId)
    if (row === undefined) throw httpError(404, 'session-missing', `找不到会话 ${sessionId}`)
    if (!sameDirectory(row?.cwd, root)) {
      throw httpError(409, 'session-wrong-workspace',
        `会话 ${sessionId} 的工作目录是 ${row?.cwd ?? '?'}，不是这个项目；它看不到本项目的技能`,
        { cwd: row?.cwd ?? null, root })
    }
    if (row?.running === true) throw httpError(409, 'session-busy', `会话 ${sessionId} 正在运行中`)
  }

  // Hold the signal here rather than passing the request's through.
  const run = new AbortController()
  agentRuns.set(sessionId, run)

  let seqBefore = 0
  try {
    const state = await controller.inspect(sessionId)
    const events = Array.isArray(state?.events) ? state.events : []
    seqBefore = events.length === 0 ? 0 : Number(events[events.length - 1]?.seq ?? 0)
  } catch {
    /* an empty session may fail to inspect; 0 is the right starting point anyway */
  }

  try {
    // DRIVE THE AGENT DIRECTLY — DO NOT GO THROUGH `sessionController.prompt`.
    //
    // `prompt(request, signal)` dereferences its second parameter before its null check:
    //
    //   prompt(request, signal) { signal?.throwIfAborted(); return this.commands.prompt(request) }
    //
    // and that line is ONLY there because the RPC layer declares `signal` as a framework
    // cancellation parameter. We call in-process with one argument, so `signal` is undefined,
    // it throws `Cannot read properties of undefined`, and the only way through used to be
    // `tools/patch-asar.mjs` — a length-neutral patch to the INSTALLED app. That is fine for
    // this machine and wrong for anyone else, which is why it blocked distribution.
    //
    // `agents.resolveAgent(sessionId)` is the host's own resolver ("Resolve or resume one
    // ordinary Session, deduplicating concurrent resumes") and is the first thing `prompt`
    // itself calls. It answers the live Agent — resuming a persisted session when needed —
    // or a stable failure. The returned agent's `followup(message)` is the documented way to
    // drive a conversation: "queues an ordinary next-turn prompt and wakes the driver".
    //
    // So no `signal`, no `requestId`, and no RPC serialization boundary is involved at all.
    // The message carries its OWN `id` instead: that is what identifies it in the log.
    const resolved = await controller.resolveAgent(sessionId)
    if (resolved === null || typeof resolved !== 'object' || resolved.agent === undefined || resolved.agent === null) {
      const reason = resolved?.error?.message ?? resolved?.error ?? 'the host answered no agent for this session'
      throw httpError(502, 'agent-unavailable', `宿主没能为该会话准备 agent：${reason}`, { sessionId })
    }
    const agent = resolved.agent
    if (typeof agent.followup !== 'function') {
      throw httpError(501, 'agent-followup-missing',
        '宿主的 agent 没有 followup 方法，无法在不打补丁的情况下驱动它；请把这一版宿主告知插件作者。',
        { sessionId })
    }
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    // There is no receipt to keep: `followup` enqueues and wakes the driver, and the events it
    // produces are what `/agent/result` reports. `agentRuns` still holds the abort controller,
    // because `/agent/cancel` needs to know a run started HERE and can be stopped from here.
  } catch (error) {
    agentRuns.delete(sessionId)
    // The error's OWN properties travel with the failure. `error.message` alone said only
    // "prompt rejected" — a domain rejection whose reason lives on the error object, exactly
    // like the `llm` chunk discriminator that stayed invisible until samples were included.
    const diagnostic = {}
    for (const key of Object.getOwnPropertyNames(error ?? {})) {
      if (key === 'stack') continue
      const value = error[key]
      diagnostic[key] = value instanceof Error ? String(value.message ?? value) : value
    }
    // TWO SHAPES OF FAILURE WORTH NAMING, kept because each one used to be a mystery.
    //
    // The first is the reason this call exists at all: an agent the host will not prepare. It is
    // no longer a `signal` crash (we never call `prompt`), but a deployment can still answer a
    // stable failure from `resolveAgent`, and the author should read that in the host's words.
    //
    // The second was OURS, and it was reported to the host as a host defect before the real cause
    // was found. The session log's append refuses anything that is not LOSSLESSLY serializable —
    // `if (dataSnapshot === undefined) throw new Error('session event "…" carries non-JSON-serializable data')`
    // — which is far stricter than JSON: a field whose value is `undefined` is refused, because JSON
    // would drop the key and the round trip would not be the same value. Omitting `requestId` made the
    // host build `source.rpcId = undefined`, and the append refused the whole event. Every field this
    // sends is now a real string, but the check stays: it is the honest explanation if it ever recurs.
    const serialized = JSON.stringify(diagnostic)
    const lossless = /inbox\/spliced/.test(serialized) || /non-JSON-serializable/.test(serialized)
    if (lossless) {
      throw httpError(501, 'agent-prompt-unsupported',
        '这次提问没能写进会话日志：事件里的某个字段不是「无损 JSON 可序列化」的（值为 undefined 的字段会被拒绝，' +
        '因为 JSON 会把它丢掉）。本插件为每条消息生成 id，因此这一条通常意味着宿主侧的字段缺失。' +
        '（判定依据见 lib/impl/router.js 的注释与 docs/host-bug-session-controller-prompt.md）',
        { sessionId, error: diagnostic, reason: 'lossless-json-required' })
    }
    throw httpError(502, 'prompt-failed',
      `提交给 agent 失败：${error?.message ?? error}`,
      { sessionId, error: diagnostic })
  }

  sendJson(response, 202, { ok: true, route: 'agent/prompt', sessionId, created, seqBefore })
}

/** Cheap liveness: is the run still going? Polled, so it must not transfer a transcript. */
async function handleAgentStatus({ response, services, url }) {
  const controller = services.sessionController
  if (controller === undefined || controller === null) {
    throw httpError(503, 'session-unavailable', '宿主没有组合 sessionController 服务')
  }
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') throw httpError(400, 'session-required', '需要 sessionId')

  const listed = await controller.list()
  const rows = Array.isArray(listed?.items) ? listed.items : []
  const row = rows.find((entry) => entry?.sessionId === sessionId)
  if (row === undefined) throw httpError(404, 'session-missing', `找不到会话 ${sessionId}`)

  sendJson(response, 200, {
    ok: true,
    sessionId,
    running: row?.running === true,
    blank: row?.blank === true,
    agentAvailable: row?.agentAvailable === true,
    // Whether THIS host still holds the abort controller. False means the run was started
    // elsewhere or the host restarted, so it cannot be cancelled from here.
    cancellable: agentRuns.has(sessionId),
  })
}

/**
 * The outcome of a finished run, read once.
 *
 * `inspect` returns the whole transcript, so this is deliberately NOT the polling endpoint.
 */
async function handleAgentResult({ response, services, url }) {
  const controller = services.sessionController
  if (controller === undefined || controller === null) {
    throw httpError(503, 'session-unavailable', '宿主没有组合 sessionController 服务')
  }
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') throw httpError(400, 'session-required', '需要 sessionId')
  const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? 0)

  let state = null
  try {
    state = await controller.inspect(sessionId)
  } catch (error) {
    throw httpError(502, 'session-inspect-failed', `could not read the session: ${error?.message ?? error}`)
  }
  const events = (Array.isArray(state?.events) ? state.events : []).filter(
    (event) => Number(event?.seq ?? 0) > sinceSeq,
  )
  // Finished when a `turn/end` appears after the prompt.
  let turnEnd = null
  for (const event of events) {
    if (event?.type === 'turn/end') turnEnd = event
  }

  // The agent's own words: the text blocks of its last assistant message.
  let text = ''
  let usage = null
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const blocks = Array.isArray(event?.data?.message?.content) ? event.data.message.content : []
    const joined = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (joined !== '') text = joined
    if (event?.data?.usage !== undefined) usage = event.data.usage
  }

  // Which project files the run touched. Best effort BY DESIGN: the tool-call payload is the
  // agent's shape, not this plugin's, so paths are scraped rather than trusted — good enough to
  // report, never used to decide what to reload.
  const writes = new Set()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    for (const match of JSON.stringify(event?.data ?? {}).matchAll(/(novel[\\/][^"\\]+\.(?:md|json))/g)) {
      writes.add(String(match[1]).replace(/\\/g, '/'))
    }
  }

  if (turnEnd !== null) agentRuns.delete(sessionId)

  sendJson(response, 200, {
    ok: true,
    sessionId,
    finished: turnEnd !== null,
    reason: turnEnd?.data?.reason ?? null,
    text,
    usage,
    writes: [...writes].slice(0, 40),
    eventCount: events.length,
    // SHAPES, NOT GUESSES. `inspect` answers `{ meta, inheritedEventCount, events }` for an ATTACHED session and
    // whatever `inspectApiSession` answers otherwise — the same two-shapes-one-name trap as `body.items` vs
    // `body.sessions`. These two fields say which one came back, so an empty transcript is never a mystery.
    totalEvents: Array.isArray(state?.events) ? state.events.length : null,
    stateKeys: state === null || typeof state !== 'object' ? [] : Object.keys(state).slice(0, 20),
    eventTypes: events.slice(-12).map((event) => event?.type ?? null),
  })
}

/** Stop a run. The controller lives here, so only this host can abort its own prompts. */
async function handleAgentCancel({ request, response, services }) {
  assertWriteAllowed(request)
  const body = await readJsonBody(request)
  const controller = services.sessionController
  if (controller === undefined || controller === null) {
    throw httpError(503, 'session-unavailable', '宿主没有组合 sessionController 服务')
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') throw httpError(400, 'session-required', '需要 sessionId')

  const run = agentRuns.get(sessionId)
  if (run !== undefined) {
    run.abort()
    agentRuns.delete(sessionId)
  }
  let cancelled = run !== undefined
  try {
    await controller.cancel(sessionId)
    cancelled = true
  } catch (error) {
    // An abort on an already-finished run is not a failure worth surfacing.
    if (!cancelled) throw httpError(502, 'cancel-failed', `could not cancel: ${error?.message ?? error}`)
  }
  sendJson(response, 200, { ok: true, route: 'agent/cancel', sessionId, cancelled })
}

// ---------------------------------------------------------------------------
// Image assets — the map's imported backgrounds
//
// The renderer cannot read the host's filesystem, so an imported image is served through this
// route rather than referenced as a `file://` URL. Reads and writes are confined to ONE directory
// by an allow-list layered on top of the containment check: `resolveInside` already refuses
// traversal and junction escapes, but serving arbitrary project files through an image route is
// not something this API has any reason to permit.
// ---------------------------------------------------------------------------

const ASSET_DIR = 'setting/map/assets'

/** Extensions a browser can be trusted to render as an image, and nothing else. */
const ASSET_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
])

/** Decoded ceiling. Base64 inflates by about a third, and the request body limit is 8MB. */
const ASSET_MAX_BYTES = 4 * 1024 * 1024

function assetExtension(name) {
  const match = /\.[A-Za-z0-9]+$/.exec(String(name ?? ''))
  return match === null ? '' : match[0].toLowerCase()
}

/**
 * Validate an asset filename.
 *
 * A bare filename inside one directory — no separators, no traversal, no leading dot — with an
 * extension this route is willing to serve. Checked before anything touches the filesystem so a
 * bad name can never reach a path operation.
 */
function assertAssetName(name) {
  const text = typeof name === 'string' ? name.trim() : ''
  if (text === '') throw httpError(400, 'asset-name-required', '需要 name（文件名，含扩展名）')
  if (text.length > 120) {
    throw httpError(400, 'asset-name-too-long', `文件名过长（${text.length} 字符，上限 120）`)
  }
  if (text.includes('..') || /[\\/:*?"<>|]/.test(text) || !/^[A-Za-z0-9\u4e00-\u9fff]/.test(text)) {
    throw httpError(400, 'asset-name-invalid',
      '文件名只能包含字母、数字、下划线、点、连字符与中文，且必须是单纯的文件名（不含路径）')
  }
  const extension = assetExtension(text)
  if (!ASSET_TYPES.has(extension)) {
    throw httpError(400, 'asset-type-not-allowed',
      `不支持的图片格式 "${extension || '(无扩展名)'}"；允许：${[...ASSET_TYPES.keys()].join(', ')}`)
  }
  return text
}

/** Send bytes with an explicit content type. `sendJson` cannot express a binary body. */
function sendBytes(response, status, buffer, contentType, extraHeaders = {}) {
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(status, {
    'content-type': contentType,
    // `no-cache` rather than `no-store`: re-importing a file under the same name must show up
    // immediately, but a plain reload should not re-transfer a large image.
    'cache-control': 'no-cache',
    'content-length': buffer.length,
    ...extraHeaders,
  })
  response.end(buffer)
}

/** Serve one imported asset. */
async function handleAssetGet({ response, modules, url }) {
  const { projectDir } = projectContext(modules, url.searchParams.get('root'))
  const raw = url.searchParams.get('path')
  const normalised = String(raw ?? '').replace(/\\/g, '/')
  if (!normalised.startsWith(`${ASSET_DIR}/`)) {
    throw httpError(400, 'asset-path-not-allowed',
      `只能读取 ${ASSET_DIR}/ 下的资源，收到 "${normalised}"`)
  }
  const name = normalised.slice(ASSET_DIR.length + 1)
  assertAssetName(name)

  // Containment (traversal + junction escape) is `resolveInside`'s job, and it throws
  // `path-escape` / `path-link-escape` itself.
  const { abs } = modules.paths.resolveInside(projectDir, `${ASSET_DIR}/${name}`)
  if (!modules.store.exists(abs)) {
    throw httpError(404, 'asset-missing', `找不到图片 ${name}`)
  }
  const bytes = modules.store.readBinary(abs)
  sendBytes(response, 200, bytes, ASSET_TYPES.get(assetExtension(name)))
}

/**
 * Import an asset.
 *
 * The body carries base64 rather than raw bytes so it can travel through the same JSON request
 * path as everything else — one body reader, one limit, one error shape.
 */
async function handleAssetPost({ request, response, modules }) {
  assertWriteAllowed(request)
  const body = await readJsonBody(request)
  const { projectDir } = projectContext(modules, body.root)
  const name = assertAssetName(body.name)

  const raw = typeof body.data === 'string' ? body.data : ''
  if (raw === '') throw httpError(400, 'asset-data-required', '需要 data（base64 编码的图片内容）')
  // Accept a full data URL as well as bare base64: that is what a FileReader hands you, and
  // rejecting it would be a pointless papercut for the caller.
  const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw
  if (base64 === '' || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    throw httpError(400, 'asset-data-invalid', 'data 不是合法的 base64')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) throw httpError(400, 'asset-data-invalid', 'base64 解出来是空的')
  if (bytes.length > ASSET_MAX_BYTES) {
    throw httpError(413, 'asset-too-large',
      `图片 ${bytes.length} 字节，上限 ${ASSET_MAX_BYTES} 字节（约 4MB）`)
  }

  const { abs, rel } = modules.paths.resolveInside(projectDir, `${ASSET_DIR}/${name}`)
  modules.store.writeBinaryAtomic(abs, bytes)
  sendJson(response, 200, {
    ok: true,
    route: 'asset',
    // The document stores this relative-to-the-assets-directory name, which is what
    // `isMapImage` and `mapAssetUrl` expect on the client.
    asset: name,
    path: rel,
    bytes: bytes.length,
    contentType: ASSET_TYPES.get(assetExtension(name)),
  })
}

function handleRequests({ response }) {
  sendJson(response, 200, {
    ok: true,
    route: 'requests',
    limit: RECENT_LIMIT,
    requests: [...recentRequests].reverse(),
  })
}

/** The API surface, so `/dsh-novel` alone answers "what can I call?". */
function handleIndex({ response, modules }) {
  sendJson(response, 200, {
    ok: true,
    route: 'index',
    plugin: 'dsh-novel',
    schemaVersion: modules.schema.SCHEMA_VERSION,
    dataDir: modules.schema.DATA_DIR,
    writeHeader: WRITE_HEADER,
    routes: ROUTES.map((entry) => ({
      method: entry.method,
      path: `${PREFIX}${entry.path === '/' ? '' : entry.path}`,
      write: entry.method !== 'GET',
    })),
  })
}

/** Cheap liveness probe: unlike /health it touches no filesystem. */
function handlePing({ response }) {
  sendJson(response, 200, { ok: true, pong: true, pid: process.pid })
}

const ROUTES = [
  { method: 'GET', path: '/', handler: handleIndex },
  { method: 'GET', path: '/ping', handler: handlePing },
  { method: 'GET', path: '/health', handler: handleHealth },
  { method: 'POST', path: '/project/create', handler: handleProjectCreate },
  { method: 'GET', path: '/project', handler: handleProjectGet },
  { method: 'GET', path: '/document', handler: handleDocumentGet },
  { method: 'POST', path: '/document', handler: handleDocumentPost },
  { method: 'POST', path: '/chapter', handler: handleChapterCreate },
  { method: 'GET', path: '/validate', handler: handleValidate },
  { method: 'GET', path: '/workspaces', handler: handleWorkspaces },
  { method: 'GET', path: '/requests', handler: handleRequests },
  { method: 'GET', path: '/asset', handler: handleAssetGet },
  { method: 'POST', path: '/asset', handler: handleAssetPost },
  { method: 'GET', path: '/sessions', handler: handleSessions },
  { method: 'POST', path: '/agent/prompt', handler: handleAgentPrompt },
  { method: 'GET', path: '/agent/status', handler: handleAgentStatus },
  { method: 'GET', path: '/agent/result', handler: handleAgentResult },
  { method: 'POST', path: '/agent/cancel', handler: handleAgentCancel },
  { method: 'GET', path: '/chapters', handler: handleChapters },
  // The whole book as one document. A GET assembles and returns it; a POST writes it into the project and
  // reports the path, which is the only way a file can be given an address a page is allowed to know.
  { method: 'GET', path: '/manuscript', handler: handleManuscript },
  { method: 'POST', path: '/manuscript', handler: handleManuscriptWrite },
  { method: 'GET', path: '/catalog', handler: handleCatalog },
  { method: 'POST', path: '/generate', handler: handleGenerate },
  { method: 'POST', path: '/draft', handler: handleDraft },
]

/**
 * Entry point called by the host shell for every request under the prefix.
 *
 * @param request - node:http request.
 * @param response - node:http response.
 * @param load - cache-busting impl loader supplied by `lib/index.js`.
 * @param services - optional host services bound by `lib/index.js`; each may
 *   be absent, and every handler that needs one must say so itself.
 */
export async function handle(request, response, load, services = Object.create(null)) {
  const [schema, paths, store, frontmatter, validate, scaffold, text, prompt, context, chapterContext, manuscript] =
    await Promise.all([
      load('./schema.js'),
      load('./paths.js'),
      load('./store.js'),
      load('./frontmatter.js'),
      load('./validate.js'),
      load('./scaffold.js'),
      load('./text.js'),
      load('./prompt.js'),
      load('./context.js'),
      load('./chapter-context.js'),
      load('./manuscript.js'),
    ])
  const modules = { schema, paths, store, frontmatter, validate, scaffold, text, prompt, context, chapterContext, manuscript }

  let url
  try {
    url = new URL(request.url ?? '/', 'http://localhost')
  } catch {
    sendJson(response, 400, { ok: false, code: 'bad-url', error: 'unparseable request URL' })
    return
  }

  let route = url.pathname
  if (route === PREFIX) route = '/'
  else if (route.startsWith(`${PREFIX}/`)) route = route.slice(PREFIX.length)

  // Record before routing, so 404s and 405s are captured too — a request landing
  // on the wrong path is exactly the kind of thing worth seeing.
  const record = {
    at: new Date().toISOString(),
    method: request.method,
    url: request.url,
    route,
    status: null,
    query: Object.fromEntries(url.searchParams.entries()),
    error: null,
  }
  recentRequests.push(record)
  if (recentRequests.length > RECENT_LIMIT) recentRequests.shift()
  const writeHead = response.writeHead.bind(response)
  response.writeHead = (status, ...rest) => {
    record.status = status
    return writeHead(status, ...rest)
  }

  const matchesPath = ROUTES.filter((entry) => entry.path === route)
  const matched = matchesPath.find((entry) => entry.method === request.method)
  if (matched === undefined) {
    const allowed = matchesPath.map((entry) => entry.method)
    if (allowed.length > 0) {
      response.writeHead(405, { allow: allowed.join(', '), 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, code: 'method-not-allowed', error: `${request.method} not allowed on ${route}`, allow: allowed }))
      return
    }
    sendJson(response, 404, {
      ok: false, code: 'no-route', error: `no route for ${request.method} ${route}`,
      routes: ROUTES.map((entry) => `${entry.method} ${PREFIX}${entry.path}`),
    })
    return
  }

  try {
    await matched.handler({ request, response, url, modules, services })
  } catch (error) {
    const status = Number(error?.httpStatus) || 500
    record.error = error?.message ?? String(error)
    if (status >= 500) {
      // Server-side faults are worth a stack in the host log; client mistakes are not.
      console.error('[dsh-novel] handler failed', route, error)
    }
    const details = error?.details ?? (error?.issues !== undefined ? { issues: error.issues } : undefined)
    sendJson(response, status, {
      ok: false,
      code: error?.code ?? 'internal',
      error: error?.message ?? String(error),
      // `issues` stays top-level because the client renders it directly; the rest
      // of the diagnostics travel in `details`. Dropping them would make a failure
      // like "unparseable model response" undebuggable — the raw text and the
      // observed chunk kinds are exactly what explains it.
      ...(Array.isArray(details?.issues) ? { issues: details.issues } : {}),
      ...(details !== undefined ? { details } : {}),
    })
  }
}
