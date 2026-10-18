/**
 * Does the host let a plugin start an agent run?
 *
 * This exists because that question has a definite answer and a vague one is useless: the plugin
 * either can drive `sessionController.prompt` or it cannot, and either way the answer should be
 * one command away rather than buried in a conversation. It talks only to the plugin's own
 * routes, so it needs no GUI, no credential, and no knowledge of the host's internals.
 *
 * Currently expected to report BLOCKED. The host-side analysis is kept in the
 * maintainer's private notes (local paths; not distributed with the repository).
 *
 * Usage: node tools/agent-smoke.mjs [--root <projectDir>] [--session <sessionId>]
 *
 * Exit codes: 0 = the agent ran and produced text, 1 = blocked or failed.
 */
import { resolve } from 'node:path'

const API = 'http://127.0.0.1:19387/dsh-novel'
const HEADERS = { 'x-dsh-novel': '1', 'content-type': 'application/json; charset=utf-8' }

const args = process.argv.slice(2)
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const root = resolve(readFlag('root', 'D:\\documents\\GitHub\\my-project'))
const wantSession = readFlag('session', null)

/**
 * The most likely reason this script fails is that nothing is listening: the plugin only exists
 * while the desktop app is running. An unhandled `fetch failed` would bury that, so the very
 * first call reports it in words.
 */
const reachable = async () => {
  try {
    await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) })
    return true
  } catch {
    return false
  }
}
if (!(await reachable())) {
  console.log(`FAIL  nothing is listening on ${API}`)
  console.log('      The plugin is served by the running DSH app, so start it first.')
  console.log('      Nothing below can run until /health answers.')
  process.exit(1)
}

const get = async (path) => {
  const response = await fetch(API + path)
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const post = async (path, payload) => {
  const response = await fetch(API + path, { method: 'POST', headers: HEADERS, body: JSON.stringify(payload) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

console.log(`project: ${root}\n`)

// --- 1. can the host see sessions for this project? -------------------------
const sessions = await get(`/sessions?root=${encodeURIComponent(root)}`)
if (sessions.status !== 200 || sessions.body.available !== true) {
  console.log(`FAIL  /sessions -> HTTP ${sessions.status} ${JSON.stringify(sessions.body).slice(0, 200)}`)
  console.log('      the host composes no sessionController, so nothing below can work')
  process.exit(1)
}
const model = sessions.body.defaultModel
console.log(`ok    /sessions: ${sessions.body.sessions.length} session(s) rooted here`)
console.log(`      default model: ${model ? `${model.provider} / ${model.model} (${model.reasoningEffort})` : '(not reported)'}`)

const busy = sessions.body.sessions.filter((session) => session.running)
if (busy.length > 0) console.log(`      ${busy.length} currently running`)

// --- 2. ask the agent to do something trivial -------------------------------
const payload = { root, text: '只回复两个字：收到' }
if (wantSession !== null) payload.sessionId = wantSession
else payload.create = true // a fresh session, so the result is not confused by older state

const started = await post('/agent/prompt', payload)
if (started.status !== 202) {
  console.log(`\nBLOCKED  /agent/prompt -> HTTP ${started.status}  code=${started.body.code ?? '(none)'}`)
  console.log(`         ${started.body.error ?? ''}`)
  if (started.body.code === 'agent-prompt-unsupported') {
    console.log('\n  This is the known host limitation, not a problem with this project:')
    console.log('  `sessionController.prompt` requires an AbortSignal that its own argument')
    console.log('  serialization rejects, so no argument form works. Six were measured.')
    console.log('  Details: maintainer\'s private notes (not in this repository)')
  }
  process.exit(1)
}

const sessionId = started.body.sessionId
const sinceSeq = started.body.seqBefore ?? 0
console.log(`\nok    /agent/prompt accepted (202)  session=${sessionId}${started.body.created ? ' (new)' : ''}`)

// --- 3. wait for the turn to end --------------------------------------------
const deadline = Date.now() + 5 * 60 * 1000
let running = true
process.stdout.write('      running')
while (running && Date.now() < deadline) {
  await new Promise((done) => setTimeout(done, 1000))
  const status = await get(`/agent/status?sessionId=${encodeURIComponent(sessionId)}`)
  if (status.status !== 200) {
    console.log(`\nFAIL  /agent/status -> HTTP ${status.status}`)
    process.exit(1)
  }
  running = status.body.running === true
  process.stdout.write('.')
}
console.log(running ? '\nFAIL  timed out waiting for the run' : '\nok    the run finished')

// --- 4. read what the agent said --------------------------------------------
const result = await get(`/agent/result?sessionId=${encodeURIComponent(sessionId)}&sinceSeq=${sinceSeq}`)
if (result.status !== 200) {
  console.log(`FAIL  /agent/result -> HTTP ${result.status}`)
  process.exit(1)
}
const { finished, reason, text, usage, writes, eventCount } = result.body
console.log(`ok    /agent/result: finished=${finished} reason=${JSON.stringify(reason)} events=${eventCount}`)
if (usage !== null && usage !== undefined) console.log(`      usage: ${JSON.stringify(usage)}`)
if (Array.isArray(writes) && writes.length > 0) console.log(`      files touched: ${writes.join(', ')}`)
console.log(`\nagent said: ${JSON.stringify(String(text ?? '')).slice(0, 400)}`)

if (finished !== true) {
  console.log('\nFAIL  no turn/end was recorded, so the run did not complete cleanly')
  process.exit(1)
}
if (String(text ?? '').trim() === '') {
  console.log('\nFAIL  the run completed but produced no text')
  process.exit(1)
}
console.log('\nPASS  a plugin can drive the agent.')
