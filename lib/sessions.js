/**
 * dsh-auto-archive —— 会话枚举、最后使用时间、标题、保护/资格分类（CONTRACT.md §6.1–§6.3）。
 *
 * 只读 DSH 数据：
 * - `ctx.sessionPersistence.list()`：全量会话快照（含冷/归档会话）。
 * - `<DSH_HOME>/sessions/* /<encodeSegment(id)>/session.vN.jsonl[.zstd]` 的 mtime（**不读文件内容**）。
 * - `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 仅作标题降级来源。
 * - `ctx.workspaceRegistry.list()` / `.pinnedSessionIds` / `.archivedSessionIds`。
 * 本模块不写、不删任何 DSH 数据。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { describeError, isPlainObject } from './config.js'

export const DAY_MS = 24 * 60 * 60 * 1000

/** 会话日志文件名（v0: session.jsonl；vN: session.vN.jsonl；可带 .zstd）。 */
const LOG_FILE_PATTERN = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/

/**
 * 复刻 dsh-session-persistence-jsonl 的目录名编码：
 * 非 `[A-Za-z0-9._-]`（以及 `~`）→ `~` + 4 位大写十六进制码点；`..` 特殊处理。
 */
export function encodeSegment(text) {
  const value = String(text)
  if (value === '.') return '~002E'
  if (value === '..') return '~002E~002E'
  let out = ''
  for (const char of value) {
    if (/[A-Za-z0-9._-]/.test(char)) {
      out += char
    } else {
      out += `~${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

export function sessionsRootOf(dshHome) {
  return path.join(dshHome, 'sessions')
}

export function projectionCacheSessionsRootOf(dshHome) {
  return path.join(dshHome, 'storages', 'session_projcache', 'sessions')
}

/** 从 getter/普通属性读字符串数组，任何异常都当空数组。 */
export function readStringArray(owner, name) {
  if (owner === undefined || owner === null) return []
  let value
  try {
    value = owner[name]
  } catch {
    return []
  }
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function toIdSet(values) {
  return new Set((Array.isArray(values) ? values : []).filter((item) => typeof item === 'string'))
}

async function readWorkspaces(workspaceRegistry) {
  if (workspaceRegistry === undefined || workspaceRegistry === null) return []
  if (typeof workspaceRegistry.list !== 'function') return []
  try {
    let value = workspaceRegistry.list()
    if (value !== null && typeof value === 'object' && typeof value.then === 'function') value = await value
    return Array.isArray(value) ? value.filter((item) => isPlainObject(item)) : []
  } catch {
    return []
  }
}

/**
 * 扫描 `<sessionsRoot>/<project>/<sessionDir>/`，取每个会话最新日志文件 mtime。
 * 目录名同时接受 encodeSegment(id) 与原始 id（宽松兼容），失败一律忽略。
 *
 * @param {string} sessionsRoot
 * @param {string[]} sessionIds
 * @returns {Promise<Map<string, number>>}
 */
export async function collectArtifactMtimes(sessionsRoot, sessionIds) {
  const result = new Map()
  const ids = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === 'string') : []
  if (ids.length === 0 || typeof sessionsRoot !== 'string') return result

  const bySegment = new Map()
  const rawIds = new Set(ids)
  for (const id of ids) {
    const segment = encodeSegment(id)
    if (!bySegment.has(segment)) bySegment.set(segment, id)
  }

  let projectEntries
  try {
    projectEntries = await fsp.readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return result
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectPath = path.join(sessionsRoot, projectEntry.name)
    let sessionEntries
    try {
      sessionEntries = await fsp.readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue
      const id = bySegment.get(sessionEntry.name) ?? (rawIds.has(sessionEntry.name) ? sessionEntry.name : undefined)
      if (id === undefined) continue
      const directory = path.join(projectPath, sessionEntry.name)
      let files
      try {
        files = await fsp.readdir(directory)
      } catch {
        continue
      }
      let newest = 0
      for (const file of files) {
        if (!LOG_FILE_PATTERN.test(file)) continue
        try {
          const stat = await fsp.stat(path.join(directory, file))
          if (Number.isFinite(stat.mtimeMs) && stat.mtimeMs > newest) newest = stat.mtimeMs
        } catch {
          /* 单个文件读不到就忽略 */
        }
      }
      if (newest > 0) {
        const previous = result.get(id) ?? 0
        if (newest > previous) result.set(id, newest)
      }
    }
  }

  return result
}

function pickProjectedTitle(rows) {
  if (!isPlainObject(rows)) return undefined
  const row = rows.title
  if (typeof row === 'string') return row
  if (isPlainObject(row)) {
    for (const key of ['val', 'value', 'text']) {
      if (typeof row[key] === 'string') return row[key]
    }
  }
  return undefined
}

/** 从投影缓存 JSON 结构里找 title（`record.rows.title.val` 为主，宽松兼容包一层 value）。 */
export function extractProjectedTitle(document) {
  if (!isPlainObject(document)) return undefined
  for (const candidate of [document.record, document.value?.record, document, document.value]) {
    if (!isPlainObject(candidate)) continue
    const title = pickProjectedTitle(candidate.rows)
    if (title !== undefined) return title
  }
  return undefined
}

/** `ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])` → title；失败返回 undefined。 */
export function titleFromProjectionCache(sessionProjectionCache, header) {
  if (sessionProjectionCache === undefined || sessionProjectionCache === null) return undefined
  if (typeof sessionProjectionCache.cachedSnapshot !== 'function') return undefined
  try {
    const meta = {
      id: header.id,
      version: header.version,
      createdAt: header.createdAt,
      isSeeded: header.isSeeded,
    }
    if (header.cwd !== undefined) meta.cwd = header.cwd
    const snapshot = sessionProjectionCache.cachedSnapshot(meta, ['title'])
    const title = snapshot?.values?.title
    if (typeof title === 'string' && title.trim() !== '') return title
    if (isPlainObject(title)) {
      for (const key of ['val', 'value', 'text']) {
        if (typeof title[key] === 'string' && title[key].trim() !== '') return title[key]
      }
    }
  } catch {
    /* 缓存未命中 / 身份不匹配 / 服务异常都走降级 */
  }
  return undefined
}

/** 读 `<root>/<id>.json` 的 `record.rows.title.val`；失败返回 undefined。 */
export async function titleFromProjectionFile(projectionRoot, sessionId) {
  if (typeof projectionRoot !== 'string' || projectionRoot === '') return undefined
  const names = new Set([`${sessionId}.json`, `${encodeSegment(sessionId)}.json`])
  for (const name of names) {
    let text
    try {
      text = await fsp.readFile(path.join(projectionRoot, name), 'utf8')
    } catch {
      continue
    }
    try {
      const title = extractProjectedTitle(JSON.parse(text))
      if (typeof title === 'string' && title.trim() !== '') return title
    } catch {
      /* 坏文件忽略 */
    }
  }
  return undefined
}

export async function resolveSessionTitle(sessionProjectionCache, header, projectionRoot) {
  const cached = titleFromProjectionCache(sessionProjectionCache, header)
  if (cached !== undefined) return cached
  const fromFile = await titleFromProjectionFile(projectionRoot, header.id)
  if (fromFile !== undefined) return fromFile
  return header.id
}

function readLiveSessions(services) {
  const sessions = services?.sessions
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return []
  try {
    const live = sessions.list()
    return Array.isArray(live) ? live : []
  } catch {
    return []
  }
}

/**
 * 枚举 + 组装原始会话记录（未做 14/90 天资格判定）。
 *
 * @param {object} runtime 需要 now()/dshHome/getServices()
 * @returns {Promise<{records: object[], archivedIds: Set<string>, pinnedIds: Set<string>, live: number}>}
 */
export async function collectSessionInventory(runtime, { now = runtime.now() } = {}) {
  const services = runtime.getServices()
  const persistence = services?.sessionPersistence
  if (persistence === undefined || persistence === null || typeof persistence.list !== 'function') {
    throw new Error('sessionPersistence.list() 不可用，无法枚举会话')
  }
  const snapshots = await persistence.list()
  const list = Array.isArray(snapshots) ? snapshots : []

  const seen = new Set()
  const entries = []
  for (const snapshot of list) {
    const header = isPlainObject(snapshot) && isPlainObject(snapshot.header) ? snapshot.header : snapshot
    if (!isPlainObject(header)) continue
    if (typeof header.id !== 'string' || header.id === '') continue
    if (seen.has(header.id)) continue
    seen.add(header.id)
    entries.push({ header, snapshot: isPlainObject(snapshot) ? snapshot : {} })
  }

  const registry = services?.workspaceRegistry
  const archivedIds = toIdSet(readStringArray(registry, 'archivedSessionIds'))
  const pinnedIds = toIdSet(readStringArray(registry, 'pinnedSessionIds'))
  const workspaces = await readWorkspaces(registry)

  const workspaceBySession = new Map()
  const workspaceCount = new Map()
  for (const workspace of workspaces) {
    if (typeof workspace.id !== 'string') continue
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    workspaceCount.set(workspace.id, sessionIds.length)
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string') continue
      if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace)
    }
  }

  const dshHome = typeof runtime.dshHome === 'string' && runtime.dshHome !== '' ? runtime.dshHome : undefined
  const mtimes = dshHome === undefined
    ? new Map()
    : await collectArtifactMtimes(sessionsRootOf(dshHome), entries.map((entry) => entry.header.id))
  const projectionRoot = dshHome === undefined ? undefined : projectionCacheSessionsRootOf(dshHome)
  const projectionCache = services?.sessionProjectionCache

  const records = []
  for (const { header, snapshot } of entries) {
    const createdAt = Number.isFinite(header.createdAt)
      ? header.createdAt
      : (Number.isFinite(snapshot.createdAt) ? snapshot.createdAt : undefined)
    const cwd = typeof header.cwd === 'string' && header.cwd !== ''
      ? header.cwd
      : (typeof snapshot.cwd === 'string' && snapshot.cwd !== '' ? snapshot.cwd : undefined)
    const mtime = mtimes.get(header.id)
    const activity = Math.max(
      Number.isFinite(createdAt) ? createdAt : 0,
      Number.isFinite(mtime) ? mtime : 0,
    )
    const workspace = workspaceBySession.get(header.id)
    const title = await resolveSessionTitle(projectionCache, header, projectionRoot)
    records.push({
      id: header.id,
      title,
      workspaceId: workspace !== undefined ? workspace.id : null,
      workspaceName: typeof workspace?.title === 'string' ? workspace.title : null,
      cwd: cwd ?? (typeof workspace?.path === 'string' ? workspace.path : null),
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
      lastActivityMs: activity > 0 ? activity : now,
      archived: archivedIds.has(header.id),
      pinned: pinnedIds.has(header.id),
    })
  }

  return {
    records,
    archivedIds,
    pinnedIds,
    live: readLiveSessions(services).length,
  }
}

export function roundDays(value) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10) / 10
}

export function idleDaysOf(lastActivityMs, now = Date.now()) {
  if (!Number.isFinite(lastActivityMs)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - lastActivityMs) / DAY_MS)
}

/**
 * 按配置给原始记录补上 idleDays / protected / eligibleArchive / eligibleCache / reason。
 *
 * §6.2：eligibleArchive = !archived && !protected && idleDays >= autoArchive.idleDays
 * §6.3：eligibleCache   = archived && !pinned && idleDays >= cacheCleanup.unusedDays
 * 注意：`enabled` 只影响 run 是否真的执行，不影响 UI 的候选展示（§6.2 备注）。
 */
export function classifySessions(records, config, now = Date.now()) {
  const protectIds = new Set(
    (Array.isArray(config?.protect?.sessionIds) ? config.protect.sessionIds : [])
      .filter((item) => typeof item === 'string'),
  )
  const workspacePatterns = (Array.isArray(config?.protect?.workspaces) ? config.protect.workspaces : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim().toLowerCase())
  const pinProtected = config?.protect?.pinnedSessions !== false
  const archiveThreshold = Number.isFinite(config?.autoArchive?.idleDays) ? config.autoArchive.idleDays : 14
  const cleanupThreshold = Number.isFinite(config?.cacheCleanup?.unusedDays) ? config.cacheCleanup.unusedDays : 90

  return (Array.isArray(records) ? records : []).map((record) => {
    const idleDays = idleDaysOf(record.lastActivityMs, now)
    const pinnedProtected = pinProtected && record.pinned === true
    const idProtected = protectIds.has(record.id)
    const workspaceProtected = workspacePatterns.length > 0 && [record.workspaceId, record.cwd]
      .some((value) => typeof value === 'string' && workspacePatterns.some((pattern) => value.toLowerCase().includes(pattern)))
    const protectedSession = pinnedProtected || idProtected || workspaceProtected
    const archived = record.archived === true
    const eligibleArchive = !archived && !protectedSession && idleDays >= archiveThreshold
    const eligibleCache = archived && record.pinned !== true && idleDays >= cleanupThreshold

    let reason
    if (!eligibleArchive && !eligibleCache) {
      if (protectedSession) reason = 'protected'
      else if (archived) reason = 'archived'
      else if (idleDays < archiveThreshold) reason = 'not-idle'
    }

    return {
      ...record,
      idleDays,
      protected: protectedSession,
      archived,
      eligibleArchive,
      eligibleCache,
      ...(reason === undefined ? {} : { reason }),
    }
  })
}

/** API / RunResult.countsBefore 用的汇总。 */
export function computeCounts(records, { archivedIds, pinnedIds, live = 0 } = {}) {
  const list = Array.isArray(records) ? records : []
  return {
    stored: list.length,
    live: Number.isFinite(live) ? live : 0,
    archived: archivedIds instanceof Set ? archivedIds.size : 0,
    pinned: pinnedIds instanceof Set ? pinnedIds.size : 0,
    eligibleArchive: list.filter((record) => record.eligibleArchive === true).length,
    eligibleCache: list.filter((record) => record.eligibleCache === true).length,
  }
}

/** 降级函数：从 sessionPersistence.stat 判断会话是否还存在（供将来使用，当前 run 不用）。 */
export async function sessionStillStored(persistence, sessionId) {
  if (persistence === undefined || persistence === null || typeof persistence.stat !== 'function') return undefined
  try {
    const snapshot = await persistence.stat(sessionId)
    return snapshot !== undefined && snapshot !== null
  } catch (error) {
    if (typeof error?.message === 'string' && /not found|unknown/i.test(error.message)) return false
    return undefined
  }
}

export { describeError }
