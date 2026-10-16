/**
 * The story-so-far digest for drafting a chapter.
 *
 * A chapter is not a lone entity: it continues a voice, pays off an outline beat,
 * and must not contradict the rules its characters live under. Handing a model only
 * "write chapter 3" produces competent prose that belongs to no book. This gathers
 * what the chapter actually depends on:
 *
 *   - the beat it is meant to deliver (its 大纲条目)
 *   - who is in it, and what they are like
 *   - where it happens
 *   - the rules in force (global, plus any branch rule for those places)
 *   - how the previous chapter ended, so the voice and the situation continue
 *
 * Pure — takes parsed documents — so the digest can be asserted rather than
 * eyeballed, and the router stays a thin caller that also reads the prose files.
 */

/** Trim, marking the cut so a truncated word is not read as the author's own. */
function clip(value, limit) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Every rule in force: all global ones, plus branch rules matching `inScope`. */
function rulesInForce(docs, inScope) {
  const world = docs['setting/world.json'] ?? {}
  const rules = Array.isArray(world.rules) ? world.rules : []
  const scope = new Set(inScope.filter((name) => name !== ''))
  return rules.filter((rule) => {
    if (rule?.scope !== 'branch') return true
    return scope.has(clip(rule?.branch, 40))
  })
}

/**
 * @param docs - project-relative path → parsed document.
 * @param chapter - the chapter's front matter.
 * @param options.previousTail - the end of the previous chapter's prose.
 * @param options.currentTail - the end of this chapter's prose, when continuing.
 * @param options.limit - total characters; the digest must not crowd out the task.
 */
export function buildChapterContext(docs, chapter, options = {}) {
  const limit = options.limit ?? 6000
  const parts = []

  const title = clip(chapter?.title, 80)
  const summary = clip(chapter?.summary, 300)
  if (title !== '' || summary !== '') {
    parts.push(`本章：${title}${summary === '' ? '' : `\n梗概：${summary}`}`)
  }

  const characters = Array.isArray(docs['setting/characters.json']?.characters)
    ? docs['setting/characters.json'].characters
    : []
  const places = Array.isArray(docs['setting/places.json']?.places) ? docs['setting/places.json'].places : []
  const characterIds = Array.isArray(chapter?.characters) ? chapter.characters : []
  const placeIds = Array.isArray(chapter?.places) ? chapter.places : []

  const cast = characterIds
    .map((id) => characters.find((entry) => entry.id === id))
    .filter((entry) => entry !== undefined)
  if (cast.length > 0) {
    const lines = cast.map((entry) => {
      const bits = [
        clip(entry.race, 20),
        clip(entry.gender, 10),
        clip(entry.ageNote, 30),
        clip(entry.status, 20),
      ].filter((bit) => bit !== '')
      const traits = clip(entry.personality, 60)
      const background = clip(entry.background, 120)
      return `- ${clip(entry.name, 40) || entry.id}${bits.length === 0 ? '' : `（${bits.join('、')}）`}${
        traits === '' ? '' : `\n  性格：${traits}`
      }${background === '' ? '' : `\n  背景：${background}`}`
    })
    parts.push(`本章出场人物：\n${lines.join('\n')}`)
  }

  const settings = placeIds.map((id) => places.find((entry) => entry.id === id)).filter((entry) => entry !== undefined)
  if (settings.length > 0) {
    const lines = settings.map(
      (entry) => `- ${clip(entry.name, 40) || entry.id}${clip(entry.kind, 20) === '' ? '' : `（${clip(entry.kind, 20)}）`}${clip(entry.summary, 120) === '' ? '' : `：${clip(entry.summary, 120)}`}`,
    )
    parts.push(`发生地点：\n${lines.join('\n')}`)
  }

  // The rules that actually bind this chapter: everything global, plus branch rules
  // for the places present. A rule about a region nobody is in is noise.
  const rules = rulesInForce(docs, [...settings.map((entry) => entry.name ?? ''), ...settings.map((entry) => entry.kind ?? '')])
  if (rules.length > 0) {
    const lines = rules.slice(0, 20).map((rule) => {
      const scope = rule?.scope === 'branch' ? `限 ${clip(rule?.branch, 20)}` : '全书'
      return `- [${scope}] ${clip(rule?.title, 60)}：${clip(rule?.body, 160)}`
    })
    parts.push(`必须遵守的规则：\n${lines.join('\n')}`)
  }

  const outline = docs['outline/outline.json'] ?? {}
  const nodes = Array.isArray(outline.nodes) ? outline.nodes : []
  const beat = nodes.find((node) => node.id === chapter?.outlineRef) ?? null
  if (beat !== null) {
    const beatBits = [clip(beat.title, 60), clip(beat.summary, 200)].filter((bit) => bit !== '')
    if (beatBits.length > 0) parts.push(`对应大纲条目：${beatBits.join(' —— ')}`)
  }

  const previousTail = clip(options.previousTail, 800)
  if (previousTail !== '') parts.push(`上一章结尾（请接着写，保持语气与情境连贯）：\n${previousTail}`)

  const currentTail = clip(options.currentTail, 800)
  if (currentTail !== '') parts.push(`本章已写到的结尾（从这之后续写）：\n${currentTail}`)

  const text = parts.join('\n\n')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** The instruction the model is given, per drafting mode. */
export const DRAFT_MODES = [
  { id: 'continue', label: '接着写', instruction: '接着下面已有的正文继续写，不要重复已写过的内容。' },
  { id: 'expand', label: '扩写', instruction: '把已有的正文扩写得更充分：补足场景、动作与对话，保留原有情节与人物。' },
  { id: 'rewrite', label: '重写', instruction: '重写这一章，保留情节要点，改进节奏与文笔。' },
]

/**
 * Build the drafting prompt.
 *
 * The mode is a preset instruction; `style` is the author's own direction. Both are
 * separate from the story digest so the model can tell a constraint from a task.
 */
export function buildDraftPrompt(options = {}) {
  const mode = DRAFT_MODES.find((entry) => entry.id === options.mode) ?? DRAFT_MODES[0]
  const instruction = clip(options.instruction, 500)
  const style = clip(options.style, 300)
  const context = clip(options.context, 7000)
  const existing = typeof options.existing === 'string' ? options.existing : ''

  const system = [
    '你是一部中文长篇小说的写手，负责写正文。',
    '直接输出正文，不要输出标题、说明、大纲或任何解释，不要使用 Markdown 代码块。',
    '使用第三人称叙述，只写情节与场景，不要替作者总结主题。',
    '严格遵守给定的设定与规则，不要引入未交代过的设定。',
  ].join('\n')

  const user = [
    `任务：${mode.instruction}`,
    instruction === '' ? '' : `本次要求：${instruction}`,
    style === '' ? '' : `文风要求：${style}`,
    context === '' ? '' : `设定与背景：\n${context}`,
    // Only 重写 gets the whole chapter inline; 接着写 already has the tail in the
    // digest, and sending the full text twice wastes the window.
    mode.id === 'rewrite' && existing !== '' ? `已有正文（重写它）：\n${existing}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n\n')

  return { system, user, mode: mode.id }
}
