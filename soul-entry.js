/**
 * `dsh-hanako-memory/soul` —— preset 挂载入口。
 *
 * 每个助手 preset 的 `agent.cordis.yml` 会 `insert` 这一行：
 *
 * ```yaml
 * - insert:
 *     - id: hanako-soul
 *       name: 'dsh-hanako-memory/soul'
 *       config: {}
 * ```
 *
 * 它负责该 preset 的**身份 + 意识块 + 工具指引**。
 * 记忆快照不在这里 —— 那走 `agent/pre-step`（见根 index.js）。
 *
 * ## 为什么配置里能拿到自己的目录
 *
 * `dsh-agent-presets` 会给挂载的插件一个 per-preset 的 scope，插件可以从
 * `ctx.fiber.entry.options.id` / 环境变量推断当前 preset。但更可靠的做法是：
 * 把 preset 目录写进 config（`presets.generate` 时生成），
 * 这样即使宿主以后改了内部结构也不会错位。
 *
 * 回退顺序：
 * 1. `config.presetDir`（由本插件生成组合文件时写入）
 * 2. `DSH_HANAKO_PRESET_DIR` 环境变量
 * 3. 只有一个 preset 时猜它
 *
 * @module soul-entry.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installSoul } from './src/soul.js'

export const name = 'hanako-soul'

/** 不硬依赖任何服务：缺 systemPrompt 时静默降级。 */
export const inject = []

/** 插件配置。 */
/** 不导出 `Config` —— 理由同 index.js：普通对象会让 profile 整个 boot 失败。 */


function resolveDshHome() {
  const env = String(process.env.DSH_HOME ?? '').trim()
  return env !== '' ? env : path.join(os.homedir(), '.dsh')
}

/** 按回退顺序定位 preset 目录。 */
function resolvePresetDir(config) {
  if (typeof config?.presetDir === 'string' && config.presetDir.trim() !== '') return config.presetDir.trim()

  const env = String(process.env.DSH_HANAKO_PRESET_DIR ?? '').trim()
  if (env !== '') return env

  // 最后手段：只有一个 preset 时猜它（多助手场景不可靠，仅作兜底）
  const root = path.join(resolveDshHome(), '.agent-presets')
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => path.join(root, entry.name))
    if (dirs.length === 1) return dirs[0]
  } catch { /* 没有就不猜 */ }
  return ''
}

export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? console
  const presetDir = resolvePresetDir(config)
  if (presetDir === '') {
    logger.info?.('[hanako-soul] no preset directory resolved; only the tool guide section will be installed')
  }
  ctx.inject?.(['systemPrompt'], promptCtx => {
    installSoul(promptCtx, { presetDir, logger })
  })
}

