# 任务卡「进度可见性」逻辑冒烟推演 —— 问题集（2026-10-01）

> **来源**：HUMAN 指令——「按 HUMAN 操作习惯，对本插件正常工作时的表现做逻辑推演冒烟，看会遇到什么问题、怎么表现、是否符合预期」。
> **提出窗口**：agent 窗口（本窗口）。**收件方：主控窗口（kimi）评审 / 排期。**
> **性质**：纯推演，**未改动任何代码**；结论基于本会话 3 次真实派发 + 源码事实。
> **对应 HEAD**：`7a913e7`（工作区另有 OPS2 未提交产物，见文末）。
> **唯一需求源**：`docs/v1-mcp-agent-dispatch-blueprint.md`（本文不新增需求，只报缺口）。

---

## 0. 一句话结论

插件在"正常工作"（基础设施全绿）时，**功能面基本符合预期**——诚实展示、崩溃恢复不确定态、幂等、长结果缩略、多项目隔离都到位。但**「显性看进度」这一体感存在 6 处落差**，其中 **2 处最关键**：

- **A：卡片默认不自动刷新**（是"照片"不是"直播"）
- **D：出卡依赖 agent 每次自觉调用**（无机制强制"派发即出卡"）

---

## 1. 场景矩阵（按 HUMAN 操作习惯）

| # | 场景 | 预期 | 实际会怎么表现 | 判定 |
|---|---|---|---|---|
| 1 | 单发单看（如"让反重力看 WXMP 未提交"） | 卡片实时滚进度 | 卡弹出，但**自动刷新默认关** → 定格在渲染那一刻；须用户手动勾「自动刷新(3秒)」才滚动 | ⚠️ 缺口（A） |
| 2 | 连派两单（HUMAN 多窗口并行习惯） | 并行 / 排队 | 第二单被 `dispatcher_busy` **直接拒**，无排队；同项目内无法并行 | ⛔ 结构限制（B） |
| 3 | 长任务离开再回 | 回来看到最新进度 | 默认不刷新 → 回来是旧快照；若关了会话，**卡消失**（任务仍在 bridge 托管下跑） | ⚠️ 缺口（A+E） |
| 4 | 重启 / 断电 | 明确提示、不瞎猜 | `RECOVERY_REQUIRED`，卡上写清不确定态 + `resolve-recovery` 指引，不自动重跑 | ✅ 符合 |
| 5 | 换网 / 断网（笔记本公司↔家） | 失败可见 | agy/codex 走 Clash `127.0.0.1:7890`，断则 CLI 失败 → `FAILED` + error 字段 | ✅ 基本符合（错误不够直白） |
| 6 | 同任务重试 | 复用不重跑 | 同 `request_id`+同 payload → 取回原 job；改 payload → `idempotency_conflict` | ✅ 符合（有认知门槛） |
| 7 | 结果很长（报告类） | 能看全 | >500 字符 / 8 行自动缩略，点「展开全文」 | ✅ 符合（T4ux） |
| 8 | 命令类任务（`git status` 等） | 能跑 | agy 未授权命令 → 软拒 → `FAILED`（`antigravity_missing_terminal_result`），**看着像 bug** | ⚠️ 缺口（C） |
| 9 | 派发后忘了出卡 | 自动出卡 | 无卡（`dispatch_task` 不带 UI 资源指针） | ⚠️ 缺口（D） |

---

## 2. 横切发现（跨场景结构性表现）

### A. 卡片是"照片"不是"直播"（最关键）
`src/task-card.html:61` 的「自动刷新」复选框**默认未勾选**；`:215` `updateAuto()` 仅在 `autoBox.checked` 为真时才起 3s 定时器。→ 不勾选时卡片**只显示渲染那一刻的快照**。
> 注：这是 A7 的设计意图（开关只由用户改变，不被新快照强制打开），但与"显性看进度"的直觉有落差。

### B. 单任务语义 vs 并行习惯（结构张力）
`src/dispatcher.js:158` `if (this.activeJobId) throw new DispatcherError("dispatcher_busy", ...)`。→ **无排队**，第二单直接失败。
> 并行只能靠"每项目独立状态目录的独立实例"，但当前生产只有 `127.0.0.1:18490` **一个入口**；同项目内并行不可能。HUMAN 的"多窗口并行"习惯在本插件里会表现为"第二单石沉大海"。

### C. 权限类失败伪装成 runner 错误
agy headless（`-p`）对需确认的工具**软拒**（实测日志：`Print mode: soft-denying tool confirmation "RunCommand"`），最终落成 `antigravity_missing_terminal_result`。→ 用户会误判为插件故障，实则是 **agy 权限面**（无命令白名单），**与出卡无关**。

### D. 出卡依赖 agent 自觉（最关键）
`src/mcp-server.js:118` 仅 `render_task_card` 带 `_meta: { ui: { resourceUri } }`；`dispatch_task`/`get_task` 无。且卡片绑定逻辑读的是 **tool-input 的 `job_id`**（`task-card.html:391`），而 `dispatch_task` 入参**没有 job_id**（job_id 是其输出）。→ **"派发即自动出卡"在当前卡片设计下做不到**，必须由 agent 显式补一发 `render_task_card(job_id)`。

### E. 卡片生命周期绑会话
卡随窗口/会话消失；任务本身不受影响（bridge 托管、独立于 WB 会话）。

### F. 进度是定性非定量
卡上给的是「当前活动 / 已运行 / 心跳 / 用量」，**没有百分比或"第几步/共几步"**。CLI 不吐步骤总数，所以"进度条"类期望天然落空。

---

## 3. 期望符合性判定

| 维度 | 判定 |
|---|---|
| 诚实展示（不伪造进度/结果/心跳） | ✅ 符合 |
| 崩溃恢复不确定态（RECOVERY_REQUIRED 不自动重跑） | ✅ 符合 |
| 幂等（request_id 复用 / conflict 拒单） | ✅ 符合 |
| 长结果缩略与就地展开 | ✅ 符合 |
| 多项目隔离（跨项目读写受控） | ✅ 符合 |
| **"显性看进度"体感** | ⚠️ **缺口**（A / D 为主，B/C/E/F 为辅） |

---

## 4. 给主控的决策请求

| # | 问题 | 建议最小改法（仅供评估，未动手） | 代价 |
|---|---|---|---|
| Q1 | 是否修 **A**（默认不刷新）？ | 卡片默认勾选自动刷新；或对"派发场景"特判 | 改 `task-card.html` + 测试 |
| Q2 | 是否修 **D**（派发即出卡）？ | 让卡片支持从 **dispatch 的 tool-result** 认领 `job_id`（现仅认 tool-input），实现"派发即出卡" | 改 `task-card.html` + 测试（方案 B） |
| Q3 | **B**（单任务 vs 并行）是否排期？ | 多项目=多实例多端口（如 WXMP 18491 / TH9320 18492…） | 部署/配置面，非代码 |
| Q4 | **C**（权限失败信息）是否加可读提示？ | 在卡/回执对 `*_missing_terminal_result` 加"疑似工具未授权"提示 | 改 runner/卡片文案 |

> 亦可**先固化协议**（零代码）：agent 每次「dispatch → 立即 render_task_card」并提示用户勾选自动刷新。**立即生效**，但依赖 agent 自觉（不解决 D 的根）。

---

## 5. 附：本会话实证证据（可复核）

| job_id（前缀） | agent | 结果 | 证据要点 |
|---|---|---|---|
| `75eedb55` | antigravity | FAILED | `antigravity_missing_terminal_result`；agy 日志 `soft-denying "RunCommand"`；exit_code 0 |
| `55ea110f` | antigravity | COMPLETED | 加 WXMP 读白名单后 `view_file` 成功，真读到 WXMP/PROJECT.md |
| `c08d04a3` | antigravity | COMPLETED | 读 `.workbuddy/...` 被拒，如实报告 `Matches user-configured deny rule` |

源码锚点：`dispatcher.js:158`（busy）、`task-card.html:61/215`（默认不刷新）、`mcp-server.js:118`（仅 render 带 `_meta.ui`）、`task-card.html:391`（卡片按 tool-input 的 job_id 绑定）。

## 6. 工作区状态说明（供主控合入时参考）

- 本推演**未产生代码改动**；仅新增本文件。
- 工作区另有 OPS2 未提交产物：`README.md`(改) + `docs/handoff/OPERATIONS.md`(新) + `docs/impl/cards/OPS2-readme-v1-operations-manual.md`(未跟踪)，以及主控并行的 `docs/impl/COMMANDER-RUNBOOK.md`(改)。
- agy 配置变更（本会话演示所致）：`~/.gemini/antigravity-cli/settings.json` 的 allow 追加了 `read_file(D:\1-WORK\1-gongzuoqu\WXMP)`；备份 `settings.json.bak-20261001-demo`。
