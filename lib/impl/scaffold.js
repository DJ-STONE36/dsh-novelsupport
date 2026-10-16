/**
 * Project scaffolding — what a brand-new project consists of.
 *
 * Pure: produces a plan, writes nothing. The router performs the I/O, which
 * keeps this module testable without a filesystem and keeps the refusal rules
 * (already exists? unwritable?) next to the code that knows about the request.
 *
 * Dependency-free: see the note at the top of `schema.js`.
 */

/**
 * @param schema - the loaded `schema.js` module.
 * @param title - the user's project title.
 * @param now - ISO timestamp, injectable so the plan is deterministic in tests.
 * @returns `{ dirs, files, calendar }` where `files` is `{ rel, value }[]`.
 */
export function planScaffold({ schema, title, now }) {
  const documents = schema.emptyDocuments({ title, now })
  return {
    dirs: [...schema.DIRS],
    files: Object.entries(documents).map(([rel, value]) => ({ rel, value })),
    calendar: documents[schema.FILES.timeline].calendar,
  }
}

/** A short, human-readable summary of a project, for listings and headers. */
export function summarizeProject({ project, entries }) {
  const count = (prefix, suffix = '') =>
    entries.filter((entry) => entry.type === 'file' && entry.path.startsWith(prefix) && entry.path.endsWith(suffix)).length
  return {
    id: project?.id ?? null,
    title: project?.title ?? '',
    schemaVersion: project?.schemaVersion ?? null,
    chapters: count('draft/', '.md'),
    updatedAt: project?.updatedAt ?? null,
  }
}
