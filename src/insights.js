/**
 * Peer 洞察层（Honcho 分支）—— 长期记忆的「理论心智」部分。
 *
 * ## Honcho 是什么、我们搬了哪一段
 *
 * Honcho（plastic-labs/honcho）把长期记忆拆成三样东西：
 * 1. **peers** —— 参与对话的双方（用户 / agent）各有自己的「表征」
 * 2. **sessions / messages** —— 原始素材
 * 3. **dialectic** —— 对某个 peer 提出自然语言问题，由「表征」推导出答案；
 *    推导结果带 provenance（依据了哪些观察）与置信度，并会随新证据演化
 *
 * 我们已有的 `MEMORY.md` / `USER.md` 是「策展过的常驻事实」，
 * 缺的正是第 3 层：**从事实里推导出来的、可修正的判断**（比如「他讨厌来回确认」）。
 *
 * ## 本模块的形状（刻意做小）
 *
 * ```
 * <agent>/memory/insights.json
 * [{ id, text, confidence, source, kind, retired, createdAt, updatedAt }]
 * ```
 *
 * - `text`：一句判断（≤240 字符）
 * - `confidence`：0–100，注入时按它排序，低的先掉出预算
 * - `source`：provenance，写「这条是从哪来的」（例如 `session 2026-10-24` / `用户当面说的`）
 * - `kind`：`user`（关于用户）/ `self`（关于自己）/ `work`（关于协作方式）
 * - `retired`：被证伪就退休，不删除（保留可回溯的痕迹，Honcho 也是这个取向）
 *
 * 上限 40 条、注入预算 600 字符 —— 和双库一样是**有界**的，不许无限膨胀。
 *
 * @module src/insights.js
 */

import fs from 'node:fs'
import path from 'node:path'

const LIMITS = Object.freeze({
  insights: 40,
  text: 240,
  source: 80,
  injectChars: 600,
})

const KINDS = Object.freeze(['user', 'self', 'work'])

function clampConfidence(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 50
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** 归一化文本（判重用）。 */
function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.insights) ? parsed.insights : [])
    return list.filter(item => item !== null && typeof item === 'object')
  } catch {
    return []
  }
}

/**
 * 一个助手的洞察库。
 */
export class InsightStore {
  /** @param {{dir: string}} options 记忆目录（`<agent>/memory`） */
  constructor({ dir }) {
    this.dir = dir
    this.file = path.join(dir, 'insights.json')
  }

  _load() {
    return readJson(this.file).map(item => {
      const text = String(item.text ?? '').trim().slice(0, LIMITS.text)
      return {
        id: String(item.id ?? ''),
        text,
        confidence: clampConfidence(item.confidence),
        source: String(item.source ?? '').slice(0, LIMITS.source),
        kind: KINDS.includes(item.kind) ? item.kind : 'work',
        retired: item.retired === true,
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now(),
      }
    }).filter(item => item.text !== '' && item.id !== '')
  }

  _persist(list) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, insights: list }, null, 2))
    } catch { /* 落盘失败不影响内存视图 */ }
  }

  /** 全部（含退休的，面板要能看见并复活）。 */
  list() {
    return this._load().sort((a, b) => (b.retired - a.retired) || (b.confidence - a.confidence) || (b.updatedAt - a.updatedAt))
  }

  /** 注入用：未退休、按置信度降序，取到预算为止。 */
  active(budget = LIMITS.injectChars) {
    const out = []
    let used = 0
    for (const item of this.list()) {
      if (item.retired) continue
      const cost = Array.from(item.text).length + 1
      if (used + cost > budget) continue
      used += cost
      out.push(item)
    }
    return out
  }

  /** 渲染成注入块（没有洞察就返回空串）。 */
  render(budget = LIMITS.injectChars) {
    const items = this.active(budget)
    if (items.length === 0) return ''
    const lines = items.map(item => `- ${item.text}（置信 ${item.confidence}${item.source === '' ? '' : '，来源 ' + item.source}）`)
    return [
      '────────── 洞察（Honcho 式推导结论，可被推翻）──────────',
      ...lines,
    ].join('\n')
  }

  /**
   * 新增一条洞察：同文本（归一化后）视为同一条，只提升置信度而不重复插入。
   *
   * @param {{text: string, confidence?: number, source?: string, kind?: string}} input
   */
  add(input = {}) {
    const text = String(input.text ?? '').trim().slice(0, LIMITS.text)
    if (text === '') throw new Error('洞察内容不能为空')
    const list = this._load()
    const key = normalizeText(text)
    const existing = list.find(item => normalizeText(item.text) === key)
    const now = Date.now()
    if (existing !== undefined) {
      existing.confidence = clampConfidence(Math.max(existing.confidence, input.confidence ?? existing.confidence) + 5)
      existing.updatedAt = now
      existing.retired = false
      this._persist(list)
      return existing
    }
    if (list.length >= LIMITS.insights) {
      // 满了就淘汰「最低置信 + 最久没更新」的一条未退休项
      const victim = list
        .filter(item => !item.retired)
        .sort((a, b) => (a.confidence - b.confidence) || (a.updatedAt - b.updatedAt))[0]
      if (victim === undefined) throw new Error(`洞察已达上限 ${LIMITS.insights} 条`)
      victim.retired = true
      victim.updatedAt = now
    }
    const insight = {
      id: 'ins_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      text,
      confidence: clampConfidence(input.confidence ?? 50),
      source: String(input.source ?? '').trim().slice(0, LIMITS.source),
      kind: KINDS.includes(input.kind) ? input.kind : 'work',
      retired: false,
      createdAt: now,
      updatedAt: now,
    }
    let next = [...list, insight]
    // 总条数硬上限：先清最老的退休项，再退休最低置信的活跃项（保留可回溯痕迹，但不无限增长）
    while (next.length > LIMITS.insights) {
      const retiredIndex = next.findIndex(item => item.retired)
      if (retiredIndex !== -1) {
        next.splice(retiredIndex, 1)
        continue
      }
      const victim = next.reduce((worst, item) => (worst === null || item.confidence < worst.confidence ? item : worst), null)
      if (victim === null) break
      victim.retired = true
      victim.updatedAt = now
      next = next.filter(item => item.id !== victim.id || item.retired)
      next.splice(next.indexOf(victim), 1)
      break
    }
    this._persist(next)
    return insight
  }

  /** 修改（置信度、文本、来源），或「退休」。 */
  update(id, patch = {}) {
    const list = this._load()
    const item = list.find(row => row.id === id)
    if (item === undefined) throw new Error(`洞察不存在：${id}`)
    if (patch.text !== undefined) {
      const text = String(patch.text).trim().slice(0, LIMITS.text)
      if (text === '') throw new Error('洞察内容不能为空')
      item.text = text
    }
    if (patch.confidence !== undefined) item.confidence = clampConfidence(patch.confidence)
    if (patch.source !== undefined) item.source = String(patch.source).slice(0, LIMITS.source)
    if (patch.kind !== undefined && KINDS.includes(patch.kind)) item.kind = patch.kind
    if (patch.retired !== undefined) item.retired = patch.retired === true
    item.updatedAt = Date.now()
    this._persist(list)
    return item
  }

  remove(id) {
    const list = this._load()
    const index = list.findIndex(row => row.id === id)
    if (index === -1) throw new Error(`洞察不存在：${id}`)
    const [removed] = list.splice(index, 1)
    this._persist(list)
    return removed
  }
}

export const __test = { LIMITS, KINDS, normalizeText }
