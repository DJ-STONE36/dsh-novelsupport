/**
 * Descriptor layer: fields, entities, and branches.
 *
 * This is the module that makes a branch a *configuration* rather than code.
 * A branch declares which document it edits, which collections live in it, how
 * those collections nest, and which entity schemas its cards use; the views
 * (`EntityTree`, `SchemaForm`) read those declarations and know nothing about
 * items, characters, or organizations specifically. Adding the 人物 branch later
 * is a descriptor entry, not a new component.
 */

/** Field builders. `type` selects the control `SchemaForm` renders. */
const F = {
  text: (key, label, extra) => ({ key, label, type: 'text', ...extra }),
  long: (key, label, extra) => ({ key, label, type: 'longtext', ...extra }),
  num: (key, label, extra) => ({ key, label, type: 'number', ...extra }),
  time: (key, label, extra) => ({ key, label, type: 'time', ...extra }),
  select: (key, label, options, extra) => ({ key, label, type: 'select', options, ...extra }),
  stringList: (key, label, extra) => ({ key, label, type: 'stringlist', ...extra }),
  stringMap: (key, label, extra) => ({ key, label, type: 'stringmap', ...extra }),
  ref: (key, label, refKind, extra) => ({ key, label, type: 'ref', refKind, ...extra }),
  refList: (key, label, refKind, extra) => ({ key, label, type: 'reflist', refKind, ...extra }),
  /** A flat, self-nested-by-`parentId` array edited as a small tree. */
  structure: (key, label, extra) => ({ key, label, type: 'structure', ...extra }),
}

/**
 * Turn a display name into a stable id segment.
 *
 * The id is minted once, from whatever the entity was first called, and never
 * follows a rename: `docs/data-model.md` requires ids to be rename-proof, with
 * `aliases` carrying former names for the consistency checker to match on.
 */
function idSegment(name, fallback) {
  const cleaned = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? fallback : cleaned
}

/** A project-unique id, avoiding collisions already present in `taken`. */
function mintId(prefix, name, taken) {
  // Tolerate a prefix written with or without its trailing dash. Ids are
  // permanent (see idSegment), so `cat--weapon` would be baked into the user's
  // data for good — normalise here rather than trusting every call site.
  const cleanPrefix = String(prefix).replace(/-+$/, '')
  const base = `${cleanPrefix}-${idSegment(name, 'untitled')}`
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * Entity schemas. Structural keys (`id`, `parentId`, `categoryId`, `custom`) are
 * NOT declared here: the tree owns parentage and the form owns `custom`, so
 * declaring them as fields would render them twice.
 */
const ENTITIES = {
  'item-category': {
    label: '分类',
    idPrefix: 'cat-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [F.text('name', '名称'), F.num('order', '排序')],
    blank: () => ({ name: '新分类', order: 10 }),
  },
  item: {
    label: '物品',
    idPrefix: 'item-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [
      F.text('name', '名称'),
      F.text('rarity', '品阶'),
      F.long('description', '描述'),
      F.long('history', '来历'),
      F.stringMap('attrs', '属性'),
      F.stringList('tags', '标签'),
    ],
    // A model-backed generator this entity offers. Declaring it here turns the
    // control on in the detail pane; a second generator is a line like this one,
    // not new UI. `hintField` seeds the direction from the author's own draft.
    generate: { kind: 'item', hintField: 'name' },
    blank: () => ({ name: '新物品', rarity: '', description: '', history: '', attrs: {}, tags: [] }),
  },
  'timeline-line': {
    label: '时间线',
    idPrefix: 'tl-',
    titleOf: (line) => line.name || line.id,
    fields: [
      F.text('name', '名称'),
      F.select('kind', '类型', [
        { value: 'main', label: '主线' },
        { value: 'branch', label: '支线' },
      ]),
      F.num('order', '排序'),
    ],
    blank: () => ({ name: '新时间线', kind: 'branch', order: 10 }),
  },
  'timeline-event': {
    label: '事件',
    idPrefix: 'evt-',
    titleOf: (event) => event.title || event.id,
    fields: [
      F.text('title', '标题'),
      F.ref('lineId', '所属线', 'timeline-line'),
      F.time('at', '发生时间'),
      F.time('spanEnd', '结束时间（时段）'),
      F.text('atLabel', '模糊时间说明'),
      F.long('impact', '影响'),
      F.refList('characters', '涉及人物', 'character'),
      F.refList('places', '涉及地点', 'place'),
      F.ref('outlineRef', '对应大纲条目', 'outline-node'),
      // A picker, like every other reference on this entity. It used to be a free-text
      // box, so a typo persisted forever and "why did this happen" silently resolved to
      // nothing — the one reference field on the entity that no check and no picker
      // covered.
      F.ref('causeEventId', '诱因事件', 'timeline-event'),
    ],
    // A model can propose a title, a time and an impact, but never a reference:
    // invented ids would point at entities that do not exist, so the author picks
    // 涉及人物/地点/所属线 themselves. The generator's field list omits them too.
    generate: { kind: 'timeline-event', hintField: 'title' },
    blank: () => ({
      title: '新事件',
      lineId: null,
      at: { year: 1, month: null, day: null },
      spanEnd: null,
      atLabel: '',
      impact: '',
      characters: [],
      places: [],
      outlineRef: null,
      causeEventId: null,
    }),
  },
  'outline-node': {
    label: '大纲条目',
    idPrefix: 'out-',
    titleOf: (node) => node.title || node.id,
    fields: [
      F.text('title', '标题'),
      F.select('kind', '层级', [
        { value: 'volume', label: '卷' },
        { value: 'chapter', label: '章' },
        { value: 'beat', label: '节拍' },
      ]),
      F.num('order', '排序'),
      F.long('summary', '概要'),
      F.ref('timelineRef', '对应事件', 'timeline-event'),
      F.text('chapterId', '对应章节'),
    ],
    blank: () => ({ title: '新条目', kind: 'chapter', order: 10, summary: '', timelineRef: null, chapterId: null }),
  },
  character: {
    label: '人物',
    idPrefix: 'char-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [
      F.text('name', '姓名'),
      F.stringList('aliases', '别名'),
      F.select('gender', '性别', [
        { value: '男', label: '男' },
        { value: '女', label: '女' },
        { value: '其他', label: '其他' },
        { value: '未定', label: '未定' },
      ]),
      F.text('race', '种族'),
      // Birth time rather than an age number: the timeline spans centuries and a
      // stored age is wrong the moment the story moves (docs/data-model.md §4.3).
      F.time('born', '出生时间'),
      F.text('ageNote', '年龄说明'),
      F.select('status', '状态', [
        { value: 'alive', label: '在世' },
        { value: 'dead', label: '已故' },
        { value: 'missing', label: '失踪' },
        { value: 'unknown', label: '未知' },
      ]),
      F.long('appearance', '外貌'),
      F.long('personality', '性格'),
      F.long('background', '背景'),
      F.text('firstAppearance', '首次出场（章节 id）'),
      F.stringList('tags', '标签'),
    ],
    generate: { kind: 'character', hintField: 'name' },
    blank: () => ({
      name: '新人物',
      aliases: [],
      gender: '未定',
      race: '',
      born: null,
      ageNote: '',
      status: 'alive',
      appearance: '',
      personality: '',
      background: '',
      firstAppearance: null,
      tags: [],
      custom: {},
    }),
  },
  place: {
    label: '地点',
    idPrefix: 'place-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [
      F.text('name', '名称'),
      F.text('kind', '类型'),
      F.long('summary', '简介'),
      F.stringList('tags', '标签'),
    ],
    // `parentId` is not a field: the tree owns parentage, so declaring it here
    // would render the same fact twice.
    generate: { kind: 'place', hintField: 'name' },
    blank: () => ({ name: '新地点', kind: '', summary: '', tags: [], custom: {} }),
  },
  /**
   * A position in an organization's structure.
   *
   * Only the shape of the hierarchy lives here — who holds a position is a
   * `member-of` relation edge, so "the post is filled" and "the person is a member"
   * cannot disagree (docs/data-model.md §4.4).
   */
  'org-position': {
    label: '职位',
    idPrefix: 'pos-',
    titleOf: (position) => position.title || position.id,
    fields: [F.text('title', '职位名称'), F.num('order', '排序')],
    blank: () => ({ title: '新职位', parentId: null, order: 10 }),
  },
  organization: {
    label: '组织',
    idPrefix: 'org-',
    titleOf: (entity) => entity.name || entity.id,
    fields: [
      F.text('name', '名称'),
      F.stringList('aliases', '别名'),
      F.text('kind', '类型'),
      F.time('founded', '成立时间'),
      F.select('status', '状态', [
        { value: 'active', label: '存续' },
        { value: 'dissolved', label: '已解散' },
        { value: 'unknown', label: '未知' },
      ]),
      F.long('summary', '简介'),
      // A flat array self-nested by `parentId`, like item categories — so it reuses
      // the same tree component rather than needing a bespoke editor.
      F.structure('structure', '组织架构'),
      F.stringList('tags', '标签'),
    ],
    generate: { kind: 'organization', hintField: 'name' },
    blank: () => ({ name: '新组织', aliases: [], kind: '', founded: null, status: 'active', summary: '', structure: [], tags: [], custom: {} }),
  },
  /**
   * A relationship edge. Lives in `relations.json`, which is the one document the
   * relationship graph owns and writes — every other branch reads it.
   */
  'relation-edge': {
    label: '关系',
    idPrefix: 'rel-',
    titleOf: (edge) => edge.id,
    fields: [
      F.ref('from', '起点', 'graph-node'),
      F.ref('to', '终点', 'graph-node'),
      F.ref('type', '类型', 'relation-type'),
      F.time('since', '起始'),
      F.time('until', '结束'),
      F.ref('causeEventId', '诱发事件', 'timeline-event'),
      F.long('note', '备注'),
    ],
    // `since` is required and must precede `until`; a fresh edge starts at year 1
    // and the author narrows it. A half-filled edge simply cannot be saved, which
    // is the validator doing its job rather than a form that lies.
    blank: () => ({ from: null, to: null, type: '', since: { year: 1, month: null, day: null }, until: null, note: '', causeEventId: null }),
  },
  /**
   * A section of the world setting. Prose, so `body` is long-form.
   */
  'world-section': {
    label: '分节',
    idPrefix: 'sec-',
    titleOf: (section) => section.title || section.id,
    fields: [F.text('title', '标题'), F.num('order', '排序'), F.long('body', '正文')],
    blank: () => ({ title: '新分节', order: 10, body: '' }),
  },
  /**
   * A world rule as its own entry, not buried in a paragraph — so consistency
   * checking can say "violates rule-003" instead of quoting prose.
   *
   * `scope` decides whether `branch` applies: a global rule governs the whole
   * book, a branch rule only its own 时间线 or region.
   */
  'world-rule': {
    label: '规则',
    idPrefix: 'rule-',
    titleOf: (rule) => rule.title || rule.id,
    fields: [
      F.text('title', '规则名称'),
      F.select('scope', '范围', [
        { value: 'global', label: '总规则（全书）' },
        { value: 'branch', label: '分支规则（限某地/某线）' },
      ]),
      F.text('branch', '适用分支（范围选「分支规则」时填）'),
      F.long('body', '规则内容'),
      F.stringList('tags', '标签'),
    ],
    // `generate` is deliberately absent: a rule is a constraint the author must
    // decide, and a model inventing one would constrain the book for them.
    blank: () => ({ title: '新规则', scope: 'global', branch: '', body: '', tags: [] }),
  },
  /**
   * Chapter front matter. Not a JSON document — the prose lives in the file body —
   * but the metadata half edits exactly like any other entity, so it reuses the
   * same form.
   */
  chapter: {
    label: '章节',
    idPrefix: 'ch-',
    titleOf: (meta) => meta.title || meta.id,
    fields: [
      F.text('title', '标题'),
      F.num('order', '排序'),
      F.select('status', '状态', [
        { value: 'draft', label: '草稿' },
        { value: 'revised', label: '已修' },
        { value: 'final', label: '定稿' },
      ]),
      F.ref('volumeRef', '所属卷', 'outline-node'),
      F.ref('outlineRef', '对应大纲条目', 'outline-node'),
      // Pickers, not typed names: the front matter stores entity ids, which is
      // what the consistency checker and the relationship graph need. A name
      // typed before the entity existed stays visible as an unresolved chip and
      // is reported as `unresolved-chapter-reference`.
      F.refList('characters', '涉及人物', 'character'),
      F.refList('places', '涉及地点', 'place'),
      F.long('summary', '概要'),
    ],
    blank: () => ({
      title: '新章节',
      order: 10,
      status: 'draft',
      volumeRef: null,
      outlineRef: null,
      characters: [],
      places: [],
      summary: '',
      custom: {},
    }),
  },
}

/**
 * Branches. One entry per activity-bar icon; `view` selects the center view.
 *
 * `planned` is shown verbatim for branches whose view has not landed yet —
 * an honest empty state beats a fake one, and it keeps the navigation complete
 * while the views arrive one at a time.
 */
const BRANCHES = [
  {
    id: 'world',
    label: '世界',
    hint: '世界观总设定、地点与地图',
    // 地点 lives here rather than as an eighth activity icon, because the brief
    // puts it under 世界 alongside 总设定 and 地图. A tab strip keeps the seven
    // icons the navigation was designed around.
    view: 'tabs',
    tabs: [
      {
        id: 'places',
        label: '地点',
        view: 'tree',
        doc: 'setting/places.json',
        tree: {
          groups: [{ key: 'places', entity: 'place', parentKey: 'parentId', label: '地点', idPrefix: 'place-' }],
          leaves: [],
        },
        // Ask this branch to also read the map document, so a 地点 can show WHICH markers on WHICH maps
        // point at it. Only this branch pays for it.
        placeLinks: true,
      },
      {
        id: 'settings',
        label: '总设定',
        view: 'tree',
        doc: 'setting/world.json',
        // Two flat collections rather than a tree: sections and rules are separate
        // lists in one document, with no nesting between them.
        collections: [
          { key: 'sections', entity: 'world-section', label: '分节', idPrefix: 'sec-' },
          { key: 'rules', entity: 'world-rule', label: '规则', idPrefix: 'rule-' },
        ],
      },
      {
        id: 'map',
        label: '地图',
        view: 'map',
        doc: 'setting/map/index.json',
        hint: '手绘或导入的 2D 地图',
      },
    ],
  },
  {
    id: 'timeline',
    label: '时间轴',
    hint: '事件、主线与支线',
    view: 'timeline',
    doc: 'outline/timeline.json',
    // Two flat collections rather than a tree, so the detail lookup needs the
    // collection keys spelled out.
    collections: [
      { key: 'lines', entity: 'timeline-line' },
      { key: 'events', entity: 'timeline-event' },
    ],
    // Reference candidates the event form offers.
    refKinds: ['timeline-line', 'outline-node', 'timeline-event', 'character', 'place'],
  },
  {
    id: 'orgs',
    label: '组织',
    hint: '组织架构与关系网',
    view: 'tabs',
    tabs: [
      {
        id: 'cards',
        label: '组织树',
        view: 'tree',
        doc: 'setting/organizations.json',
        tree: {
          groups: [
            { key: 'organizations', entity: 'organization', parentKey: 'parentId', label: '组织', idPrefix: 'org-' },
          ],
          leaves: [],
        },
      },
      {
        id: 'graph',
        label: '关系网',
        view: 'graph',
        doc: 'relations.json',
        // The graph edits edges, so it must declare where they live or the detail
        // lookup finds nothing and the pane silently shows a generic hint.
        collections: [{ key: 'edges', entity: 'relation-edge' }],
        // Both tabs read the same edge document; what distinguishes them is which
        // nodes each is centred on.
        focusKinds: ['organization'],
        nodeKinds: ['character', 'organization', 'place'],
      },
    ],
  },
  {
    id: 'chars',
    label: '人物',
    hint: '人物卡与关系网',
    view: 'tabs',
    tabs: [
      {
        id: 'cards',
        label: '人物卡',
        view: 'tree',
        doc: 'setting/characters.json',
        tree: {
          // Characters have no parent in the model, so every one is a root and the
          // tree renders a flat list. Declaring the parent key anyway means adding
          // grouping later (by faction, say) needs no new component.
          groups: [
            { key: 'characters', entity: 'character', parentKey: 'parentId', label: '人物', idPrefix: 'char-' },
          ],
          leaves: [],
        },
      },
      {
        id: 'graph',
        label: '关系网',
        view: 'graph',
        doc: 'relations.json',
        // See the 组织 tab: the graph edits edges, so it must declare them.
        collections: [{ key: 'edges', entity: 'relation-edge' }],
        focusKinds: ['character'],
        nodeKinds: ['character', 'organization', 'place'],
      },
    ],
  },
  {
    id: 'items',
    label: '物品',
    hint: '物品分类树与物品卡',
    view: 'tree',
    doc: 'setting/items.json',
    tree: {
      // A forest of categories joined by `parentId`, with items hanging off a
      // category by `categoryId`. Depth is unbounded, so 总类别/副类别/分支类别
      // are just the first three levels rather than a fixed shape.
      groups: [{ key: 'categories', entity: 'item-category', parentKey: 'parentId', label: '分类', idPrefix: 'cat-' }],
      leaves: [{ key: 'items', entity: 'item', parentKey: 'categoryId', label: '物品', idPrefix: 'item-' }],
    },
  },
  {
    id: 'outline',
    label: '剧情大纲',
    hint: '卷章结构与进度',
    view: 'tree',
    doc: 'outline/outline.json',
    // A groups-only forest: outline nodes nest by `parentId` and have no leaf
    // collection. EntityTree tolerates the missing `leaves`, which is what lets
    // the same component serve a tree of items and a tree of outline nodes.
    tree: {
      groups: [{ key: 'nodes', entity: 'outline-node', parentKey: 'parentId', label: '大纲条目', idPrefix: 'out-' }],
      leaves: [],
    },
  },
  {
    id: 'chapters',
    label: '章节',
    hint: '章节正文',
    view: 'chapters',
  },
]

const panelIdFor = (branchId) => `dsh-novel.${branchId}`
const DETAIL_KIND = 'novel.detail'
const DETAIL_ID = 'dsh-novel.detail'
