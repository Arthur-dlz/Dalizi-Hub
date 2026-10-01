# ⚠️ 已退役（2026-10-01）

> **本文件已退役，不再作为续做入口。请勿据以作业。**
>
> - **退役日期：** 2026-10-01
> - **退役原因：** 本文件所述的候选分支、基线 HEAD、测试数与验收状态**已全部过时，且与 V1 竣工现状完全相反**（原文称预期候选 HEAD `87e42ec9`、branch `fix/new-pc-local-recovery-r1`、`npm test` 63 pass、A1–A8「尚未按蓝图完成验证/真实验收」；实际 V1 已竣工，A1–A8 全绿，`npm test` 176/176 pass，HEAD `0ecc963`）。
> - **权威入口（以此为准）：**
>   - 生产运维规程：[`../impl/COMMANDER-RUNBOOK.md`](../impl/COMMANDER-RUNBOOK.md)
>   - 主控交接：[`../impl/HANDOFF-2026-10-01-commander.md`](../impl/HANDOFF-2026-10-01-commander.md)
>   - 需求与验收：[`../v1-mcp-agent-dispatch-blueprint.md`](../v1-mcp-agent-dispatch-blueprint.md) §11
>   - 竣工盘点：[`V1-POST-CLOSEOUT-INVENTORY-2026-10-01.md`](V1-POST-CLOSEOUT-INVENTORY-2026-10-01.md)
> - **明确警示：** 下文为 **2026-09 历史快照**，其中的 **HEAD、分支名、测试数、验收状态均不得据以作业**。
> - **续做指引纠正：** 下文「按蓝图推进的切片」与「暂不可接受为 PASS 的项目」所列待办与验证边界，在 V1 竣工后已不适用；接续工作请改按上方权威入口。

---

# Verify and continue

所有开发范围、接口、优先级和验收均由 [`../v1-mcp-agent-dispatch-blueprint.md`](../v1-mcp-agent-dispatch-blueprint.md) 决定。本文件只记录安全接手顺序和便于恢复工作的切片。

## 接手时的只读检查

在仓库根目录执行以下只读命令，确认候选和当前工作树；不要读取 `.workbuddy/`、PID 文件、本机 credential、Bridge token 或其他 secret 内容：

```powershell
git rev-parse HEAD
git branch --show-current
git status --short
rg --files src test docs
rg -n "activeJobId|async dispatch|async update|registerTool|function showTask|autoBox.checked|MAX_CAPTURED_OUTPUT_BYTES" src test
```

预期交接候选为 HEAD `87e42ec9acabe54327aa532df4fa54a05bd541ef`、branch `fix/new-pc-local-recovery-r1`。工作树未跟踪 `.workbuddy/`、蓝图以及 `experiments/chatgpt-task-card-poc/poc-server.pid` 均须保留；不要把它们复制进交接目录。若 live 状态不符，先保留当前状态并重新确认交接对象，不要 reset/clean/stash/checkout。

上面的读取只用于代码和 Git 元信息盘点。不要运行 `npm start`、`npm run start:http`、canary 命令、服务启停、安装/更新、真实 CLI 作业或任何会变更运行态/产生外部副作用的命令。仓库命令清单见 `package.json:6-13`。

## 已知验证证据及边界

- 协调者本轮报告：候选源码 `npm test` 为 **63 pass、0 fail，约 3.1 秒**。这是源码测试，不代表真实 CLI/Bridge 行为；本文件作者没有重跑测试。
- 协调者报告未认证 HTTP GET 得到 **401**。它只证明被探测的 HTTP 请求被拒绝，不能证明认证成功路径、MCP 请求全链路或外部 tunnel 可达。
- 状态读取 `run/dispatcher.json` 遇到 access denied；Tunnel ready 和 watchdog 状态未证实。不能报告 Bridge/Tunnel/watchdog 健康。
- stdio `npm start` 和 HTTP `127.0.0.1:18490/mcp` 是代码入口与配置；不代表当前进程已启动。
- 蓝图明确 A1–A8 尚未按蓝图完成验证/真实验收（`../v1-mcp-agent-dispatch-blueprint.md:213-219`）。源码测试/mock/UI fixture 不能代替真实 WorkBuddy Desktop、CLI 版本样本、Windows 锁与恢复验证。

## 按蓝图推进的切片

保持 blueprint 定义的顺序和关卡；以下仅是定位提示，不授权改动蓝图范围之外的资产：

1. **P0 宿主能力 / A1：** 先按蓝图只读确认可用的 Desktop/CLI/Bridge 版本和能力，再以授权的真实 Desktop 操作验证卡片资源渲染与按钮通过 MCP host bridge 调 `get_task(job_id)`。不要用 mock 或发送聊天刷新替代。
2. **P1 身份与持久执行 / A2、A5、A6：** 在 dispatcher admission、JobStore 写入 reducer、request_id 幂等和实例/执行 claim 之间定义小接口；解决 await 窗口和并发快照写入。用测试覆盖重复请求、冲突、并发/双 owner 与崩溃窗口；未知进程身份必须保留占用并进入恢复待确认状态。
3. **P2 实时 adapter / A3、A4：** 分 CLI 实现增量事件解析、活动/心跳、真实 usage 字段和终态证据。先获取安装版本的脱敏样本，语义不明字段保存 null/不可观测；账号额度不可冒充 job usage。
4. **P3 卡片 / A1、A7：** 修复用户关闭自动刷新后被快照重新开启的问题；对同一 job 的 revision 防旧响应；查询失败保留上次成功快照并允许重试。真实宿主验收仍必要。
5. **P4 受控端到端 / A8：** 只在相应执行授权和 canary 项目准备好后，对每个启用 CLI 做一项受控任务，并记录候选版本、job id、进程/CLI 证据、结果与不可观测项。真实作业不要当作只读验证。

## 暂不可接受为 PASS 的项目

- 当前 coordinator 提供的 `npm test` 结果不验证启动/恢复、已安装 CLI、Bridge、Desktop Apps 资源能力或完整端到端。
- Unauthorized HTTP GET 401 不能证明有效 bearer 请求；运行时 secret 不应放入交接文件、命令行输出或截图。
- `run/dispatcher.json` 状态访问被拒绝，Tunnel ready / watchdog 未证实。不得依据旧记忆或路径存在推断当前运行态。
- A1–A8 维持尚未按蓝图完成验证/真实验收状态，直到满足蓝图逐项证据；不可因静态代码检查、单元测试或过去的 canary 汇报跳过当前候选的验收。
