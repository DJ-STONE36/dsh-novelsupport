/**
 * Driving an agent from the chapter editor — the CLIENT half of Phase 5c.
 *
 * WHY THE HOST HALF WAS ALREADY DONE. `lib/impl/router.js` registers `/agent/prompt`,
 * `/agent/status`, `/agent/result` and `/agent/cancel`, calls the host with the semantically correct
 * arguments, and reports the known host defect as its own code (`agent-prompt-unsupported`, 501) so
 * that nothing here has to change when the host is fixed. `tools/patch-asar.mjs` applies that one-line
 * host fix. What was missing was this: there was no way to START a run, WATCH it, or TAKE its result.
 *
 * WHY AN AGENT AT ALL, when `ctx.llm` already writes chapters. They are different tools. `ctx.llm`
 * answers one question with one reply. An agent reads the setting, follows a skill, writes FILES and
 * can run the validator — that is what "写一整章并按技能校验" needs, and it cannot be done through a
 * single completion. The two sit side by side in the editor; neither pretends to be the other.
 *
 * THE ONE RULE THAT MATTERS: the agent writes to `novel/` with its own file tools, which BYPASS this
 * plugin's validation gate. So its prose goes into the editor UNSAVED — exactly as `ctx.llm` output
 * does — and what it touched is REPORTED rather than silently reloaded over the author's unsaved text.
 */

/**
 * The prompt one chapter's run is given.
 *
 * Built here, in the client, so the wording is visible where the button is — but it is DELIBERATELY a
 * pure function of what the author typed, because a prompt assembled at the call site from four
 * closures is a prompt nobody can test.
 */
function agentPromptText(chapterTitle, instruction) {
  const title = String(chapterTitle ?? '').trim()
  const ask = String(instruction ?? '').trim()
  return [
    `请写小说章节${title === '' ? '' : `《${title}》`}的正文。`,
    ask === '' ? '' : `本次要求：${ask}`,
    '按 novel-writer 技能的要求做：先读这一章相关的设定与上一章结尾，再落笔，直接写进这一章的正文。',
    '写完后用 novel-consistency 技能跑一次一致性校验，并在回复里报告：改了哪个文件、写了多少字、校验结果如何。',
    '不要改动 novel/setting/ 与 novel/outline/ 下的任何文件。',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * What is happening, from the two endpoints, in ONE place.
 *
 * A UI that decides this itself from `running` and `text` in several spots drifts: it shows "writing"
 * forever when a run ends without a `turn/end`, or "done" before the result was read.
 *
 * `finished` is the route's own word for it — `GET /agent/result` sends `finished` (router.js:1477-1492).
 * Reading a different key here is silent: the phase simply never reaches 'done', `status.running` has
 * already gone false, and the caller that polls on `phase === 'reading'` keeps asking forever.
 *
 * @returns `'idle' | 'unsupported' | 'failed' | 'running' | 'reading' | 'done'`
 *   `reading` is the gap between "the run stopped" and "we have its result" — real, and short.
 */
function agentPhase(input) {
  const started = input?.started === true
  const error = input?.error ?? null
  if (error !== null) {
    // Conditions the plugin recognises as "this host cannot be driven", as opposed to a run that
    // simply failed. Both are reported BY NAME by the host half, so neither is a mystery screen.
    const unsupported = error?.code === 'agent-prompt-unsupported'
      || error?.code === 'agent-followup-missing'
      || error?.unsupported === true
    return unsupported ? 'unsupported' : 'failed'
  }
  if (!started) return 'idle'
  if (input?.result?.finished === true) return 'done'
  if (input?.status?.running === true) return 'running'
  return 'reading'
}

/** The project files a run touched, as a tidy sorted list. Never used to decide what to reload. */
function agentWrites(result) {
  const raw = result?.writes
  const list = Array.isArray(raw) ? raw : []
  return [...new Set(list.filter((entry) => typeof entry === 'string' && entry !== ''))].sort()
}

/** The usage, as one line, or null when the host reported none. */
function agentUsageLine(usage) {
  if (usage === null || usage === undefined || typeof usage !== 'object') return null
  const parts = []
  for (const [key, label] of [['inputTokens', '输入'], ['outputTokens', '输出'], ['totalTokens', '合计']]) {
    const value = Number(usage[key])
    if (Number.isFinite(value) && value > 0) parts.push(`${label} ${value.toLocaleString('en-US')}`)
  }
  return parts.length === 0 ? null : parts.join(' · ')
}

/** The default model, as one line. */
function agentModelLine(defaultModel) {
  if (defaultModel === null || defaultModel === undefined) return null
  if (typeof defaultModel === 'string') return defaultModel
  const provider = typeof defaultModel.provider === 'string' ? defaultModel.provider : ''
  const model = typeof defaultModel.model === 'string' ? defaultModel.model : ''
  const joined = [provider, model].filter((part) => part !== '').join(' / ')
  return joined === '' ? null : joined
}

/**
 * The sessions a run could be given, filtered to THIS project.
 *
 * The host matches on `cwd`, so a session rooted anywhere else would write into another novel. The
 * filter is here as well as there, because a session that appears in this list is one a click can
 * drive, and a click must not be able to write into the wrong project.
 */
function agentSessionsFor(items, root) {
  const wanted = String(root ?? '')
  return objectList(items).filter((item) => {
    if (typeof item?.sessionId !== 'string' || item.sessionId === '') return false
    const cwd = item?.cwd
    if (typeof cwd !== 'string') return true
    return cwd.toLowerCase() === wanted.toLowerCase()
  })
}

/**
 * How long ago, in words. Pure, and `now` is a parameter so a test never depends on the clock.
 *
 * REPORTED: 「会话全是一串数字和字母是什么意思」. The host's `/sessions` rows carry `updatedAt` (and `blank`,
 * `running`) but NO title, so the picker fell back to `title ?? sessionId` and every row was a bare
 * `session-60825a3f-6c57-4458-8baf-4be2e195c381`. "When did I last use this" is the thing that makes one row
 * choosable over another, and the host does tell us that.
 */
function agentRelativeTime(updatedAt, now) {
  // TYPED, NOT COERCED. `Number(null)` is 0 and `Number('')` is 0, so coercing turned a MISSING timestamp into
  // 「56 年前」 — the epoch. The host sends a number, so anything else is "no answer".
  const then = typeof updatedAt === 'number' ? updatedAt : NaN
  const current = typeof now === 'number' ? now : NaN
  if (!Number.isFinite(then) || !Number.isFinite(current)) return null
  const seconds = Math.max(0, Math.round((current - then) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.round(months / 12)} 年前`
}

/**
 * The label for one session row.
 *
 * The id stays, because it is what identifies a session when something goes wrong — but as a SHORT SUFFIX, not
 * as the whole label. A title is used when the host provides one (it does not today), so a row reads
 * 「3 小时前 · …4be2e195」 rather than a wall of hex.
 */
function agentSessionLabel(row, now) {
  const parts = []
  const id = typeof row?.sessionId === 'string' ? row.sessionId : ''
  const title = typeof row?.title === 'string' ? row.title.trim() : ''
  if (title !== '') parts.push(title)
  else if (row?.blank === true) parts.push('空会话')
  const when = agentRelativeTime(row?.updatedAt, now)
  if (when !== null) parts.push(when)
  if (row?.running === true) parts.push('进行中')
  // The last 8 characters are enough to tell two rows apart, and short enough to read.
  if (id !== '') parts.push(`…${id.slice(-8)}`)
  return parts.length === 0 ? id : parts.join(' · ')
}

/** Newest first, so the session an author just used is the first one offered. */
function agentSessionsSorted(items) {
  return items.slice().sort((left, right) => Number(right?.updatedAt ?? 0) - Number(left?.updatedAt ?? 0))
}

/** Loads the project's sessions once, plus the host's default model. */
function useAgentSessions(root) {
  const [state, setState] = react.useState({ loading: true, error: null, items: [], defaultModel: null, available: false })
  react.useEffect(() => {
    if (isBlank(root)) {
      setState({ loading: false, error: null, items: [], defaultModel: null, available: false })
      return undefined
    }
    let live = true
    setState((current) => ({ ...current, loading: true, error: null }))
    fetch(api(`${API}/sessions?root=${encodeURIComponent(root)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        if (!live) return
        setState({
          loading: false,
          error: null,
          // THE HOST'S FIELD IS `sessions`, not `items`. Reading `items` found nothing, so the picker was
          // permanently empty and the button permanently disabled — a dead end that reports no error, which
          // is why it has to be asserted against the real route rather than against a plausible shape.
          items: agentSessionsSorted(agentSessionsFor(Array.isArray(body?.sessions) ? body.sessions : [], root)),
          defaultModel: body?.defaultModel ?? null,
          available: body?.available === true,
        })
      })
      .catch((failure) => {
        if (live) setState({ loading: false, error: String(failure?.message ?? failure), items: [], defaultModel: null, available: false })
      })
    return () => {
      live = false
    }
  }, [root])
  return state
}

/**
 * The agent control's presentation, props-driven.
 *
 * Extracted for the same reason every other branch's body is: `renderToString` does not run effects, so
 * a fetch-driven component renders only its loading state and everything after the guard is untestable.
 * All of the meaning lives here; the wrapper below only owns the network.
 */
function AgentDraftBody(props) {
  const {
    sessions, sessionId, onPickSession, instruction, onInstruction,
    phase, error, note, usage, writes, defaultModel,
    onStart, onCancel, onTake, canTake,
  } = props

  const heading = h('div', { style: { fontSize: '12px', opacity: 0.6, marginBottom: '6px' } }, '交给 agent 写这一章')

  // THIS BUTTON NO LONGER NEEDS A HOST PATCH, and the screen must stop saying it does.
  //
  // It used to drive the run through `sessionController.prompt(request, signal)`, which dereferenced a
  // cancellation signal it could not be given, so the only way through was patching the installed app.
  // The plugin now resolves the live agent and calls `followup(message)` on it — the host's own
  // documented way to drive a conversation — so no patch is involved and the "go patch your host"
  // screen was actively misleading.
  //
  // What remains is a genuine refusal to write to the session log: a field whose value is `undefined`
  // is rejected because JSON would drop the key. That is a host-side gap, not this project's data.
  if (phase === 'unsupported') {
    return h(
      'div',
      { style: { marginBottom: '12px', padding: '10px', border: `1px solid ${muted}`, borderRadius: '6px' } },
      heading,
      h(Note, { tone: 'error', text: error?.message ?? '这次提问没能交给 agent。' }),
      h(
        'div',
        { style: { fontSize: '12px', opacity: 0.7, marginTop: '4px', lineHeight: 1.8 } },
        '会话日志只接受「无损 JSON 可序列化」的事件：值为 undefined 的字段会被拒绝（JSON 会把它丢掉，往返之后就不是同一个值）。' +
          '本插件为每条消息生成 id，因此这条错误通常来自宿主侧缺失的字段，不是本项目的数据或参数问题。',
      ),
      h(
        'div',
        { style: { fontSize: '12px', opacity: 0.7, marginTop: '6px', lineHeight: 1.8 } },
        '在它修好之前，这一章可以先用上面的「让 AI 写这一章」。',
      ),
    )
  }

  return h(
    'div',
    { style: { marginBottom: '12px', padding: '10px', border: `1px solid ${muted}`, borderRadius: '6px' } },
    heading,
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.6, marginBottom: '6px', lineHeight: 1.8 } },
      '和上面「让 AI 写这一章」不同：那条走模型，一次一问一答；这条会把整章交给 agent——它读设定、照技能写、直接落到章节文件里，并跑一次校验。',
    ),
    sessions === null || sessions.length === 0
      ? h(Note, {
          text: sessions === null
            ? '正在读取本项目的会话…'
            : // NOT A DEAD END. With no sessionId the host picks the project's single session, or creates one —
              // so a project that has never been chatted in is exactly where this tool is most useful.
              '这个项目还没有会话。直接开始即可：宿主会为它新建一个。',
        })
      : h(
          'div',
          { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '6px' } },
          h('span', { style: { fontSize: '12px', opacity: 0.6 } }, '会话'),
          h(
            'select',
            {
              value: sessionId ?? '',
              onChange: (event) => onPickSession(event.target.value),
              style: { ...inputStyle, flex: '1 1 220px' },
            },
            // LABELLED, NOT RAW. The host's session rows carry no title, so this used to be a list of
            // `session-60825a3f-6c57-4458-8baf-4be2e195c381` and the only way to tell two apart was to guess.
            ...sessions.map((item) =>
              h('option', { key: item.sessionId, value: item.sessionId }, agentSessionLabel(item, Date.now())),
            ),
          ),
          h(
            'span',
            { style: { fontSize: '11px', opacity: 0.45, width: '100%' } },
            `本项目共 ${sessions.length} 个会话，按最近使用排序；末尾是编号后 8 位（宿主不提供标题）。标着「进行中」的会话正在忙，选它会被拒绝。`,
          ),
        ),
    h('input', {
      type: 'text',
      value: instruction,
      placeholder: '本次要求，例如「写主角走进荒废的山门」',
      onChange: (event) => onInstruction(event.target.value),
      style: { ...inputStyle, width: '100%', marginBottom: '6px' },
    }),
    h(
      'div',
      { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
      phase === 'running' || phase === 'reading'
        ? h('button', { type: 'button', style: buttonStyle, onClick: onCancel }, '取消')
        : // ENABLED EVEN WITH NO SESSION CHOSEN. The host resolves it: one session for this project is used,
          // several make it ask which, none makes one. Disabling the button here — as it first did — turned a
          // project without a session into a dead end with nothing to click and no error to read.
          h(
            'button',
            { type: 'button', style: buttonStyle, onClick: onStart },
            sessionId === null ? '交给 agent 写（新建会话）' : '交给 agent 写',
          ),
      canTake ? h('button', { type: 'button', style: buttonStyle, onClick: onTake }, '把结果放进编辑框') : null,
      agentModelLine(defaultModel) === null
        ? null
        : h('span', { style: { fontSize: '11px', opacity: 0.55 } }, `默认模型 ${agentModelLine(defaultModel)}`),
    ),
    // WHAT IS HAPPENING, always, so a long run never looks like a dead button.
    phase === 'running'
      ? h('div', { style: { fontSize: '12px', marginTop: '6px', opacity: 0.75 } }, 'agent 正在写。可以继续干别的，写完后这里会报告结果。')
      : null,
    phase === 'reading'
      ? h('div', { style: { fontSize: '12px', marginTop: '6px', opacity: 0.75 } }, 'agent 停了，正在读它的结果…')
      : null,
    error !== null && phase === 'failed'
      ? h(Note, { tone: 'error', text: `调用失败：${error.message ?? error}` })
      : null,
    note === null ? null : h('div', { style: { fontSize: '12px', marginTop: '6px', opacity: 0.75 } }, note),
    agentUsageLine(usage) === null
      ? null
      : h('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '4px' } }, agentUsageLine(usage)),
    // WHICH FILES IT TOUCHED. Reported, never acted on: the agent writes with its own tools, which bypass
    // this plugin's validation gate, so the author decides what to do about it.
    writes.length === 0
      ? null
      : h(
          'div',
          { style: { fontSize: '11px', opacity: 0.6, marginTop: '4px', lineHeight: 1.8 } },
          '它写过的文件：' + writes.join('、'),
        ),
  )
}

/**
 * The control itself: owns the network, hands everything readable to `AgentDraftBody`.
 *
 * The result goes into the editor through `onDrafted` and is NOT saved — the same rule as the model
 * path, for a stronger reason: an agent writes the file itself, so anything this control also saved
 * would be a second writer on the same file.
 */
function AgentDraftControl(props) {
  const { root, chapterTitle, onDrafted } = props
  const sessionsState = useAgentSessions(root)
  const [sessionId, setSessionId] = react.useState(null)
  const [instruction, setInstruction] = react.useState('')
  const [started, setStarted] = react.useState(false)
  const [status, setStatus] = react.useState(null)
  const [result, setResult] = react.useState(null)
  const [error, setError] = react.useState(null)
  const [note, setNote] = react.useState(null)

  // Default to the most recently used IDLE session.
  //
  // NOT a running one, which is what this used to prefer: `/agent/prompt` refuses a busy session with 409
  // `session-busy`, so defaulting to the one session that cannot accept a prompt made the first click fail
  // every time — and the session the author is most likely to be sitting in is precisely the running one.
  // The list arrives newest first, so `find` gives the latest idle one.
  react.useEffect(() => {
    if (sessionId !== null) return
    const items = sessionsState.items
    if (items.length === 0) return
    const idle = items.find((item) => item.running !== true)
    // No idle session leaves the choice open, and the host then creates one — see `start`, which omits
    // `sessionId` rather than sending a null.
    if (idle !== undefined) setSessionId(idle.sessionId)
  }, [sessionsState.items, sessionId])

  const phase = agentPhase({ started, status, result, error })

  // POLLING, and only while a run is live. `inspect` transfers a whole transcript, which is why the status
  // endpoint exists at all — so this asks the cheap one and reads the transcript exactly once.
  react.useEffect(() => {
    if (sessionId === null || !started || phase !== 'running') return undefined
    const timer = setInterval(() => {
      fetch(api(`${API}/agent/status?sessionId=${encodeURIComponent(sessionId)}`))
        .then(async (response) => {
          const body = await response.json().catch(() => null)
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setStatus(body)
        })
        .catch((failure) => setError({ message: String(failure?.message ?? failure) }))
    }, 1500)
    return () => clearInterval(timer)
  }, [sessionId, started, phase])

  // Read the result ONCE, when the run has stopped.
  react.useEffect(() => {
    if (sessionId === null || !started || phase !== 'reading') return undefined
    let live = true
    // `root` is REQUIRED by the route, not decorative: a transcript is the agent's
    // own words and may contain unpublished prose, so the host scopes the read to
    // the session's workspace exactly as it scopes a prompt. Omitting it used to be
    // accepted and would now be a 400.
    fetch(api(`${API}/agent/result?sessionId=${encodeURIComponent(sessionId)}&root=${encodeURIComponent(root)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        if (!live) return
        setResult(body)
        const text = typeof body?.text === 'string' ? body.text.trim() : ''
        const touched = agentWrites(body)
        setNote(
          text === ''
            ? touched.length === 0
              ? 'agent 结束了，但没有回复文本，也没有写文件。'
              : `agent 直接改了文件：${touched.join('、')}。请自己打开确认后保存。`
            : 'agent 的回复已读回。正文不会自动进编辑框——按「把结果放进编辑框」再由你决定保存。',
        )
      })
      .catch((failure) => {
        if (live) setError({ message: String(failure?.message ?? failure) })
      })
    return () => {
      live = false
    }
  }, [sessionId, started, phase, root])

  const start = () => {
    setStarted(true)
    setStatus(null)
    setResult(null)
    setError(null)
    setNote(null)
    // THE FIELD IS `text`, NOT `prompt`: the route reads `body.text` and answers 400 `prompt-required`
    // otherwise. And `sessionId` travels only when one was chosen — with none, the host picks the project's
    // single session or creates one, which is the only way out of a project that has no session yet.
    const payload = { root, text: agentPromptText(chapterTitle, instruction) }
    if (sessionId !== null) payload.sessionId = sessionId
    fetch(api(`${API}/agent/prompt`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify(payload),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          const failure = new Error(body?.error ?? `HTTP ${response.status}`)
          failure.code = body?.code ?? null
          // The route names WHICH of the two 501 causes it was; the screen must not guess.
          failure.reason = body?.details?.reason ?? null
          throw failure
        }
        if (typeof body?.sessionId === 'string' && body.sessionId !== '') setSessionId(body.sessionId)
        setStatus({ running: true })
        setNote(body?.created === true ? '已建了一个新会话并交给 agent。' : '已交给 agent。')
      })
      .catch((failure) => {
        setError({ message: String(failure?.message ?? failure), code: failure?.code ?? null, reason: failure?.reason ?? null })
      })
  }

  const cancel = () => {
    if (sessionId === null) return
    fetch(api(`${API}/agent/cancel`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ root, sessionId }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        setNote('已请求取消。')
      })
      .catch((failure) => setError({ message: String(failure?.message ?? failure) }))
  }

  const resultText = typeof result?.text === 'string' ? result.text.trim() : ''

  return h(AgentDraftBody, {
    sessions: sessionsState.loading ? null : sessionsState.items,
    sessionId,
    onPickSession: (next) => setSessionId(next === '' ? null : next),
    instruction,
    onInstruction: setInstruction,
    phase,
    error,
    note: sessionsState.error === null ? note : `读取会话失败：${sessionsState.error}`,
    usage: result?.usage ?? null,
    writes: agentWrites(result),
    defaultModel: sessionsState.defaultModel,
    onStart: start,
    onCancel: cancel,
    onTake: () => {
      if (resultText !== '') onDrafted(resultText, 'continue')
    },
    canTake: resultText !== '',
  })
}
