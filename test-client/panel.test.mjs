/**
 * panel.test.mjs
 * 面板的挂载 / 加载 / 保存 / 预览 / 执行（二次确认）/ 恢复 / 错误态 / 卸载清理。
 * 所有请求都走 fetch 桩，绝不访问网络。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { loadClient, mountPanel } from './harness.mjs'

const API = '/dsh-auto-archive'
const ENDPOINTS = {
  state: API + '/api/state',
  sessions: API + '/api/sessions?limit=200',
  history: API + '/api/history',
  config: API + '/api/config',
  run: API + '/api/run',
  restore: API + '/api/restore',
}

const NOW = 1700000000000

function baseConfig() {
  return {
    version: 1,
    autoArchive: { enabled: true, idleDays: 14, checkIntervalMinutes: 30 },
    cacheCleanup: { enabled: true, unusedDays: 90 },
    protect: { pinnedSessions: true, sessionIds: ['keep-me'], workspaces: ['D:/protected'] },
    limits: { maxOperationsPerRun: 50 },
    dryRun: false,
  }
}

function buildFixtures(overrides = {}) {
  const config = overrides.config || baseConfig()
  const state = Object.assign({
    ok: true,
    config: config,
    effective: overrides.effective || config,
    lastRunAt: NOW - 3600000,
    lastResult: null,
    counts: { stored: 4, live: 1, archived: 1, pinned: 1, eligibleArchive: 1, eligibleCache: 1 },
    nextRunAt: NOW + 1800000,
    pluginVersion: '0.1.0',
  }, overrides.state || {})
  const sessions = overrides.sessions || [
    {
      id: 'session-archived', title: '已归档会话', workspaceId: 'w1', workspaceName: '工作区一',
      cwd: 'D:/w1', createdAt: NOW - 200 * 86400000, lastActivityAt: NOW - 100 * 86400000,
      idleDays: 100, archived: true, pinned: false, protected: false,
      eligibleArchive: false, eligibleCache: true, reason: '',
    },
    {
      id: 'session-eligible', title: '可归档会话', workspaceId: 'w2', workspaceName: '工作区二',
      cwd: 'D:/w2', createdAt: NOW - 60 * 86400000, lastActivityAt: NOW - 20 * 86400000,
      idleDays: 20, archived: false, pinned: false, protected: false,
      eligibleArchive: true, eligibleCache: false, reason: '',
    },
    {
      id: 'session-protected', title: '受保护会话', workspaceId: 'w1', workspaceName: '工作区一',
      cwd: 'D:/w1', createdAt: NOW - 90 * 86400000, lastActivityAt: NOW - 80 * 86400000,
      idleDays: 80, archived: false, pinned: true, protected: true,
      eligibleArchive: false, eligibleCache: false, reason: 'active',
    },
    {
      id: 'session-live', title: '活跃会话', workspaceId: 'w2', workspaceName: '工作区二',
      cwd: 'D:/w2', createdAt: NOW - 3600000, lastActivityAt: NOW - 1800000,
      idleDays: 0.1, archived: false, pinned: false, protected: false,
      eligibleArchive: false, eligibleCache: false, reason: '',
    },
  ]
  const history = overrides.history || [
    {
      runId: 'auto-1', at: NOW - 86400000, mode: 'auto',
      archived: [{ id: 'session-old', title: '旧会话', lastActivityDays: 30 }],
      cachePurged: [{ id: 'session-older', title: '更旧会话', lastActivityDays: 120 }],
      skipped: [], errors: [], startedAt: NOW - 86400000, finishedAt: NOW - 86400000,
      countsBefore: null,
    },
  ]
  return {
    config,
    state,
    sessions,
    history,
    configWarnings: overrides.configWarnings || [],
    runBusy: overrides.runBusy === true,
  }
}

function createRoutes(fixtures) {
  return (call) => {
    const url = call.url
    if (url === ENDPOINTS.state) return { json: fixtures.state }
    if (url.indexOf(API + '/api/sessions') === 0) return { json: fixtures.sessions }
    if (url === ENDPOINTS.history) return { json: { ok: true, history: fixtures.history } }
    if (url === ENDPOINTS.config) return { json: { ok: true, config: call.body, warnings: fixtures.configWarnings } }
    if (url === ENDPOINTS.run) {
      if (fixtures.runBusy) return { status: 409, json: { ok: false, error: 'busy' } }
      const dryRun = !!(call.body && call.body.dryRun === true)
      return {
        json: {
          ok: true,
          result: {
            runId: dryRun ? 'dry-1' : 'manual-1',
            at: NOW,
            mode: dryRun ? 'dry-run' : 'manual',
            archived: [{ id: 'session-eligible', title: '可归档会话', lastActivityDays: 20 }],
            cachePurged: [{ id: 'session-archived', title: '已归档会话', lastActivityDays: 100 }],
            skipped: [{ id: 'session-live', reason: 'active' }],
            errors: [],
            startedAt: NOW,
            finishedAt: NOW + 12,
            countsBefore: { stored: 4 },
          },
        },
      }
    }
    if (url === ENDPOINTS.restore) {
      const ids = call.body && Array.isArray(call.body.sessionIds) ? call.body.sessionIds : []
      return { json: { ok: true, restored: ids, failed: [] } }
    }
    return { json: { ok: true } }
  }
}

function createTimerSpy() {
  const setIntervalCalls = []
  const clearIntervalCalls = []
  return {
    setIntervalCalls,
    clearIntervalCalls,
    setInterval(fn, ms) {
      const id = 7000 + setIntervalCalls.length
      setIntervalCalls.push({ id, fn, ms })
      return id
    },
    clearInterval(id) {
      clearIntervalCalls.push(id)
    },
  }
}

function setup(overrides = {}) {
  const fixtures = buildFixtures(overrides)
  const timers = createTimerSpy()
  const client = loadClient({
    handler: createRoutes(fixtures),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  const mounted = mountPanel(client)
  return { fixtures, timers, client, mounted, app: mounted.app }
}

// ---------------------------------------------------------------------------
// 首屏加载
// ---------------------------------------------------------------------------

test('挂载后 effect 只发 3 个 GET，渲染状态卡与统计数字', async () => {
  const { client, app, fixtures } = setup()

  assert.equal(client.fetchStub.count, 0, 'render 期间不得发请求（README/契约硬要求）')

  await app.settle()

  assert.deepEqual(client.fetchStub.paths(), [
    ENDPOINTS.state,
    ENDPOINTS.sessions,
    ENDPOINTS.history,
  ])
  assert.equal(app.findByTestId('aa-loading'), null, '加载完成应移除 loading 提示')
  assert.equal(app.findByTestId('aa-error'), null)

  const text = app.text()
  assert.ok(text.indexOf('自动归档') >= 0)
  const statValue = (testId) => app.findByTestId(testId).props.children[0].props.children
  assert.equal(statValue('aa-stat-stored'), '4')
  assert.equal(statValue('aa-stat-eligibleArchive'), '1')
  assert.equal(statValue('aa-stat-eligibleCache'), '1')
  assert.ok(app.findByTestId('aa-last-run'), '应显示最近运行时间')
  assert.ok(app.findByTestId('aa-next-run'), '应显示下次巡检时间')
  assert.equal(fixtures.state.pluginVersion, '0.1.0')
  assert.ok(text.indexOf('0.1.0') >= 0, '页脚应显示插件版本')
})

test('请求失败时错误可见，loading 结束', async () => {
  const fixtures = buildFixtures()
  const timers = createTimerSpy()
  const client = loadClient({
    handler: (call) => {
      if (call.url === ENDPOINTS.state) return { status: 503, ok: false, json: { ok: false, error: 'host 未就绪' } }
      return createRoutes(fixtures)(call)
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  const app = mountPanel(client).app
  await app.settle()

  assert.equal(app.findByTestId('aa-loading'), null)
  const error = app.findByTestId('aa-error')
  assert.ok(error, '应渲染错误框')
  const errorText = app.text()
  assert.ok(errorText.indexOf('加载状态失败') >= 0)
  assert.ok(errorText.indexOf('host 未就绪') >= 0, '应透出 host 的错误原因')
})

test('dryRun 生效时顶部出现仅预览提示', async () => {
  const fixtures = buildFixtures()
  const effective = Object.assign({}, fixtures.config, { dryRun: true })
  const { app } = setup({ effective })
  await app.settle()
  assert.ok(app.findByTestId('aa-dryrun-hint'), '应显示 dryRun 提示')
})

test('面板只读契约字段：effective 缺失时回退 config，不崩', async () => {
  const fixtures = buildFixtures()
  const state = Object.assign({}, fixtures.state)
  delete state.effective
  const { app } = setup({ state })
  await app.settle()
  assert.equal(app.findByTestId('aa-error'), null)
  assert.equal(app.findByTestId('aa-idle-days').props.value, '14')
})

// ---------------------------------------------------------------------------
// 配置编辑 / 保存
// ---------------------------------------------------------------------------

test('修改天数后出现未保存提示，保存提交深合并部分配置', async () => {
  const { client, app, fixtures } = setup()
  await app.settle()

  assert.equal(app.findByTestId('aa-save').props.disabled, true, '初始无修改，保存应禁用')
  assert.equal(app.findByTestId('aa-dirty'), null)

  await app.change('aa-idle-days', '5')
  assert.ok(app.findByTestId('aa-dirty'), '修改后应提示未保存')
  assert.equal(app.findByTestId('aa-save').props.disabled, false)

  await app.click('aa-save')

  const call = client.fetchStub.lastCall('/api/config')
  assert.ok(call, '应 POST /api/config')
  assert.equal(call.method, 'POST')
  assert.deepEqual(call.body, {
    autoArchive: { enabled: true, idleDays: 5, checkIntervalMinutes: 30 },
    cacheCleanup: { enabled: true, unusedDays: 90 },
    protect: { pinnedSessions: true, sessionIds: ['keep-me'], workspaces: ['D:/protected'] },
    limits: { maxOperationsPerRun: 50 },
    dryRun: false,
  })
  assert.equal(app.findByTestId('aa-dirty'), null, '保存成功后清除未保存标记')
  assert.match(app.text(), /配置已保存/)
  assert.equal(fixtures.state.config.autoArchive.idleDays, 14, 'fixture 不应被客户端改动')
})

test('保存时 host 返回 warnings 会在提示里展示（被规范化修正可见）', async () => {
  const { app } = setup({ configWarnings: ['autoArchive.idleDays 超出范围，已修正为 3650'] })
  await app.settle()

  await app.change('aa-idle-days', '9999')
  await app.click('aa-save')

  const notice = app.findByTestId('aa-notice')
  assert.ok(notice)
  assert.match(app.text(), /配置已保存/)
  assert.match(app.text(), /已修正为 3650/)
})

test('state.warnings 非空时顶部显示宿主提示横幅', async () => {
  const { app } = setup({ state: { warnings: ['枚举会话失败：workspaceRegistry 不可用'] } })
  await app.settle()

  const banner = app.findByTestId('aa-warnings')
  assert.ok(banner, '应显示宿主提示')
  assert.match(app.text(), /枚举会话失败：workspaceRegistry 不可用/)
})

test('越界输入在提交前被夹紧，非法输入回退默认值', async () => {
  const { client, app } = setup()
  await app.settle()

  await app.change('aa-idle-days', '0')
  await app.change('aa-interval', '9999')
  await app.change('aa-unused-days', '3651')
  await app.change('aa-max-ops', '9999')
  await app.click('aa-save')

  const body = client.fetchStub.lastCall('/api/config').body
  assert.equal(body.autoArchive.idleDays, 1)
  assert.equal(body.autoArchive.checkIntervalMinutes, 1440)
  assert.equal(body.cacheCleanup.unusedDays, 3650)
  assert.equal(body.limits.maxOperationsPerRun, 500)

  await app.change('aa-idle-days', '')
  await app.click('aa-save')
  assert.equal(client.fetchStub.lastCall('/api/config').body.autoArchive.idleDays, 14, '空输入回退当前生效值')
})

test('保护名单按行解析并提交', async () => {
  const { client, app } = setup()
  await app.settle()

  await app.change('aa-protect-ids', 'session-1\n\nsession-2\nsession-1\n')
  await app.change('aa-protect-workspaces', '  D:/protected  \n')
  await app.click('aa-save')

  const protect = client.fetchStub.lastCall('/api/config').body.protect
  assert.deepEqual(protect.sessionIds, ['session-1', 'session-2'])
  assert.deepEqual(protect.workspaces, ['D:/protected'])
  assert.equal(protect.pinnedSessions, true)
})

test('开关切换只改草稿，保存后才提交', async () => {
  const { client, app } = setup()
  await app.settle()

  await app.click('aa-auto-enabled')
  await app.click('aa-cache-enabled')
  assert.equal(client.fetchStub.callsTo('/api/config').length, 0, '未保存前不应提交')
  assert.ok(app.findByTestId('aa-auto-disabled-hint'), '关闭自动归档后显示说明')

  await app.click('aa-save')
  const body = client.fetchStub.lastCall('/api/config').body
  assert.equal(body.autoArchive.enabled, false)
  assert.equal(body.cacheCleanup.enabled, false)
})

test('撤销修改回到生效配置', async () => {
  const { client, app } = setup()
  await app.settle()

  await app.change('aa-idle-days', '3')
  assert.ok(app.findByTestId('aa-dirty'))
  await app.click('aa-reset')

  assert.equal(app.findByTestId('aa-dirty'), null)
  assert.equal(app.findByTestId('aa-idle-days').props.value, '14')
  assert.equal(client.fetchStub.callsTo('/api/config').length, 0, '撤销不应提交')
  assert.match(app.text(), /已撤销未保存的修改/)
})

test('手动刷新重新拉取三份数据', async () => {
  const { client, app } = setup()
  await app.settle()
  assert.equal(client.fetchStub.count, 3)

  await app.click('aa-refresh')
  assert.deepEqual(client.fetchStub.paths().slice(3), [ENDPOINTS.state, ENDPOINTS.sessions, ENDPOINTS.history])
  assert.equal(app.findByTestId('aa-error'), null)
})

// ---------------------------------------------------------------------------
// 预览 / 执行（二次确认）/ 恢复
// ---------------------------------------------------------------------------

test('立即预览只发 dryRun:true，不触发确认条', async () => {
  const { client, app } = setup()
  await app.settle()

  await app.click('aa-preview')
  const call = client.fetchStub.lastCall('/api/run')
  assert.deepEqual(call.body, { dryRun: true })
  assert.equal(app.findByTestId('aa-confirm-bar'), null)
  assert.ok(app.findByTestId('aa-result'), '应先显示结果卡')
  assert.match(app.text(), /预览\(未做任何变更\)/)
  assert.match(app.text(), /将归档 1 个会话/)
  assert.match(app.text(), /将清理 1 个投影缓存/)
  assert.ok(app.findByTestId('aa-result-skipped'), '应列出跳过项')
})

test('宿主 busy（409/ok:false）时展示可读提示而不是裸 busy', async () => {
  const { app } = setup({ runBusy: true })
  await app.settle()

  await app.click('aa-preview')

  const error = app.findByTestId('aa-error')
  assert.ok(error, '应显示错误框')
  assert.match(app.text(), /预览失败/)
  assert.match(app.text(), /宿主正在执行另一轮巡检/)
})

test('立即执行需二次确认，确认后 dryRun:false', async () => {
  const { client, app } = setup()
  await app.settle()

  await app.click('aa-run')
  assert.equal(client.fetchStub.callsTo('/api/run').length, 0, '未确认前不得执行')
  const bar = app.findByTestId('aa-confirm-bar')
  assert.ok(bar, '应出现确认条')
  assert.match(app.text(), /确认执行/)

  await app.click('aa-cancel-run')
  assert.equal(app.findByTestId('aa-confirm-bar'), null)
  assert.equal(client.fetchStub.callsTo('/api/run').length, 0)

  await app.click('aa-run')
  await app.click('aa-confirm-run')
  assert.deepEqual(client.fetchStub.lastCall('/api/run').body, { dryRun: false })
  assert.match(app.text(), /执行完成:/)
  assert.match(app.text(), /已归档 1 个会话/)
})

test('执行后重新拉取状态、会话与历史', async () => {
  const { client, app } = setup()
  await app.settle()
  await app.click('aa-preview')
  const paths = client.fetchStub.paths()
  assert.deepEqual(paths.slice(3), [ENDPOINTS.run, ENDPOINTS.state, ENDPOINTS.sessions, ENDPOINTS.history])
})

test('勾选已归档会话后恢复选中，提交 sessionIds', async () => {
  const { client, app } = setup()
  await app.settle()

  const restoreButton = app.findByTestId('aa-restore-selected')
  assert.equal(restoreButton.props.disabled, true, '未选中时禁用')

  const checkboxes = app.findAll((element) => element.props && element.props.type === 'checkbox')
  assert.equal(checkboxes.length, 1, '只有已归档会话可勾选')
  await app.act(() => checkboxes[0].props.onChange())

  assert.equal(app.findByTestId('aa-restore-selected').props.disabled, false)
  await app.click('aa-restore-selected')

  const call = client.fetchStub.lastCall('/api/restore')
  assert.equal(call.method, 'POST')
  assert.deepEqual(call.body, { sessionIds: ['session-archived'] })
  assert.match(app.text(), /已恢复 1 个会话/)
})

test('行内恢复按钮直接恢复该会话', async () => {
  const { client, app } = setup()
  await app.settle()

  const rowButton = app.findByTestId('aa-restore-row')
  assert.ok(rowButton)
  await app.click('aa-restore-row')
  assert.deepEqual(client.fetchStub.lastCall('/api/restore').body, { sessionIds: ['session-archived'] })
})

test('恢复失败时错误可见', async () => {
  const fixtures = buildFixtures()
  const timers = createTimerSpy()
  const client = loadClient({
    handler: (call) => {
      if (call.url === ENDPOINTS.restore) return { status: 500, ok: false, json: { ok: false, error: 'restore failed' } }
      return createRoutes(fixtures)(call)
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  const app = mountPanel(client).app
  await app.settle()
  await app.click('aa-restore-row')

  assert.match(app.text(), /恢复失败/)
  assert.match(app.text(), /restore failed/)
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

test('挂载启动 15s 轮询，卸载时 clearInterval', async () => {
  const { client, app, timers } = setup()
  await app.settle()

  assert.equal(timers.setIntervalCalls.length, 1)
  assert.equal(timers.setIntervalCalls[0].ms, 15000)
  assert.equal(timers.clearIntervalCalls.length, 0)

  app.unmount()
  assert.deepEqual(timers.clearIntervalCalls, [timers.setIntervalCalls[0].id])

  // 卸载后定时器回调也不应抛错（内部靠 alive ref 抑制 setState）。
  const before = client.fetchStub.count
  assert.doesNotThrow(() => timers.setIntervalCalls[0].fn())
  await nextTurn()
  await nextTurn()
  assert.ok(client.fetchStub.count >= before)
})

test('后台轮询失败不打断面板（不显示错误框）', async () => {
  const fixtures = buildFixtures()
  const timers = createTimerSpy()
  let stateCalls = 0
  const client = loadClient({
    handler: (call) => {
      if (call.url === ENDPOINTS.state) {
        stateCalls += 1
        if (stateCalls > 1) return { status: 500, ok: false, json: { ok: false, error: 'poll fail' } }
      }
      return createRoutes(fixtures)(call)
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  const app = mountPanel(client).app
  await app.settle()
  assert.equal(app.findByTestId('aa-error'), null)

  // 手动触发一次轮询（等价于 15s 定时器）。
  timers.setIntervalCalls[0].fn()
  await nextTurn()
  await nextTurn()
  assert.equal(app.findByTestId('aa-error'), null, '轮询失败不弹错误')
  assert.ok(app.findByTestId('aa-panel'), '面板仍在')
})
