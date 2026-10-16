/**
 * Path containment — the security core of the host half.
 *
 * The browser half supplies the project root (it is the side that knows the
 * session's working directory), so nothing here may trust it. Every write is
 * confined to `<root>/novel/**`; a path that escapes is refused, not
 * sanitized. Callers must treat a throw as a refusal.
 *
 * Dependency-free: see the note at the top of `schema.js`.
 */

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'

/** Windows device names are not usable as file names, with or without extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export function httpError(status, code, message) {
  const error = new Error(message)
  error.httpStatus = status
  error.code = code
  return error
}

/** A refusal the caller can render to the user. */
export function badRequest(code, message) {
  return httpError(400, code, message)
}

/**
 * Validate an absolute project root supplied by the browser.
 *
 * Intent is deliberately narrow: an existing directory the user picked. It does
 * NOT have to be a novel project yet — creating one inside it is the point.
 */
export function resolveRoot(rawRoot, { exists, isDirectory }) {
  if (typeof rawRoot !== 'string' || rawRoot.trim() === '') {
    // Name the received value. "root is required" alone cannot distinguish a
    // missing parameter, an empty string, and a client that sent no body at all
    // — and those have three different causes.
    throw badRequest('root-required', `root is required and must be an absolute path (received ${JSON.stringify(rawRoot ?? null)})`)
  }
  if (!isAbsolute(rawRoot)) {
    throw badRequest('root-not-absolute', `root must be absolute, got ${JSON.stringify(rawRoot)}`)
  }
  const root = resolve(rawRoot)
  if (!exists(root)) {
    throw badRequest('root-missing', `root does not exist: ${root}`)
  }
  if (!isDirectory(root)) {
    throw badRequest('root-not-directory', `root is not a directory: ${root}`)
  }
  return root
}

/**
 * Normalize a project-relative path, refusing anything that could address
 * something outside the project directory.
 *
 * Rejections are explicit rather than normalized away: a path containing `..`
 * or a drive letter is a caller bug or an attack, and silently repairing either
 * hides the fact that something is wrong.
 */
export function normalizeRelative(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw badRequest('path-required', 'path is required')
  }
  const cleaned = relPath.replace(/\\/g, '/').trim()

  if (cleaned.includes('\0')) {
    throw badRequest('path-nul', 'path must not contain a null byte')
  }
  if (isAbsolute(cleaned) || /^[a-z]:/i.test(cleaned)) {
    throw badRequest('path-absolute', `path must be project-relative, got ${relPath}`)
  }
  if (cleaned.startsWith('/')) {
    throw badRequest('path-absolute', `path must be project-relative, got ${relPath}`)
  }
  // A colon on Windows opens an alternate data stream (`file.txt:secret`),
  // which would write outside the file the name appears to address.
  if (cleaned.includes(':')) {
    throw badRequest('path-colon', `path must not contain ':' (alternate data streams), got ${relPath}`)
  }
  const segments = cleaned.split('/').filter((part) => part !== '' && part !== '.')
  if (segments.length === 0) {
    throw badRequest('path-empty', 'path resolves to nothing')
  }
  for (const segment of segments) {
    if (segment === '..') {
      throw badRequest('path-traversal', `path must not contain '..', got ${relPath}`)
    }
    if (WINDOWS_DEVICE.test(segment)) {
      throw badRequest('path-device', `path segment is a reserved device name: ${segment}`)
    }
  }
  return segments.join('/')
}

/**
 * The real path of `abs`, or of its deepest existing ancestor.
 *
 * `realpathSync.native` is REQUIRED, not a micro-optimisation. On Windows this build,
 * plain `realpathSync` does **not** resolve a directory junction — it returns the path
 * with the junction still in it — while `realpathSync.native` (libuv's `uv_fs_realpath`)
 * returns the real target. Using the plain form made this whole check a no-op for
 * junctions, which is the realistic Windows case: creating one needs no elevation,
 * unlike a symbolic link.
 *
 * A target that does not exist yet cannot be resolved, but the directory it will be
 * created in can — and that is where a link would have to sit to redirect the write.
 */
function realPathOfNearestAncestor(abs) {
  const realpath = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync
  let candidate = abs
  for (let hops = 0; hops < 64; hops += 1) {
    try {
      return realpath(candidate)
    } catch {
      const parent = dirname(candidate)
      if (parent === candidate) return null
      candidate = parent
    }
  }
  return null
}

/** Is `child` inside `parent`, in resolved (physical) terms? */
function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolve a project-relative path to an absolute one, proving containment.
 *
 * Three independent checks:
 *
 *   1. the segment scan in `normalizeRelative` rejects the *intent*;
 *   2. `relative()` on the lexical path proves the *outcome* is inside;
 *   3. the physical check below proves the outcome is inside **after links are
 *      resolved**, which the first two cannot see.
 *
 * The third was missing, and it is the only one that survives a junction: a link
 * inside the project resolves elsewhere, and both string checks pass happily because
 * the *string* is inside the root. `dsh-novel` in the profile's `node_modules` is
 * exactly such a junction, and reading or writing through it left the project.
 *
 * A symlinked final component is refused too when `lstat` can see it. Note that a
 * directory JUNCTION is not reported as a symbolic link by `lstat`, so that check alone
 * would miss it — the physical check above is what catches junctions.
 */
export function resolveInside(projectDir, relPath) {
  const safe = normalizeRelative(relPath)
  const abs = resolve(projectDir, safe)
  const rel = relative(projectDir, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw badRequest('path-escape', `path escapes the project directory: ${relPath}`)
  }

  const physicalRoot = realPathOfNearestAncestor(projectDir)
  const physicalTarget = realPathOfNearestAncestor(abs)
  if (physicalRoot !== null && physicalTarget !== null && !isInside(physicalRoot, physicalTarget)) {
    throw badRequest('path-link-escape',
      `path resolves outside the project directory through a link: ${relPath}`)
  }

  try {
    if (lstatSync(abs).isSymbolicLink()) {
      throw badRequest('path-link', `path is a symbolic link, which is not writable: ${relPath}`)
    }
  } catch (error) {
    // A missing target is the normal case for a create; a refusal must propagate.
    if (error?.httpStatus !== undefined) throw error
  }

  return { abs, rel: safe }
}

/** The project directory for a root. */
export function projectDirFor(root, dataDir) {
  return join(root, dataDir)
}
