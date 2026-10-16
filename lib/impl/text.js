/**
 * Text measures.
 *
 * `countWords` exists because chapter length is derived, not stored
 * (docs/data-model.md principle 2: derived data never lands on disk — it would
 * be a second source of truth, and a stale one the moment the AI skills edit a
 * file directly). So it is computed on read, here, where both the browser and
 * any future importer get the same answer.
 *
 * Dependency-free: see the note at the top of `schema.js`.
 */

/** CJK ranges that count as one word each. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g
/** Runs of Latin letters/digits count as one word each. */
const LATIN_WORD = /[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g

/**
 * Word count for a mixed Chinese/Latin manuscript.
 *
 * Each CJK character counts one, and each Latin/digit run counts one — which is
 * how a Chinese novelist counts: 「第一章」 is three words, not one. Counting
 * whitespace-separated tokens instead would report a 5000-character Chinese
 * chapter as a single word, and `wc -w`-style counts are meaningless for text
 * with no spaces in it.
 */
export function countWords(text) {
  const body = String(text ?? '')
  const cjk = body.match(CJK)
  const latin = body.match(LATIN_WORD)
  return (cjk === null ? 0 : cjk.length) + (latin === null ? 0 : latin.length)
}
