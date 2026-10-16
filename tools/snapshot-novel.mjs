/**
 * Snapshot `novel/` so a live skill test can be verified precisely.
 *
 * An agent writing through its own file tools bypasses the plugin's validator gate, so the
 * only way to know what it changed is to compare before and after. The skills are supposed
 * to touch `novel/draft/` and (for style) `project.json` only — this proves whether they did.
 *
 * Usage:
 *   node tools/snapshot-novel.mjs save <label>
 *   node tools/snapshot-novel.mjs diff <label>
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'novel'
const [, , mode = 'save', label = 'before'] = process.argv
const FILE = `_snapshot-${label}.json`

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full.replace(/\\/g, '/'))
  }
  return out
}

const files = existsSync(ROOT) ? walk(ROOT).sort() : []
const state = {}
for (const file of files) {
  const bytes = readFileSync(file)
  state[file] = {
    sha: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
    bytes: statSync(file).size,
  }
}

if (mode === 'save') {
  writeFileSync(FILE, JSON.stringify(state, null, 2))
  console.log(`saved ${files.length} files to ${FILE}`)
  for (const file of files) console.log(`  ${state[file].sha}  ${String(state[file].bytes).padStart(6)}B  ${file}`)
} else {
  if (!existsSync(FILE)) {
    console.log(`no snapshot at ${FILE}`)
    process.exit(1)
  }
  const before = JSON.parse(readFileSync(FILE, 'utf8'))
  const added = Object.keys(state).filter((file) => before[file] === undefined)
  const removed = Object.keys(before).filter((file) => state[file] === undefined)
  const changed = Object.keys(state).filter((file) => before[file] !== undefined && before[file].sha !== state[file].sha)
  console.log(`=== changes since ${label} ===`)
  for (const file of added) console.log(`  ADDED    ${file}  (${state[file].bytes}B)`)
  for (const file of changed) console.log(`  CHANGED  ${file}  ${before[file].bytes}B -> ${state[file].bytes}B`)
  for (const file of removed) console.log(`  REMOVED  ${file}`)
  if (added.length + changed.length + removed.length === 0) console.log('  (nothing changed)')

  // The skills promise to leave the setting documents alone.
  const trespass = [...added, ...changed, ...removed].filter(
    (file) => file.startsWith('novel/setting/') || file.startsWith('novel/outline/') || file.endsWith('relations.json'),
  )
  console.log(
    trespass.length === 0
      ? '\nsetting/ , outline/ and relations.json: untouched'
      : `\nTRESPASSED (the skills promise not to touch these):\n${trespass.map((file) => `  ${file}`).join('\n')}`,
  )
  // `.prev` backups are an artefact of the plugin's own writes, not of the agent's.
  const backups = [...added, ...changed].filter((file) => file.endsWith('.prev'))
  if (backups.length > 0) console.log(`\n(${backups.length} .prev backup(s) — written by the plugin, not the agent)`)
}
