/**
 * The generator control: model-backed or local-template.
 *
 * Four deliberate properties:
 *
 *   - **It fills the form; it does not save.** The result is a draft the author
 *     reviews before the write. A generator that saved directly would put
 *     unreviewed output into a novel.
 *   - **It says what it did.** Which model ran and how many tokens it used are
 *     shown afterwards. A button that quietly spends the author's quota is not
 *     acceptable, and the cost is otherwise invisible.
 *   - **It is declared by the entity.** `ENTITIES[x].generate` turns the control
 *     on, so a second generator is a descriptor line rather than new UI.
 *   - **Two modes, honestly labelled.** The model writes prose and costs tokens;
 *     the local tables produce names and classifications instantly and for free.
 *     Neither pretends to be the other.
 */

/** The choice of mode/provider/model/style/count, persisted per browser. */
const GENERATE_SETTINGS_KEY = 'dsh-novel.generate.settings'

function readGenerateSettings() {
  try {
    const raw = window.localStorage.getItem(GENERATE_SETTINGS_KEY)
    const parsed = raw === null ? null : JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    // A browser with storage disabled must still be able to generate.
    return {}
  }
}

function writeGenerateSettings(settings) {
  try {
    window.localStorage.setItem(GENERATE_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* preference only; losing it is not worth an error */
  }
}

/**
 * The generation catalogue, fetched once per control from the host.
 *
 * Style labels and generator kinds come from the host rather than a copy here:
 * a duplicated preset table would drift from the wording the host actually sends,
 * and a generator kind the host does not implement would fail only at click time.
 */
function useCatalog(enabled) {
  const [state, setState] = react.useState({
    loading: enabled === true,
    available: false,
    providers: [],
    models: {},
    styles: [],
    generators: [],
  })
  react.useEffect(() => {
    if (enabled !== true) return undefined
    let live = true
    fetch(api(`${API}/catalog`))
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!live) return
        setState({
          loading: false,
          available: body?.available === true,
          providers: body?.providers ?? [],
          models: body?.models ?? {},
          styles: body?.styles ?? [],
          generators: body?.generators ?? [],
        })
      })
      .catch(() => {
        if (live) setState((previous) => ({ ...previous, loading: false, available: false }))
      })
    return () => {
      live = false
    }
  }, [enabled])
  return state
}

/** `provider · model`, flattened, with the model's own name for display. */
function modelChoices(models) {
  const out = []
  for (const [provider, list] of Object.entries(models ?? {})) {
    if (!Array.isArray(list)) continue
    for (const model of list) {
      if (model?.id === null || model?.id === undefined) continue
      out.push({ provider, model: model.id, label: `${provider} · ${model.name ?? model.id}` })
    }
  }
  return out
}

/** The option rows, kept out of the way behind a disclosure. */
function GenerateOptions(props) {
  const { settings, onChange, catalog } = props
  const choices = modelChoices(catalog.models)
  const styles = catalog.styles
  const mode = settings.mode ?? 'model'

  return h(
    'details',
    { style: { marginTop: '6px', fontSize: '11px' } },
    h('summary', { style: { cursor: 'pointer', opacity: 0.55 } }, '生成选项'),
    h(
      'div',
      { style: { paddingTop: '6px', display: 'flex', flexDirection: 'column', gap: '5px' } },
      h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: { width: '46px', opacity: 0.6 } }, '方式'),
        h(
          'select',
          {
            value: settings.mode ?? 'model',
            onChange: (event) => onChange({ mode: event.target.value }),
            style: { ...inputStyle, padding: '2px 4px', flex: 1 },
          },
          h('option', { value: 'model' }, '模型生成（花额度）'),
          h('option', { value: 'local' }, '本地模板（离线免费）'),
        ),
      ),
      (settings.mode ?? 'model') === 'model'
        ? h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { width: '46px', opacity: 0.6 } }, '模型'),
            h(
              'select',
              {
                value: settings.modelKey ?? '',
                onChange: (event) => onChange({ modelKey: event.target.value }),
                style: { ...inputStyle, padding: '2px 4px', flex: 1 },
              },
              // Empty means "let the host choose", which is also the fallback when
              // /catalog is unavailable.
              h('option', { value: '' }, catalog.loading === true ? '载入中…' : '自动（宿主决定）'),
              ...choices.map((choice) =>
                h('option', { key: `${choice.provider}/${choice.model}`, value: `${choice.provider}/${choice.model}` }, choice.label),
              ),
            ),
          )
        : null,
      mode === 'model'
        ? h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { width: '46px', opacity: 0.6 } }, '风格'),
            h(
              'select',
              {
                value: settings.styleId ?? '',
                onChange: (event) => onChange({ styleId: event.target.value }),
                style: { ...inputStyle, padding: '2px 4px', flex: 1 },
              },
              h('option', { value: '' }, '不限'),
              ...styles.map((style) => h('option', { key: style.id, value: style.id }, style.label)),
            ),
          )
        : null,
      mode === 'model'
        ? h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { width: '46px', opacity: 0.6 } }, '备选'),
            h(
              'select',
              {
                value: String(settings.count ?? 1),
                onChange: (event) => onChange({ count: Number(event.target.value) }),
                style: { ...inputStyle, padding: '2px 4px', flex: 1 },
              },
              h('option', { value: '1' }, '1 份，直接填入'),
              h('option', { value: '3' }, '3 份，挑一份'),
              h('option', { value: '5' }, '5 份，挑一份'),
            ),
          )
        : null,
      h(
        'div',
        { style: { opacity: 0.45, lineHeight: 1.6 } },
        mode === 'model'
          ? '模型生成会读取本项目的设定，内容有文采但会消耗额度。'
          : '本地模板从内置表里取名字与分类，不联网、不花额度，但不会写描述性文字。',
      ),
      mode === 'model' && catalog.available !== true && catalog.loading !== true
        ? h('div', { style: { color: '#e5534b', lineHeight: 1.6 } }, '宿主没有可用的模型服务，请改用本地模板。')
        : null,
    ),
  )
}

/**
 * How a drafted passage joins what is already in the editor.
 *
 * Pure, because the three modes differ in a way that is easy to get subtly wrong:
 * 重写 replaces, while 接着写 and 扩写 append — and appending to an empty chapter must
 * not leave leading blank lines.
 */
function mergeDraft(current, text, mode) {
  const base = typeof current === 'string' ? current.trimEnd() : ''
  const draft = typeof text === 'string' ? text.trim() : ''
  if (draft === '') return base
  if (mode === 'rewrite') return draft
  return base === '' ? draft : `${base}\n\n${draft}`
}

/** The drafting modes, mirroring the host's `DRAFT_MODES` ids. */
const DRAFT_MODE_LABELS = [
  { id: 'continue', label: '接着写' },
  { id: 'expand', label: '扩写' },
  { id: 'rewrite', label: '重写' },
]

/**
 * The chapter drafting control.
 *
 * Distinct from `GenerateControl` on purpose: that one fills an entity's fields from
 * JSON, this one appends prose. Both leave the result for review rather than saving,
 * and both report the model and the cost.
 */
function DraftControl(props) {
  const { root, path, onDrafted } = props
  const [settings, setSettings] = react.useState(readGenerateSettings)
  const [instruction, setInstruction] = react.useState('')
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState(null)
  const [receipt, setReceipt] = react.useState(null)
  const catalog = useCatalog(true)
  const mode = settings.draftMode ?? 'continue'

  const update = (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    writeGenerateSettings(next)
  }

  const run = () => {
    setBusy(true)
    setError(null)
    setReceipt(null)
    const [provider, model] = (settings.modelKey ?? '').split('/')
    fetch(api(`${API}/draft`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({
        root,
        path,
        mode,
        instruction,
        styleId: settings.styleId ?? '',
        provider: provider === '' || provider === undefined ? null : provider,
        model: model === '' || model === undefined ? null : model,
      }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        onDrafted(body.text, body.mode ?? mode)
        setReceipt({
          model: `${body.provider} · ${body.model}`,
          tokens: body.usage?.totalTokens ?? null,
          words: body.wordCount ?? null,
          contextUsed: body.contextUsed !== false,
        })
      })
      .catch((failure) => setError(String(failure?.message ?? failure)))
      .finally(() => setBusy(false))
  }

  if (isBlank(path)) return null

  return h(
    'div',
    { style: { marginBottom: '12px', padding: '10px', border: `1px solid ${muted}`, borderRadius: '6px' } },
    h('div', { style: { fontSize: '12px', opacity: 0.6, marginBottom: '6px' } }, '让 AI 写这一章'),
    h('input', {
      type: 'text',
      value: instruction,
      placeholder: '本次要求，例如「写主角走进荒废的山门」',
      onChange: (event) => setInstruction(event.target.value),
      style: { ...inputStyle, width: '100%', marginBottom: '6px', boxSizing: 'border-box' },
    }),
    h(
      'div',
      { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', fontSize: '11px' } },
      h(
        'select',
        {
          value: mode,
          onChange: (event) => update({ draftMode: event.target.value }),
          style: { ...inputStyle, padding: '2px 4px' },
        },
        ...DRAFT_MODE_LABELS.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
      ),
      h(
        'select',
        {
          value: settings.styleId ?? '',
          onChange: (event) => update({ styleId: event.target.value }),
          style: { ...inputStyle, padding: '2px 4px' },
        },
        h('option', { value: '' }, '不限风格'),
        ...catalog.styles.map((style) => h('option', { key: style.id, value: style.id }, style.label)),
      ),
      h(
        'select',
        {
          value: settings.modelKey ?? '',
          onChange: (event) => update({ modelKey: event.target.value }),
          style: { ...inputStyle, padding: '2px 4px' },
        },
        h('option', { value: '' }, catalog.loading === true ? '载入中…' : '自动选模型'),
        ...modelChoices(catalog.models).map((choice) =>
          h('option', { key: `${choice.provider}/${choice.model}`, value: `${choice.provider}/${choice.model}` }, choice.label),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, marginLeft: 'auto' },
          disabled: busy === true,
          onClick: run,
        },
        busy === true ? '写作中…（可能要十几秒）' : '生成正文',
      ),
    ),
    error !== null
      ? h('div', { style: { fontSize: '11px', color: '#e5534b', marginTop: '6px', lineHeight: 1.6 } }, error)
      : null,
    receipt !== null
      ? h(
          'div',
          { style: { fontSize: '10px', opacity: 0.45, marginTop: '6px', lineHeight: 1.6 } },
          `由 ${receipt.model} 写入${receipt.words === null || receipt.words === undefined ? '' : ` ${receipt.words} 字`}${
            receipt.tokens === null || receipt.tokens === undefined ? '' : ` · ${receipt.tokens} tokens`
          } · ${receipt.contextUsed === false ? '未结合作品设定' : '已结合本章设定与前文'} · 尚未保存，请检查后再保存`,
        )
      : null,
  )
}

/**
 * The candidates, when more than one was produced. Picking one fills the form; the
 * author still has to save.
 */
function CandidateList(props) {
  const { candidates, onPick, labelOf } = props
  if (!Array.isArray(candidates) || candidates.length < 2) return null
  return h(
    'div',
    { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' } },
    h('div', { style: { fontSize: '11px', opacity: 0.55 } }, `${candidates.length} 个备选，点一个填入：`),
    ...candidates.map((candidate, index) =>
      h(
        'div',
        {
          key: index,
          onClick: () => onPick(candidate),
          style: {
            padding: '5px 8px',
            borderRadius: '6px',
            cursor: 'pointer',
            border: `1px solid ${muted}`,
            fontSize: '12px',
            lineHeight: 1.6,
          },
        },
        h('div', { style: { fontWeight: 600 } }, labelOf(candidate)),
        candidate.description !== undefined && candidate.description !== ''
          ? h('div', { style: { fontSize: '11px', opacity: 0.6 } }, candidate.description.slice(0, 60))
          : null,
      ),
    ),
  )
}

function GenerateReceipt(props) {
  const { error, receipt } = props
  if (error === null || error === undefined) {
    if (receipt === null || receipt === undefined) return null
    if (receipt.local === true) {
      return h(
        'div',
        { style: { fontSize: '10px', opacity: 0.45, marginTop: '6px', lineHeight: 1.6 } },
        '本地模板生成 · 未消耗额度 · 内容为草稿，请检查后保存',
      )
    }
    // Saying whether the project setting was used matters: the author asked for a
    // result that fits THIS novel, and "ungrounded" is a different (weaker) thing.
    const grounded = receipt.contextUsed === false ? '未结合作品设定' : '已结合作品设定'
    return h(
      'div',
      { style: { fontSize: '10px', opacity: 0.45, marginTop: '6px', lineHeight: 1.6 } },
      `由 ${receipt.model} 生成${receipt.tokens === null || receipt.tokens === undefined ? '' : ` · ${receipt.tokens} tokens`} · ${grounded} · 内容为草稿，请检查后保存`,
    )
  }
  return h('div', { style: { fontSize: '11px', color: '#e5534b', marginTop: '6px', lineHeight: 1.6 } }, error)
}

function GenerateControl(props) {
  const { generator, hint, base, root, taken, onGenerated } = props
  const [settings, setSettings] = react.useState(readGenerateSettings)
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState(null)
  const [receipt, setReceipt] = react.useState(null)
  const [candidates, setCandidates] = react.useState(null)
  const mode = settings.mode ?? 'model'
  const catalog = useCatalog(mode === 'model')

  const update = (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    writeGenerateSettings(next)
  }

  const runLocal = () => {
    const rng = makeRng(Date.now() % 2147483647)
    const draft = generateLocalDraft(generator.kind, rng, { taken })
    onGenerated({ ...base, ...draft })
    setCandidates(null)
    setReceipt({ local: true })
  }

  const run = () => {
    if (mode === 'local') {
      runLocal()
      return
    }
    setBusy(true)
    setError(null)
    setReceipt(null)
    setCandidates(null)

    const [provider, model] = (settings.modelKey ?? '').split('/')

    fetch(api(`${API}/generate`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      // `root` grounds the prompt in this project's setting: existing names,
      // existing vocabulary, the calendar. Without it the model invents a world.
      body: JSON.stringify({
        kind: generator.kind,
        hint: hint ?? '',
        base: base ?? {},
        root,
        useContext: !isBlank(root),
        provider: provider === '' || provider === undefined ? null : provider,
        model: model === '' || model === undefined ? null : model,
        // The id, not the wording: the host owns the instruction.
        styleId: settings.styleId ?? '',
        count: settings.count ?? 1,
      }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          // The host explains itself (model failure, unparseable response, no
          // model available); surface its words rather than a status code.
          throw new Error(body?.error ?? `HTTP ${response.status}`)
        }
        const produced = Array.isArray(body.candidates) && body.candidates.length > 0 ? body.candidates : [body.value]
        onGenerated(produced[0])
        setCandidates(produced.length > 1 ? produced : null)
        setReceipt({
          model: `${body.provider} · ${body.model}`,
          tokens: body.usage?.totalTokens ?? null,
          contextUsed: body.contextUsed !== false,
        })
      })
      .catch((failure) => setError(String(failure?.message ?? failure)))
      .finally(() => setBusy(false))
  }

  return h(
    'div',
    { style: { marginBottom: '12px' } },
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, width: '100%' },
        disabled: busy === true,
        title:
          mode === 'local'
            ? '用内置表生成一个草稿，不联网、不花额度'
            : hint === '' || hint === undefined
              ? '让模型即兴生成一份草稿'
              : `以「${hint}」为方向生成`,
        onClick: run,
      },
      busy === true ? '生成中…（可能要几秒）' : mode === 'local' ? '随机生成（本地模板）' : '随机生成',
    ),
    h(GenerateOptions, { settings, onChange: update, catalog }),
    h(GenerateReceipt, { error, receipt }),
    h(CandidateList, {
      candidates,
      onPick: (chosen) => {
        onGenerated(chosen)
        setCandidates(null)
      },
      labelOf: (candidate) => candidate.name ?? candidate.title ?? candidate.id ?? '(未命名)',
    }),
  )
}
