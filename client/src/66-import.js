/**
 * 纯文本批量导入 —— Phase 6 的第二件。
 *
 * WHY PLAIN TEXT, AND WHY THIS IS THE WHOLE FEATURE. The author's real material lives in notes, chat logs and
 * bullet lists. What is wanted at that moment is not a mapping wizard but "these are the names, put them in" —
 * the details get filled in later, from the entity's own form. So the format is one name per line, and the
 * importer's job is to be predictable about everything else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not invent ids (it uses `mintId`, the same one the ＋ button uses),
 * does not merge into an existing entity, and does not overwrite a field. Two names that differ only by
 * whitespace or case are the same person to a novelist, so the second is SKIPPED and reported rather than
 * imported twice — which is why the plan is shown before anything is written.
 *
 * NO HOST WORK. Entities are created in the document and saved the way every other edit is, so an import
 * cannot bypass the validator or the `.prev` backup. The parser is pure, so the whole of the interesting
 * behaviour is asserted in `client-selftest.mjs`.
 */

/** How many lines one paste may import, so a runaway paste cannot write a 50,000-entry document. */
const IMPORT_MAX_NAMES = 500

/** Bullet and numbering markers, which is what a name pasted from a list arrives with. */
const IMPORT_MARKER = /^\s*(?:[-*•·–—]+|\d+\s*[.、)）:：])\s*/

/**
 * Extra ways to write a field's name, beyond the label the form shows.
 *
 * The labels come from the schema, so `种族：` and `性别：` work for any entity with no code here. These are
 * the words people actually type that the form does not use: the form says 年龄说明 because AGE IS NOT
 * STORED (see `docs/data-model.md` — a stored age is wrong the moment the story moves), and it says
 * 出生时间 where a note says 出生.
 */
const IMPORT_FIELD_ALIASES = {
  姓名: 'name',
  名字: 'name',
  名称: 'name',
  标题: 'title',
  年龄: 'ageNote',
  年纪: 'ageNote',
  出生: 'born',
  生日: 'born',
  简介: 'summary',
  介绍: 'summary',
  说明: 'summary',
  类型: 'kind',
  类别: 'kind',
  种类: 'kind',
  品阶: 'rarity',
  稀有度: 'rarity',
  状态: 'status',
  性别: 'gender',
  种族: 'race',
  外貌: 'appearance',
  性格: 'personality',
  别名: 'aliases',
  别称: 'aliases',
}

/** The fields an import may fill. A `ref`, a `refList` or a `structure` needs the author, not a parser. */
const IMPORT_FILLABLE = new Set(['text', 'longtext', 'number', 'time', 'select', 'stringlist'])

/** The separators a list value is written with. */
const IMPORT_LIST_SPLIT = /[、,，;；/|]+/

/** Punctuation that sits between a name and the rest of a sentence. */
const IMPORT_LEAD = /^[\s是叫名为「『“"']+|[\s，,。；;：:、]+$/g

/** The fields that carry a whole sentence, where a line the parser only half understood is preserved. */
const IMPORT_SUMMARY_KEYS = ['summary', 'description', 'background', 'intro', 'body', 'note']

/** Whether a schema value looks like a field descriptor. */
const isFieldDescriptor = (value) => value !== null && typeof value === 'object' && typeof value.key === 'string'

/** The fields of an entity an import may fill, with every label that addresses them. */
function importFields(entityKey) {
  const entity = ENTITIES[entityKey]
  const fields = objectList(entity?.fields).filter(isFieldDescriptor).filter((field) => IMPORT_FILLABLE.has(field.type))
  const byLabel = new Map()
  for (const field of fields) {
    if (typeof field.label === 'string' && field.label !== '') byLabel.set(field.label, field)
  }
  for (const [alias, key] of Object.entries(IMPORT_FIELD_ALIASES)) {
    const field = fields.find((entry) => entry.key === key)
    if (field !== undefined && !byLabel.has(alias)) byLabel.set(alias, field)
  }
  return { fields, byLabel }
}

/**
 * The declared option a piece of text is talking about, if any.
 *
 * GENERIC, and that is the whole point: `性别` declares 男/女/其他/未定, so 「男性」 finds 男 with no per-entity
 * table anywhere. Longest first, so 「半精灵」 is not read as 「精灵」. The same inclusion rule the generators
 * apply to model output.
 */
function matchOption(field, text) {
  if (!Array.isArray(field?.options)) return null
  const haystack = String(text ?? '')
  let best = null
  for (const option of field.options) {
    if (option === null || typeof option !== 'object') continue
    for (const candidate of [option.label, option.value]) {
      if (typeof candidate !== 'string' || candidate === '') continue
      if (!haystack.includes(candidate)) continue
      if (best === null || candidate.length > best.length) best = candidate
    }
  }
  if (best === null) return null
  const hit = field.options.find((option) => option?.label === best || option?.value === best)
  return hit?.value ?? best
}

/**
 * A value the document already uses, found inside the line.
 *
 * THE AUTHOR'S OWN WORDS ARE THE VOCABULARY. `race` is free text, so nothing declares that 人类 is a race —
 * but the project already contains it. `context.js` reads the same way when it builds a prompt, for the same
 * reason: a new entry should read like the same book. Longest first, so 「半精灵」 wins over 「精灵」.
 */
function matchVocabulary(text, vocabulary) {
  const haystack = String(text ?? '')
  const list = (Array.isArray(vocabulary) ? vocabulary : [])
    .map((value) => String(value ?? '').trim())
    .filter((value) => value !== '')
    .sort((left, right) => right.length - left.length)
  for (const value of list) {
    if (haystack.includes(value)) return value
  }
  return null
}

/** A year written in the line, as `{ year }` — the only form in which an age can be stored. */
function matchYear(text) {
  const match = /(\d{1,6})\s*年/.exec(String(text ?? ''))
  if (match === null) return null
  const year = Number(match[1])
  return Number.isFinite(year) ? { year } : null
}

/** One `字段：值` pair's value, in the type that field declares. `undefined` means "not understood". */
function coerceImportValue(field, raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return undefined
  if (field.type === 'select') return matchOption(field, value) ?? undefined
  if (field.type === 'stringlist') {
    const parts = value.split(IMPORT_LIST_SPLIT).map((part) => part.trim()).filter((part) => part !== '')
    return parts.length === 0 ? undefined : parts
  }
  if (field.type === 'time') return matchYear(value) ?? undefined
  if (field.type === 'number') {
    const match = /-?\d+(?:\.\d+)?/.exec(value)
    return match === null ? undefined : Number(match[0])
  }
  // `年龄：23` reads better as 「23岁」 in a field whose whole purpose is to describe an age in words.
  if (field.key === 'ageNote' && /^\d+$/.test(value)) return `${value}岁`
  return value
}

/**
 * Everything one pasted line says about one entity.
 *
 * @param {string} line
 * @param {string} entityKey
 * @param {object} [vocabulary] - `{ race: [...], kind: [...], rarity: [...] }`: values already in the
 *   project, so the parser recognises the author's own words for things.
 * @returns `{ name, fields, matched }` — `fields` is what would be filled in, and `matched` is what the
 *   preview shows, so the author can read the parser's mind before agreeing to it.
 */
function parseEntityLine(line, entityKey, vocabulary) {
  // STRINGS ONLY, like `parseNameList`: a line is text, and `String(42)` turning a stray number into a
  // character named 「42」 is the kind of help nobody asked for.
  const text = typeof line === 'string' ? line.trim() : ''
  const { fields, byLabel } = importFields(entityKey)
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const out = {}
  const matched = []
  let rest = text

  // 1. EXPLICIT `字段：值` PAIRS, addressed by the schema's own labels — the most reliable signal there is, and
  //    the one an author can use deliberately: 「姓名：小明 年龄：23 种族：人类」.
  const labelPattern = [...byLabel.keys()]
    .sort((left, right) => right.length - left.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (labelPattern.length > 0 && /[:：=]/.test(text)) {
    // THE VALUE ENDS WHERE THE NEXT LABEL BEGINS, not at the next comma. 「姓名：小明 年龄：23 种族：人类」 has
    // no commas at all — one greedy value swallowed the whole line and the entry came out named
    // 「小明 年龄：23 种族：人类 状态：在世」. A name may contain a space; only the NEXT LABEL ends a value.
    const labels = labelPattern.join('|')
    const stop = `(?=\\s*(?:${labels})\\s*[:：=]|[,，;；。\\n]|$)`
    const pair = new RegExp(`(${labels})\\s*[:：=]\\s*(.*?)${stop}`, 'g')
    for (const found of text.matchAll(pair)) {
      const field = byLabel.get(found[1])
      if (field === undefined || out[field.key] !== undefined) continue
      const value = coerceImportValue(field, found[2])
      if (value === undefined) continue
      out[field.key] = value
      matched.push({ key: field.key, label: field.label, value })
      rest = rest.replace(found[0], ' ')
    }
  }

  // 2. THE NAME: `姓名：` answered it above; otherwise it is the subject of the sentence (before 是/叫/，),
  //    and only then the whole line.
  if (typeof out.name !== 'string' || out.name === '') {
    const head = /^([^，,。；;：:（(]{1,40}?)(?:是|叫|名为|，|,|。|；|;|：|:|（|\(|$)/.exec(rest)
    const candidate = (head === null ? rest : head[1]).replace(IMPORT_LEAD, '').trim()
    if (candidate !== '') {
      out.name = candidate
      rest = rest.slice(head === null ? 0 : head[0].length)
    }
  }

  // 3. WHAT IS LEFT, read against the values the project already uses and against each `select`'s options.
  for (const field of fields) {
    if (out[field.key] !== undefined) continue
    if (field.key === 'name' || field.key === 'title') continue
    if (field.type === 'select') {
      const option = matchOption(field, rest)
      if (option !== null) {
        out[field.key] = option
        matched.push({ key: field.key, label: field.label, value: option })
      }
      continue
    }
    if (field.type === 'time') {
      const time = matchYear(rest)
      if (time !== null) {
        out[field.key] = time
        matched.push({ key: field.key, label: field.label, value: `${time.year}年` })
      }
      continue
    }
    if (field.type !== 'text') continue
    const known = matchVocabulary(rest, vocabulary?.[field.key])
    if (known !== null) {
      out[field.key] = known
      matched.push({ key: field.key, label: field.label, value: known })
    }
  }

  // 4. AN AGE IN WORDS, which has nowhere structured to go — see the note on `ageNote` above.
  if (out.ageNote === undefined && byKey.has('ageNote')) {
    const age = /(\d{1,3})\s*岁/.exec(rest)
    if (age !== null) {
      out.ageNote = `${age[1]}岁`
      matched.push({ key: 'ageNote', label: byKey.get('ageNote').label, value: `${age[1]}岁` })
    }
  }

  // 5. WHAT IS LEFT IS KEPT as the entity's own sentence, in whichever field carries prose. A parser that
  //    understood four words of six and discarded the rest would throw away the author's own description of
  //    their own character; keeping it means the worst case is a sentence they can edit, in the field they
  //    would have written it in anyway.
  const leftover = rest.replace(IMPORT_LEAD, '').trim()
  if (leftover.length >= 6) {
    const summaryKey = IMPORT_SUMMARY_KEYS.find((key) => byKey.has(key))
    if (summaryKey !== undefined && out[summaryKey] === undefined) out[summaryKey] = leftover
  }
  return { name: typeof out.name === 'string' ? out.name : '', fields: out, matched }
}

/**
 * Split a paste into entity entries: a name per line, plus whatever else the line says.
 *
 * @returns `{ entries, ignored }` — `entries` in first-seen order, de-duplicated by name; `ignored` names
 *   every line left out and why, so "I pasted 40 lines and got 38" always has an answer.
 */
function parseEntityLines(text, entityKey, vocabulary) {
  const raw = typeof text === 'string' ? text : ''
  const entries = []
  const ignored = []
  const seen = new Set()
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const lineNumber = index + 1
    const trimmed = line.replace(IMPORT_MARKER, '').trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) {
      ignored.push({ line: lineNumber, text: trimmed, reason: 'comment' })
      continue
    }
    const parsed = parseEntityLine(trimmed, entityKey, vocabulary)
    const name = parsed.name.trim()
    if (name === '') {
      ignored.push({ line: lineNumber, text: trimmed, reason: 'no-name' })
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      ignored.push({ line: lineNumber, text: trimmed, reason: 'duplicate' })
      continue
    }
    if (entries.length >= IMPORT_MAX_NAMES) {
      ignored.push({ line: lineNumber, text: trimmed, reason: 'too-many' })
      continue
    }
    seen.add(key)
    entries.push({ line: lineNumber, source: trimmed, name, fields: parsed.fields, matched: parsed.matched })
  }
  return { entries, ignored }
}

/**
 * Split a pasted list into names. Kept for a name-only paste; `parseEntityLines` is the general one.
 *
 * @returns `{ names, ignored }` — `names` in first-seen order, de-duplicated; `ignored` names every line left
 *   out and why, so "I pasted 40 lines and got 38" always has an answer.
 */
function parseNameList(text) {
  // STRINGS ONLY. A paste is text; anything else is a caller bug, and `String(42)` quietly turning a stray
  // number into a character named 「42」 is the kind of help nobody asked for.
  const raw = typeof text === 'string' ? text : ''
  const names = []
  const ignored = []
  const seen = new Set()
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const lineNumber = index + 1
    const withoutMarker = line.replace(IMPORT_MARKER, '')
    const name = withoutMarker.trim()
    if (name === '') continue
    // `#` starts a comment, so a note pasted along with the names does not become a character.
    if (name.startsWith('#')) {
      ignored.push({ line: lineNumber, text: name, reason: 'comment' })
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      ignored.push({ line: lineNumber, text: name, reason: 'duplicate' })
      continue
    }
    if (names.length >= IMPORT_MAX_NAMES) {
      ignored.push({ line: lineNumber, text: name, reason: 'too-many' })
      continue
    }
    seen.add(key)
    names.push(name)
  }
  return { names, ignored }
}

/**
 * What an import would do, before it does anything.
 *
 * Accepts entries (`{ name, fields }`) or bare names, so a name-only paste behaves exactly as it did.
 *
 * @returns `{ create, duplicates, taken }` — `create` is what the author is agreeing to, and it carries the
 *   parsed fields so the preview can show the parser's reading rather than only the names.
 */
function planImport(input) {
  const raw = Array.isArray(input?.entries) ? input.entries : Array.isArray(input?.names) ? input.names : []
  const existing = new Set(
    (Array.isArray(input?.existing) ? input.existing : [])
      .map((name) => String(name ?? '').trim().toLowerCase())
      .filter((name) => name !== ''),
  )
  const create = []
  const duplicates = []
  for (const item of raw) {
    const isRecord = item !== null && typeof item === 'object'
    const name = String(isRecord ? item.name ?? '' : item ?? '').trim()
    if (name === '') continue
    // Case- and whitespace-insensitive: 「李明」 and 「李明 」 are one person, and an importer that treats them as
    // two leaves the author with a duplicate they only notice much later.
    if (existing.has(name.toLowerCase())) {
      duplicates.push(name)
      continue
    }
    create.push({
      name,
      fields: isRecord && item.fields !== null && typeof item.fields === 'object' ? item.fields : {},
      source: isRecord && typeof item.source === 'string' ? item.source : name,
      matched: isRecord && Array.isArray(item.matched) ? item.matched : [],
    })
  }
  return { create, duplicates, taken: existing }
}

/**
 * The values the project already uses for a target's text fields.
 *
 * THE AUTHOR'S OWN WORDS, read the way `context.js` reads them when it writes a prompt. `race` is free text,
 * so nothing declares that 人类 is one — but the project's own characters do, and that is a better source than
 * any list this file could carry. It also means the parser gets better as the book grows.
 */
function importVocabulary(doc, target) {
  const { fields } = importFields(target?.entity)
  const out = {}
  for (const field of fields) {
    if (field.type !== 'text') continue
    const values = objectList(doc?.[target?.key])
      .map((entry) => entry?.[field.key])
      .filter((value) => typeof value === 'string' && value.trim() !== '')
    if (values.length > 0) out[field.key] = [...new Set(values)]
  }
  return out
}

/**
 * The lists a branch can import into, from its own descriptor.
 *
 * Driven by the declarations rather than a hard-coded list of branches: any branch that declares a collection
 * or a tree of entities gets the control, including ones added later. `blank` decides the entity's default
 * shape, so a spec without a `blank` factory cannot create anything and is not offered.
 */
function importTargets(branch) {
  const slots = [
    ...(Array.isArray(branch?.tree?.groups) ? branch.tree.groups : []),
    ...(Array.isArray(branch?.tree?.leaves) ? branch.tree.leaves : []),
    ...(Array.isArray(branch?.collections) ? branch.collections : []),
  ]
  const out = []
  const seen = new Set()
  for (const slot of slots) {
    const entityKey = slot?.entity
    if (typeof entityKey !== 'string' || entityKey === '') continue
    if (seen.has(slot.key)) continue
    const entity = ENTITIES[entityKey]
    if (entity === undefined || typeof entity.blank !== 'function') continue
    seen.add(slot.key)
    out.push({ key: slot.key, entity: entityKey, label: entity.label ?? slot.label ?? entityKey, spec: slot })
  }
  return out
}

/**
 * Every id already in use anywhere in a branch, so a minted one cannot collide across its lists.
 *
 * The same rule `EntityTree` applies: ids must be unique across a branch, not merely within one collection.
 */
function branchTakenIds(branch, doc) {
  const set = new Set()
  const slots = [
    ...(Array.isArray(branch?.tree?.groups) ? branch.tree.groups : []),
    ...(Array.isArray(branch?.tree?.leaves) ? branch.tree.leaves : []),
    ...(Array.isArray(branch?.collections) ? branch.collections : []),
  ]
  for (const slot of slots) {
    for (const entry of objectList(doc?.[slot?.key])) {
      if (typeof entry?.id === 'string' && entry.id !== '') set.add(entry.id)
    }
  }
  return set
}

/** The names already in one list, for duplicate detection. */
function existingNamesIn(doc, key, entityKey) {
  const entity = ENTITIES[entityKey]
  const titleOf = typeof entity?.titleOf === 'function' ? entity.titleOf : (entry) => entry?.name ?? entry?.title ?? ''
  return objectList(doc?.[key]).map((entry) => String(titleOf(entry) ?? ''))
}

/** The entities one paste would create, built by the SAME factory the ＋ button uses. */
function buildImportedEntities(spec, entityKey, entries, taken) {
  const entity = ENTITIES[entityKey]
  if (entity === undefined || typeof entity.blank !== 'function') return []
  // NOT `objectList`: it keeps RECORDS only, and a list of names is a list of STRINGS — it would have
  // silently dropped every one of them, and the import would report success having created nothing. This is
  // the second time that helper has eaten a string array in this project (the first was the stamp glyph
  // points), so the rule is worth stating: `objectList` is for lists of objects, never for scalars.
  const list = Array.isArray(entries) ? entries : []
  const created = []
  for (const entry of list) {
    const isRecord = entry !== null && typeof entry === 'object'
    const name = String(isRecord ? entry.name ?? '' : entry ?? '').trim()
    if (name === '') continue
    const node = childNodeFor(spec, entity, null, taken)
    // THE PARSED FIELDS, applied over the blank — and ONLY keys the entity declares. Writing a field the
    // schema does not know would put a key in the author's document that no form can edit and no validator
    // expects; the same rule the model-output sanitiser follows.
    const fields = isRecord && entry.fields !== null && typeof entry.fields === 'object' ? entry.fields : {}
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'id' || key === 'name' || key === 'title') continue
      if (!(key in node)) continue
      node[key] = value
    }
    // The name is what was typed. `blank()` supplies the default (「新人物」 and so on), which is right for a
    // hand-created entry and wrong here: the author already gave the name.
    const nameKey = 'name' in node ? 'name' : 'title' in node ? 'title' : null
    if (nameKey !== null) node[nameKey] = name
    // An id minted from the default name would read `char-新人物`, and the id is what a chapter's 人物引用
    // stores — so it is re-minted from the real name.
    node.id = mintId(spec?.idPrefix ?? entity.idPrefix, name, taken)
    // `mintId` only CHECKS `taken`; it never records the id it hands out. Recording it here is what keeps two
    // entries in one paste from being minted the same id. The app never hit this because it re-derives
    // `taken` from the document between two presses, and an import creates everything in a single pass.
    taken.add(node.id)
    created.push(node)
  }
  return created
}

/**
 * The import control: pick a list, paste, see what would happen, then do it.
 *
 * The preview is not a nicety — it is the project's rule everywhere else that generated content is shown
 * before it lands. Here it is cheap and it is the only chance to notice that the paste contained eight lines
 * of notes and four names.
 */
function BulkImport(props) {
  const { branch, doc, onMutate } = props
  const targets = react.useMemo(() => importTargets(branch), [branch])
  const [targetKey, setTargetKey] = react.useState(null)
  const [text, setText] = react.useState('')
  const [open, setOpen] = react.useState(false)
  const [receipt, setReceipt] = react.useState(null)

  if (targets.length === 0) return null
  const target = targets.find((entry) => entry.key === targetKey) ?? targets[0]
  // THE VOCABULARY IS THE PROJECT'S OWN WORDS, read per target — so 人类 is recognised because this book's
  // characters are already human, not because a list in this file says so.
  const vocabulary = importVocabulary(doc, target)
  const parsed = parseEntityLines(text, target.entity, vocabulary)
  const plan = planImport({ entries: parsed.entries, existing: existingNamesIn(doc, target.key, target.entity) })

  const [error, setError] = react.useState(null)

  const run = () => {
    if (plan.create.length === 0) return
    const taken = branchTakenIds(branch, doc)
    const created = buildImportedEntities(target.spec, target.entity, plan.create, taken)
    // NOT A SILENT RETURN. `buildImportedEntities` refuses when the entity is unknown or its `blank` factory is
    // missing, and a click that produces nothing with no explanation is the family of bug this file has already
    // cost once (「按钮没有任何效果」). The button cannot be pressed in this state, so reaching it is a real fault.
    if (created.length === 0) {
      setError(`没能为「${target.label}」建成条目——这类实体的定义可能不完整（缺少 blank()）。`)
      return
    }
    setError(null)
    onMutate((current) => ({ ...current, [target.key]: [...objectList(current[target.key]), ...created] }))
    setReceipt({
      created: created.length,
      duplicates: plan.duplicates.length,
      ignored: parsed.ignored.length,
      label: target.label,
    })
    setText('')
  }

  return h(
    'div',
    { style: { marginBottom: '10px', padding: '8px', border: `1px solid ${muted}`, borderRadius: '6px' } },
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
        onClick: () => setOpen((value) => !value),
      },
      h('span', null, `${open ? '▾' : '▸'} 批量导入名字`),
      h('span', { style: { color: muted, fontSize: '11px' } }, '一行一个'),
    ),
    open
      ? h(
          'div',
          { style: { marginTop: '6px' } },
          targets.length === 1
            ? null
            : h(
                'div',
                { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
                h('span', { style: { fontSize: '12px', opacity: 0.6 } }, '导入到'),
                h(
                  'select',
                  {
                    value: target.key,
                    onChange: (event) => setTargetKey(event.target.value),
                    style: { ...inputStyle, flex: '1 1 auto' },
                  },
                  ...targets.map((entry) => h('option', { key: entry.key, value: entry.key }, entry.label)),
                ),
              ),
          h('textarea', {
            value: text,
            rows: 6,
            placeholder:
              '每行一个。可以只写名字，也可以带上已知的信息：\n小明是一个人类男性，今年23岁。\n姓名：小明 种族：人类 状态：在世\n以 # 开头的行是注释；行首的 -、*、1. 这类列表符号会被去掉。',
            onChange: (event) => {
              setText(event.target.value)
              setReceipt(null)
            },
            style: { ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 },
          }),
          // WHAT WOULD HAPPEN, before it happens — including WHAT THE PARSER READ, because a heuristic that
          // only reports "12 entries" gives the author no chance to see that it read 人类 as a name.
          h(
            'div',
            { style: { fontSize: '12px', margin: '6px 0', lineHeight: 1.8, opacity: 0.8 } },
            parsed.entries.length === 0
              ? '还没有可导入的内容。'
              : `将新建 ${plan.create.length} 个${target.label}` +
                (plan.duplicates.length === 0 ? '' : `；跳过 ${plan.duplicates.length} 个已存在（${plan.duplicates.slice(0, 4).join('、')}${plan.duplicates.length > 4 ? '…' : ''}）`) +
                (parsed.ignored.length === 0 ? '' : `；忽略 ${parsed.ignored.length} 行`),
          ),
          plan.create.length === 0
            ? null
            : h(
                'div',
                { style: { fontSize: '11px', marginBottom: '6px', lineHeight: 1.9, opacity: 0.7 } },
                ...plan.create.slice(0, 6).map((entry, index) =>
                  h(
                    'div',
                    { key: `${entry.name}-${index}` },
                    `· ${entry.name}` +
                      (entry.matched.length === 0
                        ? '（只有名字）'
                        : ' → ' + entry.matched.map((hit) => `${hit.label} ${String(hit.value)}`).join(' · ')),
                  ),
                ),
                plan.create.length > 6 ? h('div', null, `…还有 ${plan.create.length - 6} 个`) : null,
              ),
          h(
            'div',
            { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h(
              'button',
              {
                type: 'button',
                style: { ...buttonStyle, opacity: plan.create.length === 0 ? 0.5 : 1 },
                disabled: plan.create.length === 0,
                onClick: run,
              },
              `导入 ${plan.create.length} 个`,
            ),
            h('span', { style: { fontSize: '11px', opacity: 0.5 } }, '导入后记得保存。'),
          ),
          error === null ? null : h(Note, { tone: 'error', text: error }),
          receipt === null
            ? null
            : h(
                'div',
                { style: { fontSize: '12px', marginTop: '6px', opacity: 0.75, lineHeight: 1.8 } },
                `已新建 ${receipt.created} 个${receipt.label}。` +
                  (receipt.duplicates === 0 ? '' : `跳过 ${receipt.duplicates} 个重名，`) +
                  (receipt.ignored === 0 ? '' : `忽略 ${receipt.ignored} 行，`) +
                  '按「保存」写进项目。',
              ),
        )
      : null,
  )
}
