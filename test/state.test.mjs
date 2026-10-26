import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import {
  MAX_HISTORY,
  STATE_VERSION,
  defaultState,
  loadState,
  normalizeState,
  recordRun,
  saveState,
} from '../lib/state.js'
import { makeTempDirs } from './helpers.mjs'

function makeResult(index) {
  return {
    runId: `run-${index}`,
    at: 1000 + index,
    mode: 'manual',
    archived: [],
    cachePurged: [],
    skipped: [],
    errors: [],
    startedAt: 1000 + index,
    finishedAt: 1000 + index,
    countsBefore: {},
  }
}

test('defaultState 形状正确', () => {
  assert.deepEqual(defaultState(123), {
    version: STATE_VERSION,
    lastRunAt: null,
    lastResult: null,
    history: [],
    createdAt: 123,
  })
})

test('normalizeState 过滤坏 history、截断并保留已知字段', () => {
  const history = Array.from({ length: 40 }, (_, index) => makeResult(index))
  history.splice(3, 0, 'bad', 42, null)
  const { state, warnings } = normalizeState(
    { version: 7, lastRunAt: 555, lastResult: makeResult(0), history, createdAt: 111 },
    { now: 999 },
  )
  assert.equal(state.version, STATE_VERSION)
  assert.equal(state.createdAt, 111)
  assert.equal(state.lastRunAt, 555)
  assert.deepEqual(state.lastResult, makeResult(0))
  assert.equal(state.history.length, MAX_HISTORY)
  assert.ok(state.history.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item)))
  assert.ok(warnings.some((warning) => warning.includes('version')))
})

test('normalizeState 非对象回退默认状态', () => {
  const { state, warnings } = normalizeState('oops', { now: 42 })
  assert.deepEqual(state, defaultState(42))
  assert.equal(warnings.length, 1)
  const missing = normalizeState(undefined, { now: 42 })
  assert.deepEqual(missing.state, defaultState(42))
  assert.deepEqual(missing.warnings, [])
})

test('loadState 缺失/坏 JSON 都返回默认状态且不写盘（dry-run 安全）', async (t) => {
  const { dataDir } = await makeTempDirs(t)
  const missing = await loadState(dataDir, { now: 7 })
  assert.deepEqual(missing.state, defaultState(7))
  assert.deepEqual(missing.warnings, [])
  assert.deepEqual(await readdir(dataDir).catch(() => []), [])

  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'state.json'), '{broken', 'utf8')
  const bad = await loadState(dataDir, { now: 8 })
  assert.deepEqual(bad.state, defaultState(8))
  assert.ok(bad.warnings.some((warning) => warning.includes('JSON')))
  assert.equal(await readFile(path.join(dataDir, 'state.json'), 'utf8'), '{broken')
})

test('saveState 原子写 + loadState 读回', async (t) => {
  const { dataDir } = await makeTempDirs(t)
  const state = recordRun(defaultState(1), makeResult(1))
  await saveState(dataDir, state)
  const loaded = await loadState(dataDir, { now: 2 })
  assert.deepEqual(loaded.state, state)
  assert.deepEqual(await readdir(dataDir), ['state.json'])
})

test('recordRun：新结果在前、lastRun 更新、history 截断到 30', () => {
  let state = defaultState(100)
  for (let index = 0; index < 35; index += 1) {
    state = recordRun(state, makeResult(index))
  }
  assert.equal(state.history.length, MAX_HISTORY)
  assert.equal(state.history[0].runId, 'run-34')
  assert.equal(state.history[Math.min(34, MAX_HISTORY - 1)].runId, `run-${34 - (MAX_HISTORY - 1)}`)
  assert.equal(state.lastResult.runId, 'run-34')
  assert.equal(state.lastRunAt, makeResult(34).finishedAt)
  assert.equal(state.createdAt, 100)
})

test('recordRun 用 finishedAt 优先、缺失时回退 at', () => {
  const withFinished = recordRun(defaultState(1), { ...makeResult(5), finishedAt: 900 })
  assert.equal(withFinished.lastRunAt, 900)
  const onlyAt = recordRun(defaultState(1), { ...makeResult(5), finishedAt: undefined, at: 700 })
  assert.equal(onlyAt.lastRunAt, 700)
})
