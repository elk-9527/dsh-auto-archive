import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createRuntime } from '../index.js'
import { defaultConfig, normalizeConfig } from '../lib/config.js'
import { purgeProjectionCache, runOnce } from '../lib/run.js'
import {
  DAY_MS,
  FakeActiveSessionError,
  NOW,
  makeCtx,
  makeHeader,
  makeLiveSessions,
  makePersistence,
  makeProjectionCache,
  makeSnapshot,
  makeTempDirs,
  makeWorkspaceRegistry,
} from './helpers.mjs'

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function makeRuntime(t, options = {}) {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const registry = makeWorkspaceRegistry({
    workspaces: options.workspaces,
    archived: options.archived,
    pinned: options.pinned,
    onArchive: options.onArchive,
  })
  const cache = makeProjectionCache({ snapshots: options.snapshots, deleteImpl: options.deleteImpl })
  const persistence = makePersistence(options.rows ?? [])
  const ctx = makeCtx({
    sessionPersistence: persistence,
    sessions: makeLiveSessions(options.liveSessions ?? []),
    workspaceRegistry: registry,
    sessionProjectionCache: cache,
  })
  const runtime = createRuntime(ctx, { env: {}, dataDir, dshHome, now: () => NOW })
  await runtime.initialize()
  if (options.configPatch !== undefined) {
    runtime.setConfig(normalizeConfig(options.configPatch, runtime.getConfig()).config)
  }
  return { runtime, registry, cache, persistence, dataDir, dshHome }
}

function oldSnapshot(id, days, extra = {}) {
  return makeSnapshot(makeHeader(id, { createdAt: NOW - days * DAY_MS, ...extra }))
}

test('dry-run：只列候选，零副作用、不写 state/history（§6.5）', async (t) => {
  const { runtime, registry, cache, dataDir } = await makeRuntime(t, {
    rows: [oldSnapshot('old-live', 50), oldSnapshot('old-archived', 120)],
    archived: ['old-archived'],
    snapshots: { 'old-live': { title: '待归档' }, 'old-archived': { title: '待清理' } },
  })
  const beforeState = runtime.getState()
  const outcome = await runOnce(runtime, { dryRun: true })
  assert.equal(outcome.ok, true)
  const result = outcome.result
  assert.equal(result.mode, 'dry-run')
  assert.deepEqual(result.archived.map((operation) => operation.id), ['old-live'])
  assert.deepEqual(result.cachePurged.map((operation) => operation.id), ['old-archived'])
  assert.equal(result.archived[0].title, '待归档')
  assert.equal(result.archived[0].lastActivityDays, 50)
  assert.equal(result.countsBefore.stored, 2)
  assert.equal(result.countsBefore.archived, 1)

  // 零副作用
  assert.deepEqual(registry.calls.archive, [])
  assert.deepEqual(cache.deleted, [])
  assert.equal(await exists(path.join(dataDir, 'state.json')), false)
  assert.equal(runtime.getState(), beforeState)
  assert.equal(runtime.getState().lastRunAt, null)
  assert.equal(runtime.getState().history.length, 0)
})

test('配置 dryRun:true 时手动 run 默认也是 dry-run', async (t) => {
  const { runtime, registry, cache } = await makeRuntime(t, {
    rows: [oldSnapshot('old-live', 50)],
    configPatch: { dryRun: true },
  })
  const outcome = await runOnce(runtime)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result.mode, 'dry-run')
  assert.deepEqual(outcome.result.archived.map((operation) => operation.id), ['old-live'])
  assert.deepEqual(registry.calls.archive, [])
  assert.deepEqual(cache.deleted, [])
})

test('真实 run：归档过期未归档会话，写入 state.json', async (t) => {
  const { runtime, registry, cache, dataDir } = await makeRuntime(t, {
    rows: [oldSnapshot('s1', 50), oldSnapshot('s2', 120)],
    archived: ['s2'],
    snapshots: { s1: { title: 'Alpha' }, s2: { title: 'Beta' } },
  })
  const outcome = await runOnce(runtime, { mode: 'auto' })
  assert.equal(outcome.ok, true)
  const result = outcome.result
  assert.equal(result.mode, 'auto')
  assert.deepEqual(registry.calls.archive, ['s1'])
  assert.deepEqual(cache.deleted, ['s2'])
  assert.deepEqual(result.archived, [{ id: 's1', title: 'Alpha', lastActivityDays: 50 }])
  assert.deepEqual(result.cachePurged, [{ id: 's2', title: 'Beta', lastActivityDays: 120 }])
  assert.deepEqual(result.errors, [])

  const state = runtime.getState()
  assert.equal(state.lastRunAt, result.finishedAt)
  assert.equal(state.history.length, 1)
  assert.equal(state.history[0].runId, result.runId)
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.lastResult.runId, result.runId)
  assert.equal(onDisk.history.length, 1)
})

test('归档遇 WorkspaceActiveSessionError → skipped reason=active，不打断用户会话', async (t) => {
  const { runtime, registry, cache } = await makeRuntime(t, {
    rows: [oldSnapshot('busy', 50)],
    onArchive(sessionId) {
      throw new FakeActiveSessionError(sessionId)
    },
  })
  const outcome = await runOnce(runtime)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result.skipped, [{ id: 'busy', reason: 'active' }])
  assert.deepEqual(outcome.result.errors, [])
  assert.deepEqual(outcome.result.archived, [])
  assert.deepEqual(registry.calls.archive, ['busy'])
  assert.deepEqual(cache.deleted, [])
})

test('归档抛普通错误 → skipped reason=error + errors，不逃逸', async (t) => {
  const { runtime } = await makeRuntime(t, {
    rows: [oldSnapshot('broken', 50)],
    onArchive() {
      throw new Error('registry exploded')
    },
  })
  const outcome = await runOnce(runtime)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result.skipped, [{ id: 'broken', reason: 'error' }])
  assert.equal(outcome.result.errors.length, 1)
  assert.match(outcome.result.errors[0].error, /registry exploded/)
  assert.deepEqual(outcome.result.archived, [])
})

test('清理只动 eligible：pinned/未过期/未归档一律不动（§6.3）', async (t) => {
  const { runtime, cache } = await makeRuntime(t, {
    rows: [
      oldSnapshot('cache-eligible', 120),
      oldSnapshot('cache-recent', 30),
      oldSnapshot('cache-pinned', 200),
      oldSnapshot('live-old', 200),
    ],
    archived: ['cache-eligible', 'cache-recent', 'cache-pinned'],
    pinned: ['cache-pinned'],
    configPatch: { autoArchive: { idleDays: 3650 } },
  })
  const outcome = await runOnce(runtime)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result.cachePurged.map((operation) => operation.id), ['cache-eligible'])
  assert.deepEqual(cache.deleted, ['cache-eligible'])
  assert.deepEqual(outcome.result.archived, [])
  assert.deepEqual(outcome.result.errors, [])
})

test('归档与清理共享 maxOperationsPerRun 预算，先归档后清理，超出记 limit', async (t) => {
  const { runtime } = await makeRuntime(t, {
    rows: [oldSnapshot('archive-me', 50), oldSnapshot('purge-me', 120)],
    archived: ['purge-me'],
    configPatch: { limits: { maxOperationsPerRun: 1 } },
  })
  const outcome = await runOnce(runtime)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result.archived.map((operation) => operation.id), ['archive-me'])
  assert.deepEqual(outcome.result.cachePurged, [])
  assert.deepEqual(outcome.result.skipped, [{ id: 'purge-me', reason: 'limit' }])
})

test('autoArchive.enabled=false：run 只做清理（§6.2）', async (t) => {
  const { runtime, registry, cache } = await makeRuntime(t, {
    rows: [oldSnapshot('archive-candidate', 50), oldSnapshot('purge-candidate', 120)],
    archived: ['purge-candidate'],
    configPatch: { autoArchive: { enabled: false } },
  })
  const outcome = await runOnce(runtime)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result.archived, [])
  assert.deepEqual(registry.calls.archive, [])
  assert.deepEqual(outcome.result.cachePurged.map((operation) => operation.id), ['purge-candidate'])
  assert.deepEqual(cache.deleted, ['purge-candidate'])
})

test('cacheCleanup.enabled=false：不删任何缓存', async (t) => {
  const { runtime, cache } = await makeRuntime(t, {
    rows: [oldSnapshot('purge-candidate', 120)],
    archived: ['purge-candidate'],
    configPatch: { cacheCleanup: { enabled: false }, autoArchive: { idleDays: 3650 } },
  })
  const outcome = await runOnce(runtime)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result.cachePurged, [])
  assert.deepEqual(cache.deleted, [])
})

test('单飞：并发调用第二个立即 busy，activeRun 结束后释放（§6.4）', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { runtime, registry } = await makeRuntime(t, {
    rows: [oldSnapshot('s1', 50)],
    async onArchive() {
      await gate
    },
  })
  const first = runOnce(runtime, { mode: 'auto' })
  const second = await runOnce(runtime, { mode: 'auto' })
  assert.deepEqual(second, { ok: false, busy: true })
  assert.notEqual(runtime.activeRun, null)
  release()
  const outcome = await first
  assert.equal(outcome.ok, true)
  assert.deepEqual(registry.calls.archive, ['s1'])
  assert.equal(runtime.activeRun, null)
  // 释放后可以再次运行
  const third = await runOnce(runtime, { mode: 'auto' })
  assert.equal(third.ok, true)
})

test('枚举失败：runOnce 不抛错，错误进 result.errors', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const runtime = createRuntime(makeCtx({}), { env: {}, dataDir, dshHome, now: () => NOW })
  await runtime.initialize()
  const outcome = await runOnce(runtime)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result.errors.length, 1)
  assert.match(outcome.result.errors[0].error, /sessionPersistence/)
})

test('purgeProjectionCache：表 API 不可用时降级只删 projcache 下一个文件，不碰 transcript', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const projectionRoot = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  await mkdir(projectionRoot, { recursive: true })
  await writeFile(path.join(projectionRoot, 's1.json'), '{"record":{"rows":{"title":{"val":"X"}}}}', 'utf8')
  const transcriptDir = path.join(dshHome, 'sessions', '--p--', 's1')
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(path.join(transcriptDir, 'session.v4.jsonl.zstd'), 'transcript', 'utf8')

  const runtime = createRuntime(makeCtx({}), { env: {}, dataDir, dshHome, now: () => NOW })
  const outcome = await purgeProjectionCache(runtime, 's1')
  assert.deepEqual(outcome, { purged: true, method: 'file' })
  assert.equal(await exists(path.join(projectionRoot, 's1.json')), false)
  assert.equal(await exists(path.join(transcriptDir, 'session.v4.jsonl.zstd')), true)

  const missing = await purgeProjectionCache(runtime, 's1')
  assert.deepEqual(missing, { purged: false, method: 'file-missing' })
})

test('purgeProjectionCache：优先表 API；delete 返回 false 表示无行可删', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const cache = makeProjectionCache({ deleteImpl: async () => false })
  const runtime = createRuntime(makeCtx({ sessionProjectionCache: cache }), {
    env: {},
    dataDir,
    dshHome,
    now: () => NOW,
  })
  const outcome = await purgeProjectionCache(runtime, 's1')
  assert.deepEqual(outcome, { purged: false, method: 'table' })
  assert.deepEqual(cache.deleted, ['s1'])
})

test('默认配置的 14/90 天：新建会话不会被归档/清理', async (t) => {
  const { runtime, registry, cache } = await makeRuntime(t, {
    rows: [oldSnapshot('fresh', 1)],
    configPatch: {},
  })
  const outcome = await runOnce(runtime)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result.archived, [])
  assert.deepEqual(outcome.result.cachePurged, [])
  assert.deepEqual(registry.calls.archive, [])
  assert.deepEqual(cache.deleted, [])
  assert.equal(defaultConfig().autoArchive.idleDays, 14)
  assert.equal(defaultConfig().cacheCleanup.unusedDays, 90)
})
