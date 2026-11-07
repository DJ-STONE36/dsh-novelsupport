# 世界书 / 角色卡融合设计（草案）

**状态**：草案，未实现 · 2026-11-07
**结论先行**：把 lorebook / character card 当作**导入导出适配器**，不要让它们变成小说的第二套存储。
小说文档仍是唯一真相；第一阶段不改 schema、不新增磁盘文档、不做迁移。

## 1. 「融合」的三种含义，先分开

| 含义 | 做法 | 代价 | 建议 |
|---|---|---|---|
| **A. 格式互通** | 把小说导出成 SillyTavern 世界书 / 角色卡；把外部文件导入成小说实体 | 中 | **第一阶段做这个** |
| **B. 元数据持久化** | 在小说里保存触发词、插入位置、概率、开场白等聊天机制 | 高：新文档、迁移、校验、编辑 UI | 需要往返编辑时再做 |
| **C. 写作时使用** | 用世界书的触发规则挑选设定，注入章节/生成上下文 | 中 | 第三阶段 |

交接里说的「世界/事件/组织 对标 lorebook、人物 对标 character card」是 A 的映射，不是要求小说改用 lorebook 的存储。
如果反过来让 lorebook 成为存储，小说会立刻多出两个真相源：同一个人物的姓名/简介既在 `characters.json`，又在世界书条目里；改一处、另一处就旧了。这违反 `docs/data-model.md` 的第 1、2 条原则。

## 2. 两种外部格式，先在内部归一化

### 2.1 SillyTavern 世界书（独立文件）

独立世界书导出（v1.12+）是**对象**，条目按数字键存：

```json
{
  "entries": {
    "0": {
      "uid": 0,
      "key": ["林渊", "林澈"],
      "keysecondary": [],
      "comment": "林渊",
      "content": "……",
      "constant": false,
      "selective": true,
      "order": 100,
      "position": 4,
      "disable": false,
      "probability": 100,
      "depth": 4
    }
  }
}
```

> 上面的 `position: 4` 只是 ST 导出样例里的原值（枚举含义随版本/位置类型变化）。
> 适配器**只写**有把握的 `0`（角色定义前）/ `1`（角色定义后），其余位置保留原值并报告，
> 不猜。

### 2.2 角色卡内嵌 `character_book`（V2 / V3）

同一份设定，嵌在角色卡里时字段名全变了：`keys` / `secondary_keys` / `id` / `enabled` /
`insertion_order` / `position: "after_char"`，`entries` 还是**数组**。

| 概念 | SillyTavern 独立世界书 | 角色卡 `character_book` |
|---|---|---|
| 容器 | `entries` 对象，键是序号 | `entries` 数组 |
| 条目标识 | `uid`（数字） | `id?`（数字） |
| 主关键词 | `key` | `keys` |
| 次关键词 | `keysecondary` | `secondary_keys?` |
| 常驻 | `constant` | `constant?` |
| 启用 | `disable`（**反向**） | `enabled` |
| 插入顺序 | `order` | `insertion_order` |
| 插入位置 | 数值枚举 | `"before_char"` / `"after_char"` |
| 备注 | `comment` | `comment?` |
| 扩展 | 多数在顶层字段（`probability`、`depth`、`group`…） | `extensions` |

**所以适配器不能直接互相拷贝 JSON。** 内部先归一化成：

```ts
type LoreEntry = {
  uid: number | null
  keys: string[]
  secondaryKeys: string[]
  content: string
  comment: string
  constant: boolean
  selective: boolean
  enabled: boolean
  order: number
  position: 'before_char' | 'after_char' | 'at_depth' | 'outlet' | 'unknown'
  depth: number | null
  probability: number | null
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  extensions: Record<string, unknown>
}
```

未知位置、未知扩展字段**不猜**：保留在预览的「未映射」列表里，导出时回落到默认值。

### 2.3 角色卡 V1 / V2 / V3 与 PNG 载体

- **V1 JSON**：`name / description / personality / scenario / first_mes / mes_example`
- **V2 JSON**：`spec: "chara_card_v2"` + `data`，新增 `creator_notes`、`system_prompt`、
  `post_history_instructions`、`alternate_greetings`、`character_book`、`tags`、`creator`、
  `character_version`、`extensions`
- **V3 JSON**：`spec: "chara_card_v3"`，V2 的超集，新增 `nickname`、
  `creator_notes_multilingual`、`source`、`group_only_greetings`、`creation_date` 等
- **PNG**：JSON 的 UTF-8 → Base64 写进 tEXt chunk；V2 用 `chara`，V3 用 `ccv3`；
  两者并存时**优先 `ccv3`**。也读 `iTXt`（压缩时解压上限 2 MB）。JSON 文件根对象就是卡数据。
- **CHARX**（zip + `card.json` + 资源）**第一阶段不支持**；`assets` / 内嵌图片只保留字段、不解析资源。

### 2.4 格式探测（导入的第一步）

外部文件没有可靠的扩展名约定，所以按**结构**判断，不按文件名：

| 看到什么 | 判成 | 处理 |
|---|---|---|
| `entries` 是对象，值是含 `key`/`uid` 的条目 | SillyTavern 独立世界书 | 归一化 `key`/`keysecondary`/`disable`/`order` |
| `entries` 是数组，或根上有 `data.character_book` | CharacterBook | 归一化 `keys`/`secondary_keys`/`enabled`/`insertion_order` |
| 根上有 `spec: "chara_card_v2"` 或 `v3`，且有 `data` | 角色卡 V2/V3 JSON | 读 `data`，`character_book` 递归按上面处理 |
| 只有 `name`/`description`/`first_mes` 等 V1 字段 | 角色卡 V1 JSON | 当作 V1，缺的字段补空 |
| PNG 签名 `89 50 4E 47 0D 0A 1A 0A` | PNG 角色卡 | 取 `ccv3`，否则 `chara`；Base64 → UTF-8 → JSON |
| 其他 | 拒绝 | 报 `unsupported-interop-format`，不猜 |

两种世界书同时出现时（一个文件里既有独立 `entries` 对象又有 `data.character_book`）以
**独立世界书**为准，`data.character_book` 作为第二个来源**不合并**，在预览里报告。

## 3. 导出映射：小说 → 外部格式

### 3.1 小说 → 世界书

| 小说来源 | 条目数 | 触发词 | 常驻 | 正文（content） |
|---|---|---|---|---|
| `world.sections[]` | 1 | 标题 | 否 | `body` |
| `world.rules[]`（global） | 1 | 标题 + 标签 | **是** | `body` |
| `world.rules[]`（branch） | 1 | 标题 + 标签 + 分支名 | 否 | `body` |
| `characters[]` | 1 | 姓名 + 别名 | 否 | 外貌 / 性格 / 背景 |
| `organizations[]` | 1 | 名称 + 别名 + 类型 | 否 | 简介 + 架构（职位树） |
| `places[]` | 1 | 名称 + 类型 + 标签 | 否 | 简介 |
| `items[]` | 1 | 名称 + 标签 | 否 | 品阶 / 描述 / 来历 |
| `timeline.events[]` | 1 | 标题 + 涉及人物姓名 + 地点名 | 否 | 时间 + 影响 |
| `outline.*` / `draft/*` | **不导出** | — | — | 大纲与正文是剧透，不是设定 |

默认值（全部确定性，可测）：

- **order**：来源有 `order` 就用，否则 `100 + 序号 * 10`；常驻条目前置。
- **position**：规则/分节 `before_char`，实体/事件 `after_char`
  （独立世界书写 `0` / `1`，只写这两个有把握的值）。
- **probability**：100；**depth**：4；**selective**：false。
- **keys** 去重、去空、截断（每条最多 64 个、每个 128 字符）。
  去重后为空且本来非常驻的条目（如无标题的分节）改为**常驻**并报告——一个既没有触发词
  又不常驻的条目在聊天前端永远不会出现，导出它等于静默丢内容。
- 人物**同时**导出为世界书条目和角色卡：世界书没有人物就不完整；角色卡是另一个用途。
  若作者只要其中一个，导出对话框给开关。

### 3.2 小说 → 角色卡

| 卡字段 | 取值 | 说明 |
|---|---|---|
| `name` | `character.name` | 必填 |
| `description` | `appearance` + `background` | 用 Markdown 小标题分段，不合并成一段散文 |
| `personality` | `character.personality` | 原样 |
| `scenario` / `first_mes` / `mes_example` | `""` | **不编**。小说里没有这些聊天产物 |
| `creator_notes` | 自动一句 + 项目/人物 id | 标明来源 |
| `system_prompt` / `post_history_instructions` | `""` | 不冒充 |
| `alternate_greetings` | `[]` | 不编 |
| `tags` | `character.tags` | 原样 |
| `creator` | `project.author` | 空就空 |
| `extensions` | `{ "dsh-novelsupport": { projectId, characterId, exportedAt } }` | 命名空间隔离 |

`character_book` **第一阶段不内嵌**：它会把「人物」与「世界书」的取舍再复制一份。
需要单文件分发时，第二阶段再把该人物相关的世界书条目嵌进去。

## 4. 导入映射：外部格式 → 小说

导入必须**先预览、后落盘**，与现有的纯文本批量导入一致（`client/src/66-import.js` 的规则：
生成物先给作者看，确认后才写）。

### 4.1 一条世界书条目落在哪里

lorebook 条目没有「实体类型」这个字段，**不能自动确定**它该是人物、地点还是世界分节。
所以预览表里每条都要有一个目标类型，默认值按以下顺序判定，作者可改：

1. `comment` / `name` 与现有实体名或别名精确相同 → 建议合并/跳过，不新建；
2. 条目内容里出现「人物/地点/组织/物品」等字段标签（来自 schema 的 `label`）→ 建议对应类型；
3. 其余一律建议 **`world.section`**（自由散文），这是最不丢信息的默认；
4. 事件**第一阶段不自动建**：事件必须有一个可信的时间，lorebook 里没有。
   作者要事件，就在预览里补时间；补不了就落成世界分节。

| 目标 | 名称 | 触发词 | 正文落点 | 备注 |
|---|---|---|---|---|
| `world.section` | `comment` / 首关键词 / `条目 N` | 丢弃并报告 | `body` | 最保真 |
| `character` | 首关键词 | 其余关键词 → `aliases` | `background` | 性别/种族/状态留默认，报告 |
| `place` | 首关键词 | 丢弃并报告 | `summary` | |
| `organization` | 首关键词 | 其余 → `aliases` | `summary` | |
| `item` | 首关键词 | 丢弃并报告 | `description` | |

> 触发词不是小说 canon，**默认不持久化**。它们是聊天前端的检索参数，不是故事事实；
> 把它们塞进 `custom` 会让「作者的自定义信息」变成「另一个软件的配置」。
> 需要往返的作者可以勾选「保留触发参数到 `custom.lorebook`」（见 §4.3）。

### 4.2 重复与 id

- 已存在同名/同别名实体：默认**跳过**；可选「仍然新建」（`mintId` 加后缀）；
  「合并内容」第一阶段不做——追加到哪一段无法可靠判断，做错就是静默改稿。
- id 由宿主端 `mintId(prefix, name, taken)` 生成，`taken` 是全书 id + 本次导入已用的集合；
  前缀沿用现有：`sec-` / `char-` / `place-` / `org-` / `item-`。
- 导入按文档分次写，每个文档带上读到的 `expectedMtimeMs`；中途失败不回滚已写文档，
  但重试是幂等的（同名跳过），响应逐文档报告 created / skipped / error。
  这一点与 `/project/create` 的已知缺陷同源，不假装它是事务。

### 4.3 角色卡导入

| 卡字段 | 落点 |
|---|---|
| `name` | `character.name`（必填；空则拒绝） |
| `nickname`（V3） | `aliases`（与 name 不同时） |
| `description` | `background`（整段；不猜哪句是外貌） |
| `personality` | `personality` |
| `tags` | `tags` |
| `scenario` / `first_mes` / `mes_example` / `system_prompt` / `post_history_instructions` | **默认存 `custom["card.<字段>"]`**（字符串），预览里可勾掉 |
| `alternate_greetings` | `custom["card.alternate_greetings"]` = JSON 字符串；可勾掉 |
| `creator_notes` / `creator` / `character_version` | `custom["card.*"]`；可勾掉 |
| `character_book` | 按 §4.1 逐条导入；第一阶段不与人物建立归属关系 |
| `extensions` / `assets` | 不整包保存；预览报告未映射键，超过 32 KB 拒绝 |

角色卡 V2 规范要求编辑器**不得销毁未知键**，所以默认保留聊天字段而不是丢弃。
它们进 `custom` 后对 AI 是不可见的（`docs/data-model.md` §7 的限制），不会被误当成正文。

导出时**反向读回**这些 `custom.card.*`：同一张卡导入再导出，开场白与示例对话还在。
这是第一阶段能做到的最好的往返，且不需要新文档。

`custom.lorebook`（可选）存一条归一化后的 JSON 字符串，用于触发参数往返；
默认关闭。它不是一等字段，UI 只是一行 JSON，不提供专门的编辑器。

> **关于「custom 只放标量」**：`card.alternate_greetings` 与 `lorebook` 是**序列化后的 JSON
> 字符串**，形式上仍是标量，但语义上不是。这是第一阶段为了「不销毁数据」而接受的临时例外，
> 明确记录在这里；第二阶段把这两类提升为一等字段 / 边车文档，迁移时从这些键读出。
> 普通的 `custom` 用法仍然只放标量。

### 4.4 明确会丢什么（诚实清单）

| 来源字段 | 第一阶段 | 说明 |
|---|---|---|
| 世界书 `uid` | 丢 | 小说 id 由名字生成，不复用外部数字 id |
| 触发词（`world.section` / `place` / `item`） | 丢并报告 | 这些实体没有 `aliases` 字段；作者可勾选 `custom.lorebook` 保留 |
| 次关键词 / selective / selectiveLogic | 丢并报告 | 小说侧没有对应的检索语义 |
| `order` / `position` / `depth` / `probability` / `group` / 递归开关 | 丢并报告 | 同上；`custom.lorebook` 可保留 |
| 正则形状的 key（`/.../`） | 不塞进 `aliases`，报告 | 原样保留在 `custom.lorebook`（若勾选），不执行 |
| 角色卡 `scenario` / `first_mes` / `mes_example` / `system_prompt` / `post_history_instructions` | 默认进 `custom.card.*` | 勾掉才丢 |
| `alternate_greetings` | 默认进 `custom.card.alternate_greetings`（JSON 字符串） | 勾掉才丢 |
| `creator_notes` / `creator` / `character_version` | 进 `custom.card.*` | 可勾掉 |
| `extensions` / `assets` / `creator_notes_multilingual` / `source` / 日期 | 丢并报告 | 第一阶段不做整包保存；超过 32 KB 直接拒绝 |
| `character_book` 的「属于哪个人物」 | 丢 | 条目进世界书，第一阶段不建归属边 |

**不丢的**：条目的正文、名称、能作为人物/组织别名的触发词、角色卡的姓名/描述/性格/标签。

## 5. 磁盘与接口

### 5.1 第一阶段不新增 `FILES`

- 导入写进现有的 `setting/*.json` / `outline/timeline.json`，走 `store.js` 的**同一套原子写与
  `.prev` 备份**（不是另写一套落盘；也不经过 HTTP 的 `/document` 端点，避免多一次校验分叉）。
- 导出写进 `novel/export/`（与全书导出一致；`export/` 不在 `FILES`，校验器和章节加载器都不会扫到）：
  - `novel/export/<书名>.worldinfo.json`（SillyTavern 独立世界书）
  - `novel/export/cards/<人物 id>.json`（角色卡 V2；V3 作为第二阶段选项）
- 覆盖派生文件时保留一代 `.prev`，与现有写入纪律一致。

### 5.2 端点的候选形状

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-novel/interop/lorebook` | 返回构建好的独立世界书 JSON + 条目数 + 未映射警告（不写盘） |
| POST | `/dsh-novel/interop/lorebook` | 写进 `export/`，返回绝对/相对路径与字节数 |
| GET | `/dsh-novel/interop/character-card` | 按 `characterId` 返回卡 JSON |
| POST | `/dsh-novel/interop/character-card` | 写进 `export/cards/` |
| POST | `/dsh-novel/interop/preview` | 接收世界书/角色卡 JSON 或 PNG base64，返回归一化条目 + 建议目标 + 警告；**不写盘** |
| POST | `/dsh-novel/interop/apply` | 接收原始文件 + 预览里的选择，重新解析后写入；返回逐文档结果 |

`apply` 不信任客户端送来的「计划」，而是拿原始文件**重新解析重新计划**；客户端只送选择
（目标类型、跳过/新建、是否保留 `custom`）。这样预览与落盘不会各算一套。

### 5.3 客户端

- 世界分支加「世界书」页签：导出（选 ST 独立 / CharacterBook）、导入文件、预览表。
- 人物详情加「导出角色卡」按钮。
- 预览表用 props 驱动的纯组件（与 `BulkImport` 同型），`renderToString` 能测；
  文件读取用 `<input type="file">`，不经过网络上传，PNG 的解析交给宿主（浏览器侧不引 zlib）。
- 构建仍走 `tools/build-client.mjs`；新增片段按序号插在 `68-export.js` 与 `70-branches.js` 之间。

## 6. 安全边界

| 风险 | 处置 |
|---|---|
| 超大文件 / 解压炸弹 | JSON ≤ 2 MB；PNG ≤ 8 MB；条目 ≤ 2000；正文 ≤ 100 KB；iTXt 解压上限 2 MB |
| 原型污染 / 未知字段 | 只挑已知字段复制，不 `Object.assign` 整包；`__proto__` 一律不认 |
| PNG 结构 | 校验 8 字节签名、chunk 长度不越界、tEXt 关键字大小写不敏感、`ccv3` 优先 |
| HTML / 脚本注入 | 文本只作为文本存；客户端没有 `dangerouslySetInnerHTML`（已核）；地图 SVG 不渲染导入内容 |
| 路径逃逸 | 导出路径固定 `export/`，仍走 `resolveInside`；导入不接受路径参数 |
| 正则关键词 | 导入时原样保存为字符串，**不执行**；`/.../` 形状的键不塞进 `aliases`，只报告 |
| 网络 | 不引入远端抓取；只读本地文件 |

## 7. 分阶段

### 第一阶段（MVP，建议先做）

范围：世界书**双向**（JSON），角色卡**导入**（JSON/PNG）+ **导出**（JSON V2）；
不新增磁盘文档、不改 schema、不改校验器、不改技能。

新增/改动：

- `lib/impl/interop.js`（单文件，内部含 lorebook 归一化、卡解析、PNG tEXt、id 生成；
  不静态 import 兄弟模块，避免破坏 `lib/index.js` 的缓存穿透加载）
- `lib/impl/router.js`：6 个端点 + 路由表
- `client/src/69-interop.js`：导入/导出/预览组件
- `client/src/70-branches.js`、`90-apply.js`：挂载
- 测试：impl（归一化、往返、上限、PNG 夹具、重复/id）约 +25；
  api（端点、坏输入、不写盘预览、导出路径）约 +8；
  client（预览表、按钮、源码审计）约 +10；live（导出后导入另一个空项目）约 +3
- 文档：README 的接口表、界面表、测试数；本文件去掉「草案」

**验收**：一个真实项目的世界书导出后，能在 SillyTavern 里导入；把一个含
`character_book` 的 V2 卡导入空项目，人物与条目都出现，预览里每一条都能改目标。

### 第二阶段（需要往返编辑时）

- 新文档 `setting/lorebook.json`、`setting/character-cards.json`：**只存引用与外部参数**，
  内容仍从实体读取（像 `relations.json` 一样只引用 id）。
- 世界书页签变成真正的条目编辑器：触发词、顺序、位置、常驻、概率、启用。
- 角色卡内嵌 `character_book`、PNG 导出（需要一张封面图）、V3 选项。
- 校验器新增引用/枚举/范围检查；`novel-consistency` 的 code 表同步（有测试防漂移）。
- `schemaVersion` 升到 2，迁移幂等：先写数据文件，最后写 `project.json`。
- 从第一阶段 `custom.lorebook` / `custom.card.*` 迁移，迁移后保留一代 `.prev`。

### 第三阶段（写作时真正使用）

- `chapter-context.js`：按本章标题、梗概、大纲条目、上一章结尾匹配世界书关键词，
  把命中的条目按 `order`、预算注入；总规则仍常驻。
- `context.js`：生成实体时也用同一套匹配，而不是只给分节标题列表。
- 匹配是纯函数、可测；中文不做分词，用「包含」而不是词边界。
- 这一步才让世界书的「触发」在小说工具里有意义；前两阶段只是格式互通。

## 8. 需要作者拍板的三件事

1. **优先级**：先导出（对作者最安全，不改任何数据）还是先导入（外部素材进小说）？
   建议先导出，再把导入做成预览式。
2. **往返到什么程度**：触发参数默认不持久化（推荐）；还是第一阶段就存
   `custom.lorebook`？后者会让 `custom` 多出一行 JSON，但能原样导出。
3. **角色卡聊天字段**：默认存 `custom.card.*`（推荐，规范要求不销毁数据）；
   还是只报告丢弃？以及要不要在第一阶段就支持 V3。

## 9. 参考

- Character Card V2 规范：<https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md>
- Character Card V3 规范：<https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md>
- SillyTavern World Info 文档：<https://docs.sillytavern.app/usage/core-concepts/worldinfo/>
- 独立世界书导出格式与 `character_book` 的差异（社区核对）：
  <https://github.com/leyu6922-art/st-character-card-authoring-public/blob/main/references/formats/st-native-charcard-format.md>
- PNG 载体与 `ccv3` 优先规则（社区核对）：
  <https://github.com/davidgibbons/sillytavern-skills/blob/main/skills/character-card-v3-generator/references/image-and-asset-formats.md>
