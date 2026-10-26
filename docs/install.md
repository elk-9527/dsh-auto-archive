# 安装、验证与回滚（dsh-auto-archive）

> 作者：A（kernel-scout）。版本：2026-10-26。
>
> 本文只写**已经在本机实测过**的步骤；未实测的步骤单独标注 **【未验证】**，并在末尾给出替代方案。
> 所有实验都在临时 `DSH_HOME` / scratch profile 里做，**没有**触碰 `C:\Users\M\.dsh\profiles\desktop` 与真实 `~/.dsh` 数据。

---

## 0. 一次性前置

| 项 | 值（本机实测） |
|---|---|
| DSH CLI | `D:\programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| 版本 | DSH Desktop `0.2.1-rc.3`，内核包同版本 |
| pnpm | `11.28.5`（由 `dsh plugin` 内置调用，无需全局安装） |
| Node | `24.21.0`（`dsh.cmd` 以 `ELECTRON_RUN_AS_NODE=1` 跑内置 Node） |
| 插件包 | 仓库 `plugin/`（`name: dsh-auto-archive`，`version: 0.1.0`） |

建议先给 CLI 起个别名（PowerShell）：

```powershell
$dsh = "D:\programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
```

> ⚠️ 不要用系统里的 `dsh`（可能不存在）；直接用上面的完整路径最稳。

---

## 1. 方式 A：临时 DSH_HOME + scratch profile（安全预演，**已实测**）

用途：在不碰真实数据的前提下，验证「profile 能创建 / 插件能装进 profile / 配置能合成」。
**注意**：本节只验证到「安装与配置层」，是否真的 boot 成 Web 实例由 Lead 另行验证（见 §2）。

```powershell
# 1) 独立 DSH_HOME（临时目录，随便删）
$env:DSH_HOME = Join-Path $env:LOCALAPPDATA "Temp\dsh-e2e-home"

# 2) 用官方 web 模板生成 scratch profile（不会启动服务）
& $dsh --profile scratch --from-default-profile web --dump-config

# 期望：退出码 0，生成
#   $env:DSH_HOME\profiles\scratch\package.json
#   $env:DSH_HOME\profiles\scratch\cordis.patch.yml
#   $env:DSH_HOME\profiles\scratch\cordis.yml
#   $env:DSH_HOME\profiles\scratch\pnpm-workspace.yaml
```

生成的 `package.json`（实测原文）：

```json
{
  "name": "dsh-profile-scratch",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

`cordis.patch.yml` 初始只有注释 + `[]`。

```powershell
# 3) 把本仓库的 plugin/ 以 file: 方式装进 scratch profile
#    路径用正斜杠 + file: 前缀（实测可行）
& $dsh plugin --profile scratch add "file:D:/path/to/dsh-auto-archive/plugin"

# 期望：pnpm 输出类似
#   + dsh-auto-archive 0.1.0
#   退出码 0
```

安装后 `package.json` 实测变化：

```json
{
  "dependencies": { "dsh-auto-archive": "file:D:/path/to/dsh-auto-archive/plugin" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-auto-archive"
  ] } }
}
```

> 实测用的是 ASCII 临时路径（`file:C:/Temp/dsh-probe-plugin`）。
> **本仓库路径含中文，未验证**；若 `pnpm add` 对非 ASCII 路径报错，改用 §4 的 tgz 方案。

```powershell
# 4) 只验证「配置层能合成出插件 row」，不启动服务
& $dsh --profile scratch --dump-config | Select-String "dsh-auto-archive"

# 期望：输出里出现 dsh-auto-archive 的 row（id 或 name 至少一个命中）
```

```powershell
# 5) 收尾：删掉整个临时 DSH_HOME（不影响真实环境）
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "Temp\dsh-e2e-home")
```

### 1.1 卸载（scratch profile，实测路径）

```powershell
& $dsh plugin --profile scratch remove dsh-auto-archive
```

> `remove` 子命令来自 `dsh-plugin-manager` 的 `removeBundle`（README 声明）；**【未验证】** 本机只验证了 `add`。
> 替代方案：直接编辑 profile `package.json`，删掉 `dependencies` 里的条目和 `dsh.profile.bundles` 里的名字，再跑
> `& $dsh plugin --profile scratch install`（或在该 profile 目录手工 `pnpm install`）。

---

## 2. 方式 B：真实 desktop profile（**由 Lead 执行**，本文不代替）

desktop profile 由 DSH Desktop 应用独占管理。安全顺序：

1. **完全退出 DSH Desktop**（托盘也要退），确认进程不在：`Get-Process | Where-Object Name -like "*DeepSeek*"`。
2. 备份 profile 清单（**只备份、不修改**）：
   ```powershell
   Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-autoarchive"
   Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-autoarchive"
   ```
3. 安装（CLI 不需要 GUI 在跑）：
   ```powershell
   & $dsh plugin --profile desktop add "file:D:/path/to/dsh-auto-archive/plugin"
   ```
   > 路径含中文的风险见 §1；若失败，先 §4 打包成 tgz 再 `add "file:<tgz 路径>"`。
4. 验证配置层（不启动 GUI）：
   ```powershell
   & $dsh --profile desktop --dump-config | Select-String "dsh-auto-archive"
   ```
5. 启动 DSH Desktop → 设置页应出现「自动归档」；打开插件面板，先点**预览**（dryRun），确认候选合理，再执行。

> **【未验证】** 步骤 3-5 的端到端结果（应用是否覆盖 profile、重启后是否加载 client bundle）。
> 这是 Lead 的验收项（CONTRACT §9 第 2、3 条）。

### 2.1 回滚（真实 profile）

```powershell
# 1) 退出 DSH Desktop
# 2) 从 profile 清单里移除（优先用 CLI；失败则手改 package.json，见 §1.1 的替代方案）
& $dsh plugin --profile desktop remove dsh-auto-archive
# 3) 重建依赖
& $dsh plugin --profile desktop install
# 4) 若手改过，或 CLI 行为异常：直接还原备份
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-autoarchive" "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Force
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-autoarchive" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
# 5) 重启 DSH Desktop
```

**回滚不会丢用户数据**：插件只写自己的 `<DSH_HOME>/auto-archive/`，归档状态写 DSH 的 `storages/workspace.json`（标准 schema 字段，卸载后 DSH 照常读）。
**已归档的会话不会自动恢复**；如需恢复，在插件面板点「恢复」或在卸载前先恢复。

### 2.2 卸载后的残留（可安全删除）

```
<DSH_HOME>/auto-archive/config.json
<DSH_HOME>/auto-archive/state.json
<DSH_HOME>/auto-archive/history.jsonl   （若实现写了）
```

> 这些是插件自有文件（CONTRACT §3）；删除不影响 DSH。**不要**删 `<DSH_HOME>/storages/session_projcache/` 以外的任何东西。

---

## 3. 运行期验证清单（给 Lead 的验收命令）

```powershell
# a) 插件是否在 profile 里
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" | Select-String "dsh-auto-archive"

# b) 配置层是否合成
& $dsh --profile desktop --dump-config | Select-String "dsh-auto-archive"

# c) 插件自有目录是否创建（首次启动后）
Get-ChildItem "$env:USERPROFILE\.dsh\auto-archive"

# d) 投影缓存是否只在「已归档 + 超过 unusedDays」时减少
(Get-ChildItem "$env:USERPROFILE\.dsh\storages\session_projcache\sessions\*.json").Count

# e) transcript 完整性（执行前后对比，应完全一致）
Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -Filter "session.v4.jsonl.zstd" |
  Get-FileHash -Algorithm SHA256 | Sort-Object Path | Format-Table -AutoSize
```

> d) 与 e) 就是 CONTRACT §9 第 3 条的「只删 projcache json、transcript 哈希不变」验收方式。

---

## 4. 非 ASCII 路径的替代安装法（**未验证**，失败时用）

仓库路径 `D:\path\to\dsh-auto-archive` 含中文。若 `pnpm add file:<含中文路径>` 失败：

```powershell
# 1) 在仓库里打包（需要 pnpm，可用 dsh 内置的）
cd "D:\path\to\dsh-auto-archive\plugin"
pnpm pack
# 产出 dsh-auto-archive-0.1.0.tgz（在当前目录）

# 2) 把 tgz 复制到纯 ASCII 路径
Copy-Item ".\dsh-auto-archive-0.1.0.tgz" "$env:TEMP\dsh-auto-archive-0.1.0.tgz"

# 3) 用 tgz 安装
& $dsh plugin --profile desktop add "file:$env:TEMP\dsh-auto-archive-0.1.0.tgz"
```

> `pnpm pack` 会把 `plugin/` 按 `files`/默认规则打包；本包 `private: true` 不影响 `pack`（只影响 `publish`）。
> **【未验证】** 该路径是否被 `dsh plugin add` 接受（它最终也是调 pnpm add，理论上等价）。

---

## 5. 已知限制

1. **desktop profile 是应用独占的**：运行中手改 `package.json` 可能被应用覆盖；必须在应用退出时安装。
2. **client bundle 的生效需要重启 + 刷新页面**：host 端 patch 在启动时合成；client 端 `/plugins` 路由在 boot 时注册。
3. **安装的 host 代码在 in-process 运行、位于 workspace sandbox 之外**（`dsh-plugin-manager` README），所以插件代码质量直接影响宿主稳定性 —— 本插件所有异常都已捕获（CONTRACT §6.4）。
4. **不要用 `dsh --profile desktop --dump-config` 之外的 CLI 直接启动 desktop profile**：desktop 由 GUI 独占管理，CLI 启动可能抢端口/锁。
5. **回滚后 `workspace.json` 的归档状态保留**：这是 DSH 官方数据，插件卸载不会也不应清理。
