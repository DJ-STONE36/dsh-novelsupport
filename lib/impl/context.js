/**
 * The project's own setting, digested for a prompt.
 *
 * Without this, a generated entity is generic fantasy: the model knows nothing
 * about *this* novel, so it invents a currency, a cultivation ladder, or a
 * character name that collides with one already in the book. Passing the existing
 * world and vocabulary is what makes 「随机生成」 produce something that reads as
 * part of the same work.
 *
 * Pure — takes parsed documents, returns a string — so the digest is testable and
 * the router stays a thin caller.
 */

/** Fields whose existing values are vocabulary the model should reuse. */
const VOCAB_FIELDS = ['rarity', 'race', 'kind', 'gender', 'status']

/** Trim to a length, marking the cut so the model does not read a truncated word. */
function clip(value, limit) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * @param docs - project-relative path → parsed document, as `loadDocuments` returns.
 * @param generator - a `GENERATORS` entry; its `collection` locates existing names.
 * @param options.limit - total characters, kept well under a context window.
 */
export function buildWorldContext(docs, generator, options = {}) {
  const limit = options.limit ?? 3000
  const parts = []

  const world = docs['setting/world.json'] ?? {}
  const sections = Array.isArray(world.sections) ? world.sections : []
  const rules = Array.isArray(world.rules) ? world.rules : []

  if (sections.length > 0) {
    // Capped like the rules and the name list, so a project with hundreds of
    // sections cannot push the digest past its budget. The character limit below
    // is a backstop, not the mechanism.
    const titles = sections
      .slice(0, 30)
      .map((section) => clip(section?.title, 40))
      .filter((title) => title !== '')
    if (titles.length > 0) parts.push(`世界分节：${titles.join('、')}`)
  }
  if (rules.length > 0) {
    const lines = rules
      .slice(0, 15)
      .map((rule) => {
        const scope = rule?.scope === 'branch' ? rule?.branch ?? '分支' : '总'
        const body = clip(rule?.body, 120)
        return `- [${scope}] ${clip(rule?.title, 60) || rule?.id || '规则'}${body === '' ? '' : `：${body}`}`
      })
      .filter((line) => line !== '')
    if (lines.length > 0) parts.push(`世界规则：\n${lines.join('\n')}`)
  }

  const collection = generator?.collection
  if (collection !== undefined) {
    const doc = docs[collection.doc] ?? {}
    const list = Array.isArray(doc[collection.key]) ? doc[collection.key] : []
    if (list.length > 0) {
      // Names first: a duplicate name is the most visible way a generation
      // conflicts with what the author already wrote.
      const names = list
        .map((entity) => clip(entity?.name ?? entity?.title, 40))
        .filter((name) => name !== '')
      if (names.length > 0) {
        parts.push(`已有的${generator.label ?? '条目'}（不要重名）：${names.slice(0, 40).join('、')}`)
      }

      const vocabulary = new Set()
      for (const entity of list) {
        for (const key of VOCAB_FIELDS) {
          const value = clip(entity?.[key], 24)
          if (value !== '') vocabulary.add(`${key}=${value}`)
        }
      }
      if (vocabulary.size > 0) {
        parts.push(`已有的用词参考（请沿用同类表述）：${[...vocabulary].slice(0, 20).join('、')}`)
      }
    }
  }

  // The calendar, so a generated event lands inside the story's own range rather
  // than in an arbitrary year.
  const calendar = (docs['outline/timeline.json'] ?? {}).calendar
  if (calendar !== undefined && calendar !== null) {
    const start = calendar.start?.year ?? '?'
    const end = calendar.end?.year ?? '?'
    parts.push(`历法：${clip(calendar.epochLabel, 20)} ${start} 年至 ${end} 年`)
  }

  const text = parts.join('\n')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
