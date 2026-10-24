/**
 * 技能市场（腾讯 SkillHub）客户端逻辑测试。
 *
 * 关键点：
 * - 命令一律 execFile + 参数数组，slug/namespace 只允许安全字符（防注入）
 * - 两种返回形状（search / rankings）要压成同一份结构
 * - 安装失败要把错误原样带出来，不能假装成功
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SkillMarket, __test } from '../src/market.js'

const SEARCH_JSON = JSON.stringify({
  query: 'docx',
  count: 2,
  results: [
    {
      slug: '@zcwl/docx',
      publicSlug: 'docx',
      name: 'docx',
      description: '手工操作效率低易出错。智能化自动处理。',
      version: '1.0.0',
      source: 'community',
      namespace: { canonicalName: '@zcwl/docx', displayName: 'zcwl', handle: 'zcwl', publicSlug: 'docx' },
    },
    {
      slug: '@tencent-adm/tencent-meeting-mcp',
      publicSlug: 'tencent-meeting-mcp',
      name: '腾讯会议MCP',
      description_zh: '会议管理与音视频协作助手。',
      version: '1.0.16',
      source: 'enterprise',
      category: 'office-efficiency',
      downloads: 245376,
      publisher: { name: '腾讯会议', verified: true },
      namespace: { canonicalName: '@tencent-adm/tencent-meeting-mcp', handle: 'tencent-adm', publicSlug: 'tencent-meeting-mcp' },
    },
  ],
})

/** 记录调用的假执行器。 */
function fakeExec(table) {
  const calls = []
  const exec = (file, args) => {
    calls.push([file, ...args])
    const key = args[0]
    const plan = table[key]
    if (plan === undefined) return Promise.reject(new Error('unexpected: ' + args.join(' ')))
    if (typeof plan === 'function') return plan(args)
    return Promise.resolve({ stdout: plan, stderr: '' })
  }
  return { exec, calls }
}

test('search 会走 --json 并压成统一结构', async () => {
  const { exec, calls } = fakeExec({ search: SEARCH_JSON })
  const market = new SkillMarket({ bin: '/fake/skillhub', skillsRoot: '/tmp/skills', exec })

  const data = await market.search({ query: 'docx', limit: 5 })
  assert.equal(data.count, 2)
  assert.equal(data.results.length, 2)
  const first = data.results[0]
  assert.equal(first.slug, 'docx')
  assert.equal(first.namespace, 'zcwl')
  assert.equal(first.canonical, '@zcwl/docx')
  const second = data.results[1]
  assert.equal(second.verified, true, 'publisher.verified 要冒到顶层')
  assert.equal(second.downloads, 245376)

  const searchCall = calls[0]
  assert.equal(searchCall[0], '/fake/skillhub')
  assert.ok(searchCall.includes('--json'))
  assert.ok(searchCall.includes('docx'))
  assert.ok(searchCall.includes('--search-limit'))
})

test('search 有 60s 缓存（同一 query 只调一次 CLI）', async () => {
  const { exec, calls } = fakeExec({ search: SEARCH_JSON })
  const market = new SkillMarket({ bin: '/fake/skillhub', skillsRoot: '/tmp/skills', exec })
  await market.search({ query: 'docx' })
  await market.search({ query: 'docx' })
  assert.equal(calls.length, 1, '第二次应命中缓存')
})

test('rankings 会把分类聚出来（兼容 {rankings:{hot:{skills}}} 真实形状）', async () => {
  const { exec } = fakeExec({
    skill: JSON.stringify({
      rankings: {
        featured: { skills: [
          { slug: '@a/one', name: '一', category: 'office-efficiency', downloads: 10, namespace: { handle: 'a', publicSlug: 'one' } },
        ] },
        hot: { skills: [
          { slug: '@a/one', name: '一', category: 'office-efficiency', downloads: 10, namespace: { handle: 'a', publicSlug: 'one' } },
          { slug: '@b/two', name: '二', category: 'office-efficiency', downloads: 20, namespace: { handle: 'b', publicSlug: 'two' } },
          { slug: '@c/three', name: '三', category: 'data-analysis', namespace: { handle: 'c', publicSlug: 'three' } },
        ] },
      },
    }),
  })
  const market = new SkillMarket({ bin: '/fake/skillhub', skillsRoot: '/tmp/skills', exec })
  const data = await market.rankings()
  assert.equal(data.results.length, 3)
  const office = data.categories.find(row => row.key === 'office-efficiency')
  assert.equal(office.count, 2)
  assert.equal(office.name, '办公提效')
})

test('install 只允许安全 slug / namespace，并且带 --dir', async () => {
  const { exec, calls } = fakeExec({ install: JSON.stringify({ success: true, slug: 'docx' }) })
  const market = new SkillMarket({ bin: '/fake/skillhub', skillsRoot: '/tmp/skills', exec })

  const result = await market.install({ slug: '@zcwl/docx', namespace: 'zcwl' })
  assert.equal(result.ok, true)
  assert.equal(result.slug, 'docx', '@ns/slug 会剥成 slug')
  assert.equal(result.namespace, 'zcwl')
  const call = calls[0]
  assert.ok(call.includes('--dir'))
  assert.equal(call[call.indexOf('--dir') + 1], '/tmp/skills')
  assert.ok(call.includes('--namespace'))

  await assert.rejects(() => market.install({ slug: 'bad; rm -rf /' }), /含非法字符/)
  await assert.rejects(() => market.install({ slug: 'ok', namespace: 'a b' }), /含非法字符/)
})

test('install 失败会把错误带出来（不假装成功）', async () => {
  const { exec } = fakeExec({
    install: () => Promise.reject(new Error('download failed: 403')),
  })
  const market = new SkillMarket({ bin: '/fake/skillhub', skillsRoot: '/tmp/skills', exec })
  await assert.rejects(() => market.install({ slug: 'docx' }), /download failed/)
})

test('CLI 不可用时 available() 为 false，调用直接报错', async () => {
  const market = new SkillMarket({ bin: '', skillsRoot: '/tmp/skills', exec: () => Promise.resolve({ stdout: '', stderr: '' }) })
  assert.equal(market.available(), false)
  await assert.rejects(() => market.search({ query: 'x' }), /CLI 不可用/)
})

test('内部工具函数：stripAt / categoryName', () => {
  assert.equal(__test.stripAt('@ns/slug'), 'slug')
  assert.equal(__test.stripAt('slug'), 'slug')
  assert.equal(__test.categoryName('office-efficiency'), '办公提效')
  assert.equal(__test.categoryName('unknown-cat'), 'unknown-cat')
})
