/**
 * Discover the session event vocabulary from a real session log.
 *
 * `ctx.sessionController.prompt()` writes an event into the session. The log is therefore the
 * authority on what a prompt looks like — better than guessing at argument shapes, and local.
 *
 * Logs are concatenated zstd frames, and node's sync API reads only the first, so the frames
 * are split on the zstd magic before decompressing.
 *
 * Usage: node tools/session-events.mjs [sessionIdFragment]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'D:\\dsh-home\\sessions'
const fragment = process.argv[2] ?? 'session-4344ee66'

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

let found = null
for (const workspace of readdirSync(ROOT, { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue
  for (const session of readdirSync(join(ROOT, workspace.name), { withFileTypes: true })) {
    if (!session.isDirectory() || !session.name.includes(fragment)) continue
    const file = join(ROOT, workspace.name, session.name, 'session.v4.jsonl.zstd')
    if (existsSync(file)) found = { file, name: session.name }
  }
}
if (found === null) {
  console.log(`no session matching ${fragment}`)
  process.exit(1)
}

const text = decompressAll(found.file)
const events = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  try {
    events.push(JSON.parse(line))
  } catch {
    /* a torn line at a frame boundary */
  }
}

console.log(`session ${found.name}: ${events.length} events\n`)

const counts = new Map()
for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
console.log('=== event types ===')
for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(6)}  ${type}`)
}

// The shape of an event that carries user input — what `prompt()` must produce.
console.log('\n=== candidate input events (data shape) ===')
const interesting = events.filter((event) => /input|user|prompt|message|turn/.test(String(event.type)))
const seen = new Set()
for (const event of interesting.slice(0, 400)) {
  if (seen.has(event.type)) continue
  seen.add(event.type)
  const data = event.data ?? {}
  console.log(`--- ${event.type}`)
  console.log(`    data keys: ${Object.keys(data).join(', ')}`)
  console.log(`    ${JSON.stringify(data).slice(0, 420)}`)
}

// `workspace/changes` is what answers "which files did this turn touch?" — the piece needed to
// reconcile an agent run with unsaved editor state.
console.log('\n=== workspace/changes ===')
const changes = events.filter((event) => event.type === 'workspace/changes').slice(-2)
if (changes.length === 0) console.log('  (none recorded)')
for (const event of changes) {
  console.log(`  seq ${event.seq}`)
  console.log(`  ${JSON.stringify(event.data).slice(0, 900)}`)
}

// How the agent's finished prose arrives: the last text block of an assistant message.
console.log('\n=== an assistant text block ===')
for (const event of [...events].reverse()) {
  if (event.type !== 'assistant/message') continue
  const blocks = event.data?.message?.content ?? []
  const textBlocks = blocks.filter((block) => block?.type === 'text')
  if (textBlocks.length === 0) continue
  console.log(`  seq ${event.seq}, block types: ${blocks.map((block) => block.type).join(', ')}`)
  console.log(`  ${JSON.stringify(textBlocks[0]).slice(0, 300)}`)
  break
}

// `agent/inbox/spliced` is the event a prompt creates. A failing prompt reports this event as
// carrying "non-JSON-serializable data", so a WORKING one is the reference shape to compare to.
console.log('\n=== agent/inbox/spliced (a working one) ===')
const splices = events.filter((event) => event.type === 'agent/inbox/spliced')
console.log(`  ${splices.length} of them`)
for (const event of splices.slice(0, 2)) {
  const data = event.data ?? {}
  console.log(`--- seq ${event.seq}`)
  console.log(`    data keys: ${Object.keys(data).join(', ')}`)
  // Show the structure with types, so a function or a class instance is visible.
  const describe = (value, depth = 0) => {
    if (value === null) return 'null'
    if (Array.isArray(value)) return `[${value.length} × ${value.length === 0 ? '' : describe(value[0], depth + 1)}]`
    if (typeof value === 'function') return '<<FUNCTION — not serializable>>'
    if (typeof value !== 'object') return typeof value
    if (depth >= 3) return '{…}'
    return `{${Object.entries(value).map(([k, v]) => `${k}: ${describe(v, depth + 1)}`).join(', ')}}`
  }
  console.log(`    ${describe(data)}`)
  console.log(`    json bytes: ${JSON.stringify(data).length}`)
}


