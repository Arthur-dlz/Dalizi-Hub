# 生产操作手册（OPERATIONS）

> 读者：本机用户本人 + 任何新任接续窗口（**不需要项目背景**）。
> 适用对象：本机 Windows 上的 **Dalizi Dispatcher V1** 生产部署。
> 需求与验收以 [`../v1-mcp-agent-dispatch-blueprint.md`](../v1-mcp-agent-dispatch-blueprint.md) 为唯一来源；技术实现映射见 [`../impl/IMPLEMENTATION.md`](../impl/IMPLEMENTATION.md)。
> 本手册只写经核实的事实。**PID 是时点值**，一律以 Status 脚本实测为准。
> 生成日期 2026-10-01，对应 HEAD `7a913e7`。

---

## 0. 一分钟速览

| 问题 | 答案 |
|---|---|
| 重启电脑后要手动做什么？ | **什么都不用做**。登录 Windows 即触发看门狗，自动拉起生产。 |
| 生产怎么启动？ | 交给看门狗（计划任务）。**绝不在 WorkBuddy 会话里手动 Start。** |
| 怎么确认活着？ | 跑 `Status-DaliziHubBridge.ps1`，看 `ready: true`（跑前先清代理四变量）。 |
| 平时怎么用？ | WorkBuddy Desktop 已连 `http://127.0.0.1:18490/mcp`，直接派任务即可。 |
| 出问题先看哪？ | 看门狗日志 `logs\watchdog-YYYYMMDD.log`，再跑 Status。 |

---

## 1. 这是什么

一句话：**一个跑在本机的「任务派发器」**——你在 WorkBuddy Desktop 里派一个任务，它把任务转交给本机的某个命令行 AI（WorkBuddy / Codex / Antigravity）去执行，并把执行进度和结果做成一张卡片回给你。

组件关系（全部在本机）：

```
WorkBuddy Desktop（你操作的客户端）
        │  http://127.0.0.1:18490/mcp  （Bearer 认证）
        ▼
   dispatcher  ──  node src/http-mcp-server.js，监听 127.0.0.1:18490
        │            （单实例、单任务；派发/查询/卡片三个工具）
        │ spawn（子进程）
        ▼
   WorkBuddy CLI  /  Codex CLI  /  agy CLI   ← 三个目标 CLI
        ▲
        │ 由 bridge 托管拉起、看门狗守护
   bridge（D:\1-WORK\agent\dalizihub-bridge\）
        ▲
        │ 守护
   Windows 计划任务 DaliziHubBridgeWatchdog（看门狗）
```

- **dispatcher**：核心。`node src/http-mcp-server.js`，只监听本机回环 `127.0.0.1:18490/mcp`，需 Bearer 认证（未授权请求返回 401）。由 bridge 托管（**dispatcher-only 形态**）。
- **bridge**：宿主/托管层，位于 `D:\1-WORK\agent\dalizihub-bridge\`。负责拉起 dispatcher、注入凭据、暴露进程状态。配置在 `config\bridge.json`（`mcpServerUrl`、`workbuddyCliPath`、`codexCliPath`、`tunnelDormant`）。
- **看门狗**：Windows 计划任务 `DaliziHubBridgeWatchdog`，常驻轮询 bridge 状态，发现 dispatcher 挂了就 `Stop → Start` 自愈。
- **tunnel**：公网通道组件，**当前休眠**（`tunnelDormant: true`，原因见 bridge 根目录 `TUNNEL-DORMANT.md`）。休眠是「有意停机保留」，不是死代码。
- **三个目标 CLI**：`workbuddy`（CodeBuddy CLI）、`codex`（独立固定副本）、`antigravity`（`agy`）。
- **端口**：固定 `127.0.0.1:18490`，仅本机可访问。

---

## 2. 重启后怎么拉起

### 2.1 自启机制（实测口径）

计划任务 `DaliziHubBridgeWatchdog`：

- **触发器**：`AtLogOn`（用户 **Arthur** 登录即触发）+ 一次性触发（登录后约 1 分钟起、**每 1 分钟重复**，作兜底重启）。
- **多实例策略**：`IgnoreNew`（常驻循环，拒绝重入，保证单实例）。
- **执行时限**：`PT0S`（无时限，常驻不退出）。
- **失败重启**：`RestartCount=999` / 每 1 分钟（看门狗自身崩溃会被任务计划重启）。
- **身份**：`Interactive` 登录令牌（**需该用户处于登录会话**；注销/未登录不跑，锁屏不影响）。
- **动作**：`bin\watchdog-launcher-v2.exe` 包裹 `pwsh scripts\Watch-DaliziHubBridge.ps1`。
- **看门狗内部循环**：每 **30s** 轮询一次 Status；连续 **3** 次失败才判定需恢复；恢复 = `Stop → Start → 轮询 ready（12×5s）`；10 分钟窗口内最多重启 **3** 次（60s 冷却），防抖动风暴。

### 2.2 结论：登录即自愈

**重启电脑后无需任何手动操作**——登录 Windows 即触发看门狗；若发现 dispatcher/bridge 缺席，看门狗会自动 `recovery_start` 拉起生产。

### 2.3 验证步骤

```powershell
# 先清代理四变量（否则 Get-HttpStatus 会吃到沙箱代理 → 404 假阴性）
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:http_proxy,Env:https_proxy -ErrorAction SilentlyContinue
pwsh D:\1-WORK\agent\dalizihub-bridge\scripts\Status-DaliziHubBridge.ps1
```

判据：输出 JSON 里 **`ready: true`**（含义 = dispatcher 已就绪且返回 401、tunnel 不在跑）。`dispatcherHttpStatus` 应为 `401`。

### 2.4 看门狗没起时的手动兜底

仅在确认看门狗任务未运行时才用：

```powershell
Enable-ScheduledTask -TaskName 'DaliziHubBridgeWatchdog'
Start-ScheduledTask  -TaskName 'DaliziHubBridgeWatchdog'
```

### 2.5 ⚠️ 连坐收割警告（两次实证付过学费）

**不要在 WorkBuddy 会话里直接跑 Start 脚本拉生产。** WorkBuddy 会话结束时，其进程树（job object）会把子进程**一起收割**——会话里拉起的 dispatcher 会随之死亡。**生产启动/重启一律交给看门狗**（Task Scheduler 上下文，不受会话退出影响）。

---

## 3. 生产怎么开始用

### 3.1 WorkBuddy Desktop 连接

在 WorkBuddy Desktop 添加 MCP 服务器：`http://127.0.0.1:18490/mcp`。Bearer 凭据由 bridge 侧注入（**用户侧已配置完毕**，通常无需改动）。卡片渲染走 MCP App resource `ui://dalizi-dispatcher/task-card.html`。

> 仅 **WorkBuddy Desktop** 已验收（蓝图 A1）；**其他 MCP 客户端未验收，不得宣称支持**。

### 3.2 派任务

工具：`dispatch_task(agent, project, task, model, effort?, request_id?)`

- `agent` ∈ `workbuddy` / `codex` / `antigravity`。
- `project` = 已注册 alias，或受控工作根目录下的唯一直接子目录。
- `request_id`（可选）：**自带幂等**——同 `request_id` + 同 payload 重放返回**同一个 job**；不同 payload 会被拒（`idempotency_conflict`）。
- 语义边界：**单实例同一时刻只跑一个任务**（忙时拒单）。

### 3.3 看状态 / 看卡片

- `get_task(job_id)`：查持久化任务记录。
- `render_task_card(job_id)`：渲染任务卡。卡片支持手动刷新、**长结果缩略/就地展开**（>500 字符或 >8 行才折叠）、自动刷新开关（**仅用户操作改变**，不会被新快照重置）。

### 3.3.1 使用协议（零代码约定，主控补笔 2026-10-01）

依据 `docs/handoff/PROGRESS-UX-FINDINGS-2026-10-01.md` 的发现 A/D，约定 agent 侧使用协议：

1. **派发即出卡**：`dispatch_task` 拿到 `job_id` 后**立即补一发 `render_task_card(job_id)`**——当前卡片按工具**入参**的 `job_id` 绑定，而 dispatch 的 job_id 在**返回**里，不补 render 就不会出卡（发现 D）。
2. **想实时看进度**：提醒用户在卡片上勾选「自动刷新(3秒)」——卡片默认不自动刷新（设计如此：开关只由用户操作改变，蓝图 A7），不勾就是渲染那一刻的"照片"（发现 A）。
3. **busy 拒单不是丢单**：第二单被 `dispatcher_busy` 拒绝属单任务语义（见 §6.1），等前一单终态后重派即可；用同一 `request_id`+同 payload 重试是安全的（幂等取回原 job）。

### 3.4 人工恢复（RECOVERY_REQUIRED）

当 dispatcher 无法确定某任务对应进程是否还在（崩溃恢复的「不确定态」）时，会标 `RECOVERY_REQUIRED`。**dispatcher 不会自动重跑**。人工核实后执行：

```powershell
npm run resolve-recovery -- --job <job_id> --confirm --evidence "<证据摘要>"
```

缺 `--confirm` 或 `--evidence` 会被直接拒绝；命令会写审计记录并释放占用。**前置条件：目标 owner 已停止。**

### 3.5 注册新项目目录

```powershell
npm run register-project -- --alias <别名> --cwd <目录>
```

---

## 4. 日常维护

### 4.1 配置变更标准流程（看门狗铁律，六步）

任何 `config\bridge.json` 变更（含换 CLI 路径、切 tunnel 模式）都按此流程，**不要在生产运行时直接改**：

1. **停看门狗**：`Disable-ScheduledTask -TaskName 'DaliziHubBridgeWatchdog'`，并杀掉正在跑的 `Watch-DaliziHubBridge.ps1` 循环进程（**杀前先核对该进程 CommandLine 身份**，避免误杀）。
2. **停生产**：`pwsh D:\1-WORK\agent\dalizihub-bridge\scripts\Stop-DaliziHubBridge.ps1`（只停记录在册、身份核验过的 PID）。
3. **改配置**：编辑 `config\bridge.json`，**改前先留 `.bak` 备份**（现有 `.bak-20261001`、`.bak-20261001-ops` 两例可参照命名）。
4. **恢复看门狗**：`Enable-ScheduledTask -TaskName 'DaliziHubBridgeWatchdog'` + `Start-ScheduledTask -TaskName 'DaliziHubBridgeWatchdog'`，让看门狗 `recovery_start` 拉起生产。
5. **验证**：按 §2.3 跑 Status，确认 `ready: true`。
6. 记录变更内容与时间（供后续追溯）。

> 凭据类变更（HTTP token / runtime key）走 `Set-R2-Secrets.ps1` 在**本机交互**执行；本手册不记录任何密钥内容。

### 4.2 codex 独立 CLI 升级

生产用的 codex 是**独立固定副本**（`D:\2-ruanjian\codex-standalone\`），**不随桌面版自动升级**（这正是它的意义——升级免疫）。升级方式：

```powershell
npm install -g "@openai/codex" --prefix "D:\2-ruanjian\codex-standalone" --no-fund --no-audit
```

装完按 §4.1 六步重启。当前生产路径（`config\bridge.json` → `codexCliPath`）指向该副本内的 `codex.exe`（0.159.3）。**兜底**：若该固定路径缺失，Start 脚本会退回到 `%LOCALAPPDATA%\OpenAI\Codex\bin` 下最新的 `codex.exe`，避免升级换目录导致每次重启失败。

### 4.3 agy（Antigravity）升级 / 换号注意

- **会自动升级**（1.2.11 → 1.2.14 实证）：就地替换二进制，并可能改写 `~/.gemini/antigravity-cli/settings.json`（含权限 allow/deny 规则）。**升级后留意权限规则是否被改动**。
- **调度器专用账号**：`jiangarthur110@gmail.com`（固定不轮换）。
- **换号**：删除 Windows 凭据管理器里的 Antigravity 条目后重新登录（agy CLI 无 `/auth` 命令）。

### 4.4 出口代理

agy / codex 子进程由 dispatcher 定向注入本机 Clash 代理 `127.0.0.1:7890`（见 `src/egress-proxy.js`）；**workbuddy 不注入**。

### 4.5 日志与台账位置

- bridge 日志：`D:\1-WORK\agent\dalizihub-bridge\logs\`（看门狗日志按日切分，如 `watchdog-20261001.log`；dispatcher 的 stdout/stderr 亦在此）。
- 看门狗重启历史：`D:\1-WORK\agent\dalizihub-bridge\run\watchdog-restarts.json`。
- dispatcher 任务台账：仓库 `.dispatcher-data\*.json`（每个 job 一份持久快照）。

---

## 5. 故障速查表

| 现象 | 先查什么 | 处置 |
|---|---|---|
| Status `ready: false` | Status JSON 各字段：`dispatcher` 是否 `owned`、`dispatcherHttpStatus` 是否 401、`port18490Owners` 是否有陌生 PID、`tunnel` 是否误起 | 若 dispatcher 缺席，等看门狗自愈（≤ 几分钟）；若端口被陌生进程占用，看门狗会 `recovery_blocked` 拒绝动手，需人工排查占用者 |
| Status 返回 **404 假阴性** | 是否在 WorkBuddy 会话里跑的 Status、代理四变量是否已清 | 跑 Status 前执行 `Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:http_proxy,Env:https_proxy`。看门狗在 Task Scheduler 干净环境运行，不受影响 |
| 卡片不渲染 | ①宿主 WorkBuddy Desktop 的 MCP Apps 入口门控（`mcpAppsEntryEnabled`）是否开启；②`render_task_card` 是否返回正确 resource URI/MIME | 打开宿主门控后重试；确认 MCP 服务器已连 `127.0.0.1:18490/mcp` |
| 状态 `RECOVERY_REQUIRED` | 任务对应进程是否真的还在 | 人工核实后按 §3.4 `npm run resolve-recovery` 解除（不会自动重跑） |
| dispatcher 疑似死亡 | **先看门狗日志** `logs\watchdog-YYYYMMDD.log`（`recovery_started` / `recovery_ready` / `recovery_blocked_*`） | 等看门狗自愈；**不要手动拉**（见 §2.5 连坐收割）。若日志显示 `recovery_blocked_ownership_*`，说明有身份冲突需人工介入 |
| 派任务被拒 | 是否已有任务在跑（busy）、`request_id` 是否与旧 payload 冲突（`idempotency_conflict`）、project 是否已注册 | 等当前任务结束 / 换 request_id / 先注册项目 |

---

## 6. 边界与长期项

**边界（现状即设计，不要误当缺陷）**：

- **单实例、单任务**：同一时刻只跑一个任务，忙时拒单。多项目并行 = 每项目一个独立状态目录的**独立 dispatcher 实例**。
- **tunnel 休眠**：公网通道有意停机保留；再启用步骤见 bridge 根 `TUNNEL-DORMANT.md`（改 `tunnelDormant: false` 后 Stop → Start → Status 验证 `tunnelHealthStatus/tunnelReadyStatus=200`）。
- **客户端范围**：仅 WorkBuddy Desktop 已验收；**三 CLI 之外的 MCP 客户端未验收，不得宣称支持**。
- **无取消工具**：dispatcher 终态只有 `COMPLETED` / `FAILED`；卡片里的 `CANCELLED` 渲染分支仅作防御保留（蓝图 §1:24 / §5:103）。

**长期项（已知、待办，非当前故障）**：

- bridge 独立版本化（当前与项目同仓维护）。
- agy `wall_duration_ms` 的 live 复验（随下次 agy canary 补）。
- codex standalone 与桌面版共享 `~/.codex` 的现状维持（不做隔离）。
