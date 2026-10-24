/**
 * 修复 session 日志里「没有 id 的消息」。
 *
 * 背景：宿主的 `dsh-session` 校验器（`assertMessageEventShape`）要求每条
 * `user/message` 事件的 `data` 本身带非空 string `id`：
 *
 * ```js
 * const message = type === 'user/message' ? record : record?.['message']
 * if (typeof message['id'] !== 'string' || message['id'] === '')
 *   throw new Error(`${subject} lacks an identified message`)
 * ```
 *
 * 我们的 hanako-memory 插件曾在 `agent/pre-step` 注入快照时漏了 `id`（已修），
 * 于是这些 session 一旦被重新加载（例如热重启后 resume）就整份判为 corrupt，
 * 界面表现为「历史加载失败：stored session ... is corrupt」，随后自动开一个新
 * 报错会话。本脚本给这些历史记录补上 id，并把日志重新压成一个 zstd frame。
 *
 * 用法：
 *   node tools/repair-session-ids.mjs --dry-run        # 只检查
 *   node tools/repair-session-ids.mjs                  # 修 + 备份
 *   node tools/repair-session-ids.mjs --dir <sessions 根目录>
 *
 * 安全：改动前把原文件备份成 `session.v4.jsonl.zstd.bak-<时间戳>`；校验不通过不写。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MESSAGE_TYPES = new Set(['developer/message', 'system/message', 'user/message', 'assistant/message', 'tool/result'])
const ROLE_BY_TYPE = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/** 把一个 zstd 拼接文件按 frame 解开（store 是每批 append 一个 frame）。 */
export function readFrames(buf) {
  const starts = []
  let cursor = 0
  while (true) {
    const hit = buf.indexOf(MAGIC, cursor)
    if (hit === -1) break
    starts.push(hit)
    cursor = hit + 4
  }
  const chunks = []
  for (let i = 0; i < starts.length; i++) {
    const slice = buf.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buf.length)
    chunks.push(zlib.zstdDecompressSync(slice))
  }
  return Buffer.concat(chunks)
}

/** 按宿主的规则校验一条事件；返回问题列表（空 = 通过）。 */
export function validateEvent(event, index) {
  const problems = []
  const type = event?.type
  if (!MESSAGE_TYPES.has(type)) return problems
  const data = event.data
  const record = typeof data === 'object' && data !== null ? data : undefined
  const message = type === 'user/message' ? record : record?.message
  if (typeof message !== 'object' || message === null) {
    problems.push(`seq ${event.seq}/#${index}: ${type} 没有 message 对象`)
    return problems
  }
  if (typeof message.id !== 'string' || message.id === '') problems.push(`seq ${event.seq}/#${index}: ${type} 缺 id`)
  if (message.role !== ROLE_BY_TYPE[type]) problems.push(`seq ${event.seq}/#${index}: ${type} role 应为 ${ROLE_BY_TYPE[type]}，实际 ${message.role}`)
  const source = message.source
  if (typeof source !== 'object' || source === null || typeof source.kind !== 'string' || source.kind === '') {
    problems.push(`seq ${event.seq}/#${index}: ${type} 的 source 非法`)
  }
  if (!Array.isArray(message.content)) problems.push(`seq ${event.seq}/#${index}: ${type} 的 content 不是数组`)
  if (type === 'tool/result' && typeof source === 'object' && source !== null) {
    if (source.kind !== 'tool') problems.push(`seq ${event.seq}/#${index}: tool/result 的 source.kind 应为 tool`)
    if (typeof source.callId !== 'string' || source.callId === '') problems.push(`seq ${event.seq}/#${index}: tool/result 缺 source.callId`)
    if (message.toolCallId !== source.callId) problems.push(`seq ${event.seq}/#${index}: tool/result 的 toolCallId 与 source.callId 不一致`)
  }
  return problems
}

/** 给缺 id 的消息补一个 uuid；返回 { events, patched }。 */
export function patchEvents(events) {
  let patched = 0
  for (const event of events) {
    if (!MESSAGE_TYPES.has(event?.type)) continue
    const holder = event.type === 'user/message' ? event.data : event.data?.message
    if (holder === undefined || holder === null) continue
    if (typeof holder.id === 'string' && holder.id !== '') continue
    holder.id = randomUUID()
    patched += 1
  }
  return { events, patched }
}


/** 猜 DSH 的 sessions 根目录：`~/.dsh/sessions/<cwd 转义名>`，优先选会话最多的那个。 */
function pickSessionsRoot() {
  const base = path.join(os.homedir(), '.dsh', 'sessions')
  if (!fs.existsSync(base)) return base
  const dirs = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory())
  if (dirs.length === 0) return base
  let best = base
  let bestCount = -1
  for (const dir of dirs) {
    const full = path.join(base, dir.name)
    const count = fs.readdirSync(full, { withFileTypes: true }).filter(entry => entry.isDirectory()).length
    if (count > bestCount) { bestCount = count; best = full }
  }
  return best
}

function listSessionFiles(root) {
  const out = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, 'session.v4.jsonl.zstd')
    if (fs.existsSync(file)) out.push({ id: entry.name, file })
  }
  return out
}

function processSession(file, { dryRun }) {
  const buf = fs.readFileSync(file)
  const text = readFrames(buf).toString('utf8')
  const lines = text.split('\n').filter(line => line !== '')
  const events = []
  const malformed = []
  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line))
    } catch {
      malformed.push(index)
    }
  }
  const before = events.flatMap((event, index) => validateEvent(event, index))
  const { patched } = patchEvents(events)
  const after = events.flatMap((event, index) => validateEvent(event, index))
  if (patched === 0 && before.length === 0 && malformed.length === 0) return { file, patched: 0, before, after, malformed, written: false }
  if (after.length > 0 || malformed.length > 0) {
    return { file, patched, before, after, malformed, written: false, skipped: '修完仍有问题，未写入' }
  }
  if (!dryRun) {
    const backup = file + '.bak-' + Math.floor(Date.now() / 1000)
    fs.copyFileSync(file, backup)
    const body = events.map(event => JSON.stringify(event)).join('\n') + '\n'
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(body, 'utf8')))
  }
  return { file, patched, before, after, malformed, written: !dryRun }
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const dirIndex = args.indexOf('--dir')
  const sessionsRoot = dirIndex !== -1
    ? path.resolve(args[dirIndex + 1])
    : pickSessionsRoot()
  if (!fs.existsSync(sessionsRoot)) {
    console.error('sessions 目录不存在：' + sessionsRoot)
    process.exit(2)
  }
  const files = listSessionFiles(sessionsRoot)
  console.log(`扫描 ${files.length} 个 session（${sessionsRoot}）${dryRun ? ' [dry-run]' : ''}`)
  let touched = 0
  let totalPatched = 0
  for (const { id, file } of files) {
    let result
    try {
      result = processSession(file, { dryRun })
    } catch (error) {
      console.log(`  ✗ ${id}: 读不了（${String(error?.message ?? error)}）`)
      continue
    }
    if (result.patched === 0 && result.written === false && result.before.length === 0 && result.malformed.length === 0) continue
    touched += 1
    totalPatched += result.patched
    const flag = result.written ? '已修' : (result.skipped ?? '无需修')
    console.log(`  • ${id}: 补 id ${result.patched} 条，修前后问题 ${result.before.length} → ${result.after.length}，坏行 ${result.malformed.length} [${flag}]`)
    if (result.after.length > 0) console.log('    仍未通过：' + result.after.slice(0, 3).join(' | '))
  }
  console.log(`完成：涉及 ${touched} 个 session，共补 ${totalPatched} 条 id${dryRun ? '（dry-run 未写入）' : ''}`)
}

main()
