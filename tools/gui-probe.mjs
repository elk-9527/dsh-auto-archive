#!/usr/bin/env node
/**
 * gui-probe.mjs —— 用真实 Chromium（Edge/Chrome headless）打开一个 DSH web 页面，
 * 通过 CDP 观察 client 模块是否真的被浏览器加载/注册，并收集控制台错误。
 *
 * 用途：验证 dsh-auto-archive/client.js 在真实 ModuleLoader 下能否加载（单测只模拟了 loader 协议）。
 * 只读：不点击、不改数据；仅 Page.navigate + Runtime.evaluate 只读探测。
 *
 * 用法：node tools/gui-probe.mjs "http://127.0.0.1:2007/?token=..."
 * 先用 scripts/e2e-scratch.mjs 起一个 scratch web（见 docs/install.md）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9333
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const PLUGIN_ID = 'dsh-auto-archive'

function findBrowser() {
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return candidate
  throw new Error('找不到 Edge/Chrome 可执行文件')
}

async function cdpTargets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(250)
  }
  throw new Error('CDP 端点没有在 15s 内就绪')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined) {
      const waiter = pending.get(msg.id)
      if (waiter) {
        pending.delete(msg.id)
        if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
        else waiter.resolve(msg.result)
      }
    } else {
      events.push(msg)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(new Error('CDP websocket error: ' + String(e && e.message))))
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { ready, send, events, close: () => ws.close() }
}

function textOf(result) {
  if (!result) return ''
  if (result.unserializableValue) return result.unserializableValue
  if (result.value !== undefined) return typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
  if (result.description) return result.description
  return ''
}

async function main() {
  const url = process.argv[2]
  if (!url) {
    console.error('用法：node tools/gui-probe.mjs "<dsh web url with token>"')
    process.exitCode = 2
    return
  }
  const browser = findBrowser()
  const profileDir = path.join(os.tmpdir(), `dsh-gui-probe-${process.pid}`)
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1400,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  try {
    const target = await cdpTargets()
    const cdp = connect(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.navigate', { url })
    await sleep(9000) // 等 boot graph 全部 client bundle 加载 + 激活
    const evaluate = async (expression) => {
      const probe = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
      return textOf(probe.result)
    }
    // 自检：页面 console 事件是否真的被采集到（如果这行都没进 consoleAll，说明采集链路有问题）
    await evaluate(`console.log('probe-console-selftest')`)
    // 只读探测：bundle 请求、ModuleLoader 状态、插件 apply 注入的样式元素（apply 真跑过才有）
    const before = JSON.parse(
      await evaluate(`(() => {
        const loader = window.__ModuleLoader__;
        const resources = performance.getEntriesByType('resource').map((r) => r.name);
        const ours = resources.filter((n) => n.includes('${PLUGIN_ID}'));
        return JSON.stringify({
          title: document.title,
          hasLoader: !!loader,
          loaderMode: loader ? loader.mode : null,
          loaderApi: loader ? Object.keys(loader) : [],
          pluginResourceCount: ours.length,
          pluginResources: ours,
          styleInjected: !!document.querySelector('style[data-plugin="${PLUGIN_ID}"]'),
          debug: globalThis.__dshAutoArchiveDebug ?? null,
          uiButtons: [...document.querySelectorAll('button,[role="button"],[aria-label],[title]')]
            .map((el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim())
            .filter((t) => t && t.length < 30)
            .slice(0, 60),
          bodyText: (document.body && document.body.innerText || '').slice(0, 300),
          clickable: [...document.querySelectorAll('button, [role="button"], [role="menuitem"], a')].map((el) => {
            const r = el.getBoundingClientRect();
            return { text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
          }).filter((b) => b.w > 0 && b.h > 0).slice(0, 80),
        });
      })()`),
    )
    // 交互：按文本定位元素矩形，再用真实鼠标事件点击（比 element.click() 更接近用户操作）
    const clickAt = async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    }
    const findText = async (labels) => {
      const raw = await evaluate(`(() => {
        const wanted = ${JSON.stringify(labels)};
        const nodes = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"], a, li, div, span')];
        const hit = nodes.find((el) => {
          const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          return wanted.includes(t);
        });
        if (!hit) return 'NOT_FOUND';
        const r = hit.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, text: (hit.innerText || '').trim() });
      })()`)
      if (raw === 'NOT_FOUND') return { found: false }
      return { found: true, ...JSON.parse(raw) }
    }
    const clickByText = async (labels) => {
      const hit = await findText(labels)
      if (!hit.found) return 'NOT_FOUND'
      await clickAt(hit.x, hit.y)
      return 'CLICKED:' + hit.text
    }
    // 关掉「预览版说明」引导弹窗（会挡住整页）
    const dismiss = await clickByText(['继续', 'Continue'])
    await sleep(600)
    // 兜底：JS click / 回车键
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const open = await evaluate(
        `(() => { const d = document.querySelector('[role="dialog"], [aria-modal="true"]'); return d ? (d.innerText || '').slice(0, 30) : ''; })()`,
      )
      if (!open) break
      if (attempt === 0) {
        await evaluate(
          `(() => { const b = [...document.querySelectorAll('button')].find((el) => (el.innerText || '').trim() === '继续'); if (b) { b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return 'dispatched'; } return 'no-button'; })()`,
        )
      } else {
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      }
      await sleep(700)
    }
    // 打开用户菜单：点头像 -> 设置。头像位置随窗口/昵称变化，这里按「左下角
    // 最近的可点元素」定位，避免依赖具体用户昵称。
    const userHit = JSON.parse(
      await evaluate(`(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pick = [...document.querySelectorAll('button,[role="button"],img,[class*="avatar"],[class*="Avatar"]')]
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width >= 14 && rect.height >= 14 && rect.left < vw * 0.24 && rect.top > vh * 0.8)
          .sort((a, b) => b.rect.top - a.rect.top);
        if (!pick.length) return JSON.stringify({ found: false });
        const rect = pick[0].rect;
        return JSON.stringify({ found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
      })()`),
    )
    if (userHit.found) await clickAt(userHit.x, userHit.y)
    await sleep(900)
    let settingsEntry = await clickByText(['设置', 'Settings', '偏好设置', 'Preferences', '设置…', 'Settings…'])
    await sleep(2600)
    if (settingsEntry === 'NOT_FOUND') {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: ',', code: 'Comma', windowsVirtualKeyCode: 188 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: ',', code: 'Comma', windowsVirtualKeyCode: 188 })
      await sleep(1500)
      settingsEntry = 'SHORTCUT_CTRL_COMMA'
    }
    const interaction = { dismiss, userMenu: userHit.found, settingsEntry }
    const afterSettings = JSON.parse(
      await evaluate(`(() => {
        const text = (document.body && document.body.innerText || '');
        const occurrences = (text.match(/自动归档/g) || []).length;
        const navCandidates = [...document.querySelectorAll('nav button, nav a, [role="tab"], [role="menuitem"], [role="dialog"] button, [role="dialog"] a')]
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((d) => ({
          label: d.getAttribute('aria-label') || '',
          text: (d.innerText || '').slice(0, 500),
        }));
        return JSON.stringify({ occurrences, navCandidates: navCandidates.slice(0, 80), dialogs, textTail: text.slice(-400), fullText: text });
      })()`),
    )
    const info = { ...before, ...interaction, ...afterSettings }
    // 点开我们自己的分区，验证面板真的渲染（标题/开关等文案出现）
    const ourSection = await clickByText(['自动归档'])
    await sleep(2200)
    const panel = JSON.parse(
      await evaluate(`(() => {
        const text = (document.body && document.body.innerText || '');
        return JSON.stringify({
          clicked: ${JSON.stringify(ourSection)},
          text: text.slice(-1600),
          hasSaveButton: /保存配置|保存|Save/.test(text),
          hasEnabledToggle: /启用自动归档|启用|Enable/.test(text),
        });
      })()`),
    )
    Object.assign(info, { panel })
    // 截图：看清设置页到底长什么样（导航在左栏还是图标栏、分区是否被折叠）。
    const shotPath = path.join(os.tmpdir(), 'dsh-gui-probe.png')
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      ;(await import('node:fs')).writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
      info.screenshot = shotPath
    } catch (error) {
      info.screenshot = 'failed: ' + String(error && error.message ? error.message : error)
    }
    const consoleErrors = []
    const consoleAll = []
    for (const event of cdp.events) {
      if (event.method === 'Runtime.consoleAPICalled') {
        const line = `[${event.params.type}] ` + event.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
        consoleAll.push(line)
        if (['error', 'warning', 'warn'].includes(event.params.type)) consoleErrors.push(line)
      }
      if (event.method === 'Runtime.exceptionThrown') {
        const d = event.params.exceptionDetails
        const line = `EXCEPTION: ${d.exception ? d.exception.description : d.text}`
        consoleErrors.push(line)
        consoleAll.push(line)
      }
      if (event.method === 'Log.entryAdded' && ['error', 'warning'].includes(event.params.entry.level)) {
        const line = `LOG ${event.params.entry.level}: ${event.params.entry.text}`
        consoleErrors.push(line)
        consoleAll.push(line)
      }
    }
    const relevant = consoleErrors.filter(
      (line) => /auto-archive|ModuleLoader|Failed|failed|error|Error/.test(line) && !/favicon/.test(line),
    )
    console.log(JSON.stringify({ ...info, consoleErrors: relevant.slice(0, 20), consoleAll: consoleAll.slice(0, 40) }, null, 2))
    const ok =
      info.hasLoader &&
      info.loaderMode === 'live' &&
      info.styleInjected === true &&
      info.pluginResourceCount > 0 &&
      relevant.length === 0
    if (!ok) {
      process.exitCode = 1
      console.error('\n⚠️ client bundle 未在真实浏览器里成功 apply（看上面 styleInjected / consoleErrors）')
    } else {
      console.log('\n✅ client bundle 已在真实浏览器中加载并 apply（样式已注入、无控制台错误）')
    }
    cdp.close()
  } finally {
    child.kill('SIGKILL')
    await sleep(300)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
