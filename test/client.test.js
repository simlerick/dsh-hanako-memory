/**
 * client bundle 契约测试。
 *
 * 这类测试的意义：上次 UI 半身用的是错误的导出形态
 * （`module.exports = function`），宿主根本不认，但不报错 —— 静默失效。
 * 所以必须用测试把契约钉死：
 *
 * 1. 必须通过 `window.__ModuleLoader__.load({ id, factory })` 注册
 * 2. factory 返回对象必须含 `name` / `inject` / `apply`
 * 3. `apply()` 必须在 `settings.plugins.tab` 上注册
 * 4. 缺 slots 时 `apply()` 只告警，不抛错（应用其余部分不受影响）
 * 5. 挂载过程抛错时必须被吞掉并打日志（不能让设置页炸掉整个 UI）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 最小 React 替身：mount 阶段不会真正渲染，只需要 createElement 存在。 */
function fakeReact() {
  class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
  }
  Component.prototype.isReactComponent = true
  return {
    Component,
    createElement: () => null,
    Fragment: 'Fragment',
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useMemo: fn => fn(),
  }
}

/**
 * 载入 client bundle 并拿到 factory。
 * client.js 顶层只引用 `window`，所以注入一个假 window 即可。
 */
async function loadClient() {
  const captured = []
  globalThis.window = {
    __ModuleLoader__: {
      load: spec => { captured.push(spec) },
    },
  }
  // 挂载成功会向 host 回报一次诊断（fetch 同源相对路径）；测试里给个空实现。
  globalThis.fetch = () => Promise.resolve({ ok: true, text: async () => '' })
  // 每次用不同的 query 绕过 ESM 缓存
  await import(`../client/client.js?t=${Date.now()}-${Math.random()}`)
  assert.equal(captured.length, 1, '必须恰好调用一次 __ModuleLoader__.load')
  return captured[0]
}

function fakeCtx() {
  const injected = []
  const registered = []
  return {
    injected,
    registered,
    ctx: {
      slots: {
        inject: (slotName, factory) => {
          injected.push(slotName)
          factory()
        },
        register: (registration, component) => {
          registered.push({ registration, component })
        },
      },
    },
  }
}

test('通过 __ModuleLoader__ 注册，且 id 与包名一致', async () => {
  const spec = await loadClient()
  assert.equal(typeof spec.id, 'string')
  assert.equal(spec.id, 'dsh-hanako-memory')
  assert.equal(typeof spec.factory, 'function', 'factory 必须是函数')
})

test('factory 返回 name / inject / apply', async () => {
  const spec = await loadClient()
  const mod = spec.factory(path => {
    if (path === 'react') return fakeReact()
    throw new Error(`unexpected require(${path})`)
  })
  assert.equal(typeof mod.name, 'string')
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
  assert.equal(typeof mod.apply, 'function')
})

test('inject 必须声明 slots 服务（否则 cordis 抛 without inject，入口全部静默消失）', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())
  assert.ok(mod.inject.includes('slots'), "client 插件必须 inject: ['slots']，否则 ctx.slots 取不到")
})

test('cordis 式拦截 ctx 下仍能注册全部入口', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())

  // 复刻 cordis 的拦截代理：服务没写进 inject，读属性就抛
  const injectedNames = []
  const slots = {
    inject: (name, factory) => { injectedNames.push(name); factory() },
    register: () => {},
  }
  const ctx = {}
  Object.defineProperty(ctx, 'slots', {
    get() {
      if (!mod.inject.includes('slots')) throw new Error('cannot get property "slots" without inject')
      return slots
    },
  })

  assert.doesNotThrow(() => mod.apply(ctx))
  assert.deepEqual(injectedNames.sort(), ['conversation.input.overlay', 'main', 'plugins.item', 'settings.plugins.tab', 'sidebar.panellist'])
})

test('apply 在 sidebar.panellist 注册图标 + main 注册同 key 面板', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())
  const { ctx, injected, registered } = fakeCtx()

  mod.apply(ctx)

  assert.deepEqual(injected.sort(), ['conversation.input.overlay', 'main', 'plugins.item', 'settings.plugins.tab', 'sidebar.panellist'])

  const icon = registered.find(r => r.registration.name === 'sidebar.panellist')
  const panel = registered.find(r => r.registration.name === 'main')
  assert.ok(icon, '必须有侧栏图标')
  assert.ok(panel, '必须有主面板')

  // 契约：panellist 的 id 必须等于 main 的 key，侧栏点击才能切过去
  assert.equal(icon.registration.id, 'hanako-memory')
  assert.equal(panel.registration.key, 'hanako-memory')
  assert.equal(icon.registration.id, panel.registration.key)

  assert.equal(typeof icon.component, 'function')
  assert.equal(typeof panel.component, 'function')
  assert.equal(icon.registration.label(), '助手与记忆')
})

test('图标组件只渲染图标，不渲染自己的按钮（宿主拥有按钮）', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())
  const { ctx, registered } = fakeCtx()
  mod.apply(ctx)
  const icon = registered.find(r => r.registration.name === 'sidebar.panellist')
  // fakeReact.createElement 返回 null，只验证调用形状：组件是函数且接受 ownerProps
  assert.equal(typeof icon.component, 'function')
  assert.equal(icon.component.length <= 1, true, '组件应只接收 props 对象')
})

test('不注册设置页/侧栏底部（用户明确要求）', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())
  const { ctx, injected } = fakeCtx()
  mod.apply(ctx)
  // settings.plugins.tab 作为诊断/后备入口是允许的；其余仍禁止
  for (const banned of ['settings.section', 'sidebar.footer.action', 'shell.overlay']) {
    assert.ok(!injected.includes(banned), `不得注册 ${banned}`)
  }
})

test('缺 slots 服务时只告警、不抛错（应用其余部分不受影响）', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    assert.doesNotThrow(() => mod.apply({}))
    assert.doesNotThrow(() => mod.apply({ slots: null }))
    assert.doesNotThrow(() => mod.apply({ slots: {} }))
  } finally {
    console.warn = originalWarn
  }
  assert.ok(warnings.length >= 1, '必须留下可诊断的告警')
})

test('slots.inject 抛错时 apply 不得把异常抛出去', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())

  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    assert.doesNotThrow(() => mod.apply({
      slots: {
        inject: () => { throw new Error('boom from host') },
        register: () => {},
      },
    }))
  } finally {
    console.error = originalError
  }
  assert.ok(errors.length >= 1, '必须记录挂载失败')
})

test('apply 可重复调用而不抛错（热重载安全）', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())
  const { ctx } = fakeCtx()
  assert.doesNotThrow(() => {
    mod.apply(ctx)
    mod.apply(ctx)
  })
})

test('文件里不出现被禁的默认导出/CJS 导出形态', async () => {
  const fs = await import('node:fs')
  const url = new URL('../client/client.js', import.meta.url)
  const source = fs.readFileSync(url, 'utf8')
  assert.ok(!/^\s*export\s+default/m.test(source), 'dsh 插件禁止 export default')
  assert.ok(!/^\s*module\.exports\s*=/m.test(source), 'client 必须走 __ModuleLoader__，不是 CJS 导出')
  assert.ok(source.includes('__ModuleLoader__.load'), '必须使用宿主提供的模块加载器')
})
