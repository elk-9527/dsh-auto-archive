/**
 * dsh-auto-archive —— HTTP API（CONTRACT.md §5）。
 *
 * 前缀 `/dsh-auto-archive`，全部 JSON，回环限定：
 * - 非回环 Host → 403（防 DNS rebinding；无 Host 头视为回环）
 * - 未知路径 → 404；方法不符 → 405；非 JSON body → 400；body > 64KB → 413
 * - 统一 `{ok:true, ...}` / `{ok:false, error}`
 *
 * 路由处理函数绝不把异常抛给宿主：顶层统一 catch 并回 500。
 */
import {
  cloneConfig,
  describeError,
  isPlainObject,
  normalizeConfig,
  saveConfig,
} from './config.js'
import { collectSessionInventory, classifySessions, computeCounts, roundDays } from './sessions.js'
import { runOnce } from './run.js'
import { defaultState } from './state.js'

export const API_PREFIX = '/dsh-auto-archive'
export const MAX_BODY_BYTES = 64 * 1024

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const ROUTES = new Map([
  [`${API_PREFIX}/api/state`, 'GET'],
  [`${API_PREFIX}/api/sessions`, 'GET'],
  [`${API_PREFIX}/api/history`, 'GET'],
  [`${API_PREFIX}/api/config`, 'POST'],
  [`${API_PREFIX}/api/run`, 'POST'],
  [`${API_PREFIX}/api/restore`, 'POST'],
])

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large')
    this.name = 'BodyTooLargeError'
  }
}

function errorText(error) {
  const text = describeError(error)
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/** 无 Host 头（HTTP/1.0 或本机 socket）视为回环；浏览器一定带 Host。 */
export function hostIsLoopback(req) {
  const raw = String(req?.headers?.host ?? '').trim()
  if (raw === '') return true
  let name
  if (raw.startsWith('[')) {
    // [::1]:8080 → [::1]
    const end = raw.indexOf(']')
    name = end === -1 ? raw : raw.slice(0, end + 1)
  } else if (raw.indexOf(':') === -1) {
    // 纯主机名（localhost / 127.0.0.1）
    name = raw
  } else if (raw.indexOf(':') === raw.lastIndexOf(':')) {
    // host:port → host（仅一个冒号）
    name = raw.slice(0, raw.indexOf(':'))
  } else {
    // 裸 IPv6（如 ::1）
    name = raw
  }
  return LOOPBACK_HOSTS.has(name.toLowerCase())
}

/** 非回环来源：自己写 403 并返回 true，调用方直接 return。 */
export function denyNonLoopback(req, res) {
  if (hostIsLoopback(req)) return false
  sendJson(res, 403, { ok: false, error: '拒绝：只接受本机（回环地址）请求' })
  return true
}

function sendJson(res, status, payload, headers = {}) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    status = 500
    body = JSON.stringify({ ok: false, error: '响应序列化失败' })
  }
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    })
    res.end(body)
  } catch {
    try {
      res.end()
    } catch {
      /* 连接已断开 */
    }
  }
  return true
}

/** 读取请求体为 UTF-8 字符串；超过 maxBytes 抛 BodyTooLargeError。 */
export function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let settled = false
    const chunks = []
    let total = 0
    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      try {
        req.destroy?.()
      } catch {
        /* ignore */
      }
      reject(error)
    }

    const declared = Number(req?.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      rejectOnce(new BodyTooLargeError())
      return
    }

    req.on('data', (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > maxBytes) {
        rejectOnce(new BodyTooLargeError())
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => rejectOnce(error))
  })
}

async function readJsonBody(req) {
  const contentType = String(req?.headers?.['content-type'] ?? '').toLowerCase()
  if (contentType !== '' && !contentType.includes('application/json')) {
    throw new HttpError(400, '请求体必须是 JSON（Content-Type: application/json）')
  }
  let text
  try {
    text = await readRequestBody(req)
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new HttpError(413, '请求体过大（上限 64KB）')
    throw error
  }
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

function nextRunAtOf(runtime) {
  try {
    const value = runtime.getNextRunAt?.()
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function configWarningsOf(runtime) {
  return Array.isArray(runtime.configWarnings) ? [...runtime.configWarnings] : []
}

/** GET /api/state */
export async function buildStatePayload(runtime) {
  const config = runtime.getConfig()
  const state = runtime.getState() ?? defaultState(runtime.now())
  const warnings = configWarningsOf(runtime)
  let counts = { stored: 0, live: 0, archived: 0, pinned: 0, eligibleArchive: 0, eligibleCache: 0 }
  try {
    const now = runtime.now()
    const inventory = await collectSessionInventory(runtime, { now })
    const classified = classifySessions(inventory.records, config, now)
    counts = computeCounts(classified, {
      archivedIds: inventory.archivedIds,
      pinnedIds: inventory.pinnedIds,
      live: inventory.live,
    })
  } catch (error) {
    warnings.push(`枚举会话失败：${errorText(error)}`)
  }
  return {
    ok: true,
    config: cloneConfig(config),
    effective: cloneConfig(config),
    lastRunAt: Number.isFinite(state.lastRunAt) ? state.lastRunAt : null,
    lastResult: state.lastResult ?? null,
    counts,
    nextRunAt: nextRunAtOf(runtime),
    pluginVersion: typeof runtime.pluginVersion === 'string' ? runtime.pluginVersion : '0.1.0',
    warnings,
  }
}

/** GET /api/sessions?limit=200 */
export async function buildSessionsPayload(runtime, url) {
  const config = runtime.getConfig()
  const now = runtime.now()
  const inventory = await collectSessionInventory(runtime, { now })
  const classified = classifySessions(inventory.records, config, now)
  classified.sort((a, b) => (a.lastActivityMs - b.lastActivityMs) || a.id.localeCompare(b.id))

  let limit = 200
  const rawLimit = url?.searchParams?.get('limit')
  if (typeof rawLimit === 'string' && rawLimit !== '') {
    const parsed = Number(rawLimit)
    if (Number.isInteger(parsed) && parsed > 0) limit = Math.min(parsed, 1000)
  }
  const sessions = classified.slice(0, limit).map((record) => ({
    id: record.id,
    title: record.title,
    workspaceId: record.workspaceId,
    workspaceName: record.workspaceName,
    cwd: record.cwd,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityMs,
    idleDays: roundDays(record.idleDays),
    archived: record.archived,
    pinned: record.pinned,
    protected: record.protected,
    eligibleArchive: record.eligibleArchive,
    eligibleCache: record.eligibleCache,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  }))
  return { ok: true, sessions, total: classified.length }
}

async function handleGetState(runtime, res) {
  sendJson(res, 200, await buildStatePayload(runtime))
}

async function handleGetSessions(runtime, url, res) {
  sendJson(res, 200, await buildSessionsPayload(runtime, url))
}

async function handleGetHistory(runtime, res) {
  const state = runtime.getState() ?? defaultState(runtime.now())
  sendJson(res, 200, { ok: true, history: Array.isArray(state.history) ? state.history : [] })
}

async function handlePostConfig(runtime, req, res) {
  const body = await readJsonBody(req)
  if (!isPlainObject(body)) throw new HttpError(400, '配置必须是 JSON 对象')
  const current = runtime.getConfig()
  const { config, warnings } = normalizeConfig(body, current)
  let saved
  try {
    saved = await saveConfig(runtime.dataDir, config)
  } catch (error) {
    throw new HttpError(500, `保存配置失败：${errorText(error)}`)
  }
  // saveConfig 内部会再校验一次已归一化的配置，因此初次归一化产生的 warnings 不能丢。
  const allWarnings = [...new Set([...warnings, ...saved.warnings])]
  runtime.setConfig(saved.config)
  runtime.configWarnings = allWarnings
  for (const warning of allWarnings) runtime.logger?.warn?.(warning)
  try {
    runtime.reschedule?.()
  } catch (error) {
    runtime.logger?.warn?.(`重排定时器失败：${errorText(error)}`)
  }
  sendJson(res, 200, { ok: true, config: cloneConfig(saved.config), warnings: allWarnings })
}

async function handlePostRun(runtime, req, res) {
  const body = await readJsonBody(req)
  if (!isPlainObject(body)) throw new HttpError(400, 'body 必须是 JSON 对象')
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    throw new HttpError(400, 'dryRun 必须是布尔值')
  }
  const outcome = await runOnce(runtime, { mode: 'manual', dryRun: body.dryRun })
  if (outcome.ok !== true) {
    if (outcome.busy === true) {
      sendJson(res, 409, { ok: false, error: 'busy' })
      return
    }
    sendJson(res, 500, { ok: false, error: outcome.error ?? '运行失败' })
    return
  }
  sendJson(res, 200, { ok: true, ...outcome.result, result: outcome.result })
}

async function handlePostRestore(runtime, req, res) {
  const body = await readJsonBody(req)
  if (!isPlainObject(body)) throw new HttpError(400, 'body 必须是 JSON 对象')
  if (!Array.isArray(body.sessionIds)) throw new HttpError(400, 'sessionIds 必须是数组')
  const sessionIds = [...new Set(body.sessionIds.filter((id) => typeof id === 'string' && id.trim() !== ''))]
  const registry = runtime.getServices()?.workspaceRegistry
  if (registry === undefined || registry === null || typeof registry.unarchiveSession !== 'function') {
    throw new HttpError(500, 'workspaceRegistry.unarchiveSession 不可用')
  }
  const restored = []
  const failed = []
  for (const sessionId of sessionIds) {
    try {
      await registry.unarchiveSession(sessionId)
      restored.push(sessionId)
    } catch (error) {
      failed.push({ id: sessionId, error: errorText(error) })
    }
  }
  sendJson(res, 200, { ok: true, restored, failed })
}

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '')
  return pathname
}

/**
 * 顶层请求处理（导出以便单测；通过 webServer 前缀路由挂载）。
 */
export async function handleRequest(runtime, req, res) {
  try {
    if (denyNonLoopback(req, res)) return
    let url
    try {
      url = new URL(String(req?.url ?? '/'), 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { ok: false, error: '非法请求 URL' })
      return
    }
    const pathname = normalizePath(url.pathname)
    const expectedMethod = ROUTES.get(pathname)
    if (expectedMethod === undefined) {
      sendJson(res, 404, { ok: false, error: `未知路径：${url.pathname}` })
      return
    }
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (method !== expectedMethod) {
      sendJson(res, 405, { ok: false, error: `方法 ${method} 不被支持` }, { Allow: expectedMethod })
      return
    }
    switch (pathname) {
      case `${API_PREFIX}/api/state`:
        await handleGetState(runtime, res)
        return
      case `${API_PREFIX}/api/sessions`:
        await handleGetSessions(runtime, url, res)
        return
      case `${API_PREFIX}/api/history`:
        await handleGetHistory(runtime, res)
        return
      case `${API_PREFIX}/api/config`:
        await handlePostConfig(runtime, req, res)
        return
      case `${API_PREFIX}/api/run`:
        await handlePostRun(runtime, req, res)
        return
      case `${API_PREFIX}/api/restore`:
        await handlePostRestore(runtime, req, res)
        return
      default:
        sendJson(res, 404, { ok: false, error: `未知路径：${url.pathname}` })
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    if (status >= 500) runtime.logger?.error?.(`HTTP 请求处理失败：${errorText(error)}`)
    if (res.headersSent === true) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
      return
    }
    sendJson(res, status, { ok: false, error: errorText(error) })
  }
}

/**
 * 注册到 webServer；返回 disposer（由 ctx.effect 管理）。
 */
export function registerApi(runtime, webServer) {
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    throw new Error('webServer.register 不可用')
  }
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => handleRequest(runtime, req, res),
  })
}

export { HttpError, BodyTooLargeError }
