# dsh-hanako-memory

> ## ⚠️ 0.5 测试版（beta）
>
> **这是一个半成品，功能可用但边界还在动。** 已知状态见下方 [0.5 测试版状态](#05-测试版状态)：
> 面板 4 个 tab、助手=人格已合并、技能按助手分区、腾讯 SkillHub 市场只留了数据层。
> 出问题请提 [issue](https://github.com/simlerick/dsh-hanako-memory/issues)，附上 `~/.dsh/profiles/desktop/` 下的日志片段。


> **Hermes 的记忆纪律 + Honcho 的 peer 分层 + Hanako 的多智能体** —— 一个侧栏入口，管住你的助手、记忆和技能。

---

## 这是什么

三个参照系，各取所长：

| 来源 | 借鉴的核心 | 为什么值得借 |
|---|---|---|
| [**Hermes**](https://github.com/NousResearch/hermes-agent) （Nous Research 官方 agent） | 有界双库 `MEMORY.md` / `USER.md`、`§` 分隔、**字符**预算、batch 原子操作、冻结快照、漂移/不可读保护 | 这是长期实战磨出来的纪律，不是设计出来的 |
| [**Honcho**](https://github.com/plastic-labs/honcho) （7,748★） | Peer-centric 模型：用户与 agent 都是 peer；representation 低延迟快照；scope 界定召回 | 避免了「只有用户画像、没有 agent 自我」的偏差 |
| [**Hanako / HanaAgent**](https://github.com/liliMozi/openhanako) （6,833★） | **Agent 就是文件夹**：独立人格 / 记忆 / 会话；四「元」性格；`today/week/longterm/facts` 分层编译 | 多智能体隔离的干净做法 |

**一句话**：市场上有 279 个 memory 插件，但**没有一个是这个形状** —— 同时具备 Hermes 式有界双库、per-agent 隔离、以及可读写 skills 的，一个都没有。

---

## 三层记忆模型

```
L0  PINNED     置顶事实        永远注入，手工维护
L1  USER.md    用户画像        1,375 字符，慢变
L2  MEMORY.md  agent 笔记      2,200 字符，快变
─────────────── 以上常驻注入 ───────────────
L3  today.md   今日滚动摘要    按天编译
L4  week.md    本周综述        从 today 上卷
L5  longterm   长期综述        从 week 上卷
L6  facts.db   事实库（Phase 2）按需检索，不常驻
```

**为什么只常驻 L0–L2**：常驻内容每轮都进 context，必须小、必须稳定。L3–L6 按需检索。
这对应市场调研收敛出的读路径：**cheap always-on tier → search → evidence expansion**。

### 字符预算，不是 token

`§` 分隔符本身也算 3 个字符（`\n§\n`），这是 Hermes 的 `_char_count` 语义：

```python
def _char_count(self, target):
    return len(ENTRY_DELIMITER.join(self._entries_for(target)))
```

按字符而不是 token，意味着**跨模型稳定** —— 换模型不需要重新校准预算。

---

## 多智能体：每个对话一个助手

每个助手 = 一个 DSH 原生 preset 目录 + 一份独立记忆：

```
~/.dsh/.agent-presets/<id>/
├── agent.cordis.yml     # DSH 组合文件（由本插件生成）
├── preset.yml           # 展示元数据（name / yuan / order）
├── identity.md          # 可选：自定义人格
└── memory/              # ← 本插件新增：per-agent 隔离
    ├── MEMORY.md
    ├── USER.md
    ├── today.md / week.md / longterm.md
    └── pinned.json
```

**四个「元」**（Hanako 同名同义）：

| 元 | 意识块 | 气质 |
|---|---|---|
| `hanako` 小花 | MOOD（Vibe / Sparks / Reflections / Will） | 温柔、有主见，回答前先冒内心戏 |
| `butter` 黄油 | PULSE（Vibe / Echo / Read / Will） | 跳脱、直球，情绪起伏明显 |
| `ming` 明 | 沉思（Premise / Conduct / Reflection / Act） | 先厘清前提，再动手 |
| `kong` 空 | —— | 没有意识块，直接回答 |

切换助手 = 换一个 preset，**记忆、人格、会话全部跟着换**。

---

## Skill 读写：市场最缺的那一块

DSH 的 `ctx.skills` 是**只读注册表**（`registerProvider` / `register` / `list` / `get`），**没有写入 API**。

所以本插件把写入落到文件系统：

```
~/.dsh/skills/<name>/SKILL.md           ← 写入根（user-dsh）
~/.agents/skills/<name>/SKILL.md        ← 只读根（user-agents，兼容其他工具）
```

工具：

| 工具 | 用途 |
|---|---|
| `skill_list` | 列出全部技能（name + description） |
| `skill_view` | 读 SKILL.md 全文 + `linkedFiles` 清单 |
| `skill_manage` | `create` / `patch` / `write_file` / `remove_file` / `delete` |

### 一个必须知道的坑

**就地编辑 `SKILL.md` 不改变目录 mtime**，而 catalog 有 mtime 签名缓存 —— 所以写完可能「静默不生效」。

本插件的对策（三者都做）：
1. 写入后显式 `utimesSync` 父目录
2. 发 `skills/change` 事件
3. 新建技能时建新目录（天然改父目录 mtime）

---

## 安装

```bash
# 从本地目录安装
dsh plugin --profile desktop add link:/Users/simle/dsh/dsh-hanako-memory
```

装完重启 DSH。侧栏底部出现 🌸 **助手与记忆** 按钮（Settings 上方）。

---

## 面板

一个浮层，三个 tab：

- **助手** —— 卡片列表、四元选择、新建/编辑/删除、设为主助手
- **记忆** —— 双库用量条、条目增删改、置顶、滚动摘要状态
- **技能** —— 技能列表、展开看全文、附件清单

面板与模型工具**读写同一份存储**，两边永远一致。

---

## 工具 schema 的设计说明

`memory` 的 description 有四段，每段防一类真实误用：

- **WHEN** — 只记跨会话事实；任务中学会的东西去 skill
- **IF FULL** — 用**一个** batch 同时删旧+加新（否则满仓后永远写不进）
- **SKIP** — 临时进度、已完成工作、可重新发现的事实
- **TARGETS** — `memory` = 你的笔记；`user` = 用户画像

`skill_manage` 的 `operations` 用 **`anyOf` 分支**而不是扁平对象 —— 实测 27B 模型会把 `write_file` 的字段串进 `create`，导致整批回滚（Hermes issue #112677）。

---

## 为什么注入走 `agent/pre-step` 而不是 system prompt

`dsh-system-prompt` 的 `assemble()` 末尾（`lib/index.js:281`）：

```js
sections: completeSection === void 0 ? transformed.sections : [completeSection]
```

**只要某个 section 标了 `complete: true`（agent preset 可以这样宣告），waterfall 之后它会被还原成唯一的 section**，我们加的 section 全部消失。而且 `complete` 强制唯一，多个直接 throw。

所以：

| 通道 | 内容 | 理由 |
|---|---|---|
| `agent/pre-step` durable message | **记忆冻结快照** | 安全、可重放、可审计、压缩可见 |
| `system-prompt.section` | 身份 / 意识块 / 工具指引 | 会话内基本不变，不伤 cache |

注入写法照抄 DSH 官方的 `dsh-agent-instructions`（`lib/index.js:1271`）：
1. 先 `await next()`
2. `decision.kind === 'reject'` 时原样返回
3. `findLastIndex(m => messages.includes(m))` 定位 claimed 尾部
4. `toSpliced(index + 1, 0, injected)` 插入

---

## 安全设计

| 风险 | 对策 |
|---|---|
| 记忆进 system prompt，一条被污染的条目跨会话持久 | 写入前扫描注入模式；快照渲染时转义 `</system-reminder>` |
| 不可读文件被当成空文件，保存时抹掉记忆 | **拒绝写入**，明确告知 |
| 有人用 shell append 塞自由文本（无 `§` 分隔） | 检测「单条超过整库上限」→ 备份 `.bak.<ts>` 并拒绝 |
| 读到截断文件 | temp + rename 原子写 |
| 有损 UTF-8 解码被存回去 | 严格解码，失败即上报；剥掉 BOM |
| 并发写互相覆盖 | 单进程 promise 链串行化 |
| preset id 逃逸目录 | 严格正则 `^[a-z0-9][a-z0-9_-]{0,63}$` |
| skill 文件路径逃逸 | `path.resolve` 前缀校验 |
| 删除最后一个助手/默认助手 | 双重保护 |

---

## 开发

```bash
npm test    # 114 个用例
npm run check
```

测试分四层：
- `test/memory-store.test.js`（32）—— 数据安全、预算语义、匹配语义
- `test/agents.test.js`（22）—— 多智能体、目录结构、删除保护
- `test/skills.test.js`（30）—— frontmatter 契约、路径安全、缓存陷阱
- `test/tools.test.js`（19）—— schema 形状、参数规范化
- `test/integration.test.js`（11）—— 真实 apply() 端到端

---

## 与现成插件的对比

| | 本插件 | `DeepSeek-Harness-Hanako-Memory` | `dsh-hermes-memory`（社区 4 个） |
|---|---|---|---|
| 多智能体 | ✅ preset 落盘 | ✅ | ❌ |
| Hermes 有界双库 | ✅ | ⚠️ 有 Hana 记忆栈但不完全同形 | ✅ |
| **skill 读写** | ✅ | ❌ | ❌ |
| per-agent 记忆隔离 | ✅ | ✅ | ❌ |
| 注入走 pre-step（不用 systemPrompt） | ✅ | ❌ 用 `systemPrompt.section`，每轮 cache miss | 各异 |
| 测试数 | 114 | 150 | 不明 |

---

## License

MIT
