/**
 * dsh-auto-archive —— 运行态 state.json 层（CONTRACT.md §3、§6.4）。
 *
 * 结构：
 *   { version: 1, lastRunAt, lastResult, history: RunResult[], createdAt }
 *
 * 规则：
 * - history 最多 30 条、新的在前。
 * - dry-run 不写 state（也不改 lastRunAt/lastResult），由 run.js 保证。
 * - 坏 state 文件只回退默认值，不抛错、不覆盖（下一次真实 run 会原子重写）。
 */
import {
  STATE_FILENAME,
  describeError,
  isPlainObject,
  readJsonFile,
  statePath,
  writeJsonAtomic,
} from './config.js'

export const STATE_VERSION = 1
export const MAX_HISTORY = 30

export function defaultState(now = Date.now()) {
  return {
    version: STATE_VERSION,
    lastRunAt: null,
    lastResult: null,
    history: [],
    createdAt: now,
  }
}

/**
 * 容错归一化 state：只保留已知字段，history 截断。
 * @returns {{state: object, warnings: string[]}}
 */
export function normalizeState(raw, { now = Date.now() } = {}) {
  const warnings = []
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null) warnings.push(`state.json 结构非法（${typeof raw}），已使用默认状态`)
    return { state: defaultState(now), warnings }
  }
  const state = defaultState(now)
  if (raw.version !== undefined && raw.version !== STATE_VERSION) {
    warnings.push(`state.version 非法（${String(raw.version)}），已按 version ${STATE_VERSION} 处理`)
  }
  if (Number.isFinite(raw.createdAt)) state.createdAt = raw.createdAt
  if (Number.isFinite(raw.lastRunAt)) state.lastRunAt = raw.lastRunAt
  if (isPlainObject(raw.lastResult)) state.lastResult = raw.lastResult
  if (Array.isArray(raw.history)) {
    state.history = raw.history.filter((item) => isPlainObject(item)).slice(0, MAX_HISTORY)
  }
  return { state, warnings }
}

/**
 * 读取 state；缺失返回默认状态（不写盘，dry-run/只读路径安全）。
 * @returns {Promise<{state: object, warnings: string[], path: string}>}
 */
export async function loadState(dataDir, { now = Date.now() } = {}) {
  const file = statePath(dataDir)
  const warnings = []
  const read = await readJsonFile(file)
  if (!read.exists) {
    if (read.readError !== undefined) {
      warnings.push(`读取 state.json 失败：${describeError(read.readError)}（本次使用默认状态）`)
    }
    return { state: defaultState(now), warnings, path: file }
  }
  if (read.parseError !== undefined) {
    warnings.push(`state.json 不是合法 JSON：${describeError(read.parseError)}（本次使用默认状态）`)
    return { state: defaultState(now), warnings, path: file }
  }
  const { state, warnings: stateWarnings } = normalizeState(read.value, { now })
  warnings.push(...stateWarnings)
  return { state, warnings, path: file }
}

/** 原子写 state。 */
export async function saveState(dataDir, state) {
  await writeJsonAtomic(statePath(dataDir), state)
  return state
}

/**
 * 把一次真实 run 记进 state（pure，返回新对象）。
 * lastRunAt 取 resolved 的 finishedAt ?? at。
 */
export function recordRun(state, result, { maxHistory = MAX_HISTORY } = {}) {
  const base = isPlainObject(state) ? state : defaultState()
  const finishedAt = Number.isFinite(result?.finishedAt) ? result.finishedAt : result?.at
  const lastRunAt = Number.isFinite(finishedAt) ? finishedAt : Date.now()
  const history = [result, ...(Array.isArray(base.history) ? base.history : [])]
    .filter((item) => isPlainObject(item))
    .slice(0, Math.max(1, maxHistory))
  return {
    version: STATE_VERSION,
    lastRunAt,
    lastResult: result,
    history,
    createdAt: Number.isFinite(base.createdAt) ? base.createdAt : Date.now(),
  }
}

export { STATE_FILENAME }
