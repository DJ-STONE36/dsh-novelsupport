/**
 * EntityTree — a forest of groups with leaves hanging off them.
 *
 * Generic over the descriptor: `tree.groups` are joined into a forest by their
 * `parentKey` and `tree.leaves` attach to a group by theirs, so the component
 * never learns what an "item" or a "category" is. That is what lets 人物/组织 later
 * reuse it with a different descriptor instead of a second tree implementation.
 *
 * Selection is reported as `{ entity, id }` — the entity kind, not just an id —
 * because the detail pane has to pick a schema, and an id alone cannot say
 * whether it names a category or an item.
 */

/** Index a document against its tree descriptor. */
function indexTree(doc, tree) {
  const groupSpec = tree.groups[0]
  // A groups-only forest is legitimate — outline nodes nest by `parentId` and
  // have no leaf collection — so the leaf spec is optional rather than required.
  const leafSpec = Array.isArray(tree.leaves) && tree.leaves.length > 0 ? tree.leaves[0] : null
  // `objectList`, not `Array.isArray ? x : []`: a hand-edited file with a null or a
  // string in the list passes the container check and then crashes every read below.
  const groups = objectList(doc[groupSpec.key])
  const leaves = leafSpec === null ? [] : objectList(doc[leafSpec.key])

  const groupChildren = new Map()
  for (const group of groups) {
    const parent = group[groupSpec.parentKey] ?? null
    if (!groupChildren.has(parent)) groupChildren.set(parent, [])
    groupChildren.get(parent).push(group)
  }
  const leavesByGroup = new Map()
  for (const leaf of leaves) {
    const parent = leaf[leafSpec.parentKey] ?? null
    if (!leavesByGroup.has(parent)) leavesByGroup.set(parent, [])
    leavesByGroup.get(parent).push(leaf)
  }

  const byOrder = (a, b) => (Number(a.order ?? 0) - Number(b.order ?? 0)) || String(a.id).localeCompare(String(b.id))
  for (const list of groupChildren.values()) list.sort(byOrder)
  for (const list of leavesByGroup.values()) list.sort(byOrder)

  return { groupSpec, leafSpec, groups, leaves, groupChildren, leavesByGroup }
}

function TreeRow(props) {
  const { depth, title, badge, selected, hasChildren, expanded, onToggle, onClick, dim } = props
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        paddingLeft: `${8 + depth * 14}px`,
        borderRadius: '6px',
        fontSize: '13px',
        cursor: 'pointer',
        background: selected ? 'rgba(128,128,128,0.16)' : 'transparent',
        opacity: dim ? 0.6 : 1,
      },
      onClick,
    },
    hasChildren
      ? h(
          'span',
          {
            style: { width: '12px', display: 'inline-block', opacity: 0.6, userSelect: 'none' },
            onClick: (event) => {
              event.stopPropagation()
              onToggle()
            },
          },
          expanded ? '▾' : '▸',
        )
      : h('span', { style: { width: '12px', display: 'inline-block' } }),
    h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
    badge !== undefined && badge !== null ? h('span', { style: { fontSize: '11px', opacity: 0.45 } }, badge) : null,
  )
}

/**
 * @param doc - the whole document (e.g. `setting/items.json`).
 * @param tree - the branch's `tree` descriptor.
 * @param selection - `{ entity, id }` or null.
 * @param onSelect - called with `{ entity, id }`.
 * @param onMutate - receives a pure transform of the document.
 */
/**
 * Whether a spec says which field holds the parent.
 *
 * Nesting is only offered when it does. Without this, the "new child" action would
 * append a node with no parent link — it would look like it worked and then appear
 * at the top level.
 */
function supportsNesting(spec) {
  return spec !== null && spec !== undefined && typeof spec.parentKey === 'string' && spec.parentKey !== ''
}

/**
 * The node a "new child" action should append.
 *
 * Pure, and it guards a real trap: the parent link is written as
 * `created[spec.parentKey] = parentId`. A spec declaring no `parentKey` would
 * therefore write a key literally named `undefined` — harmless only as long as every
 * spec happened to declare one, and silently corrupting the document the moment one
 * did not.
 */
function childNodeFor(spec, entity, parentId, taken) {
  const blank = entity.blank()
  const id = mintId(spec.idPrefix ?? entity.idPrefix, blank.name ?? blank.title ?? 'entry', taken)
  const created = { id, ...blank }
  if (supportsNesting(spec)) {
    // Explicit `null` for a root, not an absent key: `JSON.stringify` drops
    // `undefined`, so the field would vanish from the file and "at the top level"
    // would be indistinguishable from "field not written". The documented shape
    // shows `"parentId": null`.
    created[spec.parentKey] = parentId === undefined ? null : parentId
  }
  return created
}

/**
 * The tree half: groups and their leaves.
 *
 * Split out of `EntityTree` so a branch may declare flat `collections` beside its
 * tree, or instead of one. `taken` is passed in because ids must not collide
 * across a branch's lists, not merely within one of them.
 */
function TreePane(props) {
  const { doc, tree, selection, onSelect, onMutate, taken } = props
  const [collapsed, setCollapsed] = react.useState(() => new Set())
  const index = indexTree(doc, tree)
  const { groupSpec, leafSpec, groupChildren, leavesByGroup } = index

  const toggle = (id) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const isSelected = (entity, id) => selection !== null && selection.entity === entity && selection.id === id

  const addGroup = (parentId) => {
    const created = childNodeFor(groupSpec, ENTITIES[groupSpec.entity], parentId, taken)
    onMutate((current) => ({
      ...current,
      [groupSpec.key]: [...(current[groupSpec.key] ?? []), created],
    }))
    onSelect({ entity: groupSpec.entity, id: created.id })
  }

  const addLeaf = (groupId) => {
    if (leafSpec === null) return
    const created = childNodeFor(leafSpec, ENTITIES[leafSpec.entity], groupId, taken)
    onMutate((current) => ({
      ...current,
      [leafSpec.key]: [...(current[leafSpec.key] ?? []), created],
    }))
    onSelect({ entity: leafSpec.entity, id: created.id })
  }

  const renderGroup = (group, depth) => {
    const children = groupChildren.get(group.id) ?? []
    const leaves = leavesByGroup.get(group.id) ?? []
    const hasChildren = children.length > 0 || leaves.length > 0
    const expanded = !collapsed.has(group.id)
    return h(
      react.Fragment,
      { key: group.id },
      h(TreeRow, {
        depth,
        title: ENTITIES[groupSpec.entity].titleOf(group),
        badge: leaves.length > 0 ? leaves.length : null,
        selected: isSelected(groupSpec.entity, group.id),
        hasChildren,
        expanded,
        onToggle: () => toggle(group.id),
        onClick: () => onSelect({ entity: groupSpec.entity, id: group.id }),
      }),
      expanded
        ? h(
            react.Fragment,
            null,
            ...children.map((child) => renderGroup(child, depth + 1)),
            ...leaves.map((leaf) =>
              h(TreeRow, {
                key: leaf.id,
                depth: depth + 1,
                title: ENTITIES[leafSpec.entity].titleOf(leaf),
                selected: isSelected(leafSpec.entity, leaf.id),
                hasChildren: false,
                dim: true,
                onClick: () => onSelect({ entity: leafSpec.entity, id: leaf.id }),
              }),
            ),
          )
        : null,
    )
  }

  const roots = groupChildren.get(null) ?? []
  const orphanLeaves = leavesByGroup.get(null) ?? []
  const selectedGroupId =
    selection !== null && selection.entity === groupSpec.entity ? selection.id : null

  return h(
    'div',
    null,
    h(
      'div',
      { style: { display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' } },
      h('button', { type: 'button', style: buttonStyle, onClick: () => addGroup(null) }, `新建${groupSpec.label}`),
      // Nesting was supported by the data model and by the renderer, but there was no
      // control to create a child — so a sub-category, a sub-place, a sub-organization
      // or a subordinate position could not be created in ANY branch. One button
      // fixes all of them, because they all walk this component.
      supportsNesting(groupSpec)
        ? h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle, opacity: selectedGroupId === null ? 0.5 : 1 },
              disabled: selectedGroupId === null,
              title: selectedGroupId === null ? `先在列表里选中一个上级${groupSpec.label}` : '',
              onClick: () => addGroup(selectedGroupId),
            },
            selectedGroupId === null ? `在选中${groupSpec.label}下新建` : `在选中${groupSpec.label}下新建下级`,
          )
        : null,
      leafSpec === null
        ? null
        : h(
            'button',
            { type: 'button', style: buttonStyle, onClick: () => addLeaf(selectedGroupId) },
            selectedGroupId === null ? `新建${leafSpec.label}（未归类）` : `在选中分类下新建${leafSpec.label}`,
          ),
    ),
    roots.length === 0 && orphanLeaves.length === 0
      ? h(Note, { text: `还没有${groupSpec.label}。${leafSpec === null ? '' : '先建一个分类，再往里添加。'}` })
      : h(
          'div',
          null,
          ...roots.map((group) => renderGroup(group, 0)),
          ...orphanLeaves.map((leaf) =>
            h(TreeRow, {
              key: leaf.id,
              depth: 0,
              title: ENTITIES[leafSpec.entity].titleOf(leaf),
              selected: isSelected(leafSpec.entity, leaf.id),
              hasChildren: false,
              dim: true,
              onClick: () => onSelect({ entity: leafSpec.entity, id: leaf.id }),
            }),
          ),
        ),
  )
}

/**
 * A flat collection: a heading, a count, an add button, and one row per entity.
 *
 * This is what makes a branch's `collections` declaration real. They previously
 * only fed the detail-pane lookup, so a descriptor could promise a list that no
 * view ever drew — a silent trap for the next entity kind.
 */
function CollectionPane(props) {
  const { doc, spec, selection, onSelect, onMutate, taken } = props
  const entity = ENTITIES[spec.entity]
  const label = spec.label ?? entity.label
  const list = objectList(doc[spec.key])
  const sorted = [...list].sort(
    (a, b) => (Number(a.order ?? 0) - Number(b.order ?? 0)) || String(a.id).localeCompare(String(b.id)),
  )

  const add = () => {
    const blank = entity.blank()
    const id = mintId(spec.idPrefix ?? entity.idPrefix, blank.name ?? blank.title ?? 'entry', taken)
    onMutate((current) => ({ ...current, [spec.key]: [...(current[spec.key] ?? []), { id, ...blank }] }))
    onSelect({ entity: spec.entity, id })
  }

  return h(
    'div',
    { style: { marginBottom: '12px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
      h('span', { style: { fontSize: '11px', opacity: 0.5 } }, `${label}（${list.length}）`),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, padding: '1px 7px', fontSize: '11px' },
          title: `新建${label}`,
          onClick: add,
        },
        '＋',
      ),
    ),
    sorted.length === 0
      ? h(Note, { text: `还没有${label}。` })
      : h(
          'div',
          null,
          ...sorted.map((entry) =>
            h(TreeRow, {
              key: entry.id,
              depth: 0,
              title: entity.titleOf(entry),
              selected: selection !== null && selection.entity === spec.entity && selection.id === entry.id,
              hasChildren: false,
              onClick: () => onSelect({ entity: spec.entity, id: entry.id }),
            }),
          ),
        ),
  )
}

/**
 * Remove a position and everything beneath it.
 *
 * Pure, and separated out because the subtle part is the subtree: deleting only the
 * node would leave children whose `parentId` points at nothing, which the tree
 * cannot place and the validator reports as a dangling reference.
 */
function removePositionSubtree(positions, id) {
  const list = objectList(positions)
  const doomed = new Set([id])
  // Repeat until no new descendants are found: a single pass would miss a
  // grandchild whose parent was added later in the same loop.
  let grew = true
  while (grew) {
    grew = false
    for (const position of list) {
      if (doomed.has(position.parentId) && !doomed.has(position.id)) {
        doomed.add(position.id)
        grew = true
      }
    }
  }
  return list.filter((position) => !doomed.has(position.id))
}

/** The selected position's fields plus a delete control. */
function PositionEditor(props) {
  const { position, onPatch, onRemove } = props
  return h(
    'div',
    { style: { marginTop: '10px', borderTop: `1px solid ${muted}`, paddingTop: '10px' } },
    h(SchemaForm, {
      entity: { fields: ENTITIES['org-position'].fields },
      value: position,
      onPatch,
    }),
    h(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, marginTop: '10px', color: '#e5534b', borderColor: muted },
        onClick: onRemove,
      },
      '删除这个职位（含下属）',
    ),
  )
}

/**
 * Editor for an array that self-nests by `parentId` — an organization's positions.
 *
 * It reuses `TreePane` by handing it a synthetic one-collection document, because
 * `structure` has exactly the shape `TreePane` already walks: a flat array plus a
 * parent key. Writing a second tree would have meant a second place to get
 * add/indent/order wrong.
 *
 * The only thing `TreePane` does not do is delete: at the branch level, deletion
 * lives in the detail pane's form. Here the selected position gets its own small
 * form and a delete control, so nothing has to be removed by editing JSON.
 */
function StructureInput(props) {
  const { value, onChange } = props
  const [selectedId, setSelectedId] = react.useState(null)
  const positions = objectList(value)
  const doc = { positions }
  const tree = {
    groups: [{ key: 'positions', entity: 'org-position', parentKey: 'parentId', label: '职位', idPrefix: 'pos-' }],
    leaves: [],
  }
  const selected = positions.find((position) => position.id === selectedId) ?? null
  const taken = new Set(positions.map((position) => position.id))

  // TreePane mutates a document; this field owns only the array inside it.
  const mutate = (mutator) => {
    const next = mutator(doc)
    onChange(Array.isArray(next.positions) ? next.positions : [])
  }

  const patchSelected = (patch) => {
    if (selected === null) return
    mutate((current) => ({
      positions: current.positions.map((position) =>
        position.id === selected.id ? { ...position, ...patch } : position,
      ),
    }))
  }

  const removeSelected = () => {
    if (selected === null) return
    mutate((current) => ({ positions: removePositionSubtree(current.positions, selected.id) }))
    setSelectedId(null)
  }

  return h(
    'div',
    null,
    h(TreePane, {
      doc,
      tree,
      selection: selectedId === null ? null : { entity: 'org-position', id: selectedId },
      onSelect: (next) => setSelectedId(next === null ? null : next.id),
      onMutate: mutate,
      taken,
    }),
    selected === null
      ? h(
          'div',
          { style: { marginTop: '8px', fontSize: '11px', opacity: 0.45, lineHeight: 1.7 } },
          '选中一个职位可改名、调序或删除。任职者用「关系网」里的成员关系表示——职位定义与任职是两件事，各只有一个真相源。',
        )
      : h(PositionEditor, { position: selected, onPatch: patchSelected, onRemove: removeSelected }),
  )
}

/**
 * The entity tree for a branch: its hierarchy and/or its flat collections.
 *
 * @param tree - optional; a branch may declare only `collections`.
 * @param collections - `[{ key, entity, label, idPrefix }]`.
 */
function EntityTree(props) {
  const { doc, tree, collections, selection, onSelect, onMutate } = props
  const lists = Array.isArray(collections) ? collections : []
  const hasTree = tree !== undefined && tree !== null && Array.isArray(tree.groups) && tree.groups.length > 0

  // Ids already in use anywhere in this branch, so a minted id cannot collide
  // with a sibling collection.
  const taken = react.useMemo(() => {
    const set = new Set()
    if (hasTree) {
      const index = indexTree(doc, tree)
      for (const group of index.groups) set.add(group.id)
      for (const leaf of index.leaves) set.add(leaf.id)
    }
    for (const spec of lists) {
      for (const entry of objectList(doc[spec.key])) set.add(entry.id)
    }
    return set
  }, [doc, tree, collections])

  return h(
    'div',
    null,
    hasTree ? h(TreePane, { doc, tree, selection, onSelect, onMutate, taken }) : null,
    ...lists.map((spec) =>
      h(CollectionPane, { key: spec.key, doc, spec, selection, onSelect, onMutate, taken }),
    ),
  )
}
