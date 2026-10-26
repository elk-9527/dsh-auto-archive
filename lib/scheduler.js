/**
 * dsh-auto-archive —— 自动巡检调度（CONTRACT.md §6.4）。
 *
 * - apply 后先等 60 秒做首巡（不跟启动抢资源），之后每 checkIntervalMinutes 一次。
 * - 只有 autoArchive.enabled 或 cacheCleanup.enabled 至少一个为 true 时才调度。
 * - 配置变更 → reschedule（清掉旧定时器，按新间隔重排）。
 * - 每次触发都调 `runtime.runOnce({ mode: 'auto' })`；runOnce 自身单飞，
 *   上一轮没跑完时本轮直接被忽略（不排队、不并发）。
 * - 任何异常都只写日志，绝不从定时器逃出去。
 * - 定时器句柄尽量 unref，避免拖住宿主退出。
 */
import { describeError } from './config.js'

export const FIRST_CHECK_DELAY_MS = 60_000
export const DEFAULT_INTERVAL_MINUTES = 30
export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 1440

export function checkIntervalMs(config) {
  const raw = config?.autoArchive?.checkIntervalMinutes
  const minutes = Number.isFinite(raw)
    ? Math.min(Math.max(MIN_INTERVAL_MINUTES, Math.round(raw)), MAX_INTERVAL_MINUTES)
    : DEFAULT_INTERVAL_MINUTES
  return minutes * 60_000
}

/** 任一功能开关打开就需要巡检（关闭的功能由 run.js 内部跳过）。 */
export function schedulingEnabled(config) {
  const autoArchive = config?.autoArchive?.enabled !== false
  const cacheCleanup = config?.cacheCleanup?.enabled !== false
  return autoArchive || cacheCleanup
}

function unref(handle) {
  try {
    handle?.unref?.()
  } catch {
    /* 假定时器 / 平台差异都忽略 */
  }
}

/**
 * @param {object} runtime 需要 now()/getConfig()/runOnce()/logger/timers?
 * @returns {{
 *   start: (config?: object) => boolean,
 *   reschedule: (config?: object) => boolean,
 *   stop: () => void,
 *   getNextRunAt: () => number|null,
 *   isScheduled: () => boolean,
 *   triggerNow: () => Promise<void>,
 * }}
 */
export function createScheduler(runtime) {
  const timers = runtime?.timers ?? {}
  const setTimeoutFn = typeof timers.setTimeout === 'function' ? timers.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearTimeoutFn = typeof timers.clearTimeout === 'function' ? timers.clearTimeout : (handle) => clearTimeout(handle)
  const setIntervalFn = typeof timers.setInterval === 'function' ? timers.setInterval : (fn, ms) => setInterval(fn, ms)
  const clearIntervalFn = typeof timers.clearInterval === 'function' ? timers.clearInterval : (handle) => clearInterval(handle)

  const now = () => {
    try {
      const value = runtime?.now?.()
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  const readConfig = () => {
    try {
      const value = runtime?.getConfig?.()
      return value !== undefined && value !== null ? value : {}
    } catch {
      return {}
    }
  }

  let timeoutHandle = null
  let intervalHandle = null
  let nextRunAt = null
  let stopped = true

  function logWarning(message) {
    try {
      runtime?.logger?.warn?.(message)
    } catch {
      /* ignore */
    }
  }

  function clearTimers() {
    if (timeoutHandle !== null) {
      try {
        clearTimeoutFn(timeoutHandle)
      } catch {
        /* ignore */
      }
      timeoutHandle = null
    }
    if (intervalHandle !== null) {
      try {
        clearIntervalFn(intervalHandle)
      } catch {
        /* ignore */
      }
      intervalHandle = null
    }
  }

  /** 一次自动巡检；不等待、不抛出。force 供单测 triggerNow 使用。 */
  async function tick(force = false) {
    if (stopped && !force) return
    const intervalMs = checkIntervalMs(readConfig())
    nextRunAt = now() + intervalMs
    try {
      const outcome = await runtime.runOnce({ mode: 'auto' })
      if (outcome !== undefined && outcome !== null && outcome.ok === false) {
        if (outcome.busy === true) return
        logWarning(`自动巡检失败：${outcome.error ?? '未知错误'}`)
      }
    } catch (error) {
      logWarning(`自动巡检异常：${describeError(error)}`)
    }
  }

  function armInterval(intervalMs) {
    if (stopped) return
    if (intervalHandle !== null) {
      try {
        clearIntervalFn(intervalHandle)
      } catch {
        /* ignore */
      }
      intervalHandle = null
    }
    const handle = setIntervalFn(() => {
      void tick()
    }, intervalMs)
    unref(handle)
    intervalHandle = handle
    nextRunAt = now() + intervalMs
  }

  function stop() {
    stopped = true
    clearTimers()
    nextRunAt = null
  }

  function start(config = readConfig()) {
    stop()
    if (!schedulingEnabled(config)) {
      nextRunAt = null
      return false
    }
    stopped = false
    const intervalMs = checkIntervalMs(config)
    const delayMs = Math.min(FIRST_CHECK_DELAY_MS, intervalMs)
    nextRunAt = now() + delayMs
    const handle = setTimeoutFn(() => {
      timeoutHandle = null
      if (stopped) return
      armInterval(intervalMs)
      void tick()
    }, delayMs)
    unref(handle)
    timeoutHandle = handle
    return true
  }

  return {
    start,
    reschedule(config) {
      return start(config === undefined ? readConfig() : config)
    },
    stop,
    getNextRunAt() {
      return nextRunAt
    },
    isScheduled() {
      return timeoutHandle !== null || intervalHandle !== null
    },
    /** 单测/手动诊断用：立刻走一次自动巡检路径（不重排定时器）。 */
    async triggerNow() {
      await tick(true)
    },
  }
}
