/**
 * Registration: one activity-bar icon and one center panel per branch.
 *
 * The `sidebar.panellist` entry's `id` and the `main` entry's `key` are both
 * derived from `panelIdFor(branch.id)`, so they cannot drift apart — a mismatch
 * would make the icon select a panel that does not exist, which throws inside
 * `selectPanel` and leaves the center column unchanged with no visible reason.
 */

/**
 * The right-column detail seat.
 *
 * Registered through a NESTED inject: naming `sidebarRightTabs` in the
 * module-level inject would keep the entire plugin unmounted on a host without
 * that service, taking branch navigation down with it. Nested, a missing service
 * costs only the detail tab.
 *
 * LIMITATION, and the reason the branch views do not rely on this seat: an
 * activity-bar branch panel is a *global* `main` panel, and while one fills the
 * center column the right column has no Session — `ctx.sidebarRight.mounted` is
 * `undefined`, the column has "no surface without a session", and `openTab`
 * throws rather than drawing into a surface nobody owns. This seat is therefore
 * reachable only alongside the Conversation (useful for "chat while browsing"),
 * never from inside a branch panel. Phase 3's detail pane is drawn in-panel
 * instead — see `60-shell.js` / `SplitPane`.
 */
function DetailBody() {
  return h(
    'div',
    { style: { padding: '14px', fontSize: '13px', lineHeight: 1.8 } },
    h('div', { style: { opacity: 0.75 } }, '详情位已就位。'),
    h(
      'div',
      { style: { marginTop: '10px', opacity: 0.55, fontSize: '12px' } },
      '这个标签页只在对话打开时可达；分支面板内的详情是面板自绘的（右栏在全局面板下没有会话）。',
    ),
  )
}

function registerDetailSeat(ctx) {
  ctx.inject(['sidebarRightTabs'], (scoped) => {
    const disposers = []
    try {
      disposers.push(scoped.sidebarRightTabs.register({
        id: DETAIL_ID,
        kind: DETAIL_KIND,
        title: () => '小说详情',
      }))
      disposers.push(scoped.slots.register({ name: 'sidebar.right.pane.tab', key: DETAIL_ID }, DetailBody))
    } catch (error) {
      console.warn('[dsh-novel] detail seat registration failed:', error)
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* already gone */
        }
      }
    }
  })
}

function apply(ctx) {
  for (const [index, branch] of BRANCHES.entries()) {
    const id = panelIdFor(branch.id)
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id }, createPanel(ctx, branch)))
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id, order: 5 + index, label: () => `小说·${branch.label}` },
        function BranchIcon(props) {
          return h(Glyph, { name: branch.id, size: props?.size })
        },
      ),
    )
  }
  registerDetailSeat(ctx)
}

/**
 * Testing seam.
 *
 * The host reads only `name`, `inject` and `apply`. These exports exist so
 * `tools/client-selftest.mjs` can render the pure views with plain props — the
 * only way to exercise them without a browser and a live host, and the
 * difference between catching a component bug here and catching it as a blank
 * panel in front of the user.
 */
exports.__test = {
  BRANCHES,
  ENTITIES,
  F,
  Glyph,
  Note,
  PlannedBranch,
  EntityTree,
  SchemaForm,
  SplitPane,
  indexTree,
  mintId,
  panelIdFor,
  isBlank,
  projectStore,
  api,
  withoutBlankKeys,
  timeKey,
  timeKeyParts,
  formatTimeKey,
  TimelineView,
  CalendarEditor,
  entitySpecFor,
  isAfterCursor,
  axisLeft,
  GUTTER_PX,
  CHIP_MAX_WIDTH,
  assignRows,
  ROW_SEPARATION,
  ROW_HEIGHT,
  countWords,
  MasterDetail,
  ChapterBranch,
  useChapter,
  parseStringList,
  stringListDisplay,
  MultiSelect,
  TabsBranch,
  ViewBoundary,
  AgentDraftBody,
  manuscriptReceipt,
  manuscriptQuery,
  ManuscriptExport,
  existingNamesIn,
  buildImportedEntities,
  branchTakenIds,
  importTargets,
  planImport,
  parseNameList,
  coerceImportValue,
  matchVocabulary,
  matchOption,
  importVocabulary,
  importFields,
  parseEntityLines,
  parseEntityLine,
  BulkImport,
  AgentDraftControl,
  agentPromptText,
  agentPhase,
  agentWrites,
  agentUsageLine,
  agentModelLine,
  agentSessionsFor,
  agentSessionsSorted,
  agentRelativeTime,
  agentSessionLabel,
  useRefOptions,
  REF_COLLECTIONS,
  edgesActiveAt,
  visibleNetwork,
  layoutForce,
  edgesTouching,
  clientToViewBox,
  clampToBox,
  mergePositions,
  setManualPosition,
  clearManualPositions,
  countManualPositions,
  GRAPH_LAYOUT_KEY,
  RelationGraph,
  GraphBranch,
  GraphView,
  EntityTreeBody,
  TimelineBody,
  ChapterBody,
  ChapterListPane,
  ChapterEditorPane,
  CommitRow,
  WriteFeedback,
  GenerateControl,
  GenerateReceipt,
  GenerateOptions,
  DraftControl,
  mergeDraft,
  DRAFT_MODE_LABELS,
  CandidateList,
  makeRng,
  generateLocalDraft,
  LOCAL_KINDS,
  CollectionPane,
  TreePane,
  StructureInput,
  removePositionSubtree,
  PositionEditor,
  childNodeFor,
  supportsNesting,
  isRecord,
  objectList,
  objectValues,
  // --- the map ---
  MAP_DOC,
  MAP_LAYOUT_DOC,
  MAP_ZOOM_MIN,
  MAP_ZOOM_MAX,
  MAP_PEN_COLORS,
  MAP_DEFAULT_COLOR,
  MAP_LABEL_SIZES,
  MAP_DEFAULT_LABEL_SIZE,
  MAP_PIN_HIT_PX,
  mapStrokeColor,
  cleanPoints,
  mapStrokes,
  mapPins,
  allPinIds,
  allPathIds,
  allIdsOf,
  mapCanvas,
  mapBackground,
  normalizeMap,
  mapMaps,
  migrateLegacyMaps,
  resolveActiveMap,
  withMaps,
  mapViewFor,
  withMapView,
  mapViewState,
  isMapBox,
  mapViewBox,
  viewBoxString,
  mapScale,
  mapScreenToWorld,
  mapPanTo,
  mapZoomAt,
  mapPinHitRadius,
  strokePath,
  pinAt,
  mapPinHit,
  mintMapId,
  mapLabelSize,
  mapLabelOffset,
  mapFillAt,
  mapClosedLoops,
  mapPolygonArea,
  mapPointInPolygon,
  mapShapeFromDrag,
  mapShapes,
  normalizeShape,
  mapShapePoints,
  MAP_CLOSED_GAP,
  MAP_SHAPE_STEPS,
  MAP_SHAPE_MIN_SIZE,
  MAP_SHAPE_KIND_IDS,
  MAP_SHAPE_KINDS,
  mapPathRename,
  mapPathTitle,
  mapMountainGlyph,
  mapMountainPeaks,
  mapPathAnchor,
  mapEraseAt,
  mapDistanceToCourse,
  mapPointToSegment,
  mapEraseRadius,
  mapPinColor,
  mapPinRadius,
  mapPinDiameter,
  MAP_PIN_DEFAULT_SIZE,
  MAP_PIN_SIZES,
  mapStrokeWidth,
  normalisePenWidth,
  MAP_PEN_DEFAULT,
  MAP_PEN_WIDTHS,
  mapDisplayName,
  mapUnlinkPlace,
  mapMarkPlace,
  mapFreeSpot,
  MAP_STAMP_SIZES,
  MAP_TEXT_SIZES,
  MAP_THEME_IDS,
  MAP_THEMES,
  MAP_SYMBOL_IDS,
  MAP_SYMBOLS,
  mapInkFor,
  mapHaloColor,
  mapFocusGroup,
  mapFocusAnchor,
  mapOutlineClosed,
  mapFillOf,
  mapFillAdvice,
  mapPaper,
  mapThemeId,
  mapTheme,
  mapStampColor,
  mapTextColor,
  mapStampSize,
  mapTextSize,
  mapTextWidth,
  mapStampParts,
  mapStampBox,
  mapTextBox,
  normalizeMapStamp,
  normalizeMapText,
  mapStamps,
  mapTexts,
  mapTargetName,
  mapTargetBox,
  mapTargetPoints,
  mapMoveTarget,
  mapPickAt,
  mapPlaceLinks,
  mapLabelLayout,
  mapBoxesOverlap,
  mapLabelBox,
  mapLabelAnchors,
  mapLabelWidth,
  mapAssetName,
  isMapImage,
  mapAssetUrl,
  mapGridLines,
  MAP_PATH_KINDS,
  MAP_PATH_KIND_IDS,
  MAP_PATH_WIDTHS,
  MAP_DASHES,
  MAP_PATH_MAX_WIDTH,
  MAP_PATH_HIT_PX,
  mapPathHitRadius,
  mapPathHalfWidth,
  mapSmoothPath,
  mapBankPath,
  normalizePath,
  mapPaths,
  mapAllPaths,
  pathPointAt,
  pathInsertIndex,
  mapPathInsert,
  mapPathMovePoint,
  mapPathRemovePoint,
  mapPathStart,
  mapPathAppend,
  mapPathUpdate,
  mapPathRemove,
  MAP_HISTORY_LIMIT,
  MAP_HISTORY_MERGE_MS,
  mapHistoryNew,
  mapHistorySnapshot,
  mapHistoryCanUndo,
  mapHistoryCanRedo,
  mapHistoryPush,
  mapHistoryUndo,
  mapHistoryRedo,
  MAP_PLACE_SUFFIX,
  generateRandomMap,
  MAP_EXPORT_SCALES,
  mapExportSize,
  mapExportName,
  mapParseColor,
  mapLuminance,
  mapContrast,
  mapExportInk,
  mapDragStart,
  mapDragMove,
  mapDragEnd,
  mapAppendStroke,
  mapUndoStroke,
  mapClearStrokes,
  mapClearPins,
  mapRenameMap,
  mapRemoveMap,
  mapSetLabelSize,
  mapSetLabelFixed,
  mapUpdatePin,
  freshMap,
  MapSurface,
  MapButton,
  MapGroup,
  ColorPicker,
  MapBranch,
}
