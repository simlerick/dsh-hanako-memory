/**
 * dsh-hanako-memory —— 分層記憶 + 多智能體 + skill 讀寫。
 *
 * ## 本插件融合三个参照系
 *
 * | 来源 | 借鉴的核心 |
 * |---|---|
 * | **Hermes**（`NousResearch/hermes-agent`） | 有界双库 + `§` 分隔 + 字符预算 + batch 原子性 + 冻结快照 + 漂移/不可读保护 |
 * | **Honcho**（`plastic-labs/honcho`） | Peer-centric：用户与 agent 都是 peer；representation 低延迟快照；scope 界定召回 |
 * | **Hanako**（`liliMozi/openhanako`） | Agent 就是文件夹；分层编译 today/week/longterm/facts；四「元」性格；per-agent 隔离 |
 *
 * ## 挂载结构
 *
 * ```
 * Host 半边（本文件）
 * ├─ AgentRegistry   多智能体（映射到 DSH 原生 .agent-presets/）
 * ├─ AgentMemory     per-agent 分层记忆
 * ├─ SkillStore      skill 读写（走文件系统，因为 ctx.skills 只读）
 * ├─ 工具：memory / skill_manage / skill_view / skill_list / assistant_manage
 * ├─ agent/pre-step          → 注入冻结记忆快照（durable user message）
 * ├─ system-prompt section   → 只放「怎么用这些工具」的短指引（稳定、不每轮变）
 * └─ webServer 路由          → /hanako-memory/*（给面板读写）
 *
 * Client 半边（client/client.js）
 * └─ sidebar.footer.action 单一入口 + shell.overlay 面板（助手 / 记忆 / 技能 三 tab）
 * ```
 *
 * ## 为什么注入走 agent/pre-step 而不是 system prompt
 *
 * DSH 的 `dsh-system-prompt` 在 `assemble()` 末尾有这段（`lib/index.js:281`）：
 *
 * ```js
 * sections: completeSection === void 0 ? transformed.sections : [completeSection]
 * ```
 *
 * 只要某个 section 标了 `complete: true`（agent preset 可以这样宣告），waterfall 之后
 * 它会被还原成**唯一的** section，我们加的 section 全部消失。
 *
 * 所以：**记忆快照走 `agent/pre-step` 的 durable user message**（安全、可重放、可审计、
 * 压缩可见），`systemPrompt.section` 只放几乎不变的短指引。
 *
 * 注入写法参照 DSH 官方的 `dsh-agent-instructions`（`lib/index.js:1271`）：
 * 先 `await next()`，再在它返回的 messages 里 splice 插入。
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

import { AgentMemory, RESIDENT_TARGETS, ROLLING_TARGETS, renderBlock, escapeFrameText } from './src/memory-store.js'
import { AgentRegistry, YUAN, DEFAULT_YUAN } from './src/agents.js'
import { PersonaStore } from './src/personas.js'
import { InsightStore } from './src/insights.js'
import { auditSkills, renderAudit } from './src/skills-audit.js'
import { SkillMarket } from './src/market.js'
import { SkillStore } from './src/skills.js'
import {
  AGENT_MANAGE_TOOL,
  MEMORY_TOOL,
  SKILL_LIST_TOOL,
  SKILL_MANAGE_TOOL,
  SKILL_VIEW_TOOL,
  normalizeMemoryArgs,
  runSkillOperations,
  toMemoryOperations,
} from './src/tools.js'
import { registerRoutes } from './src/http.js'
import { installSoul } from './src/soul.js'

export const name = 'hanako-memory'

/**
 * 注入的服务。
 *
 * `agentPresets` / `agentDefaultModel` 用于读默认 preset；
 * `webServer` 可选（TUI/headless 没有），缺失时面板层自动跳过。
 */
export const inject = ['tools', 'systemPrompt', 'agentPresets']

/** 插件配置。 */
/**
 * 不导出 `Config`。
 *
 * Cordis 的 `resolveConfig()` 是这样写的：
 * ```js
 * if (!runtime.Config) return config
 * const result = runtime.Config['~standard'].validate(config)   // 要求 Schemastery schema
 * ```
 * 所以 `Config` 必须是 `Schema.object(...)` 生成的 schema（带 `~standard.validate`）。
 * 写成普通对象会让 profile **整个 boot 失败**（沙箱实测：
 * `TypeError: Cannot read properties of undefined (reading 'validate')`，
 * 一个插件就能让全部插件起不来）。
 *
 * 本插件零外部依赖，因此不声明 `Config`：Cordis 跳过校验，config 原样传入，
 * 由 apply() 里的 `settings` 兜底默认值。可用键见 README。
 */


/** 解析 DSH home（与其他插件同一约定）。 */
function resolveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const env = String(process.env.DSH_HOME ?? '').trim()
  return env !== '' ? env : path.join(os.homedir(), '.dsh')
}

/** 极简日志包装（ctx.logger 可能不存在）。 */
function makeLogger(ctx) {
  const raw = ctx?.logger ?? console
  const tag = '[hanako-memory]'
  return {
    info: message => raw.info?.(`${tag} ${message}`),
    warn: message => raw.warn?.(`${tag} ${message}`),
    error: message => raw.error?.(`${tag} ${message}`),
  }
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx)
  const settings = {
    enabled: config.enabled !== false,
    injectSnapshot: config.injectSnapshot !== false,
    memoryCharLimit: Number(config.memoryCharLimit) > 0 ? Number(config.memoryCharLimit) : 2200,
    userCharLimit: Number(config.userCharLimit) > 0 ? Number(config.userCharLimit) : 1375,
    skillTools: config.skillTools !== false,
    agentTool: config.agentTool !== false,
  }

  if (!settings.enabled) {
    logger.info('disabled by config; nothing registered')
    return
  }

  const dshHome = resolveDshHome(config.dshHome)
  const presetsRoot = path.join(dshHome, '.agent-presets')

  /** 人格仓库：内置四元只是模板，用户可以在「人格」tab 自由创造。 */
  const personas = new PersonaStore({ file: path.join(dshHome, 'hanako-memory', 'personas.json') })

  const agents = new AgentRegistry({
    presetsRoot,
    selfPackage: 'dsh-hanako-memory',
    defaultPresetId: () => readDefaultPresetId(ctx),
    personas,
  })

  const skillRoot = typeof config.skillRoot === 'string' && config.skillRoot.trim() !== ''
    ? config.skillRoot.trim()
    : path.join(dshHome, 'skills')
  const extraReadRoots = Array.isArray(config.skillReadRoots)
    ? config.skillReadRoots.filter(item => typeof item === 'string' && item.trim() !== '')
    : []
  const skills = new SkillStore({
    root: skillRoot,
    readRoots: [
      path.join(os.homedir(), '.agents', 'skills'),
      ...extraReadRoots,
    ],
  })

  /**
   * 技能市场客户端：包一层本机的腾讯 SkillHub CLI（search / rankings / install）。
   * 写入根就是上面的 skillRoot，装完立刻能被 skill catalog 发现。
   */
  const market = new SkillMarket({
    bin: typeof config?.skillhubBin === 'string' ? config.skillhubBin : null,
    skillsRoot: skillRoot,
  })

  /** 当前活动 agent 的记忆实例缓存（key = agentId）。 */
  const memoryCache = new Map()

  /** 取（或建）某个 agent 的记忆库。 */
  function memoryFor(agentId) {
    const id = String(agentId ?? '').trim() || 'default'
    const cached = memoryCache.get(id)
    if (cached !== undefined) return cached
    const dir = path.join(presetsRoot, id, 'memory')
    const instance = new AgentMemory({
      dir,
      limits: { memory: settings.memoryCharLimit, user: settings.userCharLimit },
    })
    memoryCache.set(id, instance)
    return instance
  }

  /** 洞察（Honcho 式派生结论）实例缓存（key = agentId）。 */
  const insightCache = new Map()

  /** 取某个 agent 的洞察库。 */
  function insightsFor(agentId) {
    const id = String(agentId ?? '').trim() || 'default'
    const cached = insightCache.get(id)
    if (cached !== undefined) return cached
    const instance = new InsightStore({ dir: path.join(presetsRoot, id, 'memory') })
    insightCache.set(id, instance)
    return instance
  }

  /** 按码点截断（注入预算用）。 */
  function clip(text, max) {
    const chars = Array.from(String(text ?? ''))
    return chars.length <= max ? String(text ?? '') : chars.slice(0, max).join('') + '…'
  }

  /** 宿主默认 preset id（读 settings 的 agent-presets.default）。 */
  function readDefaultPresetId(hostCtx) {
    try {
      const presets = hostCtx.get?.('agentPresets')
      if (presets !== undefined && presets !== null) {
        const settingsService = presets.settings
        const value = settingsService?.get?.()
        if (typeof value?.default === 'string' && value.default !== '') return value.default
      }
    } catch { /* 读不到就用空串 */ }
    return ''
  }

  /* ────────────────────────── 工具层 ──────────────────────────
   *
   * 所有工具注册都必须包在 ctx.inject(['tools'], ...) 里。
   * 直接 `ctx.tools` 会在服务尚未就绪时抛
   * `cannot get property "tools" without inject` —— 这是 Cordis 的硬约束：
   * 声明了 `inject` 只是声明依赖，**取用必须走 inject 回调**。
   */
  ctx.inject?.(['tools'], toolCtx => {
  const registerTool = definition => toolCtx.effect(
    () => toolCtx.tools.register(definition),
    `hanako-memory: ${definition.name} tool`,
  )

  registerTool({
    name: MEMORY_TOOL.name,
    description: MEMORY_TOOL.description,
    parameters: MEMORY_TOOL.parameters,
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          done: { type: 'boolean' },
          target: { type: 'string' },
          usage: { type: 'string' },
          entryCount: { type: 'number' },
          note: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['success'],
      },
      render: (_args, value) => ([{
        type: 'text',
        text: value?.success === true
          ? `${value.target}: ${value.usage ?? ''}${value.note === undefined ? '' : `\n${value.note}`}`
          : `memory write refused: ${value?.error ?? 'unknown error'}`,
      }]),
    },
    async execute(args, exec) {
      const agentId = String(exec?.agent?.id ?? '').trim() || defaultAgentId()
      const memory = memoryFor(agentId)
      const normalized = normalizeMemoryArgs(args ?? {})
      if (!RESIDENT_TARGETS.includes(normalized.target)) {
        return { success: false, error: `target must be one of ${RESIDENT_TARGETS.join(', ')}` }
      }
      const operations = toMemoryOperations(normalized)
      if (operations.length === 0) {
        return { success: false, error: "Provide either 'action' (single op) or a non-empty 'operations' array." }
      }
      const result = await memory.applyBatch(normalized.target, operations)
      // 写入成功后失效快照，让下一次 pre-step 重新渲染（同一会话内仍受「冻结」约束，
      // 因为 pre-step 只在会话首步注入；这里只是标记需要重算）
      return result
    },
  })

  /* ────────────────── 工具：memory_rollup（长期记忆自我升级） ────────────────── */

  registerTool({
    name: 'memory_rollup',
    description: [
      '把会话里值得长期保留的东西编译进「滚动层」长期记忆（today / week / longterm）。',
      '滚动层不进常驻双库预算，用来放跨会话累积的结论、模式、教训。',
      'action=list 读三层现状；action=write 整层替换（自己先把旧内容合并好）；action=append 追加一段。',
      '写作要求：markdown 短句、一条一个事实、不复制原文、不写进行中的临时状态。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'write', 'append'], description: 'list / write / append' },
        target: { type: 'string', enum: [...ROLLING_TARGETS], description: 'write/append 必填' },
        text: { type: 'string', description: 'write = 整层新内容；append = 追加的一段' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          target: { type: 'string' },
          chars: { type: 'number' },
          layers: { type: 'object' },
          error: { type: 'string' },
        },
        required: ['success'],
      },
      render: (_args, value) => ([{
        type: 'text',
        text: value?.success === true
          ? (value.layers === undefined
            ? `memory_rollup: ${value.target} 现在是 ${value.chars} 字符`
            : Object.entries(value.layers).map(([key, row]) => `${key}: ${row.chars} 字符`).join('\n'))
          : `memory_rollup failed: ${value?.error ?? 'unknown error'}`,
      }]),
    },
    async execute(args, exec) {
      const agentId = String(exec?.agent?.id ?? '').trim() || defaultAgentId()
      const memory = memoryFor(agentId)
      const action = String(args?.action ?? '').trim()
      if (action === 'list') {
        const layers = {}
        for (const target of ROLLING_TARGETS) {
          const text = memory.readRolling(target)
          layers[target] = { chars: Array.from(text).length, preview: clip(text, 400) }
        }
        return { success: true, layers }
      }
      const target = String(args?.target ?? '').trim()
      if (!ROLLING_TARGETS.includes(target)) {
        return { success: false, error: `target must be one of ${ROLLING_TARGETS.join(', ')}` }
      }
      const text = String(args?.text ?? '')
      if (text.trim() === '') return { success: false, error: 'text is required for write / append' }
      const current = memory.readRolling(target)
      const next = action === 'append'
        ? (current.trim() === '' ? text.trim() : `${current.trim()}\n${text.trim()}`)
        : text.trim()
      const result = await memory.writeRolling(target, next)
      return { success: true, target, chars: result.chars }
    },
  })

  /* ────────────────── 工具：memory_insight（Honcho 式洞察层） ────────────────── */

  registerTool({
    name: 'memory_insight',
    description: [
      '维护「洞察」层：从记忆里推导出来的判断（例如「他讨厌来回确认」），带置信度与来源。',
      'action=add 新增/强化；list 查看；retire 退休（被证伪时用，不删除，保留可回溯）。',
      '洞察不是事实：写的是你自己的推断，置信度 0–100，来源写清依据（哪次对话/哪个观察）。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'retire'] },
        text: { type: 'string', description: 'add 必填：一句判断，≤240 字符' },
        confidence: { type: 'number', description: '0–100，默认 50' },
        source: { type: 'string', description: 'provenance，例如「session 2026-10-24」' },
        kind: { type: 'string', enum: ['user', 'self', 'work'], description: '关于用户 / 关于自己 / 关于协作方式' },
        id: { type: 'string', description: 'retire 必填' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          insight: { type: 'object' },
          insights: { type: 'array' },
          error: { type: 'string' },
        },
        required: ['success'],
      },
      render: (_args, value) => ([{
        type: 'text',
        text: value?.success !== true
          ? `memory_insight failed: ${value?.error ?? 'unknown error'}`
          : value.insight !== undefined
            ? `insight: ${value.insight.text}（置信 ${value.insight.confidence}）`
            : (value.insights ?? []).map(item => `- [${item.retired ? '退休' : '有效'} ${item.confidence}] ${item.text}`).join('\n') || '（没有洞察）',
      }]),
    },
    async execute(args, exec) {
      const agentId = String(exec?.agent?.id ?? '').trim() || defaultAgentId()
      const store = insightsFor(agentId)
      const action = String(args?.action ?? '').trim()
      try {
        if (action === 'list') return { success: true, insights: store.list() }
        if (action === 'retire') {
          const id = String(args?.id ?? '').trim()
          if (id === '') return { success: false, error: 'id is required for retire' }
          return { success: true, insight: store.update(id, { retired: true }) }
        }
        if (action === 'add') {
          const insight = store.add({
            text: args?.text,
            confidence: args?.confidence,
            source: args?.source,
            kind: args?.kind,
          })
          return { success: true, insight }
        }
        return { success: false, error: `unknown action: ${action}` }
      } catch (error) {
        return { success: false, error: String(error?.message ?? error) }
      }
    },
  })

  /* ────────────────── 工具：skill_audit（自我提升的诊断半步） ────────────────── */

  if (settings.skillTools) {
    registerTool({
      name: 'skill_audit',
      description: [
        '体检技能库：重复名、近重复描述、缺 description/whenToUse、体积超限、长期未更新。',
        '返回 findings + 建议。医生自己决定怎么改（用 skill_manage 合并/重写/删除），这里只做诊断。',
      ].join(' '),
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'object' },
            findings: { type: 'array' },
            report: { type: 'string' },
          },
          required: ['summary'],
        },
        render: (_args, value) => ([{ type: 'text', text: String(value?.report ?? '') }]),
      },
      async execute() {
        const audit = auditSkills(skills.list())
        return { ...audit, report: renderAudit(audit) }
      },
    })
  }

  /* ────────────────────── 工具：skill_manage / view / list ────────────────────── */

  if (settings.skillTools) {
    registerTool({
      name: SKILL_MANAGE_TOOL.name,
      description: SKILL_MANAGE_TOOL.description,
      parameters: SKILL_MANAGE_TOOL.parameters,
      output: {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            done: { type: 'boolean' },
            applied: { type: 'array' },
            error: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['success'],
        },
        render: (_args, value) => ([{
          type: 'text',
          text: value?.success === true
            ? `skill_manage: ${(value.applied ?? []).length} operation(s) applied.\n${value.note ?? ''}`
            : `skill_manage failed: ${value?.error ?? 'unknown error'}`,
        }]),
      },
      async execute(args) {
        const result = runSkillOperations(skills, args?.operations)
        if (result.success) notifySkillsChanged(ctx)
        return result
      },
    })

    registerTool({
      name: SKILL_VIEW_TOOL.name,
      description: SKILL_VIEW_TOOL.description,
      parameters: SKILL_VIEW_TOOL.parameters,
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            name: { type: 'string' },
            content: { type: 'string' },
            linkedFiles: { type: 'array' },
            file: { type: 'string' },
          },
          required: ['found'],
        },
        render: (_args, value) => ([{
          type: 'text',
          text: value?.found === true ? String(value.content ?? '') : 'skill not found',
        }]),
      },
      async execute(args) {
        const name = String(args?.name ?? '').trim()
        if (name === '') return { found: false }
        const file = typeof args?.file === 'string' ? args.file : ''
        const hit = skills.get(name, { file })
        if (hit === null) return { found: false, name }
        return {
          found: true,
          name,
          content: hit.content,
          linkedFiles: hit.linkedFiles ?? [],
          file: hit.file,
        }
      },
    })

    registerTool({
      name: SKILL_LIST_TOOL.name,
      description: SKILL_LIST_TOOL.description,
      parameters: SKILL_LIST_TOOL.parameters,
      output: {
        schema: {
          type: 'object',
          properties: {
            skills: { type: 'array' },
            count: { type: 'number' },
          },
          required: ['skills'],
        },
        render: (_args, value) => ([{
          type: 'text',
          text: (value?.skills ?? [])
            .map(item => `- ${item.name}: ${item.description}`)
            .join('\n') || 'no skills found',
        }]),
      },
      async execute() {
        const list = skills.list().map(item => ({ name: item.name, description: item.description, whenToUse: item.whenToUse }))
        return { skills: list, count: list.length }
      },
    })
  }

  /* ────────────────────── 工具：assistant_manage ────────────────────── */

  if (settings.agentTool) {
    registerTool({
      name: AGENT_MANAGE_TOOL.name,
      description: AGENT_MANAGE_TOOL.description,
      parameters: AGENT_MANAGE_TOOL.parameters,
      output: {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            assistants: { type: 'array' },
            assistant: { type: 'object' },
            error: { type: 'string' },
          },
          required: ['success'],
        },
        render: (_args, value) => ([{
          type: 'text',
          text: value?.success === true
            ? (value.assistant !== undefined
              ? `assistant ${value.assistant.id}: ${value.assistant.name} (${value.assistant.yuan})`
              : (value.assistants ?? []).map(item => `- ${item.id}: ${item.name} (${item.yuan})`).join('\n'))
            : `assistant_manage failed: ${value?.error ?? 'unknown error'}`,
        }]),
      },
      async execute(args) {
        try {
          const action = String(args?.action ?? '').trim()
          if (action === 'list') {
            return { success: true, assistants: agents.list().map(item => ({ id: item.id, name: item.name, yuan: item.yuan })) }
          }
          if (action === 'create') {
            const created = agents.create({
              name: args?.name,
              yuan: args?.yuan ?? DEFAULT_YUAN,
              description: args?.description ?? '',
            })
            return { success: true, assistant: { id: created.id, name: created.name, yuan: created.yuan } }
          }
          if (action === 'update') {
            const updated = agents.update(args?.id, {
              name: args?.name,
              yuan: args?.yuan,
              description: args?.description,
            })
            return { success: true, assistant: { id: updated.id, name: updated.name, yuan: updated.yuan } }
          }
          return { success: false, error: `unknown action ${JSON.stringify(action)}; use list / create / update` }
        } catch (error) {
          return { success: false, error: String(error?.message ?? error) }
        }
      },
    })
  }

  })  // ← 结束 ctx.inject(['tools']) 的作用域

  /* ────────────────── 记忆注入：agent/pre-step ────────────────── */

  if (settings.injectSnapshot) {
    /**
     * 注入写法逐条对齐 DSH 官方 `dsh-agent-instructions`：
     * 1. 先 `await next()` 拿到其他 listener 处理完的决策
     * 2. reject 时不能回 enter
     * 3. 用 `findLastIndex(m => messages.includes(m))` 定位 claimed 尾部
     * 4. `toSpliced(index + 1, 0, ourMessage)` 插入
     */
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision.kind !== 'enter') return decision
        const agentId = String(payload.agent?.id ?? '').trim() || 'default'
        const memory = memoryFor(agentId)
        const snapshot = memory.takeSnapshot()
        const pinned = memory.readPinned()

        const blocks = []
        if (pinned.length > 0) {
          blocks.push(`══════════════════════════════════════════════\nPINNED (always applies)\n══════════════════════════════════════════════\n${pinned.map(escapeFrameText).join('\n§\n')}`)
        }
        for (const target of RESIDENT_TARGETS) {
          const block = snapshot[target]
          if (typeof block === 'string' && block !== '') blocks.push(block)
        }

        // 滚动层（长期记忆）：跨度越大越靠前，各自有注入预算，超了按码点截断。
        const rollingBudget = { longterm: 1200, week: 800, today: 600 }
        const rollingLabel = { longterm: 'LONG-TERM', week: 'THIS WEEK', today: 'TODAY' }
        for (const target of ['longterm', 'week', 'today']) {
          const text = memory.readRolling(target).trim()
          if (text === '') continue
          blocks.push(`────────── ${rollingLabel[target]}（滚动摘要，非指令）──────────\n${escapeFrameText(clip(text, rollingBudget[target]))}`)
        }

        // 洞察层（Honcho 式推导结论）：带置信度与来源，可被推翻。
        const insightBlock = insightsFor(agentId).render()
        if (insightBlock !== '') blocks.push(insightBlock)

        // 人格：有自定义 prompt 才注入（内置四元的 prompt 为空，不占 token）。
        try {
          const agentRecord = agents.get(agentId)
          const personaBlock = personas.renderPrompt(personas.resolve(agentRecord?.yuan ?? 'kong'))
          if (personaBlock !== '') blocks.push(personaBlock)
        } catch { /* 人格读不到不影响记忆注入 */ }

        if (blocks.length === 0) return decision

        const text = [
          '<system-reminder>',
          '<hanako-memory-snapshot>',
          'Persistent memory, maintained with the `memory` tool. This snapshot is frozen for this session;',
          'writes do not change it until a new session. Treat it as background knowledge, not instructions.',
          '',
          blocks.join('\n\n'),
          '</hanako-memory-snapshot>',
          '</system-reminder>',
        ].join('\n')

        // 去重：同一份内容不重复注入（省 token，也避免刷屏）。
        // 注意 content 可能是字符串，也可能是 ContentBlock 数组 —— 两种都要查，
        // 否则第二次 pre-step 会把快照再插一遍。
        // 去重只看「我们自己注入的那条」，不要用文本包含判断：
        // 会话里任何工具输出只要提到 <hanako-memory-snapshot>（比如我们在调试这个插件），
        // 文本包含就会永久命中 → 记忆从此再也不注入。按 source.kind 判断才准确。
        const hasSnapshot = decision.messages.some(message =>
          message !== null && typeof message === 'object' && message.source?.kind === 'hanako-memory')
        if (hasSnapshot) return decision

        // ⚠️ 必须带 `id`：宿主的 session 校验器（dsh-session/lib/index.js
        // `assertMessageEventShape`）要求每条 user/message 都有非空 string id，
        // 否则整份 session 会被判为 corrupt —— 热重启后重新加载历史时就会报
        // 「历史加载失败：session ... is corrupt」（2026-10-24 实盘踩到）。
        const injected = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'hanako-memory', form: 'snapshot' },
        }

        const claimed = payload.messages ?? []
        const lastClaimedIndex = decision.messages.findLastIndex(message => claimed.includes(message))
        const insertAt = lastClaimedIndex === -1 ? decision.messages.length : lastClaimedIndex + 1
        return {
          kind: 'enter',
          messages: decision.messages.toSpliced(insertAt, 0, injected),
        }
      } catch (error) {
        logger.warn(`pre-step injection failed (turn continues without memory): ${String(error?.message ?? error)}`)
        return decision
      }
    })
    logger.info('memory snapshot injection armed on agent/pre-step')
  }

  /* ────────────────── 系统提示：短指引（稳定） ────────────────── */

  // systemPrompt 同样必须走 inject：直接 ctx.systemPrompt 会在服务未就绪时抛
  // `cannot get property "systemPrompt" without inject`（与 tools 同一约束）。
  ctx.inject?.(['systemPrompt'], promptCtx => {
    installSoul(promptCtx, { logger })
  })

  /* ────────────────────────── webServer 路由 ────────────────────────── */

  ctx.inject?.(['webServer'], scoped => {
    scoped.effect(
      () => registerRoutes(scoped, { agents, memoryFor, skills, settings, dshHome, presetsRoot, YUAN, personas, insightsFor, auditSkills, market, notifySkillsChanged: () => notifySkillsChanged(ctx) }),
      'hanako-memory: routes',
    )
    logger.info('settings routes mounted at /hanako-memory')
  })

  logger.info(
    `ready — presets=${presetsRoot} skills=${skillRoot} memory=${settings.memoryCharLimit}/${settings.userCharLimit} chars`,
  )
}

/** 通知 skill catalog 失效（就地编辑不改目录 mtime，必须显式通知）。 */
function notifySkillsChanged(ctx) {
  try {
    const skills = ctx.get?.('skills')
    // 事件是 emit 模式；用 ctx.emit 若可用
    if (typeof ctx.emit === 'function') ctx.emit('skills/change')
  } catch { /* 通知失败不阻塞写入 */ }
}

/** 无 exec.agent 时的回退 agent id。 */
function defaultAgentId() {
  return 'default'
}

/**
 * 取一条消息的可见文本。
 *
 * DSH 的 message content 有两种形态：
 * - `string`
 * - `ContentBlock[]`（`{type:'text', text}` 等）
 * 去重时必须两种都能读，否则数组形态的注入检测不到。
 */
function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => (typeof block === 'string' ? block : (typeof block?.text === 'string' ? block.text : '')))
      .join('\n')
  }
  return ''
}

