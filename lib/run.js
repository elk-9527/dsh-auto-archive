/**
 * dsh-auto-archive —— 一轮巡检编排（CONTRACT.md §6.2–§6.5）。
 *
 * 一次 run：
 * 1. 枚举会话 + 计算 lastActivity / 标题 / pinned / archived（sessions.js）。
 * 2. 候选按 lastActivity 升序；归档与清理共享 limits.maxOperationsPerRun 预算，先归档后清理。
 * 3. 归档：`workspaceRegistry.archiveSession(id)`（**绝不传 stopActivity**）；活动中的会话记 skipped: 'active'。
 * 4. 清理：只删该会话的投影缓存行（requireTable().delete(id)，或降级删 projcache 单个 json）。
 * 5. dry-run 只列候选，零变更、不写 state。
 * 6. 所有异常捕获进 result.errors / skipped，绝不抛出。
 *
 * Runtime 约定（index.js 构造）：
 *   { now(), logger, dataDir, dshHome, getConfig(), getServices(), getState(), saveState(state), activeRun }
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { DAY_MS, classifySessions, collectSessionInventory, computeCounts, encodeSegment, projectionCacheSessionsRootOf } from './sessions.js'
import { defaultState, recordRun } from './state.js'
import { describeError } from './config.js'

const MAX_ERROR_TEXT = 500

function errorText(error) {
  const text = describeError(error)
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text
}

/** 工作中会话错误（kernel: WorkspaceActiveSessionError）。 */
export function isActiveSessionError(error) {
  if (error === undefined || error === null) return false
  if (error.name === 'WorkspaceActiveSessionError') return true
  if (typeof error.code === 'string' && /ACTIVE/i.test(error.code)) return true
  return typeof error.message === 'string' && /is active|active session/i.test(error.message)
}

function toOperation(record) {
  return {
    id: record.id,
    title: record.title,
    lastActivityDays: Math.round(record.idleDays * 10) / 10,
  }
}

function emptyResult(mode, startedAt) {
  return {
    runId: randomUUID(),
    at: startedAt,
    mode,
    archived: [],
    cachePurged: [],
    skipped: [],
    errors: [],
    startedAt,
    finishedAt: startedAt,
    countsBefore: { stored: 0, live: 0, archived: 0, pinned: 0, eligibleArchive: 0, eligibleCache: 0 },
  }
}

/**
 * 删除一个会话的 DSH 投影缓存行。
 *
 * 唯一允许的删除动作。优先走 `sessionProjectionCache.requireTable().delete(id)`；
 * 只有表 API 不可用（服务缺失 / requireTable 抛错 / 没有 delete）时才降级为删除
 * `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`（删前 stat 确认存在，且只删这一个文件）。
 * 绝不触碰 transcript / 会话目录 / 附件 / spill。
 *
 * @returns {Promise<{purged: boolean, method: string}>}
 */
export async function purgeProjectionCache(runtime, sessionId) {
  const services = runtime.getServices()
  const projectionCache = services?.sessionProjectionCache

  if (projectionCache !== undefined && projectionCache !== null && typeof projectionCache.requireTable === 'function') {
    let table
    try {
      table = projectionCache.requireTable()
    } catch {
      table = undefined
    }
    if (table !== undefined && table !== null && typeof table.delete === 'function') {
      const deleted = await table.delete(sessionId)
      // delete() 返回 false 表示本来就没有这一行：没有发生删除，但也不算失败。
      return { purged: deleted === true, method: 'table' }
    }
  }

  const dshHome = typeof runtime.dshHome === 'string' && runtime.dshHome !== '' ? runtime.dshHome : undefined
  if (dshHome === undefined) return { purged: false, method: 'unavailable' }

  const directory = projectionCacheSessionsRootOf(dshHome)
  const names = [...new Set([`${sessionId}.json`, `${encodeSegment(sessionId)}.json`])]
  for (const name of names) {
    const file = path.join(directory, name)
    let stat
    try {
      stat = await fsp.stat(file)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (!stat.isFile()) continue
    await fsp.rm(file, { force: true })
    return { purged: true, method: 'file' }
  }
  return { purged: false, method: 'file-missing' }
}

async function persistResult(runtime, result) {
  try {
    const previous = runtime.getState() ?? defaultState(runtime.now())
    const next = recordRun(previous, result)
    await runtime.saveState(next)
  } catch (error) {
    const message = `写入 state.json 失败：${errorText(error)}`
    runtime.logger?.warn?.(message)
    result.errors.push({ id: '*', error: message })
  }
}

/**
 * 执行一轮巡检。
 *
 * @param {object} runtime
 * @param {{mode?: 'auto'|'manual', dryRun?: boolean}} [options]
 * @returns {Promise<{ok: true, busy: false, result: object} | {ok: false, busy: true} | {ok: false, busy: false, error: string}>}
 */
export async function runOnce(runtime, options = {}) {
  // 单飞：同一时刻只允许一轮；并发调用立即返回 busy（API 层回 409）。
  if (runtime.activeRun !== undefined && runtime.activeRun !== null) {
    return { ok: false, busy: true }
  }
  const promise = executeRun(runtime, options)
  runtime.activeRun = promise
  try {
    const result = await promise
    return { ok: true, busy: false, result }
  } catch (error) {
    const message = errorText(error)
    runtime.logger?.error?.(`巡检意外失败：${message}`)
    return { ok: false, busy: false, error: message }
  } finally {
    if (runtime.activeRun === promise) runtime.activeRun = null
  }
}

async function executeRun(runtime, options) {
  const startedAt = runtime.now()
  const config = runtime.getConfig()
  const requestedDryRun = typeof options?.dryRun === 'boolean' ? options.dryRun : undefined
  const dryRun = requestedDryRun === undefined ? config?.dryRun === true : requestedDryRun
  const mode = dryRun ? 'dry-run' : (options?.mode === 'auto' ? 'auto' : 'manual')
  const result = emptyResult(mode, startedAt)

  try {
    const inventory = await collectSessionInventory(runtime, { now: startedAt })
    const classified = classifySessions(inventory.records, config, startedAt)
    result.countsBefore = computeCounts(classified, {
      archivedIds: inventory.archivedIds,
      pinnedIds: inventory.pinnedIds,
      live: inventory.live,
    })

    const archiveEnabled = config?.autoArchive?.enabled !== false
    const cleanupEnabled = config?.cacheCleanup?.enabled !== false
    const maxOperations = Number.isFinite(config?.limits?.maxOperationsPerRun)
      ? Math.max(1, Math.trunc(config.limits.maxOperationsPerRun))
      : 50

    const byActivity = (a, b) => (a.lastActivityMs - b.lastActivityMs) || a.id.localeCompare(b.id)
    const archiveCandidates = archiveEnabled
      ? classified.filter((record) => record.eligibleArchive === true).sort(byActivity)
      : []
    const cleanupCandidates = cleanupEnabled
      ? classified.filter((record) => record.eligibleCache === true).sort(byActivity)
      : []

    let operations = 0
    const nextOperation = () => {
      if (operations >= maxOperations) return false
      operations += 1
      return true
    }

    if (dryRun) {
      for (const record of archiveCandidates) {
        if (!nextOperation()) {
          result.skipped.push({ id: record.id, reason: 'limit' })
          continue
        }
        result.archived.push(toOperation(record))
      }
      for (const record of cleanupCandidates) {
        if (!nextOperation()) {
          result.skipped.push({ id: record.id, reason: 'limit' })
          continue
        }
        result.cachePurged.push(toOperation(record))
      }
    } else {
      const registry = runtime.getServices()?.workspaceRegistry
      for (const record of archiveCandidates) {
        if (!nextOperation()) {
          result.skipped.push({ id: record.id, reason: 'limit' })
          continue
        }
        if (registry === undefined || registry === null || typeof registry.archiveSession !== 'function') {
          result.skipped.push({ id: record.id, reason: 'error' })
          result.errors.push({ id: record.id, error: 'workspaceRegistry.archiveSession 不可用' })
          continue
        }
        try {
          // 不传 stopActivity：有活动由 kernel 抛 WorkspaceActiveSessionError，本插件绝不打断用户会话。
          await registry.archiveSession(record.id)
          result.archived.push(toOperation(record))
        } catch (error) {
          if (isActiveSessionError(error)) {
            result.skipped.push({ id: record.id, reason: 'active' })
          } else {
            result.skipped.push({ id: record.id, reason: 'error' })
            result.errors.push({ id: record.id, error: errorText(error) })
          }
        }
      }

      for (const record of cleanupCandidates) {
        if (!nextOperation()) {
          result.skipped.push({ id: record.id, reason: 'limit' })
          continue
        }
        try {
          const outcome = await purgeProjectionCache(runtime, record.id)
          if (outcome.purged) result.cachePurged.push(toOperation(record))
        } catch (error) {
          result.skipped.push({ id: record.id, reason: 'error' })
          result.errors.push({ id: record.id, error: errorText(error) })
        }
      }
    }
  } catch (error) {
    const message = errorText(error)
    result.errors.push({ id: '*', error: message })
    runtime.logger?.warn?.(`巡检中断：${message}`)
  }

  result.finishedAt = runtime.now()
  if (!dryRun) await persistResult(runtime, result)
  return result
}

export { DAY_MS }
