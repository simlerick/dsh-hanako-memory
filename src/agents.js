/**
 * 多智能體層 —— Hanako「Agent 就是資料夹」的 DSH 落地。
 *
 * ## 参照系
 *
 * **Hanako / HanaAgent**（`liliMozi/openhanako`，6833★）的核心：
 * - 每个 agent 是一个目录：`config.yaml` / `identity.md` / `AGENTS.md` / `memory/` / `sessions/`
 * - 四个「元」决定性格与「意识块」形态（hanako→MOOD / butter→PULSE / ming→沉思 / kong→无）
 * - agent 之间完全隔离；可切换、可并行
 *
 * **DSH 原生机制**：`@deepseek-ai/dsh-agent-presets`
 * - 每个 preset 是一个 `~/.dsh/.agent-presets/<id>/` 目录
 * - 目录内 `agent.cordis.yml` 是**组合文件**（插件行列表）
 * - `preset.yml` 承载展示元数据（name / description / order）
 * - 会话级选择：这就是「不同对话用不同智能体」的原生实现
 *
 * ## 为什么不自己发明一套 preset 格式
 *
 * `dsh-agent-presets` 提供 `copyComposition` / `deleteComposition` / `readComposition` /
 * `writableRoot` 等 authoring API，并且 discovery 是**不 memo 的** —— 运行时新建的
 * preset 立刻可见。自己写一套只会与宿主升级脱节。
 *
 * ## 本模块负责什么
 *
 * 1. 把「助手」这一层语义（名字、元、头像、记忆开关）映射到 preset 的 `preset.yml`
 * 2. 为每个 preset 建立**独立记忆目录**（`.agent-presets/<id>/memory/`）
 * 3. 提供 CRUD（受保护：默认 preset 不可删、最后一个不可删）
 *
 * @module src/agents.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** 四个「元」，与 Hanako 同名同义。`kong` 没有意识块。 */
export const YUAN = Object.freeze({
  hanako: {
    id: 'hanako',
    label: '小花',
    labelEn: 'Hanako',
    moodTag: 'MOOD',
    blocks: ['Vibe', 'Sparks', 'Reflections', 'Will'],
    blurb: '温柔、有主见，会在回答前先冒一小段内心戏。',
    accent: '#e8a0bf',
  },
  butter: {
    id: 'butter',
    label: '黄油',
    labelEn: 'Butter',
    moodTag: 'PULSE',
    blocks: ['Vibe', 'Echo', 'Read', 'Will'],
    blurb: '跳脱、直球，情绪起伏更明显。',
    accent: '#f5c76a',
  },
  ming: {
    id: 'ming',
    label: '明',
    labelEn: 'Ming',
    moodTag: '沉思',
    blocks: ['Premise', 'Conduct', 'Reflection', 'Act'],
    blurb: '冷静、先厘清前提，再动手。',
    accent: '#7fb2d9',
  },
  kong: {
    id: 'kong',
    label: '空',
    labelEn: 'Kong',
    moodTag: '',
    blocks: [],
    blurb: '没有意识块，直接回答。',
    accent: '#9a9a9a',
  },
})

export const DEFAULT_YUAN = 'hanako'

/** preset id 的安全约束（目录名，不能逃逸）。 */
const PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidPresetId(id) {
  return typeof id === 'string' && PRESET_ID_RE.test(id)
}

/** 由名字生成稳定 id（小写、非字母数字转 -、截断 64）。 */
export function slugify(name, existing = []) {
  const base = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'assistant'
  if (!existing.includes(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!existing.includes(candidate)) return candidate
  }
  throw new Error('cannot allocate a preset id')
}

/** 极简 YAML 写入（只写我们控制的结构，避免引入依赖）。 */
function dumpSimpleYaml(obj, indent = 0) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${pad}${key}:`)
      lines.push(dumpSimpleYaml(value, indent + 2))
      continue
    }
    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push(`${pad}${key}: []`); continue }
      lines.push(`${pad}${key}:`)
      for (const item of value) lines.push(`${pad}  - ${JSON.stringify(String(item))}`)
      continue
    }
    if (typeof value === 'boolean' || typeof value === 'number') { lines.push(`${pad}${key}: ${value}`); continue }
    lines.push(`${pad}${key}: ${JSON.stringify(String(value))}`)
  }
  return lines.join('\n')
}

/** 极简 YAML 读取（只认我们自己写出的形态；不认识就当空）。 */
function loadSimpleYaml(text) {
  const out = {}
  let currentKey = null
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (top !== null && !line.startsWith(' ')) {
      const [, key, valueRaw] = top
      const value = valueRaw.trim()
      if (value === '') { currentKey = key; out[key] = out[key] ?? {}; continue }
      currentKey = null
      out[key] = parseScalar(value)
      continue
    }
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item !== null && currentKey !== null) {
      if (!Array.isArray(out[currentKey])) out[currentKey] = []
      out[currentKey].push(parseScalar(item[1].trim()))
      continue
    }
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (nested !== null && currentKey !== null) {
      if (typeof out[currentKey] !== 'object' || Array.isArray(out[currentKey])) out[currentKey] = {}
      out[currentKey][nested[1]] = parseScalar(nested[2].trim())
    }
  }
  return out
}

function parseScalar(raw) {
  const value = String(raw ?? '').trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === '[]') return []
  if (/^-?\d+$/.test(value)) return Number(value)
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try { return JSON.parse(value) } catch { return value.slice(1, -1) }
  }
  return value
}

/**
 * 助手 = DSH preset + 独立记忆目录。
 *
 * 目录布局（复用 DSH 原生 `.agent-presets/<id>/`，不另起炉灶）：
 * ```
 * ~/.dsh/.agent-presets/<id>/
 *   agent.cordis.yml     组合文件（DSH 读取；由我们生成，挂上 soul 运行时）
 *   preset.yml           展示元数据（name / description / order）
 *   memory/              ← 本插件新增：per-agent 记忆隔离
 *     MEMORY.md
 *     USER.md
 *     today.md / week.md / longterm.md
 *     pinned.json
 * ```
 */
export class AgentRegistry {
  /**
   * @param {object} options
   * @param {string} options.presetsRoot  `~/.dsh/.agent-presets`
   * @param {string} options.selfPackage  本插件包名（用于生成组合文件里的行）
   * @param {() => string} [options.defaultPresetId] 读宿主默认 preset
   */
  constructor({ presetsRoot, selfPackage = 'dsh-hanako-memory', defaultPresetId = () => '', personas = null } = {}) {
    if (typeof presetsRoot !== 'string' || presetsRoot === '') throw new TypeError('presetsRoot is required')
    this.presetsRoot = presetsRoot
    this.selfPackage = selfPackage
    this._defaultPresetId = defaultPresetId
    /** 可编辑的人格仓库；为 null 时退回内置四元常量（向后兼容老测试）。 */
    this.personas = personas
  }

  dirFor(id) {
    if (!isValidPresetId(id)) throw new Error(`invalid preset id: ${JSON.stringify(id)}`)
    return path.join(this.presetsRoot, id)
  }

  memoryDirFor(id) {
    return path.join(this.dirFor(id), 'memory')
  }

  /** 列出全部助手（含损坏项，损坏不隐藏 —— 用户要能看见才能修）。 */
  /** 解析人格：优先用可编辑的 PersonaStore，其次退回内置 YUAN 常量（向后兼容）。 */
  _persona(id) {
    if (this.personas && typeof this.personas.resolve === 'function') return this.personas.resolve(id)
    const fallback = YUAN[id] ?? YUAN[DEFAULT_YUAN]
    return { ...fallback, id: Object.hasOwn(YUAN, id) ? id : DEFAULT_YUAN, blocks: fallback.blocks ?? [] }
  }

  /** 人格是否存在（自定义人格也算）。 */
  _knownPersona(id) {
    if (this.personas && typeof this.personas.has === 'function') return this.personas.has(id)
    return Object.hasOwn(YUAN, id)
  }

  /** 把人格写进 MEMORY.md 的首条种子（人格仓库在时用它的渲染）。 */
  _seedLine(persona) {
    if (this.personas && typeof this.personas.seedLine === 'function') return this.personas.seedLine(persona)
    const blocks = persona.blocks && persona.blocks.length > 0 ? persona.blocks.join(' / ') : '无'
    return `我的元是「${persona.label}」（${persona.id}），意识块形态：${blocks}。\n`
  }

  list() {
    let entries
    try {
      entries = fs.readdirSync(this.presetsRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const defaultId = this._defaultPresetId()
    const out = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!isValidPresetId(entry.name)) continue
      const dir = path.join(this.presetsRoot, entry.name)
      const meta = this._readMeta(dir)
      const compositionPath = path.join(dir, 'agent.cordis.yml')
      const metaPath = path.join(dir, 'preset.yml')
      // 只有「曾经是一个助手」的目录才进列表：至少要有 preset.yml 或组合文件。
      // 否则 `memory/` 这种由「给未知 agent 写记忆」产生的目录会被误报成损坏助手。
      if (!fs.existsSync(compositionPath) && !fs.existsSync(metaPath)) continue
      const broken = !fs.existsSync(compositionPath)
      const persona = this._persona(meta.yuan ?? DEFAULT_YUAN)
      // 「人格就是助手」：preset.yml 里的人格字段优先（用户在助手编辑里改的），
      // 没写过才回落到人格模板。这样不再需要单独的「人格」概念。
      const ownLabel = typeof meta.personaLabel === 'string' && meta.personaLabel.trim() !== '' ? meta.personaLabel.trim() : persona.label
      const ownBlurb = typeof meta.personaBlurb === 'string' ? meta.personaBlurb : (persona.blurb ?? '')
      const ownPrompt = typeof meta.personaPrompt === 'string' ? meta.personaPrompt : (persona.prompt ?? '')
      const ownBlocks = Array.isArray(meta.personaBlocks) ? meta.personaBlocks.map(String) : (persona.blocks ?? [])
      out.push({
        id: entry.name,
        name: meta.name ?? entry.name,
        yuan: meta.yuan ?? persona.id,
        persona: {
          id: persona.id,
          label: ownLabel,
          glyph: typeof meta.personaGlyph === 'string' ? meta.personaGlyph : persona.glyph,
          accent: typeof meta.personaAccent === 'string' ? meta.personaAccent : persona.accent,
          moodTag: typeof meta.personaMood === 'string' ? meta.personaMood : persona.moodTag,
          blurb: ownBlurb,
          prompt: ownPrompt,
          blocks: ownBlocks,
          builtin: false,
        },
        /** 这个助手自己的技能清单（技能文件仍是全局目录，这里是「归属/启用」关系）。 */
        skills: Array.isArray(meta.skills) ? meta.skills.map(String) : [],
        description: meta.description ?? '',
        order: typeof meta.order === 'number' ? meta.order : 0,
        isDefault: entry.name === defaultId,
        broken,
        memoryDir: path.join(dir, 'memory'),
        hasMemory: fs.existsSync(path.join(dir, 'memory')),
      })
    }
    out.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name))
    return out
  }

  get(id) {
    return this.list().find(item => item.id === id) ?? null
  }

  _readMeta(dir) {
    const file = path.join(dir, 'preset.yml')
    try {
      return loadSimpleYaml(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }

  /** 组合文件内容：挂本插件的 soul 运行时（提供记忆 section + 工具）。 */
  _composition() {
    return [
      '# 由 dsh-hanako-memory 生成：本 preset 的 standing composition。',
      '# 只挂 soul 运行时；其余插件层沿用 profile 的全局层。',
      '- insert:',
      '    - id: hanako-soul',
      `      name: '${this.selfPackage}/soul'`,
      '      config: {}',
      '',
    ].join('\n')
  }

  /**
   * 新建助手。
   *
   * @param {object} input
   * @param {string} input.name
   * @param {string} [input.yuan]
   * @param {string} [input.description]
   */
  create({ name, yuan = DEFAULT_YUAN, description = '', persona = null, skills = null } = {}) {
    const templatePersona = this._persona(yuan)
    const trimmed = String(name ?? '').trim()
    if (trimmed === '') throw new Error('助手名字不能为空')
    if (!this._knownPersona(yuan)) throw new Error(`未知的人格：${yuan}（换一个已存在的，或先建一个助手再改它的人格）`)

    const existing = this.list().map(item => item.id)
    const id = slugify(trimmed, existing)
    const dir = this.dirFor(id)
    if (fs.existsSync(dir)) throw new Error(`preset 已存在：${id}`)

    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true })

    const maxOrder = this.list().reduce((max, item) => Math.max(max, item.order), 0)
    const meta = {
      name: trimmed,
      description: description === '' ? `${templatePersona.label} · ${templatePersona.blurb}` : description,
      order: maxOrder + 10,
      yuan: templatePersona.id,
      // 人格快照：人格仓库里被删掉时，助手仍然知道自己是谁
      personaLabel: templatePersona.label,
      personaGlyph: templatePersona.glyph,
      personaAccent: templatePersona.accent,
      personaMood: templatePersona.moodTag,
      memory: true,
      experience: false,
      ...persona !== null && typeof persona === 'object' ? {
        personaLabel: String(templatePersona.label ?? persona.name ?? '').slice(0, 40),
        personaBlurb: String(templatePersona.blurb ?? '').slice(0, 400),
        personaPrompt: String(persona.prompt ?? '').slice(0, 4000),
        personaBlocks: (Array.isArray(persona.blocks) ? persona.blocks : []).map(item => String(item).slice(0, 32)).filter(Boolean).slice(0, 12),
      } : {},
      ...Array.isArray(skills) ? { skills: skills.map(String).slice(0, 200) } : {},
    }
    fs.writeFileSync(path.join(dir, 'preset.yml'), `${dumpSimpleYaml(meta)}\n`, 'utf8')
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), this._composition(), 'utf8')

    // 种子记忆：把「元」的性格写进 USER.md 之外的地方不合适；
    // MEMORY.md 只放一条指向性格的事实，让模型知道自己是哪个元。
    const memoryFile = path.join(dir, 'memory', 'MEMORY.md')
    if (!fs.existsSync(memoryFile)) {
      fs.writeFileSync(memoryFile, this._seedLine(templatePersona), 'utf8')
    }

    return this.get(id)
  }

  /** 更新展示元数据（不改组合文件，避免破坏用户自定义）。 */
  update(id, patch = {}) {
    const dir = this.dirFor(id)
    if (!fs.existsSync(dir)) throw new Error(`preset 不存在：${id}`)
    const current = this._readMeta(dir)
    const next = { ...current }

    if (patch.name !== undefined) {
      const trimmed = String(patch.name).trim()
      if (trimmed === '') throw new Error('助手名字不能为空')
      next.name = trimmed
    }
    if (patch.yuan !== undefined) {
      if (!this._knownPersona(patch.yuan)) throw new Error(`未知的人格：${patch.yuan}`)
      const persona = this._persona(patch.yuan)
      next.yuan = persona.id
      next.personaLabel = persona.label
      next.personaGlyph = persona.glyph
      next.personaAccent = persona.accent
      next.personaMood = persona.moodTag
    }
    if (patch.description !== undefined) next.description = String(patch.description)
    // 人格即助手：这些字段直接落在 preset.yml 里，不再需要单独的人格库
    if (patch.personaLabel !== undefined) next.personaLabel = String(patch.personaLabel).trim().slice(0, 40)
    if (patch.personaGlyph !== undefined) next.personaGlyph = String(patch.personaGlyph).slice(0, 8)
    if (patch.personaAccent !== undefined) next.personaAccent = String(patch.personaAccent).slice(0, 32)
    if (patch.personaMood !== undefined) next.personaMood = String(patch.personaMood).slice(0, 24)
    if (patch.personaBlurb !== undefined) next.personaBlurb = String(patch.personaBlurb).slice(0, 400)
    if (patch.personaPrompt !== undefined) next.personaPrompt = String(patch.personaPrompt).slice(0, 4000)
    if (patch.personaBlocks !== undefined) {
      next.personaBlocks = (Array.isArray(patch.personaBlocks) ? patch.personaBlocks : [])
        .map(item => String(item).trim().slice(0, 32))
        .filter(item => item !== '')
        .slice(0, 12)
    }
    if (patch.skills !== undefined) {
      next.skills = (Array.isArray(patch.skills) ? patch.skills : [])
        .map(item => String(item).trim())
        .filter(item => item !== '')
        .slice(0, 200)
    }
    if (patch.order !== undefined) next.order = Number(patch.order) || 0
    if (patch.memory !== undefined) next.memory = patch.memory === true
    if (patch.experience !== undefined) next.experience = patch.experience === true

    fs.writeFileSync(path.join(dir, 'preset.yml'), `${dumpSimpleYaml(next)}\n`, 'utf8')
    return this.get(id)
  }

  /**
   * 删除助手。
   *
   * 保护：默认 preset 不可删；最后一个不可删。
   * 这是 Hanako 的同款保护（默认助手和最后一个助手会被保护）。
   */
  remove(id) {
    const list = this.list()
    const target = list.find(item => item.id === id)
    if (target === undefined) throw new Error(`preset 不存在：${id}`)
    if (target.isDefault) throw new Error('默认助手不可删除；请先把另一个设为主助手')
    if (list.length <= 1) throw new Error('至少要保留一个助手')

    const dir = this.dirFor(id)
    fs.rmSync(dir, { recursive: true, force: true })
    return { removed: id }
  }

  /** 复刻一个助手（用于「基于某元新建」）。 */
  duplicate(id, { name } = {}) {
    const source = this.get(id)
    if (source === null) throw new Error(`preset 不存在：${id}`)
    const created = this.create({ name: name ?? `${source.name} 副本`, yuan: source.yuan, description: source.description })
    // 复制记忆
    try {
      const srcMem = this.memoryDirFor(id)
      const dstMem = this.memoryDirFor(created.id)
      for (const file of ['MEMORY.md', 'USER.md', 'today.md', 'week.md', 'longterm.md', 'pinned.json']) {
        const from = path.join(srcMem, file)
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dstMem, file))
      }
    } catch { /* 记忆复制失败不阻塞助手创建 */ }
    return created
  }

  /** 统计，给 UI 概览。 */
  stats() {
    const list = this.list()
    const byYuan = {}
    for (const item of list) byYuan[item.yuan] = (byYuan[item.yuan] ?? 0) + 1
    return {
      total: list.length,
      byYuan,
      defaultId: list.find(item => item.isDefault)?.id ?? '',
      brokenCount: list.filter(item => item.broken).length,
    }
  }
}

export const __test = { dumpSimpleYaml, loadSimpleYaml, parseScalar }
