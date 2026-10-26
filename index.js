/**
 * dsh-auto-archive —— 宿主侧入口（CONTRACT.md §2.1、§6.4）。
 *
 * 职责：
 * - 读取/初始化 `<DSH_HOME>/auto-archive/`（config.json、state.json）。
 * - 注册 `/dsh-auto-archive` HTTP API（webServer 前缀路由，回环限定）。
 * - 启动自动巡检调度（首巡 60s，之后 checkIntervalMinutes；配置变更重排）。
 * - 所有外部依赖失败都降级为日志 + warning，绝不让异常逃出 apply 或定时器。
 *
 * 数据目录解析顺序：
 *   `DSH_AUTO_ARCHIVE_DIR`（测试/隔离）→ 否则 `<DSH_HOME>/auto-archive`；
 *   `DSH_HOME` 解析顺序：`DSH_AUTO_ARCHIVE_DSH_HOME`（测试/隔离）→ `DSH_HOME` → `~/.dsh`。
 * apply 的第二个参数也接受 `{ dataDir, dshHome, now, timers }` 作为测试/e2e 覆盖（普通安装不需要）。
 */
import path from 'node:path'

import {
  cloneConfig,
  defaultConfig,
  describeError,
  isPlainObject,
  loadConfig,
  resolveDataDir,
  resolveDshHome,
} from './lib/config.js'
import { defaultState, loadState, saveState as saveStateFile } from './lib/state.js'
import { registerApi } from './lib/api.js'
import { createScheduler } from './lib/scheduler.js'
import { runOnce as runArchiveOnce } from './lib/run.js'

export const name = 'dsh-auto-archive'
export const inject = [
  'webServer',
  'sessionPersistence',
  'sessions',
  'workspaceRegistry',
  'sessionProjectionCache',
]
export const PLUGIN_VERSION = '0.1.0'

const LOG_PREFIX = '[dsh-auto-archive]'

/** 服务获取容错：直接属性优先，其次 `ctx.get(name)`；都没有返回 undefined。 */
export function readService(ctx, serviceName) {
  if (ctx !== undefined && ctx !== null) {
    try {
      const direct = ctx[serviceName]
      if (direct !== undefined && direct !== null) return direct
    } catch {
      /* getter 抛错也继续尝试 ctx.get */
    }
    try {
      if (typeof ctx.get === 'function') {
        const viaGet = ctx.get(serviceName)
        if (viaGet !== undefined && viaGet !== null) return viaGet
      }
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/** 日志优先 `ctx.logger`（单字符串模板），否则 console（带前缀）。 */
export function createLogger(ctx) {
  let base
  try {
    base = ctx?.logger
  } catch {
    base = undefined
  }
  const emit = (level, message) => {
    const text = String(message)
    if (base !== undefined && base !== null) {
      const fn = base[level] ?? base.info ?? base.warn
      if (typeof fn === 'function') {
        try {
          fn.call(base, `${LOG_PREFIX} ${text}`)
          return
        } catch {
          /* 降级到 console */
        }
      }
    }
    const consoleFn = level === 'error' ? console.error : level === 'info' ? console.info : console.warn
    consoleFn(`${LOG_PREFIX} ${text}`)
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  }
}

function resolveRuntimePaths(env, options) {
  const resolved = {}
  try {
    resolved.dshHome =
      typeof options?.dshHome === 'string' && options.dshHome.trim() !== ''
        ? path.resolve(options.dshHome.trim())
        : resolveDshHome(env)
  } catch (error) {
    resolved.dshHome = undefined
  }
  try {
    resolved.dataDir =
      typeof options?.dataDir === 'string' && options.dataDir.trim() !== ''
        ? path.resolve(options.dataDir.trim())
        : resolveDataDir(env)
  } catch (error) {
    resolved.dataDir = undefined
  }
  return resolved
}

/**
 * 构造运行态（不注册任何东西，便于单测直接调用 runOnce / API 处理函数）。
 *
 * @param {object} ctx 宿主 ctx（只读服务用）。
 * @param {object} [options] `{ env, dataDir, dshHome, now, timers, logger }`
 */
export function createRuntime(ctx, options = {}) {
  const env = options.env ?? process.env
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const logger = options.logger ?? createLogger(ctx)
  const paths = resolveRuntimePaths(env, options)

  let config = defaultConfig()
  let state = defaultState(now())
  let configWarnings = []
  let initialized = false
  let scheduler = null

  const runtime = {
    ctx,
    env,
    now,
    logger,
    timers: options.timers,
    dshHome: paths.dshHome,
    dataDir: paths.dataDir,
    pluginVersion: PLUGIN_VERSION,
    activeRun: null,
    disposers: [],

    get initialized() {
      return initialized
    },
    get scheduler() {
      return scheduler
    },
    set scheduler(value) {
      scheduler = value
    },
    get configWarnings() {
      return configWarnings
    },
    set configWarnings(value) {
      configWarnings = Array.isArray(value) ? [...value] : []
    },

    getConfig() {
      return config
    },
    setConfig(next) {
      config = cloneConfig(next)
      return config
    },
    getState() {
      return state
    },
    setState(next) {
      state = isPlainObject(next) ? next : defaultState(now())
      return state
    },
    async saveState(next) {
      const value = isPlainObject(next) ? next : defaultState(now())
      await saveStateFile(paths.dataDir, value)
      state = value
      return state
    },
    getService(serviceName) {
      return readService(ctx, serviceName)
    },
    getServices() {
      return {
        webServer: readService(ctx, 'webServer'),
        sessionPersistence: readService(ctx, 'sessionPersistence'),
        sessions: readService(ctx, 'sessions'),
        workspaceRegistry: readService(ctx, 'workspaceRegistry'),
        sessionProjectionCache: readService(ctx, 'sessionProjectionCache'),
      }
    },
    getNextRunAt() {
      return scheduler === null ? null : scheduler.getNextRunAt()
    },
    reschedule() {
      if (scheduler === null) return false
      return scheduler.reschedule(config)
    },
    runOnce(runOptions) {
      return runArchiveOnce(runtime, runOptions)
    },
    async initialize() {
      if (initialized) return runtime
      initialized = true
      try {
        const loaded = await loadConfig(paths.dataDir)
        config = loaded.config
        configWarnings = [...loaded.warnings]
        for (const warning of configWarnings) logger.warn(warning)
      } catch (error) {
        config = defaultConfig()
        configWarnings = []
        logger.warn(`读取配置失败：${describeError(error)}（本次使用默认配置）`)
      }
      try {
        const loaded = await loadState(paths.dataDir, { now: now() })
        state = loaded.state
        for (const warning of loaded.warnings) logger.warn(warning)
      } catch (error) {
        state = defaultState(now())
        logger.warn(`读取运行状态失败：${describeError(error)}（本次使用默认状态）`)
      }
      return runtime
    },
    async dispose() {
      if (scheduler !== null) {
        try {
          scheduler.stop()
        } catch {
          /* ignore */
        }
      }
      const pending = runtime.disposers.splice(0, runtime.disposers.length)
      for (const disposer of pending) {
        try {
          await disposer()
        } catch (error) {
          logger.warn(`清理 ${LOG_PREFIX} 资源失败：${describeError(error)}`)
        }
      }
    },
  }

  return runtime
}

function registerEffect(runtime, ctx, setup, label) {
  const wrapped = () => {
    try {
      return setup()
    } catch (error) {
      runtime.logger.warn(`注册 ${label} 失败：${describeError(error)}`)
      return undefined
    }
  }
  if (typeof ctx?.effect === 'function') {
    try {
      const disposer = ctx.effect(wrapped, label)
      if (typeof disposer === 'function') runtime.disposers.push(disposer)
      return
    } catch (error) {
      runtime.logger.warn(`注册 ${label} 的 effect 失败：${describeError(error)}`)
    }
  }
  // 没有 ctx.effect（单测/异构宿主）时直接执行，并把返回的 disposer 登记下来。
  const disposer = wrapped()
  if (typeof disposer === 'function') runtime.disposers.push(disposer)
}

/**
 * 插件入口。绝不让异常逃出去（宿主会在 apply 抛错时把插件标成失败）。
 */
export async function apply(ctx, config) {
  const overrides = {}
  if (isPlainObject(config)) {
    if (typeof config.dataDir === 'string' && config.dataDir.trim() !== '') overrides.dataDir = config.dataDir
    if (typeof config.dshHome === 'string' && config.dshHome.trim() !== '') overrides.dshHome = config.dshHome
    if (typeof config.now === 'function') overrides.now = config.now
    if (isPlainObject(config.timers) || (typeof config.timers === 'object' && config.timers !== null)) {
      overrides.timers = config.timers
    }
  }

  const runtime = createRuntime(ctx, { env: process.env, ...overrides })
  try {
    await runtime.initialize()
  } catch (error) {
    runtime.logger.error(`初始化失败：${describeError(error)}`)
  }

  try {
    runtime.scheduler = createScheduler(runtime)
  } catch (error) {
    runtime.logger.warn(`创建调度器失败：${describeError(error)}`)
  }

  registerEffect(runtime, ctx, () => {
    const webServer = runtime.getService('webServer')
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      runtime.logger.warn('webServer 不可用：跳过 /dsh-auto-archive HTTP API 注册')
      return undefined
    }
    const disposer = registerApi(runtime, webServer)
    return typeof disposer === 'function' ? disposer : undefined
  }, 'dsh-auto-archive/api')

  registerEffect(runtime, ctx, () => {
    if (runtime.scheduler === null) return undefined
    runtime.scheduler.start(runtime.getConfig())
    return () => {
      runtime.scheduler?.stop()
    }
  }, 'dsh-auto-archive/scheduler')

  // 注意：cordis 会把插件函数的返回值当成 effect（disposer / thenable / 可迭代物）收集，
  // 返回普通对象会触发 `TypeError: Invalid effect` 并导致整个插件条目不激活。
  // 因此这里必须返回 undefined（资源清理已由 ctx.effect 的 disposer 负责）。
  return undefined
}
