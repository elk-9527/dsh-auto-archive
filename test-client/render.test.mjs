/**
 * render.test.mjs
 * 渲染层防御性：host 返回空对象 / 缺字段 / 超长列表 / 各类状态徽章，
 * 面板都必须能渲染且不抛错（CONTRACT §2.2「面板必须容错」）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { loadClient, mountPanel } from './harness.mjs'

const API = '/dsh-auto-archive'
const ENDPOINTS = {
  state: API + '/api/state',
  sessionsPrefix: API + '/api/sessions',
  history: API + '/api/history',
}

function createTimerSpy() {
  const setIntervalCalls = []
  const clearIntervalCalls = []
  return {
    setIntervalCalls,
    clearIntervalCalls,
    setInterval(fn, ms) {
      const id = 9000 + setIntervalCalls.length
      setIntervalCalls.push({ id, fn, ms })
      return id
    },
    clearInterval(id) {
      clearIntervalCalls.push(id)
    },
  }
}

/** 用给定的三份 host 响应挂载一次面板。 */
function mountWith(parts) {
  const router = (call) => {
    if (call.url === ENDPOINTS.state) return { json: parts.state === undefined ? {} : parts.state }
    if (call.url.indexOf(ENDPOINTS.sessionsPrefix) === 0) {
      return { json: parts.sessions === undefined ? [] : parts.sessions }
    }
    if (call.url === ENDPOINTS.history) return { json: parts.history === undefined ? {} : parts.history }
    return { json: { ok: true } }
  }
  const timers = createTimerSpy()
  const client = loadClient({ handler: router, setInterval: timers.setInterval, clearInterval: timers.clearInterval })
  return { client, app: mountPanel(client).app, timers }
}

function statValue(app, key) {
  return app.findByTestId('aa-stat-' + key).props.children[0].props.children
}

function sessionRows(app) {
  return app.findAllByTestId('aa-session-row')
}

function baseSession(overrides) {
  return Object.assign({
    id: 'session-x', title: '会话 X', workspaceId: 'w', workspaceName: '工作区',
    cwd: 'D:/w', createdAt: 1000, lastActivityAt: 2000, idleDays: 30,
    archived: false, pinned: false, protected: false,
    eligibleArchive: false, eligibleCache: false, reason: '',
  }, overrides || {})
}

// ---------------------------------------------------------------------------
// 空 / 缺字段
// ---------------------------------------------------------------------------

test('host 全部返回空对象 {} 时仍渲染完整面板', async () => {
  const { app } = mountWith({ state: {}, sessions: {}, history: {} })
  await app.settle()

  assert.ok(app.findByTestId('aa-panel'))
  assert.equal(app.findByTestId('aa-error'), null)
  assert.equal(app.findByTestId('aa-loading'), null)

  for (const key of ['stored', 'live', 'archived', 'pinned', 'eligibleArchive', 'eligibleCache']) {
    assert.equal(statValue(app, key), '0', key + ' 缺省应为 0')
  }

  const text = app.text()
  assert.ok(text.indexOf('没有匹配的会话') >= 0)
  assert.ok(text.indexOf('暂无运行记录') >= 0)
  assert.equal(app.findByTestId('aa-history-count').props.children, '共 0 条')
  assert.equal(app.findByTestId('aa-last-run').props.children, '—', 'lastRunAt 缺失时显示 —')
  assert.equal(app.findByTestId('aa-next-run').props.children, '未启用')
  // 表单回退默认配置
  assert.equal(app.findByTestId('aa-idle-days').props.value, '14')
  assert.equal(app.findByTestId('aa-unused-days').props.value, '90')
  assert.equal(app.findByTestId('aa-max-ops').props.value, '50')
  assert.equal(app.findByTestId('aa-interval').props.value, '30')
})

test('会话行缺字段时用 id / 未分组 / — 填空，且不渲染复选框', async () => {
  const { app } = mountWith({
    state: { ok: true, counts: { stored: 1 } },
    sessions: [{ id: 'only-id' }],
    history: [],
  })
  await app.settle()

  const rows = sessionRows(app)
  assert.equal(rows.length, 1)
  const text = app.text()
  assert.ok(text.indexOf('only-id') >= 0, '缺 title 时用 id 兜底')
  assert.ok(text.indexOf('未分组') >= 0)
  assert.ok(text.indexOf('未到期') >= 0)

  const checkboxes = app.findAll((element) => element.props && element.props.type === 'checkbox')
  assert.equal(checkboxes.length, 0, '非归档会话不渲染复选框')
})

test('sessions 支持 {sessions:[...]} 包装形态，history 支持 {history:[...]}', async () => {
  const { app } = mountWith({
    state: { ok: true, counts: { archived: 1 } },
    sessions: { ok: true, sessions: [baseSession({ id: 'wrapped', archived: true })] },
    history: {
      ok: true,
      history: [
        { runId: 'r1', at: 1700000000000, mode: 'auto', archived: [], cachePurged: [], skipped: [], errors: [] },
        { runId: 'r2', at: 1700000000001, mode: 'dry-run', archived: [{ id: 'a' }], cachePurged: [], skipped: [], errors: [] },
      ],
    },
  })
  await app.settle()

  assert.equal(sessionRows(app).length, 1)
  assert.ok(app.findByTestId('aa-history'), '应渲染历史列表')
  assert.equal(app.findByTestId('aa-history-count').props.children, '共 2 条')
  const text = app.text()
  assert.ok(text.indexOf('自动巡检') >= 0)
  assert.ok(text.indexOf('预览') >= 0)
})

test('state.lastResult 缺字段时结果卡仍可渲染（不因 undefined.length 崩溃）', async () => {
  const { app } = mountWith({
    state: { ok: true, lastRunAt: 1700000000000, lastResult: {} },
    sessions: [],
    history: [],
  })
  await app.settle()

  assert.ok(app.findByTestId('aa-result'))
  const text = app.text().replace(/\s+/g, ' ')
  assert.ok(text.indexOf('最近一次结果') >= 0)
  assert.ok(text.indexOf('归档 0 个') >= 0, '实际文本：' + text.slice(0, 400))
  assert.ok(text.indexOf('错误 0 个') >= 0)
})

// ---------------------------------------------------------------------------
// 状态徽章 / 筛选
// ---------------------------------------------------------------------------

test('会话状态徽章与 Tab 计数正确', async () => {
  const sessions = [
    baseSession({ id: 'a', title: 'A', archived: true, eligibleCache: true }),
    baseSession({ id: 'b', title: 'B', archived: true, eligibleCache: false }),
    baseSession({ id: 'c', title: 'C', protected: true, pinned: true }),
    baseSession({ id: 'd', title: 'D', eligibleArchive: true }),
    baseSession({ id: 'e', title: 'E' }),
  ]
  const { app } = mountWith({ state: { ok: true, counts: { stored: 5 } }, sessions, history: [] })
  await app.settle()

  const badges = app.findAll((element) => {
    return element.props && typeof element.props.className === 'string' &&
      element.props.className.indexOf('aa-badge') === 0
  })
  assert.deepEqual(badges.map((badge) => badge.props.children), [
    '可清理缓存', '已归档', '受保护', '可归档', '未到期',
  ])

  assert.equal(app.findByTestId('aa-filter-all').props.children, '全部(5)')
  assert.equal(app.findByTestId('aa-filter-archive').props.children, '可归档(1)')
  assert.equal(app.findByTestId('aa-filter-cache').props.children, '可清理(1)')
  assert.equal(app.findByTestId('aa-filter-archived').props.children, '已归档(2)')

  await app.click('aa-filter-archive')
  assert.equal(sessionRows(app).length, 1)
  assert.ok(app.text().indexOf('D') >= 0)

  await app.click('aa-filter-cache')
  assert.equal(sessionRows(app).length, 1)

  await app.click('aa-filter-archived')
  assert.equal(sessionRows(app).length, 2)

  await app.click('aa-filter-all')
  assert.equal(sessionRows(app).length, 5)
})

test('非归档会话在「操作」列展示 reason（如 active）', async () => {
  const { app } = mountWith({
    state: { ok: true },
    sessions: [baseSession({ id: 'busy', reason: 'active' })],
    history: [],
  })
  await app.settle()
  assert.ok(app.text().indexOf('active') >= 0)
})

// ---------------------------------------------------------------------------
// 长列表分页
// ---------------------------------------------------------------------------

test('超过 100 条会话默认只渲染 100 行，可展开/收起', async () => {
  const sessions = []
  for (let index = 0; index < 150; index += 1) {
    sessions.push(baseSession({
      id: 'session-' + String(index).padStart(4, '0'),
      title: '会话 ' + index,
      archived: index % 10 === 0,
      eligibleArchive: index % 7 === 0,
      eligibleCache: false,
    }))
  }
  const { app } = mountWith({ state: { ok: true, counts: { stored: 150 } }, sessions, history: [] })
  await app.settle()

  assert.equal(app.findByTestId('aa-filter-all').props.children, '全部(150)')
  assert.equal(sessionRows(app).length, 100, '默认最多渲染 SESSION_PAGE_SIZE 行')

  const expandButton = app.findAll((element) => {
    return element.props && typeof element.props.children === 'string' &&
      element.props.children.indexOf('显示全部') === 0
  })[0]
  assert.ok(expandButton, '超过一页时应提供展开按钮')
  assert.equal(expandButton.props.children, '显示全部 150 条')

  await app.act(() => expandButton.props.onClick())
  assert.equal(sessionRows(app).length, 150, '展开后渲染全部行')

  const collapseButton = app.findAll((element) => {
    return element.props && typeof element.props.children === 'string' &&
      element.props.children === '收起'
  })[0]
  assert.ok(collapseButton)
  await app.act(() => collapseButton.props.onClick())
  assert.equal(sessionRows(app).length, 100, '收起后回到一页')
})

test('恰好 100 条时不出现展开按钮', async () => {
  const sessions = []
  for (let index = 0; index < 100; index += 1) {
    sessions.push(baseSession({ id: 's-' + index, title: 'S' + index }))
  }
  const { app } = mountWith({ state: { ok: true }, sessions, history: [] })
  await app.settle()

  assert.equal(sessionRows(app).length, 100)
  const expandButton = app.findAll((element) => {
    return element.props && typeof element.props.children === 'string' &&
      element.props.children.indexOf('显示全部') === 0
  })
  assert.equal(expandButton.length, 0)
})

test('state.warnings 非空时显示宿主提示横幅，为空时不显示', async () => {
  const withWarnings = mountWith({
    state: { ok: true, warnings: ['枚举会话失败：workspaceRegistry 不可用', 42, '配置已回退默认值'] },
    sessions: [],
    history: [],
  })
  await withWarnings.app.settle()

  const banner = withWarnings.app.findByTestId('aa-warnings')
  assert.ok(banner, '应有 aa-warnings 横幅')
  assert.match(withWarnings.app.text(), /枚举会话失败：workspaceRegistry 不可用/)
  assert.match(withWarnings.app.text(), /配置已回退默认值/)

  const withoutWarnings = mountWith({ state: { ok: true }, sessions: [], history: [] })
  await withoutWarnings.app.settle()
  assert.equal(withoutWarnings.app.findByTestId('aa-warnings'), null)
})
