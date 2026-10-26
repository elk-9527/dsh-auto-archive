# e2e：假宿主集成验证（dsh-auto-archive）

本目录提供一个**零外部依赖、可重复、不碰真实数据**的集成脚本，用真实的
`plugin/index.js`（`apply`）跑完整业务流程：

```powershell
cd "D:\path\to\dsh-auto-archive"
node e2e/fake-host-e2e.mjs
# 退出码 0 = 全绿；失败会打印具体断言与 stack
```

当前：**65 项断言全绿**（2026-10-26，Node 24.21.0 / Windows 11）。

## 为什么用假宿主而不是真 DSH 实例

真实 DSH 实例（`dsh web` / desktop）加载本地 `file:` 插件时，裸 specifier
`@deepseek-ai/*` 由启动器的 internal loader 解析（`--expose-internals`，
见 `docs/kernel-api.md` §1）。这一步在 CI/本地脚本里不可复现，而且真实例会写
`~/.dsh` 真实数据。因此：

- **真实实例路径**由 `docs/install.md` 的「方式 A：临时 DSH_HOME + scratch profile」
  与「方式 B：desktop 安装」覆盖，由 Lead 在隔离环境执行；
- **本脚本**用假 `ctx`（只实现插件实际用到的 5 个服务 + `logger` + `effect`）+
  **真实 `node:http` 服务器** + **真实临时磁盘布局**验证插件的逻辑与 HTTP 契约；
- 假内核的每个差异都在下面「假内核与真实内核的差异」逐条列出，不假装等价。

## 覆盖场景

| # | 场景 | 关键断言 |
|---|------|----------|
| 1 | 路由注册 + `GET /api/state` | prefix 路由存在；counts `stored=9 / archived=3 / pinned=1 / eligibleArchive=3 / eligibleCache=2`；`pluginVersion=0.1.0`；config 从 `config.json` 读 |
| 2 | `GET /api/sessions` | 按 lastActivity 升序；字段齐全；标题来自 `cachedSnapshot`；pinned / protect.sessionIds 标记 `protected`；90/10 天归档会话的 `eligibleCache` 区分正确 |
| 3 | `POST /api/run {dryRun:true}` | `mode='dry-run'`；预览归档候选；**零副作用**：transcript 树、投影缓存树、`workspace.json` 哈希全不变，不写 `state.json` |
| 4 | 真跑第一轮（预算 3） | A、C 归档；活动会话 B → `skipped:'active'`；E/F 因预算 → `skipped:'limit'`；`workspace.json.archivedSessionIds` 追加；transcript / attachments 哈希不变；history=1 |
| 5 | 放宽预算后第二轮 | B 仍 active；E、F 的 projcache json 被删；G（<90d）与 A（刚归档）保留；会话目录/日志仍在；history=2 |
| 6 | `POST /api/restore` | A 恢复；未知 id 为幂等 no-op（仍计入 `restored`，见 §4.2）；`workspace.json` 移除 A；archived 3+2-1=4 |
| 7 | 安全与错误处理 | 非回环 `Host` → 403（用 `node:http` 直发，`fetch` 会覆盖 Host）；未知路径 404；`GET /api/run` 405；坏 JSON 400；`?limit=2` 生效且 `total` 仍 9 |
| 8 | 并发单飞 | 两个并发 `POST /api/run` → 一个 200、一个 409 `{ok:false,error:'busy'}` |
| 9 | effect 清理 | 触发 `ctx.effect` 的 disposer 后 prefix 路由移除，再请求 404 |

## 安全保证

- 全部数据在 `os.tmpdir()/dsh-auto-archive-e2e-*`，`finally` 中 `rm -rf`；
- 只监听 `127.0.0.1:0`（OS 随机端口），不联网；
- 不读取、不写入真实 `~/.dsh`、`desktop` profile 或任何用户数据；
- 不启动 DSH 进程，不安装插件，不改全局配置。

## 假内核与真实内核的差异（重要）

| 假实现 | 真实内核 | 影响 |
|--------|----------|------|
| `workspaceRegistry` 用内存状态 + 每次写近似 `workspace.json` | `dsh-workspace` 的 domain v2 存储、`enqueueOperation` 串行、`ctx.waterfall` 活动检查 | 归档顺序/幂等/活动抛错语义已按源码对齐；持久化格式细节不覆盖 |
| `archiveSession` 对 active 抛 `name='WorkspaceActiveSessionError'`（带 `activity`） | 同左（`WorkspaceActiveSessionError`，经 `workspace/session-activity` waterfall 收集） | 插件只按 `name`/`code`/`message` 识别，已覆盖 |
| `cachedSnapshot(meta, keys)` 用内存 Map，忽略 lifecycle identity | 真实实现按 `{formatVersion,createdAt,cwd,isSeeded}` 校验，不匹配返回 `undefined` | 插件有「快照 → projcache json → id」三级兜底，第三级在场景 2 已覆盖；identity 失效路径未覆盖 |
| `sessionPersistence.list()` 只返回 materialized 快照 | 可能返回 pending 条目（无 `formatStatus/sizeBytes`） | 插件只读 `header`/`sizeBytes?`；pending 分支未覆盖 |
| 定时器 no-op | `scheduler` 真实 `setInterval` + 首巡 60s | 调度触发、重排、dispose 停表未覆盖（dispose 停表在 [9] 间接覆盖） |
| 会话日志只按文件名 + mtime 识别 | `session.v4.jsonl.zstd` 多帧 zstd；`sessionPersistence.stat()` 读 header | 插件不解析日志内容（契约允许），只依赖路径+mtime+projcache |

## 与真实实例验证的衔接

1. 先跑本脚本（快速回归，改代码后必跑）；
2. 再用 `docs/install.md` 方式 A 在临时 `DSH_HOME` + scratch profile 装插件，
   `--dump-config` 确认条目存在，`GET /dsh-auto-archive/api/state` 确认 API 生效；
3. desktop 真实安装由 Lead 按 `docs/install.md` 方式 B 执行并验证 transcript 哈希不变。
