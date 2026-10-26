/**
 * 单测共用工具：临时目录、假 ctx / 假内核服务、假 HTTP req/res、假定时器。
 *
 * 这些假对象只模拟 CONTRACT.md 依赖到的表面行为，不复制内核实现。
 * 所有测试都使用 mkdtemp 临时目录，绝不碰真实 `~/.dsh`。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

export const DAY_MS = 24 * 60 * 60 * 1000
/** 固定"现在"：2026-01-01T00:00:00Z。 */
export const NOW = Date.UTC(2026, 0, 1)

/** 建临时根目录 + dshHome/dataDir；测试结束时自动删除。 */
export async function makeTempDirs(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-auto-archive-test-'))
  const dshHome = path.join(root, 'dsh-home')
  const dataDir = path.join(root, 'auto-archive')
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return { root, dshHome, dataDir }
}

export function makeHeader(id, { createdAt = NOW - 1 * DAY_MS, cwd = 'C:\\work\\demo', version = 4, isSeeded = false } = {}) {
  return { type: 'session', version, id, createdAt, cwd, isSeeded }
}

export function makeSnapshot(header, extra = {}) {
  return { header, revision: 1, sizeBytes: 1, ...extra }
}

/** 假 workspaceRegistry（list/getter/archiveSession/unarchiveSession）。 */
export function makeWorkspaceRegistry({ workspaces = [], archived = [], pinned = [], onArchive } = {}) {
  const archivedIds = new Set(archived)
  const pinnedIds = new Set(pinned)
  const calls = { archive: [], unarchive: [] }
  return {
    calls,
    list() {
      return workspaces.map((workspace) => ({
        ...workspace,
        sessionIds: Array.isArray(workspace.sessionIds) ? [...workspace.sessionIds] : [],
      }))
    },
    get archivedSessionIds() {
      return [...archivedIds]
    },
    get pinnedSessionIds() {
      return [...pinnedIds]
    },
    async archiveSession(sessionId) {
      calls.archive.push(sessionId)
      if (typeof onArchive === 'function') await onArchive(sessionId)
      archivedIds.add(sessionId)
      pinnedIds.delete(sessionId)
    },
    async unarchiveSession(sessionId) {
      calls.unarchive.push(sessionId)
      archivedIds.delete(sessionId)
    },
    setArchived(sessionId, value = true) {
      if (value) archivedIds.add(sessionId)
      else archivedIds.delete(sessionId)
    },
  }
}

/** 假 sessionProjectionCache：cachedSnapshot + requireTable().delete 记录。 */
export function makeProjectionCache({ snapshots = {}, deleteImpl } = {}) {
  const deleted = []
  const table = {
    get: (id) => snapshots[id],
    async put() {},
    async delete(id) {
      deleted.push(id)
      if (typeof deleteImpl === 'function') {
        const result = await deleteImpl(id)
        if (typeof result === 'boolean') return result
      }
      return true
    },
  }
  return {
    deleted,
    deletedCount() {
      return deleted.length
    },
    cachedSnapshot(meta) {
      const value = snapshots[meta?.id]
      if (value === undefined) return undefined
      return { asOfSeq: 1, values: value }
    },
    requireTable() {
      return table
    },
  }
}

/** 假 sessionPersistence.list()/stat()。 */
export function makePersistence(rows = []) {
  return {
    rows,
    async list() {
      return this.rows
    },
    async stat(id) {
      return this.rows.find((row) => row?.header?.id === id)
    },
  }
}

/** 假 sessions（活会话）。 */
export function makeLiveSessions(ids = []) {
  return { list: () => ids.map((id) => ({ id })) }
}

/** 假 webServer.register。 */
export function makeWebServer() {
  const registrations = []
  return {
    registrations,
    register(spec) {
      registrations.push(spec)
      return () => {
        registrations.pop()
      }
    },
  }
}

/**
 * 假 ctx：服务既有直接属性又有 get()，effect 立即执行并登记 disposer。
 */
export function makeCtx(services = {}, { logger } = {}) {
  const effects = []
  const logs = []
  const ctx = {
    effects,
    logs,
    logger:
      logger ??
      {
        info: (message) => logs.push({ level: 'info', message }),
        warn: (message) => logs.push({ level: 'warn', message }),
        error: (message) => logs.push({ level: 'error', message }),
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
  for (const [serviceName, value] of Object.entries(services)) {
    if (value !== undefined) ctx[serviceName] = value
  }
  return ctx
}

/** 假的 HTTP 请求（可读流 + method/url/headers）。 */
export function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const stream = new Readable({ read() {} })
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    stream.push(Buffer.from(text, 'utf8'))
  }
  stream.push(null)
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

/** 假的 HTTP 响应。 */
export function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk = '') {
      this.body += chunk
      this.ended = true
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

/** 手动时钟 + 假定时器（同步单线程，配合 flush() 等异步 tick 落地）。 */
export function makeFakeTimers(start = NOW) {
  const clock = { value: start }
  const timeouts = []
  const intervals = []
  const timers = {
    clock,
    timeouts,
    intervals,
    now: () => clock.value,
    setTimeout(fn, ms) {
      const handle = { kind: 'timeout', fn, delay: ms, due: clock.value + ms, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true } }
      timeouts.push(handle)
      return handle
    },
    clearTimeout(handle) {
      handle.cleared = true
    },
    setInterval(fn, ms) {
      const handle = { kind: 'interval', fn, delay: ms, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true } }
      intervals.push(handle)
      return handle
    },
    clearInterval(handle) {
      handle.cleared = true
    },
    /** 推进时钟并触发所有到期 timeout。 */
    advance(ms) {
      clock.value += ms
      for (const handle of [...timeouts]) {
        if (!handle.cleared && handle.due <= clock.value) {
          handle.cleared = true
          handle.fn()
        }
      }
    },
    fireIntervals() {
      for (const handle of [...intervals]) {
        if (!handle.cleared) handle.fn()
      }
    },
    liveTimeouts() {
      return timeouts.filter((handle) => !handle.cleared)
    },
    liveIntervals() {
      return intervals.filter((handle) => !handle.cleared)
    },
  }
  return timers
}

export function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 轮询等待条件成立（用于覆盖 runOnce 内部多次 await 的异步落盘）。 */
export async function waitFor(predicate, { timeout = 5000, interval = 10 } = {}) {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeout) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

export class FakeActiveSessionError extends Error {
  constructor(sessionId) {
    super(`cannot archive session '${sessionId}': the session is active (1 active task)`)
    this.name = 'WorkspaceActiveSessionError'
    this.sessionId = sessionId
    this.activity = [{ kind: 'task' }]
  }
}
