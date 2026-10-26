import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  DAY_MS,
  classifySessions,
  collectArtifactMtimes,
  collectSessionInventory,
  computeCounts,
  encodeSegment,
  extractProjectedTitle,
  idleDaysOf,
  projectionCacheSessionsRootOf,
  sessionsRootOf,
  titleFromProjectionCache,
  titleFromProjectionFile,
} from '../lib/sessions.js'
import { createRuntime } from '../index.js'
import { defaultConfig, normalizeConfig } from '../lib/config.js'
import {
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

test('encodeSegment 与内核目录编码一致', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('abc-123.x_y'), 'abc-123.x_y')
  assert.equal(encodeSegment('sess:1'), 'sess~003A1')
  assert.equal(encodeSegment('a\\b'), 'a~005Cb')
  assert.equal(encodeSegment('a b'), 'a~0020b')
  assert.equal(encodeSegment('~'), '~007E')
  assert.equal(encodeSegment('中文'), '~4E2D~6587')
  assert.equal(encodeSegment(''), '')
})

test('extractProjectedTitle 兼容 record.rows.title / {val} / 外层 value', () => {
  assert.equal(extractProjectedTitle({ record: { rows: { title: { val: 'A' } } } }), 'A')
  assert.equal(extractProjectedTitle({ rows: { title: 'B' } }), 'B')
  assert.equal(extractProjectedTitle({ value: { record: { rows: { title: { value: 'C' } } } } }), 'C')
  assert.equal(extractProjectedTitle({ record: { rows: { title: { text: 'D' } } } }), 'D')
  assert.equal(extractProjectedTitle({ record: { rows: {} } }), undefined)
  assert.equal(extractProjectedTitle(null), undefined)
  assert.equal(extractProjectedTitle('x'), undefined)
})

test('titleFromProjectionCache 命中/未命中/异常都容错', () => {
  const cache = makeProjectionCache({ snapshots: { s1: { title: 'Hello' }, s2: { title: { val: 'World' } } } })
  const header = makeHeader('s1')
  assert.equal(titleFromProjectionCache(cache, header), 'Hello')
  assert.equal(titleFromProjectionCache(cache, makeHeader('s2')), 'World')
  assert.equal(titleFromProjectionCache(cache, makeHeader('missing')), undefined)
  assert.equal(titleFromProjectionCache(undefined, header), undefined)
  const throwing = {
    cachedSnapshot() {
      throw new Error('cache down')
    },
  }
  assert.equal(titleFromProjectionCache(throwing, header), undefined)
})

test('titleFromProjectionFile 读 <id>.json / 编码名降级', async (t) => {
  const { root } = await makeTempDirs(t)
  const directory = path.join(root, 'projcache')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'sess:1.json'), JSON.stringify({ record: { rows: { title: { val: '编码' } } } }), 'utf8')
  await writeFile(path.join(directory, 'plain.json'), JSON.stringify({ record: { rows: { title: { val: '明文' } } } }), 'utf8')
  assert.equal(await titleFromProjectionFile(directory, 'plain'), '明文')
  assert.equal(await titleFromProjectionFile(directory, 'missing'), undefined)
  assert.equal(await titleFromProjectionFile(undefined, 'plain'), undefined)
})

test('collectArtifactMtimes 扫描日志 mtime、忽略无关文件、兼容原始目录名', async (t) => {
  const { root } = await makeTempDirs(t)
  const sessionsRoot = path.join(root, 'sessions')
  const project = path.join(sessionsRoot, '--C--work-demo--')
  const older = new Date(NOW - 5 * DAY_MS)
  const newer = new Date(NOW - 2 * DAY_MS)

  const dirA = path.join(project, encodeSegment('sess:1'))
  await mkdir(dirA, { recursive: true })
  await writeFile(path.join(dirA, 'session.v4.jsonl.zstd'), 'x', 'utf8')
  await utimes(path.join(dirA, 'session.v4.jsonl.zstd'), older, older)
  await writeFile(path.join(dirA, 'session.v5.jsonl'), 'y', 'utf8')
  await utimes(path.join(dirA, 'session.v5.jsonl'), newer, newer)
  // 无关文件不应影响
  await writeFile(path.join(dirA, 'attachments.log'), 'z', 'utf8')
  await utimes(path.join(dirA, 'attachments.log'), new Date(NOW), new Date(NOW))

  const dirB = path.join(project, 'weird~name')
  await mkdir(dirB, { recursive: true })
  await writeFile(path.join(dirB, 'session.jsonl'), 'w', 'utf8')
  await utimes(path.join(dirB, 'session.jsonl'), older, older)

  const mtimes = await collectArtifactMtimes(sessionsRoot, ['sess:1', 'weird~name', 'absent'])
  assert.equal(mtimes.size, 2)
  assert.equal(Math.round(mtimes.get('sess:1')), Math.round(newer.getTime()))
  assert.equal(Math.round(mtimes.get('weird~name')), Math.round(older.getTime()))

  assert.equal((await collectArtifactMtimes(path.join(root, 'nope'), ['x'])).size, 0)
  assert.equal((await collectArtifactMtimes(sessionsRoot, [])).size, 0)
})

test('collectSessionInventory 组装标题/工作区/活会话/最后活动时间', async (t) => {
  const { root, dshHome, dataDir } = await makeTempDirs(t)
  const sessionsRoot = sessionsRootOf(dshHome)
  const project = path.join(sessionsRoot, '--C--work-demo--')
  const dir = path.join(project, encodeSegment('sess:1'))
  await mkdir(dir, { recursive: true })
  const mtime = new Date(NOW - 3 * DAY_MS)
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), 'x', 'utf8')
  await utimes(path.join(dir, 'session.v4.jsonl.zstd'), mtime, mtime)

  const projectionRoot = projectionCacheSessionsRootOf(dshHome)
  await mkdir(projectionRoot, { recursive: true })
  await writeFile(
    path.join(projectionRoot, 'sess:2.json'),
    JSON.stringify({ record: { rows: { title: { val: 'Beta' } } } }),
    'utf8',
  )
  assert.ok(root)

  const rows = [
    makeSnapshot(makeHeader('sess:1', { createdAt: NOW - 10 * DAY_MS })),
    makeSnapshot(makeHeader('sess:2', { createdAt: NOW - 1 * DAY_MS, cwd: null })),
    // 重复 id 只保留一条
    makeSnapshot(makeHeader('sess:1', { createdAt: NOW - 10 * DAY_MS })),
  ]
  const registry = makeWorkspaceRegistry({
    workspaces: [
      { id: 'w1', title: 'Demo', path: 'C:\\work\\demo', sessionIds: ['sess:1'] },
      { id: 'w2', title: 'Other', path: 'D:\\other', sessionIds: ['sess:2'] },
    ],
  })
  const projectionCache = makeProjectionCache({ snapshots: { 'sess:1': { title: 'Alpha' } } })
  const ctx = makeCtx({
    sessionPersistence: makePersistence(rows),
    sessions: makeLiveSessions(['sess:1']),
    workspaceRegistry: registry,
    sessionProjectionCache: projectionCache,
  })
  const runtime = createRuntime(ctx, { env: {}, dataDir, dshHome, now: () => NOW })

  const inventory = await collectSessionInventory(runtime)
  assert.equal(inventory.records.length, 2)
  assert.equal(inventory.live, 1)
  assert.deepEqual([...inventory.archivedIds], [])
  assert.deepEqual([...inventory.pinnedIds], [])

  const first = inventory.records.find((record) => record.id === 'sess:1')
  assert.equal(first.title, 'Alpha')
  assert.equal(first.workspaceId, 'w1')
  assert.equal(first.workspaceName, 'Demo')
  assert.equal(first.cwd, 'C:\\work\\demo')
  assert.equal(Math.round(first.lastActivityMs), Math.round(mtime.getTime()))
  assert.equal(first.archived, false)
  assert.equal(first.pinned, false)

  const second = inventory.records.find((record) => record.id === 'sess:2')
  assert.equal(second.title, 'Beta')
  assert.equal(second.workspaceId, 'w2')
  assert.equal(second.cwd, 'D:\\other')
})

test('collectSessionInventory：persistence 缺失时抛错（由 run 捕获）', async (t) => {
  const { dataDir, dshHome } = await makeTempDirs(t)
  const runtime = createRuntime(makeCtx({}), { env: {}, dataDir, dshHome, now: () => NOW })
  await assert.rejects(() => collectSessionInventory(runtime), /sessionPersistence/)
})

test('classifySessions：14 天归档边界（含恰好 14 天）', () => {
  const config = defaultConfig()
  const records = [
    { id: 'exactly', lastActivityMs: NOW - 14 * DAY_MS, archived: false, pinned: false, workspaceId: null, cwd: null },
    { id: 'slightly-newer', lastActivityMs: NOW - 14 * DAY_MS + 1, archived: false, pinned: false, workspaceId: null, cwd: null },
    { id: 'young', lastActivityMs: NOW - 13 * DAY_MS, archived: false, pinned: false, workspaceId: null, cwd: null },
  ]
  const classified = classifySessions(records, config, NOW)
  const byId = Object.fromEntries(classified.map((record) => [record.id, record]))
  assert.equal(byId.exactly.eligibleArchive, true)
  assert.equal(byId.exactly.idleDays, 14)
  assert.equal(byId.exactly.reason, undefined)
  assert.equal(byId['slightly-newer'].eligibleArchive, false)
  assert.equal(byId['slightly-newer'].reason, 'not-idle')
  assert.equal(byId.young.eligibleArchive, false)
})

test('classifySessions：90 天清理边界（含恰好 90 天）', () => {
  const config = defaultConfig()
  const records = [
    { id: 'archived-exactly', lastActivityMs: NOW - 90 * DAY_MS, archived: true, pinned: false, workspaceId: null, cwd: null },
    { id: 'archived-newer', lastActivityMs: NOW - 90 * DAY_MS + 1, archived: true, pinned: false, workspaceId: null, cwd: null },
    { id: 'archived-young', lastActivityMs: NOW - 60 * DAY_MS, archived: true, pinned: false, workspaceId: null, cwd: null },
    { id: 'not-archived-old', lastActivityMs: NOW - 200 * DAY_MS, archived: false, pinned: false, workspaceId: null, cwd: null },
  ]
  const classified = classifySessions(records, config, NOW)
  const byId = Object.fromEntries(classified.map((record) => [record.id, record]))
  assert.equal(byId['archived-exactly'].eligibleCache, true)
  assert.equal(byId['archived-exactly'].eligibleArchive, false)
  assert.equal(byId['archived-newer'].eligibleCache, false)
  assert.equal(byId['archived-newer'].reason, 'archived')
  assert.equal(byId['not-archived-old'].eligibleCache, false)
})

test('classifySessions：pinned / sessionIds / workspaces 保护（大小写不敏感）', () => {
  const config = normalizeConfig({
    protect: { sessionIds: ['explicit'], workspaces: ['my-project'] },
  }).config
  const records = [
    { id: 'pinned', lastActivityMs: NOW - 100 * DAY_MS, archived: false, pinned: true, workspaceId: null, cwd: null },
    { id: 'explicit', lastActivityMs: NOW - 100 * DAY_MS, archived: false, pinned: false, workspaceId: null, cwd: null },
    { id: 'by-workspace', lastActivityMs: NOW - 100 * DAY_MS, archived: false, pinned: false, workspaceId: null, cwd: 'C:\\Work\\My-Project' },
    { id: 'by-workspace-id', lastActivityMs: NOW - 100 * DAY_MS, archived: false, pinned: false, workspaceId: 'MY-PROJECT', cwd: null },
    { id: 'free', lastActivityMs: NOW - 100 * DAY_MS, archived: false, pinned: false, workspaceId: 'other', cwd: 'C:\\other' },
  ]
  const classified = classifySessions(records, config, NOW)
  const byId = Object.fromEntries(classified.map((record) => [record.id, record]))
  assert.equal(byId.pinned.protected, true)
  assert.equal(byId.pinned.eligibleArchive, false)
  assert.equal(byId.pinned.reason, 'protected')
  assert.equal(byId.explicit.protected, true)
  assert.equal(byId['by-workspace'].protected, true)
  assert.equal(byId['by-workspace-id'].protected, true)
  assert.equal(byId.free.protected, false)
  assert.equal(byId.free.eligibleArchive, true)
})

test('classifySessions：pinnedSessions=false 时不再因 pin 保护；archived 不参与归档', () => {
  const config = normalizeConfig({ protect: { pinnedSessions: false } }).config
  const records = [
    { id: 'pinned-old', lastActivityMs: NOW - 100 * DAY_MS, archived: false, pinned: true, workspaceId: null, cwd: null },
    { id: 'archived-old', lastActivityMs: NOW - 100 * DAY_MS, archived: true, pinned: false, workspaceId: null, cwd: null },
  ]
  const classified = classifySessions(records, config, NOW)
  const byId = Object.fromEntries(classified.map((record) => [record.id, record]))
  assert.equal(byId['pinned-old'].protected, false)
  assert.equal(byId['pinned-old'].eligibleArchive, true)
  assert.equal(byId['archived-old'].eligibleArchive, false)
  assert.equal(byId['archived-old'].eligibleCache, true)
})

test('classifySessions：enabled=false 不影响候选展示（§6.2 备注）', () => {
  const config = normalizeConfig({ autoArchive: { enabled: false } }).config
  const classified = classifySessions(
    [{ id: 'old', lastActivityMs: NOW - 50 * DAY_MS, archived: false, pinned: false, workspaceId: null, cwd: null }],
    config,
    NOW,
  )
  assert.equal(classified[0].eligibleArchive, true)
})

test('idleDaysOf / computeCounts', () => {
  assert.equal(idleDaysOf(NOW - DAY_MS, NOW), 1)
  assert.equal(idleDaysOf(NOW + DAY_MS, NOW), 0)
  assert.equal(idleDaysOf(undefined, NOW), Number.POSITIVE_INFINITY)

  const records = [
    { eligibleArchive: true, eligibleCache: false },
    { eligibleArchive: false, eligibleCache: true },
    { eligibleArchive: true, eligibleCache: false },
  ]
  assert.deepEqual(computeCounts(records, { archivedIds: new Set(['a']), pinnedIds: new Set(['b', 'c']), live: 2 }), {
    stored: 3,
    live: 2,
    archived: 1,
    pinned: 2,
    eligibleArchive: 2,
    eligibleCache: 1,
  })
})
