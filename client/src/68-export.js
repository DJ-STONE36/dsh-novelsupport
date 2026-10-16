/**
 * 导出全书 —— Phase 6 的第一件，也是写作这条闭环的终点。
 *
 * WHY IT IS A HOST CALL AND NOT A CLIENT LOOP. Every chapter is a file. Asking the browser for forty of them
 * and pasting them together would read on the slow side of the boundary and assemble outside the offline
 * suite — so the host assembles (`lib/impl/manuscript.js`) and this only chooses the options and downloads
 * the result. The client's whole job is two pure functions and a button.
 */

/** The query string for the options. Pure, so the mapping is assertable without a server. */
function manuscriptQuery(options) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const flag = (value, fallback) => (value === undefined || value === null ? fallback : value === true)
  const parts = [
    `titlePage=${flag(source.titlePage, true) ? 1 : 0}`,
    `summary=${flag(source.summary, false) ? 1 : 0}`,
    `meta=${flag(source.meta, false) ? 1 : 0}`,
    // The chapters are `##` under the book's `#`; that is the shape a manuscript is read in.
    `headingLevel=2`,
  ]
  return parts.join('&')
}

/**
 * One line describing what was exported, plus every chapter left out.
 *
 * THE SKIPPED LIST IS THE POINT. A manuscript that quietly omits chapter twelve is worse than one that
 * refuses to export, so an unreadable chapter is named here rather than hoped about.
 */
function manuscriptReceipt(result) {
  const chapters = Number(result?.chapterCount)
  const words = Number(result?.wordCount)
  const skipped = Array.isArray(result?.skipped) ? result.skipped : []
  const head = `已导出 ${Number.isFinite(chapters) ? chapters : 0} 章 · ${Number.isFinite(words) ? words : 0} 字`
  if (skipped.length === 0) return { text: head, tone: 'ok' }
  const names = skipped.map((entry) => String(entry?.path ?? '?').replace(/^draft\//, '')).join('、')
  return {
    text: `${head}。但有 ${skipped.length} 章没能读出来，不在文件里：${names}`,
    tone: 'error',
  }
}
/**
 * The export control: three options, a path, and a download as the second choice.
 *
 * REORDERED AFTER THE FIRST VERSION WAS UNFINDABLE. 「导出的文件没有给出地址，无法找到」 — and that is a design
 * fault, not a user error: a Blob download lands in a directory the page is not allowed to know. So saving into
 * the project is now the primary action, because that is the one whose result has an address, and the download
 * is labelled with where it actually goes.
 */
function ManuscriptExport(props) {
  const { root } = props
  const [options, setOptions] = react.useState({ titlePage: true, summary: false, meta: false })
  const [busy, setBusy] = react.useState(null)
  const [error, setError] = react.useState(null)
  const [receipt, setReceipt] = react.useState(null)
  const [copied, setCopied] = react.useState(false)

  const toggle = (key) => setOptions((current) => ({ ...current, [key]: current[key] !== true }))

  /** A Blob and a synthetic click — the only way a page hands a file over without a server round trip. */
  const download = (text, name) => {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  /** 保存到项目里: writes the book into novel/export/ and answers with its real path. */
  const save = () => {
    // A CLICK MUST NEVER DO NOTHING. This returned early when `root` was empty — which is exactly what
    // happened when the pane was never given it, and the report was 「点击按钮没有任何效果」 with nothing on
    // screen to explain it. A missing root is a bug in how this was rendered, so it says so.
    if (isBlank(root)) {
      setError('这一栏没有拿到项目路径，按钮无法工作（界面接线的问题，不是你操作错了）。请刷新页面。')
      return
    }
    setBusy('project')
    setError(null)
    setReceipt(null)
    setCopied(false)
    fetch(api(`${API}/manuscript`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ root, ...options }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        setReceipt({
          ...manuscriptReceipt(body),
          kind: 'project',
          absolute: typeof body?.absolute === 'string' ? body.absolute : '',
          relative: typeof body?.relative === 'string' ? body.relative : '',
          bytes: Number(body?.bytes) || 0,
        })
      })
      .catch((failure) => setError(String(failure?.message ?? failure)))
      .finally(() => setBusy(null))
  }

  /** 下载: assembles over the wire and hands the text to the browser. */
  const fetchAndDownload = () => {
    // Same rule as `save`: a click that cannot do its job says why, rather than looking broken.
    if (isBlank(root)) {
      setError('这一栏没有拿到项目路径，按钮无法工作（界面接线的问题，不是你操作错了）。请刷新页面。')
      return
    }
    setBusy('download')
    setError(null)
    setReceipt(null)
    fetch(api(`${API}/manuscript?root=${encodeURIComponent(root)}&${manuscriptQuery(options)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        const text = typeof body?.text === 'string' ? body.text : ''
        if (text === '') throw new Error('宿主返回了空的手稿')
        download(text, typeof body?.name === 'string' && body.name !== '' ? body.name : 'manuscript.md')
        setReceipt({ ...manuscriptReceipt(body), kind: 'download', name: body?.name, absolute: '', relative: '', bytes: 0 })
      })
      .catch((failure) => setError(String(failure?.message ?? failure)))
      .finally(() => setBusy(null))
  }

  const copy = () => {
    const path = receipt?.absolute ?? ''
    if (path === '' || typeof navigator === 'undefined' || navigator.clipboard === undefined) return
    navigator.clipboard.writeText(path).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  const option = (key, label, title) =>
    h(
      'button',
      {
        key,
        type: 'button',
        title,
        style: { ...buttonStyle, opacity: options[key] === true ? 1 : 0.55 },
        onClick: () => toggle(key),
      },
      `${options[key] === true ? '✓ ' : ''}${label}`,
    )

  const saved = receipt !== null && receipt.kind === 'project' && receipt.absolute !== ''

  return h(
    'div',
    { style: { marginBottom: '12px', padding: '10px', border: `1px solid ${muted}`, borderRadius: '6px' } },
    h('div', { style: { fontSize: '12px', opacity: 0.6, marginBottom: '6px' } }, '导出全书'),
    h(
      'div',
      { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' } },
      option('titlePage', '标题页', '以书名开头'),
      option('summary', '章节梗概', '每章标题下附一句梗概'),
      option('meta', '章节状态与人物', '每章标题下附状态与出场人物'),
    ),
    h(
      'div',
      { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
      h(
        'button',
        { type: 'button', style: { ...buttonStyle, opacity: busy === null ? 1 : 0.5 }, disabled: busy !== null, onClick: save },
        busy === 'project' ? '正在保存…' : '保存到项目里',
      ),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, opacity: busy === null ? 1 : 0.5 },
          disabled: busy !== null,
          title: '下载到浏览器的下载目录；具体位置由浏览器决定，页面看不到',
          onClick: fetchAndDownload,
        },
        busy === 'download' ? '正在下载…' : '下载',
      ),
    ),
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.5, marginTop: '4px', lineHeight: 1.8 } },
      '「保存到项目里」写进 novel/export/ 并给出完整路径；「下载」的去处由浏览器决定，页面看不到。',
    ),
    error === null ? null : h(Note, { tone: 'error', text: `导出失败：${error}` }),
    receipt === null
      ? null
      : h(
          'div',
          { style: { fontSize: '12px', marginTop: '6px', lineHeight: 1.9 } },
          // THE PATH COMES FIRST, because that is the question this screen exists to answer.
          saved
            ? h(
                'div',
                { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { opacity: 0.6 } }, '已保存到'),
                h(
                  'code',
                  { style: { wordBreak: 'break-all', background: 'rgba(128,128,128,0.12)', padding: '1px 4px' } },
                  receipt.relative,
                ),
                h('button', { type: 'button', style: { ...buttonStyle, fontSize: '11px' }, onClick: copy }, copied ? '已复制' : '复制完整路径'),
              )
            : null,
          saved ? h('div', { style: { fontSize: '11px', opacity: 0.55, wordBreak: 'break-all' } }, receipt.absolute) : null,
          receipt.kind === 'download'
            ? h('div', { style: { opacity: 0.75 } }, `已下载 ${receipt.name ?? 'manuscript.md'}——在浏览器的下载目录里，页面看不到它具体在哪。`)
            : null,
          h(
            'div',
            {
              style: {
                marginTop: '2px',
                color: receipt.tone === 'error' ? '#e5534b' : undefined,
                opacity: receipt.tone === 'error' ? 1 : 0.75,
              },
            },
            saved && receipt.bytes > 0 ? `${receipt.text} · ${(receipt.bytes / 1024).toFixed(1)} KB` : receipt.text,
          ),
        ),
  )
}
