# AGENTS.md

**这是地图，不是规则书。** 先按下面编号顺序走，需要细节时再点链接。

本仓库装三样东西：

1. **DSH 插件**（宿主端 `lib/` + 浏览器端 `client/`）—— 小说的界面与项目读写；
2. **技能**（`.dsh/skills/`）—— 给 AI 的写作、校验、文风、评审指令；
3. **作品数据**（`novel/`）—— 两边共读共写的同一份小说，**只在本机，不进 Git**。

三样东西靠 `novel/` 里的同一份数据耦合：AI 写的章节界面能直接看到，界面改的设定 AI 下次能读到。
插件是「人侧」，技能是「AI 侧」。

## 开工步骤

1. **读 [`docs/data-model.md`](docs/data-model.md)。** 它定义 `novel/` 在磁盘上长什么样、四条原则与不变量，是本仓库的第一入口。
2. **判断改动属于哪一侧**（决定改哪个目录、要不要重新构建）：
   - 宿主端逻辑与路由 → `lib/impl/`（`lib/index.js` 是刻意压薄的壳，只有它在改动后**必须重启宿主**）；
   - 浏览器端界面 → **`client/src/`**（按序号拼接；改完**必须**跑 `node tools/build-client.mjs` 重新生成 **`client/client.js`**——它是生成物，**要提交**，但只能由构建写：手改会被下次构建覆盖，也会被自测抓住）。生效方式是刷新页面；`lib/impl/` 的改动下一次请求即生效，只有 `lib/index.js` 需要重启宿主；
   - 技能指令 → `.dsh/skills/<name>/SKILL.md`（agent 直接写文件，**没有校验闸门**，字段名必须精确）；
   - 测试 / 工具 → `tools/`。
3. **改完跑 `npm test`。** 一条命令跑 `impl` + `api` + `client` 三套离线自测，全绿才算完。
   改了 `client/src/` 就**先**跑 `node tools/build-client.mjs` 再测：`client-selftest` 会断言已提交的 `client/client.js` 与源码一致，忘了重建会直接失败。
   README 的「[测试](README.md#测试)」一节写着四套的用例数分布，`client-selftest` 会拿它和真实运行数对账——**增删用例要同步改 README**。
   push / PR 之后同一组三套会在 CI 上再跑一遍（[`.github/workflows/selftest.yml`](.github/workflows/selftest.yml)）；CI 红了就是真的红了，不要去改断言让它变绿。
4. **涉及真实 HTTP / 运行中的宿主时，再跑 `npm run test:live`。** 它需要宿主在跑，并且会把临时项目写进 `<cwd>/.verify`（它**拒绝**指向已含 `novel/project.json` 的目录）。
   要对运行中的宿主复验安全栅栏：`npm run security -- <http://127.0.0.1:端口/dsh-novel> <一个新的空目录>`。
5. **提交前**用自己的眼睛过一遍 `git status` —— 产物清单见下面的禁令。

`npm` / `node` 若不在 PATH 上，用 `tools\run.cmd <script.mjs> [args...]` 兜底（它会自己去找 node）。细则见 README 的「[怎么跑这些测试](README.md#怎么跑这些测试)」。

## 硬性禁令

- **不手改 `client/client.js`。** 它是 `tools/build-client.mjs` 从 `client/src/` 生成的产物（没有打包器，是有意为之）。`client-selftest` 会断言它与源码一致，手改必挂。
- **不碰 `novel/`。** 那是作者的本地作品数据，已被 `.gitignore` 排除，测试一律用临时目录。

## 不要做的事

- **不要为了变绿放宽断言。** 要改行为，先改断言的理由，并写进 README。
- **不要引入打包器。** 宿主每个插件只服务一个 `window.__ModuleLoader__.load()` bundle，`build-client.mjs` 正是为此存在。理由见 README「客户端为什么没有打包器」。
- **不要把产物提交进库**：`node_modules/`、`.pnpm-store/`、`.verify/`、`*.tgz`、`*.prev`、`*.bak-*`、`.dsh/{sessions,storage,cache}/`。完整规则以 [`.gitignore`](.gitignore) 为准；拿不准时 `git status --short` 看一遍再 `git add`。

## 去哪里找什么

| 想知道 | 看 |
| --- | --- |
| 数据形状、`novel/` 的文件清单、迁移策略 | [`docs/data-model.md`](docs/data-model.md) |
| 哪些自测在测什么、为什么要这样测 | README「[怎么跑这些测试](README.md#怎么跑这些测试)」「[自测](README.md#自测)」 |
| HTTP 端点清单 | README「[接口](README.md#接口)」 |
| 安全模型（Host/Origin 栅栏、路径围栏） | README「[安全模型](README.md#安全模型)」——这里不复述 |
| 写正文 / 查矛盾 / 定文风 / 评审一章 | `.dsh/skills/` 下的 `novel-writer`、`novel-consistency`、`novel-style`、`novel-review` |
| node 找不到时的运行方式 | `tools/run.cmd`（注释里写了它为什么存在，以及 `%*` 与 `cmd.exe` 括号的坑） |
