# DSH 内核 API 参考（dsh-auto-archive 插件依赖面）

> 作者：A（kernel-scout）。版本：2026-10-26，对应 DSH Desktop **0.2.1-rc.3**（`@deepseek-ai/*` 内核包同版本）。
>
> **证据等级**（全文统一使用）：
> - **【源码】**：从 app.asar 抽取到 `tools/kernel/<pkg>/` 的真实源码/README，行号可复查。
> - **【实测】**：在临时 `DSH_HOME` + scratch profile 上跑 CLI 得到的观察结果。
> - **【参照】**：从已安装的第三方插件（`~/.dsh/profiles/desktop/node_modules/dsh-meme`）反推的运行时行为。
> - **【未核实】**：推断或仅凭文档，落地前需要 Lead 在真实安装环境确认。
>
> 抽取方法：`tools/extract-pkgs.mjs` 从 `app.asar` 的 `dsh/node_modules/@deepseek-ai/<pkg>` 还原源码到 `tools/kernel/<pkg>/`。
> 本仓库不重新分发内核包；`tools/kernel` 只是离线阅读副本。

---

## 0. 结论速览（B/C 只需要看这一节也能开工）

| 问题 | 结论 |
|---|---|
| 服务名 | `webServer`、`sessionPersistence`、`sessions`、`workspaceRegistry`、`sessionProjectionCache`（**全部小驼峰，均已源码确认**） |
| 投影缓存删除 | `ctx.sessionProjectionCache.requireTable().delete(id)` → `Promise<boolean>`；不存在返回 `false` 不抛错 |
| 归档 | `await ctx.workspaceRegistry.archiveSession(id)`；有活动会话抛 `WorkspaceActiveSessionError`（**不要**传 `stopActivity:true`） |
| 枚举会话 | `await ctx.sessionPersistence.list()`；materialized 条目含 `formatStatus`/`sizeBytes`，**pending 条目没有这两个字段** |
| 标题 | `ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])` → `{asOfSeq, values:{title}}` 或 `undefined` |
| 路由 | `ctx.webServer.register({kind:'prefix', path:'/dsh-auto-archive', handler(req,res)})`，返回 disposer |
| 生命周期 | `ctx.effect(() => { ...; return disposer }, 'label')`，热重载/禁用时宿主调用 disposer |
| 本地 `file:` 插件能否 `import '@deepseek-ai/*'` | **能**（运行时由启动器的 internal loader 解析，不依赖 profile `node_modules`）；但本插件 host 侧**不需要**这么做，C 侧 `require('react')` 由 ModuleLoader 提供 |

---

## 1. 插件加载机制与 `@deepseek-ai/*` 解析

### 1.1 启动链

`D:\programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` 实际执行：

```
set ELECTRON_RUN_AS_NODE=1
"DeepSeek Harness.exe" --expose-internals "app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

- **`--expose-internals` 是关键**：启动器据此把 `internal` loader 挂到 Cordis 的 `ctx.loader` 上。
- 因此所有通过 `dsh.cmd` 启动的实例（`dsh web` / `dsh headless` / `dsh --profile <name>`）都具备同一套模块解析能力。

### 1.2 插件入口是怎么被 import 的

`tools/kernel/../cordis-plugin-loader`（抽取副本在 `%LOCALAPPDATA%\Temp\dsh-kernel-extra\tools\kernel\cordis-plugin-loader`）`lib/index.js:215-226`：

```js
import(name, getOuterStack) {
  if (name.startsWith('cordis:')) return builtins[name]
  if (this.ctx.loader?.internal) return this.ctx.loader.internal.import(name, baseUrl, {})
  return import(name)          // 兜底：普通 Node ESM 解析
}
```

⇒ 插件包里的裸 specifier（包括 `@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`）**由 internal loader 解析**，与插件自己所在目录的 `node_modules` 无关。

### 1.3 实证

- profile `C:\Users\M\.dsh\profiles\desktop\node_modules\@deepseek-ai\` 下**只有** `cosmokit`、`dsh-brand`、`schemastery` 三个包。
- 但已安装并正常工作的 `dsh-meme/index.js:16` 是 `import { defineTool } from '@deepseek-ai/dsh-tools'`，其 `package.json` 只把它声明为 `peerDependencies`。
- ⇒ 若按 Node 的 `node_modules` 解析，这个 import 必然失败；实际能跑，只能是启动器 internal loader 提供映射。**【参照】**

### 1.4 对本插件的实际要求

- **host 半边**（`plugin/index.js`、`plugin/lib/**`）：目前只 import `node:*` 内置模块 —— 最安全，零解析风险。若将来要 `import { Service } from '@deepseek-ai/cordis'`，按 1.2 的机制**可行**，但无必要（插件用 `export const name/inject/apply` 的函数式入口即可，`dsh-meme` 就是这样）。
- **client 半边**（`plugin/client.js`）：不写 `import`，用 ModuleLoader 的 `factory(require)`；`const React = require('react')` 由宿主注入。**不要**在 client 里 `import '@deepseek-ai/*'`。
- 结论：**本地 `file:` 插件与市场安装插件在模块解析上无差别**；限制只来自 profile 的 pnpm 安装与 `dsh.profile.bundles` 接线。

---

## 2. `ctx.sessionPersistence`（会话持久化）

包：`tools/kernel/dsh-session-persistence`（抽象契约）+ `tools/kernel/dsh-session-persistence-jsonl`（默认 JSONL+zstd 实现）。
服务名：**`sessionPersistence`**。

### 2.1 方法

```ts
await create(header: SessionHeader): Promise<SessionHandle>       // 建新会话日志
await open(id: string, mode: 'write' | 'read'): Promise<SessionHandle>
await stat(id: string, options?: { signal?: AbortSignal }):
    Promise<{ header, revision, sizeBytes?, formatStatus? } | undefined>
await list(options?: { signal?: AbortSignal }):
    Promise<SessionSnapshot[]>                                     // 无分页、无过滤
await flush(): Promise<void>
```

`list()` 实现：`tools/kernel/dsh-session-persistence-jsonl/lib/index.js:2604`；`stat()`：`:2571`。

### 2.2 `list()` 快照字段（**逐字**）

| 来源 | 字段 |
|---|---|
| 已落盘（materialized） | `{ header, formatStatus, revision, sizeBytes }` |
| 本进程新建、尚未落盘（pending） | `{ header, revision }` —— **没有** `formatStatus` / `sizeBytes` |

- `formatStatus`：`'current' | 'migration-required'`（`dsh-session-persistence/README.md:66`；provider 可以不提供）。
- `revision`：branded opaque string（`SessionPersistenceRevision`），**不是数字**，不能比较大小、不能 `+1`。
- `sizeBytes`：number。
- 插件枚举会话时**必须容忍 `formatStatus === undefined` 与 `sizeBytes === undefined`**（CONTRACT §2.1 漏写了这一点，已在本文件纠正）。

### 2.3 `SessionHeader` 字段（`tools/kernel/dsh-session/lib/types/index.js:26` `validateSessionHeader`）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `version` | number | ✅ | 必须 `=== 4`（`SESSION_FORMAT_VERSION`） |
| `id` | string | ✅ | 必须等于会话 id |
| `createdAt` | number | ✅ | 非负安全整数（**毫秒**时间戳） |
| `isSeeded` | boolean | ✅ | 是否 fork/seed 出来的会话 |
| `cwd` | string | ❌ | 必须是**绝对路径** |
| `parentSession` | string | ❌ | |
| `origin` | `'subagent'` | ❌ | 只允许这个字面量 |
| `delegationDepth` | number | ❌ | 非负安全整数 |
| `agentPreset` | string | ❌ | |
| `type` | `'session'` | ❌ | **不在校验器里**；真实存储的 header 常见（CONTRACT 实测），但插件**不要依赖**它 |

- 禁止出现 `seedLength` 字段（会抛错）。
- 校验器对未知字段放行（`deepFreeze` 后返回），所以前向兼容字段不会让插件崩。
- 会话 id 形态不统一（`session-<uuid>` 或裸 uuid），**一律按原样字符串使用**。

### 2.4 错误类型（导出符号）

`SessionAlreadyExistsError`、`SessionAlreadyOwnedError`、`SessionFormatUnsupportedError`、`SessionHandleClosedError`、`SessionOwnershipLostError`、`SessionPersistenceCorruptionError`、`SessionPersistenceNotFoundError`、`SessionReadOnlyError`。
**没有删除/保留（retention）API** —— 内核不提供删会话日志的方法，这正是本插件只删投影缓存的原因。

### 2.5 磁盘布局（只读，用于兜底算 mtime）

```
<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd
```

- `projectKey(cwd)`：工作目录的稳定编码；无 cwd 的会话落在 `_no-cwd`。
- 文件名随格式版本/压缩而变：`session.jsonl`（v0）、`session.vN.jsonl`、可带 `.zstd`。
- **只 stat 文件取 `mtimeMs`，不要读内容**（CONTRACT §6.1 硬约束）。B 的实现 `plugin/lib/sessions.js` 已按 `session(?:\.v\d+)?\.jsonl(?:\.zstd)?` 正则扫描，正确。

---

## 3. `ctx.sessions`（活动会话注册表）

包：`tools/kernel/dsh-session`；服务名 **`sessions`**；`SessionStore extends Service`，`super(ctx, "sessions")`（`lib/index.js:1740`）。

```ts
ctx.sessions.get(id): LiveSession | undefined    // lib/index.js:1981
ctx.sessions.list(): LiveSession[]               // 创建顺序
ctx.sessions.create(...) / fork(...) / flush(session)
```

- `ctx.sessions.get(id) !== undefined` ⇒ 会话**正在本进程内存里活着**（有活动句柄）。
- 注意：这**不是**判断「有 turn 在跑」的权威依据；权威依据是 `workspace/session-activity` waterfall（见 §4.3）。本插件只用它做粗筛，最终由 `archiveSession` 的活动检查裁决。

---

## 4. `ctx.workspaceRegistry`（工作区 + 归档/置顶）

包：`tools/kernel/dsh-workspace`；服务名 **`workspaceRegistry`**；`super(ctx, "workspaceRegistry")`（`lib/index.js:377`）；`inject: ["storageDomain", "sessionPersistence"]`。

### 4.1 读方法

```ts
get(id): Workspace | undefined                                   // :446
list(): Workspace[]                                              // :455，同步，按展示顺序
get archivedSessionIds(): string[]                               // :507，归档顺序
get pinnedSessionIds(): string[]                                 // :569，最近置顶在前
```

`Workspace` 实体（`tools/kernel/dsh-workspace/src/types.ts`，编译产物同义）：

| 成员 | 说明 |
|---|---|
| `id` | `WorkspaceId`（branded string） |
| `path` | 规范化后的真实路径（realpath） |
| `title` | 显示名 |
| `createdAt` / `updatedAt` | ISO 字符串 |
| `sessionIds` | getter，该工作区**已记账**的会话 id（按 header 的 cwd 反查） |
| `status` | 目录状态（存在/缺失等） |

### 4.2 归档/恢复/置顶

```ts
await archiveSession(sessionId, options?: { stopActivity?: boolean }): Promise<void>   // :527
await unarchiveSession(sessionId): Promise<void>                                      // :554
await pinSession(sessionId): Promise<void>                                            // :579
await unpinSession(sessionId): Promise<void>                                          // :599
```

`archiveSession` 精确行为（`lib/index.js:527`，逐条）：

1. 已归档 → **直接 return**（幂等，不写盘、不做存在性检查）。
2. `!await this.sessionKnown(sessionId)` → 抛 `WorkspaceUnknownSessionError(sessionId, "archive")`。
3. 若 `options.stopActivity !== true`：
   ```js
   const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
   if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
   ```
4. `setState({ ...state, archivedSessionIds: [...state.archivedSessionIds, sessionId], pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId) })` —— **归档会同时清掉置顶**（同一次持久化写）。
5. 若 `stopActivity === true`：再 `await this.stopSessionActivity(sessionId)`（派发 `workspace/session-stop`）。

`unarchiveSession`：**不做存在性检查**；未归档时 no-op；只把 id 从集合里移除，**不恢复原来的置顶**（README:118）。

`pinSession`：会话必须「已知且未归档」，否则抛 `WorkspaceArchivedSessionPinError`。

错误类：`WorkspaceUnknownSessionError`、`WorkspaceActiveSessionError`（实例上有 `.activity`，形如 `[{kind, items}]`）、`WorkspaceArchivedSessionPinError`、`WorkspaceOrderInvalidError`、`WorkspaceMoveInvalidError`。

### 4.3 活动检查的语义与边界（README:104）

- `workspace/session-activity` 是 **waterfall**：每个 provider 回答「这个会话还有什么在跑」，键由 provider 自定义（`SessionActivityKindMap` 由本包留空）。
- 已装配的 provider：Agent registry（运行中的 turn）、job registry（owned jobs）、Subagent runtime（运行中的后代）、Schedule 插件（活动提醒）。
- **活动检查与归档写不是原子步骤**：两者之间启动的 turn 会被「隐藏」；该窗口约等于一次持久化写延迟（实践中一个 model step）。这是内核承认的已知限制，插件无需处理，但文档里要写清楚。
- ⇒ 本插件**必须**保持 `archiveSession(id)` 不传 `stopActivity`（CONTRACT §1），遇到 `WorkspaceActiveSessionError` 记 `skipped: 'active'`。

### 4.4 持久化

- domain：`workspace`，**version 2**；表 `workspaces`（key = WorkspaceId，record `{path,title,sessionIds,createdAt,updatedAt}`）+ 一个全局 state：
  ```json
  { "initialized": true, "defaultWorkspaceId": "...", "workspaceIds": ["..."],
    "archivedSessionIds": ["..."], "pinnedSessionIds": ["..."], "pendingMutation": null }
  ```
- 磁盘文件：`<DSH_HOME>/storages/workspace.json`（storage-json 后端，domain 级单文件）。
- 归档状态**只写这个文件**，不删任何会话数据。

---

## 5. `ctx.sessionProjectionCache`（投影缓存）★ 唯一允许删除的东西

包：`tools/kernel/dsh-session-projection-cache`；服务名 **`sessionProjectionCache`**；`super(ctx, "sessionProjectionCache")`（`lib/index.js:377`）；`inject: ["storageDomain", "sessionProjections", "sessions"]`。

### 5.1 读

```ts
cachedSnapshot(meta, keys?: string[]): { asOfSeq: number, values: Record<string, unknown> } | undefined
cachedPredecessorTitle(meta): 同上（只可能含 title）| undefined
recordFor(id, expected?): CheckpointRecord | undefined     // 同步
```

`cachedSnapshot`（`lib/index.js:193`）：

- `meta`：传 `sessionPersistence.list()` 里那条的 **`header`**（或任何带同样生命周期字段的对象）。
- 生命周期身份由 `lifecycleIdentityOf(header)` 计算（同文件）：
  ```js
  { formatVersion: header.version, createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    isSeeded: header.isSeeded }
  ```
  **`version` 对应 `formatVersion`**，别传错。
- `keys` 省略 ⇒ 返回全部可用 key。
- 返回 `asOfSeq` 是所服务行里**最低**的 watermark；`values` 只含版本/schema 匹配的行。
- 返回 `undefined` 的情形：没有记录、生命周期不匹配、当前格式下无可用行、表未初始化。**必须容忍 `undefined`**，插件应回退到直接读投影 json（见 5.4）。
- 同步、零 I/O（内存表）。

### 5.2 表句柄（删除入口）

```ts
requireTable(): KvTable          // lib/index.js:357，公开
```

- 表未初始化（`this.table === undefined`，只在 `[Service.init]` 里赋值）时抛
  `new Error('session projection cache is not initialized')`。
- 返回 `domain.table('sessions')`，方法：

| 方法 | 返回 | 说明 |
|---|---|---|
| `get(key)` | `T \| undefined` | 同步，内存 |
| `entries()` / `keys()` / `size` | | |
| `put(key, value)` | `Promise<void>` | 持久化后更新内存 |
| `delete(key)` | `Promise<boolean>` | **不存在返回 `false`（不抛）**；存在则 `unit.deleteRecord` → 删内存 → 发 `domain/changed` `{operation:'deleted'}` |
| `update(key, fn)` | `Promise<T>` | |

`delete` 实现见 `dsh-storage-domain` 的 `KvTableImpl`（`delete` 内先 `if (!this.records.has(key)) return false`，再 `await this.host.unit.deleteRecord(...)`）。

⇒ 插件清理动作（CONTRACT §6.3）：
```js
const table = ctx.sessionProjectionCache.requireTable()
const existed = await table.delete(sessionId)   // false = 本来就没有缓存，不算错误
```
**只需删这一行**，不要自己 `rm` 目录；`delete` 负责持久化与内存一致。

### 5.3 磁盘布局与记录格式

- domain：`session_projcache`，**version 7**，`compatibleVersions: [3,4,5,6]`，`invalidRecords: 'backup-and-skip'`，`layout: 'per-record'`，表 `sessions`。
- 根：`dshHomePath('storages')` ⇒ 文件 **`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`**。
- 记录（README:62-68 + 实测）：
  ```json
  { "version": 7,
    "record": {
      "identity": { "formatVersion": 4, "createdAt": 1793000000000, "cwd": "C:\\work\\x", "isSeeded": false },
      "rows": { "title": { "ver": 1, "seq": 195, "val": "标题" }, "...": { } } } }
  ```
- 非法/过期记录会被**移到 `<id>.json.bak.<stamp>`**（`backup-and-skip`），不会直接删 —— 所以插件删 `<id>.json` 是安全的，且 `.bak` 文件不属于插件清理范围（不要动）。

### 5.4 兜底读标题（当 `cachedSnapshot` 不可用时）

CONTRACT §6.1 要求两级兜底，与内核行为一致：

1. `ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])?.values.title`
2. 直接读 `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val`
3. 再失败 → 用 id

B 的实现 `plugin/lib/sessions.js` 已有 `titleFromProjectionCache` / `titleFromProjectionFile` / `resolveSessionTitle`，签名与上述一致。

---

## 6. `ctx.webServer`（HTTP 路由）

包：`tools/kernel/dsh-host-webserver`；服务名 **`webServer`**；`WebServer extends Service`。

### 6.1 注册

```ts
register(route: {
  kind: 'exact' | 'prefix',
  path: string,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
}): () => void                      // 返回 disposer（lib/index.js:327）
```

- 重复 `(kind, path)` **抛错**（`webserver: duplicate ...`）—— 组合级契约，撞车即配置错误。
- 匹配顺序：exact 全表 → 最长 prefix → fallback handler。
- handler 抛异常：若未发 header → 回 400；已发 header → destroy socket；只记 warn，**不会杀进程**（README:72）。
- 还有 `registerUpgrade({path, handler})`、`registerFallback(handler)`（只允许一个）、`tapIndex(html => html)`、`collectIndexInjections()`、`renderIndex(html)`。

### 6.2 服务暴露的绑定事实

```ts
ctx.webServer.host      // 配置的具体 IPv4/IPv6 字面量
ctx.webServer.port      // 实际监听端口（配置 0 时是 OS 分配值）
ctx.webServer.protocol  // 'http:' | 'https:'
ctx.webServer.getOrigin()  // 本地客户端可访问的根 URL；未绑定前抛错
```

配置 schema（`lib/index.js:252`）：`host` **必填且拒绝 wildcard**（`0.0.0.0`/`::` 直接 load 失败，理由：会把 RCE 暴露到网络）；`port` 必填 0-65535；`tls` 可选 `{certFile,keyFile}`；`compression`/`compressionLevel`/`compressionThresholdBytes` 有默认值。

### 6.3 本插件用法（CONTRACT §5）

```js
const webServer = ctx.webServer ?? ctx.get('webServer')
ctx.effect(() => webServer.register({ kind: 'prefix', path: '/dsh-auto-archive', handler }), 'dsh-auto-archive/api')
```

- `prefix` 路由会让 `/dsh-auto-archive/api/*` 全部进来，插件自己做子路由与 404/405。
- **回环防护**必须做（CONTRACT §5）：`Host` 头不是 `127.0.0.1` / `localhost` / `[::1]` / `::1` → 403。注意 webserver 本身**不**做这层校验，它只负责把请求交给你。
- 热重载/禁用时 disposer 移除路由；务必放进 `ctx.effect`。

---

## 7. `ctx.logger` 与 `ctx.effect`

### 7.1 logger（Cordis 4.0.5 内建 `LoggerService`）

```ts
ctx.logger: Logger | ((name?: string) => Logger)
logger.info/warn/error/debug(...args)
```

- 可直接 `ctx.logger.warn(...)`（用当前 fiber 名），也可 `ctx.logger('name')` 取命名 logger。
- 参数支持：`Error` 作首参（打印 stack）、printf 风格 `%s %d %o`、任意对象。
- 内核源码里广泛使用：`dsh-host-webserver/lib/index.js` 的 `this.ctx.logger.warn(...)`。
- 本插件约定：优先 `ctx.logger`，否则 `console.warn` 带 `[dsh-auto-archive]` 前缀；不得静默吞错。B 的 `createLogger` 已实现降级。

### 7.2 effect（可清理资源）

```ts
ctx.effect(setup: () => (() => void | Promise<void>) | AsyncGenerator | void, label?: string): () => void
```

- `setup` 立即执行；其返回值（disposer）在 fiber 销毁/插件卸载/热重载时被调用。
- disposer 可以是同步函数、`async () => { ... }`、或 async generator（`yield` 清理步骤）。
- 内核用法示例：`tools/kernel/dsh-host-webserver/lib/index.js:412` `await this.ctx.effect(async () => {...})`；`dsh-client-ui-settings/README.md:41` 明确「调用方持有返回的 disposer 并把它包进 `ctx.effect`」。
- 本插件必须放进 effect 的东西：**HTTP 路由**、**定时器**（`setTimeout` 首巡 + `setInterval`）、client 的 `<style>` 注入。

---

## 8. Client 半边（浏览器）

### 8.1 加载协议（照抄 `dsh-meme/client.js` 实证）

```js
window.__ModuleLoader__.load({
  id: 'dsh-auto-archive',          // 必须 === 包名 / loader entry 名
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    // ...
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
```

- **`id` 必须与包名一致**，否则 ModuleLoader 报 `loaded without registering <id>`（dsh-meme 注释实证）。
- `require` 由宿主注入，可 `require('react')`；**不要**在这里写 ESM `import`，也不要 import `@deepseek-ai/*`。
- `apply(ctx)` 是插件入口；`inject` 声明依赖的服务名（client 侧常见 `slots`、`workspaces`、`conversation`）。
- client 侧拿到的是**浏览器 ctx**：`ctx.get('slots')`、`ctx.effect(...)`、`ctx.logger` 可用；**没有** Node API、没有 `sessionPersistence`。

### 8.2 slots API（设置页注册）

```js
const slots = ctx.get('slots')
if (!slots) return
slots.inject('settings.section', () => slots.register(
  { name: 'settings.section', id: 'auto-archive', order: 60, label: '自动归档' },
  () => React.createElement(Panel, { ctx }),
))
```

- `slots.inject(slotName, registerFn)`：等该 slot 类型可用后调用 `registerFn`，返回的 disposer 由 slots 服务管理（可再包 `ctx.effect`）。
- `slots.register(meta, render)`：
  - `meta.name`：slot 类型名，必须与 `inject` 的第一个参数一致；
  - `meta.id`：**在同一个 slot 内唯一**的贡献 id（不同 slot 可用同名 id，dsh-meme 就是 `meme-picker` 用了两次）；
  - `meta.order`：排序，数字小的靠前（`settings.section` 里 dsh-meme 用 25）；
  - `meta.label`：设置页导航显示名；
  - `render()`：返回 React 元素；某些 slot 会传 props（如 `conversation.input.overlay` 收到 `{inputActions, useInput, ...}`）。
- 可用 slot 类型（已验证）：`settings.section`、`conversation.input.left`、`conversation.input.overlay`；`dsh-client-ui-settings/README.md:45` 还列出 `settings.plugins.tab`、`settings.onboarding`、`sidebar.settings`（外壳，别抢）。
- 设置页 slot 的注册细节由 `@deepseek-ai/dsh-client-ui-settings` 声明（`tools/kernel/dsh-client-ui-settings/README.md:43-45`）。

### 8.3 client 声明（package.json）

```json
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-settings"],
    "platform": "web"
  }
}
```

- `dsh.client.platform` 必须是 `"web"`；`dsh.client.inject` 列出**非 baseline** 的 client 模块请求，宿主据此决定 bundle 加载顺序（`dsh-client-modules/README.md`「Declaring a client plugin」）。
- 包必须 `exports` 出 `"./client": "./client.js"`（ModuleLoader 按此取 bundle）。
- 客户端 bundle 无构建步骤：直接一个 `client.js`，`window.__ModuleLoader__.load(...)` 注册工厂，bundle 执行时只注册工厂、不跑副作用。

---

## 9. 包清单与补丁约定（安装期契约）

包：`dsh-package-manifest`、`dsh-plugin-manager`、`dsh-host-plugin-inventory`。

### 9.1 `package.json` 的 `dsh` 字段

| 字段 | 含义 |
|---|---|
| `dsh.manifestVersion` | 清单格式版本，当前 `1` |
| `engines.dsh` | 支持的 DSH 版本 SemVer range（安装期兼容检查用） |
| `dsh.bundle.patch` | 一个路径或**有序路径数组**（相对包根），安装时合成进 profile 的 `cordis.patch.yml` |
| `dsh.client` | 见 §8.3 |

### 9.2 profile 接线

- profile `package.json` 里有两处：
  - `dependencies`: `"dsh-auto-archive": "file:..."`（或版本号）；
  - `dsh.profile.bundles`: 包名数组 —— **patch 只对列在这里的包生效**。
- 安装 = `pnpm add` + 追加 `bundles`；`dsh plugin --profile <name> add <source>` 会自动做这两步（【实测】，见 `docs/install.md`）。
- 补丁语法（CONTRACT §8）：
  ```yaml
  - insert:
      - id: dsh-auto-archive
        name: dsh-auto-archive
  ```
  `id` 是 Cordis row id（与包名一致即可），`name` 是包名。

### 9.3 版本兼容检查

`dsh-plugin-manager` 安装时读包自己 `package.json` 的 `engines.dsh` / `peerDependencies` 做兼容检查；本插件 `engines` 只声明 `node>=22`，未声明 `engines.dsh`（【未核实】这是否会触发「无法校验」告警——Lead 安装时留意 `dsh plugin` 输出即可，不影响功能）。

---

## 10. 未核实 / 风险清单（交给 Lead 收口）

| # | 事项 | 状态 | 影响 |
|---|---|---|---|
| 1 | scratch profile 里**真正 boot** 并加载本地 `file:` 插件（`@deepseek-ai/cordis` 解析 + patch 合成 + `/plugins` 客户端 bundle） | 【未核实】Lead 正在做（autoarchive-e2e profile） | 若失败，安装机制需换方案（如直接手写 profile package.json + pnpm install） |
| 2 | `dsh plugin --profile <name> install`（无参数）行为 | 【未核实】只验证了 `add` | 回滚步骤里用它重建；失败可退回手写 package.json + `pnpm install` |
| 3 | desktop profile 是应用独占管理：运行中改 `package.json`/`cordis.patch.yml` 是否会被覆盖或需要重启 | 【未核实】 | 最终安装必须「先关 DSH → 改 → 启动」 |
| 4 | 非 ASCII 路径（本仓库的中文路径）作为 `file:` 源是否可用 | 【未核实】只用 ASCII 临时路径测过 | 最终安装建议先 `pnpm pack` 成 tgz 再装，或复制到 ASCII 路径 |
| 5 | client bundle 在真实 GUI 中加载（`/plugins` 路由、ModuleLoader id 匹配、settings.section 出现） | 【未核实】只有 dsh-meme 的同构实证 | C 的 client.js 必须逐字对齐 §8.1 |
| 6 | `cachedSnapshot` 在「会话从未产生 projection 写」时返回 `undefined` 的概率 | 【源码】确定会 | 标题必须走两级兜底（§5.4） |
| 7 | 真实 `workspace.json` 里 `archivedSessionIds` 的现有值 | 只读检查过格式，未记录具体值 | 插件只追加/移除，不重写整个数组语义 |

---

## 11. 证据来源索引

| 主题 | 文件 |
|---|---|
| Cordis loader 解析 | `%LOCALAPPDATA%\Temp\dsh-kernel-extra\tools\kernel\cordis-plugin-loader\lib\index.js:215-226` |
| 插件管理器/清单 | 同上 `dsh-plugin-manager/README.md`、`dsh-package-manifest/README.md` |
| 持久化抽象 | `tools/kernel/dsh-session-persistence/README.md`、`lib/index.js` |
| 持久化 JSONL 实现 | `tools/kernel/dsh-session-persistence-jsonl/lib/index.js:2571,2604`、`README.md:86` |
| SessionHeader 校验 | `tools/kernel/dsh-session/lib/types/index.js:26` |
| 活动会话 | `tools/kernel/dsh-session/lib/index.js:1740,1981`、`README.md:33-38` |
| 工作区/归档 | `tools/kernel/dsh-workspace/lib/index.js:377,446,455,507,527,554,569,579,599`、`README.md:102-118` |
| 投影缓存 | `tools/kernel/dsh-session-projection-cache/lib/index.js:193,357,377`、`README.md:60-68` |
| 存储域表实现 | `%LOCALAPPDATA%\Temp\dsh-kernel-extra\tools\kernel\dsh-storage-domain\lib\index.js`（`KvTableImpl.delete`） |
| Web 服务器 | `tools/kernel/dsh-host-webserver/lib/index.js:252,327,412`、`README.md:60-72` |
| Client slots | `C:\Users\M\.dsh\profiles\desktop\node_modules\dsh-meme\client.js`（`slots.inject/register` 调用点）、`tools/kernel/dsh-client-ui-settings/README.md:41-45` |
| 客户端加载协议 | `dsh-meme/client.js` 的 `window.__ModuleLoader__.load({...})` |
