/**
 * dsh-hanako-memory —— 浏览器半身（client bundle）。
 *
 * ## 契约（照抄 dshmarket / whale-girl / ui-schedule 的已验证写法）
 *
 * ```js
 * window.__ModuleLoader__.load({ id: '<package-name>', factory: (require) => {
 *   exports.name = ...
 *   exports.inject = ['slots']
 *   exports.apply = (ctx) => ...
 *   return module.exports
 * }})
 * ```
 *
 * **`inject` 必须含 `'slots'`**：Cordis 的 ctx 是拦截代理，服务没写进 inject
 * 时读 `ctx.slots` 会抛 `cannot get property "slots" without inject`，
 * 而 `apply()` 的 try/catch 会吞掉它 —— 症状是「包加载了、一个入口都没注册」。
 *
 * ## 用的是宿主原生组件
 *
 * 外壳的静态种子表（`PLATFORM_MODULES`，见 dsh-web-frontend 的 `rM()`）里有：
 * `react` / `react-dom` / `@deepseek-ai/cordis` / `dsh-client-store` /
 * `dsh-client-ui-slots` / **`dsh-client-ui-primitives`** / `dsh-client-ui-dockkit`。
 * 所以面板直接用 `ui-primitives` 的 Button / Input / SegmentedTabs / Pill / Tag /
 * StateDot / DisclosureRow / PathLabel / 图标 / relativeTime —— 和宿主设置页同一套观感，
 * 不需要在 `dsh.client.external` 里声明任何东西。
 * 拿不到 primitives 时（例如本地 Node 预览）会退化到内置的最小实现。
 *
 * ## 四个面板 tab + 一个输入框入口
 *
 * | 位置 | 槽位 | 内容 |
 * |---|---|---|
 * | 侧栏图标 🌸 | `sidebar.panellist` + `main` | 主面板：总览 / 助手 / 记忆 / 技能 |
 * | 设置 → 插件 | `settings.plugins.tab` | 同一个主面板（后备入口 + 诊断探针） |
 * | 输入框工具行 | `conversation.input.left` | 「技能」按钮：挑一个 skill 插到光标处 |
 *
 * 输入框那条用的是宿主 `inputActions`：`captureInsertion()` 拿游标快照，
 * `insertText(text, span)` 在光标处插入（`draftRev` 变了会返回 false，不会写坏草稿）。
 *
 * ## 失败隔离
 *
 * `apply()` 全程 try/catch。挂载失败只打日志 + 向 host 回报一次诊断，
 * 应用其余部分不受影响（宁可少一个面板，也不能让整个 Web UI 挂掉）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hanako-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const react = require('react')

    /** 面板版本（进 /hanako-memory/diag 的回报，用来确认页面执行的就是这版代码）。 */
    const UI_VERSION = 'agent-merge-v27'

    const name = 'hanako-memory'
    /** 必须声明 `slots`：否则 ctx.slots 抛 without inject，入口全部静默消失。 */
    const inject = ['slots']

    /* ───────────── 宿主原生组件（拿不到就退化） ───────────── */

    let primitivesError = ''

    function safeRequire(specifier) {
      try {
        return require(specifier)
      } catch (error) {
        primitivesError = specifier + ': ' + String((error && error.message) || error)
        return null
      }
    }

    const UI = safeRequire('@deepseek-ai/dsh-client-ui-primitives') || {}
    /** 是否用上了真·原生组件（诊断回报里带上，便于确认）。 */
    const usingPrimitives = UI.Button !== undefined && UI.SegmentedTabs !== undefined

    const h = react.createElement

    /* 退化实现：只在没有 primitives 的环境（Node 预览/测试）生效。 */

    function FallbackButton(props) {
      const { variant, size, icon, children, className, ...rest } = props || {}
      return h('button', {
        type: 'button',
        className: 'hk-fb hk-fb-' + (variant || 'ghost') + ' hk-fb-' + (size || 'md') + (className ? ' ' + className : ''),
        ...rest,
      }, icon || null, children)
    }

    function FallbackInput(props) {
      const { icon, className, ...rest } = props || {}
      return h('span', { className: 'hk-fb-input' + (className ? ' ' + className : '') },
        icon || null,
        h('input', rest))
    }

    function FallbackSegmentedTabs(props) {
      const { items = [], value, onChange, label } = props || {}
      return h('div', { className: 'hk-fb-tabs', role: 'tablist', 'aria-label': label },
        items.map(item => h('button', {
          key: item.value,
          type: 'button',
          role: 'tab',
          className: 'hk-fb-tab' + (item.value === value ? ' on' : ''),
          'aria-selected': item.value === value,
          onClick: () => onChange(item.value),
        }, item.label)))
    }

    function FallbackPill(props) {
      const { active, children, className, ...rest } = props || {}
      return h(props && props.onClick ? 'button' : 'span', {
        type: props && props.onClick ? 'button' : undefined,
        className: 'hk-fb-pill' + (active ? ' on' : '') + (className ? ' ' + className : ''),
        ...rest,
      }, children)
    }

    function FallbackTag(props) {
      const { tone, children, className } = props || {}
      return h('span', { className: 'hk-fb-tag tone-' + (tone || 'outline') + (className ? ' ' + className : '') }, children)
    }

    function FallbackStateDot(props) {
      return h('span', { className: 'hk-fb-dot state-' + ((props && props.state) || 'idle') })
    }

    function FallbackPathLabel(props) {
      return h('span', { className: 'hk-fb-path', title: props && props.path }, props && props.path)
    }

    function FallbackDisclosureRow(props) {
      const { icon, title, open, expandable, onToggle, children } = props || {}
      return h('div', { className: 'hk-fb-disclosure' },
        h('button', {
          type: 'button',
          className: 'hk-fb-disclosure-head',
          onClick: expandable === false ? undefined : onToggle,
        }, icon || null, h('span', { className: 'hk-fb-disclosure-title' }, title)),
        open ? h('div', { className: 'hk-fb-disclosure-body' }, children) : null)
    }

    const NativeButton = UI.Button || FallbackButton
    const NativeInput = UI.Input || FallbackInput
    const NativeSegmentedTabs = UI.SegmentedTabs || FallbackSegmentedTabs
    const NativePill = UI.Pill || FallbackPill
    const NativeTag = UI.Tag || FallbackTag
    const NativeStateDot = UI.StateDot || FallbackStateDot
    const NativePathLabel = UI.PathLabel || FallbackPathLabel
    const NativeDisclosureRow = UI.DisclosureRow || FallbackDisclosureRow

    /** 图标：primitive 有就用真的，没有就渲染空（不能渲染 undefined）。 */
    function iconOf(component, size) {
      return typeof component === 'function' ? h(component, { size: size || 16 }) : null
    }

    const ICONS = {
      database: UI.IconDatabaseOutlineRegular,
      skill: UI.IconSkillOutlineRegular,
      users: UI.IconUsersOutlineRegular,
      user: UI.IconUserOutlineRegular,
      clock: UI.IconClockOutlineRegular,
      gauge: UI.IconGaugeOutlineRegular,
      refresh: UI.IconRefreshOutlineRegular,
      plus: UI.IconPlusOutlineRegular,
      trash: UI.IconTrashOutlineRegular,
      pin: UI.IconPinOutlineRegular,
      pinFilled: UI.IconPinFillRegular,
      search: UI.IconSearchOutlineRegular,
      copy: UI.IconCopyOutlineRegular,
      download: UI.IconDownloadOutlineRegular,
      warning: UI.IconWarningOutlineRegular,
      check: UI.IconCheckOutlineRegular,
      chevronDown: UI.IconChevronDownOutlineRegular,
      chevronRight: UI.IconChevronRightOutlineRegular,
      folder: UI.IconFolderOpenOutlineRegular,
      sparkle: UI.IconSparkleRegular,
      data: UI.IconDataOutlineRegular,
      list: UI.IconFlatListOutlineRegular,
      clipboard: UI.IconChecklistOutlineRegular,
      edit: UI.IconEditOutlineRegular,
    }

    /**
     * 相对时间 → 中文字符串。
     *
     * ⚠️ 刻意**不用** primitives 的 `relativeTime`：它返回的是结构化桶
     * `{ unit: 'hours', n: 3 }`（渲染方自己本地化），直接丢给 React 会抛
     * "Objects are not valid as a React child"，整个面板会白屏 —— 这是实测踩到的坑。
     *
     * @param {number} at  时间戳（ms）
     * @param {number} [now] 注入的“现在”，便于测试
     */
    function relativeTime(at, now = Date.now()) {
      const t = Number(at)
      if (!Number.isFinite(t) || t <= 0) return '—'
      const diff = Math.max(0, Number(now) - t)
      if (diff < 60e3) return '刚刚'
      if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前'
      if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前'
      if (diff < 30 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前'
      return new Date(t).toLocaleDateString()
    }

    const writeClipboard = typeof UI.writeClipboard === 'function'
      ? UI.writeClipboard
      : async (text) => {
        try { await navigator.clipboard.writeText(String(text)) } catch { /* 剪贴板不可用 */ }
      }

    /* ─────────────────────── 样式（只用主题 token） ─────────────────────── */

    /**
     * 样式：对齐插件市场里做得最好的那批内存插件（参照 dsh-mnemon 0.5.34 的
     * MnemonView / MnemonSettingsCard 两个 CSS module）——
     * 基础字号 13/20、卡片用 0.5px `--dsw-alias-settings-card-stroke`、圆角 radius-lg、
     * 状态用 6px 圆点表示、分区标题是 `minmax(0,1fr) auto` 两列。
     *
     * 颜色一律走 `--dsw-alias-*` token，浅色/深色主题自动跟随；**不含任何 emoji**。
     */
    const CSS = [
      '.hk-page{box-sizing:border-box;display:flex;flex-direction:column;gap:0;padding:14px clamp(16px,2.4vw,28px) 0;max-width:1040px;min-height:0;max-height:100%;overflow:hidden;color:var(--dsw-alias-label-primary,#111);font:13px/20px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif)}',
      '.hk-head{flex:none;display:flex;flex-direction:column;gap:10px;padding-bottom:2px}',
      '.hk-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:14px;padding:14px 2px 28px}',
      '.hk-page *,.hk-page *:before,.hk-page *:after{box-sizing:border-box}',
      /* ── 页头 ── */
      '.hk-masthead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:44px}',
      '.hk-masthead-title{font-size:16px;font-weight:600;line-height:24px}',
      '.hk-masthead-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.hk-masthead-actions{margin-left:auto;display:flex;align-items:center;gap:8px}',
      /* ── 下划线 tab ── */
      '.hk-tabs{display:flex;align-items:center;gap:18px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));overflow-x:auto}',
      '.hk-tab{position:relative;padding:6px 0 9px;border:none;background:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#666);font:inherit;white-space:nowrap}',
      '.hk-tab:hover{color:var(--dsw-alias-label-primary,#111)}',
      '.hk-tab.on{color:var(--dsw-alias-label-primary,#111);font-weight:600}',
      '.hk-tab.on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px;background:var(--dsw-alias-state-business-primary,#4176e6)}',
      /* ── 状态卡 ── */
      '.hk-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:8px}',
      '.hk-status-card{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(0,0,0,.12)));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,transparent);padding:12px 14px;min-width:0}',
      '.hk-card-head{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#666);min-width:0}',
      '.hk-card-head>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hk-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary,#b8b8bd)}',
      '.hk-dot.ok{background:var(--dsw-alias-state-success-primary,#2ea36b)}',
      '.hk-dot.warn{background:var(--dsw-alias-state-warn-primary,#cf8b1d)}',
      '.hk-dot.err{background:var(--dsw-alias-state-error-primary,#d94a4a)}',
      '.hk-dot.info{background:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.hk-value{font-size:19px;font-weight:600;line-height:26px;margin-top:6px;color:var(--dsw-alias-label-primary,#111);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hk-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-top:2px}',
      /* ── 分区卡 ── */
      '.hk-section{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(0,0,0,.12)));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,transparent);overflow:hidden}',
      '.hk-section-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;column-gap:12px;row-gap:4px;padding:12px 14px 10px}',
      '.hk-section-title{font-size:13px;font-weight:600;line-height:20px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hk-section-desc{grid-column:1;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.hk-section-actions{grid-column:2;grid-row:1 / span 2;align-self:center;display:flex;align-items:center;gap:6px}',
      '.hk-rows{display:flex;flex-direction:column}',
      '.hk-row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));min-width:0;flex-wrap:wrap}',
      '.hk-row:first-child{border-top:none}',
      '.hk-row.click{cursor:pointer}',
      '.hk-row.click:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}',
      '.hk-row-main{flex:1 1 160px;min-width:0}',
      '.hk-row-title{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;overflow-wrap:anywhere}',
      '.hk-row-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-top:1px;overflow-wrap:anywhere}',
      '.hk-row-end{display:flex;align-items:center;gap:10px;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.hk-num{font-variant-numeric:tabular-nums}',
      '.hk-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow-wrap:anywhere}',
      /* ── 进度条 ── */
      '.hk-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08));overflow:hidden;margin-top:6px}',
      '.hk-bar>i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.hk-bar.warn>i{background:var(--dsw-alias-state-warn-primary,#cf8b1d)}',
      '.hk-bar.full>i{background:var(--dsw-alias-state-error-primary,#d94a4a)}',
      '.hk-dual{display:grid;grid-template-columns:1fr 1fr;gap:14px;flex:1 1 190px;max-width:260px}',
      '.hk-minihead{display:flex;justify-content:space-between;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      /* ── 头像（描边圆 + 名字首字） ── */
      '.hk-avatar{box-sizing:border-box;border:1px solid currentColor;border-radius:50%;display:grid;place-items:center;flex:none;font-weight:600;background:transparent;line-height:1}',
      /* ── 空态 / 错误 / 表单 ── */
      '.hk-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 16px;text-align:center;font-size:12px;line-height:19px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.hk-err{margin-bottom:10px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);border:.5px solid rgba(217,74,74,.4);background:rgba(217,74,74,.08);color:var(--dsw-alias-state-error-primary,#d94a4a);font-size:12px;line-height:18px;white-space:pre-wrap}',
      '.hk-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;min-width:0}',
      '.hk-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}',
      '.hk-textarea{width:100%;min-height:64px;resize:vertical;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#111);font:inherit;box-sizing:border-box}',
      '.hk-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.hk-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '.hk-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.hk-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer}',
      '.hk-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#111)}',
      /* ── 条目（记忆） ── */
      '.hk-entry{padding:10px 12px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));font-size:13px;line-height:20px;margin-bottom:6px;overflow-wrap:anywhere}',
      '.hk-entry-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.hk-entry-body{white-space:pre-wrap;overflow-wrap:anywhere}',
      '.hk-collapsed{max-height:60px;overflow:hidden;display:block}',
      /* ── 输入框里的技能弹出层 ── */
      '.hk-dock{position:relative;display:inline-flex;align-items:center}',
      '.hk-pop{position:absolute;left:0;bottom:calc(100% + 8px);width:min(300px,80vw);max-height:320px;overflow:auto;z-index:60;padding:6px;border-radius:var(--dsw-radius-lg,12px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));box-shadow:0 10px 24px rgba(0,0,0,.14)}',
      '.hk-pop-head{padding:6px 8px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.hk-pop-item{display:flex;gap:8px;align-items:flex-start;width:100%;text-align:left;padding:7px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;cursor:pointer;font:inherit}',
      '.hk-pop-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.hk-pop-item-main{min-width:0;flex:1}',
      '.hk-pop-name{font-size:13px;line-height:20px}',
      '.hk-pop-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.hk-pop-foot{margin-top:4px;padding:6px 8px 2px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      /* ── 退化组件（仅 Node 预览/测试用） ── */
      '.hk-fb{display:inline-flex;align-items:center;gap:4px;border:.5px solid rgba(0,0,0,.2);border-radius:8px;background:transparent;color:inherit;font:inherit;padding:4px 10px;cursor:pointer}',
      '.hk-fb-primary{background:#4176e6;border-color:transparent;color:#fff}',
      '.hk-fb-sm{font-size:12px;padding:2px 8px}',
      '.hk-fb-input{display:inline-flex;align-items:center;gap:6px;border:.5px solid rgba(0,0,0,.18);border-radius:8px;padding:4px 8px;min-width:120px}',
      '.hk-fb-input input{border:none;background:transparent;color:inherit;font:inherit;outline:none;width:100%}',
      '.hk-fb-tabs{display:flex;gap:4px}',
      '.hk-fb-tab{border:none;background:transparent;color:inherit;padding:5px 12px;border-radius:8px;cursor:pointer;font:inherit}',
      '.hk-fb-tab.on{background:rgba(0,0,0,.06);font-weight:600}',
      '.hk-fb-pill{padding:1px 8px;border-radius:9px;background:rgba(0,0,0,.06);font-size:12px;border:none;color:inherit;cursor:pointer}',
      '.hk-fb-pill.on{background:rgba(65,118,230,.14);color:#4176e6}',
      '.hk-fb-tag{padding:1px 6px;border-radius:6px;font-size:11px;background:rgba(0,0,0,.05);color:inherit}',
      '.hk-fb-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#2ea36b}',
      '.hk-fb-path{font-family:ui-monospace,monospace;font-size:11px;color:inherit;opacity:.7;overflow-wrap:anywhere}',
      '.hk-fb-disclosure{border:.5px solid rgba(0,0,0,.1);border-radius:8px;margin-bottom:6px}',
      '.hk-fb-disclosure-head{display:flex;gap:6px;align-items:center;width:100%;text-align:left;background:transparent;border:none;color:inherit;font:inherit;padding:8px 10px;cursor:pointer}',
      '.hk-fb-disclosure-title{flex:1;min-width:0}',
      '.hk-fb-disclosure-body{padding:0 10px 10px;font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap;max-height:260px;overflow:auto}',
      /* ── 旧类名兼容（其它 tab 仍在用，统一映射到新外观） ── */
      '.hk-panel{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(0,0,0,.12)));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,transparent);overflow:hidden}',
      '.hk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:8px}',
      '.hk-card{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(0,0,0,.12)));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,transparent);padding:12px 14px;cursor:pointer;min-width:0}',
      '.hk-card:hover{border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.2))}',
      '.hk-card.sel{border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#4176e6) inset}',
      '.hk-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:8px}',
      '.hk-stat{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(0,0,0,.12)));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,transparent);padding:12px 14px}',
      '.hk-stat-v{font-size:19px;font-weight:600;line-height:26px}',
      '.hk-stat-l{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-top:2px}',
      '.hk-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:44px}',
      '.hk-top-title{font-size:16px;font-weight:600;line-height:24px}',
      '.hk-top-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.hk-sec{display:flex;align-items:center;gap:8px;margin:14px 0 8px;min-width:0}',
      '.hk-sec-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;opacity:.7}',
      '.hk-sec-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hk-sec-count{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hk-sec-actions{margin-left:auto;display:flex;align-items:center;gap:6px;flex:none}',
      '.hk-flex-between{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.hk-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-top:2px}',
      '.hk-kv{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.hk-pill{font-size:11px;line-height:16px;padding:1px 7px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}',
      /* ── 窄屏 ── */
      '@media (max-width:760px){.hk-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.hk-dual{grid-template-columns:1fr;max-width:none;flex-basis:100%}.hk-tabs{gap:14px}.hk-row-end{width:100%;justify-content:flex-end}}',
    ].join('\n')

    function ensureStyles() {
      try {
        if (typeof document === 'undefined') return
        if (document.querySelector('style[data-hk-css]') !== null) return
        const tag = document.createElement('style')
        tag.dataset.hkCss = '1'
        // 供宿主模块系统按包回收样式（removeOwnedStyles 查 style[data-plugin]）
        tag.dataset.plugin = 'dsh-hanako-memory'
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch { /* 样式失败不影响功能 */ }
    }

    /* ─────────────────────── 同源 API ─────────────────────── */

    const API = '/hanako-memory'

    async function api(path, init) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json', ...(init && init.headers ? init.headers : {}) },
        ...(init || {}),
      })
      const text = await response.text()
      let payload = {}
      try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { ok: false, error: text.slice(0, 200) } }
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
      return payload
    }

    /**
     * 向 host 回报一次挂载结果（诊断用）。
     * 回报后 `/hanako-memory/diag` 能同时给出「是否在 boot graph 里」和「挂载成/败于什么」。
     *
     * @param {{mounted: boolean, reason?: string, slots?: string[]}} payload
     */
    function report(payload) {
      try {
        if (typeof fetch !== 'function') return
        const request = fetch(API + '/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...payload, name, inject }),
        })
        if (request && typeof request.catch === 'function') request.catch(() => {})
      } catch { /* 诊断失败不影响功能 */ }
    }

    /* ─────────────────────── 纯函数工具 ─────────────────────── */

    /**
     * 内置人格的兜底元数据（**不带 emoji** —— 头像统一用「名字首字 + 描边圆」的简笔画风格）。
     * 真正的数据来自 host 的 `/personas`；这里只在拿不到时兜底。
     */
    const YUAN_META = {
      hanako: { label: '小花', accent: '#e8a0bf', mood: 'MOOD', blurb: '温柔有主见，回答前先冒内心戏' },
      butter: { label: '黄油', accent: '#f5c76a', mood: 'PULSE', blurb: '跳脱直球，情绪起伏明显' },
      ming: { label: '明', accent: '#7fb2d9', mood: '沉思', blurb: '先厘清前提，再动手' },
      kong: { label: '空', accent: '#9a9a9a', mood: '—', blurb: '没有意识块，直接回答' },
    }

    function yuanOf(id) { return YUAN_META[id] || YUAN_META.hanako }

    /** 取「名字首字」当头像（简笔画风格：描边圆 + 一个字）。 */
    function initialOf(label, fallback) {
      const text = String(label ?? '').trim()
      if (text === '') return String(fallback ?? '?').slice(0, 1)
      return Array.from(text)[0]
    }

    /**
     * 头像：一个描边圆 + 名字首字。**刻意不用 emoji** —— emoji 在深浅主题下
     * 颜色不可控、也不成体系；描边 + 文字在两种主题下都清楚。
     */
    function Avatar(props) {
      const size = props.size || 30
      const accent = props.accent || 'currentColor'
      const text = initialOf(props.label, props.fallback)
      return h('span', {
        className: 'hk-avatar',
        style: {
          width: size,
          height: size,
          color: accent,
          borderColor: accent,
          fontSize: Math.max(11, Math.round(size * (text.length > 1 ? 0.42 : 0.5))),
        },
        title: props.title || props.label || '',
      }, text)
    }

    function barClass(pct) {
      if (pct >= 95) return 'hk-bar full'
      if (pct >= 75) return 'hk-bar warn'
      return 'hk-bar'
    }

    function num(value) {
      const n = Number(value)
      return Number.isFinite(n) ? n.toLocaleString('en-US') : '—'
    }

    /** 字符数（按码点算，与 host 的 charCount 一致）。 */
    function charCount(text) {
      return Array.from(String(text ?? '')).length
    }

    /**
     * 读取侧重复体检：完全重复，或一条被另一条包含（≥12 字符才判，避免短句误判）。
     * Hermes 在写入侧做 order-preserving 去重；这里针对的是历史数据/手改文件留下的重复。
     *
     * @param {string[]} entries
     * @returns {Record<number, number>} 下标 → 与哪一条重复
     */
    function findDuplicates(entries) {
      const normalized = entries.map(entry => String(entry ?? '').replace(/\s+/g, ' ').trim().toLowerCase())
      const out = {}
      for (let i = 0; i < normalized.length; i++) {
        for (let j = 0; j < i; j++) {
          const a = normalized[i]
          const b = normalized[j]
          if (a === '' || b === '') continue
          if (a === b) { out[i] = j; break }
          if (a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a))) { out[i] = j; break }
        }
      }
      return out
    }

    function downloadMarkdown(filename, text) {
      try {
        if (typeof document === 'undefined') return
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } catch { /* 导出失败不影响面板 */ }
    }

    /* ─────────────────────── 小组件 ─────────────────────── */

    function SectionHead(props) {
      return h('div', { className: 'hk-sec' },
        props.icon ? h('span', { className: 'hk-sec-icon' }, iconOf(props.icon, 14)) : null,
        h('span', { className: 'hk-sec-title' }, props.title),
        props.count !== undefined ? h('span', { className: 'hk-sec-count' }, props.count) : null,
        props.actions ? h('span', { className: 'hk-sec-actions' }, props.actions) : null)
    }

    /** 状态卡：一个状态点 + 标签 / 大数值 / 副文案（对齐市场里那批插件的 4-up 卡片）。 */
    function StatCell(label, value, hint, tone) {
      const cls = tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'err' ? 'err' : tone === 'info' ? 'info' : ''
      return h('div', { className: 'hk-status-card', key: label },
        h('div', { className: 'hk-card-head' },
          h('span', { className: 'hk-dot ' + cls }),
          h('span', null, label)),
        h('div', { className: 'hk-value' }, value),
        hint ? h('div', { className: 'hk-sub' }, hint) : null)
    }

    /** 双库迷你用量（记忆 + 画像）。 */
    function DualUsage(row, compact) {
      return h('div', { className: 'hk-dual' },
        h('div', null,
          h('div', { className: 'hk-minihead' },
            h('span', null, '记忆 ' + (compact ? row.memory.pct + '%' : num(row.memory.used) + '/' + num(row.memory.limit))),
            h('span', null, '· ' + row.memory.entryCount + ' 条')),
          h('div', { className: barClass(row.memory.pct) }, h('i', { style: { width: Math.min(100, row.memory.pct) + '%' } }))),
        h('div', null,
          h('div', { className: 'hk-minihead' },
            h('span', null, '画像 ' + (compact ? row.user.pct + '%' : num(row.user.used) + '/' + num(row.user.limit))),
            h('span', null, '· ' + row.user.entryCount + ' 条')),
          h('div', { className: barClass(row.user.pct) }, h('i', { style: { width: Math.min(100, row.user.pct) + '%' } }))))
    }

    function IconAction(icon, title, onClick, disabled) {
      return h('button', {
        type: 'button',
        className: 'hk-icon-btn',
        title,
        'aria-label': title,
        disabled: disabled === true,
        onClick,
      }, iconOf(icon, 14))
    }

    /* ─────────────────────── 通用版式件 ─────────────────────── */

    /**
     * 分区卡：标题 + 描述 + 右侧动作 + 内容。
     * 结构照抄插件市场里最好的那批（dsh-mnemon 的 section card）：
     * 标题/动作两列网格，描述单独一行，内容由调用方放 rows。
     */
    function Section(props) {
      const head = h('div', { className: 'hk-section-head' },
        h('div', { className: 'hk-section-title' }, props.title),
        props.actions ? h('div', { className: 'hk-section-actions' }, props.actions) : null,
        props.desc ? h('div', { className: 'hk-section-desc' }, props.desc) : null)
      return h('section', { className: 'hk-section' }, head, props.children)
    }

    /** 一行：状态点 + 主区（标题/副文案）+ 右侧（数值/按钮）。 */
    function Row(props) {
      const children = []
      if (props.tone !== undefined || props.dot === true) {
        children.push(h('span', { className: 'hk-dot ' + (props.tone || '') }))
      }
      if (props.leading) children.push(props.leading)
      children.push(h('div', { className: 'hk-row-main' },
        h('div', { className: 'hk-row-title' }, props.title),
        props.sub ? h('div', { className: 'hk-row-sub' }, props.sub) : null))
      if (props.end) children.push(h('div', { className: 'hk-row-end' }, props.end))
      return h('div', {
        key: props.rowKey,
        className: 'hk-row' + (props.onClick ? ' click' : ''),
        onClick: props.onClick,
      }, children)
    }

    /** 状态点（success / warn / err / info / idle）。 */
    function Dot(props) {
      return h('span', { className: 'hk-dot ' + (props.tone || '') })
    }

    /** 迷你进度条。 */
    function Bar(props) {
      const pct = Math.max(0, Math.min(100, Number(props.pct) || 0))
      const cls = pct >= 95 ? 'hk-bar full' : pct >= 75 ? 'hk-bar warn' : 'hk-bar'
      return h('div', { className: cls }, h('i', { style: { width: pct + '%' } }))
    }

    /* ─────────────────────── 总览 tab ─────────────────────── */

    const ROLLING_LABEL = { today: '今天', week: '本周', longterm: '长期' }

    /**
     * 活动行里的助手显示名：查表，取不到就回落到 id。
     *
     * 这里曾经写成 `props.agentName(item.agentId)`，但 OverviewTab 收到的是
     * **字符串**（`agentName` 在父组件里已被求值），于是 `typeof
     * props.agentName === 'function'` 为 false 却也进入了错误分支 —— 更糟的是
     * 早期版本直接调用，`TypeError: props.agentName is not a function` 让
     * 「总览」页整个渲染失败。查表纯函数不会被数据形状搞崩。
     *
     * @param {Record<string, string>} names - id → 显示名
     * @param {string} id - 助手 id
     * @returns {string} 显示名
     */
    function activityAgentLabel(names, id) {
      if (typeof id !== 'string' || id === '') return ''
      const hit = names && typeof names === 'object' ? names[id] : undefined
      return typeof hit === 'string' && hit !== '' ? hit : id
    }

    function OverviewTab(props) {
      const overview = props.overview
      if (!overview) {
        return h('div', { className: 'hk-empty' }, props.error ? props.error : '加载中…')
      }

      const totals = overview.totals || {}
      const list = overview.assistants || []
      const activity = overview.activity || []
      const memory = totals.memory || { used: 0, limit: 0, pct: 0 }
      const user = totals.user || { used: 0, limit: 0, pct: 0 }
      const paths = overview.paths || {}
      const personas = props.personas || []
      const skillStats = props.skillStats || null
      const insightCount = Number(props.insightCount) || 0
      const customPersonas = personas.filter(item => !item.builtin).length

      // ── 状态卡 ──
      const statusCards = h('div', { className: 'hk-cards' },
        StatCell('助手', num(totals.assistants), totals.broken > 0 ? totals.broken + ' 个损坏' : '全部正常', totals.broken > 0 ? 'warn' : 'ok'),
        StatCell('记忆用量', memory.pct + '%', num(memory.used) + ' / ' + num(memory.limit) + ' 字符', memory.pct >= 95 ? 'err' : memory.pct >= 75 ? 'warn' : 'info'),
        StatCell('画像用量', user.pct + '%', num(user.used) + ' / ' + num(user.limit) + ' 字符', user.pct >= 95 ? 'err' : user.pct >= 75 ? 'warn' : 'info'),
        StatCell('技能', num(totals.skills), skillStats && skillStats.findings > 0 ? skillStats.findings + ' 条体检发现' : '模型可读写', skillStats && skillStats.error > 0 ? 'err' : skillStats && skillStats.findings > 0 ? 'warn' : 'ok'),
        StatCell('置顶', num(totals.pinned), '永远最高优先级', totals.pinned > 0 ? 'ok' : 'idle'))

      // ── Provider 列表（人格 / 洞察 / 技能 / 记忆分层）──
      const providerRows = [
        Row({
          rowKey: 'p-insights',
          tone: insightCount > 0 ? 'info' : 'idle',
          title: '洞察',
          sub: '当前助手「' + (props.currentAgentName || props.agentId || '—') + '」的 Honcho 式推导结论',
          end: [h('span', { key: 'v', className: 'hk-num' }, num(insightCount) + ' 条'), h(NativeButton, {
            key: 'go', size: 'sm', variant: 'ghost', onClick: () => props.onOpenTab('memory'),
          }, '进入')],
          onClick: () => props.onOpenTab('memory'),
        }),
        Row({
          rowKey: 'p-skills',
          tone: skillStats && skillStats.error > 0 ? 'err' : skillStats && skillStats.findings > 0 ? 'warn' : 'ok',
          title: '技能',
          sub: skillStats ? '体检 ' + skillStats.findings + ' 条发现 · 共 ' + num(skillStats.totalChars) + ' 字符' : '模型可读写',
          end: [h('span', { key: 'v', className: 'hk-num' }, num(totals.skills) + ' 个'), h(NativeButton, {
            key: 'go', size: 'sm', variant: 'ghost', onClick: () => props.onOpenTab('skills'),
          }, '进入')],
          onClick: () => props.onOpenTab('skills'),
        }),
        Row({
          rowKey: 'p-layers',
          tone: list.some(row => row.rolling && (row.rolling.today.exists || row.rolling.week.exists || row.rolling.longterm.exists)) ? 'ok' : 'idle',
          title: '长期记忆（滚动层）',
          sub: 'today / week / longterm 不进常驻预算',
          end: [h('span', { key: 'v', className: 'hk-num' }, list.length + ' 个助手'), h(NativeButton, {
            key: 'go', size: 'sm', variant: 'ghost', onClick: () => props.onOpenTab('memory'),
          }, '进入')],
          onClick: () => props.onOpenTab('memory'),
        }),
      ]

      // ── 助手行 ──
      const agentRows = list.map(row => Row({
        rowKey: row.id,
        leading: h(Avatar, { label: row.name, accent: (yuanOf(row.yuan) || {}).accent || '#8a8a8a', size: 28 }),
        title: [row.name, h(NativeTag, { key: 't', tone: 'neutral' }, (yuanOf(row.yuan) || {}).label || row.yuan)],
        sub: '置顶 ' + num(row.pinned) + ' · 更新 ' + relativeTime(row.updatedAt),
        end: h('div', { style: { minWidth: 170 } },
          h('div', { className: 'hk-minihead' },
            h('span', null, '记忆 ' + num(row.memory.used) + '/' + num(row.memory.limit)),
            h('span', { className: 'hk-num' }, row.memory.pct + '%')),
          Bar({ pct: row.memory.pct }),
          h('div', { className: 'hk-minihead', style: { marginTop: 4 } },
            h('span', null, '画像 ' + num(row.user.used) + '/' + num(row.user.limit)),
            h('span', { className: 'hk-num' }, row.user.pct + '%')),
          Bar({ pct: row.user.pct })),
        onClick: () => props.onOpenMemory(row.id),
      }))

      // ── 分层摘要行 ──
      const layerRows = list.map(row => {
        const cells = ['today', 'week', 'longterm'].map(layer => {
          const cell = (row.rolling && row.rolling[layer]) || { chars: 0, exists: false }
          return h(NativeTag, { key: layer, tone: cell.exists ? 'outline' : 'quiet' },
            ROLLING_LABEL[layer] + ' ' + (cell.exists ? num(cell.chars) + ' 字' : '空'))
        })
        return Row({
          rowKey: 'layer-' + row.id,
          tone: ['today', 'week', 'longterm'].some(layer => row.rolling && row.rolling[layer] && row.rolling[layer].exists) ? 'ok' : 'idle',
          title: row.name,
          sub: cells,
        })
      })

      // ── 最近写入行 ──
      const kindLabel = kind => (kind === 'memory' ? '记忆' : kind === 'pinned' ? '置顶' : '技能')
      const kindTone = kind => (kind === 'memory' ? 'info' : kind === 'pinned' ? 'warn' : 'ok')
      // 活动行里的助手名：从 overview.assistants 建立一个 id → 名字的映射。
      // 以前这里直接把 props.agentName 当函数调用，而它实际是字符串，于是渲染
      // 「总览」页时抛出 TypeError，整块 UI 崩掉。
      const activityAgentNames = (() => {
        const names = {}
        const list = overview && Array.isArray(overview.assistants) ? overview.assistants : []
        for (const assistant of list) {
          if (assistant && typeof assistant.id === 'string') names[assistant.id] = assistant.name || assistant.id
        }
        return names
      })()
      const activityRows = activity.map((item, index) => Row({
        rowKey: 'act-' + index,
        tone: item.ok === false ? 'err' : kindTone(item.kind),
        title: [kindLabel(item.kind),
          item.agentId ? h('span', { key: 'a', className: 'hk-row-sub', style: { margin: 0 } }, activityAgentLabel(activityAgentNames, item.agentId)) : null,
          item.target ? h('span', { key: 't', className: 'hk-mono' }, String(item.target).toUpperCase()) : null,
          item.ops !== undefined ? h('span', { key: 'o', className: 'hk-row-sub', style: { margin: 0 } }, item.ops + ' 个操作') : null,
          item.count !== undefined ? h('span', { key: 'c', className: 'hk-row-sub', style: { margin: 0 } }, item.count + ' 条') : null],
        sub: item.detail || null,
        end: relativeTime(item.at),
      }))

      // ── 存储域：三张卡（记忆根 / 技能根 / 活动日志）──
      const storageCards = h('div', { className: 'hk-cards' },
        h('div', { className: 'hk-status-card', key: 'storage-memory' },
          h('div', { className: 'hk-card-head' }, h(Dot, { tone: 'ok' }), h('span', null, '记忆根')),
          h('div', { className: 'hk-mono', style: { marginTop: 6 } }, paths.memoryTemplate || '—'),
          h('div', { className: 'hk-sub' }, num(memory.used) + ' / ' + num(memory.limit) + ' 字符 · ' + list.length + ' 个助手'),),
        h('div', { className: 'hk-status-card', key: 'storage-skills' },
          h('div', { className: 'hk-card-head' }, h(Dot, { tone: skillStats && skillStats.error > 0 ? 'err' : 'ok' }), h('span', null, '技能根')),
          h('div', { className: 'hk-mono', style: { marginTop: 6 } }, (paths.skillRoots || ['—']).join('\n')),
          h('div', { className: 'hk-sub' }, num(totals.skills) + ' 个技能' + (skillStats ? ' · ' + num(skillStats.totalChars) + ' 字符' : ''))),
        h('div', { className: 'hk-status-card', key: 'storage-activity' },
          h('div', { className: 'hk-card-head' }, h(Dot, { tone: activity.length > 0 ? 'ok' : 'idle' }), h('span', null, '活动日志')),
          h('div', { className: 'hk-mono', style: { marginTop: 6 } }, paths.activityFile || '—'),
          h('div', { className: 'hk-sub' }, '本次展示最近 ' + activity.length + ' 条写入')))

      return h('div', null,
        statusCards,

        h(Section, {
          title: 'Provider',
          desc: '这个插件能干什么：每行一个能力面，右边是数量，点「进入」跳过去',
        }, h('div', { className: 'hk-rows' }, providerRows)),

        h(Section, {
          title: '助手',
          desc: list.length + ' 个 · 每个助手独立的双库记忆',
          actions: h(NativeButton, { size: 'sm', variant: 'ghost', icon: iconOf(ICONS.refresh, 14), onClick: props.onReload }, '刷新'),
        }, list.length === 0
          ? h('div', { className: 'hk-empty' }, '还没有助手。到「助手」tab 新建一个。')
          : h('div', { className: 'hk-rows' }, agentRows)),

        h(Section, {
          title: '分层摘要',
          desc: '滚动层不进常驻预算：今天 / 本周 / 长期',
        }, layerRows.length === 0
          ? h('div', { className: 'hk-empty' }, '无')
          : h('div', { className: 'hk-rows' }, layerRows)),

        h(Section, {
          title: '最近写入',
          desc: '记忆 / 置顶 / 技能的实际写操作，落盘在活动日志里',
          actions: h('span', { className: 'hk-num hk-row-sub' }, activity.length + ' 条'),
        }, activityRows.length === 0
          ? h('div', { className: 'hk-empty' }, '还没有写入记录。模型调用 memory 工具、或你在面板里改记忆后会出现。')
          : h('div', { className: 'hk-rows' }, activityRows)),

        h(Section, { title: '存储域', desc: '记忆 / 技能 / 审计的实际落盘位置' }, storageCards),
      )
    }

    /* ─────────────────────── 人格 tab（自由创造） ─────────────────────── */

    const PERSONA_FIELDS = [
      { key: 'label', label: '名字', hint: '显示人格名，例如「老王」「小满」' },
      { key: 'accent', label: '主题色', hint: 'CSS 颜色，例如 #7fb2d9' },
      { key: 'moodTag', label: '状态标签', hint: '小标签，例如 BUILD / 沉思 / MOOD' },
      { key: 'blurb', label: '一句话人格', hint: '它会怎么说话、怎么做事（进 MEMORY.md 种子）' },
      { key: 'blocks', label: '意识块', hint: '逗号分隔，例如 Plan, Patch, Verify；留空表示不演内心戏' },
      { key: 'prompt', label: '人格指令（可选）', hint: '写进 system prompt 的自由文本：语气、禁区、习惯。留空则不注入' },
    ]

    function emptyPersonaDraft() {
      return { label: '', accent: '#8a8a8a', moodTag: '—', blocks: '', blurb: '', prompt: '' }
    }

    function personaToDraft(persona) {
      return {
        label: persona.label || '',
        accent: persona.accent || '#8a8a8a',
        moodTag: persona.moodTag || '—',
        blocks: Array.isArray(persona.blocks) ? persona.blocks.join(', ') : '',
        blurb: persona.blurb || '',
        prompt: persona.prompt || '',
      }
    }

    function draftToPayload(draft) {
      return {
        label: draft.label,
        accent: draft.accent,
        moodTag: draft.moodTag,
        blurb: draft.blurb,
        prompt: draft.prompt,
        blocks: draft.blocks.split(',').map(item => item.trim()).filter(item => item !== ''),
      }
    }

    function PersonasTab(props) {
      const list = props.personas || []
      const [editing, setEditing] = props.editingPersona
      const [draft, setDraft] = react.useState(emptyPersonaDraft())
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')

      const current = list.find(item => item.id === editing) || null
      const isBuiltin = current !== null && current.builtin === true

      react.useEffect(() => {
        if (current !== null) setDraft(personaToDraft(current))
        else setDraft(emptyPersonaDraft())
      }, [editing])

      async function run(action) {
        setError('')
        setBusy(true)
        try { await action() } catch (e) { setError(String(e && e.message ? e.message : e)) } finally { setBusy(false) }
      }

      function startCreate() {
        setEditing('')
        setDraft(emptyPersonaDraft())
      }

      function field(row) {
        const isLong = row.key === 'prompt' || row.key === 'blurb'
        const control = isLong
          ? h('textarea', {
            className: 'hk-textarea',
            value: draft[row.key],
            placeholder: row.hint,
            onChange: e => setDraft(v => ({ ...v, [row.key]: e.target.value })),
          })
          : h(NativeInput, {
            placeholder: row.hint,
            value: draft[row.key],
            onChange: e => setDraft(v => ({ ...v, [row.key]: e.target.value })),
          })
        return h('div', { className: 'hk-field', key: row.key },
          h('div', { className: 'hk-label' }, row.label),
          control)
      }

      const personaRows = list.map(persona => Row({
        rowKey: persona.id,
        leading: h(Avatar, { label: persona.label || persona.id, accent: persona.accent || '#8a8a8a', size: 28 }),
        title: [persona.label || persona.id,
          persona.builtin ? h(NativeTag, { key: 'b', tone: 'neutral' }, '内置模板') : h(NativeTag, { key: 'c', tone: 'success' }, '自定义')],
        sub: [
          persona.blurb || '（没有描述）',
          (persona.blocks || []).length > 0
            ? h('span', { key: 'bl', className: 'hk-mono', style: { marginLeft: 6 } }, persona.blocks.join(' / '))
            : null,
          persona.prompt ? h('span', { key: 'p', className: 'hk-sub', style: { margin: 0 } }, ' · 有人格指令') : null,
        ],
        end: h(NativeButton, {
          size: 'sm',
          variant: 'ghost',
          onClick: () => setEditing(persona.id),
        }, '编辑'),
        onClick: () => setEditing(persona.id),
      }))

      const duplicateAction = isBuiltin
        ? h(NativeButton, {
          key: 'dup',
          size: 'sm',
          variant: 'outline',
          icon: iconOf(ICONS.copy, 14),
          disabled: busy,
          onClick: () => run(async () => {
            const data = await api('/personas/' + encodeURIComponent(current.id) + '/duplicate', {
              method: 'POST',
              body: JSON.stringify({ label: current.label + ' 副本' }),
            })
            await props.onChanged()
            setEditing(data.persona.id)
          }),
        }, '另存为自定义')
        : null

      const createAssistantAction = current === null
        ? null
        : h(NativeButton, {
          key: 'mk',
          size: 'sm',
          variant: 'outline',
          icon: iconOf(ICONS.plus, 14),
          disabled: busy,
          onClick: () => run(async () => {
            const name = typeof window !== 'undefined' && typeof window.prompt === 'function'
              ? window.prompt('新助手叫什么名字？', current.label + ' 助手')
              : current.label + ' 助手'
            if (name === null || String(name).trim() === '') return
            await api('/assistants', { method: 'POST', body: JSON.stringify({ name: String(name).trim(), yuan: current.id }) })
            await props.onChanged()
            if (props.onOpenAssistants) props.onOpenAssistants()
          }),
        }, '用这个人格新建助手')

      const editorActions = []
      if (!isBuiltin) {
        editorActions.push(h(NativeButton, {
          key: 'save',
          variant: 'primary',
          disabled: busy || draft.label.trim() === '',
          onClick: () => run(async () => {
            const payload = draftToPayload(draft)
            if (current === null) {
              const created = await api('/personas', { method: 'POST', body: JSON.stringify(payload) })
              await props.onChanged()
              setEditing(created.persona.id)
            } else {
              await api('/personas/' + encodeURIComponent(current.id), { method: 'PUT', body: JSON.stringify(payload) })
              await props.onChanged()
            }
          }),
        }, current === null ? '创造' : '保存'))
        if (current !== null) {
          editorActions.push(h(NativeButton, {
            key: 'delete',
            variant: 'outline',
            icon: iconOf(ICONS.trash, 14),
            disabled: busy,
            onClick: () => {
              if (!window.confirm('删除人格「' + current.label + '」？已有助手会保留人格快照。')) return
              run(async () => {
                await api('/personas/' + encodeURIComponent(current.id), { method: 'DELETE' })
                setEditing('')
                await props.onChanged()
              })
            },
          }, '删除'))
        }
        editorActions.push(h(NativeButton, {
          key: 'clear',
          variant: 'ghost',
          onClick: () => { setEditing(''); setDraft(emptyPersonaDraft()) },
        }, '清空表单'))
      }

      const editorBody = isBuiltin
        ? h('div', { className: 'hk-empty' },
          '这是内置模板：不能修改或删除。点右上角「另存为自定义」得到一份可自由编辑的副本。')
        : h('div', { className: 'hk-row', style: { display: 'block' } },
          h('div', { className: 'hk-inline', style: { gap: 12, alignItems: 'flex-start', marginBottom: 10 } },
            h(Avatar, { label: draft.label || '新', accent: draft.accent || '#8a8a8a', size: 44 }),
            h('div', { style: { flex: 1, minWidth: 0 } },
              field(PERSONA_FIELDS[0]),
              field(PERSONA_FIELDS[1]))),
          PERSONA_FIELDS.slice(2).map(field),
          h('div', { className: 'hk-actions' }, editorActions))

      return h('div', null,
        error ? h('div', { className: 'hk-err' }, error) : null,

        h(Section, {
          title: '人格',
          desc: list.length + ' 个（内置 ' + list.filter(item => item.builtin).length + ' 个模板，其余都是你创造的）· 人格决定语气、意识块与注入给模型的人格指令',
          actions: h(NativeButton, {
            size: 'sm',
            variant: 'primary',
            icon: iconOf(ICONS.plus, 14),
            onClick: startCreate,
          }, '创造人格'),
        }, personaRows.length === 0
          ? h('div', { className: 'hk-empty' }, '还没有人格。点「创造人格」写一个。')
          : h('div', { className: 'hk-rows' }, personaRows)),

        h(Section, {
          title: current === null ? '创造一个新人格' : (isBuiltin ? '内置模板：' + current.label : '编辑：' + current.label),
          desc: isBuiltin ? '内置模板不可改；可以另存为自定义，或用它直接建助手' : '所有字段都可以随便写；人格指令非空时会进 system prompt',
          actions: [duplicateAction, createAssistantAction],
        }, editorBody),
      )
    }

    /* ─────────────────────── 助手 tab ─────────────────────── */

    /**
     * 助手 = 人格（Hanako 原版的模型）：没有独立的「人格」列表可挑，
     * 每个助手自己带人格字段（一句话人格 / 意识块 / 人格指令 / 主题色），
     * 以及**自己的技能清单**（技能文件仍在一个目录里，这里只维护归属关系）。
     */
    function AssistantsTab(props) {
      const rows = props.overview ? props.overview.assistants || [] : []
      const [selected, setSelected] = react.useState('')
      const [draft, setDraft] = react.useState({
        name: '', description: '', personaLabel: '', personaBlurb: '',
        personaBlocks: '', personaPrompt: '', personaAccent: '#7fb2d9', personaMood: '',
      })
      const [creating, setCreating] = react.useState(false)
      const [allSkills, setAllSkills] = react.useState([])
      const [skillPick, setSkillPick] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')

      const current = rows.find(item => item.id === selected)
        || rows.find(item => item.id === props.agentId)
        || rows[0]
        || null

      react.useEffect(() => {
        api('/skills')
          .then(data => setAllSkills((data.skills || []).map(item => String(item.name))))
          .catch(() => setAllSkills([]))
      }, [])

      react.useEffect(() => {
        if (current === null) return
        const persona = current.persona || {}
        setDraft({
          name: current.name || '',
          description: current.description || '',
          personaLabel: persona.label || current.name || '',
          personaBlurb: persona.blurb || '',
          personaBlocks: Array.isArray(persona.blocks) ? persona.blocks.join(', ') : '',
          personaPrompt: persona.prompt || '',
          personaAccent: persona.accent || '#7fb2d9',
          personaMood: persona.moodTag || '',
        })
      }, [current && current.id])

      async function run(action) {
        setError('')
        setBusy(true)
        try { await action() } catch (e) { setError(String(e && e.message ? e.message : e)) } finally { setBusy(false) }
      }

      const payloadOf = () => ({
        name: draft.name,
        description: draft.description,
        personaLabel: draft.personaLabel || draft.name,
        personaBlurb: draft.personaBlurb,
        personaPrompt: draft.personaPrompt,
        personaMood: draft.personaMood,
        personaAccent: draft.personaAccent,
        personaBlocks: draft.personaBlocks.split(',').map(item => item.trim()).filter(item => item !== ''),
      })

      function field(key, label, placeholder, long) {
        const control = long
          ? h('textarea', {
            className: 'hk-textarea',
            value: draft[key],
            placeholder,
            onChange: e => setDraft(v => ({ ...v, [key]: e.target.value })),
          })
          : h(NativeInput, {
            placeholder,
            value: draft[key],
            onChange: e => setDraft(v => ({ ...v, [key]: e.target.value })),
          })
        return h('div', { className: 'hk-field', key },
          h('div', { className: 'hk-label' }, label),
          control)
      }

      const assistantSkillNames = current && Array.isArray(current.skills) ? current.skills : []
      const addable = allSkills.filter(name => !assistantSkillNames.includes(name))

      const skillChips = current === null ? null : h('div', null,
        h('div', { className: 'hk-inline' },
          assistantSkillNames.length === 0
            ? h('span', { className: 'hk-sub' }, '这个助手还没有自己的技能；右列选一个加进来。')
            : assistantSkillNames.map(name => h('span', { key: name, className: 'hk-inline', style: { gap: 4 } },
              h(NativeTag, { tone: 'info' }, name),
              h('button', {
                type: 'button',
                className: 'hk-icon-btn',
                title: '从这个助手移除',
                onClick: () => run(async () => {
                  await api('/assistants/' + encodeURIComponent(current.id), {
                    method: 'PUT',
                    body: JSON.stringify({ skills: assistantSkillNames.filter(item => item !== name) }),
                  })
                  props.onChanged()
                }),
              }, '×')))),
        h('div', { className: 'hk-inline', style: { marginTop: 8 } },
          h('select', {
            className: 'hk-textarea',
            style: { minHeight: 0, padding: '4px 8px', width: 'auto', minWidth: 160 },
            value: skillPick,
            onChange: e => setSkillPick(e.target.value),
          },
            h('option', { value: '' }, addable.length === 0 ? '（没有可加的技能）' : '选择技能…'),
            addable.map(name => h('option', { key: name, value: name }, name))),
          h(NativeButton, {
            size: 'sm',
            variant: 'outline',
            disabled: skillPick === '',
            onClick: () => run(async () => {
              await api('/assistants/' + encodeURIComponent(current.id), {
                method: 'PUT',
                body: JSON.stringify({ skills: [...assistantSkillNames, skillPick] }),
              })
              setSkillPick('')
              props.onChanged()
            }),
          }, '加到该助手')))

      const agentRows = rows.map(row => {
        const persona = row.persona || {}
        return Row({
          rowKey: row.id,
          leading: h(Avatar, { label: row.name, accent: persona.accent || '#8a8a8a', size: 28 }),
          title: [row.name,
            row.isDefault ? h(NativeTag, { key: 'd', tone: 'success' }, '主助手') : null,
            row.broken ? h(NativeTag, { key: 'b', tone: 'danger' }, '损坏') : null,
            persona.moodTag ? h(NativeTag, { key: 'm', tone: 'quiet' }, persona.moodTag) : null],
          sub: [
            persona.blurb || row.description || '（还没有写人格描述）',
            (row.skills || []).length > 0
              ? h('span', { key: 's', className: 'hk-sub', style: { margin: 0 } }, ' · 技能 ' + row.skills.length + ' 个')
              : null,
          ],
          end: h('div', { style: { minWidth: 150 } },
            h('div', { className: 'hk-minihead' },
              h('span', null, '记忆 ' + num(row.memory.used) + '/' + num(row.memory.limit)),
              h('span', { className: 'hk-num' }, row.memory.pct + '%')),
            Bar({ pct: row.memory.pct })),
          onClick: () => setSelected(row.id),
        })
      })

      const createForm = h('div', { className: 'hk-row', style: { display: 'block' } },
        field('name', '名字', '例如：小花'),
        field('personaBlurb', '一句话人格', '它会怎么说话、怎么做事', false),
        field('personaBlocks', '意识块（逗号分隔）', '例如 Plan, Patch, Verify；留空表示不演内心戏', false),
        field('personaPrompt', '人格指令（可选，进 system prompt）', '语气、禁区、习惯；留空则不注入', true),
        h('div', { className: 'hk-actions' },
          h(NativeButton, {
            variant: 'primary',
            disabled: busy || draft.name.trim() === '',
            onClick: () => run(async () => {
              await api('/assistants', {
                method: 'POST',
                body: JSON.stringify({
                  name: draft.name,
                  description: draft.description || draft.personaBlurb,
                  persona: {
                    label: draft.personaLabel || draft.name,
                    blurb: draft.personaBlurb,
                    prompt: draft.personaPrompt,
                    blocks: draft.personaBlocks.split(',').map(item => item.trim()).filter(Boolean),
                  },
                }),
              })
              setCreating(false)
              props.onChanged()
            }),
          }, '创建'),
          h(NativeButton, { variant: 'ghost', onClick: () => setCreating(false) }, '取消')))

      const editBody = current === null ? null : h('div', { className: 'hk-row', style: { display: 'block' } },
        h('div', { className: 'hk-inline', style: { gap: 12, alignItems: 'flex-start', marginBottom: 10 } },
          h(Avatar, { label: draft.name || current.name, accent: draft.personaAccent || '#8a8a8a', size: 44 }),
          h('div', { style: { flex: 1, minWidth: 0 } },
            field('name', '名字', '助手/人格的显示名'),
            field('personaLabel', '人格名（可与名字不同）', '默认跟名字一样'))),
        field('personaBlurb', '一句话人格', '它会怎么说话、怎么做事', false),
        field('personaBlocks', '意识块（逗号分隔）', '例如 Plan, Patch, Verify', false),
        field('personaPrompt', '人格指令（可选，进 system prompt）', '语气、禁区、习惯', true),
        h('div', { className: 'hk-field' },
          h('div', { className: 'hk-label' }, '主题色'),
          h(NativeInput, { value: draft.personaAccent, onChange: e => setDraft(v => ({ ...v, personaAccent: e.target.value })) })),
        h('div', { className: 'hk-actions' },
          h(NativeButton, {
            variant: 'primary',
            disabled: busy || draft.name.trim() === '',
            onClick: () => run(async () => {
              await api('/assistants/' + encodeURIComponent(current.id), {
                method: 'PUT',
                body: JSON.stringify(payloadOf()),
              })
              props.onChanged()
            }),
          }, '保存'),
          h(NativeButton, { variant: 'ghost', icon: iconOf(ICONS.database, 14), onClick: () => props.onOpenMemory(current.id) }, '打开记忆'),
          h(NativeButton, {
            variant: 'outline',
            icon: iconOf(ICONS.trash, 14),
            disabled: busy || current.isDefault,
            onClick: () => {
              if (!window.confirm('删除助手「' + current.name + '」？记忆、技能归属与配置会一起删除。')) return
              run(async () => {
                await api('/assistants/' + encodeURIComponent(current.id), { method: 'DELETE' })
                setSelected('')
                props.onChanged()
              })
            },
          }, '删除')))

      return h('div', null,
        error ? h('div', { className: 'hk-err' }, error) : null,

        h(Section, {
          title: '助手',
          desc: rows.length + ' 个 · 助手就是人格：每个对话选一个助手，它带着自己的人格、记忆和技能',
          actions: h(NativeButton, {
            size: 'sm',
            variant: creating ? 'outline' : 'primary',
            icon: iconOf(creating ? null : ICONS.plus, 14),
            onClick: () => setCreating(v => !v),
          }, creating ? '取消' : '新建助手'),
        }, creating ? createForm : (agentRows.length === 0
          ? h('div', { className: 'hk-empty' }, '还没有助手。新建一个，它会有自己的人格、记忆和技能。')
          : h('div', { className: 'hk-rows' }, agentRows))),

        current === null ? null : h(Section, {
          title: '编辑：' + current.name,
          desc: '人格字段与记忆、技能都属于这个助手；改名不会动记忆',
          actions: h(NativeTag, { tone: current.broken ? 'danger' : 'success' }, current.broken ? '损坏' : '正常'),
        }, editBody),

        current === null ? null : h(Section, {
          title: '这个助手的技能',
          desc: '技能文件仍然在一个目录里，这里维护的是「归属」；在对话里也能调用别的助手的技能',
        }, h('div', { className: 'hk-row', style: { display: 'block' } }, skillChips)),
      )
    }

    /* ─────────────────────── 记忆 tab ─────────────────────── */

    function MemoryEntry(props) {
      const { entry, index, duplicateOf, pinned, onPin, onDelete } = props
      const [open, setOpen] = react.useState(false)
      const long = charCount(entry) > 180
      const [copied, setCopied] = react.useState(false)

      return h('div', { className: 'hk-entry' },
        h('div', { className: 'hk-entry-head' },
          h('span', null, '#' + (index + 1)),
          h(NativeTag, { tone: 'quiet' }, charCount(entry) + ' 字'),
          duplicateOf !== undefined ? h(NativeTag, { tone: 'warning' }, '与 #' + (duplicateOf + 1) + ' 重复') : null,
          h('span', { style: { flex: 1 } }),
          h(IconAction, ICONS.copy, copied ? '已复制' : '复制这条', async () => {
            await writeClipboard(entry)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }),
          h(IconAction, pinned ? ICONS.pinFilled : ICONS.pin, pinned ? '取消置顶' : '置顶这条', () => onPin(entry)),
          h(IconAction, ICONS.trash, '删除这条', () => onDelete(entry))),
        h('div', { className: 'hk-entry-body' + (long && !open ? ' hk-collapsed' : '') }, entry),
        long ? h('div', { className: 'hk-actions' },
          h(NativeButton, { size: 'sm', variant: 'ghost', onClick: () => setOpen(v => !v) }, open ? '收起' : '展开全文')) : null)
    }

    function MemoryTab(props) {
      const agentId = props.agentId
      const [state, setState] = react.useState({ loading: false, data: null, error: '' })
      const [target, setTarget] = react.useState('memory')
      const [action, setAction] = react.useState('add')
      const [content, setContent] = react.useState('')
      const [oldText, setOldText] = react.useState('')
      const [search, setSearch] = react.useState('')
      const [pinDraft, setPinDraft] = react.useState('')
      const [insightDraft, setInsightDraft] = react.useState('')
      const [insightConfidence, setInsightConfidence] = react.useState('60')
      const [insights, setInsights] = react.useState([])
      const [layerEditing, setLayerEditing] = react.useState('')
      const [layerDraft, setLayerDraft] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')

      const reload = react.useCallback(() => {
        if (!agentId) return
        setState(prev => ({ ...prev, loading: true, error: '' }))
        api('/memory/' + encodeURIComponent(agentId))
          .then(data => setState({ loading: false, data, error: '' }))
          .catch(e => setState({ loading: false, data: null, error: String(e && e.message ? e.message : e) }))
        api('/insights/' + encodeURIComponent(agentId))
          .then(data => setInsights(Array.isArray(data.insights) ? data.insights : []))
          .catch(() => setInsights([]))
      }, [agentId])

      react.useEffect(reload, [reload])

      const agentRows = props.overview ? props.overview.assistants || [] : []

      if (!agentId) {
        return h('div', { className: 'hk-section' }, h('div', { className: 'hk-empty' }, '先在「助手」里选一个助手 —— 记忆是每个助手独立的。'))
      }

      const data = state.data
      const status = data && data.status ? data.status : null
      const bucket = status ? status[target] : null
      const allEntries = bucket && Array.isArray(bucket.entries) ? bucket.entries : []
      const needle = search.trim().toLowerCase()
      const indexed = allEntries.map((entry, index) => ({ entry, index }))
      const visible = needle === '' ? indexed : indexed.filter(row => String(row.entry).toLowerCase().includes(needle))
      const duplicates = findDuplicates(allEntries)
      const pinned = data && Array.isArray(data.pinned) ? data.pinned : []
      const rolling = data && data.rolling ? data.rolling : {}
      const updatedAt = data && data.updatedAt ? data.updatedAt : {}
      const rollingFilled = ['today', 'week', 'longterm'].filter(layer => rolling[layer] && rolling[layer].exists).length
      const activeInsights = insights.filter(item => !item.retired)

      async function submit() {
        setError('')
        setBusy(true)
        try {
          await api('/memory/' + encodeURIComponent(agentId), {
            method: 'POST',
            body: JSON.stringify({ target, action, content, oldText: action === 'add' ? undefined : oldText }),
          })
          setContent('')
          setOldText('')
          reload()
          if (props.onChanged) props.onChanged()
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }

      async function writePinned(next) {
        setError('')
        try {
          await api('/pinned/' + encodeURIComponent(agentId), { method: 'POST', body: JSON.stringify({ list: next }) })
          reload()
          if (props.onChanged) props.onChanged()
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
      }

      async function addInsight() {
        const text = insightDraft.trim()
        if (text === '') return
        setError('')
        try {
          await api('/insights/' + encodeURIComponent(agentId), {
            method: 'POST',
            body: JSON.stringify({ text, confidence: Number(insightConfidence) || 50, kind: 'work', source: 'panel' }),
          })
          setInsightDraft('')
          reload()
          if (props.onChanged) props.onChanged()
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
      }

      async function retireInsight(insight) {
        setError('')
        try {
          await api('/insights/' + encodeURIComponent(agentId) + '/' + encodeURIComponent(insight.id), {
            method: 'PUT',
            body: JSON.stringify({ retired: true }),
          })
          reload()
          if (props.onChanged) props.onChanged()
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
      }

      async function saveLayer(layer, text) {
        setError('')
        try {
          await api('/memory/' + encodeURIComponent(agentId) + '/rolling', {
            method: 'POST',
            body: JSON.stringify({ target: layer, action: 'write', text }),
          })
          setLayerEditing('')
          setLayerDraft('')
          reload()
          if (props.onChanged) props.onChanged()
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
      }

      async function removeEntry(entry) {
        if (!window.confirm('删除这条记忆？')) return
        try {
          await api('/memory/' + encodeURIComponent(agentId), {
            method: 'POST',
            body: JSON.stringify({ target, action: 'remove', oldText: entry }),
          })
          reload()
          if (props.onChanged) props.onChanged()
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
      }

      function exportAll() {
        const lines = ['# ' + (props.agentName || agentId) + ' 记忆导出', '', '生成时间：' + new Date().toLocaleString(), '']
        if (pinned.length > 0) {
          lines.push('## 置顶', '')
          pinned.forEach(item => lines.push('- ' + item))
          lines.push('')
        }
        for (const key of ['memory', 'user']) {
          const cell = status ? status[key] : null
          lines.push('## ' + (key === 'memory' ? 'MEMORY 笔记' : 'USER 画像'), '')
          const each = cell && Array.isArray(cell.entries) ? cell.entries : []
          if (each.length === 0) lines.push('（空）')
          each.forEach(item => lines.push('- ' + item))
          lines.push('')
        }
        lines.push('## 分层摘要', '')
        for (const layer of ['today', 'week', 'longterm']) {
          const cell = rolling[layer] || { chars: 0, exists: false }
          lines.push('- ' + (ROLLING_LABEL[layer] || layer) + '：' + (cell.exists ? cell.chars + ' 字符' : '空'))
        }
        downloadMarkdown('hanako-memory-' + agentId + '.md', lines.join('\n'))
      }

      // ── 分层行 ──
      const layerRows = ['today', 'week', 'longterm'].map(layer => {
        const cell = rolling[layer] || { chars: 0, exists: false, updatedAt: 0 }
        const editingThis = layerEditing === layer
        if (editingThis) {
          return h('div', { key: layer, className: 'hk-row' },
            h('span', { className: 'hk-dot ' + (cell.exists ? 'ok' : 'idle') }),
            h('div', { className: 'hk-row-main' },
              h('div', { className: 'hk-row-title' }, ROLLING_LABEL[layer] || layer),
              h('textarea', {
                className: 'hk-textarea',
                value: layerDraft,
                placeholder: '写这一层（整层替换）。滚动层不进常驻预算，用来放跨会话结论。',
                onChange: e => setLayerDraft(e.target.value),
              }),
              h('div', { className: 'hk-actions' },
                h(NativeButton, { size: 'sm', variant: 'primary', onClick: () => saveLayer(layer, layerDraft) }, '保存这一层'),
                h(NativeButton, { size: 'sm', variant: 'ghost', onClick: () => { setLayerEditing(''); setLayerDraft('') } }, '取消'))))
        }
        return Row({
          rowKey: layer,
          tone: cell.exists ? 'ok' : 'idle',
          title: ROLLING_LABEL[layer] || layer,
          sub: cell.exists ? num(cell.chars) + ' 字符 · 更新 ' + relativeTime(cell.updatedAt) : '还没有内容',
          end: h(NativeButton, {
            size: 'sm',
            variant: 'ghost',
            icon: iconOf(ICONS.edit, 13),
            onClick: () => { setLayerEditing(layer); setLayerDraft('') },
          }, '写'),
        })
      })

      // ── 洞察行 ──
      const insightRows = insights.map(item => Row({
        rowKey: item.id,
        tone: item.retired ? 'idle' : item.confidence >= 75 ? 'ok' : item.confidence >= 45 ? 'info' : 'warn',
        title: h('span', { style: { textDecoration: item.retired ? 'line-through' : 'none', opacity: item.retired ? .6 : 1 } }, item.text),
        sub: '置信 ' + item.confidence + ' · ' + (item.kind || 'work') + (item.source ? ' · 来源 ' + item.source : '') + ' · ' + relativeTime(item.updatedAt),
        end: item.retired
          ? h(NativeTag, { tone: 'quiet' }, '已退休')
          : h(NativeButton, { size: 'sm', variant: 'ghost', onClick: () => retireInsight(item) }, '退休'),
      }))

      // ── 条目行 ──
      const entryRows = visible.map(row => {
        const dupOf = duplicates[row.index]
        const long = charCount(row.entry) > 180
        const isPinned = pinned.includes(row.entry)
        return h('div', { key: 'entry-' + row.index, className: 'hk-row', style: { alignItems: 'flex-start' } },
          h('div', { className: 'hk-row-main' },
            h('div', { className: 'hk-entry-head' },
              h('span', null, '#' + (row.index + 1)),
              h('span', null, charCount(row.entry) + ' 字'),
              dupOf !== undefined ? h(NativeTag, { tone: 'warning' }, '与 #' + (dupOf + 1) + ' 重复') : null,
              isPinned ? h(NativeTag, { tone: 'success' }, '已置顶') : null),
            h('div', { className: 'hk-entry-body' }, row.entry)),
          h('div', { className: 'hk-row-end' },
            h(IconAction, ICONS.copy, '复制这条', async () => { await writeClipboard(row.entry) }),
            h(IconAction, isPinned ? ICONS.pinFilled : ICONS.pin, isPinned ? '取消置顶' : '置顶这条',
              () => writePinned(isPinned ? pinned.filter(item => item !== row.entry) : [...pinned, row.entry])),
            h(IconAction, ICONS.trash, '删除这条', () => removeEntry(row.entry))))
      })

      return h('div', null,
        (error || state.error) ? h('div', { className: 'hk-err' }, error || state.error) : null,

        h(Section, {
          title: props.agentName || agentId,
          desc: '记忆是每个助手独立的；本会话注入的是冻结快照，写入下次会话生效',
          actions: [
            agentRows.length > 1 ? h('select', {
              key: 'pick',
              className: 'hk-textarea',
              style: { minHeight: 0, padding: '3px 6px', width: 'auto' },
              value: agentId,
              onChange: e => props.onPickAgent(e.target.value),
            }, agentRows.map(row => h('option', { key: row.id, value: row.id }, row.name))) : null,
            h(NativeButton, { key: 'r', size: 'sm', variant: 'ghost', icon: iconOf(ICONS.refresh, 14), onClick: reload }, '刷新'),
            h(NativeButton, { key: 'e', size: 'sm', variant: 'outline', icon: iconOf(ICONS.download, 14), onClick: exportAll }, '导出'),
          ],
        },
          h('div', { className: 'hk-row' },
            h('div', { className: 'hk-inline' },
              h(NativePill, { active: target === 'memory', onClick: () => setTarget('memory') }, 'MEMORY 笔记'),
              h(NativePill, { active: target === 'user', onClick: () => setTarget('user') }, 'USER 画像'))),
          bucket ? h('div', { className: 'hk-row', style: { display: 'block' } },
            h('div', { className: 'hk-inline', style: { justifyContent: 'space-between' } },
              h('span', { style: { fontSize: 19, fontWeight: 600 } }, bucket.used + ' / ' + bucket.limit + ' 字符'),
              h(NativeTag, { tone: bucket.pct >= 95 ? 'danger' : bucket.pct >= 75 ? 'warning' : 'success' }, bucket.pct + '%')),
            Bar({ pct: bucket.pct }),
            h('div', { className: 'hk-meta' },
              h('span', null, '剩余 ' + num(Math.max(0, bucket.limit - bucket.used)) + ' 字符'),
              h('span', null, '条目 ' + (needle === '' ? allEntries.length : visible.length + ' / ' + allEntries.length)),
              bucket.entryCount > 0 ? h('span', null, '平均 ' + Math.round(bucket.used / bucket.entryCount) + ' 字/条') : null,
              h('span', null, '最后更新 ' + relativeTime(updatedAt[target])))) : null),

        h(Section, {
          title: '分层摘要',
          desc: rollingFilled + ' / 3 层有内容 · 滚动层不进常驻预算',
        }, h('div', { className: 'hk-rows' }, layerRows)),

        h(Section, {
          title: '洞察',
          desc: activeInsights.length + ' 条有效 · Honcho 式推导结论，可被推翻',
        },
          insightRows.length === 0
            ? h('div', { className: 'hk-empty' }, '还没有洞察。洞察是从记忆里推导出的判断，不是事实；模型可以用 memory_insight 写，也可以在这里手写。')
            : h('div', { className: 'hk-rows' }, insightRows),
          h('div', { className: 'hk-row' },
            h('div', { className: 'hk-row-main' },
              h(NativeInput, {
                placeholder: '写一条洞察（推断，不是事实）…',
                value: insightDraft,
                onChange: e => setInsightDraft(e.target.value),
              })),
            h('select', {
              className: 'hk-textarea',
              style: { minHeight: 0, padding: '3px 6px', width: 'auto' },
              value: insightConfidence,
              onChange: e => setInsightConfidence(e.target.value),
            }, ['30', '50', '60', '75', '90'].map(value => h('option', { key: value, value }, '置信 ' + value))),
            h(NativeButton, { size: 'sm', variant: 'outline', disabled: insightDraft.trim() === '', onClick: addInsight }, '添加'))),

        h(Section, {
          title: '置顶',
          desc: pinned.length + ' 条 · 永远最高优先级注入，建议 1–3 条硬约束',
        },
          pinned.length === 0
            ? h('div', { className: 'hk-empty' }, '还没有置顶。置顶适合放「改文件前先备份」这种硬约束。')
            : h('div', { className: 'hk-rows' }, pinned.map((item, index) => Row({
              rowKey: 'pin-' + index,
              tone: 'ok',
              title: item,
              end: h(IconAction, ICONS.trash, '取消置顶', () => writePinned(pinned.filter((_, i) => i !== index))),
            }))),
          h('div', { className: 'hk-row' },
            h('div', { className: 'hk-row-main' },
              h(NativeInput, {
                placeholder: '加一条置顶（例如：改文件前先备份）',
                value: pinDraft,
                onChange: e => setPinDraft(e.target.value),
              })),
            h(NativeButton, { size: 'sm', variant: 'outline', disabled: pinDraft.trim() === '', onClick: () => { writePinned([...pinned, pinDraft.trim()]); setPinDraft('') } }, '置顶'))),

        h(Section, {
          title: '条目',
          desc: (needle === '' ? allEntries.length : visible.length + ' / ' + allEntries.length) + ' 条' +
            (Object.keys(duplicates).length > 0 ? ' · 发现 ' + Object.keys(duplicates).length + ' 条可能重复' : ' · 没有重复'),
          actions: h('div', { style: { width: 200 } },
            h(NativeInput, {
              icon: iconOf(ICONS.search, 14),
              placeholder: '搜索条目',
              value: search,
              onChange: e => setSearch(e.target.value),
            })),
        }, state.loading
          ? h('div', { className: 'hk-empty' }, '加载中…')
          : allEntries.length === 0
            ? h('div', { className: 'hk-empty' }, '这个库里还没有内容。可以让模型写，也可以在下面手动加。')
            : visible.length === 0
              ? h('div', { className: 'hk-empty' }, '没有匹配「' + search + '」的条目。')
              : h('div', { className: 'hk-rows' }, entryRows)),

        h(Section, {
          title: '写入',
          desc: '写入前会校验注入模式与字符预算；超限整批回滚，不会只写一半',
        },
          h('div', { className: 'hk-row' },
            h('div', { className: 'hk-inline' },
              h(NativePill, { active: action === 'add', onClick: () => setAction('add') }, '新增'),
              h(NativePill, { active: action === 'replace', onClick: () => setAction('replace') }, '替换'),
              h(NativePill, { active: action === 'remove', onClick: () => setAction('remove') }, '删除'))),
          action !== 'add' ? h('div', { className: 'hk-row' },
            h('div', { className: 'hk-row-main' },
              h('div', { className: 'hk-label' }, '匹配哪条（唯一片段）'),
              h(NativeInput, { value: oldText, onChange: e => setOldText(e.target.value) }))) : null,
          action !== 'remove' ? h('div', { className: 'hk-row' },
            h('div', { className: 'hk-row-main' },
              h('div', { className: 'hk-label' }, '内容'),
              h('textarea', { className: 'hk-textarea', value: content, onChange: e => setContent(e.target.value) }))) : null,
          h('div', { className: 'hk-row' },
            h(NativeButton, { variant: 'primary', disabled: busy, onClick: submit }, busy ? '保存中…' : '保存'),
            h('span', { className: 'hk-meta' }, bucket ? '上限 ' + bucket.limit + ' 字符' : ''))),
      )
    }

    /* ─────────────────────── 技能 tab ─────────────────────── */

    /**
     * 技能 tab：按助手分区。
     *
     * 用户的要求：每个助手的技能要分开显示，但本质上「可以调用别人的技能」——
     * 所以这里是「归属视图」：同一个全局技能目录，按 `assistant.skills` 分区显示，
     * 没归属的进「未归属」，随时可以分配给某个助手。
     */
    function SkillsTab() {
      const [state, setState] = react.useState({
        loading: true, list: [], roots: [], audit: null, assistants: [], error: '',
      })
      const [open, setOpen] = react.useState('')
      const [detail, setDetail] = react.useState(null)
      const [search, setSearch] = react.useState('')
      const [error, setError] = react.useState('')
      const [assignPick, setAssignPick] = react.useState({})

      const reload = react.useCallback(() => {
        setState(prev => ({ ...prev, loading: true }))
        Promise.all([
          api('/skills'),
          api('/skills/audit').catch(() => null),
          api('/assistants').catch(() => ({ assistants: [] })),
        ])
          .then(([data, audit, assistants]) => setState({
            loading: false,
            list: data.skills || [],
            roots: data.roots || [],
            audit: audit && audit.ok && audit.summary ? audit : null,
            assistants: assistants.assistants || [],
            error: '',
          }))
          .catch(e => setState(prev => ({ ...prev, loading: false, error: String(e && e.message ? e.message : e) })))
      }, [])

      react.useEffect(reload, [reload])

      async function toggle(skillName) {
        if (open === skillName) { setOpen(''); return }
        setError('')
        try {
          const hit = await api('/skills/' + encodeURIComponent(skillName))
          setDetail(hit)
          setOpen(skillName)
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
      }

      async function assign(assistant, skillName, remove) {
        setError('')
        try {
          const current = Array.isArray(assistant.skills) ? assistant.skills : []
          const next = remove ? current.filter(item => item !== skillName) : [...current, skillName]
          await api('/assistants/' + encodeURIComponent(assistant.id), {
            method: 'PUT',
            body: JSON.stringify({ skills: next }),
          })
          reload()
        } catch (e) { setError(String(e && e.message ? e.message : e)) }
      }

      const needle = search.trim().toLowerCase()
      const matches = item => needle === '' || String(item.name).toLowerCase().includes(needle) ||
        String(item.description || '').toLowerCase().includes(needle) ||
        String(item.whenToUse || '').toLowerCase().includes(needle)

      const skillsByName = new Map(state.list.map(item => [item.name, item]))
      const claimed = new Set()
      for (const assistant of state.assistants) for (const name of assistant.skills || []) claimed.add(name)
      const unassigned = state.list.filter(item => !claimed.has(item.name) && matches(item))
      const audit = state.audit

      const skillRow = (assistant, name, removable) => {
        const item = skillsByName.get(name) || { name }
        return Row({
          rowKey: (assistant ? assistant.id : 'un') + ':' + name,
          tone: item.updatedAt && Date.now() - item.updatedAt > 180 * 86400e3 ? 'warn' : 'ok',
          title: [name, item.chars ? h(NativeTag, { key: 'c', tone: 'quiet' }, num(item.chars) + ' 字') : null],
          sub: [
            item.description || '（没有描述）',
            item.whenToUse ? h('span', { key: 'w', className: 'hk-sub', style: { margin: 0 } }, ' · 何时用：' + item.whenToUse) : null,
          ],
          end: [
            h('span', { key: 't', className: 'hk-num' }, relativeTime(item.updatedAt)),
            h(NativeButton, { key: 'v', size: 'sm', variant: 'ghost', onClick: () => toggle(name) }, open === name ? '收起' : '查看'),
            removable
              ? h(NativeButton, { key: 'r', size: 'sm', variant: 'ghost', onClick: () => assign(assistant, name, true) }, '移出')
              : null,
            !removable && state.assistants.length > 0
              ? h('select', {
                key: 'a',
                className: 'hk-textarea',
                style: { minHeight: 0, padding: '3px 6px', width: 'auto', maxWidth: 130 },
                value: assignPick[name] || '',
                onChange: e => {
                  const target = e.target.value
                  setAssignPick(prev => ({ ...prev, [name]: target }))
                  if (target === '') return
                  const assistantTarget = state.assistants.find(row => row.id === target)
                  if (assistantTarget !== undefined) assign(assistantTarget, name, false)
                },
              },
                h('option', { value: '' }, '分配给…'),
                state.assistants.map(row => h('option', { key: row.id, value: row.id }, row.name)))
              : null,
          ],
          onClick: () => toggle(name),
        })
      }

      const assistantSections = state.assistants.map(assistant => {
        const own = (assistant.skills || []).filter(name => matches(skillsByName.get(name) || { name }))
        return h(Section, {
          key: 'as-' + assistant.id,
          title: assistant.name,
          desc: own.length + ' 个技能 · 这个助手专属',
          actions: h(NativeTag, { key: 'n', tone: own.length > 0 ? 'success' : 'quiet' }, own.length + ' 个'),
        }, own.length === 0
          ? h('div', { className: 'hk-empty' }, '还没有给这个助手分配技能；在下面「未归属」里挑一个分配给它。')
          : h('div', { className: 'hk-rows' }, own.map(name => skillRow(assistant, name, true))))
      })

      return h('div', null,
        (error || state.error) ? h('div', { className: 'hk-err' }, error || state.error) : null,

        h(Section, {
          title: '技能体检',
          desc: audit
            ? 'error ' + audit.summary.error + ' · warning ' + audit.summary.warning + ' · info ' + audit.summary.info + ' · 共 ' + num(audit.summary.totalChars) + ' 字符'
            : '体检不可用（老版本 host）',
          actions: [
            h(NativeTag, {
              key: 's',
              tone: !audit ? 'neutral' : audit.summary.error > 0 ? 'danger' : audit.summary.findings > 0 ? 'warning' : 'success',
            }, !audit ? '—' : (audit.summary.findings === 0 ? '通过' : audit.summary.findings + ' 条发现')),
            h(NativeButton, { key: 'r', size: 'sm', variant: 'ghost', icon: iconOf(ICONS.refresh, 14), onClick: reload }, '重新体检'),
          ],
        },
          h('div', { className: 'hk-row' },
            h('div', { className: 'hk-row-main' },
              h(NativeInput, {
                icon: iconOf(ICONS.search, 14),
                placeholder: '搜索技能（名字 / 描述 / 何时用）',
                value: search,
                onChange: e => setSearch(e.target.value),
              }))),
          (audit ? (audit.findings || []).slice(0, 6) : []).map((finding, index) => Row({
            rowKey: 'audit-' + index,
            tone: finding.severity === 'error' ? 'err' : finding.severity === 'warning' ? 'warn' : 'idle',
            title: finding.skill,
            sub: finding.detail + ' → ' + finding.suggestion,
            end: h(NativeTag, { tone: finding.severity === 'error' ? 'danger' : finding.severity === 'warning' ? 'warning' : 'quiet' }, finding.kind),
          }))),

        state.loading
          ? h(Section, { title: '技能' }, h('div', { className: 'hk-empty' }, '加载中…'))
          : h('div', null, assistantSections),

        h(Section, {
          title: '未归属技能',
          desc: unassigned.length + ' 个 · 还没有分配给任何助手（任何助手仍可调用）',
        }, unassigned.length === 0
          ? h('div', { className: 'hk-empty' }, '没有未归属的候选技能。')
          : h('div', { className: 'hk-rows' }, unassigned.map(item => skillRow(null, item.name, false)))),

        open !== '' && detail
          ? h(Section, { title: '技能全文：' + open }, h('div', { className: 'hk-row', style: { display: 'block' } },
            h('div', { className: 'hk-entry-body hk-mono', style: { maxHeight: 320, overflow: 'auto', fontSize: 11 } }, detail.content)))
          : null,

        h(Section, { title: '技能根目录', desc: '按优先级排列：写入总是进第一项' },
          state.roots.length === 0
            ? h('div', { className: 'hk-empty' }, '—')
            : h('div', { className: 'hk-rows' }, state.roots.map((root, index) => Row({
              rowKey: root,
              tone: index === 0 ? 'ok' : 'idle',
              title: index === 0 ? '写入根' : '只读根',
              sub: h(NativePathLabel, { path: root }),
            })))),
      )
    }

    /* ─────────────────────── 渲染错误边界 ─────────────────────── */

    /**
     * 面板渲染出错时不要白屏：把错误显示出来 + 回报 host（`/client-report` → `/diag`）。
     *
     * 注意 children 必须作为第三个参数传：`h('div', child)` 会把 child 当 props，
     * 渲染出一个空 div —— 这正是 2026-10-24「面板点了没反应」的根因。
     */
    class PanelBoundary extends react.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try {
          report({
            mounted: true,
            ui: UI_VERSION,
            primitives: usingPrimitives,
            panelError: String((error && error.message) || error),
            panelStack: String((info && info.componentStack) || '').slice(0, 400),
          })
        } catch { /* 回报失败不影响兜底 UI */ }
      }

      render() {
        if (this.state.error !== null) {
          const message = String((this.state.error && this.state.error.message) || this.state.error)
          return h('div', { className: 'hk-page' },
            h('div', { className: 'hk-err' },
              '面板渲染出错（插件其余功能不受影响）：',
              h('div', { className: 'hk-mono', style: { marginTop: 6 } }, message)),
            h('div', { className: 'hk-actions' },
              h(NativeButton, { variant: 'outline', onClick: () => this.setState({ error: null }) }, '重试渲染'),
              h(NativeButton, { variant: 'ghost', onClick: () => { if (typeof window !== 'undefined') window.location.reload() } }, '重载页面')))
        }
        return h('div', null, this.props.children)
      }
    }

    /** 把页面包进错误边界（侧栏 main 与设置页 tab 都用这个）。 */
    function HanakoPageSafe() {
      return h(PanelBoundary, null, h(HanakoPage))
    }

    /* ─────────────────────── 市场 tab（腾讯 SkillHub） ─────────────────────── */

    const MARKET_CATEGORY_FALLBACK = [
      { key: '', name: '全部' },
    ]

    function MarketTab(props) {
      const [state, setState] = react.useState({
        status: null, categories: [], results: [], query: '', mode: 'rankings',
        loading: true, error: '', installing: '', message: '', category: '',
      })
      const [installed, setInstalled] = react.useState([])

      const loadSkills = react.useCallback(() => {
        api('/skills')
          .then(data => setInstalled((data.skills || []).map(item => String(item.name))))
          .catch(() => setInstalled([]))
      }, [])

      const loadRankings = react.useCallback(() => {
        setState(prev => ({ ...prev, loading: true, error: '', mode: 'rankings' }))
        Promise.all([api('/market/status'), api('/market/rankings')])
          .then(([status, rankings]) => setState(prev => ({
            ...prev,
            status,
            categories: rankings.categories || [],
            results: rankings.results || [],
            loading: false,
          })))
          .catch(e => setState(prev => ({ ...prev, loading: false, error: String(e && e.message ? e.message : e) })))
      }, [])

      react.useEffect(() => {
        loadSkills()
        loadRankings()
      }, [loadRankings, loadSkills])

      function runSearch(query) {
        const words = String(query ?? '').trim()
        if (words === '') { loadRankings(); return }
        setState(prev => ({ ...prev, loading: true, error: '', mode: 'search', query: words }))
        api('/market/search?q=' + encodeURIComponent(words) + '&limit=30')
          .then(data => setState(prev => ({
            ...prev,
            results: data.results || [],
            loading: false,
            category: '',
          })))
          .catch(e => setState(prev => ({ ...prev, loading: false, error: String(e && e.message ? e.message : e) })))
      }

      async function install(item) {
        setState(prev => ({ ...prev, installing: item.canonical || item.slug, message: '' }))
        try {
          await api('/market/install', {
            method: 'POST',
            body: JSON.stringify({ slug: item.slug, namespace: item.namespace }),
          })
          setState(prev => ({ ...prev, installing: '', message: '已安装：' + item.name }))
          loadSkills()
          if (props.onChanged) props.onChanged()
        } catch (e) {
          setState(prev => ({ ...prev, installing: '', error: String(e && e.message ? e.message : e) }))
        }
      }

      const isInstalled = item => installed.some(name =>
        name === item.slug || name === item.name || name === item.canonical || name.startsWith(item.slug))

      const categories = state.mode === 'rankings' && state.categories.length > 0
        ? [{ key: '', name: '精选', count: state.results.length }].concat(state.categories)
        : MARKET_CATEGORY_FALLBACK

      const visible = state.category === ''
        ? state.results
        : state.results.filter(item => item.category === state.category)

      const rows = visible.map(item => Row({
        rowKey: item.canonical || item.slug,
        tone: item.verified ? 'ok' : 'info',
        title: [item.name,
          item.verified ? h(NativeTag, { key: 'v', tone: 'success' }, '认证') : null,
          item.version ? h(NativeTag, { key: 'ver', tone: 'quiet' }, 'v' + item.version) : null],
        sub: [
          item.description || '（没有描述）',
          item.publisher ? h('span', { key: 'p', className: 'hk-sub', style: { margin: 0 } }, ' · ' + item.publisher) : null,
        ],
        end: [
          item.downloads > 0
            ? h('span', { key: 'd', className: 'hk-num' }, num(item.downloads) + ' 下载')
            : null,
          isInstalled(item)
            ? h(NativeTag, { key: 'i', tone: 'neutral' }, '已安装')
            : h(NativeButton, {
              key: 'install',
              size: 'sm',
              variant: 'primary',
              disabled: state.installing !== '',
              onClick: () => install(item),
            }, state.installing === (item.canonical || item.slug) ? '安装中…' : '安装'),
        ],
      }))

      const unavailable = state.status !== null && state.status.available === false

      return h('div', null,
        state.error ? h('div', { className: 'hk-err' }, state.error) : null,
        state.message ? h('div', { className: 'hk-sub', style: { marginBottom: 8 } }, state.message) : null,

        h(Section, {
          title: '技能市场',
          desc: unavailable
            ? '未找到 skillhub 命令行（腾讯 SkillHub）。装好 CLI 后这里就能搜索与安装。'
            : '来自腾讯 SkillHub：搜索或从榜单里挑，装上就直接进你的技能库（' + (state.status ? state.status.skillsRoot : '') + '）',
          actions: [
            h('div', { key: 'q', style: { width: 220 } },
              h(NativeInput, {
                icon: iconOf(ICONS.search, 14),
                placeholder: '搜索技能，回车',
                value: state.query,
                onChange: e => setState(prev => ({ ...prev, query: e.target.value })),
                onKeyDown: e => { if (e && e.key === 'Enter') runSearch(e.currentTarget ? e.currentTarget.value : state.query) },
              })),
            h(NativeButton, { key: 'r', size: 'sm', variant: 'ghost', icon: iconOf(ICONS.refresh, 14), onClick: loadRankings }, '刷新'),
          ],
        },
          h('div', { className: 'hk-row' },
            h('div', { className: 'hk-inline' },
              categories.map(cat => h(NativePill, {
                key: cat.key || 'featured',
                active: state.category === cat.key,
                onClick: () => setState(prev => ({ ...prev, category: cat.key })),
              }, cat.name + (cat.count ? ' ' + cat.count : ''))))),

          state.loading
            ? h('div', { className: 'hk-empty' }, '正在从市场取数据…')
            : unavailable
              ? h('div', { className: 'hk-empty' }, '未找到 skillhub CLI：把它装到 ~/.local/bin/skillhub，或设置 SKILLHUB_BIN 环境变量。')
              : rows.length === 0
                ? h('div', { className: 'hk-empty' }, state.mode === 'search' ? '没搜到技能，换个词试试。' : '市场暂时没有返回内容。')
                : h('div', { className: 'hk-rows' }, rows)),
      )
    }

    /* ─────────────────────── 页面（四个 tab） ─────────────────────── */

    const TABS = [
      { value: 'overview', label: '总览' },
      { value: 'assistants', label: '助手' },
      { value: 'memory', label: '记忆' },
      { value: 'skills', label: '技能' },
    ]

    /**
     * 面板高度适配。
     *
     * 宿主的槽位容器是 `height: 0; overflow: visible`，它的父级 `centerCol` 是
     * `height: 820; overflow: hidden` —— 所以 CSS `height:100%` / `max-height:100%`
     * 都解析不出可滚动高度（实测 `.hk-page` clientHeight === scrollHeight === 1480，
     * 但可见窗口只有 820，于是内容被裁掉、滚不动）。
     *
     * 这里改成 JS 实测：向上找第一个「有高度且 overflow 不是 visible」的祖先，
     * 用它的底边减我们的顶边当作可用高度，写进 style.maxHeight，自己内部滚动。
     * 窗口 resize / ResizeObserver 都会重算。
     */
    function useAvailableHeight(ref, deps) {
      const [maxHeight, setMaxHeight] = react.useState(0)
      react.useEffect(() => {
        if (typeof window === 'undefined') return undefined
        let disposed = false
        const measure = () => {
          if (disposed) return
          const el = ref.current
          if (!el) return
          const own = el.getBoundingClientRect()
          let node = el.parentElement
          let limit = 0
          while (node !== null && node !== document.body) {
            const style = window.getComputedStyle(node)
            if (node.clientHeight > 0 && (style.overflowY === 'hidden' || style.overflowY === 'auto')) {
              limit = node.getBoundingClientRect().bottom - own.top - 8
              break
            }
            node = node.parentElement
          }
          if (limit <= 0) limit = window.innerHeight - own.top - 16
          // 容器太矮（例如被塞进设置弹窗里）就不要硬塞一个 240px 的下限 ——
          // 那会让内容比容器还高、上下都被裁掉，用户只能看到中间一截。
          // 这时交给外层滚动（不设 max-height）。
          setMaxHeight(limit >= 280 ? Math.min(Math.round(limit), window.innerHeight) : 0)
        }
        measure()
        const timer = setTimeout(measure, 250)
        // 容器可能在挂载后才从「隐藏/小弹窗/侧栏」切换过来，前 4 秒多量几次
        const timers = [600, 1200, 2400, 4000].map(ms => setTimeout(measure, ms))
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
        if (ro !== null) {
          let cursor = ref.current && ref.current.parentElement
          while (cursor !== null && cursor !== document.body) { ro.observe(cursor); cursor = cursor.parentElement }
        }
        window.addEventListener('resize', measure)
        return () => {
          disposed = true
          clearTimeout(timer)
          for (const handle of timers) clearTimeout(handle)
          if (ro !== null) ro.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, deps || [])
      return maxHeight
    }

    function HanakoPage() {
      const [tab, setTab] = react.useState('overview')
      const [agentId, setAgentId] = react.useState('')
      const pageRef = react.useRef(null)
      const bodyRef = react.useRef(null)
      const [state, setState] = react.useState({ loading: true, overview: null, personas: [], error: '' })
      const [editingPersona, setEditingPersona] = react.useState('')
      const [insightCount, setInsightCount] = react.useState(0)

      const reload = react.useCallback(() => {
        setState(prev => ({ ...prev, loading: true }))
        Promise.all([
          api('/overview'),
          api('/personas').catch(() => ({ personas: [] })),
          api('/skills/audit').catch(() => null),
        ])
          .then(([overview, personas, audit]) => setState({
            loading: false,
            overview,
            personas: personas.personas || [],
            skillStats: audit && audit.ok && audit.summary ? audit.summary : null,
            error: '',
          }))
          .catch(e => setState({ loading: false, overview: null, error: String(e && e.message ? e.message : e) }))
      }, [])

      react.useEffect(() => {
        ensureStyles()
        reload()
      }, [reload])

      // 当前助手切换时拉一次洞察条数（Provider 行要用）
      react.useEffect(() => {
        if (agentId === '') { setInsightCount(0); return }
        api('/insights/' + encodeURIComponent(agentId))
          .then(data => setInsightCount((data.insights || []).filter(item => !item.retired).length))
          .catch(() => setInsightCount(0))
      }, [agentId])

      react.useEffect(() => {
        if (agentId !== '') return
        const overview = state.overview
        if (!overview || !Array.isArray(overview.assistants) || overview.assistants.length === 0) return
        const preferred = overview.assistants.find(item => item.isDefault) || overview.assistants[0]
        setAgentId(preferred.id)
      }, [state.overview, agentId])

      const rows = state.overview ? state.overview.assistants || [] : []
      const agentName = id => {
        const hit = rows.find(item => item.id === id)
        return hit ? hit.name : id
      }
      const openMemory = id => { setAgentId(id); setTab('memory') }

      const totals = state.overview && state.overview.totals ? state.overview.totals : null
      const maxHeight = useAvailableHeight(pageRef, [tab])
      // 切 tab 回到顶部：否则会停在上一页的滚动位置，看着像「只剩下面一截」
      react.useEffect(() => {
        if (bodyRef.current !== null && typeof bodyRef.current.scrollTo === 'function') {
          bodyRef.current.scrollTo({ top: 0 })
        } else if (bodyRef.current !== null) {
          bodyRef.current.scrollTop = 0
        }
      }, [tab])
      return h('div', {
        className: 'hk-page',
        ref: pageRef,
        style: maxHeight > 0 ? { maxHeight: maxHeight + 'px' } : null,
      },
        h('div', { className: 'hk-head' },
        h('div', { className: 'hk-masthead' },
          h('div', null,
            h('div', { className: 'hk-masthead-title' }, '助手与记忆'),
            h('div', { className: 'hk-masthead-meta' },
              h('span', null, rows.length + ' 个助手'),
              totals ? h('span', null, '·') : null,
              totals ? h('span', null, num(totals.skills) + ' 个技能') : null,
              totals ? h('span', null, '·') : null,
              totals ? h('span', null, '记忆 ' + ((totals.memory && totals.memory.pct) || 0) + '%') : null)),
          h('div', { className: 'hk-masthead-actions' },
            state.loading ? h('span', { className: 'hk-masthead-meta' }, '同步中…') : null)),

        h('div', { className: 'hk-tabs', role: 'tablist', 'aria-label': '助手与记忆分区' },
          TABS.map(item => h('button', {
            key: item.value,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === item.value,
            className: 'hk-tab' + (tab === item.value ? ' on' : ''),
            onClick: () => setTab(item.value),
          }, item.label)))),

        h('div', { className: 'hk-body', ref: bodyRef },
        state.error ? h('div', { className: 'hk-err' }, state.error) : null,

        tab === 'overview' ? h(OverviewTab, {
          overview: state.overview,
          error: state.error,
          personas: state.personas,
          skillStats: state.skillStats,
          insightCount,
          agentId,
          agentName,
          currentAgentName: agentName(agentId),
          onReload: reload,
          onOpenMemory: openMemory,
          onOpenTab: setTab,
        }) : null,
        tab === 'assistants' ? h(AssistantsTab, {
          overview: state.overview,
          personas: state.personas,
          agentId,
          onChanged: reload,
          onOpenMemory: openMemory,
        }) : null,
        tab === 'memory' ? h(MemoryTab, {
          agentId,
          overview: state.overview,
          agentName: agentName(agentId),
          onPickAgent: setAgentId,
          onChanged: reload,
        }) : null,
        tab === 'skills' ? h(SkillsTab) : null,
        ),
      )
    }

    /* ─────────────────────── 输入框「技能」入口 ─────────────────────── */

    /** SkillDock 最近一次从槽位拿到的 inputActions（命令贡献的兜底插入通道）。 */
    let lastInputActions = null

    /** conversation 服务（宿主 ui-conversation 提供），命令贡献里用来定位会话输入壳。 */
    let conversationService = null

    /** apply 阶段的错误（挂载失败时填），之后任何回报都自带，便于定位「为什么没渲染」。 */
    let lastApplyError = ''

    /** mount 时捕获的 slots 服务（自检用：直接读槽位占用情况）。 */
    let slotsRef = null

    /** 最近一次注册成功的槽位清单 + 命令贡献状态（自检回报用）。 */
    let registeredRef = []
    let commandUiProbe = null

    /** 一条技能插入到输入框时的文本：抄宿主 skill 选择器的官方语义 `/<name> `。 */
    function skillLine(skillName) {
      return '/' + String(skillName) + ' '
    }

    /** 命令贡献的图标：宿主用 createElement(icon, { size }) 渲染，所以必须是组件。 */
    function SkillGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 14
      const icon = iconOf(ICONS.skill, size)
      if (icon !== null) return icon
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M6 4.5h9.5L19 8v11.5H6z' }),
        h('path', { d: 'M9 10h7M9 13.5h5' }))
    }

    /**
     * `conversation.input.left`：composer 工具行左侧的紧凑控件（和「＋」同一行）。
     *
     * 点开是一个技能列表；选中后**插入到光标处**：
     * - `inputActions.captureInsertion()` 取游标快照（含 draftRev）
     * - `inputActions.insertText(text, span)` 插入；draftRev 变了返回 false（草稿被改过，丢弃这次插入）
     * - 没有 inputActions 时退化到 `setDraft(draft + text)`，再不行就提示
     *
     * 为什么不用 `useInput` 读草稿：这里只需要「插入」，读草稿会让组件多一层订阅，
     * 而 `captureInsertion + insertText` 本身就是宿主给的正规插入通道。
     */
    function SkillDock(props) {
      const actions = props && props.inputActions ? props.inputActions : null
      if (actions !== null) lastInputActions = actions
      const [open, setOpen] = react.useState(false)
      const [state, setState] = react.useState({ loading: false, skills: [], error: '' })
      const [notice, setNotice] = react.useState('')

      react.useEffect(() => { ensureStyles() }, [])

      const load = react.useCallback(() => {
        setState(prev => ({ ...prev, loading: true }))
        api('/skills')
          .then(data => setState({ loading: false, skills: data.skills || [], error: '' }))
          .catch(e => setState({ loading: false, skills: [], error: String(e && e.message ? e.message : e) }))
      }, [])

      function openPop() {
        const next = !open
        setOpen(next)
        setNotice('')
        if (next && state.skills.length === 0) load()
      }

      /**
       * 把技能插进草稿（光标处优先）。
       *
       * 文本格式抄宿主自己的 skill 选择器：`/<skill-name> `（ui-skill 就是这么插入的），
       * 这样和用户手打或宿主弹窗选出来的结果完全一致。
       */
      function insert(skill) {
        const line = skillLine(skill.name)
        try {
          if (actions && typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
            const span = actions.captureInsertion()
            const inserted = actions.insertText(line, span)
            if (inserted === false) {
              setNotice('草稿刚被修改过，请再点一次')
              return
            }
            setOpen(false)
            return
          }
          if (actions && typeof actions.setDraft === 'function') {
            actions.setDraft(line)
            setOpen(false)
            return
          }
          setNotice('拿不到输入框（宿主未提供 inputActions）')
        } catch (error) {
          setNotice(String(error && error.message ? error.message : error))
        }
      }

      const label = '插入技能'
      return h('span', { className: 'hk-dock' },
        h(NativeButton, {
          size: 'sm',
          variant: 'ghost',
          icon: iconOf(ICONS.skill, 16),
          title: label,
          'aria-label': label,
          onClick: openPop,
        }, '技能'),

        open ? h('div', { className: 'hk-pop' },
          h('div', { className: 'hk-pop-head' }, '插入技能'),
          state.loading ? h('div', { className: 'hk-empty' }, '加载中…') : null,
          state.error ? h('div', { className: 'hk-err' }, state.error) : null,
          !state.loading && !state.error && state.skills.length === 0
            ? h('div', { className: 'hk-empty' }, '还没有技能。到面板「技能」tab 看怎么让模型写进来。')
            : null,
          state.skills.map(skill => h('button', {
            key: skill.name,
            type: 'button',
            className: 'hk-pop-item',
            onClick: () => insert(skill),
          },
            h('span', { style: { flex: 'none', marginTop: 1, opacity: .8 } }, iconOf(ICONS.skill, 14)),
            h('span', { className: 'hk-pop-item-main' },
              h('div', { className: 'hk-pop-name' }, skill.name),
              skill.description ? h('div', { className: 'hk-pop-desc' }, skill.description) : null))),
          notice ? h('div', { className: 'hk-pop-foot' }, notice) : null,
          h('div', { className: 'hk-pop-foot' }, '插入到光标处；技能在面板「技能」tab 管理')) : null)
    }

    /**
     * 零 UI 桥：宿主只在 session 作用域槽位的 props 里给 `inputActions`，
     * 而「＋」菜单的命令贡献在槽位之外执行。挂一个渲染 null 的桥，
     * 把最近一次的 action 面存到模块级，让菜单里选技能时能插到光标处。
     *
     * 渲染 null = 用户看不到任何多余按钮（之前那一版在工具行加按钮，被否掉了）。
     */
    function InputActionBridge(props) {
      react.useEffect(() => {
        if (props && props.inputActions) lastInputActions = props.inputActions
      }, [props && props.inputActions])
      return null
    }

    /* ─────────────────────── 挂载 ─────────────────────── */

    /**
     * 侧栏图标：宿主拥有按钮，这里只提供图标（ownerProps: {size, active}）。
     *
     * 用**简笔画 SVG**（一个人 + 一张便签），不再用 emoji：
     * emoji 在深浅主题下颜色不受控，也和宿主其它线性图标不成体系。
     */
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
      const active = props && props.active === true
      react.useEffect(() => { ensureStyles() }, [])
      const edge = Math.round(size * 0.92)
      return h('span', {
        style: {
          display: 'grid',
          placeItems: 'center',
          width: size,
          height: size,
          lineHeight: 1,
          opacity: active ? 1 : 0.7,
        },
        title: '助手与记忆',
        'aria-label': '助手与记忆',
      }, h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('circle', { cx: 8.5, cy: 8, r: 3 }),
        h('path', { d: 'M3 19c.5-3.1 2.7-5 5.5-5s5 1.9 5.5 5' }),
        h('path', { d: 'M16.5 6.5h4.5v11h-4.5' }),
        h('path', { d: 'M18.8 9.5h1.4M18.8 12.2h1.4' }))
      )
    }

    /**
     * 自检探针（可随时删）：技能库里出现哨兵技能 `__panel-probe__` 时，把主面板切到前台一次并回报。
     *
     * 为什么需要：调试面板必须能「自己看到它」——我没有点击宿主窗口的权限，
     * 只能借这条链路把面板打开再截图。删掉哨兵技能即失效。
     */
    /**
     * 错误回传网：把 console.error / window.onerror / unhandledrejection 里
     * 和本插件有关的前几条回传给 host，这样「面板静默不渲染」时我也能在 /diag 看到原因。
     * 只抓前 3 条，避免刷屏。
     */
    let errorNetInstalled = false
    function installErrorNet() {
      if (errorNetInstalled || typeof window === 'undefined') return
      errorNetInstalled = true
      let budget = 3
      const send = (kind, text) => {
        if (budget <= 0) return
        budget -= 1
        report({ errorNet: kind + ': ' + String(text || '').slice(0, 320) })
      }
      try {
        const original = console.error
        console.error = function patched(...args) {
          try {
            const text = args.map(item => (item && item.message) || String(item)).join(' ').slice(0, 320)
            if (/hanako|hk-|panel|slot/i.test(text)) send('console.error', text)
          } catch { /* 忽略 */ }
          return original.apply(this, args)
        }
        window.addEventListener('error', event => {
          const text = String((event && event.message) || '')
          if (/hanako|hk-|panel|slot/i.test(text)) send('window.error', text)
        })
        window.addEventListener('unhandledrejection', event => {
          const reason = event && event.reason
          const text = String((reason && reason.message) || reason || '')
          if (/hanako|hk-|panel|slot/i.test(text)) send('unhandledrejection', text)
        })
      } catch { /* 装不上就算了 */ }
    }

    function probePanel(ctx) {
      if (typeof fetch !== 'function') return
      // 每个页面会话只自动开一次（避免每次热重载/切会话都强行抢走主面板）
      try {
        if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('hk-probe-done:' + UI_VERSION) === '1') return
      } catch { /* 无 storage 时保持原行为 */ }
      fetch('/hanako-memory/skills')
        .then(response => response.text())
        .then(text => {
          const data = JSON.parse(text)
          const hit = (data.skills || []).some(skill => skill.name === '__panel-probe__')
          if (!hit) return
          try {
            if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('hk-probe-done:' + UI_VERSION, '1')
          } catch { /* 忽略 */ }
          try {
            ctx.inject?.(['layout'], scope => {
              const layout = typeof scope.get === 'function' ? scope.get('layout') : null
              if (layout === null || typeof layout.selectPanel !== 'function') {
                report({ panelProbe: 'layout-unavailable' })
                return
              }
              layout.selectPanel('hanako-memory')
              report({ panelProbe: 'opened' })
              // 自检：等宿主把侧栏入口渲染出来 → 像用户那样点侧栏按钮 → 再逐个点 tab 取样
              const verify = (attempt) => {
                try {
                  const root = () => document.querySelector('.hk-page')
                  let visible = root() !== null && root().offsetParent !== null && root().getBoundingClientRect().width > 0
                  if (!visible) {
                    // 退而求其次：直接点侧栏「助手与记忆」这一行（这才是用户的真实路径）
                    const sidebarButton = Array.from(document.querySelectorAll('button'))
                      .find(node => String(node.textContent || '').includes('助手与记忆'))
                    if (sidebarButton !== undefined) sidebarButton.click()
                  }
                  setTimeout(async () => {
                    const panel = root()
                    visible = panel !== null && panel.offsetParent !== null && panel.getBoundingClientRect().width > 0
                    if (!visible && attempt < 4) {
                      verify(attempt + 1)
                      return
                    }
                    if (!visible) {
                      const buttons = Array.from(document.querySelectorAll('button'))
                        .filter(node => String(node.textContent || '').includes('助手与记忆'))
                        .map(node => ({
                          cls: String(node.className || '').slice(0, 48),
                          aria: String(node.getAttribute('aria-label') || '').slice(0, 24),
                          text: String(node.textContent || '').trim().slice(0, 24),
                        }))
                      const main = document.querySelector('main')
                      report({
                        applyError: lastApplyError,
                        ui: UI_VERSION,
                        primitives: usingPrimitives,
                        slots: registeredRef,
                        probeCommandUi: commandUiProbe,
                        panelProbe: 'not-visible',
                        attempt,
                        mounted: document.querySelector('.hk-page') !== null,
                        mainEntries: (() => {
                          try {
                            if (slotsRef === null || typeof slotsRef.entriesOfSlot !== 'function') return 'no-slots'
                            const main = slotsRef.entriesOfSlot('main') || []
                            const panel = slotsRef.entriesOfSlot('sidebar.panellist') || []
                            const describe = list => list.map(entry => {
                              const options = entry && entry.options ? entry.options : {}
                              return String(options.key || options.id || options.name || '?')
                            }).join(',')
                            return 'main=' + describe(main) + '|sidebar=' + describe(panel)
                          } catch (error) { return 'err:' + String((error && error.message) || error) }
                        })(),
                        buttons: JSON.stringify(buttons).slice(0, 500),
                        mainHtml: main === null ? 'no-main' : String(main.className || '').slice(0, 80),
                      })
                      return
                    }
                    const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
                      .filter(node => String(node.textContent || '').trim().length > 0)
                    const steps = []
                    for (const label of ['总览', '助手', '人格', '记忆', '技能']) {
                      const node = tabs.find(item => String(item.textContent).trim() === label)
                      if (node !== undefined) node.click()
                      steps.push({ tab: label, clicked: node !== undefined })
                    }
                    // 排查「不能上下滑」：把面板到中心列的每一层盒模型都记下来
                    const chain = []
                    let node = panel
                    for (let i = 0; i < 6 && node !== null; i++) {
                      const style = window.getComputedStyle(node)
                      chain.push({
                        tag: node.tagName,
                        cls: String(node.className || '').slice(0, 40),
                        h: node.offsetHeight,
                        ch: node.clientHeight,
                        sh: node.scrollHeight,
                        of: style.overflowY,
                        fx: style.flex,
                        pos: style.position,
                      })
                      node = node.parentElement
                    }
                    const text = String(panel.textContent || '')
                    // 有多少个面板实例、各自在什么容器里（侧栏 vs 设置弹窗）
                    const pageNodes = Array.from(document.querySelectorAll('.hk-page')).map(node => {
                      const rect = node.getBoundingClientRect()
                      const style = window.getComputedStyle(node)
                      const parent = node.parentElement
                      return {
                        top: Math.round(rect.top),
                        h: Math.round(rect.height),
                        ch: node.clientHeight,
                        sh: node.scrollHeight,
                        display: style.display,
                        maxH: style.maxHeight,
                        parentH: parent ? parent.clientHeight : -1,
                      }
                    }).slice(0, 4)
                    const body = document.querySelector('.hk-body')
                    const bodyInfo = body === null ? null : {
                      h: body.clientHeight,
                      sh: body.scrollHeight,
                      of: window.getComputedStyle(body).overflowY,
                    }
                    const clickTabByLabel = label => {
                      const node = Array.from(document.querySelectorAll('[role="tab"]')).find(item => String(item.textContent || '').trim() === label)
                      if (node !== undefined) node.click()
                      return node !== undefined
                    }
                    const buttonWith = keyword => Array.from(document.querySelectorAll('button')).some(b => String(b.textContent || '').includes(keyword))
                    // 点完 tab 要等 React 提交一次才能查到内容（之前同步查询永远是旧 DOM）
                    const checkLater = ms => new Promise(resolve => setTimeout(resolve, ms))
                    const assistantCreate = await (async () => {
                      clickTabByLabel('助手')
                      await checkLater(150)
                      return buttonWith('新建助手')
                    })()
                    let marketText = ''
                    const marketUsable = await (async () => {
                      clickTabByLabel('市场')
                      await checkLater(3000)
                      const bodyNode = document.querySelector('.hk-body')
                      marketText = bodyNode === null ? '' : String(bodyNode.textContent || '').slice(0, 200)
                      return buttonWith('安装') || buttonWith('搜索')
                    })()
                    const personaCreate = await (async () => {
                      clickTabByLabel('人格')
                      await checkLater(150)
                      return buttonWith('创造人格')
                    })()
                    clickTabByLabel('总览')
                    await checkLater(100)
                    const hasCreate = assistantCreate
                    const hasInstall = marketUsable
                    const headText = String((document.querySelector('.hk-head') || {}).textContent || '').slice(0, 60)
                    report({
                      bodyScroll: JSON.stringify(bodyInfo),
                      headText,
                      hasCreate,
                      hasInstall,
                      hasCreatePersona: personaCreate,
                      marketText,
                      pages: JSON.stringify(pageNodes).slice(0, 600),
                      ui: UI_VERSION,
                      primitives: usingPrimitives,
                      slots: registeredRef,
                      probeCommandUi: commandUiProbe,
                      panelProbe: 'verified',
                      domPanel: true,
                      attempt,
                      boxChain: JSON.stringify(chain).slice(0, 900),
                      tabsFound: tabs.map(node => String(node.textContent).trim()).join('/').slice(0, 120),
                      tabsReport: JSON.stringify(steps).slice(0, 500),
                      panelTextLength: text.length,
                    })
                    const first = tabs.find(item => String(item.textContent).trim() === '总览')
                    if (first !== undefined) first.click()
                  }, 700)
                } catch (error) {
                  report({ panelProbe: 'verify-failed', panelError: String((error && error.message) || error) })
                }
              }
              setTimeout(() => verify(0), 900)
            })
          } catch (error) {
            report({ panelProbe: 'inject-failed: ' + String((error && error.message) || error) })
          }
        })
        .catch(() => { /* 探针失败静默 */ })
    }

    /**
     * 「插件」页里的一个条目：技能市场。
     *
     * 用的是宿主的 `plugins.item` 槽位（官方插件列表里那张卡）：
     * - `view === 'summary'` → 卡片上的一行摘要
     * - `view === 'page'` → 点开后的整页（直接复用 MarketTab）
     *
     * 这就是用户要的「放到插件里面、添加插件那边」：不用多一个侧栏入口，
     * 技能市场和插件管理长在一起。
     */
    function MarketPluginItem(props) {
      const view = props && typeof props.view === 'string' ? props.view : 'summary'
      react.useEffect(() => { if (view === 'page') ensureStyles() }, [view])
      if (view !== 'page') {
        return h('div', { className: 'hk-sub' },
          '从腾讯 SkillHub 搜索 / 安装技能，装完立刻进技能库')
      }
      return h(PanelBoundary, null, h(MarketTab, { onChanged: () => {} }))
    }

    function mount(ctx) {
      // inject: ['slots'] 生效后 ctx.slots 直接可用；get() 只是兜底（不同宿主版本）。
      let slots = null
      try {
        slots = ctx && ctx.slots
      } catch { slots = null }
      if ((!slots || typeof slots.inject !== 'function') && ctx && typeof ctx.get === 'function') {
        try { slots = ctx.get('slots') } catch { slots = null }
      }
      if (!slots || typeof slots.inject !== 'function') {
        console.warn('[hanako-memory] slots service unavailable — panel not mounted (host features unaffected)')
        report({ mounted: false, ui: UI_VERSION, reason: 'slots service unavailable' })
        return
      }

      slotsRef = slots
      const registered = []
      registeredRef = registered

      // 侧栏图标（与「插件」图标并排）
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: 'hanako-memory',
        order: 20,
        label: () => '助手与记忆',
      }, PanelIcon))
      registered.push('sidebar.panellist')

      // 主面板：key 必须与上面的 id 完全一致，侧栏点击才会切到这里
      slots.inject('main', () => {
        try {
          return slots.register({
            name: 'main',
            key: 'hanako-memory',
          }, HanakoPageSafe)
        } catch (error) {
          lastApplyError = 'main register: ' + String((error && error.message) || error)
          report({ mounted: false, ui: UI_VERSION, applyError: lastApplyError })
          throw error
        }
      })
      registered.push('main')

      // 设置 → 插件 区的 tab：后备入口 + 诊断探针
      slots.inject('settings.plugins.tab', () => slots.register({
        name: 'settings.plugins.tab',
        id: 'hanako-memory',
        order: 70,
        label: () => '助手与记忆',
      }, HanakoPageSafe))
      registered.push('settings.plugins.tab')

      // 注意：**不在输入框工具行加独立按钮** —— 技能统一收进「＋」菜单（commandUi 贡献）。
      // 但「＋」菜单要能把技能插到光标处，需要 inputActions；它只从 session 作用域的槽位拿得到。
      // 所以这里挂一个**零 UI** 的桥：渲染 null，只把 inputActions 存到模块级供命令贡献使用。
      slots.inject('conversation.input.overlay', () => slots.register({
        name: 'conversation.input.overlay',
        id: 'hanako-memory-input-bridge',
        order: 40,
        label: () => '技能插入桥',
      }, InputActionBridge))
      registered.push('conversation.input.overlay')

      // 「插件」页里挂一个「技能市场」条目（plugins.item：官方插件列表那张卡）
      try {
        slots.inject('plugins.item', () => slots.register({
          name: 'plugins.item',
          id: 'hanako-skill-market',
          order: 90,
          label: () => '技能市场',
        }, MarketPluginItem))
        registered.push('plugins.item')
      } catch (error) {
        console.warn('[hanako-memory] plugins.item registration skipped:', error)
      }

      // 「＋」菜单里的「技能」项：注册一条客户端命令贡献（宿主支持的唯一入口）。
      // 名字不能与已占用的 8 个宿主命令重名，否则整个 ＋ 菜单会崩。
      // conversation 服务单独登记（有的宿主版本里它比 commandUi 晚到）
      try {
        ctx.inject?.(['conversation'], scope => {
          conversationService = typeof scope.get === 'function' ? scope.get('conversation') : null
          report({
            mounted: true,
            ui: UI_VERSION,
            primitives: usingPrimitives,
            slots: registered,
            probeConversation: conversationService !== null,
          })
        })
      } catch (error) {
        console.warn('[hanako-memory] conversation service probe failed:', error)
      }

      try {
        ctx.inject?.(['commandUi'], scope => {
          const commandUi = typeof scope.get === 'function' ? scope.get('commandUi') : null
          if (commandUi === null || typeof commandUi.register !== 'function') return
          scope.effect(() => commandUi.register({
            name: 'hanako-skill',
            label: () => '技能',
            description: () => '挑选一个 skill，插入到输入框',
            icon: SkillGlyph,
            available: session => Boolean(session && session.sessionId !== undefined),
            ui: {
              kind: 'popup',
              options: async () => {
                const data = await api('/skills')
                return (data.skills || []).map(skill => ({
                  id: skill.name,
                  label: skill.name,
                  detail: skill.whenToUse || skill.description || '',
                }))
              },
              // onSelect(option, context)：context 只带 { sessionId }
              onSelect: async (option, context) => {
                try {
                  const sessionId = context && context.sessionId !== undefined ? context.sessionId : null
                  const input = conversationService && conversationService.input ? conversationService.input : null
                  const shell = input && typeof input.shell === 'function' && sessionId !== null
                    ? input.shell(sessionId)
                    : null
                  // shell 拿不到时退回槽位组件的同一套动作（下面 SkillDock 会用）
                  if (shell && shell.actions) {
                    const span = shell.actions.captureInsertion()
                    if (shell.actions.insertText(skillLine(option.id), span) === false) {
                      const draft = shell.snapshot && typeof shell.snapshot.draft === 'string' ? shell.snapshot.draft : ''
                      shell.actions.setDraft(draft + skillLine(option.id))
                    }
                    if (typeof shell.focus === 'function') shell.focus()
                    return
                  }
                  // 兜底：用 SkillDock 最近一次绑定的 action 面（同一会话内通常可用）
                  if (lastInputActions && typeof lastInputActions.insertText === 'function') {
                    const span = lastInputActions.captureInsertion()
                    lastInputActions.insertText(skillLine(option.id), span)
                  }
                } catch (error) {
                  console.warn('[hanako-memory] skill command insert failed:', error)
                }
              },
            },
          }), 'hanako-memory: skill command')
          registered.push('commandUi:hanako-skill')
          commandUiProbe = true
          report({ mounted: true, ui: UI_VERSION, primitives: usingPrimitives, slots: registered, probeCommandUi: true })
        })
      } catch (error) {
        // 命令贡献失败不影响面板本身
        console.warn('[hanako-memory] command contribution skipped:', error)
        report({
          mounted: true,
          ui: UI_VERSION,
          primitives: usingPrimitives,
          slots: registered,
          commandError: String((error && error.message) || error),
        })
      }

      probePanel(ctx)

      report({ mounted: true, ui: UI_VERSION, primitives: usingPrimitives, primitivesError, primitivesType: typeof UI, primitivesKeys: UI && typeof UI === 'object' ? Object.keys(UI).slice(0, 12).join(',') : '', slots: registered })
    }

    function apply(ctx) {
      installErrorNet()
      try {
        mount(ctx)
      } catch (error) {
        console.error('[hanako-memory] mounting failed; the rest of the app is unaffected:', error)
        lastApplyError = String((error && error.message) || error)
        report({ mounted: false, ui: UI_VERSION, applyError: lastApplyError })
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply

    /**
     * 测试钩子：面板组件与纯函数，供 test/ui-render.test.js 与 tools/preview-panel.mjs 使用。
     * 宿主只认 name / inject / apply，多挂一个字段无副作用。
     */
    exports.__test = {
      CSS,
      usingPrimitives,
      UI_VERSION,
      HanakoPage,
      OverviewTab,
      AssistantsTab,
      PersonasTab,
      MemoryTab,
      PanelBoundary,
      SkillsTab,
      SkillDock,
      PanelIcon,
      findDuplicates,
      relativeTime,
      charCount,
      num,
    }

    return module.exports
  },
})
