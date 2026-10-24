/**
 * 多智能体层的单元测试。
 *
 * 重点覆盖：
 * 1. **数据安全**：id 逃逸防护、默认/最后助手删除保护
 * 2. **DSH 兼容**：生成的目录结构符合 `dsh-agent-presets` 的发现规则
 * 3. **隔离**：每个助手有独立记忆目录
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AgentRegistry, DEFAULT_YUAN, YUAN, isValidPresetId, slugify } from '../src/agents.js'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hanako-agents-test-'))
}

function makeRegistry(extra = {}) {
  return new AgentRegistry({ presetsRoot: tempRoot(), ...extra })
}

test('isValidPresetId 拒绝危险 id', () => {
  assert.equal(isValidPresetId('hanako'), true)
  assert.equal(isValidPresetId('my-assistant_2'), true)
  assert.equal(isValidPresetId('../escape'), false)
  assert.equal(isValidPresetId('a/b'), false)
  assert.equal(isValidPresetId(''), false)
  assert.equal(isValidPresetId('-leading'), false)
  assert.equal(isValidPresetId('x'.repeat(65)), false)
})

test('slugify 生成稳定 id 并避让冲突', () => {
  assert.equal(slugify('小花'), 'assistant', '中文名降级为 assistant')
  assert.equal(slugify('My Assistant'), 'my-assistant')
  assert.equal(slugify('  hello  '), 'hello')
  assert.equal(slugify('hello', ['hello']), 'hello-2')
  assert.equal(slugify('hello', ['hello', 'hello-2']), 'hello-3')
})

test('YUAN 四个元齐全，kong 无意识块', () => {
  assert.deepEqual(Object.keys(YUAN).sort(), ['butter', 'hanako', 'kong', 'ming'])
  assert.equal(YUAN.kong.blocks.length, 0)
  assert.equal(YUAN.hanako.blocks.length, 4)
  assert.equal(YUAN.hanako.moodTag, 'MOOD')
  assert.equal(YUAN.butter.moodTag, 'PULSE')
})

test('空目录 list 返回空数组而不是抛错', () => {
  const reg = makeRegistry()
  assert.deepEqual(reg.list(), [])
  assert.deepEqual(reg.stats(), { total: 0, byYuan: {}, defaultId: '', brokenCount: 0 })
})

test('create 生成 DSH 兼容的 preset 目录结构', () => {
  const reg = makeRegistry()
  const created = reg.create({ name: 'Hana Test', yuan: 'hanako' })

  assert.equal(created.id, 'hana-test')
  assert.equal(created.name, 'Hana Test')
  assert.equal(created.yuan, 'hanako')
  assert.equal(created.broken, false)

  const dir = path.join(reg.presetsRoot, 'hana-test')
  assert.ok(fs.existsSync(path.join(dir, 'agent.cordis.yml')), '必须有组合文件（DSH 发现的依据）')
  assert.ok(fs.existsSync(path.join(dir, 'preset.yml')), '必须有元数据文件')
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'MEMORY.md')), '必须有独立记忆目录')

  const composition = fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8')
  assert.match(composition, /- insert:/)
  assert.match(composition, /dsh-hanako-memory\/soul/, '组合文件应挂本插件的 soul 运行时')
})

test('prest.yml 可被读回（YAML 往返）', () => {
  const reg = makeRegistry()
  reg.create({ name: 'Round Trip', yuan: 'ming', description: '测试往返' })
  const item = reg.list()[0]
  assert.equal(item.name, 'Round Trip')
  assert.equal(item.yuan, 'ming')
  assert.equal(item.description, '测试往返')
})

test('create 拒绝空名字与未知元', () => {
  const reg = makeRegistry()
  assert.throws(() => reg.create({ name: '' }), /不能为空/)
  assert.throws(() => reg.create({ name: 'x', yuan: 'bogus' }), /未知的人格/)
})

test('每个助手有独立记忆目录且互不干扰', () => {
  const reg = makeRegistry()
  const a = reg.create({ name: 'Alpha' })
  const b = reg.create({ name: 'Beta' })
  assert.notEqual(a.memoryDir, b.memoryDir)
  assert.ok(fs.existsSync(a.memoryDir))
  assert.ok(fs.existsSync(b.memoryDir))

  fs.writeFileSync(path.join(a.memoryDir, 'MEMORY.md'), 'alpha memory', 'utf8')
  const betaContent = fs.readFileSync(path.join(b.memoryDir, 'MEMORY.md'), 'utf8')
  assert.ok(!betaContent.includes('alpha memory'), '记忆必须隔离')
})

test('order 递增，list 按 order 排序', () => {
  const reg = makeRegistry()
  reg.create({ name: 'First' })
  reg.create({ name: 'Second' })
  reg.create({ name: 'Third' })
  const names = reg.list().map(item => item.name)
  assert.deepEqual(names, ['First', 'Second', 'Third'])
})

test('update 修改名字与元', () => {
  const reg = makeRegistry()
  reg.create({ name: 'Old Name', yuan: 'hanako' })
  const updated = reg.update('old-name', { name: 'New Name', yuan: 'butter' })
  assert.equal(updated.name, 'New Name')
  assert.equal(updated.yuan, 'butter')
  // 组合文件不被 update 破坏
  const dir = path.join(reg.presetsRoot, 'old-name')
  assert.ok(fs.existsSync(path.join(dir, 'agent.cordis.yml')))
})

test('update 拒绝空名字与未知元', () => {
  const reg = makeRegistry()
  reg.create({ name: 'Guard' })
  assert.throws(() => reg.update('guard', { name: '  ' }), /不能为空/)
  assert.throws(() => reg.update('guard', { yuan: 'nope' }), /未知的人格/)
})

test('remove 保护默认助手', () => {
  const reg = makeRegistry({ defaultPresetId: () => 'main' })
  reg.create({ name: 'Main' })
  reg.create({ name: 'Other' })
  assert.throws(() => reg.remove('main'), /默认助手不可删除/)
})

test('remove 保护最后一个助手', () => {
  const reg = makeRegistry()
  reg.create({ name: 'Only One' })
  assert.throws(() => reg.remove('only-one'), /至少要保留一个助手/)
})

test('remove 正常删除非默认助手（含记忆目录）', () => {
  const reg = makeRegistry({ defaultPresetId: () => 'keep' })
  reg.create({ name: 'Keep' })
  const tmp = reg.create({ name: 'Temp' })
  const tmpDir = path.join(reg.presetsRoot, 'temp')
  assert.ok(fs.existsSync(tmpDir))
  reg.remove(tmp.id)
  assert.ok(!fs.existsSync(tmpDir), '删除助手应连记忆目录一起删除')
  assert.equal(reg.list().length, 1)
})

test('remove 不存在的助手抛错', () => {
  const reg = makeRegistry()
  assert.throws(() => reg.remove('nope'), /preset 不存在/)
})

test('duplicate 复制助手与记忆', () => {
  const reg = makeRegistry()
  const source = reg.create({ name: 'Source', yuan: 'ming' })
  fs.writeFileSync(path.join(source.memoryDir, 'MEMORY.md'), 'copied memory', 'utf8')

  const copy = reg.duplicate(source.id, { name: 'Copy' })
  assert.equal(copy.yuan, 'ming')
  assert.equal(copy.name, 'Copy')
  const copyMemory = fs.readFileSync(path.join(copy.memoryDir, 'MEMORY.md'), 'utf8')
  assert.equal(copyMemory, 'copied memory')
})

test('broken 标记：缺组合文件的目录被标出而不是隐藏', () => {
  const reg = makeRegistry()
  const created = reg.create({ name: 'Will Break' })
  fs.rmSync(path.join(reg.presetsRoot, created.id, 'agent.cordis.yml'))
  const list = reg.list()
  const item = list.find(x => x.id === created.id)
  assert.ok(item, '损坏的助手必须仍出现在列表里')
  assert.equal(item.broken, true)
  assert.equal(reg.stats().brokenCount, 1)
})

test('非法目录名被忽略，合法但缺组合文件的标 broken', () => {
  const root = tempRoot()
  // 非法 id（含点号前缀 / 路径分隔）必须被完全忽略
  fs.mkdirSync(path.join(root, '..escape'), { recursive: true })
  fs.mkdirSync(path.join(root, '.hidden'), { recursive: true })
  // 合法 id、有 preset.yml 但缺 agent.cordis.yml —— 应出现在列表并标 broken
  fs.mkdirSync(path.join(root, 'legal-but-empty'), { recursive: true })
  fs.writeFileSync(path.join(root, 'legal-but-empty', 'preset.yml'), 'name: "Empty"\n', 'utf8')

  const reg = new AgentRegistry({ presetsRoot: root })
  const list = reg.list()
  assert.deepEqual(list.map(item => item.id), ['legal-but-empty'], '非法目录名不得进入列表')
  assert.equal(list[0].broken, true, '缺组合文件的合法目录应标 broken 而不是隐藏')
})

test('stats 汇总各元数量', () => {
  const reg = makeRegistry()
  reg.create({ name: 'A', yuan: 'hanako' })
  reg.create({ name: 'B', yuan: 'hanako' })
  reg.create({ name: 'C', yuan: 'kong' })
  const stats = reg.stats()
  assert.equal(stats.total, 3)
  assert.equal(stats.byYuan.hanako, 2)
  assert.equal(stats.byYuan.kong, 1)
})

test('get 返回 null 而不是抛错', () => {
  const reg = makeRegistry()
  assert.equal(reg.get('missing'), null)
})

test('默认元是 hanako', () => {
  const reg = makeRegistry()
  const created = reg.create({ name: 'Default Yuan' })
  assert.equal(created.yuan, DEFAULT_YUAN)
})

test('重复 create 同名不会覆盖（自动加序号）', () => {
  const reg = makeRegistry()
  const a = reg.create({ name: 'Same' })
  const b = reg.create({ name: 'Same' })
  assert.notEqual(a.id, b.id)
  assert.equal(reg.list().length, 2)
})

test('只有 memory/ 的孤立目录不算助手（不给未知 id 写记忆时误报损坏）', () => {
  const root = tempRoot()
  // 模拟「给不存在的 agent 写记忆」留下的目录
  fs.mkdirSync(path.join(root, 'ghost', 'memory'), { recursive: true })
  const reg = new AgentRegistry({ presetsRoot: root })
  assert.deepEqual(reg.list(), [], '孤立 memory 目录不应出现在助手列表')
  assert.equal(reg.stats().brokenCount, 0)
})

test('真的损坏（有 preset.yml 缺组合文件）仍然报 broken', () => {
  const root = tempRoot()
  fs.mkdirSync(path.join(root, 'half-made'), { recursive: true })
  fs.writeFileSync(path.join(root, 'half-made', 'preset.yml'), 'name: "Half"\n', 'utf8')
  const reg = new AgentRegistry({ presetsRoot: root })
  const list = reg.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].broken, true)
})
