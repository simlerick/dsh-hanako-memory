/**
 * 无浏览器渲染冒烟测试。
 *
 * 为什么需要：面板是 4 个 tab 的纯手写 `react.createElement` 树，
 * 没有 JSX 编译期检查 —— 少一个括号、多一个层级、字段名写错都只在浏览器里炸。
 * 这个文件用一个 ~80 行的迷你 React（hooks + 一次重渲染）把整棵面板树真的跑一遍，
 * 并且用假的 `fetch` 喂真实形状的数据，保证：
 *
 * 1. 每个 tab 在「有数据」的状态下都能渲染不抛错
 * 2. 关键数据展示（用量、条目数、分层、最近活动、重复标记）真的出现在输出里
 * 3. host 返回缺字段时（老版本 / 空库）不崩
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createMiniReact } from './helpers/mini-react.mjs'

/* ───────────────────── 假 fetch：喂真实形状的数据 ───────────────────── */

const AGENT_ID = 'assistant'

const OVERVIEW = {
  ok: true,
  totals: {
    assistants: 1,
    broken: 0,
    byYuan: { hanako: 1 },
    defaultId: AGENT_ID,
    memory: { used: 420, limit: 2200, pct: 19 },
    user: { used: 90, limit: 1375, pct: 7 },
    pinned: 1,
    skills: 2,
  },
  limits: { memory: 2200, user: 1375 },
  paths: {
    presets: '/home/.dsh/.agent-presets',
    memoryTemplate: '/home/.dsh/.agent-presets/<助手id>/memory',
    skillRoots: ['/home/.dsh/skills'],
    activityFile: '/home/.dsh/hanako-memory/activity.json',
  },
  activity: [
    { at: Date.now() - 60000, kind: 'memory', agentId: AGENT_ID, target: 'memory', ok: true, ops: 1, detail: '19% — 420/2,200 chars' },
    { at: Date.now() - 120000, kind: 'pinned', agentId: AGENT_ID, ok: true, count: 1 },
  ],
  assistants: [{
    id: AGENT_ID,
    name: '小花',
    yuan: 'hanako',
    description: '温柔有主见',
    isDefault: true,
    broken: false,
    memory: { used: 420, limit: 2200, pct: 19, entryCount: 3, remaining: 1780 },
    user: { used: 90, limit: 1375, pct: 7, entryCount: 1, remaining: 1285 },
    pinned: 1,
    rolling: {
      today: { chars: 120, exists: true, updatedAt: Date.now() - 3600000 },
      week: { chars: 0, exists: false, updatedAt: 0 },
      longterm: { chars: 340, exists: true, updatedAt: Date.now() - 86400000 },
    },
    residentUpdatedAt: { memory: Date.now() - 60000, user: Date.now() - 90000 },
    updatedAt: Date.now() - 60000,
  }],
}

const MEMORY = {
  ok: true,
  agentId: AGENT_ID,
  status: {
    memory: {
      used: 420,
      limit: 2200,
      pct: 19,
      entryCount: 3,
      entries: ['我的元是「小花」（hanako）', '喜欢安静的工作环境', '喜欢安静的工作环境'],
    },
    user: { used: 90, limit: 1375, pct: 7, entryCount: 1, entries: ['用户在台北'] },
    today: { chars: 120, exists: true },
    week: { chars: 0, exists: false },
    longterm: { chars: 340, exists: true },
  },
  pinned: ['永远先备份再动手'],
  rolling: {
    today: { chars: 120, exists: true, updatedAt: Date.now() - 3600000 },
    week: { chars: 0, exists: false, updatedAt: 0 },
    longterm: { chars: 340, exists: true, updatedAt: Date.now() - 86400000 },
  },
  updatedAt: { memory: Date.now() - 60000, user: Date.now() - 90000 },
}

const SKILLS = {
  ok: true,
  roots: ['/home/.dsh/skills'],
  skills: [
    { name: 'dsh-plugin-dev', description: '写 DSH 插件', whenToUse: '要加面板时', relativePath: 'dsh-plugin-dev', dir: '', root: '', chars: 1200, updatedAt: Date.now() - 7200000 },
    { name: 'office-docx', description: '处理 Word', relativePath: 'office-docx', dir: '', root: '', chars: 800, updatedAt: Date.now() - 90000000 },
  ],
}

function installFetch() {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    calls.push({ path, method: (init && init.method) || 'GET' })
    let body = { ok: true }
    if (path.includes('/client-report')) body = { ok: true }
    else if (path.includes('/overview')) body = OVERVIEW
    else if (path.includes('/memory/')) body = MEMORY
    else if (path.includes('/skills/audit')) body = {
      ok: true,
      summary: { skills: 3, findings: 2, error: 0, warning: 1, info: 1, totalChars: 9500 },
      findings: [
        { severity: 'warning', kind: 'near-duplicate', skill: 'office-docx ↔ dsh-plugin-dev', detail: '描述相似度 78%', suggestion: '合成一个' },
      ],
    }
    else if (path.includes('/skills/')) body = { ok: true, name: 'dsh-plugin-dev', content: '正文' }
    else if (path.includes('/skills')) body = SKILLS
    else if (path.includes('/pinned/')) body = { ok: true }
    else if (path.includes('/assistants')) body = { ok: true, assistants: OVERVIEW.assistants }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    }
  }
  return calls
}

/* ───────────────────── 载入 client bundle ───────────────────── */

async function loadPanel() {
  const mini = createMiniReact()
  const captured = []
  globalThis.window = {
    __ModuleLoader__: { load: spec => { captured.push(spec) } },
    confirm: () => true,
  }
  globalThis.document = undefined
  installFetch()

  await import(`../client/client.js?render=${Date.now()}-${Math.random()}`)
  assert.equal(captured.length, 1, '必须恰好注册一次')

  const mod = captured[0].factory(path => {
    if (path === 'react') return mini.React
    throw new Error(`unexpected require(${path})`)
  })
  return { mod, mini, internals: mod.__test }
}

/* ───────────────────── 测试 ───────────────────── */

test('HanakoPage 在真实数据下渲染四个 tab 且不抛错', async () => {
  const { mini, internals } = await loadPanel()
  const html = await mini.mount(mini.React.createElement(internals.HanakoPage))
  for (const label of ['总览', '助手', '记忆', '技能']) {
    assert.ok(html.includes(label), '缺 tab：' + label)
  }
  assert.ok(html.includes('小花'), '助手名必须出现')
  assert.ok(html.includes('19%'), '记忆百分比必须出现')
  assert.ok(html.includes('2,200'), '预算应带千分位')
})

test('总览 tab 展示用量 / 分层 / 最近写入 / 存储路径', async () => {
  const { mini, internals } = await loadPanel()
  const html = await mini.mount(mini.React.createElement(internals.OverviewTab, {
    overview: OVERVIEW,
    agentName: () => '小花',
    onReload: () => {},
    onOpenMemory: () => {},
  }))
  assert.ok(html.includes('记忆用量') && html.includes('画像用量'), '要有用量卡')
  assert.ok(html.includes('置顶'), '要有置顶卡')
  assert.ok(html.includes('今天 120 字'), '分层摘要要显示字数')
  assert.ok(html.includes('本周 空'), '空层要显式标空')
  assert.ok(html.includes('19% — 420/2,200 chars'), '最近写入要带 usage 详情')
  assert.ok(html.includes('活动日志'), '要有活动日志一行')
  assert.ok(html.includes('/home/.dsh/hanako-memory/activity.json'), '要显示活动日志路径')
})

test('记忆 tab 展示预算 / 分层 / 置顶 / 重复标记 / 条目字数', async () => {
  const { mini, internals } = await loadPanel()
  const html = await mini.mount(mini.React.createElement(internals.MemoryTab, {
    agentId: AGENT_ID,
    overview: OVERVIEW,
    agentName: '小花',
    onPickAgent: () => {},
    onChanged: () => {},
  }))
  assert.ok(html.includes('420 / 2200 字符'), '预算条文案')
  assert.ok(html.includes('剩余 1,780'), '要显示剩余字符')
  assert.ok(html.includes('平均 140 字/条'), '要显示平均长度')
  assert.ok(html.includes('2 / 3 层有内容'), '要显示分层填充（today+longterm 有内容）')
  assert.ok(html.includes('永远先备份再动手'), '置顶条目')
  assert.ok(html.includes('与 #'), '重复条目要标出来')
  assert.ok(html.includes('19%'), '预算百分比要出现')
})

test('助手 tab 卡片展示双库用量', async () => {
  const { mini, internals } = await loadPanel()
  const html = await mini.mount(mini.React.createElement(internals.AssistantsTab, {
    overview: OVERVIEW,
    agentId: AGENT_ID,
    onChanged: () => {},
    onOpenMemory: () => {},
  }))
  assert.ok(html.includes('小花'))
  assert.ok(html.includes('主'), '默认助手标记')
  assert.ok(html.includes('记忆 '), '双库用量里的记忆数字')
  assert.ok(html.includes('打开记忆'))
})

test('渲染结果里不能出现 [object Object]（对象当 React child 会白屏的真因）', async () => {
  const { mini, internals } = await loadPanel()
  const cases = [
    ['OverviewTab', { overview: OVERVIEW, agentName: () => '小花', onReload: () => {}, onOpenMemory: () => {} }],
    ['AssistantsTab', { overview: OVERVIEW, personas: [], agentId: AGENT_ID, onChanged: () => {}, onOpenMemory: () => {} }],
    ['MemoryTab', { agentId: AGENT_ID, overview: OVERVIEW, agentName: '小花', onPickAgent: () => {}, onChanged: () => {} }],
  ]
  for (const [label, props] of cases) {
    const html = await mini.mount(mini.React.createElement(internals[label], props))
    assert.equal(html.includes('[object Object]'), false, `${label} 把对象渲染进了 React 树`)
  }
  // 相对时间必须是字符串（primitives 的原件返回 {unit,n} 结构体，不能直接用）
  assert.equal(typeof internals.relativeTime(Date.now() - 3600e3), 'string')
  assert.equal(internals.relativeTime(0), '—')
})

test('人格 tab：内置/自定义都渲染，编辑器字段齐全', async () => {
  const { mini, internals } = await loadPanel()
  const personas = [
    { id: 'hanako', label: '小花', glyph: '🌙', accent: '#e8a0bf', moodTag: 'MOOD', blocks: ['Vibe', 'Will'], blurb: '温柔有主见', prompt: '', builtin: true },
    { id: 'p-wang', label: '程序员老王', glyph: '🛠', accent: '#7fb2d9', moodTag: 'BUILD', blocks: ['Plan', 'Verify'], blurb: '话少', prompt: '先复现再修。', builtin: false },
  ]
  const html = await mini.mount(mini.React.createElement(internals.PersonasTab, {
    personas,
    editingPersona: ['p-wang', () => {}],
    onChanged: () => {},
  }))
  assert.ok(html.includes('内置模板'), '内置人格要有标记')
  assert.ok(html.includes('自定义'), '自定义人格要有标记')
  assert.ok(html.includes('程序员老王'))
  assert.ok(html.includes('Vibe'), '意识块要显示')
  assert.ok(html.includes('有人格指令'), '有 prompt 要标出来')
  for (const label of ['名字', '主题色', '状态标签', '一句话人格', '意识块', '人格指令']) {
    assert.ok(html.includes(label), '编辑器缺字段：' + label)
  }
})

test('技能 tab 展示字符数 / 更新时间 / 路径并可搜索区', async () => {
  const { mini, internals } = await loadPanel()
  const html = await mini.mount(mini.React.createElement(internals.SkillsTab))
  assert.ok(html.includes('dsh-plugin-dev'))
  assert.ok(html.includes('写 DSH 插件'))
  assert.ok(html.includes('1,200 字'), '技能字符数')
  assert.ok(html.includes('何时用：要加面板时'), 'whenToUse')
  assert.ok(html.includes('技能根目录'), '根目录列表')
})

test('host 返回缺字段时不崩（老版本 / 空库）', async () => {
  const { mini, internals } = await loadPanel()
  const bare = { ok: true, totals: {}, assistants: [], activity: [] }
  const html = await mini.mount(mini.React.createElement(internals.OverviewTab, {
    overview: bare,
    agentName: () => '',
    onReload: () => {},
    onOpenMemory: () => {},
  }))
  assert.ok(html.includes('还没有助手'), '空态要出现')

  const empty = await mini.mount(mini.React.createElement(internals.MemoryTab, {
    agentId: AGENT_ID,
    overview: { assistants: [] },
    agentName: '',
    onPickAgent: () => {},
    onChanged: () => {},
  }))
  assert.ok(typeof empty === 'string', '空库也要能渲染')
})

test('重复检测与相对时间的行为', async () => {
  const { internals } = await loadPanel()
  const dup = internals.findDuplicates([
    '用户在台北工作，习惯早上写代码',
    '用户在台北工作，习惯早上写代码',
    '完全不同的另一句话，用来确保不会被误判成重复',
    '用户在台北工作，习惯早上写代码，晚上复习',
  ])
  assert.equal(dup[1], 0, '完全重复要指向前一条')
  assert.equal(dup[3], 0, '被包含也要指出来')
  assert.equal(internals.charCount('🌙'), 1, 'emoji 按码点算 1')
  assert.equal(internals.relativeTime(Date.now() - 5000), '刚刚')
  assert.equal(internals.relativeTime(0), '—')
  assert.equal(internals.num(2200), '2,200')
})
