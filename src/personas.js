/**
 * 人格（persona）—— 把原来硬编码的「四元」变成**用户可自由创造**的数据。
 *
 * ## 为什么改
 *
 * 上一版把 hanako / butter / ming / kong 写死在 `YUAN` 常量里，
 * `Object.hasOwn(YUAN, yuan)` 一拦，用户就只能在这四个里挑。
 * 但人格本来就该是**内容**而不是**代码**：名字、表情、语气、意识块、
 * 甚至一整段自由发挥的人格描述，都应该由用户写。
 *
 * 所以这里把人格落成一个 JSON 存储：
 *
 * ```
 * ~/.dsh/hanako-memory/personas.json   { version: 1, personas: [...] }
 * ```
 *
 * - 内置的四个（hanako / butter / ming / kong）作为**默认模板**存在代码里，
 *   在列表里 `builtin: true`、不可删、不可改（想改就「另存为自定义」）
 * - 自定义人格可以有任意多个，字段全部自由填：
 *   `label / glyph / accent / moodTag / blocks[] / blurb / prompt`
 * - 助手（agent preset）只记 `yuan: <personaId>`，读取时通过本仓库解析，
 *   并在 `preset.yml` 里额外留一份快照（`personaLabel` 等）——
 *   这样即使人格被删，助手也不会变成空白。
 *
 * ## 与 Hanako 的关系
 *
 * Hanako 的每个 agent 目录里有 `identity.md` / `config.yaml`，四个「元」决定
 * 性格与「意识块」形态。我们把「元」升级成可编辑的人格，其余结构保持不变。
 *
 * @module src/personas.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** 内置人格（只读模板）。字段与自定义人格完全一致，方便前端统一渲染。 */
export const BUILTIN_PERSONAS = Object.freeze([
  {
    id: 'hanako',
    label: '小花',
    labelEn: 'Hanako',
    glyph: '',
    accent: '#e8a0bf',
    moodTag: 'MOOD',
    blocks: ['Vibe', 'Sparks', 'Reflections', 'Will'],
    blurb: '温柔、有主见，会在回答前先冒一小段内心戏。',
    prompt: '',
    builtin: true,
  },
  {
    id: 'butter',
    label: '黄油',
    labelEn: 'Butter',
    glyph: '',
    accent: '#f5c76a',
    moodTag: 'PULSE',
    blocks: ['Vibe', 'Echo', 'Read', 'Will'],
    blurb: '跳脱、直球，情绪起伏更明显。',
    prompt: '',
    builtin: true,
  },
  {
    id: 'ming',
    label: '明',
    labelEn: 'Ming',
    glyph: '',
    accent: '#7fb2d9',
    moodTag: '沉思',
    blocks: ['Premise', 'Conduct', 'Reflection', 'Act'],
    blurb: '先厘清前提、再动手；不确定就先问。',
    prompt: '',
    builtin: true,
  },
  {
    id: 'kong',
    label: '空',
    labelEn: 'Kong',
    glyph: '',
    accent: '#9a9a9a',
    moodTag: '—',
    blocks: [],
    blurb: '没有意识块，不演内心戏，直接给答案。',
    prompt: '',
    builtin: true,
  },
])

/** 自定义人格的字段上限（都是「写进 preset.yml 的展示字段」，不需要很大）。 */
const LIMITS = Object.freeze({
  label: 40,
  glyph: 8,
  accent: 32,
  moodTag: 24,
  blurb: 400,
  prompt: 4000,
  blocks: 12,
  blockLength: 32,
  personas: 64,
})

/** 32 位字符串哈希（FNV-1a），给纯中文名生成稳定 id 用。 */
function hash32(input) {
  let hash = 0x811c9dc5
  for (const char of String(input ?? '')) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** 生成一个合法 id（ASCII slug，冲突自动加后缀）。 */
function slugify(input, taken) {
  const base = String(input ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  // 纯中文名归一化后为空 —— 用内容哈希兜底，避免每个人都变成 'persona' / 'persona-2'
  const seed = base === '' ? 'p-' + hash32(input).toString(36) : base
  if (!taken.includes(seed)) return seed
  for (let n = 2; n < 100; n++) {
    const candidate = `${seed}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${seed}-${Date.now().toString(36)}`
}

function trimText(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return []
  return blocks
    .map(item => trimText(item, LIMITS.blockLength))
    .filter(item => item !== '')
    .slice(0, LIMITS.blocks)
}

/** 规整一条人格：所有字段都做长度限制与兜底，坏数据不会污染 preset.yml。 */
function normalizePersona(raw, fallbackId) {
  const id = trimText(raw && raw.id !== undefined ? raw.id : fallbackId, 40) || fallbackId
  const label = trimText(raw && raw.label, LIMITS.label) || id
  return {
    id,
    label,
    labelEn: trimText(raw && raw.labelEn, LIMITS.label) || label,
    // 头像由前端用「名字首字」画，glyph 只作兼容字段保留（不再默认塞 emoji）
    glyph: trimText(raw && raw.glyph, LIMITS.glyph),
    accent: trimText(raw && raw.accent, LIMITS.accent) || '#8a8a8a',
    moodTag: trimText(raw && raw.moodTag, LIMITS.moodTag) || '—',
    blocks: normalizeBlocks(raw && raw.blocks),
    blurb: trimText(raw && raw.blurb, LIMITS.blurb),
    prompt: trimText(raw && raw.prompt, LIMITS.prompt),
    builtin: false,
    createdAt: Number(raw && raw.createdAt) || Date.now(),
    updatedAt: Number(raw && raw.updatedAt) || Date.now(),
  }
}

/**
 * 人格仓库。
 *
 * 内置人格永远在前（不可删改），自定义人格按创建时间排在后面。
 */
export class PersonaStore {
  /**
   * @param {{file: string}} options `file` 指向 personas.json
   */
  constructor({ file }) {
    this.file = file
    this._cache = null
  }

  _load() {
    if (this._cache !== null) return this._cache
    let custom = []
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.personas) ? parsed.personas : [])
      custom = list
        .filter(item => item !== null && typeof item === 'object')
        .map(item => normalizePersona(item, 'persona'))
        .slice(0, LIMITS.personas)
    } catch {
      custom = []
    }
    const builtinIds = new Set(BUILTIN_PERSONAS.map(item => item.id))
    // 自定义人格不能撞内置 id（撞了就改名，避免内置被覆盖）
    const seen = new Set(builtinIds)
    custom = custom.map(item => {
      if (!seen.has(item.id)) { seen.add(item.id); return item }
      const next = slugify(item.id, [...seen])
      seen.add(next)
      return { ...item, id: next }
    })
    this._cache = custom
    return custom
  }

  _persist(custom) {
    this._cache = custom
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, personas: custom }, null, 2))
    } catch { /* 落盘失败不影响内存状态 */ }
  }

  /** @returns {{builtin: boolean}[]} 内置在前，自定义在后 */
  list() {
    const custom = this._load().map(item => ({ ...item, builtin: false }))
    return [...BUILTIN_PERSONAS.map(item => ({ ...item, blocks: [...item.blocks] })), ...custom]
  }

  /** 只看自定义（面板区分「内置模板」和「你创造的」）。 */
  listCustom() {
    return this._load().map(item => ({ ...item, builtin: false }))
  }

  /** @param {string} id */
  get(id) {
    return this.list().find(item => item.id === id) ?? null
  }

  /** 是否存在（含内置）。 */
  has(id) {
    return this.get(id) !== null
  }

  /** 解析人格；找不到就回落到「空」（不静默继承别人的人格）。 */
  resolve(id, fallback = 'kong') {
    return this.get(id) ?? this.get(fallback) ?? this.list()[0]
  }

  /**
   * 新建自定义人格。
   *
   * @param {object} input 任意字段都可留空：名字留空会得到「新人格」
   */
  create(input = {}) {
    const custom = this._load()
    if (custom.length >= LIMITS.personas) throw new Error(`自定义人格上限 ${LIMITS.personas} 个`)
    const taken = [...BUILTIN_PERSONAS.map(item => item.id), ...custom.map(item => item.id)]
    const label = trimText(input.label, LIMITS.label) || '新人格'
    const persona = normalizePersona({
      ...input,
      id: slugify(input.id === undefined || input.id === '' ? label : input.id, taken),
      label,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, 'persona')
    this._persist([...custom, persona])
    return persona
  }

  /**
   * 修改自定义人格。内置人格不可改（要么复制成自定义）。
   *
   * @param {string} id
   * @param {object} patch
   */
  update(id, patch = {}) {
    const custom = this._load()
    const index = custom.findIndex(item => item.id === id)
    if (index === -1) {
      if (BUILTIN_PERSONAS.some(item => item.id === id)) {
        throw new Error('内置人格不可修改；请先「另存为自定义人格」')
      }
      throw new Error(`人格不存在：${id}`)
    }
    const merged = normalizePersona({
      ...custom[index],
      ...patch,
      id: custom[index].id,
      createdAt: custom[index].createdAt,
      updatedAt: Date.now(),
      builtin: false,
    }, custom[index].id)
    const next = [...custom]
    next[index] = merged
    this._persist(next)
    return merged
  }

  /** 删除自定义人格（内置不可删）。 */
  remove(id) {
    const custom = this._load()
    const index = custom.findIndex(item => item.id === id)
    if (index === -1) {
      if (BUILTIN_PERSONAS.some(item => item.id === id)) throw new Error('内置人格不可删除')
      throw new Error(`人格不存在：${id}`)
    }
    const next = [...custom]
    const [removed] = next.splice(index, 1)
    this._persist(next)
    return removed
  }

  /** 复制任意人格（含内置）为可编辑的自定义人格 —— 「另存为」。 */
  duplicate(id, label) {
    const source = this.get(id)
    if (source === null) throw new Error(`人格不存在：${id}`)
    return this.create({
      ...source,
      id: '',
      label: trimText(label, LIMITS.label) || `${source.label} 副本`,
      builtin: false,
    })
  }

  /** 人格写进 MEMORY.md 的那一行种子记忆（助手第一次建库时用）。 */
  seedLine(persona) {
    const blocks = persona.blocks.length > 0 ? persona.blocks.join(' / ') : '无'
    const prompt = persona.prompt === '' ? '' : ` 人格设定：${persona.prompt}`
    return `我是「${persona.label}」（人格 ${persona.id}），意识块形态：${blocks}。${persona.blurb}${prompt}\n`
  }

  /** 注入 system prompt 的人格段（有 prompt 才有内容，否则返回空串）。 */
  renderPrompt(persona) {
    if (persona.prompt === '') return ''
    return [
      `────────── 人格（${persona.label}）──────────`,
      persona.blurb === '' ? '' : persona.blurb,
      persona.prompt,
    ].filter(line => line !== '').join('\n')
  }
}

export const __test = { slugify, normalizePersona, LIMITS }
