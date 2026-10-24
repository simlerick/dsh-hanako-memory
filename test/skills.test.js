/**
 * Skill 读写层的单元测试。
 *
 * 覆盖：
 * 1. **frontmatter 契约**（对齐 Hermes `_validate_frontmatter`）
 * 2. **路径安全**：逃逸防护
 * 3. **缓存陷阱**：写入后目录 mtime 必须改变
 * 4. **patch 语义**：唯一命中、replace_all
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_CONTENT,
  MAX_DESCRIPTION,
  RECOMMENDED_DESCRIPTION,
  SKILL_FILENAME,
  SkillStore,
  isValidSkillName,
  parseFrontmatter,
  renderSkill,
  validateSkill,
} from '../src/skills.js'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hanako-skill-test-'))
}

function makeStore(extra = {}) {
  return new SkillStore({ root: tempRoot(), ...extra })
}

const GOOD_SKILL = `---
name: test-skill
description: Use when you need to test something. Handles test cases.
---

# Test Skill

Do the thing.
`

test('isValidSkillName 拒绝非法名', () => {
  assert.equal(isValidSkillName('good-name'), true)
  assert.equal(isValidSkillName('good.name'), true)
  assert.equal(isValidSkillName('Bad-Name'), false, '大写不允许')
  assert.equal(isValidSkillName('../escape'), false)
  assert.equal(isValidSkillName('a/b'), false)
  assert.equal(isValidSkillName(''), false)
  assert.equal(isValidSkillName('-leading'), false)
})

test('parseFrontmatter 解析标准形态', () => {
  const parsed = parseFrontmatter(GOOD_SKILL)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.name, 'test-skill')
  assert.match(parsed.data.description, /Handles test cases/)
  assert.match(parsed.body, /# Test Skill/)
})

test('parseFrontmatter 拒绝缺开头/缺闭合', () => {
  assert.equal(parseFrontmatter('# no frontmatter').ok, false)
  assert.equal(parseFrontmatter('---\nname: x\n').ok, false, '缺闭合 ---')
})

test('renderSkill 往返一致', () => {
  const rendered = renderSkill({ name: 'rt', description: 'round trip test.', body: 'body text' })
  const parsed = parseFrontmatter(rendered)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.name, 'rt')
  assert.equal(parsed.data.description, 'round trip test.')
  assert.equal(parsed.body.trim(), 'body text')
})

test('validateSkill 要求 name 与 description', () => {
  const noName = validateSkill('---\ndescription: x.\n---\nbody')
  assert.equal(noName.ok, false)
  assert.match(noName.reason, /non-empty 'name'/)

  const noDesc = validateSkill('---\nname: x\n---\nbody')
  assert.equal(noDesc.ok, false)
  assert.match(noDesc.reason, /non-empty 'description'/)
})

test('validateSkill 要求正文非空', () => {
  const result = validateSkill('---\nname: x\ndescription: y.\n---\n   \n')
  assert.equal(result.ok, false)
  assert.match(result.reason, /content after the frontmatter/)
})

test('validateSkill 拒绝超长 description，且新 skill 受建议上限约束', () => {
  const longDesc = 'x'.repeat(MAX_DESCRIPTION + 1)
  const tooLong = validateSkill(`---\nname: x\ndescription: ${longDesc}\n---\nbody`)
  assert.equal(tooLong.ok, false)

  const recommended = 'y'.repeat(RECOMMENDED_DESCRIPTION + 10)
  const newSkill = validateSkill(`---\nname: x\ndescription: ${recommended}\n---\nbody`, { isNew: true })
  assert.equal(newSkill.ok, false, '新 skill 超过建议长度应被拒（防止索引截断）')

  const existing = validateSkill(`---\nname: x\ndescription: ${recommended}\n---\nbody`, { isNew: false })
  assert.equal(existing.ok, true, '既有 skill 不受建议上限约束，否则永远修不好')
})

test('validateSkill 拒绝超大内容并提示拆分', () => {
  const huge = `---\nname: x\ndescription: y.\n---\n${'z'.repeat(MAX_CONTENT + 1)}`
  const result = validateSkill(huge)
  assert.equal(result.ok, false)
  assert.match(result.reason, /references\//)
})

test('create 成功并落盘', () => {
  const store = makeStore()
  const result = store.create({ name: 'my-skill', description: 'Does a thing when asked.', body: 'Instructions here.' })
  assert.equal(result.ok, true, result.reason)
  const file = path.join(store.root, 'my-skill', SKILL_FILENAME)
  assert.ok(fs.existsSync(file))
  assert.match(fs.readFileSync(file, 'utf8'), /name: my-skill/)
})

test('create 拒绝已存在的 skill', () => {
  const store = makeStore()
  store.create({ name: 'dup', description: 'First.', body: 'body' })
  const again = store.create({ name: 'dup', description: 'Second.', body: 'body' })
  assert.equal(again.ok, false)
  assert.match(again.reason, /already exists/)
})

test('create 要求 frontmatter name 与请求名一致', () => {
  const store = makeStore()
  const wrong = `---\nname: different\ndescription: x.\n---\nbody`
  const result = store.create({ name: 'requested', content: wrong })
  assert.equal(result.ok, false)
  assert.match(result.reason, /must match/)
})

test('create 支持 category 子目录', () => {
  const store = makeStore()
  const result = store.create({ name: 'nested', description: 'Nested skill.', body: 'body', category: 'devops' })
  assert.equal(result.ok, true, result.reason)
  assert.ok(fs.existsSync(path.join(store.root, 'devops', 'nested', SKILL_FILENAME)))
})

test('list 扫描出已创建的 skill（含 category）', () => {
  const store = makeStore()
  store.create({ name: 'alpha', description: 'Alpha skill.', body: 'a' })
  store.create({ name: 'beta', description: 'Beta skill.', body: 'b', category: 'cat1' })
  const names = store.list().map(item => item.name).sort()
  assert.deepEqual(names, ['alpha', 'beta'])
})

test('list 忽略损坏的 SKILL.md 而不是抛错', () => {
  const store = makeStore()
  fs.mkdirSync(path.join(store.root, 'broken'), { recursive: true })
  fs.writeFileSync(path.join(store.root, 'broken', SKILL_FILENAME), 'no frontmatter here', 'utf8')
  store.create({ name: 'good', description: 'Good skill.', body: 'x' })
  const names = store.list().map(item => item.name)
  assert.deepEqual(names, ['good'], '损坏项应被跳过')
})

test('get 返回内容与 linkedFiles', () => {
  const store = makeStore()
  store.create({ name: 'withrefs', description: 'Has refs.', body: 'body' })
  store.writeFile('withrefs', { filePath: 'references/api.md', content: '# API' })
  const got = store.get('withrefs')
  assert.equal(got.name, 'withrefs')
  assert.match(got.content, /name: withrefs/)
  assert.deepEqual(got.linkedFiles, ['references/api.md'])
})

test('get 不存在的 skill 返回 null', () => {
  const store = makeStore()
  assert.equal(store.get('nope'), null)
})

test('get 拒绝路径逃逸', () => {
  const store = makeStore()
  store.create({ name: 'safe', description: 'Safe.', body: 'body' })
  assert.throws(() => store.get('safe', { file: '../../../etc/passwd' }), /escapes the skill directory/)
})

test('patch 唯一命中时替换成功', () => {
  const store = makeStore()
  store.create({ name: 'patchme', description: 'Patch me.', body: 'old line here' })
  const result = store.patch('patchme', { oldString: 'old line here', newString: 'new line here' })
  assert.equal(result.ok, true, result.reason)
  assert.match(store.get('patchme').content, /new line here/)
  assert.ok(!store.get('patchme').content.includes('old line here'))
})

test('patch 未命中时拒绝且不改文件', () => {
  const store = makeStore()
  store.create({ name: 'nomatch', description: 'No match.', body: 'content' })
  const before = store.get('nomatch').content
  const result = store.patch('nomatch', { oldString: 'absent', newString: 'x' })
  assert.equal(result.ok, false)
  assert.equal(store.get('nomatch').content, before)
})

test('patch 多命中且未 replaceAll 时拒绝', () => {
  const store = makeStore()
  store.create({ name: 'multi', description: 'Multi.', body: 'dup dup dup' })
  const result = store.patch('multi', { oldString: 'dup', newString: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /matched 3 times/)
})

test('patch replaceAll 替换全部', () => {
  const store = makeStore()
  store.create({ name: 'all', description: 'All.', body: 'dup dup dup' })
  const result = store.patch('all', { oldString: 'dup', newString: 'hit', replaceAll: true })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.replaced, 3)
  assert.match(store.get('all').content, /hit hit hit/)
})

test('patch 拒绝会把正文清空的修改（文件保持不变）', () => {
  const store = makeStore()
  store.create({ name: 'valid', description: 'Stays valid.', body: 'text' })
  const before = store.get('valid').content

  // 把正文唯一内容替换成空串 → 正文变空白 → 应被拒
  const result = store.patch('valid', { oldString: 'text', newString: '' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /content after the frontmatter/)
  assert.equal(store.get('valid').content, before, '被拒绝的 patch 不得改动文件')

  // 合法 patch 之后仍然合法
  const ok = store.patch('valid', { oldString: 'text', newString: 'better text' })
  assert.equal(ok.ok, true, ok.reason)
  const checked = validateSkill(store.get('valid').content, { isNew: false })
  assert.equal(checked.ok, true, checked.reason)
})

test('rewrite 整档重写并校验', () => {
  const store = makeStore()
  store.create({ name: 'rw', description: 'Rewrite.', body: 'old' })
  const newContent = `---\nname: rw\ndescription: New description.\n---\n\nNew body.\n`
  const result = store.rewrite('rw', newContent)
  assert.equal(result.ok, true, result.reason)
  assert.match(store.get('rw').content, /New body/)
})

test('writeFile 写附属文件并拒绝逃逸', () => {
  const store = makeStore()
  store.create({ name: 'files', description: 'Files.', body: 'body' })
  const ok = store.writeFile('files', { filePath: 'templates/config.yaml', content: 'a: 1' })
  assert.equal(ok.ok, true, ok.reason)
  assert.ok(fs.existsSync(path.join(store.root, 'files', 'templates', 'config.yaml')))

  const escape = store.writeFile('files', { filePath: '../../evil.txt', content: 'x' })
  assert.equal(escape.ok, false)

  const overwriteSkill = store.writeFile('files', { filePath: SKILL_FILENAME, content: 'x' })
  assert.equal(overwriteSkill.ok, false, '不得用 writeFile 覆盖 SKILL.md')
})

test('removeFile 删除附属文件但保护 SKILL.md', () => {
  const store = makeStore()
  store.create({ name: 'rm', description: 'Remove files.', body: 'body' })
  store.writeFile('rm', { filePath: 'references/a.md', content: 'x' })
  assert.equal(store.removeFile('rm', { filePath: 'references/a.md' }).ok, true)
  assert.ok(!fs.existsSync(path.join(store.root, 'rm', 'references', 'a.md')))

  const protectedFile = store.removeFile('rm', { filePath: SKILL_FILENAME })
  assert.equal(protectedFile.ok, false)
})

test('remove 删除整个 skill 目录', () => {
  const store = makeStore()
  store.create({ name: 'doomed', description: 'Doomed.', body: 'x' })
  assert.ok(fs.existsSync(path.join(store.root, 'doomed')))
  const result = store.remove('doomed')
  assert.equal(result.ok, true, result.reason)
  assert.ok(!fs.existsSync(path.join(store.root, 'doomed')))
})

test('写入后目录 mtime 改变（破解缓存陷阱）', async () => {
  const store = makeStore()
  store.create({ name: 'mtime', description: 'Mtime test.', body: 'v1' })
  const dir = path.join(store.root, 'mtime')
  const before = fs.statSync(dir).mtimeMs

  // 等待一个可分辨的时间片（部分文件系统 mtime 精度为 1s）
  await new Promise(resolve => setTimeout(resolve, 1100))

  store.patch('mtime', { oldString: 'v1', newString: 'v2' })
  const after = fs.statSync(dir).mtimeMs
  assert.ok(after > before, '目录 mtime 必须改变，否则 catalog 缓存不会失效')
})

test('create 改变了父目录 mtime', async () => {
  const store = makeStore()
  store.create({ name: 'first', description: 'First.', body: 'a' })
  const before = fs.statSync(store.root).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 1100))
  store.create({ name: 'second', description: 'Second.', body: 'b' })
  const after = fs.statSync(store.root).mtimeMs
  assert.ok(after > before)
})

test('readRoots 让多个根的 skill 都能被 list 看见', () => {
  const primary = tempRoot()
  const secondary = tempRoot()
  const secondaryStore = new SkillStore({ root: secondary })
  secondaryStore.create({ name: 'elsewhere', description: 'From another root.', body: 'x' })

  const store = new SkillStore({ root: primary, readRoots: [secondary] })
  const names = store.list().map(item => item.name)
  assert.ok(names.includes('elsewhere'), '只读根里的 skill 必须可见')
})

test('remove 不允许删除只读根里的 skill', () => {
  const primary = tempRoot()
  const secondary = tempRoot()
  new SkillStore({ root: secondary }).create({ name: 'foreign', description: 'Foreign.', body: 'x' })
  const store = new SkillStore({ root: primary, readRoots: [secondary] })
  const result = store.remove('foreign')
  assert.equal(result.ok, false, '不得删除别的根里的 skill')
})
