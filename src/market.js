/**
 * 技能市场（腾讯 SkillHub）—— 把「装技能」这件事从命令行搬进面板。
 *
 * ## 数据源
 *
 * 本机装了腾讯 SkillHub 的 CLI（`skillhub`，实为 `skills_store_cli.py`），它提供：
 *
 * ```
 * skillhub search <词...> --json [--search-limit N]      → { query, count, results: [{ slug, publicSlug, name, description, version, source, namespace:{handle,publicSlug} }] }
 * skillhub skill rankings [--json]                        → { results: [...含 category / subCategories / downloads / stars / iconUrl / publisher...] }
 * skillhub install <slug> --namespace <ns> --dir DIR --json
 * skillhub list --json                                    → 本机已装
 * ```
 *
 * 我们只做三件事：**搜 / 榜单 / 装**，装的目标目录固定为本插件配置的写入根
 * （默认 `~/.dsh/skills`），这样装完立刻能被 skill catalog 发现。
 *
 * ## 安全约束（重要）
 *
 * - 一律用 `execFile`（不经过 shell），参数数组传参 → 不存在命令注入
 * - `slug` / `namespace` 只允许 `[A-Za-z0-9._-]`，其他一律拒绝
 * - 每次调用有超时（默认 20s），失败原样回传错误，不吞掉
 * - 只读搜索有 60s 缓存，避免面板每敲一个字都打一次远端
 *
 * @module src/market.js
 */

import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** 允许出现在 slug / namespace 里的字符。 */
const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,80}$/

/** 默认 CLI 位置（用户环境里是 ~/.local/bin/skillhub）。 */
export const DEFAULT_CLI_CANDIDATES = Object.freeze([
  path.join(os.homedir(), '.local', 'bin', 'skillhub'),
  '/opt/homebrew/bin/skillhub',
  '/usr/local/bin/skillhub',
])

/** 找一个可执行的 skillhub。 */
export function resolveSkillhubBin(explicit) {
  if (typeof explicit === 'string' && explicit !== '') {
    try {
      fs.accessSync(explicit, fs.constants.X_OK)
      return explicit
    } catch {
      return null
    }
  }
  if (typeof process.env.SKILLHUB_BIN === 'string' && process.env.SKILLHUB_BIN !== '') {
    try {
      fs.accessSync(process.env.SKILLHUB_BIN, fs.constants.X_OK)
      return process.env.SKILLHUB_BIN
    } catch { /* 继续找默认位置 */ }
  }
  for (const candidate of DEFAULT_CLI_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch { /* 下一个 */ }
  }
  return null
}

function assertToken(value, field) {
  const text = String(value ?? '')
  if (!SAFE_TOKEN.test(text)) throw new Error(`${field} 含非法字符：${JSON.stringify(text)}`)
  return text
}

/**
 * 一个市场客户端。
 *
 * `exec` 可注入（测试用），签名 `(file, args, options) => Promise<{stdout, stderr}>`。
 */
export class SkillMarket {
  /**
   * @param {{bin?: string|null, skillsRoot: string, exec?: Function, ttlMs?: number, timeoutMs?: number}} options
   */
  constructor({ bin = null, skillsRoot, exec = null, ttlMs = 60_000, timeoutMs = 20_000 }) {
    this.bin = bin === null ? resolveSkillhubBin() : bin
    this.skillsRoot = skillsRoot
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
    this._exec = exec === null ? defaultExec : exec
    this._cache = new Map()
  }

  /** CLI 是否可用（面板据此显示「市场不可用」而不是空列表）。 */
  available() {
    return typeof this.bin === 'string' && this.bin !== ''
  }

  _run(args, { timeoutMs } = {}) {
    if (!this.available()) return Promise.reject(new Error('skillhub CLI 不可用（没找到可执行文件）'))
    return this._exec(this.bin, args, { timeout: timeoutMs ?? this.timeoutMs })
  }

  _cached(key, producer) {
    const hit = this._cache.get(key)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < this.ttlMs) return Promise.resolve(hit.value)
    return producer().then(value => {
      this._cache.set(key, { at: Date.now(), value })
      return value
    })
  }

  /**
   * 搜索技能。
   *
   * @param {{query: string, limit?: number}} input
   * @returns {Promise<{query: string, count: number, results: Array<object>}>}
   */
  async search({ query = '', limit = 20 } = {}) {
    const words = String(query ?? '').trim().slice(0, 60)
    const capped = Math.min(Math.max(Number(limit) || 20, 1), 40)
    const args = ['search']
    if (words !== '') args.push(words)
    args.push('--json', '--search-limit', String(capped))
    return this._cached('search:' + words + ':' + capped, async () => {
      const { stdout } = await this._run(args)
      const parsed = parseJson(stdout, 'search')
      const results = Array.isArray(parsed.results) ? parsed.results : []
      return {
        query: String(parsed.query ?? words),
        count: Number(parsed.count ?? results.length),
        results: results.map(normalizeResult).filter(item => item.slug !== ''),
      }
    })
  }

  /**
   * 榜单（带分类、下载量、星标、publisher，用来做「精选 / 分类」）。
   *
   * @returns {Promise<{results: Array<object>, categories: Array<{key: string, name: string, count: number}>}>}
   */
  async rankings() {
    return this._cached('rankings', async () => {
      const { stdout } = await this._run(['skill', 'rankings'])
      const parsed = parseJson(stdout, 'rankings')
      // 真实形状是 `{ rankings: { hot: { section, skills: [...] }, featured: {...}, ... } }`
      // 旧版曾按 `{ results: [...] }` 解析，结果永远空列表 —— 两种都兼容。
      let rows = []
      if (Array.isArray(parsed.results)) {
        rows = parsed.results
      } else if (parsed.rankings !== null && typeof parsed.rankings === 'object') {
        const order = ['featured', 'hot', 'recommended', 'trending', 'newest']
        const seen = new Set()
        for (const key of order) {
          const section = parsed.rankings[key]
          const list = section !== null && typeof section === 'object' && Array.isArray(section.skills) ? section.skills : []
          for (const item of list) {
            const canonical = String((item && item.namespace && item.namespace.canonicalName) || (item && item.slug) || '')
            if (canonical === '' || seen.has(canonical)) continue
            seen.add(canonical)
            rows.push({ ...item, sectionKey: key })
          }
        }
      }
      const results = rows.map(normalizeResult).filter(item => item.slug !== '')
      const categories = new Map()
      for (const item of results) {
        const key = item.category || 'other'
        const row = categories.get(key) ?? { key, name: categoryName(key), count: 0 }
        row.count += 1
        categories.set(key, row)
      }
      return { results, categories: [...categories.values()].sort((a, b) => b.count - a.count) }
    })
  }

  /**
   * 装一个技能到写入根（`skillsRoot`）。
   *
   * @param {{slug: string, namespace?: string}} input
   */
  async install({ slug, namespace = '' } = {}) {
    const cleanSlug = assertToken(stripAt(slug), 'slug')
    const cleanNamespace = namespace === '' ? '' : assertToken(stripAt(namespace), 'namespace')
    const args = ['install', cleanSlug, '--dir', this.skillsRoot, '--json', '--force']
    if (cleanNamespace !== '') args.push('--namespace', cleanNamespace)
    const { stdout, stderr } = await this._run(args, { timeoutMs: 120_000 })
    const text = String(stdout ?? '').trim()
    let parsed = null
    try { parsed = text === '' ? null : JSON.parse(text.slice(text.indexOf('{'))) } catch { parsed = null }
    this._cache.delete('rankings')
    for (const key of [...this._cache.keys()]) if (key.startsWith('search:')) this._cache.delete(key)
    return {
      slug: cleanSlug,
      namespace: cleanNamespace,
      ok: parsed === null ? true : parsed.success !== false && parsed.ok !== false,
      detail: parsed ?? { raw: text.slice(0, 400), stderr: String(stderr ?? '').slice(0, 400) },
    }
  }

  /** 本机已装（`skillhub list --json`，失败就返回空 —— 面板仍能以 catalog 为准）。 */
  async installed() {
    if (!this.available()) return []
    try {
      const { stdout } = await this._run(['list', '--json'])
      const parsed = parseJson(stdout, 'list')
      const rows = Array.isArray(parsed.skills) ? parsed.skills : (Array.isArray(parsed.results) ? parsed.results : [])
      return rows.map(normalizeResult).filter(item => item.slug !== '')
    } catch {
      return []
    }
  }
}

function stripAt(value) {
  const text = String(value ?? '').trim()
  // 允许传 @ns/slug 或 slug；这里只留最后一段给 CLI 的 slug 参数
  const slash = text.lastIndexOf('/')
  return slash === -1 ? text : text.slice(slash + 1)
}

function parseJson(stdout, label) {
  const text = String(stdout ?? '').trim()
  if (text === '') throw new Error(`${label} 返回空输出`)
  const start = text.search(/[[{]/)
  if (start === -1) throw new Error(`${label} 输出不是 JSON：${text.slice(0, 160)}`)
  try {
    return JSON.parse(text.slice(start))
  } catch (error) {
    throw new Error(`${label} JSON 解析失败：${String(error?.message ?? error)}`)
  }
}

function categoryName(key) {
  const map = {
    'office-efficiency': '办公提效',
    'content-creation': '内容创作',
    'data-analysis': '数据分析',
    'dev-programming': '研发编程',
    'design-media': '设计媒体',
    'business-ops': '商业运营',
    'ai-agent': '智能体',
    'it-ops-security': '安全运维',
    professional: '专业服务',
    education: '教育',
    'life-service': '生活服务',
  }
  return map[key] ?? key
}

/** 把 SkillHub 的两种形状（search / rankings）压成面板用的同一份结构。 */
function normalizeResult(raw) {
  const item = raw !== null && typeof raw === 'object' ? raw : {}
  const ns = item.namespace !== null && typeof item.namespace === 'object' ? item.namespace : {}
  const publisher = item.publisher !== null && typeof item.publisher === 'object' ? item.publisher : null
  const canonical = String(ns.canonicalName ?? item.slug ?? '')
  const namespace = String(ns.handle ?? '')
  const slug = String(item.publicSlug ?? item.slug ?? '')
  const description = String(item.description_zh || item.description || '').replace(/\s+/g, ' ').trim()
  return {
    slug: slug === '' ? String(item.slug ?? '') : slug,
    canonical,
    namespace,
    name: String(item.name ?? slug),
    description: description.length > 220 ? description.slice(0, 220) + '…' : description,
    version: String(item.version ?? ''),
    source: String(item.source ?? ''),
    category: String(item.category ?? ''),
    downloads: Number(item.downloads ?? 0) || 0,
    stars: Number(item.stars ?? 0) || 0,
    iconUrl: typeof item.iconUrl === 'string' ? item.iconUrl : '',
    verified: publisher !== null && publisher.verified === true,
    publisher: publisher === null ? '' : String(publisher.name ?? ''),
    subCategories: Array.isArray(item.subCategories)
      ? item.subCategories.map(row => String(row && row.name ? row.name : '')).filter(Boolean).slice(0, 3)
      : [],
  }
}

/** 默认执行器：execFile + 超时 + 大缓冲（榜单 JSON 可能上百 KB）。 */
function defaultExec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: options.timeout ?? 20_000,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim() || String(error.message ?? error)
        reject(new Error(String(detail).slice(0, 400)))
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

export const __test = { normalizeResult, parseJson, SAFE_TOKEN, stripAt, categoryName }
