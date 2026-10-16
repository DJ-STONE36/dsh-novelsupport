/**
 * Filesystem primitives: atomic writes and a bounded directory listing.
 *
 * Dependency-free and path-agnostic — it receives absolute paths that
 * `paths.js` has already proved contained. Keeping containment and I/O apart
 * means there is exactly one place to audit each.
 *
 * Atomicity matters more here than in a typical app: the AI skills
 * (`novel-writer` et al.) edit these same files through the agent's own file
 * tools while the GUI writes them through this API. A plain truncate-and-write
 * would let those two interleave and lose whichever finished first.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

/** Synchronous sleep, for the rename retry below. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function exists(abs) {
  return existsSync(abs)
}

export function isDirectory(abs) {
  try {
    return statSync(abs).isDirectory()
  } catch {
    return false
  }
}

export function statOrNull(abs) {
  try {
    const stat = statSync(abs)
    return { size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() }
  } catch {
    return null
  }
}

export function ensureDir(abs) {
  mkdirSync(abs, { recursive: true })
}

export function readText(abs) {
  return readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')
}

/** Read a binary file. Used for image assets, which must not be decoded as text. */
export function readBinary(abs) {
  return readFileSync(abs)
}

/**
 * Rename a temp file over its target, retrying the transient Windows refusals.
 *
 * Extracted so the text and binary writers cannot drift apart: the retry is the part that
 * matters, and a second hand-written copy is a second chance to get it wrong.
 */
function replaceWithRetry(tmp, abs) {
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(tmp, abs)
      return
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(error.code)) throw error
      sleepMs(15 * (attempt + 1))
    }
  }
  throw lastError
}

export function readJson(abs) {
  return JSON.parse(readText(abs))
}

/**
 * Write a file atomically: full write to a sibling temp file, then rename over
 * the target. A reader therefore sees either the old file or the new one,
 * never a half-written one.
 *
 * The rename retries because Windows transiently refuses to replace a file that
 * another process holds open — an indexer, a virus scanner, or the agent's own
 * file watcher — with EPERM/EBUSY/EACCES. Those clear in milliseconds; failing
 * the user's save outright would not.
 */
/**
 * Keep one previous generation of a file beside it before replacing it.
 *
 * This exists because the plugin CAN destroy data, and did: a wrong request body, a
 * wrong-typed `value`, a hand-written path, and a trailing space that Windows strips
 * all reach a write, and every one of them was unrecoverable. The audit found more of
 * the same family — `content: {}` becomes the literal string `[object Object]` and
 * returns 200 OK, and `value: []` wipes a whole document with zero validation errors.
 *
 * A `.prev` sibling turns "lost forever" into "one step back", which is the cheapest
 * insurance available on a file the author spent hours on.
 *
 * Deliberately not a `.md` or `.json` name: `draft/` is scanned for `.md` chapters, and
 * the JSON documents are addressed by an allow-list, so a backup can never be mistaken
 * for content.
 *
 * Best-effort by design: failing to back up must never block or fail the write itself,
 * because the write is the user's actual intent.
 */
export function keepPrevious(abs) {
  try {
    if (!existsSync(abs)) return
    copyFileSync(abs, `${abs}.prev`)
  } catch {
    /* no backup is not a reason to refuse the write */
  }
}

export function writeTextAtomic(abs, text) {
  ensureDir(dirname(abs))
  keepPrevious(abs)
  const tmp = `${abs}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, text, 'utf8')
    replaceWithRetry(tmp, abs)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* the temp file is already gone, or will be orphaned; not worth masking the real error */
    }
    throw error
  }
}

/**
 * Write a binary file atomically, with the same temp-then-rename discipline as text.
 *
 * No `.prev` generation, unlike text. The map document is what references an asset, so the
 * document's own `.prev` is the thing worth keeping; a stale image on disk is harmless and a
 * second copy would double the disk cost of every import.
 */
export function writeBinaryAtomic(abs, buffer) {
  ensureDir(dirname(abs))
  const tmp = `${abs}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, buffer)
    replaceWithRetry(tmp, abs)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* same reasoning as above */
    }
    throw error
  }
}

export function writeJsonAtomic(abs, value) {
  writeTextAtomic(abs, `${JSON.stringify(value, null, 2)}\n`)
}

/** Delete a file, tolerating its absence. */
export function removeFile(abs) {
  rmSync(abs, { force: true })
}

/**
 * Depth-limited listing. Bounded on purpose: an accidental symlink loop or a
 * huge tree must not turn a status request into a hang.
 */
export function listTree(abs, depth = 3, { maxEntries = 2000 } = {}) {
  const out = []
  const walk = (current, level, prefix) => {
    if (out.length >= maxEntries) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      out.push({ path: prefix || '.', type: 'error', error: String(error.code ?? error.message) })
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxEntries) return
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        out.push({ path: rel, type: 'dir' })
        if (level < depth) walk(child, level + 1, rel)
      } else if (entry.isFile()) {
        const stat = statOrNull(child)
        out.push({ path: rel, type: 'file', size: stat?.size ?? null, mtimeMs: stat?.mtimeMs ?? null })
      } else {
        out.push({ path: rel, type: 'other' })
      }
    }
  }
  walk(abs, 1, '')
  return { entries: out, truncated: out.length >= maxEntries }
}
