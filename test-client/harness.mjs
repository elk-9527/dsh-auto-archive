/**
 * test-client/harness.mjs
 *
 * C 角色测试夹具：在纯 Node 环境里加载「无构建、手写 ModuleLoader」的
 * plugin/client.js，并给它一套最小但够用的伪浏览器环境：
 *
 *   - createDocumentStub()  极简 document（head/appendChild/removeChild/style 节点）
 *   - createReactStub()     最小 React 桩（createElement + hooks + mount/settle/act）
 *   - createFetchStub()     记录调用、可编程返回的 fetch 桩（不访问网络）
 *   - loadClient()          用 new Function 注入桩执行 bundle，捕获 load() 规格并
 *                           用假 require 求值 factory，得到 { spec, exports, ... }
 *
 * 设计取向：宁可桩简单透明，也不去模拟真实 React 的调度。settle() 用一个
 * 确定性循环把「渲染 → effect → 微任务 → 再渲染」跑到不动点，足以覆盖
 * Panel 的异步加载链路，同时让测试保持同步可读。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as nextTurn } from 'node:timers/promises'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const CLIENT_PATH = path.join(HERE, '..', 'client.js')
export const PLUGIN_ID = 'dsh-auto-archive'

// ---------------------------------------------------------------------------
// document 桩
// ---------------------------------------------------------------------------

function createElementNode(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    attributes: Object.create(null),
    children: [],
    parentNode: null,
    textContent: '',
    setAttribute(name, value) {
      node.attributes[String(name)] = String(value)
    },
    getAttribute(name) {
      const key = String(name)
      return Object.prototype.hasOwnProperty.call(node.attributes, key) ? node.attributes[key] : null
    },
    removeAttribute(name) {
      delete node.attributes[String(name)]
    },
    appendChild(child) {
      if (!child || typeof child !== 'object') throw new TypeError('appendChild 需要一个节点')
      if (child.parentNode) child.parentNode.removeChild(child)
      node.children.push(child)
      child.parentNode = node
      return child
    },
    removeChild(child) {
      const index = node.children.indexOf(child)
      if (index < 0) throw new Error('removeChild: 节点不在父节点中')
      node.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node)
    },
    querySelectorAll() {
      return []
    },
  }
  return node
}

/** 极简 document：够 client.js 的 createOwnedStyle / removeNode 用。 */
export function createDocumentStub() {
  const head = createElementNode('head')
  const body = createElementNode('body')
  const documentElement = createElementNode('html')
  documentElement.appendChild(head)
  documentElement.appendChild(body)
  return {
    head,
    body,
    documentElement,
    createElement(tagName) {
      return createElementNode(tagName)
    },
  }
}

/** 取出 document.head 下所有 <style> 节点（按注入顺序）。 */
export function styleTagsOf(documentStub) {
  if (!documentStub || !documentStub.head) return []
  return documentStub.head.children.filter((node) => node.tagName === 'STYLE')
}

// ---------------------------------------------------------------------------
// React 桩
// ---------------------------------------------------------------------------

const ELEMENT_MARK = '$aaElement'

function isElement(value) {
  return !!(value && typeof value === 'object' && value[ELEMENT_MARK] === true)
}

function flattenChildren(input, out) {
  if (Array.isArray(input)) {
    for (const child of input) flattenChildren(child, out)
    return out
  }
  if (input === null || input === undefined || input === false || input === true) return out
  out.push(input)
  return out
}

function depsChanged(previous, next) {
  if (!previous || !next) return true
  if (previous.length !== next.length) return true
  for (let index = 0; index < previous.length; index += 1) {
    if (!Object.is(previous[index], next[index])) return true
  }
  return false
}

/**
 * 最小 React 桩。返回 { React, mount }：
 *   - createElement 产出普通对象 { $aaElement, type, props }
 *   - useState / useRef / useEffect 绑定到当前渲染实例
 *   - mount(componentOrElement, props) 返回可操作的 app 句柄
 */
export function createReactStub() {
  const runtime = { current: null, renders: 0 }

  function currentInstance(hookName) {
    if (!runtime.current) throw new Error(hookName + '() 只能在渲染期间调用')
    return runtime.current
  }

  function createElement(type, props, ...children) {
    const nextProps = props && typeof props === 'object' ? Object.assign({}, props) : {}
    const flat = flattenChildren(children, [])
    if (flat.length === 1) nextProps.children = flat[0]
    else if (flat.length > 1) nextProps.children = flat
    return { [ELEMENT_MARK]: true, type: type, props: nextProps }
  }

  const React = {
    createElement: createElement,
    Fragment: Symbol.for('aa.Fragment'),
    useState(initial) {
      const instance = currentInstance('useState')
      const index = instance.cursor
      instance.cursor += 1
      if (index >= instance.hooks.length) {
        instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        if (instance.unmounted) return
        const previous = instance.hooks[index]
        const value = typeof next === 'function' ? next(previous) : next
        if (!Object.is(value, previous)) {
          instance.hooks[index] = value
          instance.dirty = true
        }
      }
      return [instance.hooks[index], setState]
    },
    useEffect(effect, deps) {
      const instance = currentInstance('useEffect')
      const index = instance.cursor
      instance.cursor += 1
      instance.effectCalls[index] = {
        effect: effect,
        deps: Array.isArray(deps) ? deps.slice() : null,
      }
    },
    useRef(initial) {
      const instance = currentInstance('useRef')
      const index = instance.cursor
      instance.cursor += 1
      if (!(index in instance.refs)) instance.refs[index] = { current: initial }
      return instance.refs[index]
    },
    useMemo(compute) {
      currentInstance('useMemo')
      if (typeof compute !== 'function') throw new TypeError('useMemo 需要一个函数')
      return compute()
    },
    useCallback(callback) {
      currentInstance('useCallback')
      return callback
    },
  }

  function createInstance(render) {
    return {
      render: render,
      cursor: 0,
      hooks: [],
      refs: [],
      effectCalls: [],
      effectDeps: [],
      cleanups: [],
      pendingEffects: [],
      dirty: true,
      unmounted: false,
      tree: null,
      error: null,
    }
  }

  function renderInstance(instance) {
    runtime.current = instance
    instance.cursor = 0
    instance.effectCalls = []
    let tree
    try {
      tree = instance.render()
    } finally {
      runtime.current = null
    }
    runtime.renders += 1
    instance.tree = tree
    instance.dirty = false
    for (let index = 0; index < instance.effectCalls.length; index += 1) {
      const call = instance.effectCalls[index]
      if (!call || typeof call.effect !== 'function') continue
      const previous = instance.effectDeps[index]
      if (!previous || depsChanged(previous, call.deps)) {
        instance.pendingEffects.push({ index: index, effect: call.effect, deps: call.deps })
      }
    }
  }

  function runPendingEffects(instance) {
    const pending = instance.pendingEffects
    instance.pendingEffects = []
    for (const item of pending) {
      const previousCleanup = instance.cleanups[item.index]
      if (typeof previousCleanup === 'function') {
        try {
          previousCleanup()
        } catch (error) {
          instance.error = error
        }
      }
      const cleanup = item.effect()
      instance.cleanups[item.index] = typeof cleanup === 'function' ? cleanup : null
      instance.effectDeps[item.index] = item.deps
    }
  }

  async function settle(instance, maxRounds = 80) {
    for (let round = 0; round < maxRounds; round += 1) {
      if (instance.unmounted) return
      if (instance.dirty) renderInstance(instance)
      if (instance.pendingEffects.length) {
        runPendingEffects(instance)
        continue
      }
      await nextTurn()
      if (!instance.dirty && instance.pendingEffects.length === 0) {
        await nextTurn()
        if (!instance.dirty && instance.pendingEffects.length === 0) return
      }
    }
    throw new Error('mount 在 ' + maxRounds + ' 轮内没有稳定（可能有死循环的 effect/setState）')
  }

  function mount(componentOrElement, props) {
    const instance = createInstance(() => {
      if (isElement(componentOrElement)) {
        const element = componentOrElement
        return typeof element.type === 'function' ? element.type(element.props || {}) : element
      }
      if (typeof componentOrElement !== 'function') throw new TypeError('mount 需要组件函数或元素')
      return componentOrElement(props || {})
    })

    const app = {
      React: React,
      instance: instance,
      get tree() {
        return instance.tree
      },
      get renders() {
        return runtime.renders
      },
      get unmounted() {
        return instance.unmounted
      },
      async settle() {
        await settle(instance)
        return app
      },
      async act(run) {
        if (typeof run !== 'function') {
          await settle(instance)
          return undefined
        }
        const value = await run()
        await settle(instance)
        return value
      },
      /** 跑 effect 清理函数（React 卸载语义）。 */
      unmount() {
        if (instance.unmounted) return
        instance.unmounted = true
        const indexes = Object.keys(instance.cleanups)
        for (const key of indexes) {
          const cleanup = instance.cleanups[key]
          if (typeof cleanup === 'function') {
            try {
              cleanup()
            } catch (error) {
              instance.error = error
            }
          }
        }
        instance.cleanups = []
      },
      text() {
        return textOf(instance.tree)
      },
      findAll(predicate) {
        return findAllElements(instance.tree).filter(predicate || (() => true))
      },
      findByTestId(testId) {
        return findTestId(instance.tree, testId)
      },
      findAllByTestId(testId) {
        return findAllElements(instance.tree).filter((element) => {
          return element.props && element.props['data-testid'] === testId
        })
      },
      /** 点击 data-testid 命中的元素（调用它的 onClick）。 */
      async click(testId) {
        const target = requireTestId(instance.tree, testId)
        const handler = target.props.onClick
        if (typeof handler !== 'function') throw new Error('元素 ' + testId + ' 没有 onClick')
        await app.act(() => handler(createEvent()))
      },
      /** 修改 data-testid 命中的受控输入（调用它的 onChange）。 */
      async change(testId, value) {
        const target = requireTestId(instance.tree, testId)
        const handler = target.props.onChange
        if (typeof handler !== 'function') throw new Error('元素 ' + testId + ' 没有 onChange')
        await app.act(() => handler(createEvent({ value: value, checked: value === true })))
      },
    }

    renderInstance(instance)
    return app
  }

  return { React: React, mount: mount }
}

function createEvent(overrides) {
  const target = Object.assign({ value: '', checked: false }, overrides || {})
  return {
    target: target,
    currentTarget: target,
    preventDefault() {},
    stopPropagation() {},
  }
}

function requireTestId(tree, testId) {
  const element = findTestId(tree, testId)
  if (!element) throw new Error('找不到 data-testid=' + testId + ' 的元素')
  return element
}

function findTestId(tree, testId) {
  const found = findAllElements(tree).filter((element) => {
    return element.props && element.props['data-testid'] === testId
  })
  return found.length ? found[0] : null
}

function findAllElements(tree, out = []) {
  if (!tree) return out
  if (Array.isArray(tree)) {
    for (const item of tree) findAllElements(item, out)
    return out
  }
  if (isElement(tree)) {
    out.push(tree)
    findAllElements(tree.props ? tree.props.children : null, out)
  }
  return out
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    const parts = []
    for (const child of node) {
      const text = textOf(child)
      if (text) parts.push(text)
    }
    return parts.join(' ')
  }
  if (isElement(node)) return textOf(node.props ? node.props.children : null)
  return ''
}

// ---------------------------------------------------------------------------
// fetch 桩
// ---------------------------------------------------------------------------

/**
 * 可编程 fetch 桩。
 *
 * handler(call) 返回（或 resolve 为）：
 *   - { json: any }                     200 响应，res.json() 返回 json
 *   - { status, ok, json }              自定义状态码
 *   - { invalidJson: true }             res.json() 抛 SyntaxError
 *   - { reject: string | Error }        fetch 本身 reject（网络错误）
 * 省略 handler 时统一返回 { ok: true }。
 */
export function createFetchStub(handler) {
  const calls = []

  async function fetchStub(url, init) {
    const requestInit = init && typeof init === 'object' ? init : null
    const call = {
      url: String(url),
      method: (requestInit && requestInit.method) || 'GET',
      headers: (requestInit && requestInit.headers) || {},
      rawBody: requestInit && typeof requestInit.body === 'string' ? requestInit.body : null,
      body: null,
      init: requestInit,
    }
    if (call.rawBody !== null) {
      try {
        call.body = JSON.parse(call.rawBody)
      } catch (error) {
        call.body = { $unparsed: call.rawBody }
      }
    }
    calls.push(call)

    const spec = typeof handler === 'function' ? await handler(call) : { json: { ok: true } }
    if (!spec) throw new Error('fetch 桩没有为 ' + call.url + ' 提供响应')
    if (spec.reject) throw (spec.reject instanceof Error ? spec.reject : new Error(String(spec.reject)))
    const status = spec.status === undefined ? 200 : spec.status
    const ok = spec.ok === undefined ? status >= 200 && status < 300 : spec.ok === true
    return {
      ok: ok,
      status: status,
      async json() {
        if (spec.invalidJson) throw new SyntaxError('Unexpected token < in JSON at position 0')
        if (!('json' in spec)) return {}
        return typeof spec.json === 'function' ? spec.json(call) : spec.json
      },
    }
  }

  return {
    fetch: fetchStub,
    calls: calls,
    get count() {
      return calls.length
    },
    paths() {
      return calls.map((call) => call.url)
    },
    /** 取最后一次命中 path 片段的调用。 */
    lastCall(pathFragment) {
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        if (calls[index].url.indexOf(pathFragment) >= 0) return calls[index]
      }
      return null
    },
    callsTo(pathFragment) {
      return calls.filter((call) => call.url.indexOf(pathFragment) >= 0)
    },
  }
}

// ---------------------------------------------------------------------------
// bundle 加载
// ---------------------------------------------------------------------------

/**
 * 加载 plugin/client.js（不执行任何真实网络 I/O）。
 *
 * options:
 *   fetch            自定义 fetch 桩（默认 createFetchStub(options.handler)）
 *   handler          fetch 桩的路由函数
 *   documentStub     自定义 document（传 null 模拟没有 document）
 *   console          自定义 console
 *   setInterval / clearInterval / setTimeout / clearTimeout  自定义计时器（便于 spy）
 */
export function loadClient(options = {}) {
  const code = fs.readFileSync(options.path || CLIENT_PATH, 'utf8')
  const react = createReactStub()
  const documentStub = Object.prototype.hasOwnProperty.call(options, 'documentStub')
    ? options.documentStub
    : createDocumentStub()
  const fetchStub = options.fetch || createFetchStub(options.handler)
  const consoleStub = options.console || {
    log() {},
    info() {},
    warn() {},
    error() {},
    debug() {},
  }

  const loadCalls = []
  const windowStub = {
    __ModuleLoader__: {
      load(spec) {
        loadCalls.push(spec)
      },
    },
  }

  const timers = {
    setInterval: options.setInterval || ((...args) => setInterval(...args)),
    clearInterval: options.clearInterval || ((...args) => clearInterval(...args)),
    setTimeout: options.setTimeout || ((...args) => setTimeout(...args)),
    clearTimeout: options.clearTimeout || ((...args) => clearTimeout(...args)),
  }

  const compile = new Function(
    'window',
    'document',
    'fetch',
    'console',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    code,
  )
  compile(
    windowStub,
    documentStub,
    fetchStub.fetch || fetchStub,
    consoleStub,
    timers.setTimeout,
    timers.clearTimeout,
    timers.setInterval,
    timers.clearInterval,
  )

  if (loadCalls.length !== 1) {
    throw new Error('client.js 应当恰好调用一次 window.__ModuleLoader__.load，实际 ' + loadCalls.length + ' 次')
  }
  const spec = loadCalls[0]
  if (!spec || typeof spec !== 'object') throw new Error('ModuleLoader.load 收到的规格不是对象')
  if (typeof spec.factory !== 'function') throw new Error('ModuleLoader.load 规格缺少 factory 函数')

  const requireCalls = []
  const requireStub = (name) => {
    requireCalls.push(name)
    if (name === 'react') return react.React
    throw new Error('client.js 请求了未预期的模块：' + name)
  }

  const exports = spec.factory(requireStub)

  return {
    spec: spec,
    exports: exports,
    react: react.React,
    mount: react.mount,
    window: windowStub,
    document: documentStub,
    fetchStub: fetchStub,
    requireCalls: requireCalls,
    consoleStub: consoleStub,
  }
}

/**
 * 用假 ctx 调 apply()，拿到注册的 settings.section，然后挂载面板。
 * 返回 { app, meta, element, render, ctx, slots }。
 */
export function mountPanel(client, options = {}) {
  const registrations = []
  const injections = []
  const effects = []
  const slots = {
    inject(name, factory) {
      injections.push(name)
      if (typeof factory === 'function') return factory()
      return undefined
    },
    register(meta, render) {
      const registration = { meta: meta, render: render }
      registrations.push(registration)
      return {
        id: meta && meta.id,
        dispose() {},
      }
    },
  }
  const ctx = {
    get(name) {
      return name === 'slots' ? slots : undefined
    },
    effect(run) {
      effects.push(run)
      if (typeof run === 'function') return run()
      return undefined
    },
  }

  client.exports.apply(ctx)
  const registration = registrations[0]
  if (!registration) throw new Error('apply() 没有注册 settings.section')
  const element = registration.render()
  // 不在这里 settle：调用方需要先断言「挂载但未跑 effect 时没有发请求」。
  const app = client.mount(element.type, element.props || {})
  return {
    app: app,
    meta: registration.meta,
    render: registration.render,
    element: element,
    ctx: ctx,
    slots: slots,
    registrations: registrations,
    injections: injections,
    effects: effects,
  }
}
