/**
 * 迷你 React —— 无浏览器渲染面板用的最小实现。
 *
 * 只做三件事：
 * 1. `createElement` 建树（和真 React 一样把 children 拍平、丢掉 null/false）
 * 2. hooks：`useState` 有真实状态、`useEffect` 在挂载后跑一次、`useCallback/useMemo/useRef` 有返回值
 * 3. `mount()`：渲染 → 跑 effect → 等一轮微任务 → 若状态变了再渲染，最多 6 轮
 *
 * 它**不是** React 的替代品（没有 diff、没有事件），只用于「这棵面板树在真实数据下会不会炸」
 * 和「关键文案有没有渲染出来」这类冒烟验证，以及 tools/preview-panel.mjs 的本地预览。
 */

export function createMiniReact() {
  const stores = new Map()
  let cursor = { key: '', index: 0 }
  let pendingEffects = []
  let dirty = false

  class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState(next) {
      this.state = { ...(this.state || {}), ...(typeof next === 'function' ? next(this.state || {}) : next) }
      dirty = true
    }
  }
  Component.prototype.isReactComponent = true

  const React = {
    Fragment: 'Fragment',
    Component,
    createElement(type, props, ...children) {
      const flat = []
      const push = value => {
        if (Array.isArray(value)) value.forEach(push)
        else if (value === null || value === undefined || value === false || value === true) return
        else flat.push(value)
      }
      children.forEach(push)
      const merged = { ...(props || {}) }
      if (flat.length === 1) merged.children = flat[0]
      else if (flat.length > 1) merged.children = flat
      return { type, props: merged }
    },
    useState(initial) {
      const key = cursor.key + '#' + cursor.index++
      if (!stores.has(key)) stores.set(key, typeof initial === 'function' ? initial() : initial)
      const set = value => {
        const current = stores.get(key)
        stores.set(key, typeof value === 'function' ? value(current) : value)
        dirty = true
      }
      return [stores.get(key), set]
    },
    useEffect(effect) {
      const key = 'effect:' + cursor.key + '#' + cursor.index++
      if (stores.has(key)) return
      stores.set(key, true)
      pendingEffects.push(effect)
    },
    useCallback(fn) { cursor.index++; return fn },
    useMemo(fn) { cursor.index++; return fn() },
    useRef(initial) {
      const key = 'ref:' + cursor.key + '#' + cursor.index++
      if (!stores.has(key)) stores.set(key, { current: initial })
      return stores.get(key)
    },
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function render(node, path) {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
    if (Array.isArray(node)) return node.map((child, index) => render(child, path + '.' + index)).join('')
    if (typeof node === 'function') {
      cursor = { key: path + ':' + (node.name || 'anon'), index: 0 }
      return render(node({}), path + '/' + (node.name || 'anon'))
    }
    if (typeof node !== 'object') return escapeHtml(node)

    const { type, props } = node
    if (typeof type === 'function') {
      const name = type.name || 'anon'
      cursor = { key: path + ':' + name, index: 0 }
      // class 组件（例如错误边界）：实例化后走 render()
      if (type.prototype && type.prototype.isReactComponent) {
        const instance = new type(props || {})
        if (instance.state === undefined) instance.state = {}
        return render(instance.render(), path + '/' + name)
      }
      return render(type(props || {}), path + '/' + name)
    }
    const children = props ? props.children : undefined
    if (type === 'Fragment') return render(children, path + '/f')

    // 预览用：把常用属性写进去，这样看截图能看出按钮/输入框/布局的差别
    let attrs = ''
    if (props && type !== 'style') {
      if (props.className) attrs += ' class="' + escapeHtml(props.className) + '"'
      if (props.style) {
        const style = Object.entries(props.style)
          .map(([key, value]) => key.replace(/[A-Z]/g, m => '-' + m.toLowerCase()) + ':' + value)
          .join(';')
        attrs += ' style="' + escapeHtml(style) + '"'
      }
      if (props.value !== undefined) attrs += ' value="' + escapeHtml(props.value) + '"'
      if (props.placeholder !== undefined) attrs += ' placeholder="' + escapeHtml(props.placeholder) + '"'
      if (props.title !== undefined) attrs += ' title="' + escapeHtml(props.title) + '"'
      if (props.disabled === true) attrs += ' disabled'
      if (type === 'option' && props.value !== undefined) attrs += ' value="' + escapeHtml(props.value) + '"'
    }
    const voidTags = ['input', 'br', 'hr', 'img']
    if (voidTags.includes(type)) return '<' + type + attrs + '>'
    return '<' + type + attrs + '>' + render(children, path + '/c') + '</' + type + '>'
  }

  return {
    React,
    /**
     * 渲染一棵树：渲染 → 跑 effect → 等微任务 → 需要就再来一轮。
     * @param {object} element
     * @returns {Promise<string>} HTML 字符串
     */
    async mount(element) {
      dirty = true
      let html = ''
      for (let pass = 0; pass < 6 && dirty; pass++) {
        dirty = false
        pendingEffects = []
        html = render(element, 'root')
        const effects = pendingEffects
        pendingEffects = []
        for (const effect of effects) {
          try { effect() } catch { /* 组件自身错误由面板兜住 */ }
        }
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      return html
    },
  }
}
