# 宿主问题：`sessionController.prompt` 无法从插件调用

> ## 状态：**已解决** · 补丁是必要的 · **第二个「缺陷」其实是我们自己的 bug，已改正**
>
> ### 结论（2026-10-16 晚）
>
> **这条链路现在通了**：`POST /dsh-novel/agent/prompt` → **HTTP 202** → 会话真的跑了一轮 →
> `assistant/message` → `turn/end` → agent 的回复读回来了。
>
> 真正的原因有**两个**，缺一不可：
>
> | # | 原因 | 谁的 | 修法 |
> |---|---|---|---|
> | 1 | `prompt(request, signal)` 解引用一个它不可能拿到的 signal | **宿主** | `tools/patch-asar.mjs` 的补丁（`signal?.throwIfAborted()`）——**已打进真实安装并生效** |
> | 2 | **我们没传 `requestId`** | **我们的** ✗ | 传 `requestId` ✓ |
>
> ### 第二个原因：我先前误判成宿主缺陷，这里更正
>
> 第 2 个原因**不是**宿主的问题，而是本插件少传了一个字段。证据链：
>
> ```js
> // dsh-api-session-controller/lib/index.js:850  —— 宿主自己的 prompt 实现
> async prompt(request) {
>   if (!hasPromptContent(request.content)) throw ...
>   const agent = await this.resolveAgent(request.sessionId);
>   if (hasPromptRequest(agent, request.requestId)) return { accepted: true };
>   const source = {
>     kind: "user",
>     rpcId: request.requestId,          // ← 我们没传 requestId，这里就成了 undefined
>     ...
>   };
>   ...
>   if (request.mode === "steer") agent.steer(message);
>   else agent.followup(message);       // ← 真正启动这一轮
>   return { accepted: true };
> }
> ```
>
> 而会话日志在写入时要求**无损 JSON 可序列化**（比 JSON 严格得多）：
>
> ```js
> // dsh-session/lib/index.js  Session.append
> const dataSnapshot = snapshotJsonValue(data);
> if (dataSnapshot === undefined) throw new Error(`session event "${type}" carries non-JSON-serializable data`);
> ```
>
> 值为 `undefined` 的字段会被拒绝——因为 JSON 会把这个键丢掉，往返之后就不是同一个值了。
> 于是 `rpcId: undefined` 让整个 `agent/inbox/spliced` 事件写不进去，错误被包成
> `code: session/agent-busy` + `reason: session event "agent/inbox/spliced" carries non-JSON-serializable data`。
>
> 我先前把这条读成「宿主自己构造的事件有问题」✗——**那条结论是错的**，这份文档当时也这么写了，
> 现在改正：**它是我们少传一个字符串**。
>
> ### 第 1 个原因仍然是真实的宿主问题，补丁仍然必要
>
> 补丁之前，唯一可行的调用形式是**两个参数**（第二个是 `AbortSignal`），而 `AbortSignal` 无法序列化，
> 于是被同一个无损检查拒绝；一个参数则在 `signal.throwIfAborted()` 处抛
> `Cannot read properties of undefined`。**两个要求互斥，没有任何调用形式能成功**——这一条判断是对的，
> 补丁让它可选之后，单参数形式才成立。
>
> ### 最终的调用形式
>
> ```js
> await controller.prompt({
>   requestId: `dsh-novel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
>   sessionId,
>   content: [{ type: 'text', text }],
> })
> ```
>
> **三个字段全是字符串**，没有 `signal`，没有 `source`（宿主自己按 `requestId` 构造）。
>
> ### 实测到的完整一轮
>
> ```
> POST /agent/prompt            → HTTP 202  session=session-54aa2ad5-…
> GET  /agent/status            → running=true（立刻）→ 约 8 秒后 running=false
> GET  /agent/result?sinceSeq=0 → state.events 21 条，事件序列：
>     user/message, user/message, request/header, request/context, session/title,
>     session/title-llm-request, session-log-deepseek/delivery-accepted ×2,
>     assistant/message, step/end, turn/end, session/title
>   finished=true   text="收到"
> ```
>
> ### 下面各节是当时的现场记录，保留原样
>
> 第 1、1b、6、6b 节记录的**第一个**缺陷及其修法仍然有效（补丁确实必要）。其余关于
> 「第二个宿主缺陷」的推断**请按上面的更正阅读**。
>
> **补丁工具可以放心重复运行**：第二次 `--apply` 会打印 `ALREADY PATCHED` 并**什么都不写**。
>

> （会话跑在那 8 个进程里）。所以这一步只能在助手的会话之外执行。
>
> 缺陷本体、RPC 证据、源码定位与同类缺陷清单见下文。

**一句话（原始报告）**：插件持有的 `ctx.sessionController.prompt(options, signal)` 要求一个非可序列化的
`AbortSignal`，而这个调用的参数会被序列化——两个要求互斥，因此**当时没有任何参数形式能调用成功**。
Web 界面不受影响，因为它走的是带认证的 `/api/*` 路由，而不是这个服务句柄。

> **这句话现在只对一半**：补丁之后 `signal` 已可选，**单参数形式能调用进去了**
> （见顶部「第一个缺陷已修复」与「第二个缺陷」）。两个要求里只剩**序列化**那一个，
> 而它现在卡在宿主自己构造的事件上，不在调用形式上了。

| | |
|---|---|
| DSH 版本 | `0.2.0-rc.2` |
| 运行时 | node `24.21.0`, electron `44` |
| 平台 | Windows（`D:\`，NTFS，路径含反斜杠） |
| 复现者 | 第三方插件 `dsh-novel`，通过 `ctx.inject(['sessionController'], (scoped) => scoped.sessionController)` 取得句柄 |
| 复现成本 | 一次 `prompt` 调用；会创建一个会话 |

---

## 1. 最小复现

```js
// 在插件的 apply(ctx) 里
ctx.inject(['sessionController'], async (scoped) => {
  const controller = scoped.sessionController
  const { sessionId } = await controller.create({ cwd: 'D:\\path\\to\\workspace' })

  // 补丁之前的"语义上正确"的形式；现在已不需要第二参数（补丁让它可选），
  // 而它本来就是被拒绝的那一半：AbortSignal 无法序列化。
  await controller.prompt(
    {
      sessionId,
      content: [{ type: 'text', text: '只回复两个字：收到' }],
      source: { kind: 'user', rpcId: 'probe-1' },
    },
    new AbortController().signal,   // ← 补丁前必需，且正是它导致失败
  )
})
```

结果：抛出 `RemoteError`，`code: "session/agent-busy"`，
`details.reason: 'Error: session event "agent/inbox/spliced" carries non-JSON-serializable data'`。

---

## 1b. 缺陷已定位（精确定位到源码行）

RPC 声明（`@deepseek-ai/dsh-api-session-controller/lib/typert.host.js`）说明了一切：

```js
{ id: '@deepseek-ai/dsh-api-session-controller#session/prompt',
  service: 'sessionController', namespace: 'session', method: 'prompt',
  invocation: { kind: 'direct' },
  parameters: [ { name: 'request', wire: 'request', source: 'json',
                  codec: { mode: 'strict', typeSymbol: '…#SessionPromptRequest' } } ],   // ← 只有一个 JSON 参数
  cancellation: { parameter: 'signal' },                                                  // ← signal 是框架的取消参数
  result: { mode: 'strict', typeSymbol: '…#SessionPromptValue' },
  sourceLocation: { file: 'packages/api/session-controller/src/index.ts', line: 426, column: 3 } }
```

**`parameters` 里只有 `request`。`signal` 是框架层面的取消参数，不是调用方传的 JSON 参数。**
也就是说：调用方**不应该**（也无法）提供 signal，应当由框架在服务端注入。

而实现要求它必须存在：

`packages/api/session-controller/src/index.ts` 第 426 行（编译产物 `lib/index.js:3096-3099`，`lib/types/index.js:476`）：

```js
/**
 * Admit one prompt after explicitly resuming its Session.
 * @param request - Session identity, prompt content, source metadata, and delivery mode.
 * @param signal - caller cancellation before prompt admission begins.
 * @returns acknowledgement that the Agent accepted the prompt.
 */
prompt(request, signal) {
  signal.throwIfAborted();          // ← 没有空值检查
  return this.commands.prompt(request);
}
```

**为什么这是 bug 而不是"调用方用错了"**：同一个文件里其它方法全部容忍缺失的 signal ——
`list(signal)`、`retain(target, {signal})`、`nodeStatFile(path, signal)` 都写作 `signal?.throwIfAborted()`，
`list` 的文档还明确写着 *optional cancellation*。**`prompt` 是唯一一个把取消参数当必需参数的**，
而它的 RPC 声明恰恰说明该参数属于框架。

### 修法

```diff
-  prompt(request, signal) {
-    signal.throwIfAborted();
+  prompt(request: SessionPromptRequest, signal?: AbortSignal) {
+    signal?.throwIfAborted();
     return this.commands.prompt(request);
   }
```

**一处可选的问号。** 底层 `this.commands.prompt(request)` 本来就只收一个参数、完全不碰 signal
（`lib/types/commands.js:290`：`async prompt(request) { if (!hasPromptContent(request…`），
所以这一个字符就是全部所需的改动。

### 建议同时排查（同类缺陷）

凡是声明了 `cancellation: { parameter: 'signal' }`、但实现里写非可选 `signal.throwIfAborted()`
的方法都会在"直接调用且没有取消信号"时抛同样的 TypeError。已知至少还有：

- `search(query, signal)` — `signal.throwIfAborted()`
- `verifyDesktopPath(path, signal)` — `signal.throwIfAborted()`
- `control(signal)` — 流式方法，需单独判断是否应要求 signal

**更根本的修法**（二选一，推荐第二个）：

1. 把这些实现改成 `signal?.throwIfAborted()`；
2. **让框架在 `invocation.kind === 'direct'` 且调用方未提供取消信号时，注入一个真实的
   `AbortSignal`** —— 因为 `cancellation: { parameter: 'signal' }` 已经声明了这是框架的职责。
   这样声明与实现就一致了，且不需要每个方法各自防御。

### 编译产物里的位置（如果要直接改安装好的 app）

| 文件 | 行 |
|---|---|
| `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js` | 3096（`main`，实际加载的就是它） |
| `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/index.js` | 476（同源的按文件产物） |

**注意 `parameters` 的 wire 契约不用改**：它本来就只声明 `request`，现在只是让实现与契约一致。

---

## 2. 六种参数形式的实测结果

全部在**新建的空会话**上实测（因为一次失败可能留下坏的 splice，污染后续重试）：

| 调用形式 | 结果 |
|---|---|
| `prompt(options)` | `Cannot read properties of undefined (reading 'throwIfAborted')` |
| `prompt(options, {})` | `signal.throwIfAborted is not a function` |
| `prompt(options, new AbortController().signal)` | 拒绝：`non-JSON-serializable` |
| `prompt(options, { throwIfAborted() {} })` | 拒绝：`non-JSON-serializable` |
| `prompt(options, Object.create({ throwIfAborted() {} }))` | 拒绝：`non-JSON-serializable` |
| `prompt({ ...options, signal })` | `Cannot read properties of undefined (reading 'throwIfAborted')` |

`options` 恒为 `{ sessionId, content: [{ type: 'text', text }], source: { kind: 'user', rpcId } }`
——即会话日志里 `user/message` 事件的形状（见 §4），六次尝试之间**唯一的变量是第二个参数**。

## 3. 推断

1. **第二个位置参数是必需的，且会被当作 signal 使用**：传 `undefined` 报
   `reading 'throwIfAborted'`，传 `{}` 报 `not a function`，说明处理器直接对该参数调用了
   `throwIfAborted()`，且**没有默认值**。
2. **该参数必须可序列化**：任何带可调用 `throwIfAborted` 的值（真实的 `AbortSignal`、
   自有属性的函数、原型上的方法）都被拒绝，理由是会写进会话事件 `agent/inbox/spliced` 的数据里。
3. **因此无解**：需要一个方法 ⇒ 需要一个函数值;函数值不可序列化 ⇒ 被拒。

`isDSHRemoteError: true` / `name: "RemoteError"` / `rpcId` 说明这个句柄背后是**跨进程/跨边界代理**，
参数确实经过序列化，所以 #2 不是误报。

**对照**：`list()` / `create()` / `inspect()` / `cancel()` / `modelCatalog()` 全部正常
（只传普通数据、不需要 signal），所以问题**只出在 `prompt` 的 signal 参数上**。

## 4. 参照数据：一个正常工作的 `agent/inbox/spliced` 事件

从**真实会话日志**（`session.v4.jsonl.zstd`，多帧 zstd）读出：

```json
{
  "type": "agent/inbox/spliced",
  "data": {
    "target": "…",
    "start": 0,
    "inserted": [
      {
        "content": [{ "type": "text", "text": "…" }],
        "source": { "kind": "user", "rpcId": "89e8df7d-…", "clientTimeZone": "Asia/Shanghai" },
        "role": "user",
        "id": "df4cf7b3-…"
      }
    ]
  }
}
```

即：`source` / `role` / `id` 应由此路径**构造**（`id`、`role` 显然由服务端补），
而 `signal` **不属于**应该落盘的内容。

## 5. 为什么界面能发消息

Web 应用的自身路由在无凭据时返回 **401**（而不存在的路径返回 **404**）：

```
GET /            -> 401  "dsh web authentication required; reopen the URL printed by dsh web."
GET /api         -> 401
GET /api/rpc     -> 401
GET /api/sessions-> 401
GET /sessions    -> 404   ← 反例：不存在的路由不是 401
```

所以界面走的是 `/api/*`（含 `/api/rpc`），**在那条路径上证被构造/传递的方式与插件句柄不同**。
插件没有该凭据，也不应被要求持有。

## 6. 建议的修法

任选其一，第一个最直接：

1. **让 `signal` 可选，并在服务端自建默认值。**
   处理器已经会调用 `signal.throwIfAborted()`;把它改成
   `signal = new AbortController().signal`（或一个内部的、永不中止的 signal），
   插件侧的调用即可去掉第二个参数。**取消已有独立通道**：`cancel(sessionId)`，插件已经在用。
2. **接受可序列化的取消凭据**：例如 `{ sessionId, content, source, cancelToken: '<id>' }`，
   由服务端映射到内部 signal，并在 `cancel` 时中止。
3. **提供插件专用的、不经过该序列化路径的 prompt 入口**（若 #1 因分层原因不可行）。

无论选哪个，**都不要要求调用方传入 `AbortSignal` 实例**：它跨不过这个边界。

## 6b. 在源码里应用：定位与重建

```bash
# 定位（在 DSH 仓库根执行）
grep -n "signal.throwIfAborted" packages/api/session-controller/src/index.ts
```

预期命中三处以上，其中 `prompt` 的方法体在 **第 426 行**附近：

```ts
prompt(request: SessionPromptRequest, signal?: AbortSignal) {   // ← 加 ?
  signal?.throwIfAborted();                                     // ← 加 ?
  return this.commands.prompt(request);
}
```

同文件内一起改（都声明了 `cancellation.parameter === 'signal'`，却把取消参数当必需）：

| 方法 | 现状 | 改成 |
|---|---|---|
| `prompt` | `signal.throwIfAborted()` | `signal?.throwIfAborted()` |
| `search` | `signal.throwIfAborted()` | `signal?.throwIfAborted()` |
| `verifyDesktopPath` | `signal.throwIfAborted()` | `signal?.throwIfAborted()` |
| `control` | 流式，需单独判断是否应要求 signal | —— |

然后重建并重新安装，最后按 §7 验证。

### 为什么就地改编译产物与"改源码再重建"等价

不是权宜之计，而是**构建不变量**：`prompt` 所在文件里，兄弟方法**已经**是
`signal?.throwIfAborted()`（`list` 在 `lib/index.js:1889`、`retain` 在 `client.js:3196` 等都是这个形态）。

也就是说**该构建目标原生支持可选链**，编译器对 `signal?.throwIfAborted()` 的输出**就是这串字符本身**。
所以手写 `?.` 与走一遍工具链得到的字节相同 —— 不存在"改了编译产物但源码另说"的漂移风险。

（唯一的差别是源码里 `prompt` 的 `signal` 应当标成可选 `signal?: AbortSignal`，否则 TypeScript
在 `strict` 下会报"调用方可能没传";这是类型层面的，不改运行时行为。RPC 的 wire 契约本来
就只声明 `request`，所以**不需要改 schema**。）

## 6c. 为什么这次无法由助手代劳

|- 前提 | 实际情况 |
|---|---|
| 需要 DSH 源码 | **本机没有**：`D:\documents\deepseek-harness` 只是工作区目录，全盘找不到 `packages/api/session-controller/src/` |
| 需要构建工具链 | **没有**：`pnpm` / `npm` / `npx` / `yarn` 均不在 PATH，也没有源码树的 `node_modules` |
| 就地改 `app.asar` 需要可写 | **档案被锁**：DSH 运行期间以读写方式打开 `app.asar` 会被拒绝（`访问被拒绝`） |
| 关掉 DSH 再改 | **会终止助手自己**：助手的会话就跑在这 8 个 `DeepSeek Harness` 进程里 |

所以两条路都必须在**助手的会话之外**执行 —— `tools/patch-asar.mjs` 因此被设计成
"默认预演、`--apply` 才写、写前自动备份、写完回读校验"。

---

## 7. 修好之后怎么验证

`tools/agent-smoke.mjs` 是一个独立脚本，只依赖插件已注册的路由，不需要界面：

```
node tools/agent-smoke.mjs
```

现状（未修）输出 `BLOCKED` 并给出上面那张表；修好后它会走完
`prompt → 轮询 status → 读 result`，打印 agent 的回复文本与用量，并以 0 退出。

## 8. 附：为本问题而测出的服务形状（可能也有用）

```
list()              -> { items: [{ sessionId, cwd, running, blank, updatedAt,
                                   agentAvailable, projections }] }
create({})          -> { sessionId, agentPreset }          # 接受空参数；无对应的删除方法
inspect(id)         -> { meta: { id, cwd, isSeeded, agentPreset, delegationDepth, … },
                         inheritedEventCount, events: [{ type, seq, time, data }] }
modelCatalog()      -> { default: { provider, model, reasoningEffort },
                         routableProviders, groups, failures }
cancel(id)
page(id, throughSeq)            # 第二个参数是数字本身，不是选项对象
projections(<数组作为第一个参数>)  # 第二个参数不是数组；具体契约未测出
updateQueue(x)                  # 需要一个嵌套的 .kind；四种形状均报
                                # "Cannot read properties of undefined (reading 'kind')"
follow(id, ?)                   # 契约未测出
```

两点可能值得一并看看：

- **`create` 没有配对的删除/归档方法**，所以探测本身会留下无法清理的会话（本次留下 16 个空的）。
- **被拒绝的 `prompt` 会在会话里留下一个坏的 `agent/inbox/spliced`**，使该会话此后一直报
  `session/agent-busy`。失败的调用不该损坏目标会话。
