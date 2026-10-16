/**
 * Branch bodies and the router that picks one.
 *
 * Each body owns its own toolbar and its own detail pane; the shell only
 * supplies the frame. Bodies that have not landed yet render `PlannedBranch`,
 * which states what will go there — a visible, honest placeholder beats a
 * silent blank panel, and it keeps navigation complete while views arrive one
 * at a time.
 */

function PlannedBranch(props) {
  const { branch } = props
  return h(
    'div',
    null,
    h(Note, { text: `${branch.hint}。` }),
    h(
      'div',
      { style: { marginTop: '14px', fontSize: '12px', opacity: 0.5, lineHeight: 1.9 } },
      h('div', null, `分支标识：${branch.id}`),
      h('div', null, branch.planned ?? '待实现。'),
    ),
  )
}

/**
 * The chapter list. Props-driven, so the suite renders it directly.
 */
function ChapterListPane(props) {
  const { selected, onSelect, onCreate, creating, createError, totalWordCount } = props
  // A hand-edited project can hold a null entry; the pane must not depend on its
  // caller having filtered it.
  const chapters = objectList(props.chapters)
  return h(
    'div',
    null,
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, width: '100%', marginBottom: '10px' },
        disabled: creating === true,
        onClick: onCreate,
      },
      creating === true ? '创建中…' : '＋ 新建章节',
    ),
    createError !== null && createError !== undefined
      ? h('div', { style: { fontSize: '11px', color: '#e5534b', marginBottom: '8px' } }, createError)
      : null,
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.5, marginBottom: '8px' } },
      `${chapters.length} 章 · ${totalWordCount ?? 0} 字`,
    ),
    // 导出全书 belongs with the list: it is about the whole book, not the chapter that happens to be open.
    h(ManuscriptExport, { root: props.root }),
    chapters.length === 0
      ? h(Note, { text: '还没有章节。' })
      : h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          ...chapters.map((entry) => {
            const active = entry.path === selected
            return h(
              'div',
              {
                key: entry.path,
                onClick: () => onSelect(entry.path),
                title: entry.path,
                style: {
                  padding: '5px 8px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  background: active ? 'rgba(128,128,128,0.16)' : 'transparent',
                },
              },
              h(
                'div',
                {
                  style: {
                    fontSize: '12px',
                    fontWeight: active ? 600 : 400,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                entry.title || entry.id || entry.path.replace(/^draft\//, ''),
              ),
              h(
                'div',
                { style: { fontSize: '10px', opacity: 0.5 } },
                `${entry.wordCount} 字${entry.status ? ` · ${entry.status}` : ''}${
                  entry.frontMatterError !== null && entry.frontMatterError !== undefined ? ' · front matter 有问题' : ''
                }`,
              ),
            )
          }),
        ),
  )
}

/**
 * The prose editor. Props-driven, so the suite can render a loaded chapter — the
 * state that no fetch-driven test could reach.
 */
function ChapterEditorPane(props) {
  const {
    loading, placeholder, path, root, meta, body, wordCount, refOptions,
    status, actions, onPatchMeta, onSetBody, onDrafted, frontMatterError, feedback,
  } = props

  if (loading === true) return h(Note, { text: '载入中…' })
  if (meta === null) {
    // A placeholder is a normal state (nothing chosen yet), not a failure.
    if (placeholder !== undefined && placeholder !== null) return h(Note, { text: placeholder })
    return h(Note, { text: status.error ?? '章节不可用。', tone: 'error' })
  }

  return h(
    'div',
    null,
    h(CommitRow, {
      label: path,
      status,
      actions,
      extra: [h('span', { key: 'count', style: { fontSize: '12px', opacity: 0.6 } }, `${wordCount} 字`)],
    }),
    frontMatterError !== null && frontMatterError !== undefined
      ? h(
          'div',
          { style: { fontSize: '12px', color: '#e5a34b', marginBottom: '10px' } },
          `front matter 解析失败，正文仍可编辑：${frontMatterError}`,
        )
      : null,
    h(WriteFeedback, feedback),
    h(SchemaForm, { entity: ENTITIES.chapter, value: meta, onPatch: onPatchMeta, refOptions }),
    onDrafted !== undefined ? h(DraftControl, { root, path, onDrafted }) : null,
    // PHASE 5c, the client half. `DraftControl` above is one question to the model; this hands the whole
    // chapter to an agent, which reads the setting, follows a skill and writes the file itself. It reports
    // the known host limitation rather than failing silently when that call is unavailable.
    onDrafted !== undefined ? h(AgentDraftControl, { root, chapterTitle: meta?.title ?? '', onDrafted }) : null,
    h(
      'div',
      { style: { marginTop: '6px' } },
      h(FieldLabel, null, '正文'),
      h('textarea', {
        value: body,
        onChange: (event) => onSetBody(event.target.value),
        rows: 20,
        spellCheck: false,
        placeholder: '正文……支持 Markdown。',
        style: {
          ...inputStyle,
          fontFamily: 'inherit',
          fontSize: '13px',
          lineHeight: 1.9,
          resize: 'vertical',
          minHeight: '320px',
        },
      }),
    ),
  )
}

/** The chapters branch's presentation: list on the left, editor on the right. */
function ChapterBody(props) {
  return h(MasterDetail, { list: h(ChapterListPane, props.list), content: h(ChapterEditorPane, props.editor) })
}

/**
 * The chapters branch: a chapter list beside the prose editor.
 *
 * The one place the plugin writes something a human typed at length, so saves
 * are explicit rather than per-keystroke (the host validates every write against
 * the whole project), and the word count is recomputed from the buffer as you
 * type — it is derived data and never stored (docs/data-model.md principle 2).
 */
function ChapterBranch(props) {
  const { root } = props
  const [selected, setSelected] = react.useState(null)
  const [creating, setCreating] = react.useState(false)
  const [createError, setCreateError] = react.useState(null)
  const [listState, reloadList] = useEndpoint(
    isBlank(root) ? null : `${API}/chapters?root=${encodeURIComponent(root)}`,
  )
  const chapter = useChapter(root, selected)
  // Reference candidates for the metadata form — characters, places and the
  // outline nodes a chapter can point at. Read-only; this branch saves only its
  // own chapter files.
  const refOptions = useRefOptions(root, ['character', 'place', 'outline-node'])

  const chapters = objectList(listState.data?.chapters)

  // Open the first chapter once the list arrives, rather than showing an empty
  // editor while a manuscript sits behind it.
  react.useEffect(() => {
    if (selected !== null) return
    if (chapters.length > 0) setSelected(chapters[0].path)
  }, [selected, chapters.length])

  if (isBlank(root)) return h(Note, { text: '先在上方选择一个项目。' })
  if (listState.loading) return h(Note, { text: '载入中…' })
  if (listState.error !== null) {
    // A project with no data yet is a normal step on the way to creating one,
    // not a failure — say what to do instead of showing a code.
    if (listState.code === 'project-missing') {
      return h(Note, { text: '这个目录里还没有小说数据。点上方的「在此新建小说项目」，会创建 novel/ 目录与初始文档。' })
    }
    return h(Note, { text: listState.error, tone: 'error' })
  }

  const createChapter = () => {
    setCreating(true)
    setCreateError(null)
    fetch(api(`${API}/chapter`), {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ root, title: '新章节' }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        setSelected(body.path)
        reloadList()
      })
      .catch((error) => setCreateError(String(error?.message ?? error)))
      .finally(() => setCreating(false))
  }

  // `editorProps` rather than a rendered element: `ChapterBody` is pure and takes
  // each pane's props, so a test can drive either pane with a fixture.
  const editorProps =
    selected === null
      ? { loading: false, placeholder: '左侧选择一章开始编辑，或点「新建章节」。', meta: null, status: { error: null } }
      : chapter.state.loading
        ? { loading: true, meta: null, status: { error: null } }
        : {
            loading: false,
            path: selected,
            root,
            meta: chapter.state.meta,
            body: chapter.state.body,
            wordCount: chapter.state.wordCount,
            refOptions,
            status: chapter.state,
            actions: { save: chapter.save, revert: chapter.reload },
            onPatchMeta: chapter.patchMeta,
            onSetBody: chapter.setBody,
            // The draft joins the editor as UNSAVED text, so a generation can never
            // overwrite prose the author has not committed.
            // The updater form matters: the response arrives seconds later, and merging
            // against the body captured when the request started would silently discard
            // anything typed since.
            onDrafted: (text, mode) => chapter.setBody((current) => mergeDraft(current, text, mode)),
            frontMatterError: chapter.state.frontMatterError,
            feedback: { error: null, issues: chapter.state.issues, warnings: chapter.warnings },
          }

  return h(ChapterBody, {
    list: {
      // `root` travels with the list because 导出全书 lives in this pane and every one of its calls needs it.
      // Without it the export buttons did NOTHING AT ALL — `isBlank(root)` returned early — and the omission
      // was invisible because the call site `h(ManuscriptExport, { root: props.root })` looked right.
      root,
      chapters,
      selected,
      onSelect: setSelected,
      onCreate: createChapter,
      creating,
      createError,
      totalWordCount: listState.data?.totalWordCount,
    },
    editor: editorProps,
  })
}

/**
 * A branch that hosts sub-views as tabs.
 *
 * Each tab is itself a branch-shaped descriptor, so `BranchRouter` renders it with
 * no special case: a tab can be any view the router already knows (tree, timeline,
 * planned), and adding one is data.
 */
/**
 * A branch that hosts sub-views behind a tab strip.
 *
 * The wrapper is a full-height flex column, and that is load-bearing rather than
 * decoration: the views inside are `SplitPane`s, whose own `height:100%` only
 * resolves against a parent with a DEFINITE height. An auto-height wrapper here
 * made the pane grow to its content and get clipped by the host's
 * `overflow:hidden` frame — with no scrollbar, so a long form like a character
 * card was simply unreachable past the fold.
 *
 * That is why only the tab hosts (人物 / 组织 / 世界) were affected and a plain
 * tree branch (物品) was fine.
 */
function TabsBranch(props) {
  const { branch, root } = props
  const tabs = Array.isArray(branch.tabs) ? branch.tabs : []
  const [activeId, setActiveId] = react.useState(tabs.length > 0 ? tabs[0].id : null)
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null

  if (active === null) return h(Note, { text: '这个分支还没有子视图。' })

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h(
      'div',
      { style: { display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap', flex: '0 0 auto' } },
      ...tabs.map((tab) =>
        h(
          'button',
          {
            key: tab.id,
            type: 'button',
            style: {
              ...buttonStyle,
              ...(tab.id === active.id ? { borderColor: 'currentColor', fontWeight: 600 } : {}),
            },
            onClick: () => setActiveId(tab.id),
          },
          tab.label,
        ),
      ),
    ),
    // `minHeight: 0` so the child may shrink below its content and scroll instead
    // of pushing the strip off-screen.
    // A sub-tab is wrapped too, so one broken view inside 世界 does not take the tab strip with it —
    // which is exactly what made the blank window so hard to describe.
    h('div', { style: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden' } }, h(ViewBoundary, { label: `小说 · ${active.label ?? active.id}` }, h(BranchRouter, { branch: active, root }))),
  )
}

/** Resolve an entity key to its schema plus the document key it lives under. */
function entitySpecFor(branch, entityKey) {
  // A branch declares its entities either as a tree (groups + leaves) or as flat
  // collections; both shapes flow through here so the detail pane has one lookup.
  const slots = [
    ...(branch.tree?.groups ?? []),
    ...(branch.tree?.leaves ?? []),
    ...(branch.collections ?? []),
  ]
  const slot = slots.find((candidate) => candidate.entity === entityKey)
  if (slot === undefined) return null
  const entity = ENTITIES[entityKey]
  return { key: slot.key, entity: entityKey, label: entity.label, fields: entity.fields, titleOf: entity.titleOf }
}

/**
 * The tree branch's presentation, props-driven.
 *
 * Extracted from `EntityTreeBranch` because that component is fetch-driven and
 * effects do not run under `renderToString`: it always renders its loading state,
 * so everything below the guard — the toolbar, the tree, the detail form, the
 * delete flow — was unreachable from a test. Three of the bugs reported from
 * live use lived in exactly that region.
 */
function EntityTreeBody(props) {
  const {
    branch, root, doc, refOptions, selection, onSelect, onMutate,
    status, actions, detailOpen, onToggleDetail, feedback, placeLinks,
  } = props

  const spec = selection === null ? null : entitySpecFor(branch, selection.entity)
  const current = spec === null ? null : objectList(doc[spec.key]).find((entity) => entity.id === selection.id) ?? null
  /** Which map the author chose to mark this 地点 on. Null means "the first one", chosen at render. */
  const [markMapId, setMarkMapId] = react.useState(null)

  const patchEntity = (patch) => {
    if (spec === null) return
    onMutate((currentDoc) => ({
      ...currentDoc,
      [spec.key]: objectList(currentDoc[spec.key]).map((entity) =>
        entity.id === selection.id ? { ...entity, ...patch } : entity,
      ),
    }))
  }

  const removeEntity = () => {
    if (spec === null) return
    // Deleting something still referenced is refused by the host's validator,
    // which lists the referrers — so the UI does not have to guess whether this
    // is safe, it just reports what comes back.
    onMutate((currentDoc) => ({
      ...currentDoc,
      [spec.key]: (currentDoc[spec.key] ?? []).filter((entity) => entity.id !== selection.id),
    }))
    onSelect(null)
  }

  const main = h(
    'div',
    null,
    h(CommitRow, { label: branch.doc, status, actions, detailOpen, onToggleDetail }),
    h(WriteFeedback, feedback),
    // 批量导入 names, driven by the branch's own descriptor: any branch that declares collections or a tree
    // gets it, including ones added later.
    h(BulkImport, { branch, doc, onMutate }),
    h(EntityTree, { doc, tree: branch.tree, collections: branch.collections, selection, onSelect, onMutate }),
  )

  const detail =
    spec === null || current === null
      ? h(Note, { text: '选中左侧一项即可在此编辑。' })
      : h(
          'div',
          null,
          h(DetailHeading, null, `${spec.label} · ${spec.titleOf(current)}`),
          h('div', { style: { fontSize: '11px', opacity: 0.45, marginBottom: '12px' } }, current.id),
          // Only entities that declare a generator offer one.
          ENTITIES[spec.entity]?.generate !== undefined
            ? h(GenerateControl, {
                generator: ENTITIES[spec.entity].generate,
                hint: current[ENTITIES[spec.entity].generate.hintField] ?? '',
                base: current,
                root,
                onGenerated: patchEntity,
              })
            : null,
          h(SchemaForm, { entity: { fields: spec.fields }, value: current, onPatch: patchEntity, refOptions }),
          // WHERE THIS ENTITY IS MARKED ON A MAP, and how to mark it. The link ran one way only, so a 地点
          // could not say that a marker pointed at it — and the sole symptom of the link was a refused
          // delete that named nothing. Now a place can also PUT a marker on a map, which is the direction an
          // author actually thinks in: "where is 青云峰?" rather than "which place is this dot?".
          placeLinks !== undefined
            ? h(
                'div',
                { style: { marginTop: '14px', borderTop: `1px solid ${muted}`, paddingTop: '10px' } },
                h(DetailHeading, { title: `地图标注（${placeLinks.links.length}）` }),
                ...placeLinks.links.map((link) =>
                  h(
                    'div',
                    { key: link.mapId + ':' + link.pinId, style: { fontSize: '12px', marginBottom: '3px' } },
                    link.mapName + ' · ' + link.pinId + (link.label === '' ? '' : '「' + link.label + '」'),
                  ),
                ),
                placeLinks.links.length === 0
                  ? h('div', { style: { fontSize: '12px', opacity: 0.6 } }, '还没有在任何地图上标出。')
                  : h(
                      'div',
                      { style: { fontSize: '11px', opacity: 0.45, margin: '6px 0', lineHeight: 1.7 } },
                      '删除这个地点会被宿主拒绝，直到没有标记点关联它。清除标注只去掉关联，地图上的标记点会保留。',
                    ),
                placeLinks.links.length === 0
                  ? null
                  : h(
                      'button',
                      { type: 'button', style: { ...buttonStyle, marginTop: '4px' }, onClick: () => placeLinks.onUnlink(selection.id) },
                      '清除这些地图标注（' + placeLinks.links.length + '）',
                    ),
                // THE OTHER DIRECTION, which is the one an author reaches for.
                placeLinks.maps.length === 0
                  ? null
                  : h(
                      'div',
                      { style: { marginTop: '12px' } },
                      h(FieldLabel, null, '在地图上标出这个地点'),
                      h(
                        'div',
                        { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                        h(
                          'select',
                          {
                            value: markMapId ?? (placeLinks.maps[0]?.id ?? ''),
                            onChange: (event) => setMarkMapId(event.target.value),
                            style: inputStyle,
                          },
                          ...placeLinks.maps.map((map) => h('option', { key: map.id, value: map.id }, map.name)),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: buttonStyle,
                            onClick: () => placeLinks.onMark(selection.id, markMapId ?? (placeLinks.maps[0]?.id ?? '')),
                          },
                          '新建标记点',
                        ),
                      ),
                      h(
                        'div',
                        { style: { fontSize: '11px', opacity: 0.45, marginTop: '6px', lineHeight: 1.7 } },
                        '会在这张地图的空白处放一个标记点，名称自动跟着这个地点；地图已保存，切过去把它拖到正确位置即可。',
                      ),
                    ),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle, marginTop: '16px', color: '#e5534b', borderColor: muted },
              onClick: removeEntity,
            },
            `删除这个${spec.label}`,
          ),
          h(
            'div',
            { style: { marginTop: '10px', fontSize: '11px', opacity: 0.45, lineHeight: 1.7 } },
            '删除后记得保存。若仍有其他条目引用它，宿主会拒绝并列出引用者。',
          ),
        )

  return h(SplitPane, { main, detail, open: detailOpen })
}

/**
 * A tree on the left, the selected entity's detail on the right.
 *
 * Saves are explicit rather than per-keystroke: the host validates every write
 * against the whole project, and firing one per character would put the
 * validator on the typing path.
 */
function EntityTreeBranch(props) {
  const { branch, root } = props
  const { state, update, save, reload, warnings } = useDocument(root, branch.doc)
  /**
   * The map document, read ONLY by a branch that asks for it.
   *
   * A 地点 needs to know which markers point at it — that is the other half of the link, and without it the
   * only symptom of a link is a refused delete. `useDocument` treats a blank path as "no document", so every
   * other branch is unaffected.
   */
  const maps = useDocument(root, branch.placeLinks === true ? MAP_DOC : null)
  const refOptions = useRefOptions(root, Array.isArray(branch.refKinds) ? branch.refKinds : [])
  const [selection, setSelection] = react.useState(null)
  const [detailOpen, setDetailOpen] = react.useState(true)

  /** Which markers link to the selected 地点, and a way to clear them so the place can be deleted. */
  const placeLinks =
    branch.placeLinks !== true || selection === null || maps.state.value === null
      ? undefined
      : {
          links: mapPlaceLinks(mapMaps(maps.state.value), selection.id),
          /** The maps a marker could be placed on, so the author can choose. */
          maps: mapMaps(maps.state.value).map((map) => ({ id: map.id, name: mapDisplayName(map) })),
          /**
           * Put a marker for this 地点 on a chosen map.
           *
           * The map is written AND saved: the whole point is to go and drag the new marker into place, so
           * leaving the document dirty would let the author set off with the marker only in memory.
           */
          onMark: (placeId, mapId) => {
            const marked = mapMarkPlace(mapMaps(maps.state.value), mapId, placeId)
            if (marked.pinId === null) return
            maps.update((current) => withMaps(current, marked.maps, current?.activeMapId))
            maps.save()
          },
          onUnlink: (placeId) => {
            // The map is written AND saved, because the point of clearing the link is to make the delete
            // legal straight away — leaving it dirty would let the author save the places document first.
            maps.update((current) => withMaps(current, mapUnlinkPlace(mapMaps(current), placeId), current?.activeMapId))
            maps.save()
          },
          dirty: maps.state.dirty,
        }

  if (isBlank(root)) return h(Note, { text: '先在上方选择一个项目。' })
  if (state.loading) return h(Note, { text: '载入中…' })
  if (state.value === null) {
    if (state.code === 'document-missing') {
      return h(Note, { text: `${branch.doc} 不存在。点上方的「在此新建小说项目」创建项目文档。` })
    }
    return h(Note, { text: state.error ?? '文档不可用。', tone: 'error' })
  }

  return h(EntityTreeBody, {
    branch,
    root,
    doc: state.value,
    refOptions,
    placeLinks,
    selection,
    onSelect: setSelection,
    onMutate: update,
    status: state,
    actions: { save, revert: reload },
    detailOpen,
    onToggleDetail: () => setDetailOpen((open) => !open),
    feedback: { error: null, issues: state.issues, warnings },
  })
}

/**
 * The timeline branch's presentation, props-driven. Extracted for the same reason
 * as `EntityTreeBody`: the fetch guard made everything below it untestable.
 */
function TimelineBody(props) {
  const {
    branch, root, doc, refOptions, selection, onSelect, onMutate,
    status, actions, detailOpen, onToggleDetail, feedback,
  } = props

  const spec = selection === null ? null : entitySpecFor(branch, selection.entity)
  const current = spec === null ? null : objectList(doc[spec.key]).find((entity) => entity.id === selection.id) ?? null

  const patchEntity = (patch) => {
    if (spec === null) return
    onMutate((currentDoc) => ({
      ...currentDoc,
      [spec.key]: objectList(currentDoc[spec.key]).map((entity) =>
        entity.id === selection.id ? { ...entity, ...patch } : entity,
      ),
    }))
  }

  const removeEntity = () => {
    if (spec === null) return
    onMutate((currentDoc) => ({
      ...currentDoc,
      [spec.key]: (currentDoc[spec.key] ?? []).filter((entity) => entity.id !== selection.id),
    }))
    onSelect(null)
  }

  const takenIds = new Set([
    ...objectList(doc.lines).map((line) => line.id),
    ...objectList(doc.events).map((event) => event.id),
  ])

  const addEntity = (entityKey) => {
    const entity = ENTITIES[entityKey]
    const blank = entity.blank()
    const id = mintId(entity.idPrefix, blank.name ?? blank.title ?? 'entry', takenIds)
    const collection = entitySpecFor(branch, entityKey).key
    onMutate((currentDoc) => ({ ...currentDoc, [collection]: [...(currentDoc[collection] ?? []), { id, ...blank }] }))
    onSelect({ entity: entityKey, id })
  }

  const main = h(
    'div',
    null,
    h(CommitRow, {
      label: branch.doc,
      status,
      actions,
      detailOpen,
      onToggleDetail,
      extra: [
        h('button', { key: 'event', type: 'button', style: buttonStyle, onClick: () => addEntity('timeline-event') }, '新建事件'),
        h('button', { key: 'line', type: 'button', style: buttonStyle, onClick: () => addEntity('timeline-line') }, '新建时间线'),
      ],
    }),
    h(WriteFeedback, feedback),
    h(TimelineView, { doc, selection, onSelect }),
  )

  const detail =
    spec !== null && current !== null
      ? h(
          'div',
          null,
          h(DetailHeading, null, `${spec.label} · ${spec.titleOf(current)}`),
          h('div', { style: { fontSize: '11px', opacity: 0.45, marginBottom: '12px' } }, current.id),
          ENTITIES[spec.entity]?.generate !== undefined
            ? h(GenerateControl, {
                generator: ENTITIES[spec.entity].generate,
                hint: current[ENTITIES[spec.entity].generate.hintField] ?? '',
                base: current,
                root,
                onGenerated: patchEntity,
              })
            : null,
          h(SchemaForm, { entity: { fields: spec.fields }, value: current, onPatch: patchEntity, refOptions }),
          h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle, marginTop: '16px', color: '#e5534b', borderColor: muted },
              onClick: removeEntity,
            },
            `删除这个${spec.label}`,
          ),
        )
      : h(
          'div',
          null,
          h(Note, { text: '选中轴线上的事件即可编辑；未选中时可编辑历法。' }),
          h(
            'div',
            { style: { marginTop: '18px' } },
            h(CalendarEditor, {
              calendar: doc.calendar,
              onChange: (next) => onMutate((currentDoc) => ({ ...currentDoc, calendar: next })),
            }),
          ),
        )

  return h(SplitPane, { main, detail, open: detailOpen })
}

/**
 * The timeline branch: a shared time axis over `timeline.json`, with the selected
 * event or line edited on the right and the calendar itself edited when nothing
 * is selected.
 */
function TimelineBranch(props) {
  const { branch, root } = props
  const { state, update, save, reload, warnings } = useDocument(root, branch.doc)
  const refOptions = useRefOptions(root, Array.isArray(branch.refKinds) ? branch.refKinds : [])
  const [selection, setSelection] = react.useState(null)
  const [detailOpen, setDetailOpen] = react.useState(true)

  if (isBlank(root)) return h(Note, { text: '先在上方选择一个项目。' })
  if (state.loading) return h(Note, { text: '载入中…' })
  if (state.value === null) {
    if (state.code === 'document-missing') {
      return h(Note, { text: `${branch.doc} 不存在。点上方的「在此新建小说项目」创建项目文档。` })
    }
    return h(Note, { text: state.error ?? '文档不可用。', tone: 'error' })
  }

  return h(TimelineBody, {
    branch,
    root,
    doc: state.value,
    refOptions,
    selection,
    onSelect: setSelection,
    onMutate: update,
    status: state,
    actions: { save, revert: reload },
    detailOpen,
    onToggleDetail: () => setDetailOpen((open) => !open),
    feedback: { error: null, issues: state.issues, warnings },
  })
}

/**
 * The relationship graph.
 *
 * Owns `relations.json` — the one document no other branch writes — and reads the
 * node collections through `useRefOptions`, so a character created in the 人物 tab
 * shows up here without this branch knowing where characters live.
 *
 * The time cursor is the point: relations carry intervals, so "who is allied with
 * whom" is a question about a moment, not a fact about the book.
 */
/**
 * The graph's presentation: the cursor bar plus the drawing, props-driven.
 *
 * Extracted from `GraphBranch` on purpose. That component is fetch-driven, and
 * effects do not run under `renderToString` — so it always renders its loading
 * state and everything below that guard is unreachable from a test. A misplaced
 * props object in the cursor bar shipped as a blank panel for exactly that reason.
 */
function GraphView(props) {
  const {
    nodes, edges, types, calendar, cursorKey, onStep, onLatest, totalEdges,
    selection, onSelect, positions, width, height, includeOthers, onToggleOthers,
    svgRef, dragging, onNodePointerDown, onPointerMove, onPointerUp,
    manualCount, onResetPositions, layoutDirty, onSaveLayout, onRevertLayout, layoutSaving,
  } = props

  return h(
    'div',
    null,
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          fontSize: '12px',
          marginBottom: '8px',
        },
      },
      h('span', { style: { opacity: 0.55 } }, '时间游标'),
      h('strong', null, cursorKey === null ? '（最新）' : formatTimeKey(calendar, cursorKey)),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: () => onStep(-1) }, '← 上一变化'),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: () => onStep(1) }, '下一变化 →'),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: onLatest }, '回到最新'),
      h(
        'label',
        {
          style: { display: 'inline-flex', alignItems: 'center', gap: '4px', opacity: 0.75, cursor: 'pointer' },
          title: '打开后会把与同类实体直接相连的其他实体（如人物所属的组织）也画出来',
        },
        h('input', { type: 'checkbox', checked: includeOthers === true, onChange: (event) => onToggleOthers(event.target.checked) }),
        '含跨类关系',
      ),
      h(
        'span',
        { style: { opacity: 0.5 } },
        `${nodes.length} 个节点 · 当前成立 ${edges.length} 条 / 共 ${totalEdges} 条`,
      ),
    ),
    // Placement is its own document (`views/layout.json`) with its own save, kept
    // separate from the edges' save: moving a node must not mark the relationship
    // data dirty, and vice versa.
    manualCount > 0 || layoutDirty === true
      ? h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '11px', marginBottom: '8px' } },
          manualCount > 0
            ? h('span', { style: { opacity: 0.55 } }, `已手工摆位 ${manualCount} 个节点`)
            : null,
          manualCount > 0
            ? h('button', { type: 'button', style: { ...buttonStyle, padding: '1px 7px' }, onClick: onResetPositions }, '重置为自动布局')
            : null,
          layoutDirty === true
            ? h('span', { style: { color: '#e5a34b' } }, '摆位未保存')
            : null,
          layoutDirty === true
            ? h(
                'button',
                { type: 'button', style: { ...buttonStyle, padding: '1px 7px' }, disabled: layoutSaving === true, onClick: onSaveLayout },
                layoutSaving === true ? '保存中…' : '保存摆位',
              )
            : null,
          layoutDirty === true
            ? h('button', { type: 'button', style: { ...buttonStyle, padding: '1px 7px' }, onClick: onRevertLayout }, '还原摆位')
            : null,
        )
      : null,
    nodes.length === 0
      ? h(Note, { text: '还没有可入网的实体。先在「人物卡」或「组织树」里创建。' })
      : edges.length === 0
        ? h(Note, { text: '这些实体之间还没有关系。点「新建关系」，选起点、终点与类型。' })
        : h(RelationGraph, {
            nodes,
            edges,
            types,
            positions,
            width,
            height,
            selection,
            onSelect,
            svgRef,
            dragging,
            onNodePointerDown,
            onPointerMove,
            onPointerUp,
          }),
  )
}

function GraphBranch(props) {
  const { branch, root } = props
  const { state, update, save, reload, warnings } = useDocument(root, branch.doc)
  // Manual placement lives in its own document, so moving a node and editing an edge
  // are independent edits with independent saves.
  const layout = useDocument(root, 'views/layout.json')
  const nodeKinds = Array.isArray(branch.nodeKinds) ? branch.nodeKinds : ['character']
  const candidates = useRefOptions(root, [...nodeKinds, 'relation-type', 'timeline-event'])
  const calendar = useCalendar(root)
  const [selection, setSelection] = react.useState(null)
  const [detailOpen, setDetailOpen] = react.useState(true)
  // Same-kind only by default: the 人物 graph is about people. Widening it is a
  // deliberate question ("what is attached to these people?"), not the default.
  const [includeOthers, setIncludeOthers] = react.useState(false)
  // `null` means "as of the latest written moment" — every edge is in force.
  const [cursorKey, setCursorKey] = react.useState(null)
  // Drag state. `dragPoint` is an overlay only; nothing is written until release.
  const [dragging, setDragging] = react.useState(null)
  const [dragPoint, setDragPoint] = react.useState(null)
  const svgRef = react.useRef(null)

  const doc = state.value
  const types = objectList(doc?.types)
  const allEdges = objectList(doc?.edges)

  // Every entity the graph may join, tagged with its kind so the focus filter can
  // tell a character from an organization.
  const allNodes = nodeKinds.flatMap((kind) =>
    (candidates[kind] ?? []).map((option) => ({ id: option.id, title: option.title, kind })),
  )

  const activeEdges = edgesActiveAt(allEdges, cursorKey)
  const subgraph = visibleNetwork(allNodes, activeEdges, { focusKinds: branch.focusKinds, includeOthers })

  const WIDTH = 720
  const HEIGHT = 480
  const nodeKey = subgraph.nodes.map((node) => node.id).join('|')
  const edgeKey = subgraph.edges.map((edge) => `${edge.id}:${edge.from}:${edge.to}:${edge.type}`).join('|')
  const forcePositions = react.useMemo(
    () => layoutForce(subgraph.nodes, subgraph.edges, { width: WIDTH, height: HEIGHT }),
    [nodeKey, edgeKey],
  )

  const manual = layout.state.value?.graphs?.[GRAPH_LAYOUT_KEY]?.positions ?? {}
  const nodeIds = subgraph.nodes.map((node) => node.id)
  // The node being dragged is drawn from local state so the gesture stays
  // responsive; it joins the saved placement only on pointer release.
  const overlay = dragPoint === null ? manual : setManualPosition(manual, dragPoint.id, dragPoint.point)
  const positions = react.useMemo(
    () => mergePositions(forcePositions, overlay, nodeIds),
    [forcePositions, overlay, nodeKey],
  )

  const manualCount = countManualPositions(manual, nodeIds)

  const pointerToView = (event) => {
    const element = svgRef.current
    const rect = element !== null && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null
    const point = clientToViewBox({ clientX: event.clientX, clientY: event.clientY }, rect, WIDTH, HEIGHT)
    return point === null ? null : clampToBox(point, WIDTH, HEIGHT)
  }

  const onNodePointerDown = (id, event) => {
    // Without this the browser starts a text selection and the drag is cancelled.
    if (typeof event.preventDefault === 'function') event.preventDefault()
    setDragging(id)
    const point = pointerToView(event)
    if (point !== null) setDragPoint({ id, point })
  }

  const onPointerMove = (event) => {
    if (dragging === null) return
    const point = pointerToView(event)
    if (point !== null) setDragPoint({ id: dragging, point })
  }

  const onPointerUp = () => {
    if (dragging !== null && dragPoint !== null && dragPoint.id === dragging) {
      const moved = dragPoint.point
      layout.update((current) => ({
        ...(current ?? {}),
        graphs: {
          ...((current ?? {}).graphs ?? {}),
          [GRAPH_LAYOUT_KEY]: {
            positions: setManualPosition(
              ((current ?? {}).graphs ?? {})[GRAPH_LAYOUT_KEY]?.positions ?? {},
              dragging,
              moved,
            ),
          },
        },
      }))
    }
    setDragging(null)
    setDragPoint(null)
  }

  const resetPositions = () => {
    // Reads the CURRENT placements from the updater argument, not the `manual` captured
    // when this handler was created — otherwise a layout loaded in the meantime is
    // discarded, and in the other tab's placements along with it.
    layout.update((current) => {
      const graphs = (current ?? {}).graphs ?? {}
      return {
        ...(current ?? {}),
        graphs: {
          ...graphs,
          [GRAPH_LAYOUT_KEY]: {
            positions: clearManualPositions(graphs[GRAPH_LAYOUT_KEY]?.positions ?? {}, nodeIds),
          },
        },
      }
    })
  }

  if (isBlank(root)) return h(Note, { text: '先在上方选择一个项目。' })
  if (state.loading) return h(Note, { text: '载入中…' })
  if (doc === null) {
    if (state.code === 'document-missing') {
      return h(Note, { text: `${branch.doc} 不存在。点上方的「在此新建小说项目」创建项目文档。` })
    }
    return h(Note, { text: state.error ?? '文档不可用。', tone: 'error' })
  }

  const spec = selection === null ? null : entitySpecFor(branch, selection.entity)
  const currentEdge =
    selection !== null && selection.entity === 'relation-edge'
      ? allEdges.find((edge) => edge.id === selection.id) ?? null
      : null

  // The branch's own document wins over the registry copy, so unsaved type edits
  // are offered immediately.
  const refOptions = {
    ...candidates,
    'graph-node': allNodes.map((node) => ({ id: node.id, title: `${node.title}（${node.kind === 'organization' ? '组织' : node.kind === 'place' ? '地点' : '人物'}）` })),
    'relation-type': types.map((type) => ({ id: type.id, title: type.label || type.id })),
  }

  const patchEdge = (patch) => {
    update((current) => ({
      ...current,
      edges: objectList(current.edges).map((edge) => (edge.id === selection.id ? { ...edge, ...patch } : edge)),
    }))
  }

  const boundaryKeys = [
    ...new Set(
      allEdges
        .flatMap((edge) => [timeKey(edge.since), edge.until === null || edge.until === undefined ? null : timeKey(edge.until)])
        .filter((key) => key !== null),
    ),
  ].sort((a, b) => a - b)

  const stepCursor = (direction) => {
    if (boundaryKeys.length === 0) return
    if (cursorKey === null) {
      setCursorKey(boundaryKeys[boundaryKeys.length - 1])
      return
    }
    const at = boundaryKeys.indexOf(cursorKey)
    if (at === -1) {
      const next = boundaryKeys.find((key) => key > cursorKey)
      setCursorKey(direction > 0 ? next ?? cursorKey : cursorKey)
      return
    }
    const target = Math.max(0, Math.min(boundaryKeys.length - 1, at + direction))
    setCursorKey(boundaryKeys[target])
  }

  const addEdge = () => {
    const entity = ENTITIES['relation-edge']
    const blank = entity.blank()
    const taken = new Set(allEdges.map((edge) => edge.id))
    const id = mintId(entity.idPrefix, 'new', taken)
    update((current) => ({ ...current, edges: [...(current.edges ?? []), { id, ...blank }] }))
    setSelection({ entity: 'relation-edge', id })
  }

  const main = h(
    'div',
    null,
    h(
      BranchToolbar,
      null,
      h('span', { style: { fontSize: '12px', opacity: 0.55 } }, branch.doc),
      state.dirty ? h('span', { style: { fontSize: '12px', color: '#e5a34b' } }, '未保存') : null,
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, borderColor: state.dirty ? 'currentColor' : muted },
          disabled: !state.dirty || state.saving,
          onClick: save,
        },
        state.saving ? '保存中…' : '保存',
      ),
      h('button', { type: 'button', style: buttonStyle, disabled: !state.dirty, onClick: reload }, '还原'),
      // An edge joins two nodes, so with fewer than two there is nothing it could
      // connect; offering the button would only produce an unsaveable row.
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, opacity: allNodes.length < 2 ? 0.5 : 1 },
          disabled: allNodes.length < 2,
          title: allNodes.length < 2 ? '至少需要两个可入网的实体（人物或组织）' : '',
          onClick: addEdge,
        },
        '新建关系',
      ),
      h(
        'button',
        { type: 'button', style: { ...buttonStyle, marginLeft: 'auto' }, onClick: () => setDetailOpen((open) => !open) },
        detailOpen ? '收起详情' : '展开详情',
      ),
      state.savedAt !== null && !state.dirty
        ? h('span', { style: { fontSize: '12px', opacity: 0.5 } }, `已保存 ${state.savedAt}`)
        : null,
    ),

    // One implementation of the feedback block, shared with the tree and timeline
    // branches. This used to be hand-rolled here with a `!== null` check that
    // `undefined` slips past.
    h(WriteFeedback, { error: state.error, issues: state.issues, warnings }),

    h(GraphView, {
      nodes: subgraph.nodes,
      edges: subgraph.edges,
      types,
      calendar,
      cursorKey,
      onStep: stepCursor,
      onLatest: () => setCursorKey(null),
      totalEdges: allEdges.length,
      includeOthers,
      onToggleOthers: setIncludeOthers,
      selection,
      onSelect: setSelection,
      positions,
      width: WIDTH,
      height: HEIGHT,
      svgRef,
      dragging,
      onNodePointerDown,
      onPointerMove,
      onPointerUp,
      manualCount,
      onResetPositions: resetPositions,
      layoutDirty: layout.state.dirty,
      layoutSaving: layout.state.saving,
      onSaveLayout: layout.save,
      onRevertLayout: layout.reload,
    }),
  )

  let detail
  if (spec !== null && currentEdge !== null) {
    detail = h(
      'div',
      null,
      h(DetailHeading, null, '关系'),
      h('div', { style: { fontSize: '11px', opacity: 0.45, marginBottom: '12px' } }, currentEdge.id),
      h(SchemaForm, {
        entity: { fields: spec.fields },
        value: currentEdge,
        onPatch: patchEdge,
        refOptions,
      }),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, marginTop: '16px', color: '#e5534b', borderColor: muted },
          onClick: () => {
            update((current) => ({ ...current, edges: (current.edges ?? []).filter((edge) => edge.id !== selection.id) }))
            setSelection(null)
          },
        },
        '删除这条关系',
      ),
    )
  } else if (selection !== null && selection.entity === 'graph-node') {
    const node = allNodes.find((candidate) => candidate.id === selection.id) ?? null
    const touching = edgesTouching(activeEdges, selection.id)
    detail = h(
      'div',
      null,
      h(DetailHeading, null, node?.title ?? selection.id),
      h(
        'div',
        { style: { fontSize: '11px', opacity: 0.45, marginBottom: '10px' } },
        `${selection.id} · ${node?.kind === 'organization' ? '组织' : node?.kind === 'place' ? '地点' : '人物'}`,
      ),
      h('div', { style: { fontSize: '12px', opacity: 0.6, marginBottom: '6px' } }, `当前成立 ${touching.length} 条关系`),
      ...touching.map((edge) =>
        h(
          'div',
          {
            key: edge.id,
            style: { fontSize: '12px', lineHeight: 1.9, cursor: 'pointer' },
            onClick: () => setSelection({ entity: 'relation-edge', id: edge.id }),
          },
          `· ${edge.from === selection.id ? '→' : '←'} ${
            allNodes.find((candidate) => candidate.id === (edge.from === selection.id ? edge.to : edge.from))?.title ??
            (edge.from === selection.id ? edge.to : edge.from)
          }（${types.find((type) => type.id === edge.type)?.label ?? edge.type}）`,
        ),
      ),
      h(
        'div',
        { style: { marginTop: '14px', fontSize: '11px', opacity: 0.45, lineHeight: 1.7 } },
        '节点本身在这里只读：编辑人物或组织请到对应分支的卡片页签，改完刷新即可。',
      ),
    )
  } else {
    detail = h(Note, {
      text:
        allEdges.length === 0
          ? '点「新建关系」，选择起点、终点与类型。关系可以带起止时间——这正是时间游标的用处。'
          : '点网络里的节点或关系连线即可查看与编辑。虚线表示无方向的关系。',
    })
  }

  return h(SplitPane, { main, detail, open: detailOpen })
}

function BranchRouter(props) {
  const { branch, root } = props
  if (branch.view === 'tabs') return h(TabsBranch, { branch, root })
  if (branch.view === 'tree') return h(EntityTreeBranch, { branch, root })
  if (branch.view === 'timeline') return h(TimelineBranch, { branch, root })
  if (branch.view === 'graph') return h(GraphBranch, { branch, root })
  if (branch.view === 'map') return h(MapBranch, { root })
  if (branch.view === 'chapters') return h(ChapterBranch, { root })
  return h(PlannedBranch, { branch })
}
