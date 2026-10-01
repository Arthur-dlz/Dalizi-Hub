# ⚠️ 已退役（2026-10-01）

> **本文件已退役，不再作为接续入口。请勿据以作业。**
>
> - **退役日期：** 2026-10-01
> - **退役原因：** 本文件所述的候选分支、基线 HEAD、测试数与验收状态**已全部过时，且与 V1 竣工现状完全相反**（原文称 A1–A8「尚未完成验证/真实验收」、`npm test` 63 pass、HEAD `87e42ec9`、branch `fix/new-pc-local-recovery-r1`、蓝图 SHA256 `6B4C7306…`；实际 V1 已竣工，A1–A8 全绿，`npm test` 176/176 pass，HEAD `0ecc963`，蓝图 SHA256 `048BB68F…C01662`）。
> - **权威入口（以此为准）：**
>   - 生产运维规程：[`../impl/COMMANDER-RUNBOOK.md`](../impl/COMMANDER-RUNBOOK.md)
>   - 主控交接：[`../impl/HANDOFF-2026-10-01-commander.md`](../impl/HANDOFF-2026-10-01-commander.md)
>   - 需求与验收：[`../v1-mcp-agent-dispatch-blueprint.md`](../v1-mcp-agent-dispatch-blueprint.md) §11
>   - 竣工盘点：[`V1-POST-CLOSEOUT-INVENTORY-2026-10-01.md`](V1-POST-CLOSEOUT-INVENTORY-2026-10-01.md)
> - **明确警示：** 下文为 **2026-09 历史快照**，其中的 **HEAD、分支名、测试数、验收状态均不得据以作业**。
> - **死链/续做指引纠正：** 下文「五分钟阅读顺序」中 [`VERIFY_AND_CONTINUE.md`](VERIFY_AND_CONTINUE.md) 亦已同步退役；「当前不可声称的事项」中「A1–A8 尚未按蓝图完成验证/真实验收」的表述已作废。下方正文原样保留，仅供历史回溯。

---

# V1 refactor handoff: start here

> 给下一位 Agent 的五分钟接手入口。本文是导航和交接事实，不是第二份需求文档。

## 权威来源与候选状态

- **唯一需求源：** [`../v1-mcp-agent-dispatch-blueprint.md`](../v1-mcp-agent-dispatch-blueprint.md)。它记录已确认范围、模块接口、A1–A8 验收和未决项；实现时以它为准，不在本交接包复制或改写需求。
- **检查到的候选：** branch `fix/new-pc-local-recovery-r1`，HEAD `87e42ec9acabe54327aa532df4fa54a05bd541ef`。
- **未跟踪蓝图校验：** `docs/v1-mcp-agent-dispatch-blueprint.md` SHA256 `6B4C7306CDADB341FB64AD0B97BEED5E63B3DDAC0D720688F5C96262E2440816`。HEAD 与蓝图 hash 一起识别本次交接候选；若任一变化，先重新核对候选和蓝图内容，再继续。
- **保留工作树状态：** `.workbuddy/`、蓝图文件及 `experiments/chatgpt-task-card-poc/poc-server.pid` 是现有未跟踪资产。请保留原处，不打开、不复制、不清理，也不要把它们误当作本次交接包内容。
- **本地基线测试：** 协调者报告本候选 `npm test` 为 63 pass、0 fail，约 3.1 秒。这只是源码测试结果；不能证明真实 CLI、Bridge、WorkBuddy Desktop 或端到端验收通过。本次交接文档编写未重跑测试。

## 五分钟阅读顺序

1. 本文件：候选状态、先读路径和当前安全边界。
2. [`ASSET_INVENTORY.md`](ASSET_INVENTORY.md)：已实现模块、调用路径、缺口与 README 漂移。
3. [`VERIFY_AND_CONTINUE.md`](VERIFY_AND_CONTINUE.md)：安全只读起步、分阶段续做建议和验证边界。
4. 蓝图第 2、3、4、5、6、7、8、10、11 节，特别是验收矩阵 A1–A8（蓝图约第 24–219 行）。不要以这里的概述取代原文。

## 从哪里进入代码

- 调度核心：`src/dispatcher.js:10-85`
- MCP tool schema 和模块组装：`src/mcp-server.js:48-135`
- job 持久化：`src/job-store.js:13-51`
- runner 契约的现状：`src/workbuddy-runner.js:23-95`、`src/codex-runner.js:68-127`、`src/antigravity-runner.js:163-232`
- 卡片：`src/task-card.html:56-238`；已知自动刷新开关问题在 `:139-158`
- 项目解析：`src/project-registry.js:67-205`
- stdio 与 HTTP 入口：`src/mcp-server.js:133-135`、`src/http-mcp-server.js:80-129`

## 当前不可声称的事项

V1 蓝图已形成设计交付，仓库也已有 Dispatcher、runner、MCP tools 和任务卡等构件；A1–A8 尚未按蓝图完成验证/真实验收。当前代码还没有 request_id 幂等、跨进程执行 claim/恢复、实时活动与心跳、单 job token/cache/速度指标。WorkBuddy Desktop 内手动刷新和 MCP Apps 桥接兼容性仍需实际宿主验收。

运行态必须如实限定：stdio `npm start` 和 HTTP loopback `127.0.0.1:18490/mcp` 是仓库入口/配置事实；协调者本轮报告 unauthenticated GET 返回 401。Dispatcher 状态文件读取遇到 access denied；Tunnel ready 与 watchdog 状态没有证据。**不得据此宣称 Bridge、Tunnel 或 watchdog 健康。** Bridge 外部项目根是 `D:\1-WORK\agent\dalizihub-bridge`；那里及 `scripts/Bridge-Common.ps1` 等仅供后续按需查看的资产路径，不在本交接文档写入或改动范围。

## 写入边界

此 handoff 只新增 `docs/handoff/START_HERE.md`、`ASSET_INVENTORY.md`、`VERIFY_AND_CONTINUE.md`。后续 Agent 应先核实当前候选与工作树，再按蓝图推进；不要覆盖上述未跟踪工作或触碰凭据、全局配置、外部 Bridge 状态。
