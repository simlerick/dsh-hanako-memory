/**
 * 集成测试：用真实模块 + mock ctx 跑 apply()。
 *
 * 目的不是测 Cordis 本身，而是验证：
 * 1. apply() 不抛错
 * 2. 五个工具真的注册了（且 schema 正确）
 * 3. memory 工具能真的写盘
 * 4. systemPrompt section 真的注册了
 * 5. webServer 路由真的注册了
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hanako-int-'))
process.env.DSH_HOME = home

const plugin = await import('../index.js')

/** 最小可用 ctx：记录所有注册行为。 */
function makeCtx() {
  const registeredTools = new Map()
  const sections = []
  const routes = []
  const events = []

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (name, handler) => { events.push({ name, handler }); return () => {} },
    inject: (deps, cb) => {
      // 模拟 Cordis：服务名在 ctx 上可访问时才回调
      cb(ctx)
      return () => {}
    },
    get: (name) => {
      if (name === 'agentPresets') return { settings: { get: () => ({ default: 'default' }) } }
      return undefined
    },
    emit: () => {},
    tools: {
      register: (definition) => { registeredTools.set(definition.name, definition); return () => {} },
    },
    systemPrompt: {
      section: (definition) => { sections.push(definition); return () => {} },
      variable: () => () => {},
    },
    webServer: {
      register: (route) => { routes.push(route); return () => {} },
    },
  }
  return { ctx, registeredTools, sections, routes, events }
}

test('apply 不抛错并注册全部预期组件', () => {
  const { ctx, registeredTools, sections, routes } = makeCtx()
  plugin.apply(ctx, {})

  assert.equal(registeredTools.size, 8, `应注册 8 个工具，实际 ${[...registeredTools.keys()].join(',')}`)
  assert.deepEqual(
    [...registeredTools.keys()].sort(),
    ['assistant_manage', 'memory', 'memory_insight', 'memory_rollup', 'skill_audit', 'skill_list', 'skill_manage', 'skill_view'],
  )

  assert.ok(sections.some(s => s.name === 'hanako:guide'), 'guide section 必须注册')

  assert.ok(routes.length >= 3, `应注册多条路由，实际 ${routes.length}`)
  assert.ok(routes.every(route => typeof route.kind === 'string' && typeof route.path === 'string'))
})

test('memory 工具写入真实落盘', async () => {
  const { ctx, registeredTools } = makeCtx()
  plugin.apply(ctx, {})

  const memoryTool = registeredTools.get('memory')
  const result = await memoryTool.execute(
    { target: 'memory', action: 'add', content: '集成测试条目' },
    { agent: { id: 'alpha' } },
  )
  assert.equal(result.success, true, JSON.stringify(result))

  const file = path.join(home, '.agent-presets', 'alpha', 'memory', 'MEMORY.md')
  assert.ok(fs.existsSync(file), `文件应存在：${file}`)
  assert.match(fs.readFileSync(file, 'utf8'), /集成测试条目/)
})

test('memory 工具按 agent 隔离', async () => {
  const { ctx, registeredTools } = makeCtx()
  plugin.apply(ctx, {})

  const memoryTool = registeredTools.get('memory')
  await memoryTool.execute({ target: 'memory', action: 'add', content: 'A的记忆' }, { agent: { id: 'agent-a' } })
  await memoryTool.execute({ target: 'memory', action: 'add', content: 'B的记忆' }, { agent: { id: 'agent-b' } })

  const fileA = path.join(home, '.agent-presets', 'agent-a', 'memory', 'MEMORY.md')
  const fileB = path.join(home, '.agent-presets', 'agent-b', 'memory', 'MEMORY.md')
  assert.match(fs.readFileSync(fileA, 'utf8'), /A的记忆/)
  assert.ok(!fs.readFileSync(fileA, 'utf8').includes('B的记忆'), '不同 agent 的记忆必须隔离')
  assert.match(fs.readFileSync(fileB, 'utf8'), /B的记忆/)
})

test('skill_manage 工具写入真实落盘', async () => {
  const { ctx, registeredTools } = makeCtx()
  plugin.apply(ctx, {})

  const skillTool = registeredTools.get('skill_manage')
  const result = await skillTool.execute({
    operations: [{
      action: 'create',
      skill: 'integration-skill',
      description: 'Created by the integration test.',
      body: '# Integration\n\nDo the thing.',
    }],
  })
  assert.equal(result.success, true, JSON.stringify(result))

  const file = path.join(home, 'skills', 'integration-skill', 'SKILL.md')
  assert.ok(fs.existsSync(file), `SKILL.md 应存在：${file}`)

  const listTool = registeredTools.get('skill_list')
  const listed = await listTool.execute({}, {})
  assert.ok(listed.skills.some(item => item.name === 'integration-skill'))

  const viewTool = registeredTools.get('skill_view')
  const viewed = await viewTool.execute({ name: 'integration-skill' }, {})
  assert.equal(viewed.found, true)
  assert.match(viewed.content, /# Integration/)
})

test('assistant_manage 创建助手并落成 preset', async () => {
  const { ctx, registeredTools } = makeCtx()
  plugin.apply(ctx, {})

  const tool = registeredTools.get('assistant_manage')
  const created = await tool.execute({ action: 'create', name: 'Integration Assistant', yuan: 'ming' }, {})
  assert.equal(created.success, true, JSON.stringify(created))
  assert.equal(created.assistant.yuan, 'ming')

  const dir = path.join(home, '.agent-presets', created.assistant.id)
  assert.ok(fs.existsSync(path.join(dir, 'agent.cordis.yml')), '必须生成组合文件')
  assert.ok(fs.existsSync(path.join(dir, 'preset.yml')), '必须生成元数据')
  assert.ok(fs.existsSync(path.join(dir, 'memory')), '必须建立记忆目录')

  const listed = await tool.execute({ action: 'list' }, {})
  assert.equal(listed.success, true)
  assert.ok(listed.assistants.some(item => item.id === created.assistant.id))
})

test('pre-step 注入冻结快照（先 next 再 splice）', async () => {
  const { ctx, registeredTools, events } = makeCtx()
  plugin.apply(ctx, {})

  // 先写一条记忆
  await registeredTools.get('memory').execute(
    { target: 'memory', action: 'add', content: 'pre-step 测试用的记忆' },
    { agent: { id: 'inject-test' } },
  )

  const listener = events.find(event => event.name === 'agent/pre-step')
  assert.ok(listener !== undefined, 'pre-step listener 必须注册')

  const claimed = [{ role: 'user', content: [{ type: 'text', text: '用户的问题' }] }]
  const upstreamDecision = { kind: 'enter', messages: [...claimed] }

  // next() 模拟「其他 listener 已处理完」
  const decision = await listener.handler(
    { agent: { id: 'inject-test' }, messages: claimed, turn: 1, step: 1, signal: AbortSignal.timeout(1000) },
    async () => upstreamDecision,
  )

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, '应插入一条记忆消息')
  const injected = decision.messages[1]
  assert.equal(injected.source.kind, 'hanako-memory')
  // 宿主 dsh-session 的校验器要求每条 user/message 都有非空 id，
  // 否则整份 session 会判 corrupt（热重启后加载历史直接失败）。
  assert.equal(typeof injected.id, 'string', '注入消息必须带 id')
  assert.ok(injected.id.length > 0, '注入消息的 id 不能为空')
  assert.deepEqual(Object.keys(injected).sort(), ['content', 'id', 'role', 'source'])
  assert.match(injected.content[0].text, /<hanako-memory-snapshot>/)
  assert.match(injected.content[0].text, /pre-step 测试用的记忆/)
  // 原本的用户消息仍在
  assert.equal(decision.messages[0].content[0].text, '用户的问题')
})

test('pre-step 去重只看 source.kind，不受会话正文提及影响', async () => {
  const { ctx, registeredTools, events } = makeCtx()
  plugin.apply(ctx, {})
  await registeredTools.get('memory').execute(
    { target: 'memory', action: 'add', content: '去重测试记忆' },
    { agent: { id: 'dedupe-test' } },
  )
  const listener = events.find(event => event.name === 'agent/pre-step')

  // 会话里恰好提到过这个标签（例如我们在调试插件本身）—— 不能被当成已注入
  const claimed = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '调试 <hanako-memory-snapshot> 注入' }] },
  ]
  const decision = await listener.handler(
    { agent: { id: 'dedupe-test' }, messages: claimed, turn: 1, step: 1, signal: AbortSignal.timeout(1000) },
    async () => ({ kind: 'enter', messages: [...claimed] }),
  )
  assert.equal(decision.messages.length, 2, '正文里出现标签不应阻止注入')

  // 真的已经注入过（source.kind 命中）才跳过
  const injectedAlready = [
    { id: 'm2', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'hanako-memory', form: 'snapshot' } },
  ]
  const second = await listener.handler(
    { agent: { id: 'dedupe-test' }, messages: injectedAlready, turn: 1, step: 2, signal: AbortSignal.timeout(1000) },
    async () => ({ kind: 'enter', messages: [...injectedAlready] }),
  )
  assert.equal(second.messages.length, 1, '已注入过就不重复注入')
})

test('pre-step 尊重上游 reject 决策', async () => {
  const { ctx, events } = makeCtx()
  plugin.apply(ctx, {})
  const listener = events.find(event => event.name === 'agent/pre-step')

  const decision = await listener.handler(
    { agent: { id: 'x' }, messages: [], turn: 1, step: 1, signal: AbortSignal.timeout(1000) },
    async () => ({ kind: 'reject' }),
  )
  assert.equal(decision.kind, 'reject', '上游 reject 时必须原样返回，不能强行 enter')
})

test('pre-step 在无记忆时不注入', async () => {
  const { ctx, events } = makeCtx()
  plugin.apply(ctx, {})
  const listener = events.find(event => event.name === 'agent/pre-step')

  const claimed = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const decision = await listener.handler(
    { agent: { id: 'empty-agent' }, messages: claimed, turn: 1, step: 1, signal: AbortSignal.timeout(1000) },
    async () => ({ kind: 'enter', messages: [...claimed] }),
  )
  assert.equal(decision.messages.length, 1, '空记忆不应注入任何消息')
})

test('pre-step 不重复注入（同一会话已有快照）', async () => {
  const { ctx, registeredTools, events } = makeCtx()
  plugin.apply(ctx, {})
  await registeredTools.get('memory').execute(
    { target: 'memory', action: 'add', content: '去重测试' },
    { agent: { id: 'dedupe-agent' } },
  )

  const listener = events.find(event => event.name === 'agent/pre-step')
  const claimed = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }]
  const first = await listener.handler(
    { agent: { id: 'dedupe-agent' }, messages: claimed, turn: 1, step: 1, signal: AbortSignal.timeout(1000) },
    async () => ({ kind: 'enter', messages: [...claimed] }),
  )
  assert.equal(first.messages.length, 2)

  // 第二次：messages 里已经有快照
  const second = await listener.handler(
    { agent: { id: 'dedupe-agent' }, messages: claimed, turn: 1, step: 2, signal: AbortSignal.timeout(1000) },
    async () => ({ kind: 'enter', messages: [...first.messages] }),
  )
  assert.equal(second.messages.length, 2, '已有快照时不得重复插入')
})

test('disabled 配置下不注册任何东西', () => {
  const { ctx, registeredTools, sections, routes } = makeCtx()
  plugin.apply(ctx, { enabled: false })
  assert.equal(registeredTools.size, 0)
  assert.equal(sections.length, 0)
  assert.equal(routes.length, 0)
})

test('webServer 服务缺失时不抛错（工具照常注册）', () => {
  const { ctx, registeredTools } = makeCtx()
  // webServer 存在但没有对应服务时，ctx.inject(['webServer']) 不应成功回调
  const originalInject = ctx.inject
  ctx.inject = (deps, cb) => {
    if (Array.isArray(deps) && deps.includes('webServer')) return () => {}
    return originalInject(deps, cb)
  }
  plugin.apply(ctx, {})
  assert.ok(registeredTools.size > 0, '工具仍应注册，只是没有面板路由')
})

test('完全没有 inject 能力时 apply 也不崩（极端降级）', () => {
  const { ctx } = makeCtx()
  delete ctx.inject
  assert.doesNotThrow(() => plugin.apply(ctx, {}))
})
