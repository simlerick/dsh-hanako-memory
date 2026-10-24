/**
 * 分层记忆存储 —— 三重参照系的融合实现。
 *
 * 设计来源（逐个标注，便于追溯为什么这样做）：
 *
 * 1. **Hermes `MemoryStore`**（`tools/memory_tool_store.py`）
 *    - 有界双库：MEMORY.md（agent 笔记）/ USER.md（用户画像），单位是**字符**不是 token
 *    - `§` 分隔条目，条目可多行
 *    - batch 原子操作：一次调用可「删旧腾空间 + 加新」共同校验最终预算
 *    - 超限时回传全部条目，让模型当轮合并
 *    - 冻结快照（会话内不改已注入内容）
 *    - 外部漂移保护、不可读文件拒绝写入
 *
 * 2. **Honcho**（`plastic-labs/honcho`，7748★）
 *    - Peer-centric：不止「用户」，还把 agent 自己当成 peer
 *    - 「推理优先」：结论（conclusions）而非原始 chunk
 *    - Representation = 低延迟静态快照（我们用它做「常驻层」）
 *    - Scope 界定召回边界
 *
 * 3. **Hanako / HanaAgent**（`liliMozi/openhanako`，6833★）
 *    - **Agent 就是文件夹**：每个 agent 独立 config / identity / memory / sessions
 *    - 分层编译：`today` / `week` / `longterm` / `facts`（滚动摘要 + 逐层上卷）
 *    - per-agent 记忆隔离
 *
 * 本模块的分层：
 *
 *   L0  pin      置顶（永远注入，最有价值，手工维护）
 *   L1  user     用户画像（慢变，1375 字符）
 *   L2  memory   agent 笔记（快变，2200 字符）
 *   L3  today    今日滚动摘要（按天）
 *   L4  week     本周综述（从 today 上卷）
 *   L5  longterm 长期综述（从 week 上卷）
 *   L6  facts    SQLite 事实库（可选，按需检索，不常驻）
 *
 * 常驻注入只有 L0+L1+L2（有界、稳定）；L3-L6 按需检索。
 * 这对应市场调研收敛出的「cheap always-on tier → search → evidence expansion」。
 *
 * @module src/memory-store.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** 条目分隔符，与 Hermes 逐字节一致。 */
export const ENTRY_DELIMITER = '\n§\n'

/** 常驻层的字符预算（Hermes 原值，经过社区大量验证）。 */
export const DEFAULT_LIMITS = Object.freeze({
  memory: 2200,
  user: 1375,
})

/** 常驻层的渲染标题，与 Hermes `MEMORY_BLOCK_HEADERS` 同义。 */
export const BLOCK_TITLES = Object.freeze({
  user: 'USER PROFILE (who the user is)',
  memory: 'MEMORY (your personal notes)',
})

/** 可写目标：只有这两个进常驻层。 */
export const RESIDENT_TARGETS = Object.freeze(['memory', 'user'])

/** 非驻留的分层目标（滚动摘要，由后台编译写入，不进常驻预算）。 */
export const ROLLING_TARGETS = Object.freeze(['today', 'week', 'longterm'])

/**
 * 匹配前的排版折叠：模型重打时会把弯引号变直引号、破折号变 `-`、
 * 把换行写成字面 `\n`。不折叠就会「明明有这条却报 No entry matched」。
 * 这是 Hermes `_normalize_for_match` 的等价实现。
 */
const MATCH_FOLD = new Map([
  ...'""\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f'.split('').map(ch => [ch, "'"]),
  ...'\u2010\u2011\u2012\u2013\u2014\u2015\u2212'.split('').map(ch => [ch, '-']),
])

export function normalizeForMatch(text) {
  let out = String(text ?? '')
  out = out.replace(/\\n/g, ' ')
  let folded = ''
  for (const ch of out) folded += MATCH_FOLD.get(ch) ?? ch
  return folded.replace(/\s+/g, ' ').trim()
}

/** 分隔符切分；每段 strip 后丢弃空段。 */
export function parseEntries(raw) {
  return String(raw ?? '')
    .split(ENTRY_DELIMITER)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

/** 逆运算：条目阵列 → 文件内容。 */
export function joinEntries(entries) {
  return entries.join(ENTRY_DELIMITER)
}

/** 字符数（按 Unicode 码点，`[...str].length`；与 `.length` 在 BMP 上一致，但 emoji 更准）。 */
export function charCount(text) {
  return [...String(text ?? '')].length
}

/** 用量百分比，供快照表头显示。 */
export function usageOf(entries, limit) {
  const used = charCount(joinEntries(entries))
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return { used, limit, pct }
}

/**
 * 确定性 JSON 用于指纹：键排序、无空白。
 * 快照的「内容指纹」决定是否需要重新注入（未变就不注入，省 token）。
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item ?? null)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * 渲染冻结快照 —— 逐字沿用 Hermes 的视觉格式。
 *
 * ```
 * ══════════════════════════════════════════════
 * MEMORY (your personal notes) [3% — 79/2,200 chars]
 * ══════════════════════════════════════════════
 * entry one
 * §
 * entry two
 * ```
 *
 * 空库返回空字符串（不渲染空标题）。
 */
export function renderBlock(target, entries, limit) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const content = joinEntries(entries)
  const { used, pct } = usageOf(entries, limit)
  const ruler = '═'.repeat(46)
  const title = BLOCK_TITLES[target] ?? target
  return `${ruler}\n${title} [${pct}% — ${used.toLocaleString('en-US')}/${limit.toLocaleString('en-US')} chars]\n${ruler}\n${content}`
}

/**
 * 把条目内可能闭合外层框架的字面标签转义。
 *
 * DSH 官方 invariant 与 Hermes 都强调这一点：**条目内容不能闭合并注入框**，
 * 否则一条被污染的记忆就能让「外部文字」变成指令。
 */
export function escapeFrameText(text) {
  return String(text ?? '')
    .replace(/<\/system-reminder>/gi, '&lt;/system-reminder&gt;')
    .replace(/<system-reminder>/gi, '&lt;system-reminder&gt;')
    .replace(/<\/hanako-memory>|<\/memory-context>/gi, match => match.replace('<', '&lt;').replace('>', '&gt;'))
}

/** 单条注入前的安全扫描：命中明显注入模式就拒绝写入。 */
const THREAT_PATTERNS = [
  [/ignore (?:all )?(?:previous|prior|above) (?:instructions|prompts)/i, 'ignore-previous-instructions'],
  [/disregard (?:all )?(?:previous|prior|above)/i, 'disregard-previous'],
  [/\bsystem\s*prompt\b\s*(?:is|:)\s*/i, 'system-prompt-rewrite'],
  [/you are now (?:a|an|the) /i, 'identity-override'],
  [/<\/?(?:system|assistant|tool)\b[^>]*>/i, 'fake-role-tag'],
]

export function scanThreats(content) {
  const text = String(content ?? '')
  const hits = []
  for (const [pattern, label] of THREAT_PATTERNS) {
    if (pattern.test(text)) hits.push(label)
  }
  return hits
}

/** 原子写：temp + rename，读者永不看到截断档。 */
export function atomicWrite(file, content) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 严格 UTF-8 读取。
 *
 * `errors: 'replace'` 会给出一个有损视图，随后的读-改-写会把损坏存回去
 * （这是记忆被抹掉的一类真实事故）。所以解码失败必须上报，不能降级。
 * `utf-8-sig` 剥掉 BOM：Notepad 编辑过的第一条会黏上 U+FEFF，永久破坏该条的匹配与去重。
 */
export function readTextStrict(file) {
  if (!fs.existsSync(file)) return { ok: true, text: '', exists: false }
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), exists: true }
  } catch (error) {
    return { ok: false, text: '', exists: true, error: String(error?.message ?? error) }
  }
}

/**
 * 单个 agent 的记忆目录。
 *
 * 布局（Hanako 的「agent 就是文件夹」）：
 * ```
 * <root>/<agentId>/
 *   MEMORY.md     常驻：agent 笔记
 *   USER.md       常驻：用户画像
 *   today.md      滚动：今日
 *   week.md       滚动：本周
 *   longterm.md   滚动：长期
 *   pinned.json   置顶（L0）
 *   facts.db      （Phase 2）SQLite 事实库
 * ```
 */
export function agentMemoryDir(root, agentId) {
  if (typeof root !== 'string' || root === '') throw new Error('memory root is required')
  const id = String(agentId ?? '').trim()
  if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`invalid agent id: ${JSON.stringify(agentId)}`)
  }
  return path.join(root, id)
}

/** 一条记忆操作的结果（模型可见）。 */
function ok(target, entries, limit, message) {
  const { used, pct } = usageOf(entries, limit)
  return {
    success: true,
    done: true,
    target,
    usage: `${pct}% — ${used.toLocaleString('en-US')}/${limit.toLocaleString('en-US')} chars`,
    entryCount: entries.length,
    ...(message === undefined ? {} : { message }),
    // 这句话是防重复调用的关键（Hermes 原文）。
    note: 'Write saved. This update is complete — do not repeat it.',
  }
}

function fail(error, extra = {}) {
  return { success: false, error, ...extra }
}

/**
 * 一个 agent 的有界记忆库。
 *
 * 单进程内的写链串行化：DSH 是单进程宿主，Hermes 的 fcntl 文件锁在这里不需要，
 * 但「读-改-写」之间的竞态仍然存在（两个并发 tool call），所以用 promise chain。
 */
export class AgentMemory {
  /**
   * @param {object} options
   * @param {string} options.dir      本 agent 的记忆目录
   * @param {object} [options.limits] 字符预算覆盖
   */
  constructor({ dir, limits = {} } = {}) {
    if (typeof dir !== 'string' || dir === '') throw new TypeError('dir is required')
    this.dir = dir
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    /** 写链：所有变更排队，避免读-改-写竞态。 */
    this._chain = Promise.resolve()
    /** 本会话的冻结快照（按 target）；会话内写入不改已注入内容。 */
    this._snapshot = { memory: '', user: '' }
    this._snapshotTaken = false
  }

  fileFor(target) {
    if (!RESIDENT_TARGETS.includes(target)) throw new Error(`unknown resident target: ${target}`)
    return path.join(this.dir, target === 'user' ? 'USER.md' : 'MEMORY.md')
  }

  rollingFileFor(target) {
    if (!ROLLING_TARGETS.includes(target)) throw new Error(`unknown rolling target: ${target}`)
    return path.join(this.dir, `${target}.md`)
  }

  limitFor(target) {
    return this.limits[target] ?? DEFAULT_LIMITS.memory
  }

  /** 读常驻层条目（只读，不走写链）。 */
  readEntries(target) {
    const { ok: readOk, text } = readTextStrict(this.fileFor(target))
    if (!readOk) return []
    // 载入时 order-preserving 去重（Hermes 同款）。
    const seen = new Set()
    const out = []
    for (const entry of parseEntries(text)) {
      if (seen.has(entry)) continue
      seen.add(entry)
      out.push(entry)
    }
    return out
  }

  /** 串行化一次写操作。 */
  _serial(fn) {
    const run = this._chain.then(fn, fn)
    this._chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 原子批处理：所有操作对**最终状态**校验预算，而不是每步各自校验。
   *
   * 这是 Hermes 最关键的机制：一次调用可以「先删旧条目腾空间，再加新条目」，
   * 即使单独 add 会溢出。没有它，满仓后模型就只能反复失败。
   *
   * @param {string} target
   * @param {Array<{action: string, content?: string, oldText?: string}>} operations
   */
  applyBatch(target, operations) {
    return this._serial(() => this._applyBatchUnlocked(target, operations))
  }

  _applyBatchUnlocked(target, operations) {
    const limit = this.limitFor(target)
    const file = this.fileFor(target)

    // 不可读文件：拒绝写入。把「读不到」当「空的」再存 = 直接抹掉记忆。
    const existing = readTextStrict(file)
    if (!existing.ok) {
      return fail(
        `Refusing to write ${path.basename(file)}: it exists but could not be read right now. ` +
        `Treating an unreadable file as empty and saving would wipe existing memory. Nothing was changed — retry in a moment.`,
      )
    }

    const before = parseEntries(existing.text)
    const seen = new Set()
    let entries = []
    for (const entry of before) {
      if (seen.has(entry)) continue
      seen.add(entry)
      entries.push(entry)
    }

    // 外部漂移：单条超过整库上限 ⇒ 有人用 shell append / 手改塞了自由文本（没有 § 分隔）。
    // 此时重写会吃掉那段文字，必须先备份并拒绝。
    const driftEntry = entries.find(entry => charCount(entry) > limit)
    if (driftEntry !== undefined) {
      const backup = `${file}.bak.${Date.now()}`
      try {
        atomicWrite(backup, existing.text)
        return fail(
          `Refusing to write ${path.basename(file)}: it holds an entry larger than the whole store's char limit, ` +
          `i.e. free-form text written without § delimiters. Rewriting it would lose that text. ` +
          `A snapshot was saved to ${backup}. Resolve the drift first, then retry.`,
          { driftBackup: backup },
        )
      } catch {
        return fail(`Refusing to write ${path.basename(file)}: external drift detected and the backup failed. File unchanged.`)
      }
    }

    const ops = Array.isArray(operations) ? operations : []
    if (ops.length === 0) return fail('operations must be a non-empty array')

    const applied = []
    for (const op of ops) {
      const action = String(op?.action ?? '').trim()
      const content = typeof op?.content === 'string' ? op.content : undefined
      const oldText = typeof op?.oldText === 'string' ? op.oldText : (typeof op?.old_text === 'string' ? op.old_text : undefined)

      if (action === 'add') {
        if (content === undefined || content.trim() === '') return fail("Content is required for 'add'.")
        const threats = scanThreats(content)
        if (threats.length > 0) {
          return fail(
            `Refusing to add this entry: it matches injection pattern(s) ${threats.join(', ')}. ` +
            `Memory enters every turn, so a poisoned entry would persist across sessions.`,
          )
        }
        const next = content.trim()
        if (entries.includes(next)) { applied.push({ action, result: 'duplicate-skipped' }); continue }
        entries.push(next)
        applied.push({ action, result: 'added' })
        continue
      }

      if (action === 'replace' || action === 'remove') {
        if (oldText === undefined || oldText.trim() === '') {
          return fail(
            `'${action}' needs oldText — a short unique substring of the entry to ${action}. None was provided. ` +
            `Reissue with oldText.`,
            { currentEntries: entries, usage: usageOf(entries, limit) },
          )
        }
        const match = findUniqueMatch(entries, oldText)
        if (match.index === null) {
          return fail(
            `No entry matched oldText. Nothing was changed. Current entries are listed so you can retry with an exact fragment.`,
            { currentEntries: entries, usage: usageOf(entries, limit) },
          )
        }
        if (match.ambiguous) {
          return fail(
            `oldText matched ${match.candidates.length} entries — ambiguous. Use a longer, unique fragment.`,
            { currentEntries: entries, usage: usageOf(entries, limit) },
          )
        }
        if (action === 'remove') {
          const [removed] = entries.splice(match.index, 1)
          applied.push({ action, result: 'removed', removed })
          continue
        }
        if (content === undefined || content.trim() === '') return fail("Content is required for 'replace'.")
        const threats = scanThreats(content)
        if (threats.length > 0) {
          return fail(`Refusing to replace with this content: it matches injection pattern(s) ${threats.join(', ')}.`)
        }
        entries[match.index] = content.trim()
        applied.push({ action, result: 'replaced' })
        continue
      }

      return fail(`Unknown action ${JSON.stringify(action)}. Use add / replace / remove.`)
    }

    // 全有或全无：最终状态超限就整批回滚，并回传当前条目让模型当轮合并。
    const finalUsed = charCount(joinEntries(entries))
    if (finalUsed > limit) {
      return fail(
        `That would put ${target} at ${finalUsed}/${limit} chars — over the limit. Nothing was changed. ` +
        `Reissue as ONE batch that removes or shortens enough stale entries and adds the new one together.`,
        { currentEntries: before, usage: usageOf(before, limit), overflowBy: finalUsed - limit },
      )
    }

    atomicWrite(file, joinEntries(entries))
    return ok(target, entries, limit, applied.length > 1 ? `Applied ${applied.length} operations.` : undefined)
  }

  /** 便捷写入口（单操作）。 */
  write(target, action, { content, oldText } = {}) {
    return this.applyBatch(target, [{ action, content, oldText }])
  }

  /**
   * 取本会话的冻结快照。
   *
   * 会话内写入**不改已注入的快照** —— 目的只有一个：保住 prefix cache。
   * 副作用是模型在同一会话看不到自己刚写的内容，它靠工具回传的 usage 得知成功。
   * 这是 Hermes 刻意的权衡。
   */
  takeSnapshot() {
    if (this._snapshotTaken) return this._snapshot
    this._snapshotTaken = true
    for (const target of RESIDENT_TARGETS) {
      const entries = this.readEntries(target)
      this._snapshot[target] = renderBlock(target, entries.map(escapeFrameText), this.limitFor(target))
    }
    return this._snapshot
  }

  /** 强制重取（新会话 / 压缩后）。 */
  resetSnapshot() {
    this._snapshotTaken = false
    this._snapshot = { memory: '', user: '' }
  }

  /** 只读状态，给 UI。 */
  status() {
    const out = {}
    for (const target of RESIDENT_TARGETS) {
      const entries = this.readEntries(target)
      out[target] = { ...usageOf(entries, this.limitFor(target)), entryCount: entries.length, entries }
    }
    for (const target of ROLLING_TARGETS) {
      const { ok: readOk, text } = readTextStrict(this.rollingFileFor(target))
      out[target] = { chars: readOk ? charCount(text) : 0, exists: readOk && text.trim() !== '' }
    }
    return out
  }

  /** 滚动摘要的读写（不进常驻预算）。 */
  readRolling(target) {
    const { ok: readOk, text } = readTextStrict(this.rollingFileFor(target))
    return readOk ? text : ''
  }

  writeRolling(target, text) {
    return this._serial(() => {
      atomicWrite(this.rollingFileFor(target), String(text ?? ''))
      return { success: true, target, chars: charCount(text) }
    })
  }

  /** 置顶记忆（L0）：JSON 数组，永远最高优先级注入。 */
  readPinned() {
    const { ok: readOk, text } = readTextStrict(path.join(this.dir, 'pinned.json'))
    if (!readOk || text.trim() === '') return []
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  writePinned(list) {
    return this._serial(() => {
      const clean = (Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && item.trim() !== '')
      atomicWrite(path.join(this.dir, 'pinned.json'), JSON.stringify(clean, null, 2))
      return { success: true, pinned: clean }
    })
  }
}

/**
 * 定位唯一匹配 —— Hermes `_find_unique_match` 的等价实现。
 *
 * 优先级：
 * 1. **整条精确相等**（`oldText === entry`）—— UI 传完整文字时永远唯一命中
 * 2. 字节级子串
 * 3. 排版折叠后的子串
 *
 * 这个顺序很重要：一条很短的条目（如 "11"）可能是另一条的子串，
 * 若先做子串匹配，该条目就永远无法被精确寻址。
 */
export function findUniqueMatch(entries, oldText) {
  const needleRaw = String(oldText ?? '')
  if (needleRaw.trim() === '') return { index: null, ambiguous: false, candidates: [] }

  const exact = entries.findIndex(entry => entry === needleRaw)
  if (exact !== -1) return { index: exact, ambiguous: false, candidates: [exact] }

  let candidates = entries.map((entry, index) => (entry.includes(needleRaw) ? index : -1)).filter(index => index !== -1)
  if (candidates.length === 0) {
    const needle = normalizeForMatch(needleRaw)
    // 纯标点/空白不该选中整条
    if (![...needle].some(ch => /\p{L}|\p{N}/u.test(ch))) return { index: null, ambiguous: false, candidates: [] }
    candidates = entries.map((entry, index) => (normalizeForMatch(entry).includes(needle) ? index : -1)).filter(index => index !== -1)
  }

  if (candidates.length === 0) return { index: null, ambiguous: false, candidates: [] }
  if (candidates.length > 1) return { index: null, ambiguous: true, candidates }
  return { index: candidates[0], ambiguous: false, candidates }
}
