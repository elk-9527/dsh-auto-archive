import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  cloneConfig,
  defaultConfig,
  loadConfig,
  normalizeConfig,
  readJsonFile,
  resolveDataDir,
  resolveDshHome,
  saveConfig,
  writeJsonAtomic,
} from '../lib/config.js'
import { makeTempDirs } from './helpers.mjs'

test('defaultConfig 返回完整默认值且可安全修改', () => {
  const config = defaultConfig()
  assert.equal(config.version, CONFIG_VERSION)
  assert.deepEqual(config, {
    version: 1,
    autoArchive: { enabled: true, idleDays: 14, checkIntervalMinutes: 30 },
    cacheCleanup: { enabled: true, unusedDays: 90 },
    protect: { pinnedSessions: true, sessionIds: [], workspaces: [] },
    limits: { maxOperationsPerRun: 50 },
    dryRun: false,
  })
  config.autoArchive.idleDays = 99
  config.protect.sessionIds.push('x')
  assert.equal(defaultConfig().autoArchive.idleDays, 14)
  assert.deepEqual(defaultConfig().protect.sessionIds, [])
  // 默认配置本身是冻结的
  assert.throws(() => {
    DEFAULT_CONFIG.autoArchive.idleDays = 1
  })
})

test('normalizeConfig 深合并局部配置并保留其它默认值', () => {
  const { config, warnings } = normalizeConfig({
    autoArchive: { idleDays: 7 },
    protect: { sessionIds: ['s1', 's2'], workspaces: ['C:\\Work'] },
    dryRun: true,
  })
  assert.deepEqual(warnings, [])
  assert.equal(config.autoArchive.idleDays, 7)
  assert.equal(config.autoArchive.enabled, true)
  assert.equal(config.autoArchive.checkIntervalMinutes, 30)
  assert.equal(config.cacheCleanup.unusedDays, 90)
  assert.equal(config.protect.pinnedSessions, true)
  assert.deepEqual(config.protect.sessionIds, ['s1', 's2'])
  assert.deepEqual(config.protect.workspaces, ['C:\\Work'])
  assert.equal(config.limits.maxOperationsPerRun, 50)
  assert.equal(config.dryRun, true)
  assert.equal(config.version, 1)
})

test('normalizeConfig 坏值逐字段回退默认值并给出 warnings（绝不含糊合并）', () => {
  const { config, warnings } = normalizeConfig({
    autoArchive: { idleDays: 0, checkIntervalMinutes: 'fast' },
    cacheCleanup: { unusedDays: 4000, enabled: 'yes' },
    protect: { sessionIds: ['ok', 42], workspaces: 'C:\\Work' },
    limits: { maxOperationsPerRun: 1.5 },
    dryRun: 'true',
  })
  assert.equal(config.autoArchive.idleDays, 14)
  assert.equal(config.autoArchive.checkIntervalMinutes, 30)
  assert.equal(config.cacheCleanup.unusedDays, 90)
  assert.equal(config.cacheCleanup.enabled, true)
  assert.deepEqual(config.protect.sessionIds, [])
  assert.deepEqual(config.protect.workspaces, [])
  assert.equal(config.limits.maxOperationsPerRun, 50)
  assert.equal(config.dryRun, false)
  assert.ok(warnings.length >= 8, `warnings=${warnings.length}`)
  assert.ok(warnings.some((warning) => warning.includes('autoArchive.idleDays')))
  assert.ok(warnings.some((warning) => warning.includes('cacheCleanup.enabled')))
  assert.ok(warnings.some((warning) => warning.includes('protect.sessionIds')))
})

test('normalizeConfig 保留边界值（1/3650、1/1440、1/500）', () => {
  const low = normalizeConfig({
    autoArchive: { idleDays: 1, checkIntervalMinutes: 1 },
    cacheCleanup: { unusedDays: 1 },
    limits: { maxOperationsPerRun: 1 },
  })
  assert.deepEqual(low.warnings, [])
  assert.equal(low.config.autoArchive.idleDays, 1)
  assert.equal(low.config.autoArchive.checkIntervalMinutes, 1)
  assert.equal(low.config.cacheCleanup.unusedDays, 1)
  assert.equal(low.config.limits.maxOperationsPerRun, 1)

  const high = normalizeConfig({
    autoArchive: { idleDays: 3650, checkIntervalMinutes: 1440 },
    cacheCleanup: { unusedDays: 3650 },
    limits: { maxOperationsPerRun: 500 },
  })
  assert.deepEqual(high.warnings, [])
  assert.equal(high.config.autoArchive.idleDays, 3650)
  assert.equal(high.config.autoArchive.checkIntervalMinutes, 1440)
  assert.equal(high.config.cacheCleanup.unusedDays, 3650)
  assert.equal(high.config.limits.maxOperationsPerRun, 500)
})

test('normalizeConfig 非对象组整体回退，raw 非对象也不崩', () => {
  const groupBad = normalizeConfig({ autoArchive: 'off', cacheCleanup: [] })
  assert.equal(groupBad.config.autoArchive.idleDays, 14)
  assert.equal(groupBad.config.cacheCleanup.unusedDays, 90)
  assert.equal(groupBad.warnings.length, 2)

  const notObject = normalizeConfig([1, 2, 3])
  assert.deepEqual(notObject.config, defaultConfig())
  assert.equal(notObject.warnings.length, 1)

  const versionBad = normalizeConfig({ version: 9 })
  assert.equal(versionBad.config.version, 1)
  assert.ok(versionBad.warnings.some((warning) => warning.includes('version')))
})

test('normalizeConfig 以 base 为深合并基底（API 局部更新语义）', () => {
  const base = { ...defaultConfig(), dryRun: true, autoArchive: { ...defaultConfig().autoArchive, idleDays: 3 } }
  const { config } = normalizeConfig({ cacheCleanup: { unusedDays: 30 } }, base)
  assert.equal(config.dryRun, true)
  assert.equal(config.autoArchive.idleDays, 3)
  assert.equal(config.cacheCleanup.unusedDays, 30)
})

test('loadConfig 缺失文件时创建默认 config.json', async (t) => {
  const { dataDir } = await makeTempDirs(t)
  const loaded = await loadConfig(dataDir)
  assert.equal(loaded.created, true)
  assert.equal(loaded.repaired, false)
  assert.deepEqual(loaded.warnings, [])
  assert.deepEqual(loaded.config, defaultConfig())
  const text = await readFile(path.join(dataDir, 'config.json'), 'utf8')
  assert.deepEqual(JSON.parse(text), defaultConfig())
  // 目录里没有残留临时文件
  const entries = await readdir(dataDir)
  assert.deepEqual(entries, ['config.json'])
})

test('loadConfig 部分字段坏值：回退默认值并给出 warning，文件不重写', async (t) => {
  const { dataDir } = await makeTempDirs(t)
  await mkdir(dataDir, { recursive: true })
  const original = { autoArchive: { idleDays: 'oops' }, dryRun: true }
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify(original), 'utf8')
  const loaded = await loadConfig(dataDir)
  assert.equal(loaded.created, false)
  assert.equal(loaded.repaired, false)
  assert.equal(loaded.config.autoArchive.idleDays, 14)
  assert.equal(loaded.config.dryRun, true)
  assert.ok(loaded.warnings.some((warning) => warning.includes('autoArchive.idleDays')))
  // 坏文件保留原样，等用户/后续保存再覆盖
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'))
  assert.deepEqual(onDisk, original)
})

test('loadConfig 坏 JSON：用默认配置修复并继续', async (t) => {
  const { dataDir } = await makeTempDirs(t)
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'config.json'), '{ not json', 'utf8')
  const loaded = await loadConfig(dataDir)
  assert.equal(loaded.repaired, true)
  assert.deepEqual(loaded.config, defaultConfig())
  assert.ok(loaded.warnings.length >= 1)
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'))
  assert.deepEqual(onDisk, defaultConfig())
})

test('saveConfig 校验后原子落盘且可再次读回', async (t) => {
  const { dataDir } = await makeTempDirs(t)
  const saved = await saveConfig(dataDir, {
    autoArchive: { idleDays: 3, enabled: false },
    protect: { sessionIds: ['a'] },
  })
  assert.equal(saved.warnings.length, 0)
  assert.equal(saved.config.autoArchive.idleDays, 3)
  assert.equal(saved.config.autoArchive.enabled, false)
  const loaded = await loadConfig(dataDir)
  assert.deepEqual(loaded.config, saved.config)
  assert.deepEqual(await readdir(dataDir), ['config.json'])
})

test('writeJsonAtomic 覆盖写不残留临时文件，readJsonFile 容错', async (t) => {
  const { root } = await makeTempDirs(t)
  const file = path.join(root, 'nested', 'dir', 'value.json')
  await writeJsonAtomic(file, { a: 1 })
  await writeJsonAtomic(file, { a: 2 })
  assert.deepEqual(await readJsonFile(file), { exists: true, value: { a: 2 } })
  const entries = await readdir(path.dirname(file))
  assert.deepEqual(entries, ['value.json'])

  assert.deepEqual(await readJsonFile(path.join(root, 'missing.json')), { exists: false })
  await writeFile(path.join(root, 'bad.json'), 'not-json', 'utf8')
  const bad = await readJsonFile(path.join(root, 'bad.json'))
  assert.equal(bad.exists, true)
  assert.ok(bad.parseError instanceof Error)
})

test('路径解析：DSH_AUTO_ARCHIVE_DIR > <DSH_HOME>/auto-archive；DSH_HOME 覆盖变量优先', () => {
  const env = {
    DSH_HOME: 'C:\\Users\\x\\.dsh',
    DSH_AUTO_ARCHIVE_DSH_HOME: 'D:\\tmp\\home',
    DSH_AUTO_ARCHIVE_DIR: 'D:\\tmp\\data',
  }
  assert.equal(resolveDshHome(env), path.resolve('D:\\tmp\\home'))
  assert.equal(resolveDataDir(env), path.resolve('D:\\tmp\\data'))
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\Users\\x\\.dsh' }), path.resolve('C:\\Users\\x\\.dsh'))
  assert.equal(resolveDataDir({ DSH_HOME: 'C:\\Users\\x\\.dsh' }), path.join(path.resolve('C:\\Users\\x\\.dsh'), 'auto-archive'))
  assert.ok(resolveDshHome({}).endsWith(path.join('.dsh')))
})

test('cloneConfig 返回深拷贝', () => {
  const source = defaultConfig()
  const copy = cloneConfig(source)
  copy.autoArchive.idleDays = 99
  copy.protect.sessionIds.push('x')
  assert.equal(source.autoArchive.idleDays, 14)
  assert.deepEqual(source.protect.sessionIds, [])
})
