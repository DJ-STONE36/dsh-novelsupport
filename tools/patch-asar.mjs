/**
 * Patch the installed DSH app.asar to fix `sessionController.prompt`.
 *
 * The defect, located by reading the archive (see docs/host-bug-session-controller-prompt.md):
 * `prompt(request, signal)` calls `signal.throwIfAborted()` with no null check, while its RPC
 * declaration lists only `request` under `parameters` and `signal` under
 * `cancellation: { parameter: 'signal' }` — a framework parameter the caller cannot supply. Every
 * sibling method in the same file tolerates a missing signal (`signal?.throwIfAborted()`).
 *
 * WHY THIS PATCH IS SMALL
 *   `signal.throwIfAborted();` and `signal?.throwIfAborted()` are both exactly 24 characters:
 *   `?.` adds one, dropping the `;` removes one. So the file length does not change, no offset in
 *   the archive shifts, only the header's `integrity` hash has to be updated — and a SHA256 hex
 *   string is also a fixed 64 characters. Two byte ranges are rewritten; the other 115MB is
 *   copied verbatim. (The missing semicolon is safe: the next line starts with `return`, which
 *   cannot continue the expression, so ASI terminates the statement.)
 *
 * HOW TO USE
 *   node tools/patch-asar.mjs "<path to app.asar>"            # dry run, writes nothing
 *   node tools/patch-asar.mjs "<path to app.asar>" --apply    # backs up, patches, verifies
 *   node tools/patch-asar.mjs "<path to app.asar>" --revert   # restores the newest backup
 *
 * The DRY RUN is the default on purpose: this edits an installed application outside this
 * workspace, so the change should be inspected before it is made. Close the app before
 * --apply; a running app has the archive open.
 */
import { copyFileSync, openSync, readSync, writeSync, closeSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, basename } from 'node:path'

const TARGET = 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js'

/** The patch, as an ordered list of exact string replacements inside the target file. */
const REPLACEMENTS = [
  // Anchored so it cannot hit the other 13 `throwIfAborted` calls in this same file
  // (`control`, `search`, `history`, `list`, …). Applied positionally: the first occurrence
  // AFTER the method signature.
  { anchor: 'prompt(request, signal) {', from: 'signal.throwIfAborted();', to: 'signal?.throwIfAborted()' },
]

const [, , asarPath, ...flags] = process.argv
if (asarPath === undefined) {
  console.error('usage: patch-asar.mjs <app.asar> [--apply|--revert]')
  process.exit(2)
}
const apply = flags.includes('--apply')
const revert = flags.includes('--revert')

// --- revert -----------------------------------------------------------------
if (revert) {
  const dir = dirname(asarPath)
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith(`${basename(asarPath)}.bak-`))
    .sort()
  if (backups.length === 0) {
    console.error(`no backup found next to ${asarPath}`)
    process.exit(1)
  }
  const newest = join(dir, backups[backups.length - 1])
  copyFileSync(newest, asarPath)
  console.log(`restored ${asarPath}`)
  console.log(`  from ${newest}`)
  console.log('  (the .bak file is left in place; delete it when you are satisfied)')
  process.exit(0)
}

// --- read the archive -------------------------------------------------------
const bytes = readFileSync(asarPath)
const headerSize = bytes.readUInt32LE(4)
const jsonLen = bytes.readUInt32LE(12)
const jsonStart = 16
const dataStart = 8 + headerSize
const jsonText = bytes.toString('utf8', jsonStart, jsonStart + jsonLen)
const header = JSON.parse(jsonText)

console.log(`archive : ${asarPath} (${(bytes.length / 1048576).toFixed(1)}MB)`)
console.log(`header  : jsonLen=${jsonLen}  dataStart=${dataStart}\n`)

// --- locate the entry -------------------------------------------------------
let node = header
for (const segment of TARGET.split('/')) {
  node = node?.files?.[segment]
  if (node === undefined) {
    console.error(`entry not found: ${TARGET}`)
    process.exit(1)
  }
}
if (node.files !== undefined) {
  console.error(`entry is a directory: ${TARGET}`)
  process.exit(1)
}
if (node.unpacked === true) {
  console.error('entry is marked unpacked; its content is on disk, not in the archive')
  console.error(`  edit instead: ${dirname(asarPath)}\\app.asar.unpacked\\${TARGET}`)
  process.exit(1)
}

const offset = Number(node.offset)
const size = Number(node.size)
const original = bytes.subarray(dataStart + offset, dataStart + offset + size)
console.log(`entry   : ${TARGET}`)
console.log(`          offset=${offset} size=${size}`)
console.log(`          sha256=${node.integrity?.hash ?? '(none recorded)'}`)

const contentSha = createHash('sha256').update(original).digest('hex')
if (node.integrity?.hash !== undefined && node.integrity.hash !== contentSha) {
  console.log(`          WARNING: the header hash does not match the content hash (${contentSha}).`)
  console.log('          The archive may already be modified; stopping rather than guessing.')
  process.exit(1)
}

// --- build the patched content ----------------------------------------------
let text = original.toString('utf8')
if (Buffer.byteLength(text, 'utf8') !== original.length) {
  console.error('the entry is not plain UTF-8; refusing to patch')
  process.exit(1)
}

// --- already patched? -------------------------------------------------------
//
// APPLYING THIS PATCH TWICE MUST BE A NO-OP. `indexOf(from, anchorAt)` finds the first call still written
// the required way AFTER the anchor — so once the prompt's own call has been fixed, that search walks on
// into the NEXT method that still uses `signal.throwIfAborted();` and makes ITS signal mandatory instead.
// The file length is unchanged and the integrity hash is recomputed, so the damage would be silent: a
// method this patch has nothing to do with would start throwing when called without a signal. Thirteen
// other calls in this same file use the required form, so the walk has somewhere to go.
let alreadyPatched = 0
for (const replacement of REPLACEMENTS) {
  const anchorAt = text.indexOf(replacement.anchor)
  if (anchorAt === -1) continue
  const nextRequired = text.indexOf(replacement.from, anchorAt)
  const nextOptional = text.indexOf(replacement.to, anchorAt)
  if (nextOptional === -1 || (nextRequired !== -1 && nextRequired < nextOptional)) continue
  console.log(`\n  already patched: the first call after the anchor is ${JSON.stringify(replacement.to)}`)
  alreadyPatched += 1
}

if (alreadyPatched === REPLACEMENTS.length) {
  console.log('\nALREADY PATCHED — nothing to do, and nothing was written.')
  console.log('  To undo it: node tools/patch-asar.mjs "<app.asar>" --revert')
  process.exit(0)
}

for (const replacement of REPLACEMENTS) {
  const anchorAt = text.indexOf(replacement.anchor)
  if (anchorAt === -1) {
    console.error(`anchor not found: ${JSON.stringify(replacement.anchor)}`)
    console.error('  the archive may be a different DSH version; nothing was written')
    process.exit(1)
  }
  const at = text.indexOf(replacement.from, anchorAt)
  if (at === -1) {
    console.error(`target not found after the anchor: ${JSON.stringify(replacement.from)}`)
    process.exit(1)
  }
  const after = text.indexOf(replacement.from, at + 1)
  if (after !== -1) {
    console.log(`          note: ${JSON.stringify(replacement.from)} also appears later in the file; patching only the one inside the method`)
  }
  const before = text.slice(0, at)
  const line = before.split('\n').length
  console.log(`\n  line ${line}: ${JSON.stringify(replacement.from)} -> ${JSON.stringify(replacement.to)}`)
  text = before + replacement.to + text.slice(at + replacement.from.length)
}

const patched = Buffer.from(text, 'utf8')
if (patched.length !== original.length) {
  console.error(`\nrefusing to write: length changed from ${original.length} to ${patched.length}.`)
  console.error('This patch is designed to be length-neutral so that no offset shifts.')
  process.exit(1)
}
console.log(`\n  length unchanged: ${patched.length} bytes`)

const newHash = createHash('sha256').update(patched).digest('hex')
console.log(`  new sha256     : ${newHash}`)

// The integrity block records the hash twice for a single-block file (hash + blocks[0]).
const oldHash = node.integrity?.hash
let newJsonText = jsonText
if (oldHash !== undefined) {
  const occurrences = jsonText.split(oldHash).length - 1
  console.log(`  integrity hash appears ${occurrences} time(s) in the header; updating all`)
  newJsonText = jsonText.split(oldHash).join(newHash)
}
if (Buffer.byteLength(newJsonText, 'utf8') !== jsonLen) {
  console.error('refusing to write: the header length changed')
  process.exit(1)
}

// --- dry run by default -----------------------------------------------------
if (!apply) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to patch for real.')
  console.log('Close the DSH app first; a running process has this archive open.')
  process.exit(0)
}

// --- write ------------------------------------------------------------------
// Check the archive is actually writable BEFORE copying a 115MB backup: while the app runs, the
// archive is locked, and failing here with instructions is far better than an EBUSY after a
// wasted copy — or worse, a half-written archive.
try {
  closeSync(openSync(asarPath, 'r+'))
} catch (error) {
  console.error(`\nCANNOT WRITE: ${asarPath}`)
  console.error(`  ${error?.code ?? ''} ${error?.message ?? error}`)
  console.error('')
  console.error('  The DSH app still has this archive open. Quit it COMPLETELY and retry:')
  console.error('    * close every window;')
  console.error('    * check the system tray — an Electron app with a tray icon often keeps running')
  console.error('      after the last window closes, and the lock lives with it;')
  console.error('    * confirm with:  Get-Process "DeepSeek Harness"   (expect no output)')
  console.error('')
  console.error('  Nothing was written.')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${asarPath}.bak-${stamp}`
copyFileSync(asarPath, backup)
console.log(`\nbackup: ${backup} (${(statSync(backup).size / 1048576).toFixed(1)}MB)`)

const fd = openSync(asarPath, 'r+')
const out = Buffer.from(patched)
try {
  writeSyncAt(fd, out, dataStart + offset)
  writeSyncAt(fd, Buffer.from(newJsonText, 'utf8'), jsonStart)
} finally {
  closeSync(fd)
}

/** `writeFileSync` cannot target an offset; a positioned write can. */
function writeSyncAt(descriptor, buffer, position) {
  let written = 0
  while (written < buffer.length) {
    written += writeSync(descriptor, buffer, written, buffer.length - written, position + written)
  }
}

// --- verify by re-reading ---------------------------------------------------
const check = readFileSync(asarPath)
const checkHeaderSize = check.readUInt32LE(4)
const checkJsonLen = check.readUInt32LE(12)
if (checkHeaderSize !== headerSize || checkJsonLen !== jsonLen) {
  console.error('VERIFY FAILED: header size changed')
  process.exit(1)
}
const checkJson = JSON.parse(check.toString('utf8', 16, 16 + checkJsonLen))
let checkNode = checkJson
for (const segment of TARGET.split('/')) checkNode = checkNode.files[segment]
const checkContent = check.subarray(8 + checkHeaderSize + offset, 8 + checkHeaderSize + offset + size)
const checkHash = createHash('sha256').update(checkContent).digest('hex')
const ok = checkNode.integrity.hash === checkHash && checkContent.toString('utf8').includes('signal?.throwIfAborted()')
console.log(`verify: header hash matches content = ${checkNode.integrity.hash === checkHash}`)
console.log(`verify: patched call present          = ${checkContent.toString('utf8').includes('signal?.throwIfAborted()')}`)
console.log(ok ? '\nPATCHED. Restart the DSH app, then run: tools\\run.cmd agent-smoke.mjs' : '\nVERIFY FAILED — restore with --revert')
process.exit(ok ? 0 : 1)
