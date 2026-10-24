/**
 * 写入活动日志（面板「最近活动」的数据源）。
 *
 * 为什么需要：Hermes / Hanako 的记忆面板都会回答「最近到底写了什么」。
 * 之前本插件的面板只有当前状态，没有时间维度 —— 用户看不出「谁在哪一轮改了哪个库」。
 *
 * 形态刻意做到最简：
 * - 内存里保留最近 {@link MAX_ENTRIES} 条（读快）
 * - 同时落盘一份 JSON 数组（重启后仍有历史，不会每次都变成空白）
 * - 任何 IO 失败都吞掉：日志坏掉绝不能影响记忆写入本身
 *
 * @module src/activity.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** 保留条数。面板一次展示 20–50 条，200 条足够回溯。 */
const MAX_ENTRIES = 200

export class ActivityLog {
  /**
   * @param {string} file 落盘路径（`<dshHome>/hanako-memory/activity.json`）
   */
  constructor(file) {
    this.file = file
    this.items = this._load()
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(item => item !== null && typeof item === 'object').slice(-MAX_ENTRIES)
    } catch {
      return []
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.items))
    } catch { /* 落盘失败不影响功能 */ }
  }

  /**
   * 记一条活动。
   *
   * @param {object} entry `{ kind: 'memory' | 'pinned' | 'skills', agentId?, target?, ok?, ... }`
   * @returns {object} 实际写入的记录（带 `at` 时间戳）
   */
  push(entry) {
    const record = { at: Date.now(), ...entry }
    this.items.push(record)
    if (this.items.length > MAX_ENTRIES) this.items = this.items.slice(-MAX_ENTRIES)
    this._persist()
    return record
  }

  /**
   * 最近的记录，新的在前。
   *
   * @param {number} limit
   */
  list(limit = 50) {
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_ENTRIES) : 50
    return this.items.slice(-size).reverse()
  }
}

export const __test = { MAX_ENTRIES }
