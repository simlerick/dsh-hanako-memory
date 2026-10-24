/**
 * 工具层的单元测试。
 *
 * 重点：
 * 1. schema 形状（anyOf 分支、required）
 * 2. arguments 规范化（old_text / oldText、new_text 别名）
 * 3. skill operations 的失败处理
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  AGENT_MANAGE_TOOL,
  MEMORY_TOOL,
  SKILL_LIST_TOOL,
  SKILL_MANAGE_TOOL,
  SKILL_VIEW_TOOL,
  normalizeMemoryArgs,
  runSkillOperations,
  toMemoryOperations,
} from '../src/tools.js'
import { SkillStore } from '../src/skills.js'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hanako-tools-test-'))
}

test('MEMORY_TOOL 的 description 含四段关键指引', () => {
  const desc = MEMORY_TOOL.description
  assert.match(desc, /WHEN:/)
  assert.match(desc, /IF FULL:/)
  assert.match(desc, /SKIP:/)
  assert.match(desc, /memory.*user|user.*memory/, '必须说明两个 target 的区别')
  assert.match(desc, /skill_manage/, '必须指引「任务学到的东西去 skill」')
})

test('MEMORY_TOOL 的 target 只允许 memory/user', () => {
  assert.deepEqual(MEMORY_TOOL.parameters.properties.target.enum, ['memory', 'user'])
})

test('MEMORY_TOOL 的 operations 项 required 只有 action', () => {
  const item = MEMORY_TOOL.parameters.properties.operations.items
  assert.deepEqual(item.required, ['action'])
  assert.equal(item.additionalProperties, false)
})

test('SKILL_MANAGE_TOOL 用 anyOf 分支而非扁平对象', () => {
  const item = SKILL_MANAGE_TOOL.parameters.properties.operations.items
  assert.ok(Array.isArray(item.anyOf), '必须是 anyOf 分支')
  assert.ok(item.anyOf.length >= 5)

  const actions = item.anyOf.map(branch => branch.properties.action.const)
  assert.deepEqual(actions.sort(), ['create', 'delete', 'patch', 'remove_file', 'write_file'])

  // create 与 write_file 的字段不能混在一起
  const create = item.anyOf.find(branch => branch.properties.action.const === 'create')
  assert.ok(create.properties.content !== undefined)
  assert.equal(create.properties.file_content, undefined, 'create 不该有 write_file 的字段')

  const writeFile = item.anyOf.find(branch => branch.properties.action.const === 'write_file')
  assert.ok(writeFile.properties.file_content !== undefined)
  assert.equal(writeFile.properties.content, undefined)
})

test('SKILL_MANAGE_TOOL 的每个分支都有 additionalProperties: false', () => {
  for (const branch of SKILL_MANAGE_TOOL.parameters.properties.operations.items.anyOf) {
    assert.equal(branch.additionalProperties, false, `${branch.properties.action.const} 分支必须禁止额外字段`)
  }
})

test('AGENT_MANAGE_TOOL 的 yuan enum 与四个元一致', () => {
  assert.deepEqual(
    AGENT_MANAGE_TOOL.parameters.properties.yuan.enum.sort(),
    ['butter', 'hanako', 'kong', 'ming'],
  )
})

test('所有工具都有 name / description / parameters', () => {
  for (const tool of [MEMORY_TOOL, SKILL_MANAGE_TOOL, SKILL_VIEW_TOOL, SKILL_LIST_TOOL, AGENT_MANAGE_TOOL]) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.name.length > 0)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 40, `${tool.name} 的 description 太短，模型会用错`)
    assert.equal(typeof tool.parameters, 'object')
  }
})

test('normalizeMemoryArgs 同时接受 old_text 与 oldText', () => {
  assert.equal(normalizeMemoryArgs({ target: 'memory', action: 'remove', old_text: 'a' }).oldText, 'a')
  assert.equal(normalizeMemoryArgs({ target: 'memory', action: 'remove', oldText: 'b' }).oldText, 'b')
})

test('normalizeMemoryArgs 默认 target 为 memory', () => {
  assert.equal(normalizeMemoryArgs({}).target, 'memory')
})

test('normalizeMemoryArgs 处理 new_text 别名', () => {
  const normalized = normalizeMemoryArgs({
    target: 'memory',
    operations: [{ action: 'add', new_text: 'via alias' }],
  })
  assert.equal(normalized.operations[0].content, 'via alias')
})

test('toMemoryOperations 优先使用 operations 数组', () => {
  const ops = toMemoryOperations({
    target: 'memory',
    action: 'add',
    content: 'single',
    operations: [{ action: 'add', content: 'batch' }],
  })
  assert.equal(ops.length, 1)
  assert.equal(ops[0].content, 'batch')
})

test('toMemoryOperations 单操作回退', () => {
  const ops = toMemoryOperations({ target: 'memory', action: 'add', content: 'x', oldText: undefined })
  assert.deepEqual(ops, [{ action: 'add', content: 'x', oldText: undefined }])
})

test('toMemoryOperations 无 action 时返回空数组', () => {
  assert.deepEqual(toMemoryOperations({ target: 'memory' }), [])
})

test('runSkillOperations 执行多个操作', () => {
  const store = new SkillStore({ root: tempRoot() })
  const result = runSkillOperations(store, [
    { action: 'create', skill: 'multi', description: 'Multi op skill.', body: 'body text' },
    { action: 'write_file', skill: 'multi', file_path: 'references/a.md', file_content: 'ref' },
  ])
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(result.applied.length, 2)
  assert.equal(result.done, true)
  assert.ok(fs.existsSync(path.join(store.root, 'multi', 'references', 'a.md')))
})

test('runSkillOperations 在一项失败时报告已应用的部分', () => {
  const store = new SkillStore({ root: tempRoot() })
  const result = runSkillOperations(store, [
    { action: 'create', skill: 'good', description: 'Good skill.', body: 'body' },
    { action: 'patch', skill: 'good', old_string: 'absent', new_string: 'x' },
  ])
  assert.equal(result.success, false)
  assert.match(result.error, /patch good/)
  assert.equal(result.appliedBeforeFailure.length, 1, '必须报告已应用的部分，避免模型误判状态')
  assert.ok(result.note.includes('already applied'))
})

test('runSkillOperations 拒绝空 operations', () => {
  const store = new SkillStore({ root: tempRoot() })
  assert.equal(runSkillOperations(store, []).success, false)
  assert.equal(runSkillOperations(store, undefined).success, false)
})

test('runSkillOperations 拒绝未知 action', () => {
  const store = new SkillStore({ root: tempRoot() })
  const result = runSkillOperations(store, [{ action: 'destroy', skill: 'x' }])
  assert.equal(result.success, false)
  assert.match(result.error, /unknown action/)
})

test('runSkillOperations delete 能删除 skill', () => {
  const store = new SkillStore({ root: tempRoot() })
  store.create({ name: 'tobedeleted', description: 'Delete me.', body: 'x' })
  const result = runSkillOperations(store, [{ action: 'delete', skill: 'tobedeleted' }])
  assert.equal(result.success, true, JSON.stringify(result))
  assert.ok(!fs.existsSync(path.join(store.root, 'tobedeleted')))
})

test('runSkillOperations remove_file 删除附属文件', () => {
  const store = new SkillStore({ root: tempRoot() })
  store.create({ name: 'withfile', description: 'With file.', body: 'x' })
  store.writeFile('withfile', { filePath: 'references/r.md', content: 'r' })
  const result = runSkillOperations(store, [{ action: 'remove_file', skill: 'withfile', file_path: 'references/r.md' }])
  assert.equal(result.success, true, JSON.stringify(result))
  assert.ok(!fs.existsSync(path.join(store.root, 'withfile', 'references', 'r.md')))
})
