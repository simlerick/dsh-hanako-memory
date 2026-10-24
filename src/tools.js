/**
 * 工具层 —— 暴露给模型的三个工具。
 *
 * 设计原则（来自 Hermes `MEMORY_SCHEMA` 与 `SKILL_MANAGE_SCHEMA` 的实战教训）：
 *
 * 1. **description 决定模型用得对不对**，比 parameters  schema 更重要。
 *    Hermes 的 memory description 有四段：WHEN / IF FULL / TARGETS / SKIP，
 *    每段都在防一类真实误用。
 *
 * 2. **单工具多 action**，而不是拆成一堆小工具。工具数量直接吃 context 预算。
 *
 * 3. **operations 数组形态**（skill_manage）：每个 action 一个独立 shape，
 *    不要摊平成一个对象 —— 实测 27B 模型会把 write_file 的字段串到 create 里，
 *    导致整批回滚（Hermes issue #112677）。
 *
 * @module src/tools.js
 */

import { DEFAULT_LIMITS, RESIDENT_TARGETS } from './memory-store.js'
import { YUAN } from './agents.js'

/** 常驻记忆工具。 */
export const MEMORY_TOOL = {
  name: 'memory',
  description: [
    'Curate durable memory. Two stores: `memory` (your own notes: environment, project conventions,',
    'tool quirks, lessons) and `user` (who the user is: name, role, preferences, style).',
    '',
    'WHEN: only for facts that apply to EVERY session regardless of task. Anything learned while doing',
    'a task (procedures, pitfalls, that kind of work\'s preferences and corrections) belongs in a skill',
    'via `skill_manage` — where it loads only when relevant. Memory is injected into every turn and',
    `must stay small (${DEFAULT_LIMITS.memory} chars for memory, ${DEFAULT_LIMITS.user} for user).`,
    '',
    'IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that removes or',
    'shortens enough stale entries and adds the new one together. Never retry the same add.',
    '',
    'SKIP: trivial or easily re-discovered facts, raw data dumps, task progress, completed-work logs,',
    'temporary TODO state (use session search for those). Reusable procedures belong in a skill.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'replace', 'remove'],
        description: "Single-op shape. Omit when using 'operations'.",
      },
      target: {
        type: 'string',
        enum: [...RESIDENT_TARGETS],
        description: "'memory' for your own notes, 'user' for the user profile.",
      },
      content: {
        type: 'string',
        description: "Required for 'add' and 'replace'. The new entry text.",
      },
      oldText: {
        type: 'string',
        description:
          "REQUIRED for 'replace' and 'remove': a short unique fragment of the entry to change. " +
          'An exact whole-entry match wins over a substring match, so passing the full entry text always addresses that entry.',
      },
      operations: {
        type: 'array',
        description:
          'Batch shape: a list of operations applied atomically against the FINAL char budget. ' +
          'Preferred when making multiple changes or consolidating to make room. Each item is {action, content?, oldText?}.',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'replace', 'remove'] },
            content: { type: 'string' },
            oldText: { type: 'string' },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    required: ['target'],
  },
}

/** Skill 管理工具。 */
export const SKILL_MANAGE_TOOL = {
  name: 'skill_manage',
  description: [
    'Create, patch and organize skills. A skill is a directory holding SKILL.md (YAML frontmatter +',
    'instructions) plus optional references/, templates/, scripts/.',
    '',
    'WHEN: after finishing work whose procedure you would want next time — the steps, the pitfalls,',
    "the user's corrections for that kind of task. Memory is for cross-session facts; skills are for",
    'reusable procedure. Prefer `patch` over `create` to extend an existing skill rather than',
    'accumulating near-duplicate skills.',
    '',
    'frontmatter contract: must start with --- and close with ---; must include `name` (lowercase',
    'kebab-case, matching the directory) and `description` (one sentence, trigger first, ends with a',
    'period, ≤240 chars for new skills — longer gets truncated in the skill index and loses routing',
    'signal); a non-empty body is required after the frontmatter.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        description:
          'Ordered ops; each names its target skill. Each action has its own shape — another action\'s ' +
          'field is invalid.',
        items: {
          anyOf: [
            {
              type: 'object',
              properties: {
                action: { const: 'create' },
                skill: { type: 'string', description: 'lowercase kebab-case name; becomes the directory name' },
                description: { type: 'string', description: 'One sentence, trigger first, ends with a period.' },
                content: { type: 'string', description: 'Full SKILL.md text (YAML frontmatter + markdown body). Preferred.' },
                body: { type: 'string', description: 'Markdown body only; use instead of content to let the tool render frontmatter.' },
                category: { type: 'string', description: "Optional category subdirectory (e.g. 'devops')." },
              },
              required: ['action', 'skill'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                action: { const: 'patch' },
                skill: { type: 'string' },
                old_string: { type: 'string', description: 'Text to replace; must occur exactly once unless replace_all.' },
                new_string: { type: 'string', description: 'Replacement text.' },
                replace_all: { type: 'boolean', description: 'Replace all occurrences (default false).' },
                file_path: { type: 'string', description: 'Optional supporting file (e.g. references/api.md); default SKILL.md.' },
              },
              required: ['action', 'skill', 'old_string', 'new_string'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                action: { const: 'write_file' },
                skill: { type: 'string' },
                file_path: { type: 'string', description: 'Supporting file path inside the skill directory.' },
                file_content: { type: 'string', description: 'Full text of the supporting file.' },
              },
              required: ['action', 'skill', 'file_path', 'file_content'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                action: { const: 'remove_file' },
                skill: { type: 'string' },
                file_path: { type: 'string' },
              },
              required: ['action', 'skill', 'file_path'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                action: { const: 'delete' },
                skill: { type: 'string' },
              },
              required: ['action', 'skill'],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ['operations'],
  },
}

/** Skill 浏览工具（读）。 */
export const SKILL_VIEW_TOOL = {
  name: 'skill_view',
  description:
    'Load a skill\'s full SKILL.md, or one of its supporting files. Call with just `name` first to get ' +
    'the body plus a `linkedFiles` list; then call again with `file` to read a specific supporting file.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact skill name (use skill_list to discover names).' },
      file: { type: 'string', description: "Optional supporting file path (e.g. 'references/api.md')." },
    },
    required: ['name'],
  },
}

/** Skill 列表工具。 */
export const SKILL_LIST_TOOL = {
  name: 'skill_list',
  description: 'List available skills (name + description only). Use skill_view(name) to load the full body.',
  parameters: { type: 'object', properties: {}, required: [] },
}

/** 助手管理工具 —— 让模型也能创建/切换助手。 */
export const AGENT_MANAGE_TOOL = {
  name: 'assistant_manage',
  description: [
    'Manage assistants (agent presets). An assistant is a separate identity with its own persona,',
    'memory and sessions; the user picks one per conversation.',
    '',
    'Each assistant has a "yuan" (性格): ' + Object.values(YUAN).map(item => `${item.id} (${item.label})`).join(', ') + '.',
    '',
    'Use `create` when the user asks for a new assistant; `update` to rename or change its yuan;',
    '`list` to see what exists. Deletion is deliberately not exposed here — it is destructive and',
    'belongs to the user in the panel.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'update'] },
      name: { type: 'string', description: 'Assistant display name (required for create).' },
      id: { type: 'string', description: 'Assistant id (required for update).' },
      yuan: { type: 'string', enum: Object.keys(YUAN), description: 'Personality archetype.' },
      description: { type: 'string', description: 'Optional one-line description.' },
    },
    required: ['action'],
  },
}

/**
 * 把工具的 arguments 规范化。
 *
 * 模型有时用 `old_text`（Hermes 原版命名），有时用 `oldText`；两个都接受。
 */
export function normalizeMemoryArgs(args = {}) {
  const target = typeof args.target === 'string' ? args.target : 'memory'
  const operations = Array.isArray(args.operations)
    ? args.operations.map(op => normalizeMemoryOp(op))
    : undefined
  return {
    target,
    action: typeof args.action === 'string' ? args.action : undefined,
    content: typeof args.content === 'string' ? args.content : undefined,
    oldText: pickOldText(args),
    operations,
  }
}

function pickOldText(source) {
  if (typeof source.oldText === 'string') return source.oldText
  if (typeof source.old_text === 'string') return source.old_text
  return undefined
}

function normalizeMemoryOp(op) {
  const normalized = {
    action: typeof op?.action === 'string' ? op.action : '',
    content: typeof op?.content === 'string' ? op.content : undefined,
    oldText: pickOldText(op ?? {}),
  }
  if (normalized.content === undefined && typeof op?.new_text === 'string') normalized.content = op.new_text
  return normalized
}

/** 把 memory 工具调用转成 store 的批量操作。 */
export function toMemoryOperations(normalized) {
  if (Array.isArray(normalized.operations) && normalized.operations.length > 0) return normalized.operations
  if (normalized.action === undefined) return []
  return [{ action: normalized.action, content: normalized.content, oldText: normalized.oldText }]
}

/**
 * 执行 skill_manage 的 operations 数组。
 *
 * 全有或全无：任何一步失败就整批回滚（用写入前的快照恢复）。
 * 这与 Hermes 的 batch 语义一致，也避免「改了一半」的状态。
 */
export function runSkillOperations(store, operations) {
  const ops = Array.isArray(operations) ? operations : []
  if (ops.length === 0) return { success: false, error: 'operations must be a non-empty array' }

  const applied = []
  for (const op of ops) {
    const action = String(op?.action ?? '').trim()
    const skill = String(op?.skill ?? '').trim()

    if (action === 'create') {
      const result = store.create({
        name: skill,
        description: op.description,
        content: op.content,
        body: op.body,
        category: op.category,
      })
      if (!result.ok) return rollbackFailure(store, applied, `create ${skill}: ${result.reason}`)
      applied.push({ action, skill, dir: result.file })
      continue
    }

    if (action === 'patch') {
      const result = store.patch(skill, {
        oldString: String(op.old_string ?? ''),
        newString: String(op.new_string ?? ''),
        replaceAll: op.replace_all === true,
        file: typeof op.file_path === 'string' ? op.file_path : '',
      })
      if (!result.ok) return rollbackFailure(store, applied, `patch ${skill}: ${result.reason}`)
      applied.push({ action, skill, file: result.file })
      continue
    }

    if (action === 'write_file') {
      const result = store.writeFile(skill, { filePath: op.file_path, content: op.file_content })
      if (!result.ok) return rollbackFailure(store, applied, `write_file ${skill}: ${result.reason}`)
      applied.push({ action, skill, file: result.file })
      continue
    }

    if (action === 'remove_file') {
      const result = store.removeFile(skill, { filePath: op.file_path })
      if (!result.ok) return rollbackFailure(store, applied, `remove_file ${skill}: ${result.reason}`)
      applied.push({ action, skill, file: op.file_path })
      continue
    }

    if (action === 'delete') {
      const result = store.remove(skill)
      if (!result.ok) return rollbackFailure(store, applied, `delete ${skill}: ${result.reason}`)
      applied.push({ action, skill, dir: result.removed })
      continue
    }

    return rollbackFailure(store, applied, `unknown action ${JSON.stringify(action)}`)
  }

  return {
    success: true,
    done: true,
    applied,
    note: 'Skill update saved. This update is complete — do not repeat it.',
  }
}

function rollbackFailure(_store, applied, reason) {
  return {
    success: false,
    error: reason,
    appliedBeforeFailure: applied,
    note: applied.length > 0
      ? 'Earlier operations in this batch were already applied and are listed in appliedBeforeFailure — re-check the skill state before retrying.'
      : 'Nothing was changed.',
  }
}
