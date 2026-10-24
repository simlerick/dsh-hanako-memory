/**
 * 技能体检（自我提升的「诊断」半步）。
 *
 * ## 为什么需要
 *
 * Hermes 在 skill 写入侧有一整套守卫（`skills_tool_dedup` / `skill_linter` /
 * `skill_manager_guards` / `skills_ast_audit`）；我们只搬了写入，没有体检。
 * 结果是技能库会慢慢长出：同名重复、描述几乎一样的近重复、没写 whenToUse、
 * 一篇比一篇长、以及「说了流程但没说何时用」的僵尸技能。
 *
 * 这个模块只做**只读诊断**，把问题连同建议一起交给模型（`skill_audit` 工具）
 * 和面板（技能 tab 顶部的审计条），让「演化」由模型决策、由人确认。
 *
 * 思路和「自我提升」一致：**先看得见问题，再谈自动改**。
 *
 * @module src/skills-audit.js
 */

/** 体积阈值（字符）。超过就建议拆分，而不是继续往里堆。 */
const OVERSIZE_CHARS = 8000
/** 技能数量阈值：超过就开始建议合并。 */
const MANY_SKILLS = 30
/** 近重复判定：描述归一化后 token 重合度 ≥ 该值。 */
const NEAR_DUPLICATE = 0.72

/** 归一化：小写、去标点、切词（中文按字、英文按词）。 */
function tokenize(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
  const tokens = new Set()
  for (const part of normalized.split(' ')) {
    if (part === '') continue
    if (/[\u4e00-\u9fff]/.test(part)) {
      // 中文：逐字 + 双字，避免整段当一个 token
      for (const char of part) tokens.add(char)
      for (let i = 0; i + 1 < part.length; i++) tokens.add(part.slice(i, i + 2))
    } else {
      tokens.add(part)
    }
  }
  return tokens
}

/** Jaccard 相似度。 */
function similarity(a, b) {
  const left = tokenize(a)
  const right = tokenize(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * 体检技能库。
 *
 * @param {Array<{name: string, description?: string, whenToUse?: string, chars?: number, updatedAt?: number}>} skills
 * @returns {{summary: object, findings: Array<object>}}
 */
export function auditSkills(skills) {
  const list = Array.isArray(skills) ? skills.filter(item => item && typeof item.name === 'string') : []
  const findings = []

  const push = (severity, kind, skill, detail, suggestion) => {
    findings.push({ severity, kind, skill, detail, suggestion })
  }

  // 1) 名字重复（大小写/空格差异）
  const byNormalized = new Map()
  for (const item of list) {
    const key = item.name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!byNormalized.has(key)) byNormalized.set(key, [])
    byNormalized.get(key).push(item)
  }
  for (const [key, group] of byNormalized) {
    if (group.length > 1) {
      push('error', 'duplicate-name', group.map(item => item.name).join(' / '),
        `名字归一化后相同：${key}`,
        '合并成一个技能：保留最新的正文，把另一份里独有的步骤并进去，然后删掉多余目录')
    }
  }

  // 2) 近重复（描述相似）
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const score = similarity(list[i].description ?? list[i].name, list[j].description ?? list[j].name)
      if (score >= NEAR_DUPLICATE) {
        push('warning', 'near-duplicate', `${list[i].name} ↔ ${list[j].name}`,
          `描述相似度 ${(score * 100).toFixed(0)}%`,
          '两者多半是同一件事的两个版本：合成一个，把差异点写成「变体」小节')
      }
    }
  }

  // 3) 缺字段 / 太长
  for (const item of list) {
    if (String(item.description ?? '').trim() === '') {
      push('warning', 'missing-description', item.name, '缺 description（技能目录里只有名字）',
        '补一行 description：做什么 + 什么时候用，这是索引里唯一的检索信号')
    }
    if (String(item.whenToUse ?? '').trim() === '') {
      push('info', 'missing-when-to-use', item.name, '缺 whenToUse',
        '写清触发条件（例如「要加面板 / 工具 / 路由时」），否则模型不会想起来用它')
    }
    if (Number(item.chars ?? 0) > OVERSIZE_CHARS) {
      push('info', 'oversize', item.name, `${item.chars} 字符 > ${OVERSIZE_CHARS}`,
        '拆成「主线」+ 若干附属文件（references/*.md），正文只留决策要点')
    }
  }

  // 4) 数量与陈旧度
  if (list.length > MANY_SKILLS) {
    push('info', 'many-skills', '全部', `共 ${list.length} 个（阈值 ${MANY_SKILLS}）`,
      '技能太多会让目录本身变成噪音：把低频的合并或退休')
  }
  const now = Date.now()
  const stale = list.filter(item => Number(item.updatedAt ?? 0) > 0 && now - Number(item.updatedAt) > 180 * 86400e3)
  if (stale.length > 0) {
    push('info', 'stale', stale.map(item => item.name).join(' / '),
      `${stale.length} 个技能超过 180 天没更新`,
      '确认是否还准确：过时的流程比没有更危险，要么更新要么删')
  }

  const counts = { error: 0, warning: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] += 1

  return {
    summary: {
      skills: list.length,
      findings: findings.length,
      error: counts.error,
      warning: counts.warning,
      info: counts.info,
      totalChars: list.reduce((sum, item) => sum + Number(item.chars ?? 0), 0),
    },
    findings,
  }
}

/** 把体检结果渲染成给模型看的一段文字（工具返回值用）。 */
export function renderAudit(audit) {
  if (audit.findings.length === 0) {
    return `技能库体检通过：${audit.summary.skills} 个技能，没有发现重复/缺字段/过长问题。`
  }
  const lines = [
    `技能库体检：${audit.summary.skills} 个技能，${audit.summary.findings} 条发现` +
    `（error ${audit.summary.error} / warning ${audit.summary.warning} / info ${audit.summary.info}）`,
  ]
  for (const finding of audit.findings) {
    lines.push(`- [${finding.severity}] ${finding.kind} — ${finding.skill}：${finding.detail} → ${finding.suggestion}`)
  }
  return lines.join('\n')
}

export const __test = { similarity, tokenize, NEAR_DUPLICATE, OVERSIZE_CHARS }
