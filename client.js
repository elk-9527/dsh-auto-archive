/**
 * dsh-auto-archive — 设置页「自动归档」面板(Client 半边)。
 *
 * 无构建、手写的 ModuleLoader bundle(骨架照抄 dsh-meme/client.js):
 * 注册 settings.section 页, 渲染 状态卡 / 配置 / 候选会话 / 历史 面板。
 * 所有数据只走 host 的 HTTP API(/dsh-auto-archive/api/*, 见 CONTRACT.md §5),
 * 不碰任何 Node API。
 *
 * 注意: 注册 id 必须等于包名(dsh-auto-archive), 否则 ModuleLoader 报
 * "loaded without registering dsh-auto-archive"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-archive',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** host HTTP API 前缀(约定: 与包名一致)。 */
    const API_BASE = '/dsh-auto-archive'
    /** style 标签归属 id: 必须等于模块注册 id, 宿主按它清理样式。 */
    const STYLE_OWNER_ID = 'dsh-auto-archive'
    /** 状态卡后台轮询间隔(只看状态, 不重新拉会话列表)。 */
    const REFRESH_INTERVAL_MS = 15000
    /** 会话表默认最多渲染多少行(其余折叠, 避免一次渲染上百行)。 */
    const SESSION_PAGE_SIZE = 100

    // ------------------------------------------------------------------
    // 基础工具(纯函数, 便于单测)
    // ------------------------------------------------------------------

    /** 任何值 → 有限数字, 否则 fallback。 */
    function toFiniteNumber(value, fallback) {
      if (typeof value === 'number') return isFinite(value) ? value : fallback
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value)
        return isFinite(n) ? n : fallback
      }
      return fallback
    }

    /** 整数并夹在 [min,max]; 非法值回退 fallback。 */
    function clampInt(value, min, max, fallback) {
      const n = toFiniteNumber(value, NaN)
      if (!isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.round(n)))
    }

    /** 非负计数。 */
    function countOf(value) {
      const n = toFiniteNumber(value, 0)
      return n > 0 ? Math.round(n) : 0
    }

    /** 字符串数组: 去空、去重、保序。 */
    function normalizeStringArray(value) {
      if (!Array.isArray(value)) return []
      const out = []
      const seen = {}
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') continue
        const text = value[i].trim()
        if (!text || seen['#' + text]) continue
        seen['#' + text] = true
        out.push(text)
      }
      return out
    }

    /** 多行文本 → 字符串数组(每行一条, 忽略空行/重复)。 */
    function parseLines(text) {
      if (typeof text !== 'string') return []
      return normalizeStringArray(text.split(/\r?\n/))
    }

    function pad2(n) {
      return (n < 10 ? '0' : '') + n
    }

    /** 时间戳 → 'YYYY-MM-DD HH:mm'(本地时区); 非法 → '—'。 */
    function formatTime(ms) {
      const t = toFiniteNumber(ms, 0)
      if (!(t > 0)) return '—'
      const d = new Date(t)
      if (isNaN(d.getTime())) return '—'
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }

    /** 时间戳 → 相对时间(近 30 天内), 更早则给日期。 */
    function formatRelative(ms, nowMs) {
      const t = toFiniteNumber(ms, 0)
      if (!(t > 0)) return '—'
      const now = toFiniteNumber(nowMs, Date.now())
      const diff = now - t
      if (diff < 0) return '刚刚'
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return minutes + ' 分钟前'
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      const days = Math.floor(hours / 24)
      if (days < 30) return days + ' 天前'
      return formatTime(t)
    }

    /** 天数 → '12.3 天'。 */
    function formatIdle(days) {
      const n = toFiniteNumber(days, NaN)
      if (!isFinite(n) || n < 0) return '—'
      const rounded = Math.round(n * 10) / 10
      return rounded + ' 天'
    }

    /** 会话 id 太长时截断显示(完整 id 放 title)。 */
    function shortId(id) {
      const text = typeof id === 'string' ? id : String(id == null ? '' : id)
      if (text.length <= 20) return text
      return text.slice(0, 10) + '…' + text.slice(-6)
    }

    function errorMessage(error, prefix) {
      const detail = error && error.message ? error.message : String(error)
      // host 以 {ok:false,error:'busy'} 表达"上一轮巡检还在跑"，给用户一个可读说法。
      const friendly = detail === 'busy' ? '宿主正在执行另一轮巡检，请稍后再试' : detail
      return prefix ? prefix + ': ' + friendly : friendly
    }

    // ------------------------------------------------------------------
    // 配置默认值 / 归一化(host 字段缺失时面板也能活)
    // ------------------------------------------------------------------

    function defaultConfig() {
      return {
        version: 1,
        autoArchive: { enabled: true, idleDays: 14, checkIntervalMinutes: 30 },
        cacheCleanup: { enabled: true, unusedDays: 90 },
        protect: { pinnedSessions: true, sessionIds: [], workspaces: [] },
        limits: { maxOperationsPerRun: 50 },
        dryRun: false,
      }
    }

    function boolOr(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    function sectionOf(raw, key) {
      const section = raw && typeof raw === 'object' ? raw[key] : null
      return section && typeof section === 'object' ? section : {}
    }

    /** 任意(部分/损坏)配置 → 完整配置。 */
    function normalizeConfig(raw) {
      const defaults = defaultConfig()
      const root = raw && typeof raw === 'object' ? raw : {}
      const auto = sectionOf(root, 'autoArchive')
      const cache = sectionOf(root, 'cacheCleanup')
      const protect = sectionOf(root, 'protect')
      const limits = sectionOf(root, 'limits')
      return {
        version: toFiniteNumber(root.version, defaults.version),
        autoArchive: {
          enabled: boolOr(auto.enabled, defaults.autoArchive.enabled),
          idleDays: clampInt(auto.idleDays, 1, 3650, defaults.autoArchive.idleDays),
          checkIntervalMinutes: clampInt(auto.checkIntervalMinutes, 1, 1440, defaults.autoArchive.checkIntervalMinutes),
        },
        cacheCleanup: {
          enabled: boolOr(cache.enabled, defaults.cacheCleanup.enabled),
          unusedDays: clampInt(cache.unusedDays, 1, 3650, defaults.cacheCleanup.unusedDays),
        },
        protect: {
          pinnedSessions: boolOr(protect.pinnedSessions, defaults.protect.pinnedSessions),
          sessionIds: normalizeStringArray(protect.sessionIds),
          workspaces: normalizeStringArray(protect.workspaces),
        },
        limits: {
          maxOperationsPerRun: clampInt(limits.maxOperationsPerRun, 1, 500, defaults.limits.maxOperationsPerRun),
        },
        dryRun: boolOr(root.dryRun, defaults.dryRun),
      }
    }

    /** 面板草稿 → 提交给 POST /api/config 的部分配置(数字已夹紧)。 */
    function buildConfigPayload(draft, protectText) {
      const cfg = normalizeConfig(draft)
      const text = protectText && typeof protectText === 'object' ? protectText : {}
      return {
        autoArchive: {
          enabled: cfg.autoArchive.enabled,
          idleDays: cfg.autoArchive.idleDays,
          checkIntervalMinutes: cfg.autoArchive.checkIntervalMinutes,
        },
        cacheCleanup: {
          enabled: cfg.cacheCleanup.enabled,
          unusedDays: cfg.cacheCleanup.unusedDays,
        },
        protect: {
          pinnedSessions: cfg.protect.pinnedSessions,
          sessionIds: parseLines(text.sessionIds),
          workspaces: parseLines(text.workspaces),
        },
        limits: { maxOperationsPerRun: cfg.limits.maxOperationsPerRun },
        dryRun: cfg.dryRun,
      }
    }

    // ------------------------------------------------------------------
    // host 响应归一化(CONTRACT §5; 字段缺失有默认, 不抛错)
    // ------------------------------------------------------------------

    function normalizeCounts(raw) {
      const root = raw && typeof raw === 'object' ? raw : {}
      return {
        stored: countOf(root.stored),
        live: countOf(root.live),
        archived: countOf(root.archived),
        pinned: countOf(root.pinned),
        eligibleArchive: countOf(root.eligibleArchive),
        eligibleCache: countOf(root.eligibleCache),
      }
    }

    function normalizeRunResult(raw) {
      const root = raw && typeof raw === 'object' ? raw : {}
      const archived = []
      if (Array.isArray(root.archived)) {
        for (const row of root.archived) {
          if (!row || typeof row !== 'object') continue
          archived.push({
            id: String(row.id == null ? '' : row.id),
            title: String(row.title == null ? '' : row.title),
            lastActivityDays: toFiniteNumber(row.lastActivityDays, NaN),
          })
        }
      }
      const cachePurged = []
      if (Array.isArray(root.cachePurged)) {
        for (const row of root.cachePurged) {
          if (!row || typeof row !== 'object') continue
          cachePurged.push({
            id: String(row.id == null ? '' : row.id),
            title: String(row.title == null ? '' : row.title),
            lastActivityDays: toFiniteNumber(row.lastActivityDays, NaN),
          })
        }
      }
      const skipped = []
      if (Array.isArray(root.skipped)) {
        for (const row of root.skipped) {
          if (!row || typeof row !== 'object') continue
          skipped.push({ id: String(row.id == null ? '' : row.id), reason: String(row.reason == null ? '' : row.reason) })
        }
      }
      const errors = []
      if (Array.isArray(root.errors)) {
        for (const row of root.errors) {
          if (!row || typeof row !== 'object') continue
          errors.push({ id: String(row.id == null ? '' : row.id), error: String(row.error == null ? '' : row.error) })
        }
      }
      return {
        runId: String(root.runId == null ? '' : root.runId),
        at: toFiniteNumber(root.at, 0),
        mode: String(root.mode == null ? '' : root.mode),
        archived: archived,
        cachePurged: cachePurged,
        skipped: skipped,
        errors: errors,
        startedAt: toFiniteNumber(root.startedAt, 0),
        finishedAt: toFiniteNumber(root.finishedAt, 0),
        countsBefore: root.countsBefore && typeof root.countsBefore === 'object' ? root.countsBefore : null,
      }
    }

    /** GET /api/state → 面板状态(全部字段带默认)。 */
    function normalizeState(raw) {
      const root = raw && typeof raw === 'object' ? raw : {}
      const config = normalizeConfig(root.config)
      const effective = root.effective && typeof root.effective === 'object'
        ? normalizeConfig(root.effective)
        : config
      return {
        config: config,
        effective: effective,
        lastRunAt: toFiniteNumber(root.lastRunAt, 0),
        lastResult: root.lastResult && typeof root.lastResult === 'object' ? normalizeRunResult(root.lastResult) : null,
        counts: normalizeCounts(root.counts),
        nextRunAt: toFiniteNumber(root.nextRunAt, 0),
        pluginVersion: typeof root.pluginVersion === 'string' ? root.pluginVersion : '',
        warnings: normalizeStringArray(root.warnings),
      }
    }

    /** GET /api/sessions → [{id,...}] (兼容裸数组 / {sessions:[...]})。 */
    function normalizeSessions(raw) {
      const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.sessions) ? raw.sessions : [])
      const out = []
      for (const row of list) {
        if (!row || typeof row !== 'object') continue
        const id = String(row.id == null ? '' : row.id)
        if (!id) continue
        const lastActivityAt = toFiniteNumber(row.lastActivityAt, 0)
        let idleDays = toFiniteNumber(row.idleDays, NaN)
        if (!isFinite(idleDays)) {
          idleDays = lastActivityAt > 0 ? (Date.now() - lastActivityAt) / 86400000 : NaN
        }
        out.push({
          id: id,
          title: String(row.title == null ? '' : row.title) || id,
          workspaceId: String(row.workspaceId == null ? '' : row.workspaceId),
          workspaceName: String(row.workspaceName == null ? '' : row.workspaceName),
          cwd: String(row.cwd == null ? '' : row.cwd),
          createdAt: toFiniteNumber(row.createdAt, 0),
          lastActivityAt: lastActivityAt,
          idleDays: idleDays,
          archived: row.archived === true,
          pinned: row.pinned === true,
          protected: row.protected === true,
          eligibleArchive: row.eligibleArchive === true,
          eligibleCache: row.eligibleCache === true,
          reason: typeof row.reason === 'string' ? row.reason : '',
        })
      }
      return out
    }

    /** GET /api/history → RunResult[] (兼容 {history:[...]})。 */
    function normalizeHistory(raw) {
      const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.history) ? raw.history : [])
      const out = []
      for (const row of list) {
        if (!row || typeof row !== 'object') continue
        out.push(normalizeRunResult(row))
      }
      return out
    }

    function modeLabel(mode) {
      if (mode === 'auto') return '自动巡检'
      if (mode === 'manual') return '手动执行'
      if (mode === 'dry-run') return '预览'
      return mode ? String(mode) : '—'
    }

    /** 单条会话 → 状态标签。 */
    function statusLabel(row) {
      if (!row) return '—'
      if (row.archived && row.eligibleCache) return '可清理缓存'
      if (row.archived) return '已归档'
      if (row.protected) return '受保护'
      if (row.eligibleArchive) return '可归档'
      return '未到期'
    }

    function statusClass(row) {
      const label = statusLabel(row)
      if (label === '可归档') return 'good'
      if (label === '可清理缓存') return 'warn'
      if (label === '已归档') return 'muted'
      if (label === '受保护') return 'danger'
      return 'muted'
    }

    function runSummary(result, dryRun) {
      const r = result || normalizeRunResult(null)
      const parts = []
      if (r.archived.length) parts.push((dryRun ? '将归档 ' : '已归档 ') + r.archived.length + ' 个会话')
      if (r.cachePurged.length) parts.push((dryRun ? '将清理 ' : '已清理 ') + r.cachePurged.length + ' 个投影缓存')
      if (r.skipped.length) parts.push('跳过 ' + r.skipped.length + ' 个')
      if (r.errors.length) parts.push('错误 ' + r.errors.length + ' 个')
      return (dryRun ? '预览(未做任何变更):' : '执行完成:') + (parts.length ? parts.join('，') : '没有符合条件的会话')
    }

    // ------------------------------------------------------------------
    // HTTP API(只走 host 的 /dsh-auto-archive/api/*)
    // ------------------------------------------------------------------

    /**
     * 用注入的 fetch 建一组 API 调用(便于单测)。
     * @param {(url: string, init?: object) => Promise<any>} fetchImpl
     */
    function createApi(fetchImpl) {
      const call = typeof fetchImpl === 'function' ? fetchImpl : () => Promise.reject(new Error('fetch 不可用'))

      async function request(path, init) {
        const res = await call(API_BASE + path, init)
        if (!res || typeof res !== 'object') throw new Error('接口无响应')
        let payload = null
        let parseFailed = false
        try {
          payload = await res.json()
        } catch (error) {
          parseFailed = true
        }
        if (payload && typeof payload === 'object' && payload.ok === false) {
          const reason = typeof payload.error === 'string' && payload.error ? payload.error : '请求被拒绝'
          throw new Error(reason)
        }
        if (res.ok === false) {
          throw new Error('请求失败(HTTP ' + (res.status == null ? '?' : res.status) + ')')
        }
        if (parseFailed) throw new Error('接口返回内容不是合法 JSON')
        return payload
      }

      const postJson = (path, body) => request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })

      return {
        getState: () => request('/api/state'),
        getSessions: (limit) => request('/api/sessions?limit=' + (clampInt(limit, 1, 1000, 200))),
        getHistory: () => request('/api/history'),
        saveConfig: (patch) => postJson('/api/config', patch),
        run: (dryRun) => postJson('/api/run', { dryRun: dryRun === true }),
        restore: (sessionIds) => postJson('/api/restore', { sessionIds: normalizeStringArray(sessionIds) }),
      }
    }

    const api = createApi((url, init) => fetch(url, init))

    // ------------------------------------------------------------------
    // 样式(带 data-plugin 归属; 卸载时由 ctx.effect 清理)
    // ------------------------------------------------------------------

    const CSS = [
      '.aa-panel{display:flex;flex-direction:column;gap:14px;padding:4px 0 8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);max-width:980px}',
      '.aa-head{display:flex;flex-direction:column;gap:3px}',
      '.aa-title{font-size:15px;font-weight:600}',
      '.aa-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.aa-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.aa-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.aa-card-title{font-size:13px;font-weight:600}',
      '.aa-card-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.aa-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.aa-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px}',
      '.aa-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.aa-stat-v{font-size:18px;font-weight:600;line-height:1.2}',
      '.aa-stat-k{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.aa-meta{display:flex;flex-wrap:wrap;gap:5px 18px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.aa-meta b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.aa-error,.aa-notice,.aa-warn{padding:7px 12px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.aa-error{color:#e5484d;border-color:color-mix(in srgb,#e5484d 45%,transparent);background:color-mix(in srgb,#e5484d 10%,transparent)}',
      '.aa-warn{color:#b26a00;border-color:color-mix(in srgb,#f5a623 45%,transparent);background:color-mix(in srgb,#f5a623 10%,transparent)}',
      '.aa-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.aa-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.aa-switch{position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l1);cursor:pointer;transition:background .15s ease;flex:none;display:inline-block;border:none;padding:0}',
      '.aa-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .15s ease}',
      '.aa-switch.on{background:var(--dsw-alias-brand-primary)}',
      '.aa-switch.on::after{transform:translateX(16px)}',
      '.aa-panel input[type=number],.aa-panel input[type=text],.aa-panel textarea{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;font-size:13px;outline:none;transition:border-color .12s ease}',
      '.aa-panel input[type=number]:focus,.aa-panel input[type=text]:focus,.aa-panel textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.aa-num{width:86px}',
      '.aa-textarea{width:100%;box-sizing:border-box;min-height:52px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.aa-panel button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;transition:border-color .12s ease,background .12s ease}',
      '.aa-panel button:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.aa-panel button:disabled{opacity:.5;cursor:default}',
      '.aa-panel .aa-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.aa-panel .aa-btn-primary:hover{background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}',
      '.aa-panel .aa-btn-danger{color:#e5484d;border-color:color-mix(in srgb,#e5484d 50%,var(--dsw-alias-border-l1))}',
      '.aa-tabs{display:flex;gap:6px;flex-wrap:wrap}',
      '.aa-tab{border-radius:999px;font-size:12px;padding:2px 10px;background:transparent}',
      '.aa-tab.on{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.aa-table-wrap{overflow:auto;max-height:440px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}',
      '.aa-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.aa-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2);text-align:left;font-weight:600;font-size:11px;color:var(--dsw-alias-label-secondary);padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.aa-table td{padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}',
      '.aa-table tr:last-child td{border-bottom:none}',
      '.aa-session-title{font-size:12px;word-break:break-all}',
      '.aa-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.aa-badge{display:inline-block;font-size:11px;border-radius:999px;padding:1px 8px;white-space:nowrap;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.aa-badge.good{color:#2f9e44;border-color:color-mix(in srgb,#2f9e44 45%,transparent);background:color-mix(in srgb,#2f9e44 12%,transparent)}',
      '.aa-badge.warn{color:#b26a00;border-color:color-mix(in srgb,#f5a623 45%,transparent);background:color-mix(in srgb,#f5a623 12%,transparent)}',
      '.aa-badge.danger{color:#e5484d;border-color:color-mix(in srgb,#e5484d 45%,transparent);background:color-mix(in srgb,#e5484d 12%,transparent)}',
      '.aa-link{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:6px}',
      '.aa-link:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);border-color:transparent}',
      '.aa-hist{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none}',
      '.aa-hist li{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;font-size:12px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}',
      '.aa-hist li:last-child{border-bottom:none}',
      '.aa-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:14px;text-align:center}',
      '.aa-foot{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}',
    ].join('')

    /**
     * 建一个归属本插件的 <style>(打 data-plugin 标记, 避免被宿主的
     * "认领无主 style" 逻辑在别的模块变更时连坐删除)。
     */
    function createOwnedStyle(css) {
      const doc = typeof document === 'undefined' ? null : document
      if (!doc || typeof doc.createElement !== 'function') return null
      const el = doc.createElement('style')
      if (el && typeof el.setAttribute === 'function') el.setAttribute('data-plugin', STYLE_OWNER_ID)
      el.textContent = css
      const parent = doc.head || doc.documentElement
      if (parent && typeof parent.appendChild === 'function') parent.appendChild(el)
      return el
    }

    function removeNode(el) {
      if (!el) return
      if (el.parentNode && typeof el.parentNode.removeChild === 'function') {
        el.parentNode.removeChild(el)
        return
      }
      if (typeof el.remove === 'function') el.remove()
    }

    // ------------------------------------------------------------------
    // 小组件(纯渲染函数: 不调用 hooks, 只有 Panel 用 hooks)
    // ------------------------------------------------------------------

    function StatGrid(counts) {
      const items = [
        ['stored', '会话总数', counts.stored],
        ['live', '活动中', counts.live],
        ['archived', '已归档', counts.archived],
        ['pinned', '置顶', counts.pinned],
        ['eligibleArchive', '可归档', counts.eligibleArchive],
        ['eligibleCache', '可清理缓存', counts.eligibleCache],
      ]
      return h('div', { className: 'aa-grid' }, items.map((item) => h('div', {
        key: item[0], className: 'aa-stat', 'data-testid': 'aa-stat-' + item[0],
      }, [
        h('div', { className: 'aa-stat-v' }, String(item[2])),
        h('div', { className: 'aa-stat-k' }, item[1]),
      ])))
    }

    function StatusCard(props) {
      const state = props.state
      const counts = props.counts
      const effective = props.effective
      const busy = props.busy
      const loading = props.loading
      const confirmRun = props.confirmRun
      const confirmText = '确认执行？将按当前配置归档最多 ' + counts.eligibleArchive +
        ' 个会话（可恢复），并清理最多 ' + counts.eligibleCache + ' 个可重建的投影缓存（单次上限 ' +
        effective.limits.maxOperationsPerRun + '）。'
      return h('div', { className: 'aa-card' }, [
        h('div', { className: 'aa-card-head' }, [
          h('div', { className: 'aa-card-title' }, '状态'),
          h('div', { className: 'aa-row' }, [
            h('button', {
              type: 'button', 'data-testid': 'aa-refresh', disabled: !!busy || !!loading,
              onClick: props.onRefresh,
            }, loading ? '加载中…' : '刷新'),
            h('button', {
              type: 'button', 'data-testid': 'aa-preview', disabled: !!busy,
              onClick: () => props.onRun(true),
            }, busy === 'preview' ? '预览中…' : '立即预览'),
            h('button', {
              type: 'button', className: 'aa-btn-danger', 'data-testid': 'aa-run', disabled: !!busy,
              onClick: () => props.setConfirmRun(true),
            }, '立即执行'),
          ]),
        ]),
        StatGrid(counts),
        h('div', { className: 'aa-meta' }, [
          h('span', null, ['最近运行：', h('b', { 'data-testid': 'aa-last-run' }, formatRelative(state ? state.lastRunAt : 0) + (state && state.lastRunAt ? '（' + formatTime(state.lastRunAt) + '）' : ''))]),
          h('span', null, ['下次巡检：', h('b', { 'data-testid': 'aa-next-run' }, state && state.nextRunAt > 0 ? formatTime(state.nextRunAt) : '未启用')]),
          h('span', null, ['插件版本：', h('b', null, state && state.pluginVersion ? state.pluginVersion : '—')]),
          h('span', null, ['单次上限：', h('b', null, String(effective.limits.maxOperationsPerRun) + ' 个操作')]),
        ]),
        confirmRun ? h('div', { className: 'aa-warn', 'data-testid': 'aa-confirm-bar' }, [
          h('div', null, confirmText),
          h('div', { className: 'aa-row', style: { marginTop: '8px' } }, [
            h('button', {
              type: 'button', className: 'aa-btn-primary', 'data-testid': 'aa-confirm-run', disabled: !!busy,
              onClick: () => props.onRun(false),
            }, busy === 'run' ? '执行中…' : '确认执行'),
            h('button', {
              type: 'button', 'data-testid': 'aa-cancel-run', disabled: !!busy,
              onClick: () => props.setConfirmRun(false),
            }, '取消'),
          ]),
        ]) : null,
      ])
    }

    function NumberField(props) {
      return h('label', { className: 'aa-row', style: { gap: '6px' } }, [
        h('span', { className: 'aa-label' }, props.label),
        h('input', {
          type: 'number', className: 'aa-num', min: props.min, max: props.max, step: 1,
          value: props.value === '' || props.value == null ? '' : String(props.value),
          'data-testid': props.testId,
          onChange: (event) => props.onChange(event && event.target ? event.target.value : ''),
        }),
        h('span', { className: 'aa-label' }, props.unit || ''),
      ])
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'aa-switch' + (props.on ? ' on' : ''),
        role: 'switch',
        'aria-checked': props.on ? 'true' : 'false',
        'aria-label': props.label,
        'data-testid': props.testId,
        disabled: props.disabled === true,
        onClick: () => props.onToggle(!props.on),
      })
    }

    function ConfigCard(props) {
      const draft = props.draft
      const auto = draft.autoArchive
      const cache = draft.cacheCleanup
      const patch = props.patchSection
      return h('div', { className: 'aa-card' }, [
        h('div', { className: 'aa-card-head' }, [
          h('div', { className: 'aa-card-title' }, '配置'),
          props.dirty
            ? h('span', { className: 'aa-card-sub', 'data-testid': 'aa-dirty' }, '有未保存的修改')
            : h('span', { className: 'aa-card-sub' }, '修改后点击「保存配置」生效'),
        ]),
        h('div', { className: 'aa-row' }, [
          Switch({ on: auto.enabled, label: '启用自动归档', testId: 'aa-auto-enabled', onToggle: (next) => patch('autoArchive', 'enabled', next) }),
          h('span', { className: 'aa-label' }, '自动归档'),
          NumberField({
            label: '无活动超过', unit: '天', min: 1, max: 3650, value: auto.idleDays,
            testId: 'aa-idle-days', onChange: (value) => patch('autoArchive', 'idleDays', value),
          }),
          NumberField({
            label: '巡检间隔', unit: '分钟', min: 1, max: 1440, value: auto.checkIntervalMinutes,
            testId: 'aa-interval', onChange: (value) => patch('autoArchive', 'checkIntervalMinutes', value),
          }),
        ]),
        auto.enabled ? null : h('div', { className: 'aa-hint', 'data-testid': 'aa-auto-disabled-hint' }, '自动归档已关闭：自动巡检不会归档会话，手动执行也只在开关打开时归档（预览仍会列出候选）。'),
        h('div', { className: 'aa-row' }, [
          Switch({ on: cache.enabled, label: '启用缓存清理', testId: 'aa-cache-enabled', onToggle: (next) => patch('cacheCleanup', 'enabled', next) }),
          h('span', { className: 'aa-label' }, '缓存清理'),
          NumberField({
            label: '已归档且无活动超过', unit: '天', min: 1, max: 3650, value: cache.unusedDays,
            testId: 'aa-unused-days', onChange: (value) => patch('cacheCleanup', 'unusedDays', value),
          }),
          NumberField({
            label: '单次操作上限', unit: '个', min: 1, max: 500, value: draft.limits.maxOperationsPerRun,
            testId: 'aa-max-ops', onChange: (value) => patch('limits', 'maxOperationsPerRun', value),
          }),
        ]),
        h('div', { className: 'aa-row' }, [
          Switch({ on: draft.dryRun, label: '仅预览（dryRun）', testId: 'aa-dryrun', onToggle: (next) => patch('dryRun', null, next) }),
          h('span', { className: 'aa-label' }, '仅预览（dryRun）'),
          h('span', { className: 'aa-hint' }, '打开后自动巡检也只预览、不产生任何变更。'),
        ]),
        h('div', { className: 'aa-row' }, [
          Switch({ on: draft.protect.pinnedSessions, label: '保护置顶会话', testId: 'aa-protect-pinned', onToggle: (next) => patch('protect', 'pinnedSessions', next) }),
          h('span', { className: 'aa-label' }, '保护置顶会话'),
        ]),
        h('div', { className: 'aa-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: '6px' } }, [
          h('span', { className: 'aa-label' }, '保护名单 · 会话 id（每行一个，永不自动归档）'),
          h('textarea', {
            className: 'aa-textarea', 'data-testid': 'aa-protect-ids', spellCheck: false,
            placeholder: 'session-xxxxxxxx-…\n（留空表示不额外保护）',
            value: props.protectText.sessionIds,
            onChange: (event) => props.patchProtectText('sessionIds', event && event.target ? event.target.value : ''),
          }),
          h('span', { className: 'aa-label' }, '保护名单 · 工作区（每行一个 workspace id 或 cwd 子串，大小写不敏感）'),
          h('textarea', {
            className: 'aa-textarea', 'data-testid': 'aa-protect-workspaces', spellCheck: false,
            placeholder: 'workspace id 或 cwd 子串\n（留空表示不额外保护）',
            value: props.protectText.workspaces,
            onChange: (event) => props.patchProtectText('workspaces', event && event.target ? event.target.value : ''),
          }),
        ]),
        h('div', { className: 'aa-row' }, [
          h('button', {
            type: 'button', className: 'aa-btn-primary', 'data-testid': 'aa-save', disabled: !!props.busy || !props.dirty,
            onClick: props.onSave,
          }, props.busy === 'save' ? '保存中…' : '保存配置'),
          h('button', {
            type: 'button', 'data-testid': 'aa-reset', disabled: !!props.busy || !props.dirty,
            onClick: props.onReset,
          }, '撤销修改'),
        ]),
      ])
    }

    function sessionMatchesFilter(row, filter) {
      if (filter === 'archive') return row.eligibleArchive
      if (filter === 'cache') return row.eligibleCache
      if (filter === 'archived') return row.archived
      return true
    }

    function SessionsCard(props) {
      const rows = props.sessions
      const filter = props.filter
      const selected = props.selected
      const filtered = rows.filter((row) => sessionMatchesFilter(row, filter))
      const visible = props.expanded ? filtered : filtered.slice(0, SESSION_PAGE_SIZE)
      const tabs = [
        ['all', '全部', rows.length],
        ['archive', '可归档', rows.filter((row) => row.eligibleArchive).length],
        ['cache', '可清理', rows.filter((row) => row.eligibleCache).length],
        ['archived', '已归档', rows.filter((row) => row.archived).length],
      ]
      const body = visible.length
        ? visible.map((row) => h('tr', { key: row.id, 'data-testid': 'aa-session-row' }, [
          h('td', null, row.archived ? h('input', {
            type: 'checkbox', checked: selected.indexOf(row.id) >= 0,
            'aria-label': '选择 ' + row.title,
            onChange: () => props.toggleSelect(row.id),
          }) : null),
          h('td', null, [
            h('div', { className: 'aa-session-title' }, row.title || '（无标题）'),
            h('div', { className: 'aa-mono', title: row.id }, shortId(row.id)),
          ]),
          h('td', { className: 'aa-label' }, row.workspaceName || '未分组'),
          h('td', { className: 'aa-label' }, formatIdle(row.idleDays)),
          h('td', null, h('span', { className: 'aa-badge ' + statusClass(row) }, statusLabel(row))),
          h('td', null, row.archived ? h('button', {
            type: 'button', className: 'aa-link', 'data-testid': 'aa-restore-row',
            disabled: !!props.busy, onClick: () => props.onRestore([row.id]),
          }, '恢复') : (row.reason ? h('span', { className: 'aa-label' }, row.reason) : null)),
        ]))
        : h('tr', null, h('td', { colSpan: 6, className: 'aa-empty' }, '没有匹配的会话'))
      return h('div', { className: 'aa-card' }, [
        h('div', { className: 'aa-card-head' }, [
          h('div', { className: 'aa-card-title' }, '会话（按最后使用时间排序）'),
          h('div', { className: 'aa-row' }, [
            h('button', {
              type: 'button', 'data-testid': 'aa-restore-selected', disabled: !!props.busy || selected.length === 0,
              onClick: () => props.onRestore(selected),
            }, '恢复选中' + (selected.length ? '（' + selected.length + '）' : '')),
          ]),
        ]),
        h('div', { className: 'aa-tabs' }, tabs.map((tab) => h('button', {
          key: tab[0], type: 'button',
          className: 'aa-tab' + (filter === tab[0] ? ' on' : ''),
          'data-testid': 'aa-filter-' + tab[0],
          onClick: () => props.setFilter(tab[0]),
        }, tab[1] + '(' + tab[2] + ')'))),
        h('div', { className: 'aa-table-wrap' }, h('table', { className: 'aa-table' }, [
          h('thead', null, h('tr', null, [
            h('th', { style: { width: '28px' } }, ''),
            h('th', null, '标题 / id'),
            h('th', null, '工作区'),
            h('th', null, '最后使用'),
            h('th', null, '状态'),
            h('th', null, '操作'),
          ])),
          h('tbody', null, body),
        ])),
        filtered.length > SESSION_PAGE_SIZE
          ? h('div', { className: 'aa-row' }, [
            h('button', { type: 'button', onClick: () => props.setExpanded(!props.expanded) },
              props.expanded ? '收起' : '显示全部 ' + filtered.length + ' 条'),
          ])
          : null,
      ])
    }

    function ResultCard(props) {
      const result = props.result
      if (!result) return null
      const detail = []
      if (result.archived.length) {
        detail.push(h('div', { key: 'archived', className: 'aa-hint', 'data-testid': 'aa-result-archived' },
          '归档：' + result.archived.slice(0, 5).map((row) => row.title || shortId(row.id)).join('、') +
          (result.archived.length > 5 ? ' 等 ' + result.archived.length + ' 个' : '')))
      }
      if (result.cachePurged.length) {
        detail.push(h('div', { key: 'purged', className: 'aa-hint', 'data-testid': 'aa-result-purged' },
          '清理缓存：' + result.cachePurged.slice(0, 5).map((row) => row.title || shortId(row.id)).join('、') +
          (result.cachePurged.length > 5 ? ' 等 ' + result.cachePurged.length + ' 个' : '')))
      }
      if (result.skipped.length) {
        detail.push(h('div', { key: 'skipped', className: 'aa-hint', 'data-testid': 'aa-result-skipped' },
          '跳过：' + result.skipped.slice(0, 5).map((row) => shortId(row.id) + '(' + (row.reason || '?') + ')').join('、') +
          (result.skipped.length > 5 ? ' 等 ' + result.skipped.length + ' 个' : '')))
      }
      if (result.errors.length) {
        detail.push(h('div', { key: 'errors', className: 'aa-error', 'data-testid': 'aa-result-errors' },
          '错误：' + result.errors.slice(0, 5).map((row) => (row.id ? shortId(row.id) + ' ' : '') + row.error).join('；')))
      }
      return h('div', { className: 'aa-card', 'data-testid': 'aa-result' }, [
        h('div', { className: 'aa-card-head' }, [
          h('div', { className: 'aa-card-title' }, '最近一次结果'),
          h('span', { className: 'aa-card-sub' }, modeLabel(result.mode) + ' · ' + formatTime(result.at || result.finishedAt)),
        ]),
        h('div', { className: 'aa-meta' }, [
          h('span', null, ['归档 ', h('b', null, String(result.archived.length)), ' 个']),
          h('span', null, ['清理缓存 ', h('b', null, String(result.cachePurged.length)), ' 个']),
          h('span', null, ['跳过 ', h('b', null, String(result.skipped.length)), ' 个']),
          h('span', null, ['错误 ', h('b', null, String(result.errors.length)), ' 个']),
        ]),
        detail.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, detail) : null,
      ])
    }

    function HistoryCard(props) {
      const history = props.history.slice(0, 10)
      return h('div', { className: 'aa-card' }, [
        h('div', { className: 'aa-card-head' }, [
          h('div', { className: 'aa-card-title' }, '历史记录（最近 10 次）'),
          h('span', { className: 'aa-card-sub', 'data-testid': 'aa-history-count' }, '共 ' + props.history.length + ' 条'),
        ]),
        history.length
          ? h('ul', { className: 'aa-hist', 'data-testid': 'aa-history' }, history.map((row, index) => h('li', {
            key: row.runId || ('h' + index),
          }, [
            h('span', { className: 'aa-mono' }, formatTime(row.at || row.finishedAt)),
            h('span', { className: 'aa-label' }, modeLabel(row.mode)),
            h('span', null, '归档 ' + row.archived.length),
            h('span', null, '清理 ' + row.cachePurged.length),
            h('span', { className: 'aa-label' }, '跳过 ' + row.skipped.length),
            row.errors.length ? h('span', { className: 'aa-badge danger' }, '错误 ' + row.errors.length) : null,
          ])))
          : h('div', { className: 'aa-empty' }, '暂无运行记录'),
      ])
    }

    // ------------------------------------------------------------------
    // 主面板(唯一使用 hooks 的组件)
    // ------------------------------------------------------------------

    function Panel(props) {
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [stateData, setStateData] = React.useState(null)
      const [sessions, setSessions] = React.useState([])
      const [history, setHistory] = React.useState([])
      const [runResult, setRunResult] = React.useState(null)
      const [filter, setFilter] = React.useState('all')
      const [selected, setSelected] = React.useState([])
      const [expanded, setExpanded] = React.useState(false)
      const [confirmRun, setConfirmRun] = React.useState(false)
      const [draft, setDraft] = React.useState(defaultConfig())
      const [dirty, setDirty] = React.useState(false)
      const [protectText, setProtectText] = React.useState({ sessionIds: '', workspaces: '' })
      const alive = React.useRef(true)
      const dirtyRef = React.useRef(false)

      function adoptConfig(config) {
        const next = normalizeConfig(config)
        setDraft(next)
        setProtectText({
          sessionIds: next.protect.sessionIds.join('\n'),
          workspaces: next.protect.workspaces.join('\n'),
        })
        setDirty(false)
        dirtyRef.current = false
      }

      function adoptState(raw) {
        const next = normalizeState(raw)
        setStateData(next)
        if (!dirtyRef.current) adoptConfig(next.effective)
        return next
      }

      async function refreshAll(quiet) {
        if (!quiet) setLoading(true)
        try {
          const [stateRes, sessionsRes, historyRes] = await Promise.all([
            api.getState(),
            api.getSessions(200),
            api.getHistory(),
          ])
          if (!alive.current) return
          adoptState(stateRes)
          const list = normalizeSessions(sessionsRes)
          setSessions(list)
          setHistory(normalizeHistory(historyRes))
          setSelected((previous) => previous.filter((id) => list.some((row) => row.id === id && row.archived)))
          setError('')
        } catch (thrown) {
          if (alive.current) setError(errorMessage(thrown, '加载状态失败'))
        } finally {
          if (alive.current) setLoading(false)
        }
      }

      async function refreshStatus() {
        try {
          const res = await api.getState()
          if (!alive.current) return
          adoptState(res)
        } catch (thrown) {
          // 后台轮询失败不打断用户: 下一次轮询会重试, 手动刷新会显示错误
        }
      }

      React.useEffect(() => {
        alive.current = true
        refreshAll(false)
        const timer = setInterval(() => { refreshStatus() }, REFRESH_INTERVAL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [])

      function patchSection(section, key, value) {
        dirtyRef.current = true
        setDirty(true)
        setDraft((previous) => {
          const base = previous || defaultConfig()
          if (key === null) return Object.assign({}, base, { [section]: value })
          const current = base[section] && typeof base[section] === 'object' ? base[section] : {}
          return Object.assign({}, base, { [section]: Object.assign({}, current, { [key]: value }) })
        })
      }

      function patchProtectText(key, value) {
        dirtyRef.current = true
        setDirty(true)
        setProtectText((previous) => Object.assign({}, previous, { [key]: value }))
      }

      function onReset() {
        const effective = stateData ? stateData.effective : defaultConfig()
        adoptConfig(effective)
        setError('')
        setNotice('已撤销未保存的修改')
      }

      async function onRefresh() {
        if (busy) return
        setBusy('refresh')
        setError('')
        setNotice('')
        try {
          await refreshAll(true)
        } finally {
          if (alive.current) setBusy('')
        }
      }

      async function onSave() {
        if (busy) return
        setBusy('save')
        setError('')
        setNotice('')
        try {
          const payload = buildConfigPayload(draft, protectText)
          const res = await api.saveConfig(payload)
          if (!alive.current) return
          const saved = res && (res.config || res.effective) ? (res.config || res.effective) : payload
          adoptConfig(saved)
          const saveWarnings = res && Array.isArray(res.warnings) ? normalizeStringArray(res.warnings) : []
          setNotice('配置已保存' + (saveWarnings.length ? '（' + saveWarnings.slice(0, 3).join('；') + '）' : ''))
          await refreshStatus()
        } catch (thrown) {
          if (alive.current) setError(errorMessage(thrown, '保存配置失败'))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      async function onRun(dryRun) {
        if (busy) return
        setConfirmRun(false)
        setBusy(dryRun ? 'preview' : 'run')
        setError('')
        setNotice('')
        try {
          const res = await api.run(dryRun)
          if (!alive.current) return
          const raw = res && (res.result || res.runResult) ? (res.result || res.runResult) : res
          const result = normalizeRunResult(raw)
          setRunResult(result)
          setNotice(runSummary(result, dryRun))
          await refreshAll(true)
        } catch (thrown) {
          if (alive.current) setError(errorMessage(thrown, dryRun ? '预览失败' : '执行失败'))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      async function onRestore(ids) {
        const list = normalizeStringArray(ids)
        if (!list.length || busy) return
        setBusy('restore')
        setError('')
        setNotice('')
        try {
          const res = await api.restore(list)
          if (!alive.current) return
          const restored = res && Array.isArray(res.restored) ? res.restored : []
          const failed = res && Array.isArray(res.failed) ? res.failed : []
          setNotice('已恢复 ' + restored.length + ' 个会话' + (failed.length ? '，失败 ' + failed.length + ' 个' : ''))
          setSelected([])
          await refreshAll(true)
        } catch (thrown) {
          if (alive.current) setError(errorMessage(thrown, '恢复失败'))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      function toggleSelect(id) {
        setSelected((previous) => (previous.indexOf(id) >= 0
          ? previous.filter((item) => item !== id)
          : previous.concat([id])))
      }

      const effective = stateData ? stateData.effective : defaultConfig()
      const counts = stateData ? stateData.counts : normalizeCounts(null)
      const lastResult = runResult || (stateData ? stateData.lastResult : null)

      return h('div', { className: 'aa-panel', 'data-testid': 'aa-panel' }, [
        h('div', { className: 'aa-head' }, [
          h('div', { className: 'aa-title' }, '自动归档'),
          h('div', { className: 'aa-sub' }, '超过设定天数且无活动的会话自动归档（可随时恢复）；已归档且长期未用的会话只清理可重建的投影缓存，绝不删除会话记录、附件或工作区文件。'),
        ]),
        error ? h('div', { className: 'aa-error', role: 'alert', 'data-testid': 'aa-error' }, error) : null,
        notice ? h('div', { className: 'aa-notice', role: 'status', 'data-testid': 'aa-notice' }, notice) : null,
        loading && !stateData
          ? h('div', { className: 'aa-notice', 'data-testid': 'aa-loading' }, '正在加载状态…')
          : null,
        effective.dryRun
          ? h('div', { className: 'aa-warn', 'data-testid': 'aa-dryrun-hint' }, '当前开启了「仅预览（dryRun）」：自动巡检也只预览，不会归档或清理。')
          : null,
        stateData && stateData.warnings && stateData.warnings.length
          ? h('div', { className: 'aa-warn', 'data-testid': 'aa-warnings' }, '宿主提示：' + stateData.warnings.slice(0, 3).join('；'))
          : null,
        StatusCard({
          state: stateData,
          counts: counts,
          effective: effective,
          busy: busy,
          loading: loading,
          confirmRun: confirmRun,
          setConfirmRun: setConfirmRun,
          onRefresh: onRefresh,
          onRun: onRun,
        }),
        ConfigCard({
          draft: draft,
          dirty: dirty,
          busy: busy,
          protectText: protectText,
          patchSection: patchSection,
          patchProtectText: patchProtectText,
          onSave: onSave,
          onReset: onReset,
        }),
        ResultCard({ result: lastResult }),
        SessionsCard({
          sessions: sessions,
          filter: filter,
          setFilter: setFilter,
          selected: selected,
          toggleSelect: toggleSelect,
          expanded: expanded,
          setExpanded: setExpanded,
          busy: busy,
          onRestore: onRestore,
        }),
        HistoryCard({ history: history }),
        h('div', { className: 'aa-foot' }, [
          '安全边界：归档只写会话注册表（可随时恢复），不会删除会话记录；缓存清理只删除可重建的 DSH 投影缓存文件；',
          '受保护会话（置顶 / 保护名单 / 保护工作区）永不自动归档。手动执行默认可以先「立即预览」确认候选。',
        ]),
      ])
    }

    // ------------------------------------------------------------------
    // 注册
    // ------------------------------------------------------------------

    // 注册 settings.section 需要 slots 服务。
    const inject = ['slots']

    /**
     * 取 slots 服务：0.2.x 的客户端 ctx 可能以属性形式暴露服务（ctx.slots），
     * 也可能只提供 ctx.get(name)（0.1.x 的 dsh-meme 写法）。两种都试，
     * 避免注册被静默跳过（实测过「样式注入了但设置页没出现」）。
     */
    function resolveSlots(ctx) {
      if (!ctx) return undefined
      const usable = (s) => s && typeof s.inject === 'function' && typeof s.register === 'function'
      const direct = ctx.slots
      if (usable(direct)) return direct
      const viaGet = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (usable(viaGet)) return viaGet
      return undefined
    }

    function apply(ctx) {
      // 样式: 注入带 data-plugin 归属的 <style>, 随 effect 清理。
      try {
        const styleEl = createOwnedStyle(CSS)
        if (styleEl && ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => () => { removeNode(styleEl) }, 'dsh-auto-archive: styles')
        }
      } catch (error) {
        // 样式失败不该阻断设置页注册
        console.warn('[dsh-auto-archive] 注入样式失败:', error && error.message ? error.message : error)
      }

      const slots = resolveSlots(ctx)
      if (!slots) {
        console.warn('[dsh-auto-archive] 取不到 slots 服务，设置页未注册')
        return
      }
      slots.inject('settings.section', () => {
        const dispose = slots.register(
          { name: 'settings.section', id: 'auto-archive', order: 60, label: '自动归档' },
          () => React.createElement(Panel, { ctx: ctx }),
        )
        return dispose
      })
    }

    exports.apply = apply
    exports.inject = inject
    // 辅助入口仅供回归测试(node --test), 宿主不消费。
    exports.__test = {
      API_BASE,
      STYLE_OWNER_ID,
      REFRESH_INTERVAL_MS,
      SESSION_PAGE_SIZE,
      CSS,
      createApi,
      normalizeConfig,
      normalizeState,
      normalizeSessions,
      normalizeHistory,
      normalizeRunResult,
      normalizeCounts,
      buildConfigPayload,
      defaultConfig,
      parseLines,
      clampInt,
      formatTime,
      formatRelative,
      formatIdle,
      shortId,
      sessionStatus: statusLabel,
      statusLabel,
      statusClass,
      runSummary,
      modeLabel,
      errorMessage,
      createOwnedStyle,
      Panel,
    }
    return module.exports
  },
})
