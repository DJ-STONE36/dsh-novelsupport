/**
 * TimelineView — in-world time along a horizontal axis, one lane per timeline.
 *
 * The axis is proportional to `timeKey`, so an event's position reflects how far
 * into the story's history it happens rather than how early it was written.
 *
 * Two things make this more than a row of labels:
 *
 *   - **The time cursor.** Relationships and events are time-varying
 *     (docs/data-model.md §4.8), so "what is true" is only answerable relative to
 *     a moment. The cursor marks that moment; events at or before it are solid,
 *     later ones dimmed; stepping walks the story. Without it the view could only
 *     draw "now", which a thousand-year calendar does not define.
 *
 *   - **Vertical stacking.** Events are positioned by time, so three events in
 *     the same year land on the same pixel and hide each other. Chips are
 *     therefore laid out in rows alternating above and below the axis line.
 *
 * `timeKey` is duplicated from the host's `validate.js` — the two halves are
 * separate bundles with no shared import path. `client-selftest.mjs` cross-checks
 * the copies on the same inputs so they cannot drift silently.
 */

/**
 * Coerce an optional numeric field, treating null/blank/boolean/object as absent.
 *
 * `Number(null)` is `0`, so coercing blindly reads a cleared year as year 0 —
 * silently teleporting an event to the start of history rather than treating it
 * as unset. Kept in step with the host's `validate.js` by a cross-check test.
 */
function optionalNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'object') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** `{year,month,day}` → a sortable integer, or null when the time is unusable.
 *
 * Must stay byte-for-byte equivalent to the host's copy in `lib/impl/validate.js`: the two
 * are cross-checked by a test, so a change here without the same change there fails loudly.
 * An out-of-range month or day makes the whole time unusable rather than encoding into a key
 * that sorts as a different date (`month: 0` used to sort before January).
 */
function timeKey(time) {
  if (time === null || time === undefined || typeof time !== 'object' || Array.isArray(time)) return null
  const year = optionalNumber(time.year)
  if (year === null) return null
  const month = optionalNumber(time.month)
  const day = optionalNumber(time.day)
  if (month !== null && (month < 1 || month > 12)) return null
  if (day !== null && (day < 1 || day > 31)) return null
  return year * 10000 + (month ?? 0) * 100 + (day ?? 0)
}

/** The inverse of `timeKey`, for display. */
function timeKeyParts(key) {
  return { year: Math.floor(key / 10000), month: Math.floor(key / 100) % 100, day: key % 100 }
}

/** Render a key in the project's own calendar, e.g. 「创世历 1345 年 3 月 2 日」. */
function formatTimeKey(calendar, key) {
  if (key === null) return '—'
  const { year, month, day } = timeKeyParts(key)
  const parts = [`${year} 年`]
  if (month > 0) parts.push(`${month} 月`)
  if (day > 0) parts.push(`${day} 日`)
  const epoch = calendar?.epochLabel ? `${calendar.epochLabel} ` : ''
  return `${epoch}${parts.join(' ')}`
}

/**
 * Whether an event lies after the cursor — i.e. has not happened yet as of it.
 *
 * Named and exported rather than inlined because it is the whole meaning of the
 * cursor: everything at or before it is true, everything after is the future.
 */
function isAfterCursor(cursorKey, event) {
  const key = timeKey(event?.at)
  if (key === null || cursorKey === null || cursorKey === undefined) return false
  return key > cursorKey
}

/**
 * Horizontal gutter reserved at each end of the axis, in pixels.
 *
 * Event chips are centred on their moment (`translateX(-50%)`), so a chip at 0%
 * or 100% would put half of itself outside the scroll container and be clipped —
 * the label at either end of the timeline becomes unreadable exactly where the
 * story starts and ends. Positions are mapped into an inset region instead.
 * The value must exceed half the widest chip (see `CHIP_MAX_WIDTH`).
 */
const GUTTER_PX = 58
const CHIP_MAX_WIDTH = 110
const CHIP_HEIGHT = 20
/** Vertical distance between stacking rows. */
const ROW_HEIGHT = 24

/**
 * Two chips share a row only if they are at least this far apart, as a fraction
 * of the axis width.
 *
 * Deliberately NOT measured from the DOM: measuring needs a ref, an effect and a
 * layout pass, which cannot be tested outside a browser — and an untestable
 * layout rule is how the edge-clipping bug survived. A fraction threshold is
 * approximate but deterministic, and `assignRows` is a pure function the suite
 * can pin down. ~14% keeps the widest chip (110px) clear of its neighbour on a
 * panel around 800px wide, which is the common case.
 */
const ROW_SEPARATION = 0.14

/** CSS `left` for a 0..1 position, inside the gutters. */
function axisLeft(fraction) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  return `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX * 2}px) * ${clamped})`
}

/**
 * Assign each position a stacking row so nearby chips do not overlap.
 *
 * Greedy first-fit over positions sorted by time: each chip takes the first row
 * whose last chip is far enough to the left, opening a new row only when none
 * fits. Greedy is enough here — a timeline lane holds tens of events, and the
 * alternative (optimal interval partitioning) would only ever save a row in
 * contrived cases.
 *
 * @param fractions - positions as 0..1, in their original order.
 * @returns `{ rowOf, rowCount }` where `rowOf[i]` is the row for `fractions[i]`.
 */
function assignRows(fractions, minSeparation = ROW_SEPARATION) {
  const sorted = fractions
    .map((fraction, index) => ({ fraction, index }))
    .sort((a, b) => a.fraction - b.fraction || a.index - b.index)

  const rowRightEdge = []
  const rowOf = new Array(fractions.length).fill(0)

  for (const item of sorted) {
    let row = rowRightEdge.findIndex((right) => item.fraction - right >= minSeparation)
    if (row === -1) {
      row = rowRightEdge.length
      rowRightEdge.push(Number.NEGATIVE_INFINITY)
    }
    rowRightEdge[row] = item.fraction
    rowOf[item.index] = row
  }

  return { rowOf, rowCount: rowRightEdge.length }
}

function TimelineView(props) {
  const { doc, selection, onSelect } = props
  const calendar = doc.calendar ?? {}
  // Elements as well as containers: `{"events":[null]}` passes `Array.isArray`.
  const lines = objectList(doc.lines)
  const events = objectList(doc.events)

  const distinctKeys = [...new Set(events.map((event) => timeKey(event.at)).filter((key) => key !== null))].sort(
    (a, b) => a - b,
  )

  // Default the cursor to the latest written moment — the closest thing a novel
  // has to "now".
  const [cursorKey, setCursorKey] = react.useState(() =>
    distinctKeys.length > 0 ? distinctKeys[distinctKeys.length - 1] : null,
  )

  const declaredStart = timeKey(calendar.start)
  const declaredEnd = timeKey(calendar.end)
  const declaredUsable = declaredStart !== null && declaredEnd !== null && declaredEnd > declaredStart

  // The axis spans the UNION of the declared calendar and every event time.
  //
  // Clamping to the declared range instead is the obvious implementation and it
  // breaks the view: an event dated outside those bounds is pinned to the very
  // edge, and the cursor — mapped from a fraction of the declared span — can
  // never reach it, so every event reads as "future" and dims at once.
  const bounds = [...(declaredUsable ? [declaredStart, declaredEnd] : []), ...distinctKeys]
  const lo = bounds.length > 0 ? Math.min(...bounds) : 0
  const hi = bounds.length > 0 ? Math.max(...bounds) : 1
  const span = hi > lo ? hi - lo : 1

  const pctOf = (key) => Math.max(0, Math.min(100, ((key - lo) / span) * 100))
  const fractionOf = (key) => (key === null ? 0 : pctOf(key) / 100)

  const declaredWiderThanContent = declaredUsable && (declaredStart > lo || declaredEnd < hi)

  // Lanes: the declared lines, plus synthetic ones so an event whose lineId is
  // unknown or absent is still shown rather than silently dropped.
  const declaredIds = new Set(lines.map((line) => line.id))
  const orphanIds = [...new Set(events.map((event) => event.lineId ?? null))].filter(
    (id) => id !== null && !declaredIds.has(id),
  )
  const lanes = [
    ...lines,
    ...orphanIds.map((id) => ({ id, name: `未定义线 ${id}`, kind: 'branch', synthetic: true })),
    ...(events.some((event) => event.lineId === null || event.lineId === undefined)
      ? [{ id: null, name: '未归线', kind: 'branch', synthetic: true }]
      : []),
  ]

  const eventsOfLane = (laneId) => events.filter((event) => (event.lineId ?? null) === laneId)

  const step = (direction) => {
    if (distinctKeys.length === 0) return
    const current = cursorKey
    if (current === null) {
      setCursorKey(distinctKeys[distinctKeys.length - 1])
      return
    }
    const at = distinctKeys.indexOf(current)
    if (at === -1) {
      const next = distinctKeys.find((key) => key > current)
      setCursorKey(direction > 0 ? next ?? current : current)
      return
    }
    const target = Math.max(0, Math.min(distinctKeys.length - 1, at + direction))
    setCursorKey(distinctKeys[target])
  }

  // Whether the cursor sits at the latest written moment — the default. Labelled
  // so that "nothing is dimmed" reads as the intended state, not a broken cursor.
  const atLatest = distinctKeys.length === 0 || cursorKey === distinctKeys[distinctKeys.length - 1]

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
          marginBottom: '10px',
          fontSize: '12px',
        },
      },
      h('span', { style: { opacity: 0.55 } }, '时间游标'),
      h('strong', { style: { fontWeight: 600 } }, `${formatTimeKey(calendar, cursorKey)}${atLatest ? '（最新）' : ''}`),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: () => step(-1) }, '← 上一事件'),
      h('button', { type: 'button', style: { ...buttonStyle, padding: '2px 8px' }, onClick: () => step(1) }, '下一事件 →'),
      h(
        'button',
        {
          type: 'button',
          style: { ...buttonStyle, padding: '2px 8px' },
          disabled: distinctKeys.length === 0,
          onClick: () => setCursorKey(distinctKeys[distinctKeys.length - 1] ?? null),
        },
        '回到最新',
      ),
      h('span', { style: { opacity: 0.45 } }, `${events.length} 个事件 · ${lines.length} 条线`),
    ),

    // Click strip: the axis itself, where the cursor is placed.
    h(
      'div',
      {
        title: '点击此处设置时间游标',
        onClick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const usable = rect.width - GUTTER_PX * 2
          if (usable <= 0) return
          // Subtract the gutter so the click lands where the tick it aims at
          // actually is; without this the cursor drifts toward the centre.
          const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - GUTTER_PX) / usable))
          setCursorKey(Math.round(lo + fraction * span))
        },
        style: {
          position: 'relative',
          height: '20px',
          borderBottom: `1px solid ${muted}`,
          cursor: 'crosshair',
          fontSize: '11px',
          opacity: 0.6,
        },
      },
      h('span', { style: { position: 'absolute', left: 0 } }, formatTimeKey(calendar, lo)),
      h('span', { style: { position: 'absolute', right: 0 } }, formatTimeKey(calendar, hi)),
    ),

    declaredWiderThanContent
      ? h(
          'div',
          { style: { fontSize: '11px', opacity: 0.45, marginTop: '2px' } },
          `历法区间：${formatTimeKey(calendar, declaredStart)} ~ ${formatTimeKey(calendar, declaredEnd)}（轴已扩展到含全部事件）`,
        )
      : null,

    events.length === 0
      ? h(
          'div',
          { style: { marginTop: '14px' } },
          h(Note, { text: '还没有事件。事件是时间轴上的条目；关系变化由事件触发时可在事件上注明。' }),
        )
      : null,

    lanes.length > 0 && events.length > 0
      ? h(
          'div',
          { style: { marginTop: '6px' } },
          ...lanes.map((lane) => {
            const laneEvents = eventsOfLane(lane.id)
            const fractions = laneEvents.map((event) => fractionOf(timeKey(event.at)))
            const { rowOf, rowCount } = assignRows(fractions)

            // Rows alternate above and below the axis: row 0 above, row 1 below,
            // row 2 further above, and so on. The axis line is drawn through the
            // middle, so "before and after this moment" reads spatially.
            const maxDepth = Math.max(0, Math.ceil(rowCount / 2) - 1) + 1
            const laneHeight = 2 * maxDepth * ROW_HEIGHT + CHIP_HEIGHT
            const axisY = laneHeight / 2

            return h(
              'div',
              { key: lane.id ?? '__none__', style: { marginBottom: '10px' } },
              // The lane caption is its own line rather than an overlay: an
              // overlaid label collides with the topmost row of chips.
              h(
                'div',
                {
                  style: {
                    fontSize: '11px',
                    opacity: 0.5,
                    fontWeight: lane.kind === 'main' ? 600 : 400,
                  },
                },
                `${lane.kind === 'main' ? '主线' : '支线'} · ${lane.name}`,
              ),
              h(
                'div',
                { style: { position: 'relative', height: `${laneHeight}px` } },
                // The axis line itself.
                h('div', {
                  style: {
                    position: 'absolute',
                    top: `${axisY}px`,
                    left: 0,
                    right: 0,
                    height: '1px',
                    background: muted,
                  },
                }),
                cursorKey !== null
                  ? h('div', {
                      style: {
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: axisLeft(fractionOf(cursorKey)),
                        width: '1px',
                        background: 'currentColor',
                        opacity: 0.45,
                        pointerEvents: 'none',
                      },
                    })
                  : null,
                ...laneEvents.map((event, index) => {
                  const future = isAfterCursor(cursorKey, event)
                  const selected =
                    selection !== null && selection.entity === 'timeline-event' && selection.id === event.id
                  const side = rowOf[index] % 2 === 0 ? -1 : 1
                  const depth = Math.floor(rowOf[index] / 2) + 1
                  const centerY = axisY + side * depth * ROW_HEIGHT
                  return h(
                    'button',
                    {
                      key: event.id,
                      type: 'button',
                      title: `${formatTimeKey(calendar, timeKey(event.at))}　${event.title ?? event.id}`,
                      onClick: () => onSelect({ entity: 'timeline-event', id: event.id }),
                      style: {
                        position: 'absolute',
                        left: axisLeft(fractions[index]),
                        top: `${centerY}px`,
                        transform: 'translate(-50%, -50%)',
                        maxWidth: `${CHIP_MAX_WIDTH}px`,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        font: 'inherit',
                        fontSize: '11px',
                        lineHeight: `${CHIP_HEIGHT - 4}px`,
                        padding: '0 7px',
                        borderRadius: '999px',
                        border: `1px solid ${selected ? 'currentColor' : muted}`,
                        background: selected ? 'rgba(128,128,128,0.2)' : 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        // Events after the cursor are the future: still visible, so
                        // the whole story stays legible, but clearly not yet true.
                        opacity: future ? 0.35 : 1,
                      },
                    },
                    event.title ?? event.id,
                  )
                }),
              ),
            )
          }),
        )
      : null,
  )
}

/**
 * The calendar editor: an in-world epoch name and the axis endpoints.
 *
 * Needed as a first-class control rather than a hidden default because character
 * ages are derived from `born` against this calendar (docs/data-model.md §6.2) —
 * with no usable calendar there is no reference point to compute them from.
 */
function CalendarEditor(props) {
  const { calendar, onChange } = props
  const current = calendar ?? {}
  return h(
    'div',
    null,
    h(DetailHeading, null, '历法'),
    h(
      'div',
      { style: { fontSize: '11px', opacity: 0.5, lineHeight: 1.7, marginBottom: '10px' } },
      '时间轴的起点与终点，以及纪元名称。人物年龄由出生时间按这套历法推算，因此它必须可用。轴会自动扩展到包含全部事件。',
    ),
    h(
      'div',
      { style: { marginBottom: '10px' } },
      h(FieldLabel, null, '纪元名称'),
      h('input', {
        value: current.epochLabel ?? '',
        onChange: (event) => onChange({ ...current, epochLabel: event.target.value }),
        style: inputStyle,
      }),
    ),
    h(
      'div',
      { style: { marginBottom: '10px' } },
      h(FieldLabel, null, '起点'),
      h(TimeInput, { value: current.start, onChange: (next) => onChange({ ...current, start: next }) }),
    ),
    h(
      'div',
      null,
      h(FieldLabel, null, '终点'),
      h(TimeInput, { value: current.end, onChange: (next) => onChange({ ...current, end: next }) }),
    ),
  )
}
