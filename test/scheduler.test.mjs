import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FIRST_CHECK_DELAY_MS,
  checkIntervalMs,
  createScheduler,
  schedulingEnabled,
} from '../lib/scheduler.js'
import { normalizeConfig } from '../lib/config.js'
import { NOW, flush, makeFakeTimers } from './helpers.mjs'

function makeSchedulerRuntime({ config = normalizeConfig({}).config, timers = makeFakeTimers() } = {}) {
  const calls = []
  const warnings = []
  let configRef = config
  let runImpl = async () => ({ ok: true, busy: false, result: {} })
  const runtime = {
    timers,
    now: () => timers.clock.value,
    getConfig: () => configRef,
    logger: {
      warn: (message) => warnings.push(message),
      error: () => {},
      info: () => {},
    },
    async runOnce(options) {
      calls.push(options)
      return runImpl(options)
    },
  }
  return {
    runtime,
    calls,
    warnings,
    timers,
    setConfig(next) {
      configRef = next
    },
    setRunImpl(fn) {
      runImpl = fn
    },
  }
}

test('checkIntervalMs / schedulingEnabled 边界', () => {
  assert.equal(checkIntervalMs({ autoArchive: { checkIntervalMinutes: 30 } }), 30 * 60_000)
  assert.equal(checkIntervalMs({ autoArchive: { checkIntervalMinutes: 1 } }), 60_000)
  assert.equal(checkIntervalMs({ autoArchive: { checkIntervalMinutes: 1440 } }), 1440 * 60_000)
  // 非法值回退默认 30 分钟
  assert.equal(checkIntervalMs({}), 30 * 60_000)
  assert.equal(checkIntervalMs({ autoArchive: { checkIntervalMinutes: -1 } }), 60_000)
  assert.equal(checkIntervalMs({ autoArchive: { checkIntervalMinutes: 9999 } }), 1440 * 60_000)

  assert.equal(schedulingEnabled(normalizeConfig({}).config), true)
  assert.equal(schedulingEnabled(normalizeConfig({ autoArchive: { enabled: false } }).config), true)
  assert.equal(schedulingEnabled(normalizeConfig({ cacheCleanup: { enabled: false } }).config), true)
  assert.equal(
    schedulingEnabled(normalizeConfig({ autoArchive: { enabled: false }, cacheCleanup: { enabled: false } }).config),
    false,
  )
})

test('两个开关都关：不调度，nextRunAt 为 null', () => {
  const config = normalizeConfig({ autoArchive: { enabled: false }, cacheCleanup: { enabled: false } }).config
  const { runtime, timers } = makeSchedulerRuntime({ config })
  const scheduler = createScheduler(runtime)
  assert.equal(scheduler.start(config), false)
  assert.equal(scheduler.isScheduled(), false)
  assert.equal(scheduler.getNextRunAt(), null)
  assert.equal(timers.liveTimeouts().length, 0)
  assert.equal(timers.liveIntervals().length, 0)
})

test('首巡 60s，之后按 checkIntervalMinutes 定时；tick 调 runOnce({mode:"auto"})', async () => {
  const { runtime, timers, calls } = makeSchedulerRuntime()
  const scheduler = createScheduler(runtime)
  assert.equal(scheduler.start(), true)
  assert.equal(scheduler.isScheduled(), true)
  assert.equal(scheduler.getNextRunAt(), NOW + FIRST_CHECK_DELAY_MS)

  const [first] = timers.liveTimeouts()
  assert.equal(first.delay, FIRST_CHECK_DELAY_MS)
  assert.equal(first.unrefCalled, true)

  timers.advance(FIRST_CHECK_DELAY_MS)
  await flush()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { mode: 'auto' })
  assert.equal(timers.liveIntervals().length, 1)
  assert.equal(timers.liveIntervals()[0].delay, 30 * 60_000)
  assert.equal(scheduler.getNextRunAt(), NOW + FIRST_CHECK_DELAY_MS + 30 * 60_000)

  timers.fireIntervals()
  await flush()
  assert.equal(calls.length, 2)
})

test('配置变更 reschedule：清旧定时器、按新间隔重排', async () => {
  const { runtime, timers, calls, setConfig } = makeSchedulerRuntime()
  const scheduler = createScheduler(runtime)
  scheduler.start()
  const oldTimeout = timers.liveTimeouts()[0]

  const config = normalizeConfig({ autoArchive: { checkIntervalMinutes: 5 } }).config
  setConfig(config)
  assert.equal(scheduler.reschedule(), true)

  assert.equal(oldTimeout.cleared, true)
  assert.equal(timers.liveTimeouts().length, 1)
  assert.equal(timers.liveTimeouts()[0].delay, FIRST_CHECK_DELAY_MS)

  timers.advance(FIRST_CHECK_DELAY_MS)
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(timers.liveIntervals()[0].delay, 5 * 60_000)

  // 再次 reschedule 关闭功能 → 定时器全部清掉
  const disabled = normalizeConfig({ autoArchive: { enabled: false }, cacheCleanup: { enabled: false } }).config
  setConfig(disabled)
  assert.equal(scheduler.reschedule(), false)
  assert.equal(scheduler.isScheduled(), false)
  assert.equal(timers.liveTimeouts().length, 0)
  assert.equal(timers.liveIntervals().length, 0)
  assert.equal(scheduler.getNextRunAt(), null)
})

test('stop 清理全部定时器（ctx.effect disposer 语义）', () => {
  const { runtime, timers } = makeSchedulerRuntime()
  const scheduler = createScheduler(runtime)
  scheduler.start()
  timers.advance(FIRST_CHECK_DELAY_MS)
  assert.equal(timers.liveIntervals().length, 1)
  scheduler.stop()
  assert.equal(scheduler.isScheduled(), false)
  assert.equal(scheduler.getNextRunAt(), null)
  assert.equal(timers.liveIntervals().length, 0)
})

test('tick 异常/失败只写日志，绝不逃逸；busy 静默跳过', async () => {
  const { runtime, timers, warnings, setRunImpl, calls } = makeSchedulerRuntime()
  setRunImpl(async () => ({ ok: false, busy: true }))
  const scheduler = createScheduler(runtime)
  scheduler.start()
  timers.advance(FIRST_CHECK_DELAY_MS)
  await flush()
  assert.equal(calls.length, 1)
  assert.deepEqual(warnings, [])

  setRunImpl(async () => ({ ok: false, busy: false, error: 'disk full' }))
  timers.fireIntervals()
  await flush()
  assert.ok(warnings.some((warning) => warning.includes('disk full')))

  setRunImpl(async () => {
    throw new Error('boom')
  })
  timers.fireIntervals()
  await flush()
  assert.ok(warnings.some((warning) => warning.includes('boom')))
})

test('triggerNow 走同一 tick 路径（单测/诊断用）', async () => {
  const { runtime, calls } = makeSchedulerRuntime()
  const scheduler = createScheduler(runtime)
  await scheduler.triggerNow()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { mode: 'auto' })
})
