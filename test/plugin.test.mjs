import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { API_PREFIX } from '../lib/api.js'
import { defaultConfig } from '../lib/config.js'
import { apply, createLogger, createRuntime, inject, name, readService } from '../index.js'
import {
  NOW,
  makeCtx,
  makeFakeTimers,
  makeLiveSessions,
  makePersistence,
  makeProjectionCache,
  makeReq,
  makeRes,
  makeSnapshot,
  makeTempDirs,
  makeWorkspaceRegistry,
  makeWebServer,
  waitFor,
} from './helpers.mjs'

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function fullServices(overrides = {}) {
  return {
    webServer: makeWebServer(),
    sessionPersistence: makePersistence([]),
    sessions: makeLiveSessions([]),
    workspaceRegistry: makeWorkspaceRegistry(),
    sessionProjectionCache: makeProjectionCache(),
    ...overrides,
  }
}

/**
 * Lead 在真实 DSH 0.2.1-rc.3 上实证的两条宿主语义（勿改）：
 * 1. cordis 会把插件 `apply()` 的返回值当成 effect 收集；返回普通对象会抛
 *    `TypeError: Invalid effect` 并导致整个插件条目不激活 ⇒ apply 必须 return undefined，
 *    资源清理由 ctx.effect 的 disposer 负责（本文件最后一个用例锁死该语义）。
 * 2. `file:` 依赖会被 pnpm **复制**进 profile 的 node_modules（不是软链）；改源码后必须重跑
 *    `dsh plugin --profile <p> add file:<path>`（或 install）才会生效；`dsh plugin add`
 *    会自动把包名写进 `dsh.profile.bundles`，`remove` 会自动移除——e2e/安装验证时按此操作。
 */
test('插件导出契约：name / inject', () => {
  assert.equal(name, 'dsh-auto-archive')
  assert.deepEqual(inject, [
    'webServer',
    'sessionPersistence',
    'sessions',
    'workspaceRegistry',
    'sessionProjectionCache',
  ])
})

test('readService 兼容直接属性与 ctx.get；缺失返回 undefined', () => {
  assert.equal(readService({ foo: 1 }, 'foo'), 1)
  assert.equal(readService({ get: (key) => (key === 'bar' ? 2 : undefined) }, 'bar'), 2)
  assert.equal(readService({}, 'nope'), undefined)
  assert.equal(readService(undefined, 'nope'), undefined)
  const fallback = {
    get foo() {
      throw new Error('getter boom')
    },
    get: () => 3,
  }
  // 直接属性读取抛错时退回 ctx.get
  assert.equal(readService(fallback, 'foo'), 3)
  const onlyThrowing = {
    get foo() {
      throw new Error('getter boom')
    },
  }
  assert.equal(readService(onlyThrowing, 'foo'), undefined)
})

test('createLogger 优先 ctx.logger（带前缀），否则 console', () => {
  const calls = []
  const logger = createLogger({
    logger: {
      warn: (message) => calls.push(['warn', message]),
      error: (message) => calls.push(['error', message]),
    },
  })
  logger.warn('hello')
  logger.error('oops')
  assert.deepEqual(calls, [
    ['warn', '[dsh-auto-archive] hello'],
    ['error', '[dsh-auto-archive] oops'],
  ])
  logger.info('info falls back')
})

test('apply：初始化数据目录/config.json、注册 API、启动调度，dispose 全清理', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const timers = makeFakeTimers()
  const webServer = makeWebServer()
  const ctx = makeCtx(fullServices({ webServer }))
  // apply 必须返回 undefined：cordis 会把非 effect 返回值当成非法 effect。
  assert.equal(await apply(ctx, { dataDir, dshHome, timers, now: () => NOW }), undefined)

  assert.equal(await exists(path.join(dataDir, 'config.json')), true)
  assert.equal(await exists(path.join(dataDir, 'state.json')), false)
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8')), defaultConfig())

  // HTTP 已注册（prefix /dsh-auto-archive）
  assert.equal(webServer.registrations.length, 1)
  assert.equal(webServer.registrations[0].kind, 'prefix')
  assert.equal(webServer.registrations[0].path, API_PREFIX)

  // 两个 effect 都注册并从 ctx.effect 执行
  assert.deepEqual(
    ctx.effects.map((entry) => entry.label),
    ['dsh-auto-archive/api', 'dsh-auto-archive/scheduler'],
  )

  // 默认配置启用 → 60s 后首巡
  assert.equal(timers.liveTimeouts().length, 1)
  assert.equal(timers.liveTimeouts()[0].delay, 60_000)

  // 注册的 API 真能响应
  const req = makeReq({ url: `${API_PREFIX}/api/state` })
  const res = makeRes()
  await webServer.registrations[0].handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)

  // 模拟宿主卸载：执行 effect disposer
  for (const entry of ctx.effects) entry.disposer?.()
  assert.equal(timers.liveTimeouts().length, 0)
  assert.equal(timers.liveIntervals().length, 0)
  assert.equal(webServer.registrations.length, 0)
})

test('apply：首巡后可自动巡检（mode=auto）并写 state.json', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const timers = makeFakeTimers()
  const registry = makeWorkspaceRegistry()
  const persistence = makePersistence([
    makeSnapshot({ type: 'session', version: 4, id: 's1', createdAt: NOW - 30 * 24 * 60 * 60 * 1000, cwd: 'C:\\x', isSeeded: false }),
  ])
  const ctx = makeCtx(fullServices({ workspaceRegistry: registry, sessionPersistence: persistence }))
  await apply(ctx, { dataDir, dshHome, timers, now: () => NOW })

  timers.advance(60_000)
  await waitFor(() => registry.calls.archive.length === 1)
  await waitFor(async () => exists(path.join(dataDir, 'state.json')))
  assert.deepEqual(registry.calls.archive, ['s1'])
  const state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'))
  assert.equal(state.history.length, 1)
  assert.equal(state.lastResult.mode, 'auto')
  assert.equal(state.lastResult.archived[0].id, 's1')
  assert.ok(Number.isFinite(state.lastRunAt))
})

test('apply：配置文件预先关闭两个开关 → 不调度', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  await mkdir(dataDir, { recursive: true })
  await writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ autoArchive: { enabled: false }, cacheCleanup: { enabled: false } }),
    'utf8',
  )
  const timers = makeFakeTimers()
  const ctx = makeCtx(fullServices())
  await apply(ctx, { dataDir, dshHome, timers, now: () => NOW })
  assert.equal(timers.liveTimeouts().length, 0)
  assert.equal(timers.liveIntervals().length, 0)
})

test('apply：坏 config.json 自动修复为默认配置并继续', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'config.json'), '{broken', 'utf8')
  const ctx = makeCtx(fullServices())
  await apply(ctx, { dataDir, dshHome, timers: makeFakeTimers(), now: () => NOW })
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8')), defaultConfig())
  assert.ok(ctx.logs.some((entry) => entry.message.includes('JSON')))
})

test('apply：服务缺失也不抛错（只 warning），HTTP 注册跳过', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const ctx = makeCtx({})
  const timers = makeFakeTimers()
  await apply(ctx, { dataDir, dshHome, timers, now: () => NOW })
  assert.ok(ctx.logs.some((entry) => entry.message.includes('webServer 不可用')))
  assert.equal(await exists(path.join(dataDir, 'config.json')), true)
  // 调度仍按默认配置启动（枚举失败会进 run.errors，不影响调度）
  assert.equal(timers.liveTimeouts().length, 1)
})

test('apply：ctx 没有 effect 时退化为直接注册并登记 disposer', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const webServer = makeWebServer()
  const services = fullServices({ webServer })
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    get: (serviceName) => services[serviceName],
  }
  await apply(ctx, { dataDir, dshHome, timers: makeFakeTimers(), now: () => NOW })
  assert.equal(webServer.registrations.length, 1)
})

test('apply：走环境变量解析数据目录（DSH_AUTO_ARCHIVE_DIR / DSH_AUTO_ARCHIVE_DSH_HOME）', async (t) => {
  const { root } = await makeTempDirs(t)
  const dataDir = path.join(root, 'env-data')
  const dshHome = path.join(root, 'env-home')
  const previousData = process.env.DSH_AUTO_ARCHIVE_DIR
  const previousHome = process.env.DSH_AUTO_ARCHIVE_DSH_HOME
  process.env.DSH_AUTO_ARCHIVE_DIR = dataDir
  process.env.DSH_AUTO_ARCHIVE_DSH_HOME = dshHome
  try {
    const ctx = makeCtx(fullServices())
    await apply(ctx, { timers: makeFakeTimers() })
    assert.equal(await exists(path.join(dataDir, 'config.json')), true)
  } finally {
    if (previousData === undefined) delete process.env.DSH_AUTO_ARCHIVE_DIR
    else process.env.DSH_AUTO_ARCHIVE_DIR = previousData
    if (previousHome === undefined) delete process.env.DSH_AUTO_ARCHIVE_DSH_HOME
    else process.env.DSH_AUTO_ARCHIVE_DSH_HOME = previousHome
  }
})

test('cordis effect 语义：effect setup 返回普通对象会 Invalid effect，apply 必须全合法', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const services = fullServices()
  const effects = []
  const strictCtx = {
    logger: { warn() {}, error() {}, info() {} },
    get: (serviceName) => services[serviceName],
    // 严格模拟 cordis/lib/index.js safeCollect：普通对象/原始值不是合法 effect。
    effect(setup, label) {
      const value = setup()
      const valid = value === undefined || value === null || typeof value === 'function' ||
        (typeof value === 'object' && typeof value.then === 'function')
      assert.equal(valid, true, `${label} 返回了非法 effect: ${Object.prototype.toString.call(value)}`)
      effects.push({ label, value })
      return () => {}
    },
  }
  assert.equal(await apply(strictCtx, { dataDir, dshHome, timers: makeFakeTimers(), now: () => NOW }), undefined)
  assert.deepEqual(effects.map((entry) => entry.label), [
    'dsh-auto-archive/api',
    'dsh-auto-archive/scheduler',
  ])
  // 两个 effect 的返回值只能是 disposer 函数（scheduler 也可能返回 stop 函数）
  for (const entry of effects) {
    assert.ok(entry.value === undefined || typeof entry.value === 'function')
  }
})

test('createRuntime：setConfig/setState/runOnce/reschedule 基本语义', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const ctx = makeCtx(fullServices())
  const runtime = createRuntime(ctx, { env: {}, dataDir, dshHome, now: () => NOW })
  await runtime.initialize()
  assert.deepEqual(runtime.getConfig(), defaultConfig())
  runtime.setConfig({ ...defaultConfig(), dryRun: true })
  assert.equal(runtime.getConfig().dryRun, true)
  assert.equal(runtime.getState().lastRunAt, null)

  const outcome = await runtime.runOnce({})
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result.mode, 'dry-run')

  runtime.setState({ version: 1, lastRunAt: 5, lastResult: null, history: [], createdAt: 1 })
  assert.equal(runtime.getState().lastRunAt, 5)
  await runtime.dispose()
})
