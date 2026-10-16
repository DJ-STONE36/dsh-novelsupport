/**
 * RelationGraph — the relationship network over `relations.json`.
 *
 * Two things make this more than a drawing:
 *
 *   - **Time.** Edge intervals are the model's whole point (docs/data-model.md
 *     §4.8): "who is allied with whom" is only answerable relative to a moment, so
 *     the view carries a cursor and shows only the relations in force at it.
 *     Everything at or before the cursor is real; later ones are not yet.
 *
 *   - **Determinism.** The layout is a pure function of its inputs — no random
 *     seed, no animation loop, no DOM measurement — so the same data always draws
 *     the same picture and the suite can assert on it. A physics loop that
 *     measured the DOM could not be tested outside a browser, which is exactly how
 *     earlier layout bugs reached the user.
 *
 * `timeKey` and its helpers are shared with `50-timeline.js` (same closure, so no
 * import), and `client-selftest.mjs` cross-checks them against the host's copy.
 */

/**
 * The edges in force at a moment.
 *
 * `since` is inclusive and `until` exclusive, so an edge ending exactly when
 * another begins leaves no gap and no overlap — the handover convention the
 * validator enforces.
 */
function edgesActiveAt(edges, cursorKey) {
  if (cursorKey === null || cursorKey === undefined) return edges
  return edges.filter((edge) => {
    const start = timeKey(edge.since)
    // An unusable `since` keeps the edge visible rather than silently dropping it:
    // hiding data because it is malformed makes the malformation unfindable.
    if (start !== null && start > cursorKey) return false
    const end = edge.until === null || edge.until === undefined ? null : timeKey(edge.until)
    if (end === null) return true
    return cursorKey < end
  })
}

/**
 * The part of the network a view should draw.
 *
 * Defaults to the focus kinds ALONE — the 人物 graph is about people, the 组织
 * graph is about organizations. An earlier version instead kept every node kind
 * and only filtered which *edges* to show, so a neighbour dragged organizations
 * and places into the character graph: the view was centred on people but its
 * contents were whatever happened to be attached.
 *
 * `includeOthers` widens it to the focus kinds plus everything directly joined to
 * them, which is how a membership (`人物 —隶属→ 组织`) becomes visible. Off by
 * default, because that is a different question from "who relates to whom".
 *
 * An edge is only drawn when BOTH ends are present: an edge to a node the view
 * excludes cannot be placed, and counting it would misreport the totals.
 */
function visibleNetwork(nodes, edges, options = {}) {
  const focusKinds = Array.isArray(options.focusKinds) ? options.focusKinds : []
  const includeOthers = options.includeOthers === true

  const focusNodes = focusKinds.length === 0 ? nodes : nodes.filter((node) => focusKinds.includes(node.kind))
  const focusIds = new Set(focusNodes.map((node) => node.id))

  const touching = edges.filter((edge) => focusIds.has(edge.from) || focusIds.has(edge.to))
  const keepIds = new Set(focusIds)
  if (includeOthers) {
    for (const edge of touching) {
      keepIds.add(edge.from)
      keepIds.add(edge.to)
    }
  }

  const keptNodes = nodes.filter((node) => keepIds.has(node.id))
  const keptEdges = edges.filter((edge) => keepIds.has(edge.from) && keepIds.has(edge.to))
  return { nodes: keptNodes, edges: keptEdges }
}

/**
 * Force-directed layout, deterministic and self-contained.
 *
 * Fruchterman–Reingold in spirit: every pair repels, every edge pulls, and a
 * cooling schedule bounds how far a node may move per step. Nodes start on a
 * circle in input order, which is what makes the result reproducible — a random
 * start would draw a different picture on every render and make the output
 * untestable.
 *
 * Iterations scale down with node count, because the repulsion pass is O(n²):
 * a few hundred steps for a handful of characters, a few dozen for a saga, where
 * the layout is approximate anyway and responsiveness matters more.
 */
function layoutForce(nodes, edges, options = {}) {
  const width = options.width ?? 720
  const height = options.height ?? 480
  const count = nodes.length
  const positions = new Map()
  if (count === 0) return positions
  if (count === 1) {
    positions.set(nodes[0].id, { x: width / 2, y: height / 2 })
    return positions
  }

  const iterations = options.iterations ?? Math.max(60, Math.min(300, Math.round(6000 / count)))
  const area = width * height
  const k = Math.sqrt(area / count)
  const radius = Math.min(width, height) * 0.32

  nodes.forEach((node, index) => {
    const angle = (index / count) * Math.PI * 2
    positions.set(node.id, {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    })
  })

  const ids = nodes.map((node) => node.id)
  const links = edges
    .map((edge) => ({ from: edge.from, to: edge.to }))
    .filter((link) => positions.has(link.from) && positions.has(link.to) && link.from !== link.to)

  const margin = 26
  let temperature = Math.min(width, height) * 0.1

  for (let step = 0; step < iterations; step += 1) {
    const disp = new Map(ids.map((id) => [id, { x: 0, y: 0 }]))

    // Repulsion between every pair.
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions.get(ids[i])
        const b = positions.get(ids[j])
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distance = Math.hypot(dx, dy)
        if (distance < 0.01) {
          // Coincident nodes would divide by zero; nudge deterministically.
          dx = (i - j) * 0.01
          dy = 0.01
          distance = Math.hypot(dx, dy)
        }
        const force = (k * k) / distance
        const ux = (dx / distance) * force
        const uy = (dy / distance) * force
        const da = disp.get(ids[i])
        const db = disp.get(ids[j])
        da.x += ux
        da.y += uy
        db.x -= ux
        db.y -= uy
      }
    }

    // Attraction along edges.
    for (const link of links) {
      const a = positions.get(link.from)
      const b = positions.get(link.to)
      const dx = a.x - b.x
      const dy = a.y - b.y
      const distance = Math.max(0.01, Math.hypot(dx, dy))
      const force = (distance * distance) / k
      const ux = (dx / distance) * force
      const uy = (dy / distance) * force
      const da = disp.get(link.from)
      const db = disp.get(link.to)
      da.x -= ux
      da.y -= uy
      db.x += ux
      db.y += uy
    }

    for (const id of ids) {
      const point = positions.get(id)
      const delta = disp.get(id)
      const length = Math.max(0.01, Math.hypot(delta.x, delta.y))
      const limited = Math.min(length, temperature)
      point.x += (delta.x / length) * limited
      point.y += (delta.y / length) * limited
      point.x = Math.max(margin, Math.min(width - margin, point.x))
      point.y = Math.max(margin, Math.min(height - margin, point.y))
    }

    temperature *= 0.97
  }

  return positions
}

/** Incident edges for a node, for the read-only node summary. */
function edgesTouching(edges, nodeId) {
  return edges.filter((edge) => edge.from === nodeId || edge.to === nodeId)
}

/**
 * The key under which the relationship network's manual positions are stored in
 * `views/layout.json` (`{ graphs: { relations: { positions: { id: {x,y} } } } }`).
 *
 * One key for both the 人物 and 组织 tabs: positions belong to NODES, and the two
 * tabs show overlapping sets of the same nodes. Per-tab keys would let the same
 * person sit in two places.
 */
const GRAPH_LAYOUT_KEY = 'relations'

/**
 * Convert a pointer position into SVG viewBox coordinates.
 *
 * Pure, and separated out on purpose: the ONE part of dragging that cannot be
 * tested is reading the element's rectangle, because `renderToString` has no
 * layout. Keeping the arithmetic here means the arithmetic is still verified, and
 * only the measurement is taken on faith.
 */
function clientToViewBox(point, rect, width, height) {
  if (rect === null || rect === undefined || rect.width === 0 || rect.height === 0) return null
  const x = ((point.clientX - rect.left) / rect.width) * width
  const y = ((point.clientY - rect.top) / rect.height) * height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/** Keep a dragged node inside the canvas, so it cannot be lost off-screen. */
function clampToBox(point, width, height, margin = 14) {
  // `Math.min`/`Math.max` propagate NaN, and `JSON.stringify` turns NaN into null — so a
  // NaN placement was written, then rejected on reload, losing it with no explanation.
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return { x: width / 2, y: height / 2 }
  return {
    x: Math.max(margin, Math.min(width - margin, point.x)),
    y: Math.max(margin, Math.min(height - margin, point.y)),
  }
}

/**
 * Final positions: a manual placement wins over the computed layout.
 *
 * Nodes without a manual position keep their force-layout place, so dropping one
 * node does not disturb the rest — which is the whole reason to move one by hand.
 */
function mergePositions(forcePositions, manual, nodeIds) {
  const merged = new Map()
  const placed = manual !== null && typeof manual === 'object' ? manual : {}
  for (const id of nodeIds) {
    const override = placed[id]
    const usable =
      override !== null &&
      override !== undefined &&
      Number.isFinite(override.x) &&
      Number.isFinite(override.y)
    const point = usable ? { x: override.x, y: override.y } : forcePositions.get(id)
    if (point !== undefined) merged.set(id, point)
  }
  return merged
}

/** Record a manual placement, dropping anything unusable. */
function setManualPosition(manual, nodeId, point) {
  const placed = manual !== null && typeof manual === 'object' ? manual : {}
  if (point === null || point === undefined || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return placed
  }
  return { ...placed, [nodeId]: { x: point.x, y: point.y } }
}

/**
 * Forget the manual placements for the given nodes, leaving other nodes' alone.
 *
 * The graph is shown one focus at a time, so "reset" must not silently throw away
 * placements made in the other tab.
 */
function clearManualPositions(manual, nodeIds) {
  const placed = manual !== null && typeof manual === 'object' ? manual : {}
  const next = { ...placed }
  for (const id of nodeIds) delete next[id]
  return next
}

/** How many of the given nodes have a manual placement. */
function countManualPositions(manual, nodeIds) {
  const placed = manual !== null && typeof manual === 'object' ? manual : {}
  let count = 0
  for (const id of nodeIds) {
    const point = placed[id]
    if (point !== null && point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y)) count += 1
  }
  return count
}

/**
 * @param nodes - `{ id, title, kind }`.
 * @param edges - raw edges from `relations.json`.
 * @param types - the document's type registry, for labels and direction.
 */
function RelationGraph(props) {
  const {
    types, positions, width, height, selection, onSelect,
    svgRef, dragging, onNodePointerDown, onPointerMove, onPointerUp,
  } = props
  // Guarded here as well as at the call site: a component that only survives when its
  // caller pre-filters is one refactor away from taking the panel down again.
  const nodes = objectList(props.nodes)
  const edges = objectList(props.edges)
  const typeById = new Map(objectList(types).map((type) => [type.id, type]))
  const titleOf = new Map(nodes.map((node) => [node.id, node.title]))
  const selectedEdge = selection !== null && selection.entity === 'relation-edge' ? selection.id : null
  const selectedNode = selection !== null && selection.entity === 'graph-node' ? selection.id : null

  return h(
    'svg',
    {
      ref: svgRef,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': `关系网：${nodes.length} 个节点，${edges.length} 条关系`,
      onPointerMove,
      onPointerUp,
      // Leaving the canvas must end the drag, or the node would keep following the
      // pointer after the button was released outside it.
      onPointerLeave: onPointerUp,
      style: {
        width: '100%',
        height: 'auto',
        maxHeight: '70vh',
        color: 'inherit',
        background: 'transparent',
        // Without this a drag scrolls the pane on touch devices instead of moving
        // the node.
        touchAction: 'none',
      },
    },
    ...edges.map((edge) => {
      const a = positions.get(edge.from)
      const b = positions.get(edge.to)
      if (a === undefined || b === undefined) return null
      const type = typeById.get(edge.type)
      const active = edge.id === selectedEdge
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      return h(
        'g',
        { key: edge.id },
        h('line', {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          stroke: 'currentColor',
          strokeWidth: active ? 2.4 : 1.2,
          // Undirected types are dashed, so the graph says which relations have a
          // direction without needing a legend.
          strokeDasharray: type?.directed === false ? '5 4' : undefined,
          opacity: active ? 0.95 : 0.4,
        }),
        h(
          'text',
          {
            x: midX,
            y: midY - 4,
            fontSize: 10,
            textAnchor: 'middle',
            fill: 'currentColor',
            opacity: active ? 0.95 : 0.55,
          },
          type?.label ?? edge.type,
        ),
        // A line is a hard click target; this transparent disc at the midpoint is
        // what actually opens the edge.
        h('circle', {
          cx: midX,
          cy: midY,
          r: 9,
          fill: 'transparent',
          style: { cursor: 'pointer' },
          onClick: () => onSelect({ entity: 'relation-edge', id: edge.id }),
        }),
        h('title', null, `${titleOf.get(edge.from) ?? edge.from} — ${titleOf.get(edge.to) ?? edge.to}：${type?.label ?? edge.type}`),
      )
    }),
    ...nodes.map((node) => {
      const point = positions.get(node.id)
      if (point === undefined) return null
      const active = node.id === selectedNode
      const held = node.id === dragging
      return h(
        'g',
        {
          key: node.id,
          style: { cursor: held === true ? 'grabbing' : 'grab' },
          onClick: () => onSelect({ entity: 'graph-node', id: node.id }),
          onPointerDown: (event) => onNodePointerDown(node.id, event),
        },
        // A generous invisible disc under the visible one: the label sits below the
        // circle, and a 12px target is not comfortable to grab.
        h('circle', { cx: point.x, cy: point.y, r: 16, fill: 'transparent' }),
        h('circle', {
          cx: point.x,
          cy: point.y,
          r: active ? 15 : 12,
          fill: held === true ? 'currentColor' : 'transparent',
          fillOpacity: held === true ? 0.25 : 0,
          stroke: 'currentColor',
          strokeWidth: active ? 2.4 : 1.2,
          opacity: active ? 1 : 0.75,
        }),
        h(
          'text',
          {
            x: point.x,
            y: point.y + 26,
            fontSize: 11,
            textAnchor: 'middle',
            fill: 'currentColor',
            // Organizations are square-ish in prose but here they are marked by
            // weight: distinguishing node kinds by shape would need a legend.
            fontWeight: node.kind === 'organization' ? 600 : 400,
          },
          node.title,
        ),
      )
    }),
  )
}
