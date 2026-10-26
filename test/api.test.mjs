import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  API_PREFIX,
  buildSessionsPayload,
  buildStatePayload,
  denyNonLoopback,
  handleRequest,
  hostIsLoopback,
  readRequestBody,
  registerApi,
} from '../lib/api.js'
import { createRuntime } from '../index.js'
import {
  DAY_MS,
  NOW,
  makeCtx,
  makeHeader,
  makeLiveSessions,
  makePersistence,
  makeProjectionCache,
  makeReq,
  makeRes,
  makeSnapshot,
  makeTempDirs,
  makeWorkspaceRegistry,
  makeWebServer,
} from './helpers.mjs'

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function snapshot(id, days) {
  return makeSnapshot(makeHeader(id, { createdAt: NOW - days * DAY_MS }))
}

async function makeApiRuntime(t, options = {}) {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const registry = makeWorkspaceRegistry({
    workspaces: options.workspaces ?? [],
    archived: options.archived ?? [],
    pinned: options.pinned ?? [],
  })
  const cache = makeProjectionCache({ snapshots: options.snapshots ?? {} })
  const persistence = makePersistence(options.rows ?? [])
  const webServer = makeWebServer()
  const ctx = makeCtx({
    webServer,
    sessionPersistence: persistence,
    sessions: makeLiveSessions(options.liveSessions ?? []),
    workspaceRegistry: registry,
    sessionProjectionCache: cache,
  })
  const runtime = createRuntime(ctx, { env: {}, dataDir, dshHome, now: () => NOW })
  await runtime.initialize()
  const rescheduleCalls = []
  runtime.reschedule = () => {
    rescheduleCalls.push(true)
    return true
  }
  return { runtime, ctx, registry, cache, persistence, webServer, dataDir, dshHome, rescheduleCalls }
}

async function call(runtime, options) {
  const req = makeReq(options)
  const res = makeRes()
  await handleRequest(runtime, req, res)
  return res
}

test('hostIsLoopback / denyNonLoopback：只接受回环 Host', () => {
  const loopbackHosts = ['127.0.0.1', '127.0.0.1:11582', 'localhost', 'localhost:3000', '[::1]', '[::1]:8080', '::1']
  for (const host of loopbackHosts) {
    assert.equal(hostIsLoopback(makeReq({ headers: { host } })), true, host)
  }
  for (const host of ['evil.example', '10.0.0.2:8080', '0.0.0.0', 'example.com:443']) {
    assert.equal(hostIsLoopback(makeReq({ headers: { host } })), false, host)
  }
  // 没有 Host 头（本机 socket / HTTP/1.0）按回环处理
  assert.equal(hostIsLoopback(makeReq({})), true)

  const denied = makeRes()
  assert.equal(denyNonLoopback(makeReq({ headers: {} }), denied), false)
  const req = makeReq({ headers: { host: 'evil.example' } })
  const res = makeRes()
  assert.equal(denyNonLoopback(req, res), true)
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().ok, false)
  assert.match(res.json().error, /本机/)
})

test('registerApi 用 prefix 挂载 /dsh-auto-archive', () => {
  const webServer = makeWebServer()
  const runtime = { getService: () => undefined }
  const dispose = registerApi(runtime, webServer)
  assert.equal(typeof dispose, 'function')
  assert.equal(webServer.registrations.length, 1)
  assert.equal(webServer.registrations[0].kind, 'prefix')
  assert.equal(webServer.registrations[0].path, API_PREFIX)
  assert.equal(typeof webServer.registrations[0].handler, 'function')
  assert.throws(() => registerApi({}, {}), /webServer\.register/)
})

test('GET /api/state 返回契约字段与 counts', async (t) => {
  const { runtime } = await makeApiRuntime(t, {
    rows: [snapshot('old-live', 20), snapshot('old-archived', 120), snapshot('fresh', 1)],
    archived: ['old-archived'],
    pinned: ['fresh'],
    liveSessions: ['fresh'],
    snapshots: { 'old-live': { title: 'Live' } },
  })
  const res = await call(runtime, { url: `${API_PREFIX}/api/state` })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.config.autoArchive.idleDays, 14)
  assert.equal(body.effective.cacheCleanup.unusedDays, 90)
  assert.equal(body.lastRunAt, null)
  assert.equal(body.lastResult, null)
  assert.deepEqual(body.counts, {
    stored: 3,
    live: 1,
    archived: 1,
    pinned: 1,
    eligibleArchive: 1,
    eligibleCache: 1,
  })
  assert.equal(body.nextRunAt, null)
  assert.equal(body.pluginVersion, '0.1.0')
  assert.deepEqual(body.warnings, [])
})

test('GET /api/state：枚举失败也 200，counts 归零 + warnings', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const runtime = createRuntime(makeCtx({}), { env: {}, dataDir, dshHome, now: () => NOW })
  await runtime.initialize()
  const res = await call(runtime, { url: `${API_PREFIX}/api/state` })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.counts.stored, 0)
  assert.equal(body.warnings.length, 1)
  assert.match(body.warnings[0], /枚举会话失败/)
})

test('GET /api/sessions：按 lastActivity 升序、limit 生效、字段完整', async (t) => {
  const { runtime } = await makeApiRuntime(t, {
    rows: [snapshot('middle', 3), snapshot('oldest', 30), snapshot('newest', 1)],
    workspaces: [{ id: 'w1', title: 'Demo', path: 'C:\\work\\demo', sessionIds: ['oldest'] }],
    archived: ['newest'],
    snapshots: { oldest: { title: 'Oldest' } },
  })
  const limited = await call(runtime, { url: `${API_PREFIX}/api/sessions?limit=2` })
  assert.equal(limited.statusCode, 200)
  const limitedBody = limited.json()
  assert.equal(limitedBody.ok, true)
  assert.equal(limitedBody.total, 3)
  // 按 lastActivityAt 升序：最久未活动的排最前
  assert.deepEqual(limitedBody.sessions.map((session) => session.id), ['oldest', 'middle'])

  const body = (await call(runtime, { url: `${API_PREFIX}/api/sessions` })).json()
  assert.deepEqual(body.sessions.map((session) => session.id), ['oldest', 'middle', 'newest'])
  const oldest = body.sessions.find((session) => session.id === 'oldest')
  assert.deepEqual(Object.keys(oldest).sort(), [
    'archived',
    'createdAt',
    'cwd',
    'eligibleArchive',
    'eligibleCache',
    'id',
    'idleDays',
    'lastActivityAt',
    'pinned',
    'protected',
    'title',
    'workspaceId',
    'workspaceName',
  ].sort())
  assert.equal(oldest.title, 'Oldest')
  assert.equal(oldest.workspaceId, 'w1')
  assert.equal(oldest.workspaceName, 'Demo')
  assert.equal(oldest.idleDays, 30)
  assert.equal(oldest.eligibleArchive, true)
  assert.equal(oldest.reason, undefined)
  // 3 天不够 14 天：候选之外给出 reason
  const middle = body.sessions.find((session) => session.id === 'middle')
  assert.equal(middle.eligibleArchive, false)
  assert.equal(middle.reason, 'not-idle')
  // newest 已归档，不参与归档
  const newest = body.sessions.find((session) => session.id === 'newest')
  assert.equal(newest.archived, true)
  assert.equal(newest.eligibleArchive, false)
  assert.equal(newest.reason, 'archived')
})

test('GET /api/sessions：非法 limit 回退默认 200', async (t) => {
  const { runtime } = await makeApiRuntime(t, { rows: [snapshot('a', 1)] })
  const body = (await call(runtime, { url: `${API_PREFIX}/api/sessions?limit=abc` })).json()
  assert.equal(body.total, 1)
  assert.equal(body.sessions.length, 1)
})

test('GET /api/history 返回 state.history', async (t) => {
  const { runtime } = await makeApiRuntime(t)
  runtime.setState({
    version: 1,
    lastRunAt: 1,
    lastResult: { runId: 'r1' },
    history: [{ runId: 'r1' }],
    createdAt: 0,
  })
  const body = (await call(runtime, { url: `${API_PREFIX}/api/history` })).json()
  assert.deepEqual(body, { ok: true, history: [{ runId: 'r1' }] })
})

test('POST /api/config：深合并、落盘、重排定时器', async (t) => {
  const { runtime, rescheduleCalls, dataDir } = await makeApiRuntime(t)
  const res = await call(runtime, {
    method: 'POST',
    url: `${API_PREFIX}/api/config`,
    headers: { 'content-type': 'application/json' },
    body: { autoArchive: { idleDays: 3 }, dryRun: true },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.config.autoArchive.idleDays, 3)
  assert.equal(body.config.autoArchive.checkIntervalMinutes, 30)
  assert.equal(body.config.dryRun, true)
  assert.deepEqual(body.warnings, [])
  assert.equal(runtime.getConfig().autoArchive.idleDays, 3)
  assert.equal(rescheduleCalls.length, 1)
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'))
  assert.equal(onDisk.autoArchive.idleDays, 3)
  assert.equal(onDisk.dryRun, true)
})

test('POST /api/config：坏值回退默认并返回 warnings（仍然 200）', async (t) => {
  const { runtime } = await makeApiRuntime(t)
  const res = await call(runtime, {
    method: 'POST',
    url: `${API_PREFIX}/api/config`,
    headers: { 'content-type': 'application/json' },
    body: { cacheCleanup: { unusedDays: 9999 } },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.config.cacheCleanup.unusedDays, 90)
  assert.equal(body.warnings.length, 1)
})

test('POST /api/run：dry-run 返回候选且不写 state', async (t) => {
  const { runtime, registry, cache, dataDir } = await makeApiRuntime(t, {
    rows: [snapshot('old-live', 50)],
  })
  const res = await call(runtime, {
    method: 'POST',
    url: `${API_PREFIX}/api/run`,
    headers: { 'content-type': 'application/json' },
    body: { dryRun: true },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.result.mode, 'dry-run')
  assert.deepEqual(body.archived.map((operation) => operation.id), ['old-live'])
  assert.deepEqual(registry.calls.archive, [])
  assert.deepEqual(cache.deleted, [])
  assert.equal(await exists(path.join(dataDir, 'state.json')), false)
})

test('POST /api/run：并发运行返回 409 busy', async (t) => {
  const { runtime } = await makeApiRuntime(t)
  runtime.activeRun = Promise.resolve()
  try {
    const res = await call(runtime, {
      method: 'POST',
      url: `${API_PREFIX}/api/run`,
      headers: { 'content-type': 'application/json' },
      body: {},
    })
    assert.equal(res.statusCode, 409)
    assert.deepEqual(res.json(), { ok: false, error: 'busy' })
  } finally {
    runtime.activeRun = null
  }
})

test('POST /api/run：dryRun 类型非法 → 400', async (t) => {
  const { runtime } = await makeApiRuntime(t)
  const res = await call(runtime, {
    method: 'POST',
    url: `${API_PREFIX}/api/run`,
    headers: { 'content-type': 'application/json' },
    body: { dryRun: 'yes' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().ok, false)
})

test('POST /api/restore：去重、过滤、逐个恢复并报告失败', async (t) => {
  const { runtime, registry } = await makeApiRuntime(t, { archived: ['a', 'b', 'bad'] })
  const original = registry.unarchiveSession.bind(registry)
  registry.unarchiveSession = async (sessionId) => {
    if (sessionId === 'bad') {
      registry.calls.unarchive.push(sessionId)
      throw new Error('unarchive failed')
    }
    await original(sessionId)
  }
  const res = await call(runtime, {
    method: 'POST',
    url: `${API_PREFIX}/api/restore`,
    headers: { 'content-type': 'application/json' },
    body: { sessionIds: ['a', 'a', 'b', 42, '', '  ', 'bad'] },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.restored.sort(), ['a', 'b'].sort())
  assert.equal(body.failed.length, 1)
  assert.equal(body.failed[0].id, 'bad')
  assert.match(body.failed[0].error, /unarchive failed/)
  assert.deepEqual(registry.calls.unarchive, ['a', 'b', 'bad'])
})

test('POST /api/restore：sessionIds 缺失 → 400', async (t) => {
  const { runtime } = await makeApiRuntime(t)
  const res = await call(runtime, {
    method: 'POST',
    url: `${API_PREFIX}/api/restore`,
    headers: { 'content-type': 'application/json' },
    body: {},
  })
  assert.equal(res.statusCode, 400)
})

test('路由安全：未知路径 404、方法不符 405、非 JSON 400、坏 JSON 400、超大 413', async (t) => {
  const { runtime } = await makeApiRuntime(t)

  const notFound = await call(runtime, { url: `${API_PREFIX}/nope` })
  assert.equal(notFound.statusCode, 404)
  assert.equal(notFound.json().ok, false)

  const wrongMethod = await call(runtime, { method: 'POST', url: `${API_PREFIX}/api/state` })
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.Allow, 'GET')

  const wrongContentType = await call(runtime, {
    method: 'POST',
    url: `${API_PREFIX}/api/run`,
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  })
  assert.equal(wrongContentType.statusCode, 400)

  const badJson = await call(runtime, {
    method: 'POST',
    url: `${API_PREFIX}/api/run`,
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  })
  assert.equal(badJson.statusCode, 400)

  const tooLarge = await call(runtime, {
    method: 'POST',
    url: `${API_PREFIX}/api/run`,
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(70 * 1024),
  })
  assert.equal(tooLarge.statusCode, 413)
})

test('非回环 Host 的 API 请求一律 403（DNS rebinding 防护）', async (t) => {
  const { runtime } = await makeApiRuntime(t, { rows: [snapshot('s1', 20)] })
  for (const host of ['evil.example', '10.0.0.2:8080']) {
    const res = await call(runtime, { url: `${API_PREFIX}/api/state`, headers: { host } })
    assert.equal(res.statusCode, 403, host)
    assert.equal(res.json().ok, false)
  }
  const ok = await call(runtime, { url: `${API_PREFIX}/api/state`, headers: { host: '127.0.0.1:11582' } })
  assert.equal(ok.statusCode, 200)
})

test('尾斜杠路径也能命中路由', async (t) => {
  const { runtime } = await makeApiRuntime(t)
  const res = await call(runtime, { url: `${API_PREFIX}/api/state/` })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
})

test('readRequestBody：正常读取与超限拒绝', async () => {
  assert.equal(await readRequestBody(makeReq({ body: 'hello' })), 'hello')
  assert.equal(await readRequestBody(makeReq({}), 1024), '')
  await assert.rejects(() => readRequestBody(makeReq({ body: 'x'.repeat(2048) }), 1024), /too large/)
  await assert.rejects(
    () => readRequestBody(makeReq({ headers: { 'content-length': '999999' }, body: 'x' }), 1024),
    /too large/,
  )
})

test('buildStatePayload / buildSessionsPayload 可直接调用（不依赖 HTTP）', async (t) => {
  const { runtime } = await makeApiRuntime(t, { rows: [snapshot('a', 20)] })
  const state = await buildStatePayload(runtime)
  assert.equal(state.ok, true)
  assert.equal(state.counts.stored, 1)
  const sessions = await buildSessionsPayload(runtime, new URL(`http://127.0.0.1${API_PREFIX}/api/sessions?limit=500`))
  assert.equal(sessions.ok, true)
  assert.equal(sessions.total, 1)
})
