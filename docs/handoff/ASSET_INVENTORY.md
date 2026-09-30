# Asset inventory

本文件是代码定位索引。V1 需求和验收以 [`../v1-mcp-agent-dispatch-blueprint.md`](../v1-mcp-agent-dispatch-blueprint.md) 为唯一来源。

## 当前调用链

```text
MCP dispatch_task
  -> Dispatcher.dispatch
  -> validateDispatchInput + ProjectRegistry.resolve
  -> JobStore.create(QUEUED JSON)
  -> setImmediate(#execute)
  -> RUNNING + target Runner.run
  -> PID callback + runner waits for process close and parses output
  -> JobStore.update(terminal result)

MCP get_task / render_task_card
  -> Dispatcher.get -> JobStore.get
  -> JSON text + structuredContent

stdio entry ─┐
            ├─ createMcpServer + same Dispatcher
HTTP entry ─┘
```

## 模块、接口与缺口

| 资产 | 当前职责 / 证据 | 对 V1 的影响 |
|---|---|---|
| `src/contracts.js:18-50` | 校验 agent/project/task/model/effort；按目标 agent allowlist 检查模型；项目解析通过 registry seam。 | 新字段与兼容规则从蓝图契约增加；保持失败关闭和现有验证。 |
| `src/dispatcher.js:10-85` | 进程内 `activeJobId`；校验并解析项目，写 QUEUED 后异步执行，最终写状态、结果和诊断。 | busy 检查在异步项目解析前，存在并发准入窗口（`:21-27`）；无持久 claim、事件 reducer 或恢复。 |
| `src/job-store.js:13-51` | 每 job JSON 文件；临时文件再 rename；提供 create/get/update。 | `update` 为未串行化的 read-merge-write（`:38-42`）；并发心跳/事件写入需单一 reducer/apply seam，避免丢更新。 |
| `src/mcp-server.js:15-32,48-64,67-129` | 三个 MCP 工具 `dispatch_task/get_task/render_task_card`，一个 UI resource；集中模型 allowlist 和依赖组装。 | dispatch 当前无 `request_id`；get_task/render 共用读路径；不要把来源客户端标签当认证。 |
| `src/project-registry.js:67-135,191-205` | 读取可选 workspace roots；registry alias / 唯一 direct child；canonical path 和 root containment。 | V1 应沿用受控目标目录能力；不要增加任意 cwd 输入。 |
| `src/workbuddy-runner.js:23-95` | CodeBuddy 固定 Node 脚本、argv、shell false、隐藏窗口；聚合 stdout/stderr，等进程关闭后解析。 | 不是流式快照；需从实际安装版本事件开发实时 adapter 和真实 usage 映射。 |
| `src/codex-runner.js:7-23,68-127` | 可信绝对路径覆盖或 PATH `codex`；argv `exec -m … --json`；终态事件与退出码解析；未知 actual model 记为不可观测。 | 同样等 close 才解析；现有安全 executable 与 argv 约束应保留。 |
| `src/antigravity-runner.js:7-37,163-232` | 可信路径/默认 `agy`；`stream-json` parser；当前参数含 `--dangerously-skip-permissions`。 | 蓝图要求先核实并保留现行权限边界，不可借监控变更扩大或假设权限行为。 |
| `src/task-card.js:4-14`、`src/task-card.html:34-238` | 自包含 MCP App；展示持久快照；支持 host `tools/call get_task` 和 `window.openai.callTool` 回退；3 秒可选自动刷新。 | 行 157 每个快照都设置 `autoBox.checked = !terminal`，会覆盖用户关闭选择；真实 Desktop 宿主兼容尚未证实。 |
| `src/http-mcp-server.js:8-11,80-129` | HTTP MCP 固定 loopback `127.0.0.1:18490/mcp`，专用 Bearer token 环境变量、Origin 检查、请求体限制；复用 MCP server。 | 运行态一律按已观察证据描述；此源码事实不代表 Tunnel 已就绪。 |
| `src/antigravity-usage.js` | 解析账号额度信息。蓝图基线明确它不是单 job token usage（蓝图 `:37`）。 | 不能用账号额度替代每 job input/output/cache/speed。 |
| `test/*.test.js` | `node --test` 单元和 MCP 集成覆盖现有接口。 | 测试通过不能替代每 CLI 真样本、Windows 恢复/锁、WorkBuddy Desktop 和真实链路验收。 |

## MCP 与 transport 细节

- MCP schemas：`src/mcp-server.js:77-116`。`dispatch_task(agent, project, task, model, effort?)`；`get_task(job_id)`；`render_task_card(job_id)`。当前 dispatch 回执是 job id/status；读工具返回 JSON 文本和结构化 job。
- 项目目标限制：`src/contracts.js:18-43`；当前代码含 WorkBuddy、Codex、Antigravity。各模型 allowlist 在 `src/mcp-server.js:15-32`。
- stdio executable entry：`src/mcp-server.js:133-135`。HTTP 入口：`src/http-mcp-server.js:80-129`。两者使用同一 dispatcher/MCP 定义。
- 任务卡 resource URI/MIME：`src/task-card.js:4-14`；注册位置 `src/mcp-server.js:106-129`。

## 已知代码风险（源代码可复核）

1. **准入竞争：** `src/dispatcher.js:21-27` 在 await registry resolve 之前检查占用、之后才 claim `activeJobId`；并发请求可能同时通过检查。
2. **快照更新竞争：** `src/job-store.js:38-42` 每次 update 独立读改写，缺少顺序化。若增加 heartbeat/event writer，会有丢更新风险。
3. **无运行恢复：** 仅有内存 active id；启动时没有扫描/恢复非终态记录。持久 job 可读，不等于能确认旧进程或安全接管。
4. **没有实时过程视图：** 三个 runner 将输出累积到进程 close 后再 parse；没有逐事件当前步骤、owner 心跳或每 job usage 写回。
5. **自动刷新偏好覆盖：** `task-card.html:139-158` 的 `showTask` 对每个非终态快照重新勾选 auto-refresh。蓝图 A7 已将此列为需修复和验证的行为。
6. **状态终态差异：** dispatcher 只把 COMPLETED/FAILED 作为终态（`dispatcher.js:4`），而卡片还识别 CANCELLED（`task-card.html:65`）；当前无 cancel 工具/实现。

## README 漂移

`README.md` 自称 V0（第 1 行），dispatch 描述主要列 WorkBuddy/Codex（第 1–8 行），但源码已包括 Antigravity（`contracts.js:22-23`、`mcp-server.js:17-32`、`package.json:11`）。README 所说三个工具及 HTTP loopback/Bearer 约束仍与源码一致。README 的 UI 自动刷新描述不能被理解成 WorkBuddy Desktop 实际宿主兼容性已验收；蓝图明确该点尚未证实。
