/**
 * 自我提升层测试：可创造人格 / Honcho 式洞察 / 技能体检。
 *
 * 这一层的三件事都必须有测试，因为它们都在**改写长期状态**：
 * - 人格：内置不可删、自定义可自由改、助手在人格被删后仍保留快照
 * - 洞察：去重强化、置信度排序、注入预算、退休可回溯
 * - 体检：重复/近重复/缺字段/超长都要能报出来
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PersonaStore, BUILTIN_PERSONAS } from '../src/personas.js'
import { InsightStore } from '../src/insights.js'
import { auditSkills } from '../src/skills-audit.js'
import { AgentRegistry } from '../src/agents.js'
import { registerRoutes } from '../src/http.js'
import { AgentMemory } from '../src/memory-store.js'
import { SkillStore } from '../src/skills.js'

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makePersonas() {
  return new PersonaStore({ file: path.join(tmpdir('hk-personas-'), 'personas.json') })
}

/* ───────────────────────── 人格 ───────────────────────── */

test('内置人格只读：不能改、不能删，可以另存为自定义', () => {
  const store = makePersonas()
  assert.equal(store.list().length, BUILTIN_PERSONAS.length, '默认只有内置四个')

  assert.throws(() => store.remove('hanako'), /内置人格不可删除/)
  assert.throws(() => store.update('hanako', { label: 'x' }), /内置人格不可修改/)

  const copy = store.duplicate('hanako', '小花·改')
  assert.equal(copy.label, '小花·改')
  assert.equal(copy.builtin, false)
  assert.deepEqual(copy.blocks, BUILTIN_PERSONAS[0].blocks, '复制要带意识块')
  assert.equal(store.list().length, BUILTIN_PERSONAS.length + 1)

  const updated = store.update(copy.id, { glyph: '🌊', prompt: '说话简短，先给结论。' })
  assert.equal(updated.glyph, '🌊')
  assert.match(store.renderPrompt(updated), /说话简短/)
  assert.equal(store.renderPrompt(store.get('kong')), '', '内置 prompt 为空 → 不注入')
})

test('自定义人格字段自由填，坏输入被兜底与截断', () => {
  const store = makePersonas()
  const created = store.create({
    label: '  程序员老王  ',
    glyph: '🛠',
    accent: '#123456',
    moodTag: 'BUILD',
    blocks: ['Plan', 'Patch', 'Verify', '', '   '],
    blurb: '话少，先看代码再下判断。',
    prompt: '永远先复现再修。'.repeat(200),
  })
  assert.equal(created.label, '程序员老王', '首尾空白去掉')
  assert.equal(created.blocks.length, 3, '空意识块被丢掉')
  assert.ok([...created.prompt].length <= 4000, 'prompt 被截断')
  assert.match(created.id, /^[a-z0-9-]+$/, 'id 是 ASCII slug')

  const withoutLabel = store.create({})
  assert.equal(withoutLabel.label, '新人格', '空名字有兜底')

  const line = store.seedLine(created)
  assert.match(line, /程序員|程序员/)
  assert.match(line, /Plan \/ Patch \/ Verify/, '种子记忆要写意识块')
})

/* ───────────────────── 助手 × 人格 ───────────────────── */

test('助手可以用自定义人格创建，人格被删后仍有快照', () => {
  const personas = makePersonas()
  const presetsRoot = path.join(tmpdir('hk-presets-'), '.agent-presets')
  fs.mkdirSync(presetsRoot, { recursive: true })
  const agents = new AgentRegistry({ presetsRoot, personas })

  const custom = personas.create({ label: '老王', glyph: '🛠', blocks: ['Plan'], blurb: '话少' })
  const created = agents.create({ name: '老王助手', yuan: custom.id })

  assert.equal(created.yuan, custom.id)
  assert.equal(created.persona.label, '老王')
  assert.equal(created.persona.glyph, '🛠')

  const seeded = fs.readFileSync(path.join(presetsRoot, created.id, 'memory', 'MEMORY.md'), 'utf8')
  assert.match(seeded, /老王/, '种子记忆用自己的名字')

  // 删掉人格后：助手仍然能解析（回落到默认），preset.yml 里保留了快照字段
  personas.remove(custom.id)
  const after = agents.get(created.id)
  assert.ok(after !== null)
  const meta = fs.readFileSync(path.join(presetsRoot, created.id, 'preset.yml'), 'utf8')
  assert.match(meta, /personaLabel: "?老王"?/, 'preset.yml 要留人格快照')

  assert.throws(() => agents.create({ name: '幽灵', yuan: 'not-exist' }), /未知的人格/)
})

/* ───────────────────────── 洞察 ───────────────────────── */

test('洞察：去重强化、置信度排序、注入预算、退休可回溯', () => {
  const dir = path.join(tmpdir('hk-insights-'), 'memory')
  const store = new InsightStore({ dir })

  const first = store.add({ text: '他讨厌来回确认。', confidence: 40, source: 'session 1' })
  assert.equal(store.list().length, 1)

  const again = store.add({ text: '他讨厌来回确认。', confidence: 60 })
  assert.equal(again.id, first.id, '同文本视为同一条')
  assert.ok(again.confidence > 40, '重复出现会提升置信度')
  assert.equal(store.list().length, 1, '不重复插入')

  store.add({ text: '他习惯先看数据再拍板。', confidence: 90, kind: 'user' })
  const rendered = store.render()
  assert.match(rendered, /洞察/)
  assert.match(rendered, /置信 90/)

  store.update(again.id, { retired: true })
  assert.equal(store.active().some(item => item.id === again.id), false, '退休后不再注入')
  assert.equal(store.list().some(item => item.id === again.id && item.retired), true, '退休项仍可回看')
})

test('洞察有条数与注入预算上限', () => {
  const dir = path.join(tmpdir('hk-insights-cap-'), 'memory')
  const store = new InsightStore({ dir })
  for (let i = 0; i < 46; i++) {
    store.add({ text: '观察 ' + i + '：' + 'x'.repeat(30), confidence: 30 + i })
  }
  const list = store.list()
  assert.ok(list.length <= 40, `上限 40，实际 ${list.length}`)
  assert.ok(list.every(item => item.text !== ''), '留下的都是完整记录')
  assert.ok(list.filter(item => !item.retired).length > 0, '超额淘汰后仍要有可用洞察')

  const active = store.active(120)
  const used = active.reduce((sum, item) => sum + [...item.text].length + 1, 0)
  assert.ok(used <= 120, `注入预算要守住，实际 ${used}`)
})

/* ─────────────────────── 技能体检 ─────────────────────── */

test('技能体检能报出重复名 / 近重复 / 缺字段 / 超长', () => {
  const skills = [
    { name: 'dsh-plugin-dev', description: '开发 DSH 插件：client bundle 契约与槽位', whenToUse: '要加面板时', chars: 900 },
    { name: 'DSH-Plugin-Dev', description: '开发 DSH 插件：client bundle 契约与槽位注册', whenToUse: '要加面板时', chars: 900 },
    { name: 'solo', description: '', chars: 12000 },
  ]
  const audit = auditSkills(skills)
  const kinds = new Set(audit.findings.map(item => item.kind))
  assert.ok(kinds.has('duplicate-name'), '名字归一化重复')
  assert.ok(kinds.has('near-duplicate'), '描述近重复')
  assert.ok(kinds.has('missing-description'), '缺 description')
  assert.ok(kinds.has('oversize'), '超长')
  assert.ok(audit.summary.error >= 1)
  assert.ok(audit.summary.warning >= 1)

  const clean = auditSkills([{ name: 'only', description: '唯一技能', whenToUse: '总是', chars: 100 }])
  assert.equal(clean.findings.length, 0, '干净库不该报问题')
})

/* ───────────────────── 新路由（面板用） ───────────────────── */

test('人格 / 洞察 / 体检 / 滚动层写入路由都能用', async () => {
  const dshHome = tmpdir('hk-routes-persona-')
  const presetsRoot = path.join(dshHome, '.agent-presets')
  fs.mkdirSync(presetsRoot, { recursive: true })
  const personas = new PersonaStore({ file: path.join(dshHome, 'hanako-memory', 'personas.json') })
  const agents = new AgentRegistry({ presetsRoot, personas })
  const skills = new SkillStore({ root: path.join(dshHome, 'skills') })
  const memoryFor = id => new AgentMemory({ dir: path.join(presetsRoot, id, 'memory') })
  const insightsFor = id => new InsightStore({ dir: path.join(presetsRoot, id, 'memory') })
  const { auditSkills: audit } = await import('../src/skills-audit.js')

  const routes = []
  registerRoutes({ webServer: { register: route => routes.push(route) }, get: () => undefined }, {
    agents, memoryFor, skills, settings: { memoryCharLimit: 2200, userCharLimit: 1375 },
    dshHome, presetsRoot, personas, insightsFor, auditSkills: audit,
  })

  const call = async (p, { method = 'GET', url = p, body } = {}) => {
    const route = routes.find(item => item.kind === 'prefix' && url.startsWith(item.path))
      ?? routes.find(item => item.path === p)
    assert.ok(route, '找不到路由 ' + p)
    let payload = ''
    async function* iterator() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) }
    await route.handler({ method, url, headers: {}, [Symbol.asyncIterator]: iterator }, { writeHead() {}, end(chunk) { payload += chunk ?? '' } })
    return JSON.parse(payload)
  }

  // 人格 CRUD
  const createdPersona = await call('/hanako-memory/personas', { method: 'POST', body: { label: '测试人格', glyph: '🧪' } })
  assert.equal(createdPersona.ok, true)
  const id = createdPersona.persona.id
  const listed = await call('/hanako-memory/personas')
  assert.ok(listed.personas.some(item => item.id === id))
  const updated = await call('/hanako-memory/personas', { method: 'PUT', url: '/hanako-memory/personas/' + id, body: { blurb: '改过' } })
  assert.equal(updated.persona.blurb, '改过')

  // 用这个人格建助手，再写洞察 + 滚动层
  const assistant = agents.create({ name: '路由测试', yuan: id })
  const insight = await call('/hanako-memory/insights', { method: 'POST', url: '/hanako-memory/insights/' + assistant.id, body: { text: '测试洞察', confidence: 70 } })
  assert.equal(insight.ok, true)
  const insightList = await call('/hanako-memory/insights', { url: '/hanako-memory/insights/' + assistant.id })
  assert.equal(insightList.insights.length, 1)

  const rolled = await call('/hanako-memory/memory', { method: 'POST', url: '/hanako-memory/memory/' + assistant.id + '/rolling', body: { target: 'longterm', text: '长期结论一条' } })
  assert.equal(rolled.ok, true)
  assert.ok(rolled.chars > 0)

  const auditResult = await call('/hanako-memory/skills/audit')
  assert.equal(auditResult.ok, true)
  assert.ok(auditResult.summary !== undefined)

  // 清理
  const removed = await call('/hanako-memory/personas', { method: 'DELETE', url: '/hanako-memory/personas/' + id })
  assert.equal(removed.ok, true)
})
