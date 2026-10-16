/**
 * Empirical path-safety probe.
 *
 * The host resolves project-relative paths from user-supplied JSON. Reading the
 * code suggests it is safe; this asks the running host directly, which is the only
 * way to be sure. EVERY case here is a READ (`GET /document`), so even a failure
 * can only disclose a file — it cannot modify or delete one.
 *
 * Usage: node tools/path-probe.mjs [root]
 */
const ROOT = process.argv[2] ?? 'D:\\documents\\GitHub\\my-project'
const API = 'http://127.0.0.1:19387/dsh-novel'

const cases = [
  // [label, path value, should it be refused?]
  ['a legitimate document (control)', 'setting/items.json', false],
  ['traversal with ../', '../../../../Windows/System32/drivers/etc/hosts', true],
  ['traversal in the middle', 'setting/../../../outside.json', true],
  ['a deep traversal', '../../../../../../../../etc/passwd', true],
  ['an absolute windows path', 'C:\\Windows\\win.ini', true],
  ['a drive-relative path', 'C:Windows\\win.ini', true],
  ['a UNC path', '\\\\localhost\\c$\\Windows\\win.ini', true],
  ['a unix-style absolute path', '/etc/passwd', true],
  ['trailing dot', 'setting/items.json.', true],
  ['trailing space', 'setting/items.json ', true],
  ['a reserved device name', 'CON', true],
  ['a reserved name with an extension', 'setting/NUL.json', true],
  ['an alternate data stream', 'setting/items.json:stream', true],
  ['a directory rather than a file', 'setting', true],
  ['the project root itself', '.', true],
  ['an empty path', '', true],
  ['a path that is only slashes', '///', true],
  ['a backslash traversal', '..\\..\\outside.json', true],
  ['a natively encoded traversal', '..%2f..%2foutside.json', true],
  ['doubled separators', 'setting//items.json', false],
  ['a leading slash on a relative path', '/setting/items.json', null],
]

let refusals = 0
let acceptances = 0
const unexpected = []

for (const [label, value, shouldRefuse] of cases) {
  let status = null
  let code = null
  let leakedBytes = null
  try {
    const response = await fetch(`${API}/document?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(value)}`)
    status = response.status
    const body = await response.json().catch(() => null)
    code = body?.code ?? (body?.ok === true ? 'ok' : null)
    if (body?.value !== undefined) leakedBytes = JSON.stringify(body.value).length
  } catch (error) {
    status = `network error: ${error.message}`
  }

  const refused = typeof status === 'number' && status >= 400
  const note = shouldRefuse === null ? '(either is acceptable)' : shouldRefuse === refused ? 'as expected' : '*** UNEXPECTED ***'
  if (refused) refusals += 1
  else acceptances += 1
  if (shouldRefuse !== null && shouldRefuse !== refused) unexpected.push({ label, value, status, code })

  console.log(
    `${String(status).padEnd(6)} ${String(code ?? '').padEnd(20)} ${note.padEnd(20)} ${label}`,
  )
  if (leakedBytes !== null && shouldRefuse === true) {
    console.log(`       ^^ LEAKED ${leakedBytes} bytes of JSON`)
  }
}

console.log(`\n${refusals} refused, ${acceptances} accepted, ${unexpected.length} unexpected`)
if (unexpected.length > 0) {
  console.log('\nUnexpected outcomes:')
  for (const entry of unexpected) {
    console.log(`  ${entry.label}: path=${JSON.stringify(entry.value)} -> ${entry.status} ${entry.code ?? ''}`)
  }
}
