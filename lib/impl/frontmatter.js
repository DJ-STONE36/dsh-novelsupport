/**
 * YAML front matter for chapter markdown files.
 *
 * Chapters are the one document type written as Markdown rather than JSON: the
 * prose must stay readable and `git diff`-able, and the AI skills edit it
 * directly. Everything structural about a chapter (order, status, which
 * entities it involves) lives in the front matter instead, so the prose body is
 * never polluted with bookkeeping.
 *
 * Pure, apart from the `js-yaml` import — which is an external package, so it
 * stays in Node's normal module cache and is deliberately NOT part of this
 * package's hot-reload arrangement.
 */

import { dump as yamlDump, load as yamlLoad } from 'js-yaml'

/**
 * Field order in the emitted front matter. Textual order is the only thing
 * making these files pleasant to hand-edit, and `js-yaml` preserves the key
 * order it is given — so the serializer builds the object in this order rather
 * than sorting.
 */
export const CHAPTER_FIELD_ORDER = [
  'id',
  'title',
  'order',
  'status',
  'volumeRef',
  'outlineRef',
  'characters',
  'places',
  'summary',
  'custom',
]

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Split a chapter file into front matter and body.
 *
 * Never throws: a chapter whose front matter is malformed is a real state a
 * user can create by hand, and the reader must still be able to show the prose.
 * The failure travels back as `error` alongside the raw body.
 */
export function parseFrontMatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  if (!source.startsWith('---')) {
    return { meta: {}, body: source, hasFrontMatter: false, error: null }
  }
  const match = FRONT_MATTER.exec(source)
  if (match === null) {
    return { meta: {}, body: source, hasFrontMatter: false, error: 'front matter is not terminated by ---' }
  }
  const body = source.slice(match[0].length)
  let parsed
  try {
    parsed = yamlLoad(match[1])
  } catch (error) {
    return { meta: {}, body, hasFrontMatter: true, error: `front matter is not valid YAML: ${error.message}` }
  }
  if (parsed === null || parsed === undefined) {
    return { meta: {}, body, hasFrontMatter: true, error: null }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { meta: {}, body, hasFrontMatter: true, error: 'front matter must be a mapping' }
  }
  return { meta: parsed, body, hasFrontMatter: true, error: null }
}

/** Render front matter + body back into a chapter file. */
export function serializeFrontMatter(meta, body) {
  const ordered = {}
  for (const key of CHAPTER_FIELD_ORDER) {
    if (meta[key] !== undefined) ordered[key] = meta[key]
  }
  for (const [key, value] of Object.entries(meta)) {
    if (ordered[key] === undefined && value !== undefined) ordered[key] = value
  }
  const yamlText = yamlDump(ordered, { lineWidth: 140, noRefs: true, sortKeys: false }).trimEnd()
  const cleanBody = String(body ?? '').replace(/^(\r?\n)+/, '')
  return `---\n${yamlText}\n---\n\n${cleanBody}`
}

/** A fresh chapter's front matter, in field order. */
export function newChapterMeta({ id, title, order }) {
  return {
    id,
    title: String(title ?? ''),
    order: Number.isFinite(order) ? order : 10,
    status: 'draft',
    volumeRef: null,
    outlineRef: null,
    characters: [],
    places: [],
    summary: '',
    // Chapters get the same escape hatch as every other entity (data-model
    // principle 3), so a note like 本章要埋伏笔 needs no schema change.
    custom: {},
  }
}
