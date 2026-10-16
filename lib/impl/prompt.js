/**
 * Prompt building and response handling for the model-backed generators.
 *
 * Generators are DECLARATIVE: each kind declares its scenario and its fields, and
 * one prompt builder plus one sanitiser serve every kind. An earlier version had a
 * hand-written prompt and a hand-written sanitiser per kind, which meant adding
 * 人物 or 事件 cost two new functions and two new chances to forget a field.
 *
 * The sanitiser is the point of the design. Model output is UNTRUSTED INPUT: it is
 * coerced into exactly the fields the entity declares, and nothing else reaches
 * the document. Left unchecked, a hallucinated key would be written to the
 * author's file and then read back by every other view and by the validator.
 */

/** Clamp a value to a trimmed string, or an empty string. */
function asText(value, limit = 2000) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  return text.trim().slice(0, limit)
}

/** A number, or null. `Number(null)` is 0, so blanks must be caught first. */
function asNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'object') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** A `{year,month,day}` time, or null when there is no usable year. */
function asTime(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const year = asNumber(value.year)
  if (year === null) return null
  return { year, month: asNumber(value.month), day: asNumber(value.day) }
}

/** A flat map of string → string, dropping anything else. */
function asStringMap(value, limit) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    const name = String(key).trim()
    if (name === '' || entry === null || entry === undefined) continue
    out[name.slice(0, 80)] = asText(entry, 400)
    if (Object.keys(out).length >= limit) break
  }
  return out
}

/** A list of non-empty strings. */
function asStringList(value, limit) {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => asText(entry, 200))
    .filter((entry) => entry !== '')
    .slice(0, limit)
}

/**
 * Pull the first JSON object out of a model response.
 *
 * Scans for the matching closing brace rather than trusting the whole response:
 * models routinely add a sentence, wrap the JSON in a ```json fence, or both. The
 * scan skips braces inside strings, so a value containing `}` does not truncate
 * the object.
 */
export function extractJsonObject(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start === -1) return { value: null, error: '响应里没有 JSON 对象' }

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      if (inString) escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const candidate = source.slice(start, index + 1)
        try {
          return { value: JSON.parse(candidate), error: null }
        } catch (error) {
          return { value: null, error: `JSON 解析失败：${error.message}` }
        }
      }
    }
  }
  return { value: null, error: 'JSON 对象没有闭合' }
}

/** How each field type is described to the model. */
const FIELD_HINT = {
  text: '（字符串）',
  stringlist: '（字符串数组）',
  stringmap: '（对象，值都是字符串）',
  time: '（对象 {"year":数字,"month":数字或null,"day":数字或null}）',
  enum: '（字符串，只能取给定值之一）',
}

/** Coerce an enum field to one of its declared values, or drop it. */
function asEnum(value, values) {
  const text = asText(value, 40)
  if (text === '') return ''
  // An exact match, else a containment match so 「男性（外表）」 still lands on 男 rather
  // than producing a value the select cannot display.
  if (values.includes(text)) return text
  const loose = values.find((candidate) => text.includes(candidate))
  return loose ?? ''
}

/**
 * Every generator this plugin offers.
 *
 * `collection` is where the kind's entities live, which is how the context builder
 * finds existing names to avoid duplicating. `nameField` is the field a blank
 * result falls back on. Reference fields (`characters`, `lineId`, …) are
 * deliberately absent: a model must not invent an entity id, so the author picks
 * those.
 */
export const GENERATORS = {
  item: {
    label: '物品',
    scenario: '设计一件与这部小说相称的物品',
    nameField: 'name',
    fallbackName: '未命名物品',
    collection: { doc: 'setting/items.json', key: 'items' },
    fields: [
      { key: 'name', type: 'text', label: '物品名称', max: 80 },
      { key: 'rarity', type: 'text', label: '品阶或等级（参考已有用词）', max: 40 },
      { key: 'description', type: 'text', label: '外形与用途，1-3 句', max: 800 },
      { key: 'history', type: 'text', label: '来历与相关事件，1-3 句', max: 800 },
      { key: 'attrs', type: 'stringmap', label: '属性键值对', max: 12 },
      { key: 'tags', type: 'stringlist', label: '标签', max: 8 },
    ],
  },
  character: {
    label: '人物',
    scenario: '设计一个与这部小说相称的人物',
    nameField: 'name',
    fallbackName: '未命名人物',
    collection: { doc: 'setting/characters.json', key: 'characters' },
    fields: [
      { key: 'name', type: 'text', label: '姓名（不要与已有角色重名）', max: 40 },
      { key: 'aliases', type: 'stringlist', label: '别名或道号', max: 4 },
      // Declared as an enum, not free text. As text, a model answering「男性（外表）」
      // produced a value the 性别 select has no option for: nothing selected on screen,
      // the value present on disk, and silently overwritten by the first interaction.
      { key: 'gender', type: 'enum', label: '性别', values: ['男', '女', '其他', '未定'] },
      { key: 'race', type: 'text', label: '种族（参考已有用词）', max: 40 },
      { key: 'ageNote', type: 'text', label: '年龄说明，如「外观二十出头」', max: 40 },
      { key: 'appearance', type: 'text', label: '外貌', max: 600 },
      { key: 'personality', type: 'text', label: '性格', max: 600 },
      { key: 'background', type: 'text', label: '背景', max: 800 },
      { key: 'tags', type: 'stringlist', label: '标签', max: 8 },
    ],
  },
  place: {
    label: '地点',
    scenario: '设计一个与这部小说相称的地点',
    nameField: 'name',
    fallbackName: '未命名地点',
    collection: { doc: 'setting/places.json', key: 'places' },
    fields: [
      { key: 'name', type: 'text', label: '地点名称（不要与已有地点重名）', max: 60 },
      { key: 'kind', type: 'text', label: '类型，如 城池/山门/秘境', max: 40 },
      { key: 'summary', type: 'text', label: '简介，2-4 句', max: 800 },
      { key: 'tags', type: 'stringlist', label: '标签', max: 8 },
    ],
  },
  organization: {
    label: '组织',
    scenario: '设计一个与这部小说相称的势力或组织',
    nameField: 'name',
    fallbackName: '未命名组织',
    collection: { doc: 'setting/organizations.json', key: 'organizations' },
    fields: [
      { key: 'name', type: 'text', label: '组织名称（不要与已有组织重名）', max: 60 },
      { key: 'aliases', type: 'stringlist', label: '别名', max: 4 },
      { key: 'kind', type: 'text', label: '类型，如 宗门/王朝/商会', max: 40 },
      { key: 'founded', type: 'time', label: '成立时间，可只给年份' },
      { key: 'summary', type: 'text', label: '简介与行事风格，2-4 句', max: 800 },
      { key: 'tags', type: 'stringlist', label: '标签', max: 8 },
    ],
  },
  'timeline-event': {
    label: '事件',
    scenario: '设计一个应当出现在这部小说时间轴上的事件',
    nameField: 'title',
    fallbackName: '未命名事件',
    collection: { doc: 'outline/timeline.json', key: 'events' },
    fields: [
      { key: 'title', type: 'text', label: '事件标题', max: 60 },
      { key: 'at', type: 'time', label: '发生时间，落在日历范围内' },
      { key: 'spanEnd', type: 'time', label: '结束时间；若是时点则给 null' },
      { key: 'atLabel', type: 'text', label: '模糊时间说明，如「三年前」，没有就留空', max: 40 },
      { key: 'impact', type: 'text', label: '影响与后果，2-4 句', max: 800 },
    ],
  },
}

/**
 * The style presets offered in the UI, with the instruction each sends.
 *
 * Declared here rather than in the client so the wording that reaches the model is
 * versioned with the prompt, and so a preset cannot drift into being a label with
 * no effect.
 */
export const STYLE_PRESETS = [
  { id: 'concise', label: '简练', instruction: '文字简练，不堆砌形容词，每段控制在两句以内。' },
  { id: 'rich', label: '详实', instruction: '细节充实，写出具体的物象与感官，允许稍长的段落。' },
  { id: 'classical', label: '古雅', instruction: '用词典雅，接近文言白话之间的语感，避免现代口语词。' },
  { id: 'plain', label: '平实', instruction: '语言平实直白，不追求修辞，像在讲述事实。' },
  { id: 'eerie', label: '诡谲', instruction: '气氛诡谲，留下不安与未知，不把话说满。' },
]

/** How many candidates a caller may ask for, and the ceiling that keeps it sane. */
const MAX_CANDIDATES = 5

/**
 * Turn a preset id into its instruction.
 *
 * The client sends the ID, never the wording, so the instruction cannot drift
 * from the label and there is no second copy of this table to keep in sync.
 */
export function resolveStyle(styleId) {
  const preset = STYLE_PRESETS.find((entry) => entry.id === styleId)
  return preset === undefined ? '' : preset.instruction
}

/** The catalogue the client renders: labels only, no instructions to duplicate. */
export function catalogue() {
  return {
    styles: STYLE_PRESETS.map((preset) => ({ id: preset.id, label: preset.label })),
    generators: Object.entries(GENERATORS).map(([kind, generator]) => ({ kind, label: generator.label })),
    maxCandidates: MAX_CANDIDATES,
  }
}

/**
 * Build the model-visible prompt for one generator.
 *
 * @param options.hint - an optional direction, e.g. 「剑」. Passing the author's
 *   current draft makes 「随机生成」 a nudge rather than a lottery.
 * @param options.context - the project's own setting, so a generated entity fits
 *   the novel instead of being generically fantasy-shaped.
 * @param options.style - free-form writing direction, appended as its own line.
 * @param options.count - how many distinct candidates to ask for.
 */
export function buildPrompt(generator, options = {}) {
  const hint = asText(options.hint, 200)
  const context = asText(options.context, 4000)
  const style = asText(options.style, 300)
  const requested = Number.isInteger(options.count) ? options.count : 1
  const count = Math.max(1, Math.min(MAX_CANDIDATES, requested))

  const shape =
    count === 1
      ? '只输出一个 JSON 对象，不要输出任何解释文字，不要使用 Markdown 代码块。'
      : `只输出一个 JSON 对象，形如 {"candidates":[ … ]}，其中恰好包含 ${count} 个互不相同的候选；不要输出任何解释文字，不要使用 Markdown 代码块。`

  const system = [
    '你是一部中文长篇小说的设定助手。',
    shape,
    '不确定的字段给出简短合理的内容，不要留空占位符。',
    '字段：',
    ...generator.fields.map((field) => {
      const hint =
        field.type === 'enum'
          ? `（字符串，只能取以下之一：${(field.values ?? []).join(' / ')}）`
          : FIELD_HINT[field.type] ?? ''
      return `  ${field.key}: ${field.label}${hint}`
    }),
  ].join('\n')

  const user = [
    hint === '' ? `${generator.scenario}。` : `${generator.scenario}，方向是：${hint}`,
    style === '' ? '' : `写作要求：${style}`,
    context === '' ? '' : `以下是这部小说已有的设定。请遵守它，不要与之冲突，也不要重复已有的名称：\n${context}`,
  ]
    .filter((line) => line !== '')
    .join('\n\n')

  return { system, user, count }
}

/**
 * Pull the candidates out of a parsed response.
 *
 * With `count > 1` the prompt asks for a `{"candidates":[…]}` wrapper, but a model
 * that ignores the wrapper and returns a bare object still yields one usable
 * candidate rather than an error — a worse result, not a failed request.
 */
export function extractCandidates(value) {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value.candidates)) return value.candidates
  return [value]
}

/**
 * Coerce a model's answer into exactly the fields the generator declares.
 *
 * Everything else is dropped, the existing draft's `id` and `custom` are kept, and
 * a blank required name falls back to the author's own draft before the generic
 * placeholder — so a generation can never re-key an entity or leave it unnamed.
 */
export function sanitizeByFields(raw, base, generator) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { ...base }

  for (const field of generator.fields) {
    const entry = value[field.key]
    if (field.type === 'stringlist') out[field.key] = asStringList(entry, field.max ?? 30)
    else if (field.type === 'stringmap') out[field.key] = asStringMap(entry, field.max ?? 40)
    else if (field.type === 'time') out[field.key] = asTime(entry)
    else if (field.type === 'enum') out[field.key] = asEnum(entry, field.values ?? [])
    else out[field.key] = asText(entry, field.max ?? 2000)
  }

  const nameKey = generator.nameField
  if (nameKey !== undefined) {
    const produced = out[nameKey]
    if (produced === undefined || produced === '') {
      out[nameKey] = asText(base?.[nameKey], 80) || generator.fallbackName
    }
  }
  return out
}

/**
 * The fields a model-visible prompt was built from, for the record.
 *
 * `dsh-llm` asks callers to keep model-visible input reconstructable; returning
 * the exact prompt with the result is what makes a generated value auditable.
 */
export function promptRecord(prompt) {
  return { system: prompt.system, user: prompt.user }
}
