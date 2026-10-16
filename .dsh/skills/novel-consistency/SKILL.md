---
name: novel-consistency
description: '长篇小说一致性校验。用于检查设定冲突、人物与专名矛盾、时间线与伏笔断层，并在增删改章节后核对全书自洽。当用户要求查设定矛盾、校对前文或维护设定表时使用。结构性问题交给宿主校验器，语义问题由你判断。'
---

# novel-consistency

作品数据在**工作区根的 `novel/`**。校验分两层，**不要混为一谈**：

| 层 | 谁做 | 管什么 |
|---|---|---|
| **结构** | 宿主校验器（已有实现，别重写） | 悬空引用、重复 id、环、时间区间倒置或重叠、枚举越界、空白键、front matter 坏掉 |
| **语义** | **你** | 人物行为是否出格、伏笔是否落空、专名是否前后矛盾、时间线在**正文里**是否打架 |

**事实来源优先级**：`novel/setting/` > `novel/outline/` > 已定稿正文。低优先级与高优先级冲突时，**报告冲突**，不要擅自改高优先级的那一份。

## 第一步：跑结构校验

如果 GUI 正在运行（DSH Web 界面），直接问它——它读的是同一份文件：

```
GET http://127.0.0.1:19387/dsh-novel/validate?root=<工作区绝对路径>
```

返回 `issues[]`，每条有 `level`（`error` / `warning`）、`code`、`path`、`message`、`ids`。

**若 GUI 没在跑**，就按下面的不变量自己核对你关心的部分，并在报告里说明你没跑结构校验。

### error 与 warning 的区别

- **error** = 结构性损坏。GUI 会**拒绝引入新 error 的写入**，所以一个 error 会让作者改不动那个文件——优先报告。
- **warning** = 提醒，不阻断。章节引用指向不存在的实体只是 warning（作者可能先写名字、后建人物卡）——这正是迁移路径，不是错误。

### code 对照

| code | 级别 | 含义 |
|---|---|---|
| `dangling-reference` | error | 引用了一个不存在的 id |
| `bad-reference` / `bad-reference-list` | error | 引用字段类型不对（应为字符串 / 数组） |
| `duplicate-id` | error | 同一 id 被用了两次（跨文件也算） |
| `missing-id` / `bad-id` | error | 实体没有 id，或 id 不是非空字符串 |
| `parent-cycle` | error | 父指针成环 |
| `bad-time` | error | 时间不是 `{year,month,day}`、缺 `year`、或 `month`/`day` 越界（1–12 / 1–31） |
| `interval-inverted` | error | 关系边 `since` **不早于** `until`——**相等也算**，不是只有"晚于" |
| `interval-overlap` | error | 同一对实体、同一类型的两条边时间区间重叠 |
| `exclusive-relation-overlap` | error | 互斥关系（`ally` / `hostile`）在同一时段并存 |
| `unknown-relation-type` | error | `type` 不在 `relations.json` 的 `types` 里 |
| `self-relation` | error | 边的起点与终点是同一个实体 |
| `edge-missing-id` | error | 关系边没有 id |
| `bad-enum` | error | 枚举字段取了未声明的值。含 `project.json` 的 `settings.style.status`（只能是 `proposed` / `confirmed`） |
| `blank-map-key` | error | `custom` / `attrs` 里有空键——界面上看不见也删不掉 |
| `bad-front-matter` | error | 章节 front matter 解析失败 |
| `bad-order` | error | 章节 `order` 不是数字 |
| `duplicate-position-id` | error | 职位 id 重复（同一组织内或跨组织） |
| `unresolved-chapter-reference` | warning | 章节引用的名字还没有对应实体 |
| `open-relation-to-dead` | warning | 与已故人物的关系仍未结束 |
| `position-org-mismatch` | warning | 边的 `positionId` 属于另一个组织 |
| `missing-document` | warning | `novel/` 下缺少某个文档 |
| `event-outside-calendar` | warning | 事件的 `at` **确定**落在 `calendar.start`–`calendar.end` 之外。判定保守：只写年份的时间跨整年，不会被误报 |

**`positionId` 是特例**：宿主会校验它（上面的 `position-org-mismatch`），但**界面没有这个字段的编辑控件**——`relation-edge` 的字段表里没有它。所以它只可能由你或手工编辑写入。写它之前先确认 `pos-*` 这个职位确实属于边的 `to` 所指的组织（即那条 `member-of` 边指向的组织）。

## 第二步：只做机器做不了的判断

结构校验器**故意不碰**语义（见 `docs/data-model.md` §5 的分工），所以这些是你的活。**每一条都必须先问"我有基准吗"——没有基准就说无法判定，不要硬判。**

- **人物出格**：行为与 `personality` / `background` 冲突。指名到章、到句。
  **基准为空时（三个字段都是空串）**：没有可对比的行为基准，**判"无法判定"**并披露范围。不要拿你自己的期待当基准。
- **伏笔落空**：`outline/outline.json` 里标了节拍却没有任何章节兑现；或正文埋了线索再没提起。
  **`nodes` 为空时**：没有约定回收点，**不能判"落空"**。改为报告"正文已埋的线索 + 大纲为空，所以没有任何约定回收点"——这是**范围限制**，不是缺陷。
- **专名矛盾**：同一事物在不同章用了不同名字，或新名字与已有人物/地点重名。
- **正文里的时间线冲突**：front matter 与 `timeline.json` 都对得上，但**叙述本身**自相矛盾（"三日后"与"翌日"指同一场；某人先死又出场）。
- **规则被绕过**：`world.json` 的 `rules[]` 被违反。范围的判定见下。
- **视角与文风漂移**：见 `novel-style`。

### `scope: branch` 的规则怎么判适用范围

`branch` 字段里存的是**人类可读的名字**（如「北陆」），不是 `place-*` id。生效条件：

> 该规则在**出场地点**（或叙述正在发生的地点）的 `name` **或** `kind` **与 `branch` 精确相等**时生效。

- 匹配的是 `name` **或** `kind`，两者任一相等即可（宿主生成章节背景时就是这么取的）。
- 是**精确相等**，不做包含匹配。
- **`branch` 指不到任何地点时**（没有地点的 `name`/`kind` 等于它）：这条规则**永远不会生效**。校验器不检查 `branch` 字段，所以界面不会报警——**你要报告它**，并给出三个修法之一：新建对应地点、把 `branch` 改成已有地点名、或把 `scope` 改回 `global`。**这是事实，不是推测。**
- **当前位置无法确认时**：不要默认规则适用。报告这个不确定性，并说明它是否被用来支撑了关键情节。

## 报告里的"事实"与"推测"

语义问题**没有 `code`**——`code` 是结构层的东西。所以每条语义发现写成：

```
[序号] 一句话结论 · 事实 或 推测 · 优先级
- 证据：文件#实体id + 引文（指明到章、到句）
- 最小修法：……
- 不确定处：……（推测必写）
```

**没有问题时明说"没有"**，并交代你实际检查了哪些范围。**无法判定的项也要列出来并说明为什么**——"基准为空"是一个结论，不是沉默的理由。沉默与"查过了没问题"是两回事。

## 报告方式

1. **先结构，后语义**。结构问题有确定的 id 与文件路径，先给。
2. **每条都能定位**：`code`（如果有）+ `文件#实体id` + 引文片段。
3. **给最小修法**，不是重写。作者要的是"把 `char-linyuan` 改成 `char-shenyi`"，不是重写那一节。
4. **区分事实与推测**。"这条引用不存在"是事实；"这里可能想写的是另一个人"是推测，标出来。
5. **不要自行修改正文**，除非作者明确要求修。你是校对，不是代笔。
6. 没有问题时**明说没有**，并说明你实际检查了哪些范围——沉默和"查过了没问题"是两回事。

## 设定同步

若正文里定下了一个新事实（新地名、新人物、新的力量规则）而设定文件里没有：

- **报告它，问作者要不要回写** `novel/setting/`。不要自作主张写入设定文件。
- 作者同意后再写，并遵守 `novel-writer` 里那份字段清单与 id 前缀。
- 新增实体后，**引用它的地方要改成实体 id**，否则会留下 `unresolved-chapter-reference` 警告。

## 不要做的事

- 不要重写宿主的校验器。它已经跑过了；重复实现只会得出不同结论。
- 不要把 warning 当 error 报。那会让作者去改本来正确的东西。
- 不要为了消除警告而删字段或删引用。**那只是把问题藏起来。**
- 不要检查你不确定的东西然后沉默。**不确定就写"不确定"。**
