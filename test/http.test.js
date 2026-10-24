/**
 * 路由契约测试。
 *
 * 为什么必须有：`dsh-host-webserver` 要求 prefix 路径**不能有尾部斜杠**，
 * 违反时不报错、只是静默不匹配 → 请求落到 SPA fallback，面板读到 index.html。
 * 沙箱实测踩过这个坑，所以把契约钉成测试。
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

function makeDeps() {
  // dshHome 指到临时目录：活动日志会落盘，绝不能写进仓库或 $HOME
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-routes-'))
  const presetsRoot = path.join(dshHome, '.agent-presets')
  fs.mkdirSync(presetsRoot, { recursive: true })
  const agents = new AgentRegistry({ presetsRoot })
  const skills = new SkillStore({ root: path.join(presetsRoot, 'skills') })
  const memoryFor = agentId => new AgentMemory({ dir: path.join(presetsRoot, agentId, 'memory') })
  return { agents, skills, memoryFor, settings: { memoryCharLimit: 2200, userCharLimit: 1375 }, dshHome, presetsRoot }
}

function collectRoutes() {
  const routes = []
  const ctx = { webServer: { register: route => { routes.push(route) } } }
  registerRoutes(ctx, makeDeps())
  return routes
}

test('所有路由路径都没有尾部斜杠（webserver 硬约束）', () => {
  for (const route of collectRoutes()) {
    assert.ok(!route.path.endsWith('/'), `路径不得以斜杠结尾: ${route.path}`)
    assert.ok(route.path.startsWith('/'), `路径必须是绝对形式: ${route.path}`)
  }
})

test('kind 只用 exact / prefix', () => {
  for (const route of collectRoutes()) {
    assert.ok(route.kind === 'exact' || route.kind === 'prefix', `非法 kind: ${route.kind}`)
  }
})

test('(kind, path) 不重复（重复注册会抛错）', () => {
  const seen = new Set()
  for (const route of collectRoutes()) {
    const key = `${route.kind}:${route.path}`
    assert.ok(!seen.has(key), `重复注册: ${key}`)
    seen.add(key)
  }
})

test('status 必须是 exact 路由', () => {
  const routes = collectRoutes()
  const status = routes.find(route => route.path === '/hanako-memory/status')
  assert.ok(status, '必须有 /hanako-memory/status')
  assert.equal(status.kind, 'exact', 'status 用 exact，避免被前缀匹配吞掉')
})

test('分类前缀路由齐全', () => {
  const prefixes = collectRoutes().filter(route => route.kind === 'prefix').map(route => route.path).sort()
  assert.deepEqual(prefixes, [
    '/hanako-memory/assistants',
    '/hanako-memory/insights',
    '/hanako-memory/memory',
    '/hanako-memory/personas',
    '/hanako-memory/pinned',
    '/hanako-memory/skills',
  ])
})

test('每个路由都有 handler 函数', () => {
  for (const route of collectRoutes()) {
    assert.equal(typeof route.handler, 'function', `${route.path} 缺 handler`)
  }
})
