/**
 * Broad recovery search: every session log, every snapshot of `setting/items.json`.
 *
 * MY transcript only records requests I made. Edits made through the GUI are browser
 * fetches and never appear in it — but they may appear in another session's log, so the
 * search covers every session directory, not just this workspace's.
 *
 * Usage: node tools/recover-items.mjs
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Session logs are concatenated zstd frames; node's sync API reads only the first. */
function decompressAll(path) {
  const buffer = readFileSync(path)
  const offsets = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) offsets.push(i)
  }
  const parts = []
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      /* a partial trailing frame */
    }
  }
  return parts.join('')
}

const roots = ['D:\\dsh-home\\sessions']
const logs = []
for (const root of roots) {
  if (!existsSync(root)) continue
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    for (const session of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const file = join(workspaceDir, session.name, 'session.v4.jsonl.zstd')
      if (existsSync(file)) logs.push({ workspace: workspace.name, session: session.name, file, size: statSync(file).size })
    }
  }
}
console.log(`scanning ${logs.length} session logs\n`)

const snapshots = []
for (const log of logs) {
  let text = null
  try {
    text = decompressAll(log.file)
  } catch (error) {
    console.log(`  ${log.session}: decompress failed (${error.message})`)
    continue
  }
  let index = text.indexOf('categories')
  let found = 0
  while (index !== -1) {
    const start = text.lastIndexOf('{', index)
    if (start !== -1) {
      let depth = 0
      let inString = false
      let escaped = false
      let end = -1
      for (let i = start; i < Math.min(text.length, start + 400000); i += 1) {
        const ch = text[i]
        if (escaped) {
          escaped = false
          continue
        }
        if (ch === '\\') {
          escaped = true
          continue
        }
        if (ch === '"') {
          inString = !inString
          continue
        }
        if (inString) continue
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      if (end !== -1) {
        const unescaped = text
          .slice(start, end + 1)
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .replace(/\\n/g, '\n')
        try {
          const parsed = JSON.parse(unescaped)
          if (Array.isArray(parsed.categories) || Array.isArray(parsed.items)) {
            snapshots.push({
              session: log.session,
              offset: start,
              categories: (parsed.categories ?? []).length,
              items: (parsed.items ?? []).length,
              compact: JSON.stringify(parsed).length,
              value: parsed,
            })
            found += 1
          }
        } catch {
          /* not a whole document */
        }
      }
    }
    index = text.indexOf('categories', index + 1)
  }
  if (found > 0) console.log(`  ${log.session}: ${found} snapshot(s), ${text.length} chars`)
}

console.log(`\ntotal snapshots across all sessions: ${snapshots.length}`)
snapshots.sort((a, b) => a.compact - b.compact)
for (const snapshot of snapshots.slice(-8)) {
  console.log(
    `  ${snapshot.session}  categories=${snapshot.categories} items=${snapshot.items}  ${snapshot.compact}B  ${JSON.stringify((snapshot.value.items ?? []).map((i) => i.name))}`,
  )
}

if (snapshots.length === 0) {
  console.log('\nnothing recoverable')
  process.exit(1)
}
const best = snapshots[snapshots.length - 1]
console.log(`\n--- richest snapshot (${best.compact} bytes) ---`)
console.log(JSON.stringify(best.value, null, 2))
writeFileSync('_recovered-items.json', `${JSON.stringify(best.value, null, 2)}\n`)
console.log('\nwritten to _recovered-items.json (NOT applied)')
