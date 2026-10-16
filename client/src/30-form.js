/**
 * SchemaForm — a detail editor driven entirely by an entity descriptor.
 *
 * Two halves, and the second is the one that matters product-wise:
 *
 *   1. The declared fields, each rendered by its `type`.
 *   2. A free-form 自定义信息 section over `entity.custom`.
 *
 * (2) is what makes "用户在人物卡上新建一个信息：性格" work without a code change
 * and without a migration — `custom` is a flat bag of scalars on every entity
 * precisely so a new field costs nothing (docs/data-model.md §7). The promotion
 * rule is stated in the UI: anything needing a type, validation, filtering, or a
 * relationship should become a declared field instead.
 *
 * Fields render as controlled inputs and report upward through `onPatch`; the
 * form holds no state of its own beyond an uncommitted key/value draft row.
 */

const CUSTOM_VALUE_LIMIT = 400

function FieldLabel(props) {
  // BOTH FORMS, deliberately. `children` is the usual one and `text` is used by every field label in the map
  // panel — and because the component read only `children`, all fifteen of those rendered an EMPTY label.
  // A blank caption looks like a spacing choice, so nothing ever reported it.
  return h(
    'label',
    { style: { fontSize: '11px', opacity: 0.55, display: 'block', marginBottom: '3px' } },
    props.text ?? props.children,
  )
}

function FieldRow(props) {
  return h('div', { style: { marginBottom: '10px' } }, props.children)
}

/** year / month / day, kept as three numeric inputs — the calendar is in-world. */
function TimeInput(props) {
  const value = props.value ?? {}
  const set = (part, raw) => {
    const next = { ...value }
    next[part] = raw === '' ? null : Number(raw)
    // An empty year means the whole time is unset. Emitting `{year:null,…}` would
    // be a "time object" the host's validator rightly rejects as unusable, so
    // widening a field back to blank has to produce `null`, not a partial object.
    props.onChange(Number.isFinite(next.year) ? next : null)
  }
  const parts = ['year', 'month', 'day']
  return h(
    'div',
    { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
    ...parts.map((part) =>
      h('input', {
        key: part,
        type: 'number',
        value: value[part] ?? '',
        placeholder: part === 'year' ? '年' : part === 'month' ? '月' : '日',
        onChange: (event) => set(part, event.target.value),
        style: { ...inputStyle, width: part === 'year' ? '80px' : '56px' },
      }),
    ),
  )
}

/** Drop keys that are blank or whitespace-only — they are not representable. */
function withoutBlankKeys(record) {
  return Object.fromEntries(
    Object.entries(record ?? {}).filter(([key]) => String(key).trim() !== ''),
  )
}

/**
 * A key→value editor that never persists an uncommitted row.
 *
 * The draft row lives in component state, NOT in the object being edited. The
 * obvious implementation — append `{'': ''}` to the data and let the renderer
 * filter it out — writes an entry the UI then hides: invisible, unremovable junk
 * in the user's file. That is exactly what shipped, and it reached a real novel
 * project before anyone noticed.
 */
function KeyValueEditor(props) {
  const { value, onChange, addLabel } = props
  const entries = Object.entries(withoutBlankKeys(value))
  const [draft, setDraft] = react.useState({ key: '', value: '' })

  const renameKey = (index, nextKey) => {
    const next = {}
    entries.forEach(([key, entryValue], i) => {
      next[i === index ? nextKey : key] = entryValue
    })
    onChange(withoutBlankKeys(next))
  }

  const commitDraft = () => {
    if (draft.key.trim() === '') return
    onChange({ ...withoutBlankKeys(value), [draft.key.trim()]: draft.value })
    setDraft({ key: '', value: '' })
  }

  const removeAt = (index) => {
    const next = {}
    entries.forEach(([key, entryValue], i) => {
      if (i !== index) next[key] = entryValue
    })
    onChange(next)
  }

  return h(
    'div',
    null,
    ...entries.map(([key, entryValue], index) =>
      h(
        'div',
        { key: index, style: { display: 'flex', gap: '4px', marginBottom: '4px' } },
        h('input', {
          value: key,
          placeholder: props.keyPlaceholder ?? '键',
          onChange: (event) => renameKey(index, event.target.value),
          style: { ...inputStyle, width: '38%' },
        }),
        h('input', {
          value: String(entryValue ?? ''),
          placeholder: props.valuePlaceholder ?? '值',
          maxLength: CUSTOM_VALUE_LIMIT,
          onChange: (event) => onChange({ ...withoutBlankKeys(value), [key]: event.target.value }),
          style: inputStyle,
        }),
        h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 7px' }, onClick: () => removeAt(index) }, '×'),
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', gap: '4px', marginTop: '4px' } },
      h('input', {
        value: draft.key,
        placeholder: props.keyPlaceholder ?? '键',
        onChange: (event) => setDraft((current) => ({ ...current, key: event.target.value })),
        onKeyDown: (event) => {
          if (event.key === 'Enter') commitDraft()
        },
        style: { ...inputStyle, width: '38%' },
      }),
      h('input', {
        value: draft.value,
        placeholder: props.valuePlaceholder ?? '值',
        maxLength: CUSTOM_VALUE_LIMIT,
        onChange: (event) => setDraft((current) => ({ ...current, value: event.target.value })),
        onKeyDown: (event) => {
          if (event.key === 'Enter') commitDraft()
        },
        style: inputStyle,
      }),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 9px' }, disabled: draft.key.trim() === '', onClick: commitDraft }, '＋'),
    ),
  )
}

/** Lines → the normalized list. Blank lines are not values. */
function parseStringList(text) {
  return String(text ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * What the textarea should display.
 *
 * While editing it shows the RAW buffer, not a round-trip through the parsed
 * list. Rendering the normalized value is the obvious implementation and it
 * breaks typing outright: pressing Enter adds a trailing empty line, the parser
 * drops it, the joined value has no trailing newline, and the controlled
 * textarea snaps back — so the cursor never reaches line two and 「每行一个」
 * cannot be used at all. On blur the normalized value takes over again, which is
 * what keeps blank lines out of the file.
 */
function stringListDisplay(editing, draft, value) {
  if (editing) return draft
  return Array.isArray(value) ? value.join('\n') : ''
}

function StringListInput(props) {
  const [draft, setDraft] = react.useState('')
  const [editing, setEditing] = react.useState(false)
  return h('textarea', {
    value: stringListDisplay(editing, draft, props.value),
    rows: 3,
    placeholder: '每行一个',
    onChange: (event) => {
      setEditing(true)
      setDraft(event.target.value)
      props.onChange(parseStringList(event.target.value))
    },
    onBlur: () => {
      setEditing(false)
      setDraft('')
    },
    style: { ...inputStyle, resize: 'vertical', fontFamily: 'inherit' },
  })
}

/**
 * A multi-select picker over existing entities.
 *
 * This is the "click a character and pull them in" affordance: chosen entries are
 * chips, candidates come from a dropdown, and anything already in the data that no
 * longer resolves is shown as an unresolved chip rather than silently dropped —
 * which is how a name typed before the entity existed stays visible and fixable.
 */
function MultiSelect(props) {
  const { value, onChange, options, addLabel } = props
  const selected = Array.isArray(value) ? value : []
  const candidates = Array.isArray(options) ? options : []
  const titleOf = new Map(candidates.map((option) => [option.id, option.title]))
  const [pending, setPending] = react.useState('')

  const remaining = candidates.filter((option) => !selected.includes(option.id))

  return h(
    'div',
    null,
    selected.length === 0
      ? h('div', { style: { fontSize: '11px', opacity: 0.45, marginBottom: '4px' } }, '（未选）')
      : h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' } },
          ...selected.map((id) =>
            h(
              'span',
              {
                key: id,
                title: titleOf.has(id) ? id : `${id} —— 没有对应实体`,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '11px',
                  padding: '1px 4px 1px 8px',
                  borderRadius: '999px',
                  border: `1px solid ${titleOf.has(id) ? muted : '#c98a2b'}`,
                },
              },
              titleOf.get(id) ?? id,
              h(
                'button',
                {
                  type: 'button',
                  style: { ...buttonStyle, padding: '0 5px', border: 'none', opacity: 0.7 },
                  onClick: () => onChange(selected.filter((entry) => entry !== id)),
                },
                '×',
              ),
            ),
          ),
        ),
    h(
      'select',
      {
        value: pending,
        onChange: (event) => {
          if (event.target.value === '') return
          onChange([...selected, event.target.value])
          setPending('')
        },
        style: inputStyle,
      },
      h(
        'option',
        { value: '' },
        remaining.length === 0
          ? candidates.length === 0
            ? '暂无可选项 —— 先在该分支创建'
            : '全部已选'
          : (addLabel ?? '＋ 添加…'),
      ),
      ...remaining.map((option) => h('option', { key: option.id, value: option.id }, option.title)),
    ),
  )
}

function FieldControl(props) {
  const { field, value, onPatch, refOptions } = props
  const set = (next) => onPatch({ [field.key]: next })

  switch (field.type) {
    case 'longtext':
      return h('textarea', {
        value: value ?? '',
        rows: field.rows ?? 4,
        onChange: (event) => set(event.target.value),
        style: { ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 },
      })
    case 'number':
      return h('input', {
        type: 'number',
        value: value ?? '',
        onChange: (event) => {
          if (event.target.value === '') return set(null)
          const parsed = Number(event.target.value)
          // Infinity (from `1e999`) serialises to null, so storing it silently empties the
          // field. A non-finite entry keeps the last good value instead.
          if (!Number.isFinite(parsed)) return
          set(parsed)
        },
        style: inputStyle,
      })
    case 'time':
      return h(TimeInput, { value, onChange: set })
    case 'select':
      return h(
        'select',
        { value: value ?? '', onChange: (event) => set(event.target.value), style: inputStyle },
        // `emptyLabel` lets a caller say WHAT is unset. A pin's 「对应地点」 showing a bare
        // 「（未设）」 left the author asking what the field even was; the default is kept so every
        // other branch reads as before.
        h('option', { value: '' }, field.emptyLabel ?? '（未设）'),
        ...(field.options ?? []).map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    case 'stringlist':
      return h(StringListInput, { value, onChange: set })
    case 'stringmap':
      return h(KeyValueEditor, { value, onChange: set })
    case 'ref':
      return h(
        'select',
        {
          value: value ?? '',
          onChange: (event) => set(event.target.value === '' ? null : event.target.value),
          style: inputStyle,
        },
        h('option', { value: '' }, field.emptyLabel ?? '（未设）'),
        ...(refOptions?.[field.refKind] ?? []).map((option) => h('option', { key: option.id, value: option.id }, option.title)),
      )
    case 'reflist':
      return h(MultiSelect, { value, onChange: set, options: refOptions?.[field.refKind] })
    case 'structure':
      return h(StructureInput, { value, onChange: set })
    case 'text':
    default:
      return h('input', { value: value ?? '', onChange: (event) => set(event.target.value), style: inputStyle })
  }
}

/** The 自定义信息 section: a flat bag of scalars, the zero-migration escape hatch. */
function CustomSection(props) {
  return h(
    'div',
    { style: { marginTop: '18px', paddingTop: '14px', borderTop: `1px dashed ${muted}` } },
    h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } }, '自定义信息'),
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.5, lineHeight: 1.7, marginBottom: '10px' } },
      '随手加的字段放这里，不需要改代码、不需要迁移。需要类型约束、筛选，或要让 AI 校验的，应提升为正式字段。',
    ),
    h(KeyValueEditor, {
      value: props.value,
      onChange: props.onChange,
      keyPlaceholder: '名称',
      valuePlaceholder: '内容',
    }),
  )
}

/**
 * @param entity - the entity descriptor from `ENTITIES`.
 * @param value - the entity being edited.
 * @param onPatch - receives a partial update to merge into the entity.
 * @param refOptions - `{ [refKind]: [{ id, title }] }` for `ref`/`reflist` fields.
 */
function SchemaForm(props) {
  const { entity, value, onPatch, refOptions } = props
  if (value === null || value === undefined) return null
  return h(
    'div',
    null,
    ...entity.fields.map((field) =>
      h(
        FieldRow,
        { key: field.key },
        h(FieldLabel, null, field.label),
        h(FieldControl, { field, value: value[field.key], onPatch, refOptions }),
      ),
    ),
    h(CustomSection, { value: value.custom, onChange: (custom) => onPatch({ custom }) }),
  )
}
