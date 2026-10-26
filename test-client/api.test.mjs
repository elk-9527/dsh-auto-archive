/**
 * api.test.mjs
 * 覆盖 client 侧对 CONTRACT §5 的 HTTP 约定、错误处理，以及所有
 * 「host 字段缺失也要能让面板活」的归一化函数（防御性读取）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { loadClient, createFetchStub } from './harness.mjs'

const client = loadClient()
const T = client.exports.__test

function apiWith(handler) {
  const stub = createFetchStub(handler)
  return { api: T.createApi(stub.fetch), stub }
}

const okJson = (json) => ({ json: json })

// ---------------------------------------------------------------------------
// HTTP 约定
// ---------------------------------------------------------------------------

test('GET 端点 URL 与 CONTRACT §5 完全一致', async () => {
  const { api, stub } = apiWith(() => okJson({ ok: true }))

  await api.getState()
  await api.getSessions(200)
  await api.getHistory()

  assert.equal(stub.calls.length, 3)
  assert.equal(stub.calls[0].url, '/dsh-auto-archive/api/state')
  assert.equal(stub.calls[0].method, 'GET')
  assert.equal(stub.calls[1].url, '/dsh-auto-archive/api/sessions?limit=200')
  assert.equal(stub.calls[2].url, '/dsh-auto-archive/api/history')
})

test('getSessions 的 limit 默认 200 且夹在 [1,1000]', async () => {
  const { api, stub } = apiWith(() => okJson([]))

  await api.getSessions()
  await api.getSessions('abc')
  await api.getSessions(0)
  await api.getSessions(99999)
  await api.getSessions(37)

  assert.deepEqual(stub.paths(), [
    '/dsh-auto-archive/api/sessions?limit=200',
    '/dsh-auto-archive/api/sessions?limit=200',
    '/dsh-auto-archive/api/sessions?limit=1',
    '/dsh-auto-archive/api/sessions?limit=1000',
    '/dsh-auto-archive/api/sessions?limit=37',
  ])
})

test('POST 端点带 JSON 头，body 形状符合契约', async () => {
  const { api, stub } = apiWith(() => okJson({ ok: true }))

  await api.saveConfig({ autoArchive: { idleDays: 7 } })
  await api.run(true)
  await api.run()
  await api.restore(['a', 'b'])

  const [config, run1, run2, restore] = stub.calls
  assert.equal(config.url, '/dsh-auto-archive/api/config')
  assert.equal(config.method, 'POST')
  assert.deepEqual(config.headers, { 'Content-Type': 'application/json' })
  assert.equal(config.rawBody, '{"autoArchive":{"idleDays":7}}')
  assert.deepEqual(config.body, { autoArchive: { idleDays: 7 } })

  assert.equal(run1.url, '/dsh-auto-archive/api/run')
  assert.equal(run1.method, 'POST')
  assert.deepEqual(run1.body, { dryRun: true })

  assert.deepEqual(run2.body, { dryRun: false }, '非严格 true 一律视为 false')
  assert.equal(run2.rawBody, '{"dryRun":false}')

  assert.equal(restore.url, '/dsh-auto-archive/api/restore')
  assert.deepEqual(restore.body, { sessionIds: ['a', 'b'] })
})

test('restore 的 sessionIds 会去空、去重、剔除非法项', async () => {
  const { api, stub } = apiWith(() => okJson({ ok: true, restored: [], failed: [] }))
  await api.restore([' a ', 3, null, '', 'a', 'b'])
  assert.deepEqual(stub.calls[0].body, { sessionIds: ['a', 'b'] })
})

test('返回 {ok:false,error} 时以该错误文案 reject', async () => {
  const { api } = apiWith(() => ({ status: 409, ok: false, json: { ok: false, error: 'busy' } }))
  await assert.rejects(api.run(true), /busy/)
})

test('{ok:false} 没有 error 时给默认拒绝文案', async () => {
  const { api } = apiWith(() => ({ status: 400, ok: false, json: { ok: false } }))
  await assert.rejects(api.getState(), /请求被拒绝/)
})

test('HTTP 非 2xx 且无 JSON 业务错误时报告状态码', async () => {
  const { api } = apiWith(() => ({ status: 500, ok: false, json: null }))
  await assert.rejects(api.getState(), /请求失败\(HTTP 500\)/)
})

test('响应不是合法 JSON 时明确报错', async () => {
  const { api } = apiWith(() => ({ status: 200, ok: true, invalidJson: true }))
  await assert.rejects(api.getState(), /不是合法 JSON/)
})

test('网络错误原样向上抛', async () => {
  const { api } = apiWith(() => ({ reject: 'fetch failed: ECONNREFUSED' }))
  await assert.rejects(api.getState(), /ECONNREFUSED/)
})

test('fetch 返回非对象时报「接口无响应」', async () => {
  const stub = { fetch: async () => null }
  const api = T.createApi(stub.fetch)
  await assert.rejects(api.getState(), /接口无响应/)
})

// ---------------------------------------------------------------------------
// 配置归一化 / 提交体
// ---------------------------------------------------------------------------

test('defaultConfig 每次返回全新对象，默认值与 §4 一致', () => {
  const first = T.defaultConfig()
  assert.deepEqual(first, {
    version: 1,
    autoArchive: { enabled: true, idleDays: 14, checkIntervalMinutes: 30 },
    cacheCleanup: { enabled: true, unusedDays: 90 },
    protect: { pinnedSessions: true, sessionIds: [], workspaces: [] },
    limits: { maxOperationsPerRun: 50 },
    dryRun: false,
  })
  first.autoArchive.idleDays = 99
  assert.equal(T.defaultConfig().autoArchive.idleDays, 14, '不得共享可变默认值')
})

test('normalizeConfig 对空/损坏配置回退默认值', () => {
  for (const raw of [null, undefined, 42, 'x', [], {}]) {
    const cfg = T.normalizeConfig(raw)
    assert.deepEqual(cfg, T.defaultConfig(), '输入 ' + JSON.stringify(raw) + ' 应完全回退默认值')
  }
  const weird = T.normalizeConfig({
    version: 'abc',
    autoArchive: 'oops',
    cacheCleanup: null,
    protect: 7,
    limits: { maxOperationsPerRun: 'NaN' },
    dryRun: 'yes',
  })
  assert.deepEqual(weird, T.defaultConfig())
})

test('normalizeConfig 深合并 + 数字夹紧 + 布尔严格判定', () => {
  const cfg = T.normalizeConfig({
    version: 2,
    autoArchive: { enabled: false, idleDays: 0, checkIntervalMinutes: 9999 },
    cacheCleanup: { unusedDays: 3651 },
    protect: { pinnedSessions: 'yes', sessionIds: ['a', ' a ', 5, ''], workspaces: ['w'] },
    limits: { maxOperationsPerRun: 9000 },
    dryRun: true,
  })

  assert.equal(cfg.version, 2)
  assert.equal(cfg.autoArchive.enabled, false)
  assert.equal(cfg.autoArchive.idleDays, 1, 'idleDays 下界 1')
  assert.equal(cfg.autoArchive.checkIntervalMinutes, 1440, '巡检间隔上界 1440')
  assert.equal(cfg.cacheCleanup.unusedDays, 3650, 'unusedDays 上界 3650')
  assert.equal(cfg.protect.pinnedSessions, true, '非布尔值回退默认 true')
  assert.deepEqual(cfg.protect.sessionIds, ['a'], '去空去重且剔除非字符串')
  assert.deepEqual(cfg.protect.workspaces, ['w'])
  assert.equal(cfg.limits.maxOperationsPerRun, 500, '单次上限上界 500')
  assert.equal(cfg.dryRun, true)

  const decimals = T.normalizeConfig({ autoArchive: { idleDays: '7.6' } })
  assert.equal(decimals.autoArchive.idleDays, 8, '数字字符串转整数并四舍五入')
})

test('buildConfigPayload 只提交 schema 内字段，数字夹紧、名单按行解析', () => {
  const draft = T.normalizeConfig({
    autoArchive: { idleDays: 0, checkIntervalMinutes: 0 },
    cacheCleanup: { unusedDays: 0 },
    limits: { maxOperationsPerRun: 0 },
  })
  const payload = T.buildConfigPayload(draft, {
    sessionIds: ' session-1 \n\nsession-2\nsession-1\n',
    workspaces: 'D:/work/a\n',
  })

  assert.deepEqual(payload, {
    autoArchive: { enabled: true, idleDays: 1, checkIntervalMinutes: 1 },
    cacheCleanup: { enabled: true, unusedDays: 1 },
    protect: {
      pinnedSessions: true,
      sessionIds: ['session-1', 'session-2'],
      workspaces: ['D:/work/a'],
    },
    limits: { maxOperationsPerRun: 1 },
    dryRun: false,
  })
  assert.equal('version' in payload, false, '提交部分配置时不该带 version')

  const fromDraft = T.buildConfigPayload(draft, {})
  assert.deepEqual(fromDraft.protect.sessionIds, [], '缺名单文本时提交空数组')
})

// ---------------------------------------------------------------------------
// host 响应归一化（防御性读取）
// ---------------------------------------------------------------------------

test('normalizeCounts 缺失/非法计数一律为 0', () => {
  assert.deepEqual(T.normalizeCounts(null), {
    stored: 0, live: 0, archived: 0, pinned: 0, eligibleArchive: 0, eligibleCache: 0,
  })
  assert.deepEqual(
    T.normalizeCounts({ stored: '12', live: -3, archived: 4.6, pinned: 'x' }),
    { stored: 12, live: 0, archived: 5, pinned: 0, eligibleArchive: 0, eligibleCache: 0 },
  )
})

test('normalizeState 对空响应给出安全默认（effective 回退 config）', () => {
  const state = T.normalizeState(undefined)
  assert.deepEqual(state.config, T.defaultConfig())
  assert.deepEqual(state.effective, state.config, '缺 effective 时回退 config')
  assert.equal(state.lastRunAt, 0)
  assert.equal(state.nextRunAt, 0)
  assert.equal(state.lastResult, null)
  assert.equal(state.pluginVersion, '')
  assert.deepEqual(state.counts, T.normalizeCounts(null))
  assert.deepEqual(state.warnings, [], '缺 warnings 时为 []')
})

test('normalizeState 收集 host warnings（去非字符串、trim、去重）', () => {
  const state = T.normalizeState({ ok: true, warnings: ['枚举失败 ', 7, '枚举失败', '', ' 配置回退 '] })
  assert.deepEqual(state.warnings, ['枚举失败', '配置回退'])
  const bare = T.normalizeState({ ok: true, warnings: 'not-array' })
  assert.deepEqual(bare.warnings, [])
})

test('normalizeState 映射完整响应', () => {
  const state = T.normalizeState({
    ok: true,
    config: { autoArchive: { idleDays: 21 } },
    effective: { dryRun: true, limits: { maxOperationsPerRun: 10 } },
    lastRunAt: 1700000000000,
    lastResult: { runId: 'r1', mode: 'manual', archived: [{ id: 's1', title: 't', lastActivityDays: 30 }] },
    counts: { stored: 3, live: 1, archived: 2, pinned: 1, eligibleArchive: 1, eligibleCache: 2 },
    nextRunAt: '1700000060000',
    pluginVersion: '0.1.0',
  })
  assert.equal(state.config.autoArchive.idleDays, 21)
  assert.equal(state.effective.dryRun, true)
  assert.equal(state.effective.limits.maxOperationsPerRun, 10)
  assert.equal(state.lastRunAt, 1700000000000)
  assert.equal(state.nextRunAt, 1700000060000)
  assert.equal(state.lastResult.mode, 'manual')
  assert.deepEqual(state.counts, { stored: 3, live: 1, archived: 2, pinned: 1, eligibleArchive: 1, eligibleCache: 2 })
  assert.equal(state.pluginVersion, '0.1.0')
})

test('normalizeSessions 兼容裸数组与 {sessions}，丢弃坏行并补齐默认', () => {
  const now = Date.now()
  const rows = T.normalizeSessions([
    null,
    'bad',
    {},
    { id: 's1' },
    {
      id: 's2',
      title: '会话二',
      workspaceId: 'w1',
      workspaceName: '工作区',
      cwd: 'D:/a',
      createdAt: 1,
      lastActivityAt: now - 10 * 86400000,
      archived: true,
      pinned: true,
      protected: 'yes',
      eligibleArchive: 1,
      eligibleCache: true,
      reason: 'active',
    },
  ])

  assert.deepEqual(rows.map((row) => row.id), ['s1', 's2'], '无 id / 非对象行被丢弃')
  const s1 = rows[0]
  assert.equal(s1.title, 's1', '缺标题回退 id')
  assert.equal(s1.workspaceName, '')
  assert.equal(s1.archived, false)
  assert.equal(s1.eligibleArchive, false)
  assert.ok(!isFinite(s1.idleDays), '既无 idleDays 又无 lastActivityAt 时 idleDays 为 NaN')
  assert.equal(s1.reason, '')

  const s2 = rows[1]
  assert.equal(s2.title, '会话二')
  assert.equal(s2.archived, true)
  assert.equal(s2.pinned, true)
  assert.equal(s2.protected, false, '非严格 true 一律 false')
  assert.equal(s2.eligibleArchive, false, '非严格 true 一律 false')
  assert.equal(s2.eligibleCache, true)
  assert.ok(Math.abs(s2.idleDays - 10) < 0.05, '缺 idleDays 时用 lastActivityAt 计算，实际 ' + s2.idleDays)
  assert.equal(s2.reason, 'active')

  const wrapped = T.normalizeSessions({ ok: true, sessions: [{ id: 'x', idleDays: 3 }] })
  assert.equal(wrapped.length, 1)
  assert.equal(wrapped[0].idleDays, 3)

  assert.deepEqual(T.normalizeSessions(null), [])
  assert.deepEqual(T.normalizeSessions({ sessions: 'nope' }), [])
})

test('normalizeHistory 兼容 {history} 与裸数组，逐条归一化', () => {
  assert.deepEqual(T.normalizeHistory(null), [])
  assert.deepEqual(T.normalizeHistory({ history: 'nope' }), [])
  assert.deepEqual(T.normalizeHistory([null, 3]), [])

  const list = T.normalizeHistory({
    ok: true,
    history: [
      { runId: 'r1', mode: 'auto', archived: [{ id: 'a', title: 'A' }], cachePurged: [{ id: 'b' }], skipped: [{ id: 'c', reason: 'active' }], errors: [{ id: 'd', error: 'boom' }] },
      { runId: 'r2', mode: 'dry-run' },
    ],
  })
  assert.equal(list.length, 2)
  assert.equal(list[0].runId, 'r1')
  assert.deepEqual(list[0].archived, [{ id: 'a', title: 'A', lastActivityDays: NaN }])
  assert.deepEqual(list[0].skipped, [{ id: 'c', reason: 'active' }])
  assert.deepEqual(list[0].errors, [{ id: 'd', error: 'boom' }])
  assert.equal(list[1].cachePurged.length, 0)

  assert.equal(T.normalizeHistory([{ runId: 'r3' }])[0].runId, 'r3', '裸数组同样接受')
})

test('normalizeRunResult 对空对象给出空结构，不抛错', () => {
  const empty = T.normalizeRunResult({})
  assert.equal(empty.runId, '')
  assert.equal(empty.at, 0)
  assert.equal(empty.mode, '')
  assert.deepEqual(empty.archived, [])
  assert.deepEqual(empty.cachePurged, [])
  assert.deepEqual(empty.skipped, [])
  assert.deepEqual(empty.errors, [])
  assert.equal(empty.countsBefore, null)

  const junk = T.normalizeRunResult({ archived: [{}, null, 'x'], skipped: [{ id: 5 }] })
  assert.equal(junk.archived.length, 1, '非对象行丢弃，空对象保留占位')
  assert.deepEqual(junk.skipped, [{ id: '5', reason: '' }])
})

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

test('formatTime / formatRelative / formatIdle / shortId', () => {
  assert.equal(T.formatTime(0), '—')
  assert.equal(T.formatTime('nope'), '—')
  assert.match(T.formatTime(1700000000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

  const now = 1700000000000
  assert.equal(T.formatRelative(0, now), '—')
  assert.equal(T.formatRelative(now - 20 * 1000, now), '刚刚')
  assert.equal(T.formatRelative(now - 5 * 60000, now), '5 分钟前')
  assert.equal(T.formatRelative(now - 3 * 3600000, now), '3 小时前')
  assert.equal(T.formatRelative(now - 2 * 86400000, now), '2 天前')
  assert.equal(T.formatRelative(now - 40 * 86400000, now), T.formatTime(now - 40 * 86400000))
  assert.equal(T.formatRelative(now + 60000, now), '刚刚')

  assert.equal(T.formatIdle(NaN), '—')
  assert.equal(T.formatIdle(-1), '—')
  assert.equal(T.formatIdle(12.34), '12.3 天')
  assert.equal(T.formatIdle('7'), '7 天')
  assert.equal(T.formatIdle(null), '—')

  assert.equal(T.shortId('short-id'), 'short-id')
  assert.equal(T.shortId('0123456789abcdefghijklmn'), '0123456789…ijklmn')
  assert.equal(T.shortId(null), '')
})

test('statusLabel / statusClass 覆盖各状态', () => {
  assert.equal(T.statusLabel(null), '—')
  assert.equal(T.statusLabel({ archived: true, eligibleCache: true }), '可清理缓存')
  assert.equal(T.statusLabel({ archived: true, eligibleCache: false }), '已归档')
  assert.equal(T.statusLabel({ protected: true }), '受保护')
  assert.equal(T.statusLabel({ eligibleArchive: true }), '可归档')
  assert.equal(T.statusLabel({}), '未到期')

  assert.equal(T.statusClass({ eligibleArchive: true }), 'good')
  assert.equal(T.statusClass({ archived: true, eligibleCache: true }), 'warn')
  assert.equal(T.statusClass({ archived: true }), 'muted')
  assert.equal(T.statusClass({ protected: true }), 'danger')
  assert.equal(T.statusClass({}), 'muted')
})

test('modeLabel / runSummary 文案', () => {
  assert.equal(T.modeLabel('auto'), '自动巡检')
  assert.equal(T.modeLabel('manual'), '手动执行')
  assert.equal(T.modeLabel('dry-run'), '预览')
  assert.equal(T.modeLabel(''), '—')
  assert.equal(T.modeLabel('x'), 'x')

  const result = T.normalizeRunResult({
    archived: [{ id: 'a' }, { id: 'b' }],
    cachePurged: [{ id: 'c' }],
    skipped: [{ id: 'd', reason: 'active' }],
    errors: [{ id: 'e', error: 'boom' }],
  })
  assert.equal(T.runSummary(result, true), '预览(未做任何变更):将归档 2 个会话，将清理 1 个投影缓存，跳过 1 个，错误 1 个')
  assert.equal(T.runSummary(result, false), '执行完成:已归档 2 个会话，已清理 1 个投影缓存，跳过 1 个，错误 1 个')
  assert.equal(T.runSummary(T.normalizeRunResult({}), true), '预览(未做任何变更):没有符合条件的会话')
})

test('parseLines / clampInt 基础行为', () => {
  assert.deepEqual(T.parseLines('a\n\n b \r\nc'), ['a', 'b', 'c'])
  assert.deepEqual(T.parseLines(''), [])
  assert.deepEqual(T.parseLines(null), [])
  assert.equal(T.clampInt(5, 1, 10, 99), 5)
  assert.equal(T.clampInt(0, 1, 10, 99), 1)
  assert.equal(T.clampInt(50, 1, 10, 99), 10)
  assert.equal(T.clampInt('abc', 1, 10, 99), 99)
  assert.equal(T.clampInt('', 1, 10, 99), 99)
})

test('errorMessage：host busy 翻成可读中文，其它错误原样并加前缀', () => {
  assert.equal(
    T.errorMessage(new Error('busy'), '执行失败'),
    '执行失败: 宿主正在执行另一轮巡检，请稍后再试',
  )
  assert.equal(T.errorMessage(new Error('HTTP 500'), '保存配置失败'), '保存配置失败: HTTP 500')
  assert.equal(T.errorMessage('plain'), 'plain')
  assert.equal(T.errorMessage(new Error(''), '恢复失败'), '恢复失败: Error')
})
