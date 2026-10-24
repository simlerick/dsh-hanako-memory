/**
 * HTTP 路由 —— 面板与 host 半身之间的同源 API。
 *
 * ## 契约要点（来自 `dsh-host-webserver` 的类型定义，踩过坑）
 *
 * - `kind: 'exact'` 逐字匹配；`kind: 'prefix'` 匹配 `p` 与 `p/<anything>`
 * - **path 是「无尾部斜杠的绝对路径」**。写成 `/x/` 会静默不匹配，
 *   请求落到 SPA fallback，返回 index.html（面板会读到一堆 HTML）。
 * - 同一个 `(kind, path)` 重复注册会抛错。
 *
 * 所以这里用**少量 prefix 路由 + 自己切段**，而不是为每个子路径各注册一条。
 *
 * 路由表：
 * ```
 * GET  /hanako-memory/status
 * *    /hanako-memory/assistants                  GET 列表 / POST 新建
 * *    /hanako-memory/assistants/<id>             GET / PUT / DELETE
 * *    /hanako-memory/memory/<agentId>            GET 全貌 / POST 写
 * *    /hanako-memory/memory/<agentId>/<target>   GET 单库
 * *    /hanako-memory/pinned/<agentId>            GET / POST
 * *    /hanako-memory/skills                      GET 列表 / POST 批量操作
 * *    /hanako-memory/skills/<name>[/...]         GET 内容 / DELETE
 * ```
 *
 * @module src/http.js
 */

import fs, { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ActivityLog } from './activity.js'
import { RESIDENT_TARGETS, ROLLING_TARGETS } from './memory-store.js'
import { runSkillOperations } from './tools.js'

/** 本包在 boot graph 里的 id（= package.json 的 name）。 */
const PKG_NAME = 'dsh-hanako-memory'

/** client 半身最近一次回报（进程内），同时落盘一份供外部脚本读取。 */
let lastClientReport = null
const REPORT_PATH = '/tmp/hanako-client-report.json'

/** 进程内共享的活动日志（registerRoutes 可能被 HMR 多次调用）。 */
let sharedActivity = null

/**
 * @param {string} dshHome
 * @returns {ActivityLog}
 */
function activityFor(dshHome) {
  if (sharedActivity === null) {
    sharedActivity = new ActivityLog(path.join(dshHome, 'hanako-memory', 'activity.json'))
  }
  return sharedActivity
}

/** 文件 mtime（毫秒）；读不到返回 0，面板显示「—」。 */
function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 百分比（0–100，取整，限幅）。 */
function pctOf(used, limit) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

/** 只挑面板要用的字段，避免把 entries 整份塞进 overview。 */
function usageSummary(bucket) {
  return {
    used: bucket?.used ?? 0,
    limit: bucket?.limit ?? 0,
    pct: bucket?.pct ?? 0,
    entryCount: bucket?.entryCount ?? 0,
    remaining: Math.max(0, (bucket?.limit ?? 0) - (bucket?.used ?? 0)),
  }
}

/**
 * 读 boot graph 里属于本包的那一条。
 *
 * `clientModules` 是宿主 dsh-client-modules 提供的服务；拿不到时（TUI/老版本）
 * 返回 `{ available: false }`，不影响任何功能。
 *
 * @param {object} ctx
 * @param {string} id
 */
function describeClientGraph(ctx, id) {
  try {
    const modules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
    if (!modules || typeof modules.graph !== 'function') return { available: false }
    const graph = modules.graph()
    const entries = Array.isArray(graph?.entries) ? graph.entries : []
    const entry = entries.find(row => row?.id === id)
    return {
      available: true,
      rev: graph?.rev,
      entryCount: entries.length,
      /** 本包是否进入了 boot graph —— 这是「浏览器到底有没有我们的包」的判据。 */
      inGraph: entry !== undefined,
      entry: entry ?? null,
      ids: entries.map(row => row?.id),
    }
  } catch (error) {
    return { available: false, error: String(error?.message ?? error) }
  }
}

/** 统一 JSON 回应。 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读请求体（限长，防止坏客户端打满内存）。 */
async function readJsonBody(req, limitBytes = 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** 去掉 query/hash 的 pathname。 */
function pathnameOf(req) {
  return String(req?.url ?? '/').split('?')[0].split('#')[0]
}

/**
 * 取 prefix 之后的路径段（已 decode、已丢弃空段）。
 * @param {string} pathname
 * @param {string} prefix  无尾部斜杠
 */
function segmentsAfter(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return []
  const rest = pathname.slice(prefix.length).replace(/^\/+/, '')
  if (rest === '') return []
  return rest.split('/').filter(part => part !== '').map(part => {
    try { return decodeURIComponent(part) } catch { return part }
  })
}

/**
 * 注册路由。
 *
 * @param {object} ctx  已 `inject(['webServer'])` 的 scoped context
 * @param {object} deps { agents, memoryFor, skills, settings, dshHome, presetsRoot }
 */
export function registerRoutes(ctx, deps) {
  const { agents, memoryFor, skills, settings, personas, insightsFor, auditSkills, market, notifySkillsChanged } = deps
  const dshHome = typeof deps.dshHome === 'string' && deps.dshHome !== '' ? deps.dshHome : os.tmpdir()
  const activity = activityFor(dshHome)
  const presetsRoot = typeof deps.presetsRoot === 'string' ? deps.presetsRoot : ''

  const route = (kind, path, handler) => {
    if (path.endsWith('/')) throw new Error(`route path must not end with a slash: ${path}`)
    ctx.webServer.register({
      kind,
      path,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          try { json(res, 500, { ok: false, error: String(error?.message ?? error) }) } catch { /* 已断开 */ }
        }
      },
    })
  }

  /* ── 诊断（无认证、只读自身状态） ─────────────────────────
   *
   * 起因：client 半身「加载了但没挂载」时，浏览器里只有一行 console 错误，
   * 从外面完全看不见。所以让 client 半身挂载成功/失败时主动回报一次，
   * host 把它连同 boot graph 里的自己那一条一起吐出来 —— 不用再猜。
   */

  route('exact', '/hanako-memory/diag', async (_req, res) => {
    json(res, 200, {
      ok: true,
      clientReport: lastClientReport,
      clientModules: describeClientGraph(ctx, PKG_NAME),
    })
  })

  route('exact', '/hanako-memory/client-report', async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = await readJsonBody(req, 64 * 1024)
    lastClientReport = { ...body, at: Date.now(), iso: new Date().toISOString() }
    try {
      writeFileSync(REPORT_PATH, JSON.stringify(lastClientReport, null, 2))
    } catch { /* 落盘失败不影响回报本身 */ }
    json(res, 200, { ok: true })
  })

  /* ── 总览 ─────────────────────────────────────────────── */

  route('exact', '/hanako-memory/status', async (_req, res) => {
    const list = agents.list()
    const stats = agents.stats()
    const allSkills = skills.list()

    const memoryUsage = list.map(item => {
      const memory = memoryFor(item.id)
      const status = memory.status()
      return {
        agentId: item.id,
        name: item.name,
        memory: { used: status.memory.used, limit: status.memory.limit, pct: status.memory.pct, entries: status.memory.entryCount },
        user: { used: status.user.used, limit: status.user.limit, pct: status.user.pct, entries: status.user.entryCount },
        pinned: memory.readPinned().length,
      }
    })

    json(res, 200, {
      ok: true,
      assistants: stats,
      skillCount: allSkills.length,
      memoryUsage,
      limits: { memory: settings.memoryCharLimit, user: settings.userCharLimit },
    })
  })

  /**
   * 面板首页的一次性聚合。
   *
   * 面板原本要打 3–4 个请求才能拼出「助手 + 用量 + 分层 + 最近活动」，
   * 而且分层（today/week/longterm）与更新时间根本没有接口 —— 这里一次给全。
   */
  route('exact', '/hanako-memory/overview', async (_req, res) => {
    const list = agents.list()
    const stats = agents.stats()

    let memoryUsed = 0
    let memoryLimit = 0
    let userUsed = 0
    let userLimit = 0
    let pinnedTotal = 0

    const assistants = list.map(item => {
      const memory = memoryFor(item.id)
      const status = memory.status()
      const pinned = memory.readPinned()

      memoryUsed += status.memory.used
      memoryLimit += status.memory.limit
      userUsed += status.user.used
      userLimit += status.user.limit
      pinnedTotal += pinned.length

      const rolling = {}
      for (const target of ROLLING_TARGETS) {
        rolling[target] = {
          chars: status[target]?.chars ?? 0,
          exists: status[target]?.exists === true,
          updatedAt: mtimeOf(memory.rollingFileFor(target)),
        }
      }

      const residentUpdatedAt = {}
      for (const target of RESIDENT_TARGETS) residentUpdatedAt[target] = mtimeOf(memory.fileFor(target))
      const updatedAt = Math.max(residentUpdatedAt.memory, residentUpdatedAt.user, ...Object.values(rolling).map(row => row.updatedAt))

      return {
        id: item.id,
        name: item.name,
        yuan: item.yuan,
        description: item.description ?? '',
        isDefault: item.isDefault === true,
        broken: item.broken === true,
        memory: usageSummary(status.memory),
        user: usageSummary(status.user),
        pinned: pinned.length,
        rolling,
        residentUpdatedAt,
        updatedAt,
      }
    })

    json(res, 200, {
      ok: true,
      totals: {
        assistants: list.length,
        broken: stats.brokenCount,
        byYuan: stats.byYuan,
        defaultId: stats.defaultId,
        memory: { used: memoryUsed, limit: memoryLimit, pct: pctOf(memoryUsed, memoryLimit) },
        user: { used: userUsed, limit: userLimit, pct: pctOf(userUsed, userLimit) },
        pinned: pinnedTotal,
        skills: skills.list().length,
      },
      limits: { memory: settings.memoryCharLimit, user: settings.userCharLimit },
      paths: {
        presets: presetsRoot,
        memoryTemplate: presetsRoot === '' ? '' : path.join(presetsRoot, '<助手id>', 'memory'),
        skillRoots: Array.isArray(skills.readRoots) ? [...skills.readRoots] : [],
        activityFile: sharedActivity?.file ?? '',
      },
      activity: activity.list(20),
      assistants,
    })
  })

  route('exact', '/hanako-memory/activity', async (req, res) => {
    const raw = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'))
    json(res, 200, { ok: true, activity: activity.list(Number.isFinite(raw) && raw > 0 ? raw : 50) })
  })

  /* ── 助手 ─────────────────────────────────────────────── */

  route('prefix', '/hanako-memory/assistants', async (req, res) => {
    const segments = segmentsAfter(pathnameOf(req), '/hanako-memory/assistants')

    if (segments.length === 0) {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, assistants: agents.list() })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        json(res, 200, { ok: true, assistant: agents.create({ name: body?.name, yuan: body?.yuan, description: body?.description }) })
        return
      }
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    const id = segments[0]
    if (req.method === 'GET') {
      json(res, 200, { ok: true, assistant: agents.get(id) })
      return
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const body = await readJsonBody(req)
      json(res, 200, {
        ok: true,
        assistant: agents.update(id, {
          name: body?.name,
          yuan: body?.yuan,
          description: body?.description,
          order: body?.order,
          memory: body?.memory,
          experience: body?.experience,
        }),
      })
      return
    }
    if (req.method === 'DELETE') {
      json(res, 200, { ok: true, ...agents.remove(id) })
      return
    }
    json(res, 405, { ok: false, error: 'method not allowed' })
  })

  /* ── 技能市场（腾讯 SkillHub CLI） ─────────────────────── */

  route('exact', '/hanako-memory/market/status', async (_req, res) => {
    json(res, 200, {
      ok: true,
      available: market !== undefined && market !== null && market.available(),
      bin: market !== undefined && market !== null ? String(market.bin ?? '') : '',
      skillsRoot: market !== undefined && market !== null ? market.skillsRoot : '',
    })
  })

  route('exact', '/hanako-memory/market/rankings', async (_req, res) => {
    if (market === undefined || market === null) {
      json(res, 503, { ok: false, error: 'market unavailable' })
      return
    }
    try {
      const data = await market.rankings()
      json(res, 200, { ok: true, ...data })
    } catch (error) {
      json(res, 502, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('exact', '/hanako-memory/market/search', async (req, res) => {
    if (market === undefined || market === null) {
      json(res, 503, { ok: false, error: 'market unavailable' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    try {
      const data = await market.search({
        query: url.searchParams.get('q') ?? '',
        limit: Number(url.searchParams.get('limit')) || 20,
      })
      json(res, 200, { ok: true, ...data })
    } catch (error) {
      json(res, 502, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('exact', '/hanako-memory/market/install', async (req, res) => {
    if (market === undefined || market === null) {
      json(res, 503, { ok: false, error: 'market unavailable' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = await readJsonBody(req)
    try {
      const result = await market.install({ slug: body?.slug, namespace: body?.namespace })
      activity.push({ kind: 'skills', ok: result.ok !== false, ops: 1, detail: 'install ' + result.slug + (result.namespace === '' ? '' : ' @' + result.namespace) })
      if (typeof notifySkillsChanged === 'function') notifySkillsChanged()
      json(res, 200, { ok: result.ok !== false, ...result })
    } catch (error) {
      activity.push({ kind: 'skills', ok: false, ops: 1, detail: 'install failed: ' + String(error?.message ?? error).slice(0, 120) })
      json(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  /* ── 人格（可自由创造） ───────────────────────────────── */

  route('prefix', '/hanako-memory/personas', async (req, res) => {
    if (personas === undefined || personas === null) {
      json(res, 503, { ok: false, error: 'persona store unavailable' })
      return
    }
    const segments = segmentsAfter(pathnameOf(req), '/hanako-memory/personas')

    if (segments.length === 0) {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, personas: personas.list() })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        try {
          json(res, 200, { ok: true, persona: personas.create(body ?? {}) })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    const id = segments[0]
    const action = segments[1] ?? ''

    if (action === 'duplicate') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      try {
        json(res, 200, { ok: true, persona: personas.duplicate(id, body?.label) })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }

    if (req.method === 'GET') {
      const persona = personas.get(id)
      if (persona === null) {
        json(res, 404, { ok: false, error: `persona ${JSON.stringify(id)} not found` })
        return
      }
      json(res, 200, { ok: true, persona })
      return
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req)
      try {
        json(res, 200, { ok: true, persona: personas.update(id, body ?? {}) })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    if (req.method === 'DELETE') {
      try {
        json(res, 200, { ok: true, persona: personas.remove(id) })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    json(res, 405, { ok: false, error: 'method not allowed' })
  })

  /* ── 洞察（Honcho 式派生结论） ─────────────────────────── */

  route('prefix', '/hanako-memory/insights', async (req, res) => {
    if (typeof insightsFor !== 'function') {
      json(res, 503, { ok: false, error: 'insight store unavailable' })
      return
    }
    const segments = segmentsAfter(pathnameOf(req), '/hanako-memory/insights')
    const agentId = segments[0] ?? ''
    if (agentId === '') {
      json(res, 400, { ok: false, error: 'agentId is required' })
      return
    }
    if (agents.get(agentId) === null) {
      json(res, 404, { ok: false, error: `assistant ${JSON.stringify(agentId)} not found` })
      return
    }
    const store = insightsFor(agentId)
    const insightId = segments[1] ?? ''

    if (insightId === '') {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, agentId, insights: store.list() })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        try {
          json(res, 200, { ok: true, insight: store.add(body ?? {}) })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    if (req.method === 'PUT') {
      const body = await readJsonBody(req)
      try {
        json(res, 200, { ok: true, insight: store.update(insightId, body ?? {}) })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    if (req.method === 'DELETE') {
      try {
        json(res, 200, { ok: true, insight: store.remove(insightId) })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    json(res, 405, { ok: false, error: 'method not allowed' })
  })

  /* ── 记忆 ─────────────────────────────────────────────── */

  route('prefix', '/hanako-memory/memory', async (req, res) => {
    const segments = segmentsAfter(pathnameOf(req), '/hanako-memory/memory')
    const agentId = segments[0] ?? ''
    const target = segments[1] ?? ''
    if (agentId === '') {
      json(res, 400, { ok: false, error: 'agentId is required' })
      return
    }
    // 面板写入只允许针对真实存在的助手：否则会给一个不存在的 id 造出孤立记忆目录。
    if (agents.get(agentId) === null) {
      json(res, 404, { ok: false, error: `assistant ${JSON.stringify(agentId)} not found` })
      return
    }
    const memory = memoryFor(agentId)

    if (req.method === 'GET') {
      const status = memory.status()
      if (target === '') {
        const rolling = {}
        for (const row of ROLLING_TARGETS) {
          rolling[row] = {
            chars: status[row]?.chars ?? 0,
            exists: status[row]?.exists === true,
            updatedAt: mtimeOf(memory.rollingFileFor(row)),
          }
        }
        const updatedAt = {}
        for (const row of RESIDENT_TARGETS) updatedAt[row] = mtimeOf(memory.fileFor(row))
        json(res, 200, { ok: true, agentId, status, pinned: memory.readPinned(), rolling, updatedAt })
        return
      }
      if (!RESIDENT_TARGETS.includes(target)) {
        json(res, 400, { ok: false, error: `target must be one of ${RESIDENT_TARGETS.join(', ')}` })
        return
      }
      json(res, 200, { ok: true, agentId, target, updatedAt: mtimeOf(memory.fileFor(target)), ...status[target] })
      return
    }

    if (req.method === 'POST' && target === 'rolling') {
      const body = await readJsonBody(req)
      const layer = String(body?.target ?? '').trim()
      if (!ROLLING_TARGETS.includes(layer)) {
        json(res, 400, { ok: false, error: `target must be one of ${ROLLING_TARGETS.join(', ')}` })
        return
      }
      const text = String(body?.text ?? '')
      const current = memory.readRolling(layer)
      const next = body?.action === 'append'
        ? (current.trim() === '' ? text.trim() : `${current.trim()}\n${text.trim()}`)
        : text
      const result = await memory.writeRolling(layer, next)
      activity.push({ kind: 'memory', agentId, target: layer, ok: true, ops: 1, detail: `rolling ${layer}: ${result.chars} 字符` })
      json(res, 200, { ok: true, ...result })
      return
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      const writeTarget = String(body?.target ?? target ?? '').trim()
      if (!RESIDENT_TARGETS.includes(writeTarget)) {
        json(res, 400, { ok: false, error: `target must be one of ${RESIDENT_TARGETS.join(', ')}` })
        return
      }
      const operations = Array.isArray(body?.operations)
        ? body.operations
        : [{ action: body?.action, content: body?.content, oldText: body?.oldText ?? body?.old_text }]
      const result = await memory.applyBatch(writeTarget, operations)
      activity.push({
        kind: 'memory',
        agentId,
        target: writeTarget,
        ok: result.success === true,
        ops: operations.length,
        detail: result.success === true
          ? String(result.usage ?? result.message ?? '')
          : String(result.error ?? '').slice(0, 160),
      })
      json(res, 200, { ok: result.success === true, ...result })
      return
    }

    json(res, 405, { ok: false, error: 'method not allowed' })
  })

  /* ── 置顶 ─────────────────────────────────────────────── */

  route('prefix', '/hanako-memory/pinned', async (req, res) => {
    const segments = segmentsAfter(pathnameOf(req), '/hanako-memory/pinned')
    const agentId = segments[0] ?? ''
    if (agentId === '') {
      json(res, 400, { ok: false, error: 'agentId is required' })
      return
    }
    const memory = memoryFor(agentId)
    if (req.method === 'GET') {
      json(res, 200, { ok: true, pinned: memory.readPinned() })
      return
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      const list = Array.isArray(body?.list) ? body.list : []
      const result = await memory.writePinned(list)
      activity.push({ kind: 'pinned', agentId, ok: result?.success !== false, count: list.length })
      json(res, 200, { ok: true, ...result })
      return
    }
    json(res, 405, { ok: false, error: 'method not allowed' })
  })

  /* ── 技能 ─────────────────────────────────────────────── */

  route('prefix', '/hanako-memory/skills', async (req, res) => {
    const segments = segmentsAfter(pathnameOf(req), '/hanako-memory/skills')

    if (segments.length === 0) {
      if (req.method === 'GET') {
        json(res, 200, {
          ok: true,
          roots: Array.isArray(skills.readRoots) ? [...skills.readRoots] : [],
          skills: skills.list().map(item => ({
            name: item.name,
            description: item.description,
            whenToUse: item.whenToUse,
            relativePath: item.relativePath,
            dir: item.dir,
            root: item.root,
            chars: Number(item.chars ?? 0),
            updatedAt: mtimeOf(item.file),
          })),
        })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const result = runSkillOperations(skills, body?.operations)
        activity.push({
          kind: 'skills',
          ok: result?.success !== false,
          ops: Array.isArray(body?.operations) ? body.operations.length : 1,
          detail: String(result?.error ?? result?.message ?? '').slice(0, 160),
        })
        json(res, 200, result)
        return
      }
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    const skillName = segments[0]
    const file = segments.slice(1).join('/')

    // 技能体检：只读诊断，给面板和 skill_audit 工具用
    if (skillName === 'audit' && file === '') {
      if (typeof auditSkills !== 'function') {
        json(res, 503, { ok: false, error: 'audit unavailable' })
        return
      }
      const audit = auditSkills(skills.list())
      json(res, 200, { ok: true, ...audit })
      return
    }


    if (req.method === 'GET') {
      const hit = skills.get(skillName, { file })
      if (hit === null) {
        json(res, 404, { ok: false, error: `skill ${JSON.stringify(skillName)} not found` })
        return
      }
      json(res, 200, { ok: true, ...hit })
      return
    }
    if (req.method === 'DELETE') {
      json(res, 200, { ok: true, ...skills.remove(skillName) })
      return
    }
    json(res, 405, { ok: false, error: 'method not allowed' })
  })
}
