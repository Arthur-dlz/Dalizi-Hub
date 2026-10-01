# Asset inventory

本文件是代码定位索引。V1 需求和验收以 [`../v1-mcp-agent-dispatch-blueprint.md`](../v1-mcp-agent-dispatch-blueprint.md) 为唯一来源。

> **最后核对：2026-10-01，对应 HEAD `0ecc963`（main）。V1 已竣工（A1–A8 全绿），`npm test` = 176/176 pass（17 个测试文件）。**
> 本索引已按 V1 实际实现刷新，下文行号均以该 HEAD 源码为准；凡未亲自核实的点显式标注"未核实"。

## 当前调用链

```text
启动路径（stdio 或 HTTP 任一入口）
  -> createDispatcherFromEnvironment
  -> Dispatcher.initialize（单飞 promise）：实例锁 acquire -> 幂等索引 load/rebuild -> scanRecovery 恢复扫描
  -> 完成后才对外提供工具

MCP dispatch_task
  -> Dispatcher.dispatch -> #enqueueAdmission（单一 async mutex 串行准入链 #admission）
  -> #admit 区间内：validateDispatchInput + resolveProject（校验 / 项目解析）
  -> request_id 幂等查表（hit 取回原 job；conflict 拒绝）-> busy 检查 -> 置 activeJobId
  -> JobStore.create(QUEUED 快照) -> 幂等索引 append
  -> setImmediate(#execute)

#execute（在准入区间之外）
  -> 选择 runner（workbuddy / codex / antigravity）
  -> JobStore.update(RUNNING + execution_state=claimed + claim 证据)   ← claim 持久化前置于 spawn
  -> JobStore.update(spawning) -> 建 per-job 事件 sink + owner 心跳（5s）
  -> runner.run 内 spawn（shell:false, windowsHide:true）
  -> onStarted：JobStore.update(pid, running, claim) + 进程身份探针补 claim.child_start_time
  -> runner emit 事件 -> sink 补 job_id/单调 seq -> JobStore.apply（per-job FIFO 串行 reducer 落盘）
     事件 kind：started / activity / usage / heartbeat / result / error
  -> runner 返回后终态收敛：buildCompletionEvidence -> JobStore.get -> JobStore.update(终态 + completion_evidence)

MCP get_task / render_task_card（共用同一 jobTool 读路径）
  -> Dispatcher.get -> JobStore.get
  -> JSON 文本 + structuredContent（卡片经宿主 tools/call get_task 轮询刷新）

stdio entry ─┐
            ├─ createDispatcherFromEnvironment + createMcpServer（同一 Dispatcher 实例与工具定义）
HTTP entry ─┘
```

## 模块、接口与缺口

> 第三列由"规划语态"改为"V1 落地状态"，逐行按 HEAD `0ecc963` 源码核对。

| 资产 | 当前职责 / 证据 | V1 落地状态 |
|---|---|---|
| `src/contracts.js:16,41-86` | 校验 agent（workbuddy/codex/antigravity，`:45`）/project/task/model/effort；按目标 agent allowlist 检查模型；antigravity 由模型后缀推导 tier 并拒绝冲突 effort（`:54-68`）；request_id 格式校验（`:16,33-39`）；项目解析经 registry seam（`:81-86`）。 | 已实现：三 agent 契约、request_id、antigravity effort-tier 规则均已落地；保持失败关闭与 allowlist。 |
| `src/dispatcher.js:65-341` | `#admission` 单一 async mutex 串行准入链（`:66`）；`initialize` 单飞（锁→索引重建→恢复扫描，`:99-121`）；`#admit` 区间内校验/解析/幂等/busy/建 job（`:140-198`）；`#createEventSink` 补 job_id + 单调 seq（`:205-236`）；`#execute` claim 前置 spawn（`:265-271`）、心跳与事件共享同一 reducer seam、终态写 completion_evidence（`:308-325`）。 | 已实现：V0 的"检查与 claim 之间 await"并发窗口被串行准入链闭合；无旁路直写快照。 |
| `src/job-store.js:200-345` | 每 job JSON 文件；临时文件 + rename（`renameWithRetry` 抗瞬态 EPERM/EBUSY，`:25-37`）；create/get/update；per-job FIFO 串行链 `#queues`（`:201,329-337`）；`apply` reducer 入口（`:266-278`）；遗留 `update` 亦走同一 seam（`:244-262`）；`listNonTerminal`（`:304-307`）。 | 已实现：read-merge-write 已串行化，丢更新风险闭合；快照 schema_version 恒 2（`:8`）。 |
| `src/mcp-server.js:17-34,71-146` | 三个 MCP 工具 `dispatch_task/get_task/render_task_card` + 一个 UI resource；集中三 agent 模型 allowlist（`:17-34`）；dispatch schema 已含 request_id（`:92`）；get/render 共用 `jobTool` 读路径并返回 structuredContent（`:46-48,74-121`）；stdio 启动路径（`:138-146`）。 | 已实现：request_id 契约、三 agent allowlist、读工具共用路径落地；不要把来源客户端标签当认证。 |
| `src/project-registry.js:62-65,102-135,191-207` | `ProjectRegistry.resolve` 读取可选 workspace roots；registry alias / 唯一 direct child；canonical path 与 root containment。 | 已实现：沿用受控目标目录能力；未增加任意 cwd 输入。 |
| `src/workbuddy-runner.js:15-26,127-284` | CodeBuddy 固定 Node 脚本、argv、shell:false、隐藏窗口；`emit` 逐事件输出（`:135-155`）；tool_use → activity（`:192-194`）；usage 字段映射（`:15-26`）。 | 已实现：由"等 close 再解析"改为流式 emit；usage 映射落地，WB 真样本校准仍标注 pending（源码 `:11-12` 自述）。 |
| `src/codex-runner.js:11,171-199,230-388` | 可信绝对路径覆盖或 PATH `codex`；argv `exec -m … --json --skip-git-repo-check`（`:302`）；事件流 emit（`:239-291`）；终态事件与退出码解析；未知 actual model 记为 NOT_OBSERVABLE（`:11,132`）。 | 已实现：事件流与 verdict 落地；安全 executable 与 argv 约束保留。 |
| `src/antigravity-runner.js:199-232,273-434` | 可信路径/默认 `agy`；`stream-json` parser；argv `-p … --output-format stream-json --model … --effort …`（`:347`），**已不含 `--dangerously-skip-permissions`**（依据 `docs/impl/agy-permission-decision.md §4`，源码注释 `:342-346`）。 | 已实现：权限边界按决策文档落定（不加 skip-permissions，越权显式失败），未扩大权限。 |
| `src/task-card.js:4-14`、`src/task-card.html:76,201-217,411-415` | 自包含 MCP App；展示持久快照；支持 host `tools/call get_task` 与 `window.openai.callTool` 回退；3 秒可选自动刷新。 | 已修复：`:202` `!isTerminal && autoBox.checked`、`:215` 尊重用户关闭、`:411-415` 开关仅由用户操作改变；真实 Desktop 宿主兼容仍未证实。 |
| `src/http-mcp-server.js:8-11,80-129` | HTTP MCP 固定 loopback `127.0.0.1:18490/mcp`，专用 Bearer token 环境变量、Origin 检查、请求体限制；复用 MCP server（`:84`）。 | 已实现：与 stdio 共用同一 dispatcher/工具定义；此源码事实不代表 Tunnel 已就绪。 |
| `src/antigravity-usage.js:1-39` | `parseAntigravityUsage` 解析 agy 账号额度分组。 | 保留约束：账号额度 ≠ 单 job token usage，不能用它替代每 job input/output/cache/speed。 |
| `test/*.test.js` | `node --test` 单元与 MCP 集成覆盖现有接口。 | 已落地：176/176 pass（17 文件）；但仍不能替代每 CLI 真样本、Windows 恢复/锁与真实链路验收。 |

## MCP 与 transport 细节

- MCP schemas：`src/mcp-server.js:82-121`。`dispatch_task(agent, project, task, model, effort?, request_id?)`；`get_task(job_id)`；`render_task_card(job_id)`。dispatch 回执是 job id/status/request_id；读工具返回 JSON 文本和结构化 job。
- 项目目标限制：`src/contracts.js:41-79`；当前代码含 WorkBuddy、Codex、Antigravity（`:45`）。各模型 allowlist 在 `src/mcp-server.js:17-34`。
- stdio executable entry：`src/mcp-server.js:138-146`。HTTP 入口：`src/http-mcp-server.js:80-129`。两者使用同一 dispatcher/MCP 定义。
- 任务卡 resource URI/MIME：`src/task-card.js:4-14`；注册位置 `src/mcp-server.js:122-134`。

## 已知代码风险（源代码可复核）

> 原 6 条为 V1 施工**前**诊断。逐条按 HEAD `0ecc963` 复核现状：

1. **准入竞争 → 已闭合。** `src/dispatcher.js:66` `#admission = Promise.resolve()` 单一 async mutex 串行准入链；`#enqueueAdmission`（`:134-138`）把 lookup→busy→create→置占用全部纳入区间；claim 在 spawn 之前持久化（`src/dispatcher.js:265-271`，先写 RUNNING+claimed 再 `runner.run`）。并发请求不再可能同时通过检查。
2. **快照更新竞争 → 已闭合。** `src/job-store.js:201` `#queues` + `#enqueue`（`:329-337`）per-job FIFO 串行链；事件经 `apply` reducer（`:266-278`）、遗留 `update` 亦走同一 seam（`:244-262`）；所有写入统一走临时文件 + rename（`:339-344`）。V0 的独立 read-merge-write 已消除。
3. **无运行恢复 → 已实现。** `src/recovery.js:81` `scanRecovery`；`classifyRecovery` 决策表（`:22-57`）把存活进程判为 `RECOVERY_REQUIRED + execution_state=running`（`:92-97`）、身份不可读判为 `RECOVERY_REQUIRED + execution_state=unknown`（`:98-104`）；自动路径永不 kill 未知进程、永不自动重跑。
4. **无实时过程视图 → 已实现（A3）。** dispatcher 建 per-job 事件 sink（`src/dispatcher.js:205-236`），runner 逐事件 `emit`（`src/workbuddy-runner.js:192-194`、`src/codex-runner.js:289-290`、`src/antigravity-runner.js:334-335`），`activity` 经 reducer 落到快照（`src/job-store.js:141-152`）；owner 心跳 5s 同 seam（`src/dispatcher.js:241-243,278-281`）。
5. **自动刷新偏好覆盖 → 已修复（A7）。** `src/task-card.html:202` 仅在 `!isTerminal && autoBox.checked` 时启用；`updateAuto`（`:214-217`）在用户关闭后停止计时器；`:411-415` 注释与代码确认"自动刷新开关仅由用户操作改变"。
6. **状态终态差异 → 属蓝图范围外设计边界，非缺陷。** 蓝图 §1 非目标（`:24`）列"取消/审批产品…不在范围内"；蓝图 §5（`:103`）明确"V1 无取消路径：现有卡片 CANCELLED 渲染分支（`task-card.html:65`）仅作防御渲染保留，dispatcher 不产生该状态，不新增取消工具"。卡片识别 CANCELLED（`src/task-card.html:76`），dispatcher 终态集为 COMPLETED/FAILED（`src/dispatcher.js:7`）——与蓝图一致。注：蓝图 §8 实为"安全与权限"（`:170-178`），未含取消条目；该边界原文依据是 §1 `:24` 与 §5 `:103`。

## README 漂移

亲自核对 `README.md`（HEAD `0ecc963`）现状：第 1 行仍自称 **"Dalizi Dispatcher V0"**；dispatch 的 agent 描述仍只列 WorkBuddy/Codex（第 9–10 行），**全篇未出现 Antigravity**（grep 无命中），而源码已支持 antigravity（`src/contracts.js:45`、`src/mcp-server.js:19-34`、`package.json:11` 有 `canary:antigravity`）。README 已含三工具、HTTP loopback/Bearer 约束与卡片 CANCELLED 描述（第 63–90 行），与源码一致。

**结论：README 漂移未消除**（"自称 V0"与"缺 Antigravity"两项仍在）。README 的 UI 自动刷新描述仍不能被理解成 WorkBuddy Desktop 实际宿主兼容性已验收；蓝图明确该点尚未证实。
