/**
 * Mechanical audit sweeps: the checks a grep does more reliably than reading.
 *
 * Findings from reading are claims; this produces hard numbers to check them against.
 *
 * Usage: node tools/audit-sweep.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const read = (path) => readFileSync(path, 'utf8')
const section = (title) => console.log(`\n=== ${title} ===`)

const router = read('lib/impl/router.js')
const apiTest = read('tools/api-selftest.mjs')
const implTest = read('tools/impl-selftest.mjs')
const clientTest = read('tools/client-selftest.mjs')
const apply = read('client/src/90-apply.js')

// --- 1. every host error code, and whether a test exercises it ---------------
section('host error codes vs api-selftest coverage')
const codes = [...router.matchAll(/httpError\(\s*(\d+)\s*,\s*'([a-z0-9-]+)'/g)].map((m) => ({
  status: Number(m[1]),
  code: m[2],
}))
const unique = [...new Map(codes.map((entry) => [entry.code, entry])).values()]
const uncovered = []
for (const entry of unique) {
  // A code is covered if the api suite mentions it, or asserts its status together
  // with a nearby string. Mention-by-name is the strongest signal available.
  const covered = apiTest.includes(`'${entry.code}'`) || apiTest.includes(`"${entry.code}"`)
  console.log(`  ${covered ? 'covered ' : 'UNCOVERED'} ${String(entry.status).padEnd(4)} ${entry.code}`)
  if (!covered) uncovered.push(entry)
}
console.log(`  total ${unique.length} distinct codes, ${uncovered.length} not named in api-selftest`)

// --- 2. the `!== null` then dereference class --------------------------------
section('`!== null` checks followed by a dereference on the same line')
const clientFiles = readdirSync('client/src').filter((name) => name.endsWith('.js'))
let suspicious = 0
for (const name of clientFiles) {
  const lines = read(`client/src/${name}`).split('\n')
  lines.forEach((line, index) => {
    if (/!==\s*null/.test(line) && /\.(length|map|filter|find|join|forEach)\b/.test(line)) {
      console.log(`  client/src/${name}:${index + 1}: ${line.trim().slice(0, 110)}`)
      suspicious += 1
    }
    // `x.length > 0` with no guard at all on the same line
    if (/^\s*[a-zA-Z_$][\w$.]*\.length\s*>\s*0/.test(line) && !/Array\.isArray/.test(line) && !/!==\s*null/.test(line)) {
      console.log(`  client/src/${name}:${index + 1}: UNGUARDED ${line.trim().slice(0, 100)}`)
      suspicious += 1
    }
  })
}
console.log(`  ${suspicious} line(s) to inspect`)

// --- 3. unused test surface --------------------------------------------------
section('__test exports never referenced by any suite')
const exportBlock = apply.slice(apply.indexOf('__test = {'))
const exported = [...exportBlock.matchAll(/^\s{2}([A-Za-z_$][\w$]*),?$/gm)].map((m) => m[1])
const allTests = implTest + apiTest + clientTest
const unused = exported.filter((name) => {
  const uses = allTests.split(new RegExp(`\\b${name}\\b`)).length - 1
  // One use is the export list reference itself if it appears in the tests at all.
  return uses === 0
})
console.log(`  ${exported.length} exported, ${unused.length} never used by a suite`)
for (const name of unused) console.log(`  unused: ${name}`)

// --- 4. constants duplicated across the host/client boundary ------------------
section('values that exist on both sides and could drift')
const pairs = [
  ['schema DATA_DIR', /DATA_DIR\s*=\s*'([^']+)'/.exec(read('lib/impl/schema.js'))?.[1], /DATA_DIR\s*=\s*'([^']+)'/.exec(read('client/src/10-core.js'))?.[1]],
]
for (const [what, host, client] of pairs) {
  console.log(`  ${what}: host=${JSON.stringify(host)} client=${JSON.stringify(client)} ${host === client ? '' : '<-- DRIFT'}`)
}
// Style ids and draft mode ids: the client must not invent its own labels for them.
const hostStyles = [...read('lib/impl/prompt.js').matchAll(/\{ id: '([a-z]+)', label: '([^']+)'/g)].map((m) => m[1])
const hostModes = [...read('lib/impl/chapter-context.js').matchAll(/\{ id: '([a-z]+)', label: '([^']+)'/g)].map((m) => m[1])
const clientModes = [...read('client/src/35-generate.js').matchAll(/\{ id: '([a-z]+)', label: '([^']+)' \}/g)].map((m) => m[1])
console.log(`  host style ids:  ${hostStyles.join(', ')}`)
console.log(`  host draft ids:  ${hostModes.join(', ')}`)
console.log(`  client draft ids: ${clientModes.join(', ')} ${hostModes.join(',') === clientModes.join(',') ? '(match)' : '<-- DRIFT'}`)
// The client must not carry its own copy of the style table.
const clientHasStyles = /\{ id: '(concise|rich|classical|plain|eerie)'/.test(read('client/src/35-generate.js'))
console.log(`  client carries its own style presets: ${clientHasStyles ? 'YES <-- drift risk' : 'no (fetched from /catalog)'}`)

// --- 5. documented files vs scaffolded --------------------------------------
section('documented project files vs FILES in schema.js')
const schema = read('lib/impl/schema.js')
const filesBlock = schema.slice(schema.indexOf('export const FILES'), schema.indexOf('export const DIRS'))
const scaffolded = [...filesBlock.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]).sort()
const model = read('docs/data-model.md')
const documented = [...model.matchAll(/`((?:setting|outline|draft|views)\/[\w./-]+)`/g)].map((m) => m[1])
const uniqueDocumented = [...new Set(documented)].sort()
console.log(`  scaffolded (${scaffolded.length}): ${scaffolded.join(', ')}`)
const undocumented = scaffolded.filter((path) => !uniqueDocumented.some((doc) => doc.startsWith(path) || path.startsWith(doc)))
console.log(`  scaffolded but never named in data-model.md: ${undocumented.length === 0 ? 'none' : undocumented.join(', ')}`)

// --- 6. test counts quoted in the README ------------------------------------
section('README test counts vs tools')
const readme = read('README.md')
for (const suite of ['impl-selftest', 'api-selftest', 'client-selftest', 'live-check']) {
  const quoted = new RegExp(`${suite}\\.mjs[^\\n]*?(\\d+)\\s*项`).exec(readme)?.[1] ?? '(not quoted)'
  console.log(`  ${suite}: README says ${quoted}`)
}

// --- 7. files that exist but are never mentioned anywhere -------------------
section('files in the repo not referenced by any doc or tool')
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.verify')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full.replace(/\\/g, '/'))
  }
  return out
}
const everything = walk('.')
const haystack = readme + model + implTest + apiTest + clientTest + router
const orphans = everything.filter((path) => {
  if (/\/(node_modules|\.git)\//.test(path)) return false
  if (/^(client\/client\.js|package\.json|cordis\.patch\.yml|\.gitignore)/.test(path)) return false
  const base = path.split('/').pop()
  return !haystack.includes(base)
})
for (const path of orphans) console.log(`  unreferenced: ${path}`)
if (orphans.length === 0) console.log('  none')

console.log('')
