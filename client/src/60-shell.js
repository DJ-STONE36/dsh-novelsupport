/**
 * Panel shell: the project bar, the in-panel split, and the frame each branch
 * renders into.
 *
 * The detail pane is drawn HERE rather than delegated to the host's right
 * column. That is not a preference: an activity-bar branch panel is a *global*
 * `main` panel, which replaces the Conversation, and the host's right column is
 * session-scoped — `ctx.sidebarRight.mounted` is `undefined` while a global
 * panel fills the center, and the column has "no surface without a session".
 * So the 细节扩展区 has to live inside the panel.
 */

function ProjectBar(props) {
  const { root, setRoot, onCreate, creating, status } = props
  const [state, reload] = useEndpoint(`${API}/workspaces`)
  const workspaces = state.data?.workspaces ?? []
  const available = state.data?.available !== false

  // Convenience, not magic: with exactly one initialized project there is
  // nothing to choose, so opening on it beats showing an empty picker.
  react.useEffect(() => {
    if (!isBlank(root) || state.loading || !available) return
    const initialized = workspaces.filter((workspace) => workspace.project.initialized)
    if (initialized.length === 1) setRoot(initialized[0].path)
  }, [root, state.loading, available, workspaces.length, setRoot])

  const selected = workspaces.find((workspace) => workspace.path === root) ?? null

  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
    h('span', { style: { fontSize: '12px', opacity: 0.55 } }, '项目'),
    h(
      'select',
      {
        value: root ?? '',
        disabled: state.loading,
        onChange: (event) => setRoot(event.target.value === '' ? null : event.target.value),
        style: { ...inputStyle, width: 'auto', maxWidth: '240px' },
      },
      h('option', { value: '' }, state.loading ? '载入中…' : '未选择'),
      ...workspaces.map((workspace) =>
        h(
          'option',
          { key: workspace.id, value: workspace.path },
          `${workspace.title || workspace.path}${workspace.project.initialized ? '' : '（无小说数据）'}`,
        ),
      ),
    ),
    h('button', { type: 'button', style: buttonStyle, onClick: reload }, '刷新'),
    selected !== null && !selected.project.initialized
      ? h(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, borderColor: 'currentColor' },
            disabled: creating,
            onClick: () => onCreate(selected.path, selected.title),
          },
          creating ? '创建中…' : '在此新建小说项目',
        )
      : null,
    status !== null ? h('span', { style: { fontSize: '12px', opacity: 0.7 } }, status) : null,
    !available && !state.loading ? h('span', { style: { fontSize: '12px', opacity: 0.6 } }, '宿主未提供项目列表') : null,
  )
}

/** The branch's own toolbar row, below the header. */
function BranchToolbar(props) {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } },
    props.children,
  )
}

/**
 * Center content plus an optional detail pane.
 *
 * `open` is owned by the branch body, because only it knows whether there is
 * anything worth showing.
 */
function SplitPane(props) {
  return h(
    'div',
    { style: { display: 'flex', height: '100%', minHeight: 0, gap: '0' } },
    h('div', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'auto' } }, props.main),
    props.open && props.detail
      ? h(
          'div',
          {
            style: {
              flex: '0 0 330px',
              width: '330px',
              borderLeft: `1px solid ${muted}`,
              overflow: 'auto',
              padding: '14px 16px',
              boxSizing: 'border-box',
            },
          },
          props.detail,
        )
      : null,
  )
}

/**
 * A narrow list beside a wide content area.
 *
 * The mirror of `SplitPane`: that one puts a detail inspector on the right and
 * is sized for forms, this one puts a chooser on the left and gives the rest to
 * the work — which is what prose needs. Both exist because a chapter editor and
 * an entity inspector want opposite proportions.
 */
function MasterDetail(props) {
  return h(
    'div',
    { style: { display: 'flex', height: '100%', minHeight: 0 } },
    h(
      'div',
      {
        style: {
          flex: '0 0 230px',
          width: '230px',
          borderRight: `1px solid ${muted}`,
          overflow: 'auto',
          paddingRight: '12px',
          boxSizing: 'border-box',
        },
      },
      props.list,
    ),
    h(
      'div',
      {
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'auto',
          paddingLeft: '16px',
          boxSizing: 'border-box',
        },
      },
      props.content,
    ),
  )
}

/**
 * The commit row every editable branch shows: which document, whether it is dirty,
 * save, revert.
 *
 * Shared rather than repeated so the three branches cannot drift apart, and so a
 * body component can be rendered in a test with one `status` + `actions` pair
 * instead of a dozen loose props.
 *
 * @param status - `{ dirty, saving, savedAt }`.
 * @param actions - `{ save, revert }`.
 * @param extra - branch-specific controls, placed before the detail toggle.
 */
function CommitRow(props) {
  const { label, status, actions, extra, detailOpen, onToggleDetail } = props
  return h(
    BranchToolbar,
    null,
    h('span', { style: { fontSize: '12px', opacity: 0.55 } }, label),
    status.dirty ? h('span', { style: { fontSize: '12px', color: '#e5a34b' } }, '未保存') : null,
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, borderColor: status.dirty ? 'currentColor' : muted },
        disabled: !status.dirty || status.saving,
        onClick: actions.save,
      },
      status.saving ? '保存中…' : '保存',
    ),
    h('button', { type: 'button', style: buttonStyle, disabled: !status.dirty, onClick: actions.revert }, '还原'),
    ...(extra ?? []),
    status.savedAt !== null && status.savedAt !== undefined && !status.dirty
      ? h('span', { style: { fontSize: '12px', opacity: 0.5 } }, `已保存 ${status.savedAt}`)
      : null,
    // A FUNCTION, not merely "not undefined". `onToggleDetail: null` used to render a live-looking
    // 收起详情 button that was bound to nothing — the click did nothing and the pane could not be
    // collapsed. Requiring callable makes `null` mean "no toggle", which is what a caller means.
    typeof onToggleDetail === 'function'
      ? h(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, marginLeft: 'auto' },
            onClick: onToggleDetail,
          },
          detailOpen ? '收起详情' : '展开详情',
        )
      : null,
  )
}

/** The findings a refused or questionable write produced, in one block. */
function WriteFeedback(props) {
  const { error, issues, warnings } = props
  // `Array.isArray` hardened the CONTAINER, not the elements: an `issues` array holding
  // a `null` still reaches `issue.code` below and takes the pane down. This is the same
  // shape as the bug that shipped, one level deeper.
  const list = (value) => (Array.isArray(value) ? value.filter(isRecord) : [])
  const raw = (value) => (Array.isArray(value) ? value : [])
  const refused = list(issues)
  const cautioned = list(warnings)
  // The length of the RAW list decides whether a refusal happened: `[null]` is still a
  // refusal with a malformed payload, and rendering nothing would hide it entirely.
  if (raw(issues).length === 0 && raw(warnings).length === 0 && isMissing(error)) return null

  return h(
    'div',
    { style: { marginBottom: '10px', fontSize: '12px', lineHeight: 1.7 } },
    !isMissing(error) ? h(Note, { text: String(error), tone: 'error' }) : null,
    refused.length > 0
      ? h(
          'div',
          { style: { color: '#e5534b' } },
          h('div', null, '宿主拒绝了这次写入，因为会引入以下问题：'),
          ...refused.map((issue, index) =>
            h(
              'div',
              { key: index, style: { paddingLeft: '10px' } },
              // A malformed issue is still worth showing: silently dropping it would
              // hide the fact that the write was refused.
              `· ${isMissing(issue.code) ? '(无代码)' : issue.code} ${isMissing(issue.message) ? '' : issue.message}`,
            ),
          ),
        )
      : raw(issues).length > 0
        ? h(
            'div',
            { style: { color: '#e5534b' } },
            h('div', null, '宿主拒绝了这次写入，但没有给出可读的原因。'),
          )
        : null,
    cautioned.length > 0
      ? h(
          'div',
          { style: { color: '#c98a2b' } },
          ...cautioned.map((issue, index) =>
            h('div', { key: index }, `· ${isMissing(issue.message) ? '(无说明)' : issue.message}`),
          ),
        )
      : null,
  )
}

/** A labelled block used inside the detail pane. */
function DetailHeading(props) {
  // `title` FIRST, because that is what every caller passes. Rendering only `children` made all four
  // headings in the map panel — 地图, 标记大小, 标点名称, 地图标注 — invisible, silently: a div with no text
  // looks exactly like a layout gap, so nobody reports it. `children` is kept as the fallback.
  return h(
    'div',
    { style: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' } },
    props.title ?? props.children,
  )
}

/**
 * A crash in one view shows a message instead of a blank window.
 *
 * ADDED AFTER TWO WHITE SCREENS. React unmounts the WHOLE tree when a render throws, so a single wrong
 * variable name — `penColor` in `MapSurface`, `texts` in `MapBranch` — did not break one panel, it broke
 * every panel, and the author's report was necessarily "整个插件白屏" with nothing to go on. The mistake is
 * always cheap to fix once it can be READ, so this turns the blank page into the error and a 重试 button.
 *
 * A class, because React has no hook for this and the boundary must catch render-phase errors.
 */
class ViewBoundary extends react.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    // Also to the console, so the full stack is available where the author can copy it.
    console.error('[dsh-novel] view failed to render:', error)
  }

  render() {
    if (this.state.error === null) return this.props.children
    return h(
      'div',
      { style: { padding: '16px', fontSize: '13px', lineHeight: 1.8 } },
      h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, `${this.props.label ?? '这个视图'}出错了`),
      h('div', { style: { opacity: 0.6, marginBottom: '10px' } }, '其余部分仍可用；右侧的面板列表可以切到别的视图。'),
      h(
        'pre',
        {
          style: {
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'rgba(128,128,128,0.12)',
            padding: '8px',
            margin: '0 0 10px 0',
            fontSize: '12px',
          },
        },
        String(this.state.error?.stack ?? this.state.error?.message ?? this.state.error),
      ),
      h(
        'button',
        { type: 'button', style: buttonStyle, onClick: () => this.setState({ error: null }) },
        '重试',
      ),
    )
  }
}

function createPanel(ctx, branch) {
  return function BranchPanel() {
    const [root, setRoot] = useProjectRoot()
    const [creating, setCreating] = react.useState(false)
    const [status, setStatus] = react.useState(null)

    const createProject = (target, title) => {
      // Guard locally. `JSON.stringify` DROPS an undefined value, so a blank
      // target would reach the host as a body with no `root` key at all and come
      // back as "root is required and must be an absolute path" — a true
      // statement that explains nothing about what the user did wrong.
      if (isBlank(target)) {
        setStatus('没有选中的项目目录，请先在左侧下拉里选一个。')
        return
      }
      setCreating(true)
      setStatus(null)
      fetch(api(`${API}/project/create`), {
        method: 'POST',
        headers: WRITE_HEADERS,
        // Seed the project title from the workspace's own title, so a project
        // created from the picker is named rather than blank.
        body: JSON.stringify({ root: target, title: title ?? '' }),
      })
        .then(async (response) => {
          const body = await response.json().catch(() => null)
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setStatus(`已创建 ${body.created.length} 个文档`)
          setRoot(target)
        })
        .catch((error) => setStatus(`创建失败：${String(error?.message ?? error)}`))
        .finally(() => setCreating(false))
    }

    return h(
      'div',
      {
        style: {
          height: '100%',
          boxSizing: 'border-box',
          // Entry pages pad by the frame's reserved strip so nothing lands under
          // the Windows caption. Zero on plain web documents.
          paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
          display: 'flex',
          flexDirection: 'column',
          color: 'inherit',
        },
      },
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
            padding: '10px 20px',
            borderBottom: `1px solid ${muted}`,
          },
        },
        h('strong', { style: { fontSize: '14px', fontWeight: 600 } }, `小说 · ${branch.label}`),
        h('span', { style: { width: '1px', height: '18px', background: muted } }),
        h(ProjectBar, { root, setRoot, onCreate: createProject, creating, status }),
        h(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, marginLeft: 'auto' },
            onClick: () => ctx.layout.selectPanel(null),
          },
          '返回对话',
        ),
      ),
      h('div', { style: { padding: '20px', overflow: 'hidden', flex: '1 1 auto', minHeight: 0 } }, h(ViewBoundary, { label: `小说 · ${branch.label}` }, h(BranchRouter, { branch, root }))),
    )
  }
}
