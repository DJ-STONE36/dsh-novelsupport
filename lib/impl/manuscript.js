/**
 * 全书导出：把章节拼成一份手稿。
 *
 * WHY THIS IS A HOST MODULE, AND A PURE ONE. The chapters live on disk and are read by the host, so
 * assembling a manuscript is host work — but every decision about WHAT the manuscript looks like is a
 * function of the chapter list and the options, with no file I/O in it. Pure means the offline suite can
 * assert the exact bytes of a finished book, including the parts that are easy to get wrong: narrative
 * order, an unreadable chapter, an empty chapter, a title that is blank.
 *
 * WHY IT MATTERS THAT NOTHING IS SILENTLY DROPPED. A chapter that cannot be read must appear in
 * `skipped`, not vanish. An export that quietly leaves out chapter twelve is worse than one that fails:
 * the author sends the file to someone before noticing.
 *
 * WORD COUNT COMES FROM `text.js`, the same function the editor uses. Two counters would eventually
 * disagree, and then the author would be looking at two different lengths for the same book.
 */
import { countWords } from './text.js'

/** The narrative order, with a stable tiebreak so the same project always exports the same bytes. */
function inNarrativeOrder(chapters) {
  const list = Array.isArray(chapters) ? chapters.slice() : []
  return list.sort((left, right) => {
    const a = Number(left?.meta?.order)
    const b = Number(right?.meta?.order)
    const leftOrder = Number.isFinite(a) ? a : Number.MAX_SAFE_INTEGER
    const rightOrder = Number.isFinite(b) ? b : Number.MAX_SAFE_INTEGER
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    // Equal or missing `order` falls back to the path, which is the filename — so the export is
    // deterministic rather than dependent on directory-listing order.
    return String(left?.path ?? '').localeCompare(String(right?.path ?? ''))
  })
}

/** A chapter's heading. A blank title still gets a heading, or the chapter reads as an orphan. */
function chapterHeading(meta, index, level) {
  const title = typeof meta?.title === 'string' ? meta.title.trim() : ''
  const hashes = '#'.repeat(level)
  if (title !== '') return `${hashes} ${title}`
  // The file name is the honest fallback: it is what the author sees in the chapter list, and inventing
  // 「第 N 章」 would contradict a book whose own numbering lives in the titles.
  const id = typeof meta?.id === 'string' && meta.id !== '' ? meta.id : null
  return `${hashes} ${id === null ? `（无标题 ${index + 1}）` : id}`
}

/**
 * Assemble a manuscript.
 *
 * @param {object} input
 * @param {Array} input.chapters - the host's chapter list: `{ path, meta, body, unreadable? }`.
 * @param {string} input.projectTitle
 * @param {object} [input.options]
 * @returns `{ text, included, skipped, wordCount }` — `skipped` names every chapter left out and why.
 */
export function buildManuscript(input) {
  const chapters = inNarrativeOrder(input?.chapters)
  const options = input?.options !== null && typeof input?.options === 'object' ? input.options : {}
  const titlePage = options.titlePage !== false
  const headingLevel = Number(options.headingLevel) === 1 ? 1 : 2
  const includeSummary = options.summary === true
  const includeMeta = options.meta === true
  const separator = typeof options.separator === 'string' ? options.separator : '\n\n---\n\n'
  const projectTitle = typeof input?.projectTitle === 'string' ? input.projectTitle.trim() : ''

  const parts = []
  const included = []
  const skipped = []

  if (titlePage) {
    // A blank project title gets the heading it deserves rather than an empty line: a manuscript that
    // starts with nothing looks like a broken file.
    parts.push(`# ${projectTitle === '' ? '未命名' : projectTitle}`)
  }

  const hashes = '#'.repeat(headingLevel)
  for (const [index, chapter] of chapters.entries()) {
    if (chapter?.unreadable === true) {
      skipped.push({ path: chapter?.path ?? null, reason: 'unreadable', detail: chapter?.meta?.error ?? null })
      continue
    }
    const body = typeof chapter?.body === 'string' ? chapter.body.trim() : ''
    const heading = chapterHeading(chapter?.meta, index, headingLevel)
    // AN EMPTY CHAPTER IS STILL A CHAPTER. Dropping it would renumber the book in the reader's hands and
    // hide the fact that something is unwritten; keeping it shows the gap exactly where it is.
    const block = [heading]
    if (includeMeta) {
      const bits = []
      if (typeof chapter?.meta?.status === 'string' && chapter.meta.status !== '') bits.push(`状态：${chapter.meta.status}`)
      const characters = Array.isArray(chapter?.meta?.characters) ? chapter.meta.characters : []
      if (characters.length > 0) bits.push(`人物：${characters.join('、')}`)
      if (bits.length > 0) block.push(`*${bits.join(' · ')}*`)
    }
    if (includeSummary && typeof chapter?.meta?.summary === 'string' && chapter.meta.summary.trim() !== '') {
      block.push(`> ${chapter.meta.summary.trim()}`)
    }
    if (body !== '') block.push(body)
    parts.push(block.join('\n\n'))
    included.push({
      path: chapter?.path ?? null,
      title: typeof chapter?.meta?.title === 'string' ? chapter.meta.title : '',
      words: countWords(body),
      empty: body === '',
    })
  }

  const text = titlePage ? `${parts.join(separator)}\n` : `${parts.join(separator)}\n`
  return {
    text,
    included,
    skipped,
    // The book's length is the sum of what was included — not of what exists. A reader counting the
    // manuscript gets the number of the file they are holding.
    wordCount: included.reduce((total, chapter) => total + chapter.words, 0),
    chapterCount: included.length,
  }
}

/** A file name for the manuscript, sanitised the way the map export sanities its own. */
export function manuscriptName(projectTitle, extension = 'md') {
  const cleaned = String(projectTitle ?? '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const ext = /^[a-z0-9]+$/i.test(extension) ? extension.toLowerCase() : 'md'
  return `${cleaned === '' ? 'manuscript' : cleaned}.${ext}`
}
