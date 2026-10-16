# 小说插件数据模型 v1

**状态**：已确认（2026-10-14）。Phase 1 的施工依据。

这份文档定义"小说项目在磁盘上长什么样"。它必须被三方同时遵守：

| 使用方 | 怎么用 |
| --- | --- |
| 界面（插件客户端） | 读出来画成树/图/时间轴，写回用户编辑 |
| 宿主端（插件 Node 侧） | 唯一真正读写磁盘的一方，负责校验与原子写 |
| 技能（`novel-writer` 等） | AI 直接改这些文件产出正文与设定 |

三方对不齐，就会出现"AI 写好的章节界面读不出来"这类最难查的问题。

---

## 1. 四条原则

1. **id 只增不改。** 每个实体一个稳定 id，改名、改设定都不动它。正文和关系都靠 id 挂钩，不靠姓名——姓名会改会重名。
2. **派生数据不落盘。** 字数、人员组成、关系网度数这类"能算出来"的东西不存。存了就有两个真相源，早晚不一致。
3. **每个实体都有 `custom` 口袋。** 想加一个自己才用的字段，先塞 `custom`，不动 schema、不用迁移。攒够共性再提升为一等字段。
4. **版本写在 `project.json`，迁移幂等。** 多文件迁移时先写数据文件、最后才写 `project.json`；中途崩溃则版本号仍是旧的，迁移可安全重跑。写入必须原子（临时文件 + rename），因为 AI 和界面会并发写同一批文件。

---

## 2. 目录布局

```
novel/
├─ project.json                  项目元数据 + schemaVersion（权威版本号）
├─ relations.json                全部关系边 + 关系类型登记表
├─ setting/
│  ├─ world.json                 世界总设定：分节 + 规则
│  ├─ places.json                地点（地图打点的宿主实体）
│  ├─ characters.json            人物
│  ├─ organizations.json         组织
│  ├─ items.json                 物品（分类树 + 物品卡）
│  └─ map/
│     ├─ index.json              画布、图层、笔迹、打点（矢量）
│     └─ assets/                 导入的位图（png/jpg）
├─ outline/
│  ├─ timeline.json              时间轴：日历 + 多条线 + 事件
│  └─ outline.json               剧情大纲：卷/章树（叙事顺序）
├─ draft/
│  └─ ch-0001.md                 章节正文（YAML front matter + 正文）
└─ views/
   └─ layout.json                关系网/地图的手工摆位（用户资产，需持久化）
```

**分支 → 文件 → 视图映射**

| 分支 | 文件 | 视图 |
| --- | --- | --- |
| 世界·总设定 | `setting/world.json` | 分节编辑器 |
| 世界·地图 | `setting/map/index.json` + `places.json` | 2D 画布 |
| 时间轴 | `outline/timeline.json` | 时间轴 |
| 剧情大纲 | `outline/outline.json` | 时间轴（派生泳道） |
| 组织 | `setting/organizations.json` + `relations.json` | 关系网 |
| 人物 | `setting/characters.json` + `relations.json` | 关系网 |
| 物品 | `setting/items.json` + `relations.json` | 树 |
| 章节 | `draft/*.md` | 列表 + 编辑器 |

---

## 3. 通用约定

- **id 格式**：`<类型前缀>-<短横线短名>`，如 `char-linyuan`、`org-qingyun`、`item-qingfeng`、`place-qingyunshan`、`evt-0007`、`out-0012`、`ch-0001`。短名在创建时由名称生成一次，之后**永不跟随改名**——`name` 才是显示用的权威字段，旧名进 `aliases`。
- **注：`aliases` 是给 `novel-consistency` 用的**，它能据此抓出"同一个人的两种写法"。
- **时间**：一律用世界内时间，形如 `{"year":1345,"month":3,"day":2}`；月/日可为 `null`（只知年份）。显示文本单独存 `atLabel`，为空时由日历推导。排序一律按 `(year, month, day)` 数值，不按字符串。
- **删除**：硬删除，但宿主端拒绝删除仍被引用的实体，并列出引用者。不做软删除（会让 AI 引用到"看似存在"的幽灵）。
- **文件编码**：UTF-8 无 BOM。

---

## 4. 各文件形状

### 4.1 `project.json`

```json
{
  "schemaVersion": 1,
  "id": "proj-qingyunji",
  "title": "青云记",
  "author": "",
  "createdAt": "2026-10-14T06:00:00.000Z",
  "defaultTimelineId": "tl-main",
  "settings": { "wordCountGoal": 300000 }
}
```

### 4.2 `setting/world.json` — 总设定

规则拆成独立条目，而不是埋在大段文字里，这样一致性校验能指名道姓地说"违反 rule-003"。

```json
{
  "sections": [
    { "id": "sec-bg", "title": "世界背景", "order": 10, "body": "……markdown……" },
    { "id": "sec-power", "title": "力量体系", "order": 20, "body": "……" }
  ],
  "rules": [
    { "id": "rule-001", "scope": "global", "title": "灵气守恒", "body": "……", "tags": ["修炼"] },
    { "id": "rule-014", "scope": "branch", "branch": "北境", "title": "北境无灵", "body": "……", "tags": [] }
  ]
}
```

`scope` = `global`（总规则）| `branch`（分支规则），分支规则多一个 `branch` 字段。

### 4.3 `setting/characters.json` — 人物

年龄**不直接存数字**，存出生时间，需要时按时间轴推算。理由：时间轴跨度长，人物年龄随剧情变化，存数字必然过期。

```json
{
  "characters": [
    {
      "id": "char-linyuan",
      "name": "林渊",
      "aliases": ["林澈"],
      "gender": "男",
      "race": "人族",
      "born": { "year": 1318, "month": 4, "day": 9 },
      "ageNote": "外观二十出头",
      "status": "alive",
      "appearance": "……",
      "personality": "……",
      "background": "……",
      "firstAppearance": "ch-0001",
      "tags": ["主角"],
      "custom": {}
    }
  ]
}
```

`status` = `alive | dead | missing | unknown`。一致性校验据此抓"已死角色出场"。`born` 可为 `null`（年龄不详），此时靠 `ageNote`。

### 4.4 `setting/organizations.json` — 组织

架构分两层：`structure` 只定义**有哪些职位、谁向谁汇报**（纯定义，一棵树）；**谁在任**是关系边（`member-of` 带 `positionId`）。任职信息因此只有一个真相源——不这样拆，"职位挂了人"和"人是成员"就会各说各话。

```json
{
  "organizations": [
    {
      "id": "org-qingyun",
      "name": "青云宗",
      "aliases": [],
      "kind": "宗门",
      "parentId": null,
      "founded": { "year": 980, "month": null, "day": null },
      "status": "active",
      "summary": "……",
      "structure": [
        { "id": "pos-1", "title": "掌门", "parentId": null, "order": 10 },
        { "id": "pos-2", "title": "执剑长老", "parentId": "pos-1", "order": 20 }
      ],
      "tags": [],
      "custom": {}
    }
  ]
}
```

人员组成 = 该组织的全部 `member-of` 边；组织架构图 = 职位树，各节点的任职者由边查出。

### 4.5 `setting/items.json` — 物品

分类树深度不写死，用 `parentId` 自嵌套，因此"总类别/副类别/分支类别"只是三层实例，不是上限（原文用了"等等"，说明可能更深）。分类与物品分开放。

**物品归属不存 `ownerId`**，用关系边 `owns` 表示。理由：物品会易主，流转本身常是剧情，字段只能存"当前归属"这一个真相，会丢掉历史，且与关系网形成两个真相源。

```json
{
  "categories": [
    { "id": "cat-weapon", "name": "兵器", "parentId": null, "order": 10 },
    { "id": "cat-sword", "name": "剑", "parentId": "cat-weapon", "order": 10 }
  ],
  "items": [
    {
      "id": "item-qingfeng",
      "name": "青锋剑",
      "categoryId": "cat-sword",
      "rarity": "地阶",
      "attrs": { "长": "三尺", "material": "寒铁" },
      "description": "……",
      "history": "……",
      "tags": ["法器"],
      "custom": {}
    }
  ]
}
```

### 4.6 `setting/places.json` — 地点

地图打点、章节涉地、人物所在地都指向这里。

```json
{
  "places": [
    {
      "id": "place-qingyunshan",
      "name": "青云山",
      "parentId": null,
      "kind": "山门",
      "summary": "……",
      "tags": [],
      "custom": {}
    }
  ]
}
```

### 4.7 `setting/map/index.json` — 地图

```json
{
  "canvas": { "width": 4000, "height": 3000 },
  "background": { "kind": "image", "asset": "assets/world.png" },
  "layers": [
    {
      "id": "layer-terrain",
      "name": "地形",
      "visible": true,
      "strokes": [
        { "id": "s-1", "tool": "brush", "color": "#3a7", "width": 4,
          "points": [[120, 340], [128, 352]] }
      ]
    }
  ],
  "pins": [
    { "id": "pin-1", "placeId": "place-qingyunshan", "x": 812, "y": 430, "label": "" }
  ]
}
```

`background.kind` = `image`（导入）| `blank`（手绘底）。笔迹存矢量点串，不存位图——位图无法缩放、无法改色、diff 不可读。

### 4.8 `relations.json` — 关系（一套引擎服务三个分支）

人物关系网、组织关系网、物品归属**共用一个文件、一套结构、一个渲染引擎**。边的方向性、类型、颜色由登记表驱动，界面因此是数据驱动的，加一种关系不用改代码。

**什么进这个文件、什么留在字段里**：树形且唯一归属的用字段（`parentId`、`categoryId`）——组织归谁、分类属哪类、地点归哪、职位向谁汇报、大纲的父子；网状、多对多、带属性和时间的用边——师徒、亲缘、同盟、隶属、持有。

```json
{
  "types": [
    { "id": "master-apprentice", "label": "师徒", "directed": true, "color": "#4a8" },
    { "id": "member-of", "label": "隶属", "directed": true, "color": null },
    { "id": "owns", "label": "持有", "directed": true, "color": null },
    { "id": "parent-child", "label": "亲缘", "directed": false, "color": null },
    { "id": "ally", "label": "同盟", "directed": false, "color": null, "excludes": ["hostile"] },
    { "id": "hostile", "label": "敌对", "directed": false, "color": null, "excludes": ["ally"] }
  ],
  "edges": [
    { "id": "rel-0001", "from": "char-linyuan", "to": "char-shenyi",
      "type": "master-apprentice", "note": "",
      "since": { "year": 1339, "month": null, "day": null },
      "until": { "year": 1350, "month": 3, "day": 2 },
      "causeEventId": "evt-0007" },

    { "id": "rel-0004", "from": "char-linyuan", "to": "char-shenyi",
      "type": "hostile", "note": "师门决裂",
      "since": { "year": 1350, "month": 3, "day": 2 },
      "until": null,
      "causeEventId": "evt-0007" },

    { "id": "rel-0002", "from": "char-shenyi", "to": "org-qingyun",
      "type": "member-of", "positionId": "pos-1", "note": "",
      "since": { "year": 1300, "month": null, "day": null }, "until": null },

    { "id": "rel-0003", "from": "char-linyuan", "to": "item-qingfeng",
      "type": "owns", "note": "拜师所赠",
      "since": { "year": 1340, "month": null, "day": null }, "until": null }
  ]
}
```

`from`/`to` 只放 id，不限制实体类型，因此人物↔组织、人物↔物品天然支持。

#### 关系随时间变化怎么处理

关系不是静态属性，是**带时间的量**。所以这里不存"当前关系图"，只存一段段**区间边**——任意时刻的关系状态都是查出来的。

三条语义约定：

- **`since` 含、`until` 不含。** 相邻区间因此首尾相接：上例 `rel-0001`（师徒）终于 1350-03-02，`rel-0004`（敌对）始于同一刻，交接处不重不漏。
- **`until: null` = 到故事"已写进度"为止仍然成立**，不是"永远"——后面还没写。
- **一次变化 = 闭合旧边 + 开新边。** 永不原地改写一条边的类型，否则那段时间的历史就没了。

**关系变化挂到时间轴事件上**（`causeEventId`）。上面两条边都指向 `evt-0007`，于是"关系为什么变了"有出处，时间轴视图也能把事件和它引发的关系变动画在一起。

**关系网视图因此需要一个时间游标。** 默认停在最新已写进度，可拖到任意时刻或跳某一章，图按那一刻重绘；双击一条边显示它的变化史（1339 拜师 → 1350 决裂）。

**必须区分两种"变化"，混起来会出问题：**

| | 例子 | 怎么处理 |
| --- | --- | --- |
| **故事内的变化** | 剧情推进，林渊叛出师门 | 闭合旧边 + 开新边，是数据 |
| **作者改设定** | 你觉得"师徒"不合适，改成"养父子" | **直接改写那条边本身**，旧版本交给 git |

如果把"作者改设定"也做成新增区间，时间轴上就会凭空多出一段看起来像剧情的关系变化——而它其实只是你在编辑。版本历史是 git 的职责，数据模型不重复做。

`types[].excludes` 声明互斥关系（同盟与敌对不能同时成立），让这类约束也是数据驱动的，而不是写死在代码里。

### 4.9 `outline/timeline.json` — 时间轴

```json
{
  "calendar": { "epochLabel": "创世历", "start": { "year": 1000, "month": 1, "day": 1 },
                "end": { "year": 1500, "month": 12, "day": 31 } },
  "lines": [
    { "id": "tl-main", "name": "主线", "kind": "main", "order": 0 },
    { "id": "tl-north", "name": "北境线", "kind": "branch", "order": 10 }
  ],
  "events": [
    {
      "id": "evt-0007", "lineId": "tl-main",
      "at": { "year": 1345, "month": 3, "day": 2 }, "atLabel": "",
      "spanEnd": null,
      "title": "青云山崩",
      "outlineRef": "out-0012",
      "characters": ["char-linyuan"], "places": ["place-qingyunshan"],
      "impact": "……", "order": 0
    }
  ]
}
```

`kind` = `main`（主时间轴）| `branch`（支线），对应原文"新建时间线要与主时间轴区分"。`spanEnd` 非空表示这是一个"时段"而非"时点"。`atLabel` 用于无法精确到日的事件（"三年前"）。

### 4.10 `outline/outline.json` — 剧情大纲

```json
{
  "nodes": [
    { "id": "out-0001", "parentId": null, "kind": "volume", "title": "第一卷 青云山下", "order": 10, "summary": "" },
    { "id": "out-0012", "parentId": "out-0001", "kind": "chapter", "title": "第十二章 山崩", "order": 120,
      "summary": "……", "timelineRef": "evt-0007", "chapterId": null }
  ]
}
```

**大纲与时间轴是两条轴，不能合并。** 大纲按*叙事顺序*（读者看到的先后），时间轴按*故事内时间*。两者在倒叙、插叙时会不一致——这正是"在大纲里放时间轴"最容易踩的坑。所以各存一份，靠 `timelineRef` / `outlineRef` 双向挂钩；时间轴视图把大纲节点渲染成一条派生泳道，看起来"在一起"，底层不混。

`chapterId` 非空表示该大纲条目已落成正文。

### 4.11 `draft/ch-0001.md` — 章节正文

YAML front matter + Markdown 正文。正文用 Markdown（人可读、git diff 可读）；结构信息进 front matter，不污染正文。

```markdown
---
id: ch-0001
title: 第一章 青云山下
order: 10
status: draft
volumeRef: out-0001
outlineRef: null
characters: [char-linyuan]
places: [place-qingyunshan]
summary: ""
---

正文……
```

- `order` 用**间隔整数**（10、20、30），中间插章取 15，避免全书重编号。
- `status` = `draft | revised | final`。
- `characters` / `places` 是显式清单，供一致性校验逐条核对；不在正文里做内联标记（`@林渊` 之类会污染正文，留作后续可选增强）。
- **不存字数**（原则 2，由宿主端计算）。

### 4.12 `views/layout.json` — 手工摆位

```json
{
  "graphs": {
    "relations": { "positions": { "char-linyuan": { "x": 120, "y": 300 }, "char-shenyi": { "x": 220, "y": 180 } } }
  },
  "mapView": { "centerX": 800, "centerY": 400, "zoom": 1.0 }
}
```

这是**用户资产**（手工拖出来的布局），必须持久化，不能当派生数据丢掉；但它和实体分离，所以重新布局不影响任何设定。

---

## 5. 引用完整性

宿主端负责守这些不变量，违反即拒绝写入并返回可读原因：

| 不变量 | 说明 |
| --- | --- |
| 引用必须存在 | `characters: [char-x]` 里的 `char-x` 必须在 `characters.json` 里 |
| 禁止删除被引用实体 | 删人物前先看谁引用它，列出引用者让用户决定 |
| `parentId` 不成环 | 组织、分类、地点、职位、大纲五处都要查 |
| 时间可排序 | 同一时间轴上 `at` 不能为空对象 |
| id 唯一 | 跨文件全局唯一 |
| **同对同类型区间不重叠** | 同一 `(from, to, type)` 可有多段区间（决裂后复合），但不得重叠；允许留空档 |
| **区间起点早于终点** | `since` 必须早于 `until`（`until` 为 `null` 除外） |
| **互斥类型不同时成立** | `types[].excludes` 声明的类型，在同一对实体上的区间不得相交 |
| **开区间不悬在已故者身上** | 人物 `status` 为 `dead` 后仍有 `until: null` 的关系 → 警告，不阻断（传承、遗泽一类关系合法） |

后四条是"关系随时间变化"带来的，它们同时也是**时间游标渲染**的正确性前提：区间一乱，任意时刻的图都不可信。

这些检查同时服务于 `novel-consistency` 技能——技能负责"语义"一致性（性格突变、伏笔未回收），宿主端负责"结构"一致性（引用悬空、成环）。分工清楚，不重复。

---

## 6. 已确认的决定

1. **地点（`places.json`）加入。** 地图打点与章节涉地需要宿主实体；一致性校验据此可查"地点对不上"。
2. **人物年龄存出生时间**（`born`），需要时按时间轴推算；`ageNote` 承担"外观二十出头"这类模糊描述。**前置条件：日历必须先定下来**，否则年龄无从推算——因此建项目时就要写入默认日历。
3. **物品归属、组织人员用关系边**，不存字段。统一、可表达流转与历史，且不与关系网形成两个真相源。
4. **删除策略为"硬删 + 引用检查"**，不做回收站，避免 AI 引用到"看似存在"的幽灵。
5. **Front matter 用 YAML**，插件引入 `js-yaml` 依赖（本环境已有插件在用，验证可用）。

### 由此产生的 Phase 1 前置任务

- 插件需要一个 `node_modules`：`pnpm add js-yaml`（工作区内安装，宿主端从 junction 解析得到），并确认本机 pnpm 可用。
- 建项目时必须一并写入默认日历（`calendar`），否则第 2 条的年龄推算没有基准。

---

## 7. 结构演进：改结构有多贵

分三档，成本差一个数量级。

| 档 | 典型例子 | 成本 |
| --- | --- | --- |
| **加自定义信息** | 人物卡上加一条"性格" | **零**：写进 `custom`，不改代码、不改 schema、不迁移 |
| **提升为一等字段** | "性格"要所有人必填、要能筛选、要参与一致性校验 | **低**：写一条幂等迁移，把 `custom.性格` 搬到 `personality` |
| **改形态或语义** | 年龄从数字改成出生时间；关系从人物内部拆成独立文件；大纲与时间轴合并 | **高**：批量转数据，部分需人工判断（如"27 岁"是哪个时间点的 27 岁） |

**提升规则**：`custom` 只放标量。一旦某个信息需要**类型约束、校验、筛选、或参与关系**，就该提升为一等字段。

因此定模型时真正要慎重的，只有那几处**形态选择**——年龄怎么存、关系放哪、大纲与时间轴是否合并——而不是字段清单。字段清单随时能长。

### 界面上的自定义信息

详情面板是 schema 驱动的，所以"新建一条信息"是**用户在界面上直接做的事，不需要改代码**：人物卡底部有一个自定义信息区，可增删任意键值对，写进 `custom`。日后该信息提升为一等字段，那条数据被迁移到基础信息区，**内容不丢，只是界面位置变了**。

**限制（诚实说明）**：`custom` 里的信息对 AI 是隐形的——`novel-consistency` 只校验一等字段与显式规则。想让 AI 也管"性格前后矛盾"，就得把它提升为一等字段。
