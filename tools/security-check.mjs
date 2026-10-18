/**
 * Security regression check against a RUNNING DSH host.
 *
 * The four self-test suites cannot see the host's request pipeline, and the two
 * properties that matter most here are only observable over real HTTP:
 *
 *   1. the plugin's `/dsh-novel/**` prefix route sits BELOW the host's token
 *      check and its Host/Origin fence, so a forged Host must be refused by the
 *      plugin itself — with a DNS-rebinding page, the browser considers the
 *      request same-origin and sends the write header without any preflight;
 *   2. a whole-document write must reject a stale mtime instead of silently
 *      discarding what an agent (or another window) wrote in between.
 *
 * It also pins the smaller hardening that is easy to lose in a refactor: SVG
 * assets are served sandboxed, a transcript read requires its project root, and
 * a chapter cannot be created at a path the chapter loader never scans.
 *
 * Run: node tools/security-check.mjs <base> <fresh-root>
 *   base       e.g. http://127.0.0.1:5941/dsh-novel  (DSH_NOVEL_BASE is used when omitted)
 *   fresh-root must be a scratch directory; the check creates a project inside it
 *              and refuses to run where a project already exists.
 *
 * Exit code: 0 all checks passed, 1 some failed, 2 bad invocation/refused.
 */

import { request as httpRequest } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = (process.argv[2] ?? process.env.DSH_NOVEL_BASE ?? '').replace(/\/+$/, '')
const ROOT = process.argv[3]

if (BASE === '' || ROOT === undefined) {
  console.error('usage: node tools/security-check.mjs <base> <fresh-root>')
  console.error('   or: DSH_NOVEL_BASE=http://127.0.0.1:<port>/dsh-novel node tools/security-check.mjs "" <fresh-root>')
  process.exit(2)
}

if (existsSync(join(ROOT, 'novel', 'project.json'))) {
  console.error(`refusing to run: ${ROOT} already contains a novel project`)
  process.exit(2)
}

const url = new URL(BASE.endsWith('/dsh-novel') ? BASE : `${BASE}/dsh-novel`)
const PORT = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
const HOST = url.host
const H = { 'x-dsh-novel': '1', 'content-type': 'application/json' }

let failed = 0
function ok(name, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ' :: ' + detail}`)
  if (!condition) failed += 1
}

function raw(path, headers, method = 'GET', body = null) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      { host: url.hostname, port: PORT, path: `/dsh-novel${path}`, method, headers },
      (response) => {
        let text = ''
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => {
          let json = null
          try { json = JSON.parse(text) } catch { /* text only */ }
          resolvePromise({ status: response.statusCode, json, text, headers: response.headers })
        })
      },
    )
    request.on('error', (error) => rejectPromise(new Error(`cannot reach ${BASE}: ${error?.message ?? error}`)))
    if (body !== null) request.write(body)
    request.end()
  })
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* text only */ }
  return { status: response.status, json, text, headers: response.headers }
}

try {
  await raw('/ping', { host: HOST })
} catch (error) {
  console.error(String(error.message ?? error))
  console.error('The host port changes on every restart. Pass the CURRENT Web UI origin:')
  console.error("  node tools/security-check.mjs http://127.0.0.1:<current-port>/dsh-novel <fresh-root>")
  process.exit(2)
}

// ---- 1. the Host / Origin fence -------------------------------------------------
const normal = await raw('/ping', { host: HOST })
ok('the deployment\'s own Host passes', normal.status === 200, `status ${normal.status}`)

const forged = await raw('/ping', { host: 'evil.example' })
ok('a forged Host is refused', forged.status === 403 && forged.json?.code === 'untrusted-origin',
  `status ${forged.status} code ${forged.json?.code}`)

const crossSite = await raw('/ping', { host: HOST, 'sec-fetch-site': 'cross-site' })
ok('a cross-site marker is refused', crossSite.status === 403, `status ${crossSite.status}`)

const foreignOrigin = await raw('/ping', { host: HOST, origin: 'http://evil.example' })
ok('a foreign Origin is refused', foreignOrigin.status === 403, `status ${foreignOrigin.status}`)

const sameOrigin = await raw('/ping', { host: HOST, origin: new URL(BASE).origin, 'sec-fetch-site': 'same-origin' })
ok('a same-origin request passes', sameOrigin.status === 200, `status ${sameOrigin.status}`)

const forgedWrite = await raw(
  '/project/create',
  { host: 'evil.example', origin: 'http://evil.example', ...H },
  'POST',
  JSON.stringify({ root: ROOT, title: 'forged' }),
)
ok('a forged Host cannot write', forgedWrite.status === 403, `status ${forgedWrite.status}`)
ok('the forged write left nothing on disk', !existsSync(join(ROOT, 'novel', 'project.json')))

// ---- 2. normal project, concurrency, chapters, assets ---------------------------
mkdirSync(ROOT, { recursive: true })
const created = await call('POST', '/project/create', { root: ROOT, title: 'security-check' })
ok('project create works normally', created.status === 201,
  created.status === 201 ? '' : `status ${created.status}: ${created.text.slice(0, 120)}`)

const read = await call('GET', `/document?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent('setting/world.json')}`)
const mtime = read.json?.stat?.mtimeMs
ok('GET /document reports the mtime', typeof mtime === 'number', `stat ${JSON.stringify(read.json?.stat)}`)

const stale = await call('POST', '/document', {
  root: ROOT, path: 'setting/world.json', value: { sections: [], rules: [] }, expectedMtimeMs: mtime - 1000,
})
ok('a stale write is a 409', stale.status === 409 && stale.json?.code === 'document-changed',
  `status ${stale.status} code ${stale.json?.code}`)

const fresh = await call('POST', '/document', {
  root: ROOT, path: 'setting/world.json', value: { sections: [], rules: [] }, expectedMtimeMs: mtime,
})
ok('a matching write succeeds and returns the new mtime',
  fresh.status === 200 && typeof fresh.json?.stat?.mtimeMs === 'number', `status ${fresh.status}`)

const nested = await call('POST', '/chapter', { root: ROOT, id: 'sub/x', title: '隐身章' })
ok('a nested chapter id is refused', nested.status === 400 && nested.json?.code === 'bad-chapter-id',
  `status ${nested.status} code ${nested.json?.code}`)

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
const uploaded = await call('POST', '/asset', {
  root: ROOT, name: 'x.svg', data: Buffer.from(svg).toString('base64'),
})
ok('an SVG asset can be imported', uploaded.status === 200, `status ${uploaded.status}`)
const served = await call('GET', `/asset?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent('setting/map/assets/x.svg')}`)
ok('the SVG is served sandboxed', served.headers.get('content-security-policy') === 'sandbox',
  String(served.headers.get('content-security-policy')))
ok('the SVG is nosniff', served.headers.get('x-content-type-options') === 'nosniff',
  String(served.headers.get('x-content-type-options')))

// ---- 3. the transcript is scoped to its project ---------------------------------
const noRoot = await call('GET', '/agent/result?sessionId=security-check-none')
ok('a transcript read without root is refused',
  noRoot.status === 400 && (noRoot.json?.code === 'root-required' || noRoot.json?.code === 'session-unavailable'),
  `status ${noRoot.status} code ${noRoot.json?.code}`)

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${failed === 0 ? 'all security checks passed' : `${failed} security check(s) failed`}`)
process.exit(failed === 0 ? 0 : 1)
