/**
 * Skill 读写层 —— 市场上最稀缺的能力。
 *
 * ## 为什么需要单独一层
 *
 * DSH 的 `ctx.skills` 是**只读的注册表**：
 * ```
 * registerProvider(create) / register(skill) / list() / snapshot() / get()
 * ```
 * **没有 create / update / delete / writeFile。** 这是刻意设计：skill 是「被发现的资产」，
 * 不是「被写入的状态」。
 *
 * 所以写入必须落到文件系统。而 `@deepseek-ai/dsh-skill-filesystem` 的发现根按优先级是：
 *
 * | 优先 | 根目录 | 来源 |
 * |---|---|---|
 * | 1 | `<projectRoot>/.dsh/skills` | project-dsh |
 * | 2 | `<projectRoot>/.agents/skills` | project-agents |
 * | 3 | `customSkillDirs` | custom |
 * | 4 | `<DSH_HOME>/skills` | user-dsh |
 * | 5 | `<agentsHome>/skills` | user-agents（默认 `~/.agents/skills`） |
 * | 6 | `bundledSkillDir` | bundled |
 *
 * ## 一个必须知道的坑
 *
 * 手工把文件放进这些根**有时会静默失效**：catalog 有 mtime 签名缓存，而就地编辑
 * `SKILL.md` **不改变目录 mtime**。（engramory 的 README 明确警告过这一点。）
 *
 * 对策（本模块全部实施）：
 * 1. 写入后主动 touch 父目录（改 mtime），让签名失效
 * 2. 通过 `skills/change` 事件通知 catalog
 * 3. 新建 skill 时建新目录（天然改父目录 mtime）
 *
 * ## frontmatter 契约（对齐 Hermes `_validate_frontmatter`）
 *
 * - 必须以 `---` 开头 / 闭合，YAML 可解析成 mapping
 * - 必须有 `name` 与 `description`
 * - `description` ≤ 1024 字符；新 skill 建议 ≤ 240（系统提示预算，超限会被索引截断成
 *   `...` 而毁掉路由信号）
 * - frontmatter 之后必须有正文
 * - 整份 `SKILL.md` ≤ 65536 字符（超限提示拆到 `references/`）
 *
 * @module src/skills.js
 */

import fs from 'node:fs'
import path from 'node:path'

export const SKILL_FILENAME = 'SKILL.md'
export const MAX_DESCRIPTION = 1024
/** 新 skill 的建议上限：系统提示里技能索引的预算。超了会被截断，破坏路由。 */
export const RECOMMENDED_DESCRIPTION = 240
export const MAX_CONTENT = 65536
export const MAX_NAME = 64
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** frontmatter 里的保留字段顺序（写回时保持稳定）。 */
const FRONTMATTER_ORDER = ['name', 'description', 'whenToUse', 'version', 'allowed-tools', 'model-invocable', 'user-invocable']

export function isValidSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name)
}

/**
 * 解析 frontmatter。
 *
 * 只支持我们需要的 YAML 子集（标量 + 简单阵列），不引入 js-yaml ——
 * 插件要零外部依赖，且 skill frontmatter 在实践中就是这个形状。
 * 遇到复杂形态（嵌套 mapping）返回 `ok: false` 并交给调用方决定。
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  if (!source.startsWith('---')) return { ok: false, reason: 'SKILL.md must start with YAML frontmatter (---)' }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { ok: false, reason: 'SKILL.md frontmatter is not closed (missing closing ---)' }

  const headerText = source.slice(3, end).replace(/^\n/, '')
  const body = source.slice(end + 4).replace(/^\n/, '')
  const data = {}
  let currentKey = null

  for (const rawLine of headerText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue

    const listItem = /^\s+-\s+(.*)$/.exec(line)
    if (listItem !== null && currentKey !== null) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = []
      data[currentKey].push(scalar(listItem[1]))
      continue
    }

    const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (pair === null) {
      // 嵌套 mapping 之类我们不支持的形态
      return { ok: false, reason: `unsupported frontmatter line: ${JSON.stringify(line.slice(0, 60))}` }
    }
    const [, key, rawValue] = pair
    const value = rawValue.trim()
    if (value === '') { currentKey = key; data[key] = ''; continue }
    currentKey = null
    data[key] = scalar(value)
  }

  return { ok: true, data, body }
}

function scalar(raw) {
  const value = String(raw ?? '').trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === '[]') return []
  if (/^-?\d+$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1)
    if (value.startsWith('"')) { try { return JSON.parse(value) } catch { return inner } }
    return inner.replace(/''/g, "'")
  }
  return value
}

/** 渲染 frontmatter + body（保持字段顺序稳定，便于 diff）。 */
export function renderSkill({ name, description, whenToUse, metadata = {}, body }) {
  const lines = ['---', `name: ${name}`, `description: ${description}`]
  if (whenToUse !== undefined && whenToUse !== '') lines.push(`whenToUse: ${whenToUse}`)
  for (const key of FRONTMATTER_ORDER) {
    if (key === 'name' || key === 'description' || key === 'whenToUse') continue
    if (metadata[key] !== undefined) lines.push(`${key}: ${metadata[key]}`)
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (FRONTMATTER_ORDER.includes(key)) continue
    lines.push(`${key}: ${value}`)
  }
  lines.push('---', '', String(body ?? '').replace(/\s+$/, ''))
  return `${lines.join('\n')}\n`
}

/**
 * 校验一份 SKILL.md 内容。
 * @returns {{ok: true, data: object, body: string} | {ok: false, reason: string}}
 */
export function validateSkill(content, { isNew = true } = {}) {
  const parsed = parseFrontmatter(content)
  if (!parsed.ok) return parsed

  const { data, body } = parsed
  if (typeof data.name !== 'string' || data.name.trim() === '') {
    return { ok: false, reason: "frontmatter must include a non-empty 'name' field" }
  }
  if (!isValidSkillName(data.name)) {
    return { ok: false, reason: `skill name ${JSON.stringify(data.name)} must be lowercase kebab-case (${SKILL_NAME_RE})` }
  }
  if (typeof data.description !== 'string' || data.description.trim() === '') {
    return { ok: false, reason: "frontmatter must include a non-empty 'description' field" }
  }
  const descLength = [...data.description].length
  if (descLength > MAX_DESCRIPTION) {
    return { ok: false, reason: `description is ${descLength} chars (limit ${MAX_DESCRIPTION})` }
  }
  if (isNew && descLength > RECOMMENDED_DESCRIPTION) {
    return {
      ok: false,
      reason: `description is ${descLength} chars — new skills should fit the ${RECOMMENDED_DESCRIPTION}-char system-prompt budget ` +
        `(one sentence, trigger first, ends with a period). The skill index truncates longer descriptions, destroying the routing signal. ` +
        `Move detail into the body.`,
    }
  }
  if (body.trim() === '') {
    return { ok: false, reason: 'SKILL.md must have content after the frontmatter (instructions, procedures, etc.)' }
  }
  const total = [...String(content)].length
  if (total > MAX_CONTENT) {
    return {
      ok: false,
      reason: `SKILL.md is ${total.toLocaleString('en-US')} chars (limit ${MAX_CONTENT.toLocaleString('en-US')}). ` +
        `Split detail into references/ or templates/ supporting files.`,
    }
  }
  return { ok: true, data, body }
}

/** 原子写。 */
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 触碰目录 mtime —— 破解「就地编辑不改目录 mtime」的缓存问题。
 * 若目录不存在则创建。
 */
function touchDir(dir) {
  try {
    const now = new Date()
    fs.utimesSync(dir, now, now)
    return true
  } catch {
    try { fs.mkdirSync(dir, { recursive: true }); return true } catch { return false }
  }
}

/**
 * Skill 文件系统仓库。
 *
 * 只管文件；catalog 失效通知由宿主侧（index.js）在操作后触发 `skills/change`。
 */
export class SkillStore {
  /**
   * @param {object} options
   * @param {string} options.root             写入根（默认 `<DSH_HOME>/skills`）
   * @param {string[]} [options.readRoots]    额外只读根（用于 list/get 时能看见别处安装的 skill）
   */
  constructor({ root, readRoots = [] } = {}) {
    if (typeof root !== 'string' || root === '') throw new TypeError('root is required')
    this.root = root
    this.readRoots = [root, ...readRoots.filter(item => item !== root)]
  }

  /** 一个 skill 的目录（<root>/<name>，可带 category 子目录）。 */
  dirFor(name, category = '') {
    if (!isValidSkillName(name)) throw new Error(`invalid skill name: ${JSON.stringify(name)}`)
    const cat = String(category ?? '').trim()
    if (cat !== '' && !/^[a-z0-9][a-z0-9._-]*$/.test(cat)) throw new Error(`invalid category: ${JSON.stringify(category)}`)
    return cat === '' ? path.join(this.root, name) : path.join(this.root, cat, name)
  }

  fileFor(name, category = '') {
    return path.join(this.dirFor(name, category), SKILL_FILENAME)
  }

  /** 递归找出所有 SKILL.md（支持 category 子目录）。 */
  _scan(root) {
    const found = []
    const walk = (dir, depth) => {
      if (depth > 4) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const child = path.join(dir, entry.name)
        const skillFile = path.join(child, SKILL_FILENAME)
        if (fs.existsSync(skillFile)) {
          found.push({ dir: child, file: skillFile })
          continue // skill 目录内的 references/ 等不再深入
        }
        walk(child, depth + 1)
      }
    }
    walk(root, 0)
    return found
  }

  /** 列出全部 skill 摘要（name + description + whenToUse + 路径）。 */
  list() {
    const seen = new Set()
    const out = []
    for (const root of this.readRoots) {
      for (const { dir, file } of this._scan(root)) {
        let text
        try { text = fs.readFileSync(file, 'utf8') } catch { continue }
        const parsed = parseFrontmatter(text)
        if (!parsed.ok) continue
        const name = String(parsed.data.name ?? '').trim()
        if (name === '' || seen.has(name)) continue
        seen.add(name)
        out.push({
          name,
          description: String(parsed.data.description ?? ''),
          whenToUse: parsed.data.whenToUse === undefined ? undefined : String(parsed.data.whenToUse),
          dir,
          file,
          root,
          relativePath: path.relative(root, dir).split(path.sep).join('/'),
          /** 面板展示用：SKILL.md 的字符数（已经读进来了，顺手带上，不额外 IO）。 */
          chars: text.length,
        })
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /** 取完整内容（SKILL.md 或附屬檔）。 */
  get(name, { file = '', category = '' } = {}) {
    if (!isValidSkillName(name)) throw new Error(`invalid skill name: ${JSON.stringify(name)}`)
    let skillDir = null
    // 先按写入根直接找，再扫描只读根
    const direct = this.dirFor(name, category)
    if (fs.existsSync(path.join(direct, SKILL_FILENAME))) skillDir = direct
    else {
      const hit = this.list().find(item => item.name === name)
      if (hit !== undefined) skillDir = hit.dir
    }
    if (skillDir === null) return null

    const target = file === '' ? path.join(skillDir, SKILL_FILENAME) : path.join(skillDir, String(file))
    // 路径逃逸防护
    const normalized = path.resolve(target)
    if (!normalized.startsWith(path.resolve(skillDir) + path.sep) && normalized !== path.resolve(skillDir, SKILL_FILENAME)) {
      throw new Error('file path escapes the skill directory')
    }
    if (!fs.existsSync(normalized)) return null
    const content = fs.readFileSync(normalized, 'utf8')
    if (file === '') {
      const parsed = parseFrontmatter(content)
      return {
        name,
        dir: skillDir,
        file: normalized,
        content,
        frontmatter: parsed.ok ? parsed.data : {},
        body: parsed.ok ? parsed.body : content,
        linkedFiles: this._listLinked(skillDir),
      }
    }
    return { name, file: normalized, content }
  }

  /** 列出 skill 目录下的附属资源（references / templates / scripts / assets）。 */
  _listLinked(skillDir) {
    const out = []
    const walk = (dir, prefix, depth) => {
      if (depth > 3) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) { walk(path.join(dir, entry.name), rel, depth + 1); continue }
        if (entry.name === SKILL_FILENAME && prefix === '') continue
        out.push(rel)
      }
    }
    walk(skillDir, '', 0)
    out.sort()
    return out
  }

  /**
   * 新建 skill。
   * @returns {{ok: true, name: string, file: string} | {ok: false, reason: string}}
   */
  create({ name, description, content, body, category = '', whenToUse, metadata = {} } = {}) {
    if (!isValidSkillName(name)) {
      return { ok: false, reason: `skill name ${JSON.stringify(name)} must be lowercase kebab-case (${SKILL_NAME_RE})` }
    }
    const dir = this.dirFor(name, category)
    if (fs.existsSync(dir)) return { ok: false, reason: `skill ${JSON.stringify(name)} already exists at ${dir}` }

    const rendered = content !== undefined
      ? String(content)
      : renderSkill({ name, description, whenToUse, metadata, body })

    const checked = validateSkill(rendered, { isNew: true })
    if (!checked.ok) return { ok: false, reason: checked.reason }
    // 文件名与 frontmatter name 必须一致，否则发现层与调用层会对不上
    if (checked.data.name !== name) {
      return { ok: false, reason: `frontmatter name ${JSON.stringify(checked.data.name)} must match the requested name ${JSON.stringify(name)}` }
    }

    const file = path.join(dir, SKILL_FILENAME)
    atomicWrite(file, rendered)
    // 新建目录天然改了父目录 mtime，但仍显式 touch，避免某些文件系统精度问题
    touchDir(path.dirname(dir))
    return { ok: true, name, file }
  }

  /**
   * 补丁式修改（old_string / new_string）。
   *
   * 这是 Hermes `skill_manage` 的 patch 形态：模型给小片段，避免整档重写。
   * `old_string` 必须唯一命中，否则拒绝（与 DSH 的 edit 工具同一纪律）。
   */
  patch(name, { oldString, newString, replaceAll = false, file = '', category = '' } = {}) {
    const current = this.get(name, { file, category })
    if (current === null) return { ok: false, reason: `skill ${JSON.stringify(name)} not found` }
    if (typeof oldString !== 'string' || oldString === '') {
      return { ok: false, reason: 'old_string is required for patch' }
    }
    if (typeof newString !== 'string') return { ok: false, reason: 'new_string is required for patch' }

    const before = current.content
    const occurrences = countOccurrences(before, oldString)
    if (occurrences === 0) {
      return { ok: false, reason: 'old_string was not found in the skill file; nothing was changed' }
    }
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, reason: `old_string matched ${occurrences} times — pass replace_all or use a longer unique fragment` }
    }
    const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString)

    if (file === '') {
      const checked = validateSkill(after, { isNew: false })
      if (!checked.ok) return { ok: false, reason: checked.reason }
    }

    atomicWrite(current.file, after)
    touchDir(path.dirname(current.file))
    return { ok: true, name, file: current.file, replaced: replaceAll ? occurrences : 1 }
  }

  /** 整档重写（最后手段）。 */
  rewrite(name, content, { category = '' } = {}) {
    const current = this.get(name, { category })
    if (current === null) return { ok: false, reason: `skill ${JSON.stringify(name)} not found` }
    const checked = validateSkill(String(content), { isNew: false })
    if (!checked.ok) return { ok: false, reason: checked.reason }
    if (checked.data.name !== name) {
      return { ok: false, reason: `frontmatter name ${JSON.stringify(checked.data.name)} must match ${JSON.stringify(name)}` }
    }
    atomicWrite(current.file, String(content))
    touchDir(path.dirname(current.file))
    return { ok: true, name, file: current.file }
  }

  /** 写附属文件（references/templates/scripts）。 */
  writeFile(name, { filePath, content, category = '' } = {}) {
    if (!isValidSkillName(name)) return { ok: false, reason: `invalid skill name ${JSON.stringify(name)}` }
    const rel = String(filePath ?? '').replace(/\\/g, '/').trim()
    if (rel === '' || rel.startsWith('/') || rel.includes('../') || rel === SKILL_FILENAME) {
      return { ok: false, reason: `file_path must be a supporting file inside the skill directory (got ${JSON.stringify(filePath)})` }
    }
    const dir = this.dirFor(name, category)
    if (!fs.existsSync(dir)) return { ok: false, reason: `skill ${JSON.stringify(name)} not found` }
    const target = path.join(dir, ...rel.split('/'))
    if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
      return { ok: false, reason: 'file path escapes the skill directory' }
    }
    atomicWrite(target, String(content ?? ''))
    touchDir(dir)
    return { ok: true, name, file: target }
  }

  /** 删除附属文件。 */
  removeFile(name, { filePath, category = '' } = {}) {
    const dir = this.dirFor(name, category)
    if (!fs.existsSync(dir)) return { ok: false, reason: `skill ${JSON.stringify(name)} not found` }
    const rel = String(filePath ?? '').replace(/\\/g, '/').trim()
    if (rel === '' || rel.startsWith('/') || rel.includes('../') || rel === SKILL_FILENAME) {
      return { ok: false, reason: 'file_path must name a supporting file (SKILL.md itself cannot be removed this way)' }
    }
    const target = path.join(dir, ...rel.split('/'))
    if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
      return { ok: false, reason: 'file path escapes the skill directory' }
    }
    if (!fs.existsSync(target)) return { ok: false, reason: `file ${JSON.stringify(rel)} not found` }
    fs.rmSync(target, { force: true })
    touchDir(dir)
    return { ok: true, name, removed: rel }
  }

  /** 删除整个 skill（只允许删写入根里的，不碰只读根）。 */
  remove(name, { category = '' } = {}) {
    const dir = this.dirFor(name, category)
    if (!fs.existsSync(path.join(dir, SKILL_FILENAME))) {
      return { ok: false, reason: `skill ${JSON.stringify(name)} not found in the writable root` }
    }
    fs.rmSync(dir, { recursive: true, force: true })
    touchDir(path.dirname(dir))
    return { ok: true, name, removed: dir }
  }
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let index = 0
  for (;;) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) break
    count += 1
    index = found + needle.length
  }
  return count
}

export const __test = { countOccurrences, touchDir }
