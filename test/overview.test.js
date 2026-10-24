/**
 * 面板数据接口测试（总览 / 活动 / 记忆分层 / 技能元数据）。
 *
 * 这轮面板新增的每个数字都必须有来源：以前「分层摘要」「最后更新时间」
 * 「最近写入」根本没有接口，面板只能靠猜 —— 所以把它们钉成契约测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerRoutes } from '../src/http.js'
import { AgentRegistry } from '../src/agents.js'
import { AgentMemory } from '../src/memory-store.js'
import { SkillStore } from '../src/skills.js'

/** 组一个真实文件系统上的最小环境（不碰 $HOME）。 */
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-overview-'))
  const presetsRoot = path.join(home, '.agent-presets')
  fs.mkdirSync(presetsRoot, { recursive: true })
  const skillRoot = path.join(home, 'skills')
  fs.mkdirSync(skillRoot, { recursive: true })

  const agents = new AgentRegistry({ presetsRoot })
  const skills = new SkillStore({ root: skillRoot })
  const memoryFor = agentId => new AgentMemory({
    dir: path.join(presetsRoot, agentId, 'memory'),
    limits: { memory: 2200, user: 1375 },
  })

  const routes = []
  const ctx = { webServer: { register: route => { routes.push(route) } }, get: () => undefined }
  registerRoutes(ctx, {
    agents,
    memoryFor,
    skills,
    settings: { memoryCharLimit: 2200, userCharLimit: 1375 },
    dshHome: home,
    presetsRoot,
  })

  const find = p => routes.find(route => route.path === p)
  const call = async (route, { method = 'GET', url = route.path, body = undefined } = {}) => {
    let payload = ''
    async function* iterator() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    }
    const req = { method, url, headers: {}, [Symbol.asyncIterator]: iterator }
    const res = { writeHead() {}, end(chunk) { payload += chunk ?? '' } }
    await route.handler(req, res)
    return JSON.parse(payload)
  }

  return { home, presetsRoot, agents, skills, find, call }
}

test('/overview 一次给全：总量 / 每个助手 / 分层 / 路径 / 活动', async () => {
  const env = makeEnv()
  env.agents.create({ name: '小花', yuan: 'hanako', description: '测试' })
  const memory = env.agents.list()[0]

  // 写两条记忆 + 一条滚动摘要 + 一条置顶，让每个数字都有非零值
  const store = new AgentMemory({ dir: path.join(env.presetsRoot, memory.id, 'memory') })
  await store.write('memory', 'add', { content: '喜欢安静的工作环境' })
  await store.write('user', 'add', { content: '用户在台北' })
  await store.writeRolling('today', '今天做完了插件 UI')
  await store.writePinned(['永远先备份再动手'])

  const overview = await env.call(env.find('/hanako-memory/overview'))
  assert.equal(overview.ok, true)
  assert.equal(overview.totals.assistants, 1)
  assert.equal(overview.totals.pinned, 1)
  assert.ok(overview.totals.memory.used > 0, '记忆用量必须来自真实文件')
  assert.ok(overview.totals.user.used > 0)

  const row = overview.assistants[0]
  assert.equal(row.id, memory.id)
  // create() 会种一条「我的元是…」，所以是 1 条种子 + 1 条新增
  assert.equal(row.memory.entryCount, 2)
  assert.ok(row.updatedAt > 0, '必须给出最后更新时间')
  assert.equal(row.rolling.today.exists, true)
  assert.equal(row.rolling.today.chars, '今天做完了插件 UI'.length)
  assert.equal(row.rolling.week.exists, false)

  assert.ok(overview.paths.presets.endsWith('.agent-presets'))
  assert.ok(Array.isArray(overview.paths.skillRoots))
  assert.ok(overview.paths.memoryTemplate.includes('<助手id>'))
  assert.ok(Array.isArray(overview.activity))
})

test('/memory/<id> 带分层与更新时间', async () => {
  const env = makeEnv()
  const created = env.agents.create({ name: '明', yuan: 'ming', description: '' })
  const store = new AgentMemory({ dir: path.join(env.presetsRoot, created.id, 'memory') })
  await store.write('memory', 'add', { content: '先厘清前提' })
  await store.writeRolling('longterm', '长期：做 DSH 插件')

  const payload = await env.call(env.find('/hanako-memory/memory'), {
    url: '/hanako-memory/memory/' + encodeURIComponent(created.id),
  })
  assert.equal(payload.ok, true)
  assert.ok(payload.updatedAt.memory > 0)
  assert.equal(payload.rolling.longterm.exists, true)
  assert.ok(payload.rolling.longterm.updatedAt > 0)
  assert.equal(payload.status.memory.entryCount, 2)
})

test('写入会落进活动日志，可以在 /activity 里读到', async () => {
  const env = makeEnv()
  const created = env.agents.create({ name: '黄油', yuan: 'butter', description: '' })

  const memoryRoute = env.find('/hanako-memory/memory')
  const write = await env.call(memoryRoute, {
    method: 'POST',
    url: '/hanako-memory/memory/' + encodeURIComponent(created.id),
    body: { target: 'memory', action: 'add', content: '喜欢跳脱的表达' },
  })
  assert.equal(write.ok, true)

  const activityRoute = env.find('/hanako-memory/activity')
  const log = await env.call(activityRoute)
  assert.equal(log.ok, true)
  assert.ok(log.activity.length >= 1, '写入后必须有活动记录')
  const entry = log.activity[0]
  assert.equal(entry.kind, 'memory')
  assert.equal(entry.agentId, created.id)
  assert.equal(entry.target, 'memory')
  assert.ok(entry.at > 0)
  assert.ok(String(entry.detail).includes('chars'), '详情里要有 usage 字符串')
})

test('置顶写入也会记一条活动', async () => {
  const env = makeEnv()
  const created = env.agents.create({ name: '空', yuan: 'kong', description: '' })
  const pinnedRoute = env.find('/hanako-memory/pinned')
  const result = await env.call(pinnedRoute, {
    method: 'POST',
    url: '/hanako-memory/pinned/' + encodeURIComponent(created.id),
    body: { list: ['永远先备份'] },
  })
  assert.equal(result.ok, true)
  const log = await env.call(env.find('/hanako-memory/activity'))
  assert.equal(log.activity[0].kind, 'pinned')
  assert.equal(log.activity[0].count, 1)
})

test('/skills 带字符数、更新时间与根目录', async () => {
  const env = makeEnv()
  const dir = path.join(env.home, 'skills', 'demo-skill')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    'name: demo-skill',
    'description: 演示用技能',
    '---',
    '',
    '正文内容',
  ].join('\n'))

  const payload = await env.call(env.find('/hanako-memory/skills'))
  assert.equal(payload.ok, true)
  assert.ok(Array.isArray(payload.roots))
  const hit = payload.skills.find(item => item.name === 'demo-skill')
  assert.ok(hit, '必须发现 demo-skill')
  assert.equal(hit.description, '演示用技能')
  assert.ok(hit.chars > 0, '必须带字符数')
  assert.ok(hit.updatedAt > 0, '必须带更新时间')
})
