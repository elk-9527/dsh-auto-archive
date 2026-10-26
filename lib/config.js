/**
 * dsh-auto-archive —— 配置与数据文件层。
 *
 * 职责：
 * - 解析插件自有数据目录（`<DSH_HOME>/auto-archive/`，测试用 `DSH_AUTO_ARCHIVE_DIR` 覆盖）。
 * - config.json 的默认值 / 深合并 / 校验 / 容错读取 / 原子写入。
 * - 提供通用的 JSON 原子写与容错读工具（state.js 复用）。
 *
 * 设计约束（见 CONTRACT.md §3、§4）：
 * - 坏配置绝不让插件崩：缺文件 → 默认值并落盘；字段类型/范围非法 → 该字段回退默认值 + warning。
 * - 写入一律 tmp + rename，绝不写半截文件。
 * - 本模块不写 DSH 的 storages/sessions/attachments。
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CONFIG_VERSION = 1
export const CONFIG_FILENAME = 'config.json'
export const STATE_FILENAME = 'state.json'
export const DATA_DIR_ENV = 'DSH_AUTO_ARCHIVE_DIR'
/** e2e/测试专用：覆盖 DSH_HOME（默认取 DSH_HOME 或 ~/.dsh）。 */
export const DSH_HOME_ENV = 'DSH_AUTO_ARCHIVE_DSH_HOME'

const GROUP_KEYS = Object.freeze(['autoArchive', 'cacheCleanup', 'protect', 'limits'])

/** 数值字段 → 合法区间（闭合）。 */
export const NUMERIC_FIELDS = Object.freeze({
  'autoArchive.idleDays': Object.freeze({ min: 1, max: 3650 }),
  'autoArchive.checkIntervalMinutes': Object.freeze({ min: 1, max: 1440 }),
  'cacheCleanup.unusedDays': Object.freeze({ min: 1, max: 3650 }),
  'limits.maxOperationsPerRun': Object.freeze({ min: 1, max: 500 }),
})

export const BOOLEAN_FIELDS = Object.freeze([
  'autoArchive.enabled',
  'cacheCleanup.enabled',
  'protect.pinnedSessions',
  'dryRun',
])

export const ARRAY_FIELDS = Object.freeze(['protect.sessionIds', 'protect.workspaces'])

/** 默认配置（同时是「非法字段回退值」的唯一来源）。 */
export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  autoArchive: Object.freeze({ enabled: true, idleDays: 14, checkIntervalMinutes: 30 }),
  cacheCleanup: Object.freeze({ enabled: true, unusedDays: 90 }),
  protect: Object.freeze({
    pinnedSessions: true,
    sessionIds: Object.freeze([]),
    workspaces: Object.freeze([]),
  }),
  limits: Object.freeze({ maxOperationsPerRun: 50 }),
  dryRun: false,
})

/** @returns {boolean} */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item))
  if (isPlainObject(value)) {
    const copy = {}
    for (const [key, item] of Object.entries(value)) copy[key] = cloneValue(item)
    return copy
  }
  return value
}

/** 深拷贝一份默认配置（调用方可以随便改）。 */
export function defaultConfig() {
  return cloneValue(DEFAULT_CONFIG)
}

export function cloneConfig(config) {
  return cloneValue(isPlainObject(config) ? config : DEFAULT_CONFIG)
}

function getPath(source, parts) {
  let cursor = source
  for (const part of parts) {
    if (!isPlainObject(cursor) || !(part in cursor)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

function setPath(target, parts, value) {
  let cursor = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (!isPlainObject(cursor[part])) cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts[parts.length - 1]] = value
}

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
  try {
    const text = JSON.stringify(value)
    if (typeof text === 'string') return text.length > 60 ? `${text.slice(0, 60)}…` : text
  } catch {
    /* fallthrough */
  }
  return String(value)
}

function validateField(field, value) {
  const numeric = NUMERIC_FIELDS[field]
  if (numeric !== undefined) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < numeric.min || value > numeric.max) {
      return { ok: false, reason: `需要 ${numeric.min}-${numeric.max} 的整数，收到 ${formatValue(value)}` }
    }
    return { ok: true, value }
  }
  if (BOOLEAN_FIELDS.includes(field)) {
    if (typeof value !== 'boolean') return { ok: false, reason: `需要 true/false，收到 ${formatValue(value)}` }
    return { ok: true, value }
  }
  if (ARRAY_FIELDS.includes(field)) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      return { ok: false, reason: '需要字符串数组' }
    }
    return { ok: true, value: [...value] }
  }
  return { ok: false, reason: `未知配置项 ${field}` }
}

/**
 * 深合并 + 校验一份可能不完整/含坏值的配置。
 *
 * @param {unknown} raw 读取到或 API 传入的原始配置。
 * @param {object} [base] 深合并基底（默认配置；API 局部更新时传当前配置）。
 * @returns {{config: object, warnings: string[]}} 一定返回一份完整合法配置。
 */
export function normalizeConfig(raw, base = DEFAULT_CONFIG) {
  const warnings = []
  const config = cloneConfig(base)
  config.version = CONFIG_VERSION
  if (raw === undefined || raw === null) return { config, warnings }
  if (!isPlainObject(raw)) {
    warnings.push(`配置必须是 JSON 对象，已忽略（收到 ${formatValue(raw)}）`)
    return { config, warnings }
  }

  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    warnings.push(`配置 version 非法（收到 ${formatValue(raw.version)}），已按 version ${CONFIG_VERSION} 处理`)
  }

  for (const group of GROUP_KEYS) {
    if (raw[group] === undefined) continue
    if (!isPlainObject(raw[group])) {
      warnings.push(`配置项 ${group} 必须是对象（收到 ${formatValue(raw[group])}），已整体回退默认值`)
      config[group] = cloneValue(DEFAULT_CONFIG[group])
    }
  }

  const fields = [...Object.keys(NUMERIC_FIELDS), ...BOOLEAN_FIELDS, ...ARRAY_FIELDS]
  for (const field of fields) {
    const parts = field.split('.')
    const incoming = getPath(raw, parts)
    if (incoming === undefined) continue
    const checked = validateField(field, incoming)
    if (checked.ok) {
      setPath(config, parts, checked.value)
      continue
    }
    const fallback = getPath(DEFAULT_CONFIG, parts)
    warnings.push(`配置项 ${field} 非法（${checked.reason}），已回退默认值 ${formatValue(fallback)}`)
    setPath(config, parts, cloneValue(fallback))
  }

  return { config, warnings }
}

/** `<DSH_HOME>`：优先测试覆盖变量，其次 DSH_HOME，最后 ~/.dsh。 */
export function resolveDshHome(env = process.env) {
  for (const key of [DSH_HOME_ENV, 'DSH_HOME']) {
    const value = env?.[key]
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value.trim())
  }
  return path.join(os.homedir(), '.dsh')
}

/** 插件数据目录：`DSH_AUTO_ARCHIVE_DIR` 覆盖，否则 `<DSH_HOME>/auto-archive`。 */
export function resolveDataDir(env = process.env) {
  const override = env?.[DATA_DIR_ENV]
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  return path.join(resolveDshHome(env), 'auto-archive')
}

export function configPath(dataDir) {
  return path.join(dataDir, CONFIG_FILENAME)
}

export function statePath(dataDir) {
  return path.join(dataDir, STATE_FILENAME)
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

let tmpSequence = 0

/**
 * 原子写 JSON：同目录写临时文件，然后 rename 覆盖。
 * Windows 上 rename 覆盖偶尔被占用进程短暂阻塞，做有限次重试。
 */
export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  tmpSequence = (tmpSequence + 1) % 1_000_000
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${tmpSequence.toString(36)}`
  const text = `${JSON.stringify(value, null, 2)}\n`
  await fsp.writeFile(tmp, text, 'utf8')
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (error) {
      lastError = error
      const code = error?.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      await delay(15 * (attempt + 1))
    }
  }
  try {
    await fsp.rm(tmp, { force: true })
  } catch {
    /* 清理失败不掩盖原错误 */
  }
  throw lastError
}

/**
 * 容错读取 JSON。
 * @returns {Promise<{exists: boolean, value?: unknown, readError?: Error, parseError?: Error}>}
 */
export async function readJsonFile(file) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    return { exists: false, readError: error }
  }
  try {
    return { exists: true, value: JSON.parse(text) }
  } catch (error) {
    return { exists: true, parseError: error }
  }
}

/**
 * 读取配置；缺失则创建默认配置并落盘，坏 JSON 则用默认配置重写并给出 warning。
 * 永不抛错（写失败也只是 warning）。
 *
 * @param {string} dataDir
 * @returns {Promise<{config: object, warnings: string[], created: boolean, repaired: boolean, path: string}>}
 */
export async function loadConfig(dataDir) {
  const file = configPath(dataDir)
  const warnings = []
  const read = await readJsonFile(file)

  if (!read.exists && read.readError === undefined) {
    const config = defaultConfig()
    try {
      await writeJsonAtomic(file, config)
      return { config, warnings, created: true, repaired: false, path: file }
    } catch (error) {
      warnings.push(`创建默认 config.json 失败：${describeError(error)}（本次使用内存默认配置）`)
      return { config, warnings, created: false, repaired: false, path: file }
    }
  }

  if (read.readError !== undefined) {
    warnings.push(`读取 config.json 失败：${describeError(read.readError)}（本次使用默认配置，未覆盖原文件）`)
    return { config: defaultConfig(), warnings, created: false, repaired: false, path: file }
  }

  if (read.parseError !== undefined) {
    warnings.push(`config.json 不是合法 JSON：${describeError(read.parseError)}（已用默认配置覆盖）`)
    const config = defaultConfig()
    try {
      await writeJsonAtomic(file, config)
    } catch (error) {
      warnings.push(`重写 config.json 失败：${describeError(error)}（本次使用内存默认配置）`)
    }
    return { config, warnings, created: false, repaired: true, path: file }
  }

  const { config, warnings: fieldWarnings } = normalizeConfig(read.value)
  warnings.push(...fieldWarnings)
  return { config, warnings, created: false, repaired: false, path: file }
}

/**
 * 校验并落盘配置。
 * @throws 写入失败时抛出（调用方决定如何响应）。
 */
export async function saveConfig(dataDir, rawConfig) {
  const { config, warnings } = normalizeConfig(rawConfig)
  await writeJsonAtomic(configPath(dataDir), config)
  return { config, warnings }
}

export function describeError(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
