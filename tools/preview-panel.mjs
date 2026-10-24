#!/usr/bin/env node
/**
 * 面板本地预览：把 client bundle 在 Node 里渲染成一张 HTML，再用无头 Chrome 截图。
 *
 * 为什么需要：这台机器上我没法（也不该）去点宿主窗口 —— 但「UI 好不好看」必须看得见。
 * 这个脚本用 test/helpers/mini-react.mjs 把面板树 + 面板自己的 CSS 渲成独立 HTML，
 * 于是改样式可以本地闭环验证，不用每次重启应用再用肉眼试。
 *
 * 用法：
 *   node tools/preview-panel.mjs                 # 渲染全部 tab
 *   node tools/preview-panel.mjs memory          # 只渲染某个 tab
 *   node tools/preview-panel.mjs --shot          # 顺便用无头 Chrome 截图到 /tmp/panel-<tab>.png
 *
 * 产物：/tmp/panel-preview-<tab>.html（可直接拖浏览器看）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createMiniReact } from '../test/helpers/mini-react.mjs'

const AGENT_ID = 'hanako'

const OVERVIEW = {
  ok: true,
  totals: {
    assistants: 2,
    broken: 0,
    byYuan: { hanako: 1, ming: 1 },
    defaultId: AGENT_ID,
    memory: { used: 1240, limit: 4400, pct: 28 },
    user: { used: 310, limit: 2750, pct: 11 },
    pinned: 2,
    skills: 3,
  },
  limits: { memory: 2200, user: 1375 },
  paths: {
    presets: path.join(os.homedir(), '.dsh', '.agent-presets'),
    memoryTemplate: path.join(os.homedir(), '.dsh', '.agent-presets', '<助手id>', 'memory'),
    skillRoots: [path.join(os.homedir(), '.dsh', 'skills'), path.join(os.homedir(), '.agents', 'skills')],
    activityFile: path.join(os.homedir(), '.dsh', 'hanako-memory', 'activity.json'),
  },
  activity: [
    { at: Date.now() - 40_000, kind: 'memory', agentId: AGENT_ID, target: 'memory', ok: true, ops: 1, detail: '28% — 1,240/2,200 chars' },
    { at: Date.now() - 9 * 60_000, kind: 'pinned', agentId: AGENT_ID, ok: true, count: 2 },
    { at: Date.now() - 3 * 3600_000, kind: 'memory', agentId: 'ming', target: 'user', ok: false, ops: 1, detail: 'That would put user at 1500/1375 chars — over the limit.' },
    { at: Date.now() - 26 * 3600_000, kind: 'skills', ok: true, ops: 2, detail: 'created 1, updated 1' },
  ],
  assistants: [
    {
      id: AGENT_ID,
      name: '小花',
      yuan: 'hanako',
      description: '温柔有主见，回答前先冒内心戏',
      isDefault: true,
      broken: false,
      memory: { used: 1240, limit: 2200, pct: 56, entryCount: 6, remaining: 960 },
      user: { used: 310, limit: 1375, pct: 23, entryCount: 3, remaining: 1065 },
      pinned: 2,
      rolling: {
        today: { chars: 820, exists: true, updatedAt: Date.now() - 2 * 3600_000 },
        week: { chars: 2100, exists: true, updatedAt: Date.now() - 30 * 3600_000 },
        longterm: { chars: 0, exists: false, updatedAt: 0 },
      },
      residentUpdatedAt: { memory: Date.now() - 40_000, user: Date.now() - 600_000 },
      updatedAt: Date.now() - 40_000,
    },
    {
      id: 'ming',
      name: '明',
      yuan: 'ming',
      description: '先厘清前提，再动手',
      isDefault: false,
      broken: false,
      memory: { used: 300, limit: 2200, pct: 14, entryCount: 2, remaining: 1900 },
      user: { used: 180, limit: 1375, pct: 13, entryCount: 1, remaining: 1195 },
      pinned: 0,
      rolling: {
        today: { chars: 260, exists: true, updatedAt: Date.now() - 7 * 3600_000 },
        week: { chars: 0, exists: false, updatedAt: 0 },
        longterm: { chars: 640, exists: true, updatedAt: Date.now() - 4 * 86400_000 },
      },
      residentUpdatedAt: { memory: Date.now() - 7 * 3600_000, user: Date.now() - 7 * 3600_000 },
      updatedAt: Date.now() - 7 * 3600_000,
    },
  ],
}

const MEMORY = {
  ok: true,
  agentId: AGENT_ID,
  status: {
    memory: {
      used: 1240,
      limit: 2200,
      pct: 56,
      entryCount: 6,
      entries: [
        '我的元是「小花」（hanako），意识块形态：Vibe / Sparks / Reflections / Will。',
        '用户的 Mac 是 arm64，DSH 应用版本 0.2.0-rc.2，profile 在 ~/.dsh/profiles/desktop。',
        '插件装进主环境前必须先跑 tools/sandbox-verify.sh，四级全绿才能装。',
        '插件装进主环境前必须先跑 tools/sandbox-verify.sh，四级全绿才能装。',
        'client 插件必须 inject: [\'slots\']，否则 ctx.slots 会抛 without inject，入口全部静默消失。',
        '改完 client/client.js 存盘即热更新（宿主 dsh-client-hmr 会 watch）；index.js 和 src/** 需要重启应用才生效。',
      ],
    },
    user: { used: 310, limit: 1375, pct: 23, entryCount: 3, entries: ['用户在台北，习惯用繁体中文。', '偏好简洁直接的回复，讨厌废话。', '长期在做 DSH 插件生态。'] },
    today: { chars: 820, exists: true },
    week: { chars: 2100, exists: true },
    longterm: { chars: 0, exists: false },
  },
  pinned: ['永远先备份再动手', '交付前必须自己验证，不许说「应该可以」'],
  rolling: {
    today: { chars: 820, exists: true, updatedAt: Date.now() - 2 * 3600_000 },
    week: { chars: 2100, exists: true, updatedAt: Date.now() - 30 * 3600_000 },
    longterm: { chars: 0, exists: false, updatedAt: 0 },
  },
  updatedAt: { memory: Date.now() - 40_000, user: Date.now() - 600_000 },
}

const SKILLS = {
  ok: true,
  roots: ['/Users/simle/.dsh/skills', '/Users/simle/.agents/skills'],
  skills: [
    { name: 'dsh-plugin-dev', description: '开发 DSH 插件：client bundle 契约、槽位注册、webServer 路由、沙箱验证', whenToUse: '要加面板 / 工具 / 路由时', relativePath: 'dsh-plugin-dev', dir: '', root: '', chars: 4820, updatedAt: Date.now() - 2 * 3600_000 },
    { name: 'office-docx', description: '读写 .docx，含表格与格式化', whenToUse: '交付 Word 文档时', relativePath: 'office-docx', dir: '', root: '', chars: 3110, updatedAt: Date.now() - 3 * 86400_000 },
    { name: 'hermes-memory', description: 'Hermes 双库记忆纪律：有界、原子、可回退', whenToUse: '改记忆层逻辑时', relativePath: 'hermes-memory', dir: '', root: '', chars: 1550, updatedAt: Date.now() - 9 * 86400_000 },
  ],
}

function installFetch() {
  globalThis.fetch = async url => {
    const p = String(url)
    let body = { ok: true }
    if (p.includes('/overview')) body = OVERVIEW
    else if (p.includes('/memory/')) body = MEMORY
    else if (p.includes('/skills/')) body = { ok: true, name: 'dsh-plugin-dev', content: '# dsh-plugin-dev\n\n（技能全文预览）' }
    else if (p.includes('/skills')) body = SKILLS
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
}

const PERSONAS = [
  { id: 'hanako', label: '小花', glyph: '🌙', accent: '#e8a0bf', moodTag: 'MOOD', blocks: ['Vibe', 'Sparks', 'Reflections', 'Will'], blurb: '温柔、有主见，会在回答前先冒一小段内心戏。', prompt: '', builtin: true },
  { id: 'kong', label: '空', glyph: '◯', accent: '#9a9a9a', moodTag: '—', blocks: [], blurb: '没有意识块，不演内心戏，直接给答案。', prompt: '', builtin: true },
  { id: 'p-j9rgpt', label: '程序员老王', glyph: '🛠', accent: '#7fb2d9', moodTag: 'BUILD', blocks: ['Plan', 'Patch', 'Verify'], blurb: '话少，先看代码再下判断。', prompt: '永远先复现再修；不确定就说不确定。', builtin: false, createdAt: Date.now() - 86400e3, updatedAt: Date.now() - 3600e3 },
]

const TABS = ['overview', 'assistants', 'personas', 'memory', 'skills']

async function loadBundle() {
  const mini = createMiniReact()
  const captured = []
  globalThis.window = { __ModuleLoader__: { load: spec => { captured.push(spec) } }, confirm: () => true }
  globalThis.document = undefined
  installFetch()
  await import('../client/client.js?preview=' + Date.now())
  const spec = captured[0]
  const mod = spec.factory(name => {
    if (name === 'react') return mini.React
    throw new Error('unexpected require: ' + name)
  })
  return { mini, internals: mod.__test }
}

function wrapHtml(title, css, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #1b1b1d; color: #eee; font: 13px/1.6 -apple-system, "PingFang SC", system-ui, sans-serif; }
  .frame { padding: 18px 20px 40px; max-width: 900px; }
  .frame-title { font-size: 12px; color: #888; margin-bottom: 10px; letter-spacing: .5px; }
  .dsw-alias-label-primary { color: #eee }
  ${css}
</style></head>
<body><div class="frame"><div class="frame-title">${title}</div>${body}</div></body></html>`
}

const wantShots = process.argv.includes('--shot')
const only = process.argv.find(arg => TABS.includes(arg))

const { mini, internals } = await loadBundle()
const css = internals.CSS
const results = []

for (const tab of TABS) {
  if (only && tab !== only) continue
  let element
  if (tab === 'overview') {
    element = mini.React.createElement(internals.OverviewTab, {
      overview: OVERVIEW,
      agentName: () => '小花',
      onReload: () => {},
      onOpenMemory: () => {},
    })
  } else if (tab === 'personas') {
    element = mini.React.createElement(internals.PersonasTab, {
      personas: PERSONAS,
      editingPersona: [PERSONAS[2].id, () => {}],
      onChanged: () => {},
    })
  } else if (tab === 'assistants') {
    element = mini.React.createElement(internals.AssistantsTab, {
      overview: OVERVIEW,
      personas: PERSONAS,
      agentId: AGENT_ID,
      onChanged: () => {},
      onOpenMemory: () => {},
    })
  } else if (tab === 'memory') {
    element = mini.React.createElement(internals.MemoryTab, {
      agentId: AGENT_ID,
      overview: OVERVIEW,
      agentName: '小花',
      onPickAgent: () => {},
      onChanged: () => {},
    })
  } else {
    element = mini.React.createElement(internals.SkillsTab)
  }

  const body = await mini.mount(element)
  const html = wrapHtml('dsh-hanako-memory · ' + tab, css, body)
  const file = '/tmp/panel-preview-' + tab + '.html'
  fs.writeFileSync(file, html)
  results.push({ tab, file })

  if (wantShots) {
    const png = '/tmp/panel-' + tab + '.png'
    execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=980,780',
      '--screenshot=' + png,
      'file://' + file,
    ], { stdio: 'ignore' })
    results[results.length - 1].png = png
  }
}

for (const row of results) {
  console.log('✅ ' + row.tab + ' → ' + row.file + (row.png ? '  截图 ' + row.png : ''))
}
