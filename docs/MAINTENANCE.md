# 接手这个仓库

**给「下一个会话」或「下一个人」看的**。目的只有一个：让一个**没有任何上下文**的助手在十分钟内能安全地改这个插件。

> 如果你是一个 AI 助手，正在一个新的会话里读到这里：**先跑第 1 节的四条命令**，再读第 3 节的架构图和第 4 节的不变式。
> 第 8 节有一段可以直接粘贴的开场白。

---

## 0. 怎么开一个新会话（给作者自己看的）

- **快捷键 `Ctrl+N`**，或者**侧栏最上面那个带「新对话」图标的按钮**（悬停显示「新建会话」，按钮上就标着快捷键）。
  两者都调 `session.new`，键位在 `dsh-client-ui-workspace` 里注册为 `"KeyN" + ["primary"]`（primary 在 Windows 上就是 Ctrl）。
- **会话的工作目录跟着工作区走**，所以只要还在本仓库这个工作区里，新会话就自动是同一个项目。
  新会话里第一件事应该是 `pwd` 确认一下 —— 第 9 节的开场白已经写了这一步。
- **切换回旧会话**：侧栏的会话列表，或搜索会话（`session.search`）。**这个会话不会消失**，随时可以回来 ——
  但它已经被压缩过，细节会随压缩减少，所以**别把会话当记忆**（见第 9 节末尾）。

---

## 1. 三十秒上手

```powershell
cd D:\documents\GitHub\my-project

# 跑四套测试（411 项，约 30 秒）。全绿才动代码。
tools\run.cmd impl-selftest.mjs
tools\run.cmd api-selftest.mjs
tools\run.cmd client-selftest.mjs
New-Item -ItemType Directory -Force .verify | Out-Null   # live-check 要求这个目录【存在】
tools\run.cmd live-check.mjs      # 需要宿主在跑；会在 .verify/ 里建临时项目

# 改完客户端后必须重建（宿主半不需要，改动下次请求即生效）
tools\run.cmd build-client.mjs

# 打包（它自己会先跑前三套，红了就拒绝打包）
tools\run.cmd package-plugin.mjs
```

> **`live-check.mjs` 不能连跑两次** ✓ 它会在 `<cwd>/.verify/` 建出一个真项目并写章节，
> 而**第二次它会主动拒绝启动**（`process.exit(2)`）✓ 这是**保护**，不是缺陷 ✓
> 它防的是有人把仓库根当参数传进去 —— 那会写进作者真实的 `novel/` ✓
> 三个坑：
> - 拒绝信息打在 **stderr** 上 ✗ 不在 stdout ✓ 所以 `| Select-String 'OK|FAIL'`
>   这类过滤会**什么都看不到**，只留下一个光秃秃的 `exit 2` ✓ 看起来像"跑了但没输出" ✗
> - 于是**四套连跑**这个固定动作第二次会**假红** ✓ 不是代码坏了 ✓
> - **反过来删掉 `.verify` 也会红** ✗ 它要求这个 root **存在**（`root defaults to <cwd>/.verify`
>   **and must be an existing directory**）✓ 删掉会得到 `0 passed, 10 failed`，
>   看起来比"拒绝启动"更像是插件坏了 ✗ 要重跑就先
>   `Remove-Item -Recurse -Force .verify` **再** `New-Item -ItemType Directory .verify`
>   （或只删里面的 `novel/`）✓

**`tools\run.cmd` 是什么**：这台机器上的 Node 不在 `PATH` 里，一切都要用固定的 node 路径启动 ✓ `run.cmd` 就是那层包装 ✓ 直接 `node xxx.mjs` 会找不到 node ✓

**宿主半 vs 客户端半的生效方式不同**，这点很省时间：
- `lib/**`（宿主）—— **下次 HTTP 请求就生效** ✓ 不用重启、不用重建 ✓
- `client/src/**`（客户端）—— **必须 `build-client.mjs`** ✓ 然后**刷新页面** ✓（客户端插件有 HMR，但只有 `pnpm run dev:web` 在跑时才自动重载 ✓）

---

## 2. 这个仓库是什么

一个 **DeepSeek Harness 插件**，给长篇小说作者用：三栏界面、地图、时间轴、人物/物品/地点/组织的关系网、章节正文、导出全书、纯文本批量导入、把一章交给 agent 写。

- 插件挂在 profile 里是靠 **junction**：`D:\dsh-home\profiles\desktop\node_modules\dsh-novel` → 本仓库 ✓
- 所以本仓库的改动**立刻生效** ✓ 这也是为什么「打包」是独立的一步（见 `INSTALL.md`）✓
- 它同时是一个**真实在用的作品仓库**：`novel/` 里有一位作者正在写的小说 ✓ **改代码时不要动 `novel/`** ✓（测试用的是临时目录 ✓）

---

## 3. 架构地图

### 宿主半 `lib/`（13 个模块，Node 侧，能读写文件）

| 文件 | 干什么 |
|---|---|
| `lib/index.js` | 入口：`ctx.inject` 逐个绑定可选服务（`workspaceRegistry` / `llm` / `sessionController`），注册 `/dsh-novel` 前缀路由。**服务分开绑定**：合成一个会让缺一个服务就整个插件消失 |
| `lib/impl/router.js` | **74 KB，路由 + 大部分业务逻辑**。所有 handler 在这里；改接口先看它 |
| `lib/impl/paths.js` | **路径围栏**：`resolveInside` 拒绝越界、junction 逃逸、符号链接。任何写盘都要过它 |
| `lib/impl/store.js` | 读写 + `keepPrevious`（`.prev` 备份）+ 原子写 |
| `lib/impl/schema.js` | 文档清单（`FILES`）、数据目录（`DATA_DIR`） |
| `lib/impl/frontmatter.js` | 章节 YAML front matter（唯一的外部依赖 `js-yaml` 在这） |
| `lib/impl/validate.js` | 全书校验器（接口会返回 `issues`） |
| `lib/impl/scaffold.js` | 新建项目时的目录与文件骨架 |
| `lib/impl/text.js` | `countWords`——**字数的唯一实现**，编辑器和导出都用它 |
| `lib/impl/prompt.js` | 生成用的模型目录与提示词 |
| `lib/impl/context.js` | 给模型写 prompt 时读**项目里已有的用词**（「让新条目读起来像同一本书」） |
| `lib/impl/chapter-context.js` | 某一章的上下文拼装 |
| `lib/impl/manuscript.js` | **导出全书**的纯函数（叙事顺序、空章节保留、`skipped` 报告） |

### 客户端半 `client/`

**没有打包器**：`tools/build-client.mjs` 把 `client/src/*.js` **按文件名排序**拼成**一个** factory 闭包 ✓

| 片段 | 干什么 |
|---|---|
| `10-core.js` | 宿主访问、共享选择、小组件原子 |
| `20-schema.js` | `ENTITIES`（实体与字段描述符）、`mintId`、`idSegment` |
| `30-form.js` | 表单：`FieldControl` / `FieldLabel` … |
| `35-generate.js` / `36-templates.js` | 模型生成 / 本地模板生成 |
| `40-tree.js` | 通用的树（分类 + 条目） |
| `45-graph.js` | 关系网 |
| `50-timeline.js` | 时间轴 |
| `60-shell.js` | 外壳：三栏、`ViewBoundary`（渲染错误的兜底） |
| `62-agent.js` | 交给 agent 写这一章 |
| `65-map.js` | **地图（约 5200 行，全在这一个文件）** |
| `66-import.js` | 纯文本批量导入（含 schema 驱动的字段解析） |
| `68-export.js` | 导出全书的界面 |
| `70-branches.js` | 各分支的界面与装配 |
| `90-apply.js` | 把组件挂到宿主接口上（**新建组件要在这里导出**） |

**拼接的两个后果**（踩过多次）：
- `const` **不跨片段提升** ✗ —— 片段 A 不能用片段 B 里 `const` 定义的东西（`function` 声明会提升 ✓）。**片段顺序就是文件名顺序** ✓
- 整个闭包**零依赖**，只能 `require('react')` ✓；不能用 `import`/`export` ✓（构建工具会拒绝）

### 工具 `tools/`

| 工具 | 干什么 |
|---|---|
| `run.cmd` | 用固定 node 路径跑任意 `.mjs` |
| `impl-selftest.mjs` / `api-selftest.mjs` / `client-selftest.mjs` / `live-check.mjs` | 四套测试 |
| `build-client.mjs` | 拼客户端 |
| `package-plugin.mjs` | 打包（自己写 tar.gz，自带验证） |
| `patch-asar.mjs` / `wait-and-patch.mjs` / `apply-host-patch.cmd` | 宿主 asar 的长度中性补丁（见第 7 节） |
| `render-map.mjs` | 不开浏览器看地图（`--svg --paper <主题>`） |
| `asar-find.mjs` / `asar-peek.mjs` / `asar-entry.mjs` | 读安装好的 DSH 的 asar（**查宿主真实行为的主要手段**） |
| `agent-smoke.mjs` | 端到端试一次「交给 agent」 |

---

## 4. 必须先知道的八条不变式

这些是我在这个项目里**反复踩到同一类坑**之后固化下来的规则 ✓ 违反它们不会报错 ✓ 只会**静默地**做错事 ✓

1. **规范化保留，只有显示才替换**
   `normalizeX` 永远不把缺省值写进数据 ✓ 缺什么就显示什么 ✓ 把显示用的兜底写进数据会造成「一个值两个含义」✓

2. **同一份列表要有两个视图**
   例如地图路径：`mapPaths`（绘制用，≥2 点）vs `mapAllPaths`（编辑用，保留 1 点的草稿）✓ 规范化必须用后者 ✓ 否则用户画到一半的点会被悄悄丢掉 ✓

3. **`objectList` 只用于对象列表，永远不用于标量**
   它只保留 record ✓ 会**静默丢掉**字符串、数字、坐标对 ✓ —— 这个坑我踩了**三次**（符号图章的坐标点对、导入的名字列表、还有一次）✓

4. **新建实体的形状只能有一个来源**
   一切都走 `childNodeFor(spec, entity, parentId, taken)` ✓ 它和「＋新建」按钮用的是同一个 ✓ 手写第二条构造路径必然漂移 ✓
   注意 `mintId` **只检查 `taken`、从不登记** ✓ 一次建多个（如批量导入）必须自己 `taken.add(id)` ✓

5. **写进用户文档的字段必须是 schema 声明过的**
   `if (!(key in node)) continue` ✓ 否则会写进一个没有表单能编辑、校验器也不认识的键 ✓

6. **字段名要对着路由本身核对，不要对着"看起来合理的形状"**
   已经踩过两次：`/sessions` 返回 `sessions`（我读 `items` ✗，选择器永远是空的 ✓）、`/agent/prompt` 读 `text`（我发 `prompt` ✗，每次 400 ✓）✓ **两者都不报错** ✓

7. **会话事件要求「无损 JSON 可序列化」**
   比 JSON 严格：**值为 `undefined` 的字段会被拒绝**（JSON 会丢键，往返就不是同一个值）✓
   `controller.prompt` **必须带 `requestId`** ✓（宿主用它构造 `source.rpcId`；漏了就是 `rpcId: undefined` → 整个事件写不进去 → 报成 `session/agent-busy` + "非 JSON 可序列化"）✓ **这条我误判成宿主缺陷过** ✗ 见第 7 节 ✓

8. **没有浏览器，所以决定要下沉到纯函数**
   `renderToString` **不跑 effect、不跑 handler、没有盒模型** ✓ 所以 fetch 驱动的组件在测试里永远只能渲染 loading ✓
   做法：**分支主体的逻辑抽成 props 驱动的 `*Body`**，界面只负责取数 ✓ 所有判断都放进纯函数 ✓ 这样离线测试才能断言真实行为 ✓

---

## 5. 验证纪律（这个仓库最值钱的部分）

**每条守卫都必须证明「把 bug 种回去它会失败」** ✓ 而且**要确认种对了地方** ✓

我在这里吃过几次教训，都是同一类：
- 种 bug 用的字符串替换**静默没生效**，却打印了 "planted" ✗ → 于是「验证通过」是假的 ✓
- 守卫**看起来在守、实际没覆盖** ✗ —— 我断言了 `h(ManuscriptExport, { root: props.root })`（调用点**是对的** ✗）而真正的 bug 是**上一级没传 `root`** ✗ → **两个按钮全都没反应，测试却全绿** ✓
- **在注释里找代码** ✗ / **断言 React 的 `key`** ✗（SSR 标记里永远不出现 key ✓）

**现在的规矩**：
- 种回验证用**编辑工具**改代码 ✓ 不用 PowerShell 字符串替换 ✓（转义失败过一次 ✓）
- 守卫发现**读不懂**它要检查的东西时，必须**判失败** ✓ 而不是跳过 ✓
  （例：`ChapterBody` 的 `list`/`editor` 槽位如果不是字面量也不是它能解析的局部赋值 → **直接 FAIL** ✓）
- 断言要**对着源码/真实路由**核对 ✓ 不要对着"合理形状" ✓

**测试分布**：`impl` 88 项（纯逻辑）· `api` 72 项（真实 HTTP）· `client` 241 项（纯函数 + 源码结构审计）· `live` 10 项（真的建项目、写章节、写盘再读回）

---

## 6. 这台机器 / 这个沙箱的坑

| 坑 | 表现 | 办法 |
|---|---|---|
| **管道 stdio 被禁** | `spawn` 带 pipe → `EPERM` | 用 `stdio: 'inherit'` 或 `'ignore'` ✓ 或直接读文件 ✓ |
| **DSH 运行时锁住 asar** | 关掉窗口没用，托盘进程还在 → `EPERM` | `tools\apply-host-patch.cmd`（等锁释放）✓ **绝不要自己 kill DSH** ✓ |
| **没有 npm / pnpm** | 装不了包 | 自己写（打包器就是为此自己实现了 tar.gz）✓ |
| **Node 不在 PATH** | `node` 找不到 | `tools\run.cmd` ✓ |
| **Node 版 zstd 只解一帧** | 会话 `.jsonl.zstd` 只读出 1 条 | 别去解压会话日志 ✓ 用 `controller.inspect` ✓ |
| **无法截图浏览器** | 「the browser produced no screenshot」 | 像素效果只能由作者判断 ✓ 我用 `render-map.mjs --svg` 产出可看的文件 ✓ |
| **`.cmd` 必须 CRLF** | LF 的话 `%~dp0` 一类会出问题 | 有测试逐文件守住 ✓ |
| **Electron 没有 `prompt/confirm/alert`** | 调用即报错 | 有测试扫描全部片段守住（注释先剥掉）✓ |
| **`Number(null) === 0`** | 缺失的时间戳算成 1970 → 「56 年前」 | 用 `typeof x === 'number'` 严格判断 ✓ |
| **`String(42)` 会变成名字** | 一个叫「42」的人物 | 非字符串一律拒绝 ✓ |
| **插件按「裸名」加载会把宿主搞崩** ✗ | 同名插件从 npm 装进来，把 `@deepseek-ai/dsh-*` 旧版核心包当**普通依赖**拉进 profile 顶层 → **遮蔽宿主自带的运行时** → `dsh-app-boot` 的 peer 检查逐行禁用它们 → **宿主连崩 27 分钟** | 注册**用绝对路径** ✓ 见下 ✓ |
| **`nodeLinker: hoisted`** ✗ | profile 的依赖全被抬到顶层 `node_modules`，冲突插件因此能越过宿主自带包 ✓ 是上面那条的放大器 | profile 的 `pnpm-workspace.yaml` **不要**设它 ✓ 默认的 isolated linker 把依赖留在各自子树里 ✓ |

### 为什么插件注册要用绝对路径

`@deepseek-ai/dsh-client-modules/lib/index.js` 只分两条路：

```js
name: isAbsolute(loaderName) ? pathToFileURL(loaderName).href : new URL(loaderName, baseUrl).href
...
try { return { path: createRequire(baseUrl).resolve(`${expectedPackageName}/package.json`) } } catch { return }
```

- **裸名**（`name: 'dsh-novel'`）→ 走 `createRequire(baseUrl)`，**也就是 profile 的 `node_modules`** ✓ 谁能往那儿装东西，谁就能换掉宿主加载的代码 ✗
- **绝对路径**（`name: 'D:/…/lib/index.js'`）→ 走 `pathToFileURL`，**根本不查 `node_modules`** ✓

所以本插件在 profile 的 `cordis.patch.yml` 里是这样注册的：

```yaml
- insert:
    - id: dsh-novel
      name: 'D:/documents/GitHub/my-project/lib/index.js'
```

**三条配套纪律**（少一条就会重演那次故障）：
1. **不要**把 `dsh-novel` 写进 profile `package.json` 的 `dependencies` ✓ 本仓库是 `0.0.1`，写 `^0.1.1` 之类的范围会让 pnpm 去 npm 装**同名包** ✗
2. **不要**把它加进 `dsh.profile.bundles` ✓ 那条路同样经 `node_modules` ✓
3. 插件自己的 `package.json` **不要**声明 `@deepseek-ai/dsh-*` 的 peer/dependency ✓ 本插件 `peerDependencies` 为空，所以 `evaluatePluginCompatibility` **根本没有东西可评估** ✓

**改完必须冷启动才算验证过** ✓ 刷新页面只重载渲染进程，**不重读插件注册** ✗

---

## 7. 当前状态、已知限制

- **Phase 1–6 都完成了** ✓ 详见 `README.md` 的 `## 当前状态`（那里是权威的清单 ✓ 本节只讲重点）
- **agent 那条路是通的** ✓ 需要**两个条件**：
  1. 宿主打过补丁（让 `prompt` 的 `signal` 参数可选）—— `tools\apply-host-patch.cmd` ✓ 补丁已在真实安装里生效 ✓
  2. 调用**必须带 `requestId`** ✓（见第 4 节第 7 条 ✓ 有测试守住 ✓）
- **`docs/host-bug-session-controller-prompt.md` 有一段是我的误判** ✗：我曾把「漏传 `requestId`」写成宿主缺陷 ✓ 文档顶部已更正 ✓ **读那份文档时先读顶部的更正** ✓
- **i18n 不做** ✓（作者只要中文 ✓ 已明确决定 ✓）
- **有意推迟**：汇流变宽、图章/文字旋转、多行文字、六边形网格、导入 CSV/JSON、导出 Word（`office-docx` 技能可用 ✓）

---

## 8. 怎么改（常见任务）

| 想做什么 | 从哪下手 |
|---|---|
| 加一个侧栏分支 | `70-branches.js` 的 `BRANCHES` + 一个 `*Body` 组件；在 `90-apply.js` 导出 |
| 加一个实体种类 | `20-schema.js` 的 `ENTITIES`（字段描述符带 `label`/`type`/`options` ✓ 表单、导入、校验都会跟着走 ✓） |
| 加一个宿主接口 | `lib/impl/router.js` 的 handler + 路由表；`api-selftest.mjs` 加一条 |
| 改地图工具 | `65-map.js`（纯函数在文件上半部分 ✓ 手写 SVG 在下面 ✓ 命中和导出共用同一套几何 ✓） |
| 改数据模型 | **先读 `docs/data-model.md`** ✓ 再改 `schema.js` + `validate.js` + 技能文档（有测试防漂移 ✓） |
| 加一个技能 | `.dsh/skills/<名>/SKILL.md` ✓ 注意有测试断言技能只引用真实存在的字段与 id 前缀 ✓ |

**改完的固定动作**：四套测试 → `build-client.mjs` → 刷新页面 → 作者看一眼像素/手感 ✓

---

## 9. 换一个会话接手时，直接粘贴这段

> 接手 `D:\documents\GitHub\my-project`（一个 DSH 小说插件）。
> **第一步先确认 `pwd` 就是 `D:\documents\GitHub\my-project`** —— 会话的工作目录跟着工作区走，
> 不在这个目录里的话下面所有命令都会找不到文件。
> 然后读 `docs/MAINTENANCE.md`：第 1 节跑四套测试确认基线全绿，第 3 节是架构图，
> 第 4 节是八条必须遵守的不变式，第 5 节是验证纪律（每条守卫都要种回验证过）。
> 宿主半改 `lib/**`（下次请求即生效），客户端半改 `client/src/**`（必须 `tools\run.cmd build-client.mjs` 再刷新页面）。
> 不要动 `novel/`（那是作者的作品）。要跑任何命令都用 `tools\run.cmd`。
> 现在请先跑一遍测试，然后告诉我结果和你打算做什么。

**为什么这样比「把整个会话留着」可靠**：
- 会话会被**压缩**（这个项目已经被压缩过一次 ✓ 细节在那一步就丢了 ✗）✓ 而且不能无限延长 ✓
- 而**测试、注释、文档活在仓库里** ✓ 411 项检查把每一个决定和每一个踩过的坑都编码进去了 ✓ 改错了会**失败** ✓
- 所以：**仓库是记忆 ✓ 会话是工作台** ✓ 工作台可以换 ✓ 记忆不会丢 ✓
