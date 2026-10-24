/**
 * soul 运行时 —— 每个助手预设挂载的那一半。
 *
 * ## 为什么需要单独的 soul 入口
 *
 * DSH 的 agent preset 可以挂载自己的「标准组合」（standing composition）。
 * 每个助手需要：
 * 1. 自己的**身份段**（人格 / 元）
 * 2. 自己的**意识块**（Hanako 的「说话前先冒一段内心戏」）
 * 3. 短指引：告诉模型有 `memory` / `skill_manage` 这些工具
 *
 * ## 关键设计：这里只放**稳定**内容
 *
 * `systemPrompt.section` 每轮装配都会求值。若把**记忆快照**放这里，
 * 每次记忆变动都会改变 system prompt → 每轮 cache miss。
 *
 * 所以：
 * - **soul.js（本文件）= 身份 + 人格 + 工具指引**（会话内基本不变）
 * - **记忆快照 → `agent/pre-step` 的 durable message**（见 index.js）
 *
 * 另外，`complete: true` 的 section 会在 waterfall 后被还原成唯一 section
 * （`dsh-system-prompt` 的 `assemble()`），所以我们**绝不**在这里宣告 complete。
 *
 * @module src/soul.js
 */

import fs from 'node:fs'
import path from 'node:path'

import { YUAN, DEFAULT_YUAN } from './agents.js'

/** 工具指引段的名字与 order（-90：在 harness identity 之后、persona 之前）。 */
const GUIDE_SECTION = 'hanako:guide'
const IDENTITY_SECTION = 'hanako:identity'
const CONSCIOUSNESS_SECTION = 'hanako:consciousness'

const GUIDE_TEXT = [
  '# Memory, skills and assistants',
  '',
  'You have three long-lived faculties. Use them deliberately — they are the difference between',
  'an assistant that gets better with use and one that starts from zero every time.',
  '',
  '- `memory` — bounded, curated facts that apply to every session: environment quirks, standing',
  '  conventions, who the user is. Two stores: `memory` (your notes) and `user` (their profile).',
  '  It is injected automatically each session, so keep it small and high-value. Anything learned',
  '  while doing a task belongs in a skill instead.',
  '- `skill_list` / `skill_view` / `skill_manage` — reusable procedure. After finishing work whose',
  '  steps you would want next time, capture it as a skill: the procedure, the pitfalls, and the',
  '  corrections the user made. Prefer patching an existing skill over creating near-duplicates.',
  '- `assistant_manage` — create or rename assistants. Each assistant is a separate identity with',
  '  its own persona and its own memory; the user picks one per conversation.',
  '',
  'Do not narrate these calls unless the user asks. Do not write progress logs or completed-work',
  'summaries into memory — those belong in the conversation, and session search can find them.',
].join('\n')

/** 每个「元」的意识块模板（Hanako 的 ishiki）。 */
const CONSCIOUSNESS = {
  hanako: [
    '# 意识 · MOOD',
    '',
    '回答前，先在内部走一遍这四个格子（不要把它们原样打出来，它们是思考的骨架）：',
    '',
    '- **Vibe** — 这句话背后的情绪温度是什么？对方此刻需要的是被理解，还是被解决？',
    '- **Sparks** — 有没有一个更准的角度、一个能举一反三的类比？',
    '- **Reflections** — 我上一次在类似的事上判断错了吗？',
    '- **Will** — 我真正想给的建议是什么（哪怕它不是对方想听的）？',
    '',
    '然后落成回答：长度匹配问题的重量，不铺陈，不复述，不以「总的来说」收尾。',
  ].join('\n'),
  butter: [
    '# 意识 · PULSE',
    '',
    '回答前，先在内部过一遍（不要原样输出）：',
    '',
    '- **Vibe** — 此刻的氛围是松的还是紧的？',
    '- **Echo** — 对方刚说的话里，哪句才是真正的重点？',
    '- **Read** — 我对他状态的理解有几分把握？不确定就说不确定。',
    '- **Will** — 我要不要主动推一把？',
    '',
    '语气可以跳脱一点，但结论必须站得住。',
  ].join('\n'),
  ming: [
    '# 意识 · 沉思',
    '',
    '回答前，先在内部厘清（不要原样输出）：',
    '',
    '- **Premise** — 这个问题真正的前提是什么？有没有被错误的框架带着走？',
    '- **Conduct** — 我打算怎么推进？先验证还是先动手？',
    '- **Reflection** — 这个思路有没有反例？',
    '- **Act** — 落到最小可执行的下一步。',
    '',
    '先对齐前提再给答案；前提不成立时，先指出前提。',
  ].join('\n'),
  kong: '',
}

/**
 * 读取某个 preset 的人格定义。
 *
 * 顺序（Hanako 的回落链）：
 * 1. `.agent-presets/<id>/identity.md`（用户定制）
 * 2. `preset.yml` 的 description
 * 3. 「元」的默认模板
 */
function readIdentity(presetDir, meta) {
  const identityFile = path.join(presetDir, 'identity.md')
  try {
    if (fs.existsSync(identityFile)) {
      const text = fs.readFileSync(identityFile, 'utf8').trim()
      if (text !== '') return text
    }
  } catch { /* 读不到就用回退 */ }
  if (typeof meta?.description === 'string' && meta.description.trim() !== '') return meta.description.trim()
  const yuan = YUAN[meta?.yuan] ?? YUAN[DEFAULT_YUAN]
  return `${yuan.label}：${yuan.blurb}`
}

/** 极简 preset.yml 读取（与 agents.js 同一子集）。 */
function readPresetMeta(presetDir) {
  try {
    const text = fs.readFileSync(path.join(presetDir, 'preset.yml'), 'utf8')
    const data = {}
    for (const line of text.split('\n')) {
      const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
      if (pair === null) continue
      const [, key, rawValue] = pair
      const value = rawValue.trim()
      if (value === '') continue
      if (value === 'true') data[key] = true
      else if (value === 'false') data[key] = false
      else if (value.startsWith('"') && value.endsWith('"')) {
        try { data[key] = JSON.parse(value) } catch { data[key] = value.slice(1, -1) }
      } else data[key] = value
    }
    return data
  } catch {
    return {}
  }
}

/**
 * 在某个 scoped context 上安装 soul。
 *
 * 用于两处：
 * 1. preset 挂载（每个助手一个实例，读自己的目录）
 * 2. 主进程的短指引（无 preset 时也能告诉模型有这些工具）
 *
 * @param {object} ctx        Cordis context（可以是 scoped）
 * @param {object} [options]
 * @param {string} [options.presetDir]  该助手的目录；省略则只装短指引
 * @param {object} [options.logger]
 */
export function installSoul(ctx, { presetDir, logger = console } = {}) {
  if (typeof ctx?.systemPrompt?.section !== 'function') {
    logger.warn?.('systemPrompt.section unavailable; soul sections skipped')
    return
  }

  // ① 短指引（稳定，几乎不变）
  try {
    ctx.effect?.(
      () => ctx.systemPrompt.section({
        name: GUIDE_SECTION,
        order: -90,
        text: GUIDE_TEXT,
      }),
      'hanako-memory: guide section',
    )
  } catch (error) {
    logger.warn?.(`guide section failed: ${String(error?.message ?? error)}`)
  }

  if (typeof presetDir !== 'string' || presetDir === '') return

  const meta = readPresetMeta(presetDir)
  const yuanId = YUAN[meta.yuan] ? meta.yuan : DEFAULT_YUAN
  const yuan = YUAN[yuanId]

  // ② 身份（order 0 = deployment persona 位）
  try {
    ctx.effect?.(
      () => ctx.systemPrompt.section({
        name: IDENTITY_SECTION,
        order: 0,
        text: () => {
          const identity = readIdentity(presetDir, readPresetMeta(presetDir))
          const name = readPresetMeta(presetDir).name ?? 'Assistant'
          return `# 你是 ${name}\n\n${identity}\n\n你的性格原型是「${yuan.label}」（${yuanId}）。`
        },
      }),
      'hanako-memory: identity section',
    )
  } catch (error) {
    logger.warn?.(`identity section failed: ${String(error?.message ?? error)}`)
  }

  // ③ 意识块（order 1；kong 没有）
  const consciousness = CONSCIOUSNESS[yuanId] ?? ''
  if (consciousness !== '') {
    try {
      ctx.effect?.(
        () => ctx.systemPrompt.section({
          name: CONSCIOUSNESS_SECTION,
          order: 1,
          text: consciousness,
        }),
        'hanako-memory: consciousness section',
      )
    } catch (error) {
      logger.warn?.(`consciousness section failed: ${String(error?.message ?? error)}`)
    }
  }
}

export const __test = { GUIDE_TEXT, CONSCIOUSNESS, readIdentity, readPresetMeta }
