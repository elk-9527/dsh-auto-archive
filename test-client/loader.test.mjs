/**
 * loader.test.mjs
 * 覆盖 §9 的「可加载 / apply 注册 settings.section / 渲染不抛错」三条硬要求。
 * 全部使用桩环境，不触碰真实 DOM，也不发任何网络请求。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  loadClient,
  mountPanel,
  createDocumentStub,
  styleTagsOf,
  PLUGIN_ID,
} from './harness.mjs'

test('bundle 通过 __ModuleLoader__ 注册且 id 等于包名，导出 apply/inject', () => {
  const client = loadClient()

  assert.equal(client.spec.id, PLUGIN_ID)
  assert.equal(client.spec.id, 'dsh-auto-archive')
  assert.equal(typeof client.spec.factory, 'function')
  assert.equal(typeof client.exports.apply, 'function')
  assert.deepEqual(client.exports.inject, ['slots'])
  // 只允许 require('react')，不能偷偷依赖别的包。
  assert.deepEqual(client.requireCalls, ['react'])
})

test('加载与 apply 阶段不发起任何网络请求', () => {
  const client = loadClient()
  assert.equal(client.fetchStub.count, 0)

  mountPanel(client)
  // 挂载只会渲染一次（effect 未 settle），同样不该有请求。
  assert.equal(client.fetchStub.count, 0)
})

test('apply 注册 settings.section，元信息与约定完全一致', () => {
  const client = loadClient()
  const injections = []
  const registrations = []
  const slots = {
    inject(name, factory) {
      injections.push(name)
      return factory()
    },
    register(meta, render) {
      registrations.push({ meta, render })
      return { id: meta.id, dispose() {} }
    },
  }
  const effects = []
  const ctx = {
    get(name) {
      return name === 'slots' ? slots : undefined
    },
    effect(run) {
      effects.push(run)
    },
  }

  assert.doesNotThrow(() => client.exports.apply(ctx))

  assert.deepEqual(injections, ['settings.section'])
  assert.equal(registrations.length, 1)
  assert.deepEqual(registrations[0].meta, {
    name: 'settings.section',
    id: 'auto-archive',
    order: 60,
    label: '自动归档',
  })
  assert.equal(typeof registrations[0].render, 'function')

  const element = registrations[0].render()
  assert.equal(element.$aaElement, true)
  assert.equal(typeof element.type, 'function')
  assert.ok(element.props && element.props.ctx === ctx, 'Panel 应收到 ctx')
})

test('apply 注入带 data-plugin 归属的 <style>，并通过 ctx.effect 清理', () => {
  const documentStub = createDocumentStub()
  const client = loadClient({ documentStub })
  const disposers = []

  const ctx = {
    get() {
      return undefined
    },
    effect(run) {
      disposers.push(run)
    },
  }
  client.exports.apply(ctx)

  const styles = styleTagsOf(documentStub)
  assert.equal(styles.length, 1, '应恰好注入一份样式')
  assert.equal(styles[0].getAttribute('data-plugin'), 'dsh-auto-archive')
  assert.ok(styles[0].textContent.indexOf('.aa-panel') >= 0, '样式内容应包含面板类名')
  assert.ok(styles[0].textContent.indexOf('--dsw-alias-') >= 0, '样式应使用宿主 CSS 变量')

  assert.equal(disposers.length, 1, '应通过 ctx.effect 注册清理')
  const cleanup = disposers[0]()
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.equal(styleTagsOf(documentStub).length, 0, '清理后样式节点应被移除')
})

test('apply 在缺 slots / 缺 ctx / 缺 document 的宿主上静默降级、不抛错', () => {
  const client = loadClient({ documentStub: null })

  assert.doesNotThrow(() => client.exports.apply(undefined))
  assert.doesNotThrow(() => client.exports.apply(null))
  assert.doesNotThrow(() => client.exports.apply({}))
  assert.doesNotThrow(() => client.exports.apply({ get: () => undefined }))
  assert.doesNotThrow(() => client.exports.apply({ get: () => ({}) }))
  assert.doesNotThrow(() => client.exports.apply({
    get: () => ({ inject() {}, register() { return {} } }),
  }))
})

test('渲染函数可产出面板节点（桩 React 下不抛错）', () => {
  const client = loadClient()
  const mounted = mountPanel(client)
  const tree = mounted.app.tree

  assert.equal(tree.$aaElement, true)
  assert.equal(tree.props['data-testid'], 'aa-panel')

  // 首帧 loading 态可见、且未加载到状态时不渲染错误框。
  const text = mounted.app.text()
  assert.ok(text.indexOf('自动归档') >= 0)
  assert.ok(text.indexOf('正在加载状态') >= 0)
  assert.equal(mounted.app.findByTestId('aa-error'), null)
})

test('未注册 slots 时 apply 只注入样式（不产生注册副作用）', () => {
  const documentStub = createDocumentStub()
  const client = loadClient({ documentStub })
  const effects = []
  client.exports.apply({
    get: () => undefined,
    effect(run) {
      effects.push(run)
    },
  })

  assert.equal(styleTagsOf(documentStub).length, 1)
  assert.equal(effects.length, 1)
})
