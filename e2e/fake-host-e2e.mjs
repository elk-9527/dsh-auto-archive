#!/usr/bin/env node
/**
 * dsh-auto-archive —— 安全 e2e（不启动 DSH、不碰真实 ~/.dsh）
 *
 * 思路：用「真实 plugin/index.js 的 apply()」+「真实 node:http 服务」+「真实临时磁盘文件」
 * +「按内核语义实现的假服务（workspaceRegistry / sessionProjectionCache / sessionPersistence）」
 * 组装一个最小宿主，然后只通过 HTTP API 驱动插件，验证：
 *
 *  1. GET  /api/state、/api/sessions 的计数与候选正确；
 *  2. dryRun 零副作用（transcript / 投影缓存 / workspace.json / state.json 哈希全不变）；
 *  3. 真跑：只归档 idle 且非保护的会话；活动会话 skipped:'active'；预算超出的 skipped:'limit'；
 *  4. 清理只删「已归档 + 超 unusedDays」的 projcache json，transcript 哈希不变；
 *  5. /api/restore 恢复归档；
 *  6. 回环防护 403 / 404 / 405 / 400；
 *  7. 并发单飞（第二次 run 返回 busy）；
 *  8. dispose 后路由被移除。
 *
 * 磁盘布局按真实内核格式造：
 *   <DSH_HOME>/sessions/<project>/<encodeSegment(id)>/session.v4.jsonl.zstd
 *   <DSH_HOME>/storages/session_projcache/sessions/<id>.json
 *   <DSH_HOME>/storages/workspace.json
 *   <DSH_HOME>/auto-archive/{config.json,state.json}
 *
 * 运行：node e2e/fake-host-e2e.mjs
 * 退出码 0 = 全绿。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PLUGIN_ENTRY = path.join(REPO, 'index.js')

const DAY = 24 * 60 * 60 * 1000
/** 固定"现在"：2026-01-01T00:00:00Z（与单测一致，避免时钟抖动）。 */
const NOW = Date.UTC(2026, 0, 1)

let checks = 0
function ok(message) {
  checks += 1
  console.log(`  ✓ ${message}`)
}
function fail(message) {
  console.error(`  ✗ ${message}`)
  process.exitCode = 1
}
function assertOk(condition, message) {
  assert.ok(condition, message)
  ok(message)
}

/** 复刻内核 encodeSegment（非 [A-Za-z0-9._-] 与 ~ → ~XXXX）。 */
function encodeSegment(text) {
  const value = String(text)
  if (value === '.') return '~002E'
  if (value === '..') return '~002E~002E'
  let out = ''
  for (const char of value) {
    out += /[A-Za-z0-9._-]/.test(char) ? char : `~${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 递归哈希一棵目录树（路径 + 内容），用于"什么都没变"断言。 */
async function hashTree(root) {
  const rows = []
  async function walk(dir) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        rows.push(`${path.relative(root, full).split(path.sep).join('/')}=${sha256(await fsp.readFile(full))}`)
      }
    }
  }
  await walk(root)
  return rows.join('\n')
}

async function exists(file) {
  try {
    await fsp.stat(file)
    return true
  } catch {
    return false
  }
}

/** 造一个真实形态的会话日志（内容无关，只用于哈希/mtime；插件只 stat 不读）。 */
async function writeSessionArtifact(dshHome, id, { mtimeDaysAgo, project = 'project-demo' }) {
  const dir = path.join(dshHome, 'sessions', project, encodeSegment(id))
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  // 故意写非 zstd 内容：内核/插件都不该读它；e2e 只关心"字节没被改"。
  await fsp.writeFile(file, Buffer.from(`fake-zstd-frame:${id}\n`, 'utf8'))
  const mtime = new Date(NOW - mtimeDaysAgo * DAY)
  await fsp.utimes(file, mtime, mtime)
  return file
}

async function writeProjectionCache(dshHome, id, title) {
  const dir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${id}.json`)
  const record = {
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: NOW - 40 * DAY, cwd: 'C:\\work\\demo', isSeeded: false },
      rows: {
        title: { ver: 1, seq: 42, val: title },
      },
    },
  }
  await fsp.writeFile(file, JSON.stringify(record, null, 2))
  return file
}

/** 假内核服务集合（只实现插件用到的表面；语义对齐 tools/kernel 源码）。 */
function createFakeKernel({ dshHome, sessions, liveIds = new Set(), activeIds = new Set() }) {
  const storagesDir = path.join(dshHome, 'storages')
  const workspaceFile = path.join(storagesDir, 'workspace.json')
  const projectionDir = path.join(storagesDir, 'session_projcache', 'sessions')

  /** 近似 workspace domain 的落盘信封（真实格式见 docs/kernel-api.md §4.4）。 */
  let workspaceState = {
    version: 2,
    state: {
      initialized: true,
      workspaceIds: ['ws-1'],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        'ws-1': {
          path: 'C:\\work\\demo',
          title: 'Demo',
          sessionIds: sessions.map((row) => row.header.id),
          createdAt: new Date(NOW - 400 * DAY).toISOString(),
          updatedAt: new Date(NOW - 1 * DAY).toISOString(),
        },
      },
    },
  }

  async function persistWorkspace() {
    await fsp.mkdir(storagesDir, { recursive: true })
    await fsp.writeFile(workspaceFile, JSON.stringify(workspaceState, null, 2))
  }

  const knownIds = new Set(sessions.map((row) => row.header.id))

  const workspaceRegistry = {
    async readState() {
      return workspaceState
    },
    list() {
      return Object.entries(workspaceState.tables.workspaces).map(([id, record]) => ({
        id,
        ...record,
        sessionIds: [...record.sessionIds],
      }))
    },
    get archivedSessionIds() {
      return [...workspaceState.state.archivedSessionIds]
    },
    get pinnedSessionIds() {
      return [...workspaceState.state.pinnedSessionIds]
    },
    async archiveSession(sessionId) {
      if (workspaceState.state.archivedSessionIds.includes(sessionId)) return
      if (!knownIds.has(sessionId)) {
        const error = new Error(`workspace: unknown session ${sessionId}`)
        error.name = 'WorkspaceUnknownSessionError'
        error.sessionId = sessionId
        error.operation = 'archive'
        throw error
      }
      if (activeIds.has(sessionId)) {
        const error = new Error(`workspace: session ${sessionId} is active`)
        error.name = 'WorkspaceActiveSessionError'
        error.sessionId = sessionId
        error.activity = [{ kind: 'agent', items: [{ id: 'turn-1' }] }]
        throw error
      }
      workspaceState.state.archivedSessionIds = [...workspaceState.state.archivedSessionIds, sessionId]
      workspaceState.state.pinnedSessionIds = workspaceState.state.pinnedSessionIds.filter((id) => id !== sessionId)
      await persistWorkspace()
    },
    async unarchiveSession(sessionId) {
      if (!workspaceState.state.archivedSessionIds.includes(sessionId)) return
      workspaceState.state.archivedSessionIds = workspaceState.state.archivedSessionIds.filter((id) => id !== sessionId)
      await persistWorkspace()
    },
    async pinSession(sessionId) {
      if (!workspaceState.state.pinnedSessionIds.includes(sessionId)) {
        workspaceState.state.pinnedSessionIds = [sessionId, ...workspaceState.state.pinnedSessionIds]
        await persistWorkspace()
      }
    },
  }

  const sessionPersistence = {
    async list() {
      return sessions.map((row) => ({
        header: row.header,
        formatStatus: 'current',
        revision: `rev-${row.header.id}`,
        sizeBytes: 1024,
      }))
    },
    async stat(id) {
      return (await sessionPersistence.list()).find((snapshot) => snapshot.header.id === id)
    },
    async flush() {},
  }

  const sessionProjectionCache = {
    cachedSnapshot(meta, keys) {
      const file = path.join(projectionDir, `${meta?.id}.json`)
      // 假实现同步读不可行，这里用内存表模拟内核的同步内存表。
      const value = projectionTitles.get(meta?.id)
      if (value === undefined) return undefined
      const values = {}
      for (const key of keys ?? ['title']) {
        if (key === 'title') values.title = value
      }
      return { asOfSeq: 42, values }
    },
    requireTable() {
      return {
        async delete(sessionId) {
          const file = path.join(projectionDir, `${sessionId}.json`)
          if (!(await exists(file))) return false
          await fsp.rm(file, { force: true })
          return true
        },
      }
    },
  }

  const projectionTitles = new Map()
  for (const row of sessions) projectionTitles.set(row.header.id, row.title)

  const sessionsService = {
    get(id) {
      return liveIds.has(id) ? { id } : undefined
    },
    list() {
      return [...liveIds].map((id) => ({ id }))
    },
  }

  return {
    workspaceState,
    workspaceFile,
    projectionDir,
    workspaceRegistry,
    sessionPersistence,
    sessionProjectionCache,
    sessions: sessionsService,
  }
}

/** 假 webServer：真实 node:http + 与内核一致的 exact/prefix 匹配语义。 */
function createFakeWebServer() {
  const exact = new Map()
  const prefixes = []
  const server = createServer(async (req, res) => {
    const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
    const pathname = url.pathname
    let handler = exact.get(pathname)
    if (handler === undefined) {
      const sorted = [...prefixes].sort((a, b) => b.path.length - a.path.length)
      const match = sorted.find((entry) => pathname === entry.path || pathname.startsWith(`${entry.path}/`))
      handler = match?.handler
    }
    if (handler === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('no route')
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end(String(error?.message ?? error))
      } else {
        res.destroy()
      }
    }
  })

  const webServer = {
    register(route) {
      if (route.kind === 'exact') {
        if (exact.has(route.path)) throw new Error(`webserver: duplicate exact route ${route.path}`)
        exact.set(route.path, route.handler)
        return () => exact.delete(route.path)
      }
      if (route.kind === 'prefix') {
        if (prefixes.some((entry) => entry.path === route.path)) throw new Error(`webserver: duplicate prefix route ${route.path}`)
        const entry = { path: route.path, handler: route.handler }
        prefixes.push(entry)
        return () => {
          const index = prefixes.indexOf(entry)
          if (index >= 0) prefixes.splice(index, 1)
        }
      }
      throw new Error(`webserver: unknown route kind ${route.kind}`)
    },
    routes() {
      return { exact: [...exact.keys()], prefixes: prefixes.map((entry) => entry.path) }
    },
  }

  return { server, webServer }
}

function createFakeCtx(services) {
  const effects = []
  const logs = []
  const ctx = {
    logs,
    effects,
    logger: {
      info: (message) => logs.push({ level: 'info', message: String(message) }),
      warn: (message) => logs.push({ level: 'warn', message: String(message) }),
      error: (message) => logs.push({ level: 'error', message: String(message) }),
    },
    get(serviceName) {
      return services[serviceName]
    },
    effect(setup, label) {
      const disposer = setup()
      const entry = { label, disposer: typeof disposer === 'function' ? disposer : undefined }
      effects.push(entry)
      return () => {
        entry.disposer?.()
      }
    },
  }
  for (const [serviceName, value] of Object.entries(services)) ctx[serviceName] = value
  return ctx
}

/** 假定时器：apply 会装首巡 60s 定时器，e2e 里不需要它真的触发。 */
function createNoopTimers() {
  const handle = () => ({ unref() {} })
  return {
    setTimeout: () => handle(),
    clearTimeout: () => {},
    setInterval: () => handle(),
    clearInterval: () => {},
  }
}

async function httpJson(base, { method = 'GET', pathname, body, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

/**
 * 低层 HTTP 请求：fetch 会覆盖 Host 头（forbidden header），
 * 验证「非回环 Host → 403」必须用 node:http 自己发。
 */
function httpRaw(base, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: url.hostname, port: url.port, method, path: pathname, headers },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          let json
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
          resolve({ status: response.statusCode, json, text })
        })
      },
    )
    request.on('error', reject)
    if (body !== undefined) request.write(typeof body === 'string' ? body : JSON.stringify(body))
    request.end()
  })
}

// ---------------------------------------------------------------------------
// 场景数据
// ---------------------------------------------------------------------------

const SESSION_ROWS = [
  // id, mtimeDaysAgo, archived, pinned, 期望
  { id: 'session-a-idle', mtimeDaysAgo: 25, archived: false, pinned: false },
  { id: 'session-b-active', mtimeDaysAgo: 24, archived: false, pinned: false, active: true },
  { id: 'session-c-idle', mtimeDaysAgo: 23, archived: false, pinned: false },
  { id: 'session-d-fresh', mtimeDaysAgo: 1, archived: false, pinned: false },
  { id: 'session-e-archived-old', mtimeDaysAgo: 120, archived: true, pinned: false },
  { id: 'session-f-archived-new', mtimeDaysAgo: 100, archived: true, pinned: false },
  { id: 'session-g-archived-fresh', mtimeDaysAgo: 10, archived: true, pinned: false },
  { id: 'session-h-pinned', mtimeDaysAgo: 30, archived: false, pinned: true },
  { id: 'session-i-protected', mtimeDaysAgo: 30, archived: false, pinned: false },
]

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-auto-archive-e2e-'))
  const dshHome = path.join(root, 'dsh-home')
  const dataDir = path.join(root, 'auto-archive')
  const attachmentsDir = path.join(dshHome, 'attachments')
  await fsp.mkdir(attachmentsDir, { recursive: true })
  await fsp.writeFile(path.join(attachmentsDir, 'a.png'), Buffer.from('fake-attachment-bytes'))

  console.log(`\n[setup] temp root = ${root}`)

  // 1) 造真实形态的会话日志 + 投影缓存
  const sessions = []
  for (const row of SESSION_ROWS) {
    const artifact = await writeSessionArtifact(dshHome, row.id, { mtimeDaysAgo: row.mtimeDaysAgo })
    await writeProjectionCache(dshHome, row.id, `标题-${row.id}`)
    sessions.push({
      row,
      artifact,
      header: {
        type: 'session',
        version: 4,
        id: row.id,
        createdAt: NOW - 400 * DAY,
        cwd: 'C:\\work\\demo',
        isSeeded: false,
        agentPreset: 'default',
      },
    })
  }

  // 2) 假内核 + 初始 workspace 归档/置顶状态
  const kernel = createFakeKernel({
    dshHome,
    sessions,
    liveIds: new Set(['session-b-active']),
    activeIds: new Set(['session-b-active']),
  })
  kernel.workspaceState.state.archivedSessionIds = SESSION_ROWS.filter((row) => row.archived).map((row) => row.id)
  kernel.workspaceState.state.pinnedSessionIds = ['session-h-pinned']
  await fsp.mkdir(path.dirname(kernel.workspaceFile), { recursive: true })
  await fsp.writeFile(kernel.workspaceFile, JSON.stringify(kernel.workspaceState, null, 2))

  // 3) 预置插件配置：idleDays=14、unusedDays=90、预算 3（用于验证 limit）
  await fsp.mkdir(dataDir, { recursive: true })
  await fsp.writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        autoArchive: { enabled: true, idleDays: 14, checkIntervalMinutes: 30 },
        cacheCleanup: { enabled: true, unusedDays: 90 },
        protect: { pinnedSessions: true, sessionIds: ['session-i-protected'], workspaces: [] },
        limits: { maxOperationsPerRun: 3 },
        dryRun: false,
      },
      null,
      2,
    ),
  )

  const { server, webServer } = createFakeWebServer()
  const ctx = createFakeCtx({
    webServer,
    sessionPersistence: kernel.sessionPersistence,
    sessions: kernel.sessions,
    workspaceRegistry: kernel.workspaceRegistry,
    sessionProjectionCache: kernel.sessionProjectionCache,
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  console.log(`[setup] fake host listening on ${base}`)

  const { apply } = await import(pathToFileURL(PLUGIN_ENTRY).href)
  await apply(ctx, {
    dataDir,
    dshHome,
    now: () => NOW,
    timers: createNoopTimers(),
  })

  const cleanup = async () => {
    try {
      for (const entry of ctx.effects) entry.disposer?.()
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => server.close(resolve))
    await fsp.rm(root, { recursive: true, force: true })
  }

  try {
    console.log('\n[1] 启动后：路由已注册、初始状态正确')
    assertOk(webServer.routes().prefixes.includes('/dsh-auto-archive'), 'prefix 路由 /dsh-auto-archive 已注册')
    const state0 = await httpJson(base, { pathname: '/dsh-auto-archive/api/state' })
    assertOk(state0.status === 200 && state0.json?.ok === true, 'GET /api/state → 200 ok')
    assertOk(state0.json?.counts?.stored === 9, `counts.stored === 9（实际 ${state0.json?.counts?.stored}）`)
    assertOk(state0.json?.counts?.archived === 3, `counts.archived === 3（实际 ${state0.json?.counts?.archived}）`)
    assertOk(state0.json?.counts?.pinned === 1, `counts.pinned === 1（实际 ${state0.json?.counts?.pinned}）`)
    assertOk(state0.json?.counts?.eligibleArchive === 3, `counts.eligibleArchive === 3（实际 ${state0.json?.counts?.eligibleArchive}）`)
    assertOk(state0.json?.counts?.eligibleCache === 2, `counts.eligibleCache === 2（实际 ${state0.json?.counts?.eligibleCache}）`)
    assertOk(state0.json?.pluginVersion === '0.1.0', 'pluginVersion === 0.1.0')
    assertOk(state0.json?.config?.limits?.maxOperationsPerRun === 3, 'config 从 config.json 读取（预算 3）')

    console.log('\n[2] GET /api/sessions：排序与分类字段')
    const sessionsResp = await httpJson(base, { pathname: '/dsh-auto-archive/api/sessions?limit=200' })
    assertOk(sessionsResp.status === 200 && sessionsResp.json?.ok === true, 'GET /api/sessions → 200 ok')
    const rows = sessionsResp.json.sessions
    assertOk(Array.isArray(rows) && rows.length === 9, `sessions 长度 === 9（实际 ${rows?.length}）`)
    assertOk(rows[0].id === 'session-e-archived-old', `按 lastActivity 升序（首条 ${rows[0]?.id}）`)
    const byId = new Map(rows.map((row) => [row.id, row]))
    assertOk(byId.get('session-a-idle')?.eligibleArchive === true, 'session-a-idle eligibleArchive === true')
    assertOk(byId.get('session-a-idle')?.title === '标题-session-a-idle', '标题来自 cachedSnapshot')
    assertOk(byId.get('session-h-pinned')?.protected === true, 'pinned 会话 protected === true')
    assertOk(byId.get('session-i-protected')?.protected === true, 'protect.sessionIds 命中 protected === true')
    assertOk(byId.get('session-e-archived-old')?.eligibleCache === true, '已归档且 120 天 → eligibleCache')
    assertOk(byId.get('session-g-archived-fresh')?.eligibleCache === false, '已归档但仅 10 天 → 不 eligibleCache')
    assertOk(byId.get('session-d-fresh')?.eligibleArchive === false, '1 天会话不 eligibleArchive')

    // 全量哈希快照（dry-run 前后必须一致）
    const transcriptBefore = await hashTree(path.join(dshHome, 'sessions'))
    const projcacheBefore = await hashTree(kernel.projectionDir)
    const workspaceBefore = sha256(await fsp.readFile(kernel.workspaceFile))
    const stateBefore = await exists(path.join(dataDir, 'state.json'))
      ? sha256(await fsp.readFile(path.join(dataDir, 'state.json')))
      : '<missing>'
    const attachmentsBefore = await hashTree(attachmentsDir)

    console.log('\n[3] dryRun：只预览，零副作用')
    const dry = await httpJson(base, { method: 'POST', pathname: '/dsh-auto-archive/api/run', body: { dryRun: true } })
    assertOk(dry.status === 200 && dry.json?.ok === true, 'POST /api/run {dryRun:true} → 200 ok')
    assertOk(dry.json?.mode === 'dry-run', `mode === dry-run（实际 ${dry.json?.mode}）`)
    assertOk(
      JSON.stringify(dry.json?.archived?.map((item) => item.id)) === JSON.stringify(['session-a-idle', 'session-b-active', 'session-c-idle']),
      `dry-run 预览归档候选（实际 ${JSON.stringify(dry.json?.archived?.map((item) => item.id))}）`,
    )
    const drySkipped = new Map((dry.json?.skipped ?? []).map((item) => [item.id, item.reason]))
    assertOk(drySkipped.get('session-e-archived-old') === 'limit', 'dry-run 中清理候选因预算 3 记 limit')
    assertOk(
      (await hashTree(path.join(dshHome, 'sessions'))) === transcriptBefore,
      'dry-run 后 transcript 树哈希不变',
    )
    assertOk((await hashTree(kernel.projectionDir)) === projcacheBefore, 'dry-run 后投影缓存树哈希不变')
    assertOk(sha256(await fsp.readFile(kernel.workspaceFile)) === workspaceBefore, 'dry-run 后 workspace.json 哈希不变')
    const stateAfterDry = (await exists(path.join(dataDir, 'state.json')))
      ? sha256(await fsp.readFile(path.join(dataDir, 'state.json')))
      : '<missing>'
    assertOk(stateAfterDry === stateBefore, 'dry-run 不写 state.json')

    console.log('\n[4] 真跑第一轮：归档 + 活动跳过 + 预算 limit')
    const run1 = await httpJson(base, { method: 'POST', pathname: '/dsh-auto-archive/api/run', body: { dryRun: false } })
    assertOk(run1.status === 200 && run1.json?.ok === true, 'POST /api/run {dryRun:false} → 200 ok')
    assertOk(run1.json?.mode === 'manual', `mode === manual（实际 ${run1.json?.mode}）`)
    const run1Archived = run1.json?.archived?.map((item) => item.id) ?? []
    assertOk(JSON.stringify(run1Archived) === JSON.stringify(['session-a-idle', 'session-c-idle']), `归档 A、C（实际 ${JSON.stringify(run1Archived)}）`)
    const run1Skipped = new Map((run1.json?.skipped ?? []).map((item) => [item.id, item.reason]))
    assertOk(run1Skipped.get('session-b-active') === 'active', '活动会话 B skipped: active')
    assertOk(run1Skipped.get('session-e-archived-old') === 'limit', '清理候选 E 因预算 limit')
    assertOk(run1Skipped.get('session-f-archived-new') === 'limit', '清理候选 F 因预算 limit')
    assertOk((run1.json?.cachePurged ?? []).length === 0, '第一轮未清理任何缓存（预算被归档用完）')

    const workspaceAfterRun1 = JSON.parse(await fsp.readFile(kernel.workspaceFile, 'utf8'))
    assertOk(
      JSON.stringify(workspaceAfterRun1.state.archivedSessionIds) ===
        JSON.stringify(['session-e-archived-old', 'session-f-archived-new', 'session-g-archived-fresh', 'session-a-idle', 'session-c-idle']),
      'workspace.json archivedSessionIds 追加 A、C（归档只写 registry）',
    )
    assertOk((await hashTree(path.join(dshHome, 'sessions'))) === transcriptBefore, '第一轮后 transcript 树哈希不变')
    assertOk((await hashTree(kernel.projectionDir)) === projcacheBefore, '第一轮后投影缓存树哈希不变（清理未执行）')
    assertOk((await hashTree(attachmentsDir)) === attachmentsBefore, '第一轮后 attachments 哈希不变')
    const state1 = JSON.parse(await fsp.readFile(path.join(dataDir, 'state.json'), 'utf8'))
    assertOk(state1.history.length === 1, `state.history 长度 1（实际 ${state1.history.length}）`)

    console.log('\n[5] 放宽预算 + 第二轮：清理只删 eligible 的 projcache json')
    const configResp = await httpJson(base, {
      method: 'POST',
      pathname: '/dsh-auto-archive/api/config',
      body: { limits: { maxOperationsPerRun: 10 } },
    })
    assertOk(configResp.status === 200 && configResp.json?.ok === true, 'POST /api/config 放宽预算 → 200 ok')
    assertOk(configResp.json?.config?.limits?.maxOperationsPerRun === 10, '配置已生效（预算 10）')

    const run2 = await httpJson(base, { method: 'POST', pathname: '/dsh-auto-archive/api/run', body: { dryRun: false } })
    const run2Skipped = new Map((run2.json?.skipped ?? []).map((item) => [item.id, item.reason]))
    assertOk(run2Skipped.get('session-b-active') === 'active', '第二轮 B 仍 active 跳过')
    const purged = (run2.json?.cachePurged ?? []).map((item) => item.id)
    assertOk(JSON.stringify(purged) === JSON.stringify(['session-e-archived-old', 'session-f-archived-new']), `清理 E、F（实际 ${JSON.stringify(purged)}）`)
    assertOk(!(await exists(path.join(kernel.projectionDir, 'session-e-archived-old.json'))), 'E 的 projcache json 已删除')
    assertOk(!(await exists(path.join(kernel.projectionDir, 'session-f-archived-new.json'))), 'F 的 projcache json 已删除')
    assertOk(await exists(path.join(kernel.projectionDir, 'session-g-archived-fresh.json')), 'G（未满 90 天）projcache 保留')
    assertOk(await exists(path.join(kernel.projectionDir, 'session-a-idle.json')), 'A（归档但未满 90 天）projcache 保留')
    assertOk((await hashTree(path.join(dshHome, 'sessions'))) === transcriptBefore, '第二轮后 transcript 树哈希不变')
    assertOk((await hashTree(attachmentsDir)) === attachmentsBefore, '第二轮后 attachments 哈希不变')
    assertOk(await exists(sessions[0].artifact), '会话目录/日志仍在（未删会话）')
    const state2 = JSON.parse(await fsp.readFile(path.join(dataDir, 'state.json'), 'utf8'))
    assertOk(state2.history.length === 2, `state.history 长度 2（实际 ${state2.history.length}）`)

    console.log('\n[6] 恢复归档（restore）')
    const restore = await httpJson(base, {
      method: 'POST',
      pathname: '/dsh-auto-archive/api/restore',
      body: { sessionIds: ['session-a-idle', 'session-unknown'] },
    })
    assertOk(restore.status === 200 && restore.json?.ok === true, 'POST /api/restore → 200 ok')
    // 内核 unarchiveSession 不做存在性检查：未归档的 id 是 no-op 且不报错，
    // 所以未知 id 也会出现在 restored 里（真实语义，见 docs/kernel-api.md §4.2）。
    assertOk((restore.json?.restored ?? []).includes('session-a-idle'), 'restored 含 session-a-idle')
    assertOk(Array.isArray(restore.json?.failed) && restore.json.failed.length === 0, 'unarchive 对未知 id 幂等（failed 为空）')
    const workspaceAfterRestore = JSON.parse(await fsp.readFile(kernel.workspaceFile, 'utf8'))
    assertOk(!workspaceAfterRestore.state.archivedSessionIds.includes('session-a-idle'), 'workspace.json 已移除 A')
    const stateAfterRestore = await httpJson(base, { pathname: '/dsh-auto-archive/api/state' })
    // 初始 3（E/F/G）+ 第一轮归档 2（A/C）= 5；restore 掉 A → 4。
    assertOk(stateAfterRestore.json?.counts?.archived === 4, `恢复后 archived === 4（实际 ${stateAfterRestore.json?.counts?.archived}）`)

    console.log('\n[7] 安全与错误处理')
    // fetch 会强制覆盖 Host（forbidden header），所以用 node:http 直接发。
    const forbidden = await httpRaw(base, {
      pathname: '/dsh-auto-archive/api/state',
      headers: { host: 'evil.example.com' },
    })
    assertOk(forbidden.status === 403 && forbidden.json?.ok === false, '非回环 Host → 403')
    const unknown = await httpJson(base, { pathname: '/dsh-auto-archive/api/nope' })
    assertOk(unknown.status === 404 && unknown.json?.ok === false, '未知路径 → 404')
    const wrongMethod = await httpJson(base, { pathname: '/dsh-auto-archive/api/run' })
    assertOk(wrongMethod.status === 405, 'GET /api/run → 405')
    const badJson = await httpJson(base, {
      method: 'POST',
      pathname: '/dsh-auto-archive/api/run',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    })
    assertOk(badJson.status === 400 && badJson.json?.ok === false, '非 JSON body → 400')
    const limited = await httpJson(base, { pathname: '/dsh-auto-archive/api/sessions?limit=2' })
    assertOk(limited.json?.sessions?.length === 2 && limited.json?.total === 9, 'sessions?limit=2 生效且 total 不变')

    console.log('\n[8] 并发单飞（第二次 run 返回 busy）')
    // apply() 按 cordis 约定返回 undefined（返回值会被当成 effect），
    // 所以并发/清理只能从 HTTP API 与 ctx.effect 的 disposer 观察。
    const [firstRun, secondRun] = await Promise.all([
      httpJson(base, { method: 'POST', pathname: '/dsh-auto-archive/api/run', body: { dryRun: true } }),
      httpJson(base, { method: 'POST', pathname: '/dsh-auto-archive/api/run', body: { dryRun: true } }),
    ])
    const statuses = [firstRun.status, secondRun.status].sort()
    assertOk(statuses.includes(200) && statuses.includes(409), `并发两次 run → 一个 200、一个 409（实际 ${statuses.join('/')}）`)
    const busy = firstRun.status === 409 ? firstRun : secondRun
    assertOk(busy.json?.ok === false && busy.json?.error === 'busy', '409 响应体 {ok:false,error:"busy"}')

    console.log('\n[9] effect 清理：路由与定时器被移除')
    for (const entry of ctx.effects) entry.disposer?.()
    assertOk(webServer.routes().prefixes.length === 0, 'dispose 后 prefix 路由已移除')
    const afterDispose = await httpJson(base, { pathname: '/dsh-auto-archive/api/state' })
    assertOk(afterDispose.status === 404, 'dispose 后请求 → 404（路由不存在）')

    console.log(`\n[done] ${checks} 项断言通过`)
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error('\n[e2e] 失败：', error)
  process.exitCode = 1
})
