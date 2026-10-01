# OPS2：README 漂移消除 + 《生产操作手册》编写（运维文档卡）

阶段：运维文档 ｜ 依赖：V1 整体收官（HEAD `7a913e7`）｜ 并行：可与任何卡并行（纯文档，不碰代码）｜ 状态：待施工
来源：盘点报告据实判定「README 漂移未消除」（自称 V0、全篇无 Antigravity）+ 用户要求沉淀生产操作知识（重启拉起/日常使用/维护），项目不烂尾。

---

## ⛔ 红线（先读本节再动手；违反 = 返工 + 纪律留档）

1. **禁止触碰 `.workbuddy/` 目录（含其下所有文件，含 `memory/`）——工作日志由主控撰写，你只负责回传。已有三个窗口因写此目录被记过。**
2. 只允许修改/新建「拥有文件」列出的 **2 个**文件，其余一切文件只读。
3. 禁止 `git commit` / `git push` / 任何 git 写操作。
4. 禁止启动、停止、重启任何服务或进程；**禁止执行 `D:\1-WORK\agent\dalizihub-bridge\` 下任何脚本**（含 Status/Start/Stop）；禁止 `schtasks` 写操作（`Get-ScheduledTask` 等只读系统查询允许）。
5. 禁止读取 `secrets/`、凭据、token、环境变量中的密钥。
6. **bridge 目录只读白名单（本卡特许，超范围即越界）**：允许读 `D:\1-WORK\agent\dalizihub-bridge\` 下的 `scripts\*.ps1`（**`Set-R2-Secrets.ps1` 除外，禁读**）、`TUNNEL-DORMANT.md`、`config\release.json`、`config\bridge.json`。**禁止读 `run\` 目录下任何文件**（含 token/隧道 URL 风险）；禁止读 `.bak` 以外任何可能含凭据的文件；白名单外一律不碰。
7. 回传只写事实；做不成的写 `NOT_PROVEN` 或 `BLOCKED`，**禁止编造成功叙事**（前车之鉴：T6 窗口因编造开工基线被记纪律 FAIL）。手册内容凡未经卡内锚点或你亲自读码/读文件核实的，禁止写入。
8. **开工第一步（未做=回传拒收）**：执行 `git status --porcelain` 和 `node --test --test-concurrency=1`，把输出原文贴进回传的「开工基线」一节。当前正确基线 = HEAD `7a913e7`、工作区干净、**176/176**。若你的基线不是这个，**停止施工并立即回传 BLOCKED**。
9. **本卡是文档卡：禁止改动任何代码/测试语义。README 与手册中的技术表述必须与源码/配置事实一致，禁止夸大（尤其：不得宣称 WorkBuddy Desktop 以外的 MCP 客户端已支持）。**

## 拥有文件（单写者）

- `README.md`（改）
- `docs/handoff/OPERATIONS.md`（**新建**）

其余全部只读。蓝图 `docs/v1-mcp-agent-dispatch-blueprint.md` **本卡不动**（需求唯一来源，仅可引用）。

## 目标

1. **README 漂移消除**：把 README 从 V0 口径刷到 V1 收官现状——它是仓库门面，当前自称 V0 且无 Antigravity，会误导每一个新读者。
2. **《生产操作手册》（OPERATIONS.md）**：让「重启后怎么拉起 / 生产怎么开始用 / 日常怎么维护 / 出问题查哪里」成为有据可查的文档，而不是只存在于主控记忆里。读者 = 用户本人 + 任何新任接续窗口（不要求有项目背景）。

## 现状锚点（主控已核实，可直接引用；你施工前仍须按红线许可范围抽查复核）

### 生产形态（今日实测口径）

- dispatcher：`node src/http-mcp-server.js`，`127.0.0.1:18490/mcp`，Bearer 认证（未授权请求 http 401 实证）；由 bridge 托管（dispatcher-only 形态）；当前 PID 29116（**手册中须注明"以 Status 脚本实测为准"，PID 是时点值**）。
- bridge：`D:\1-WORK\agent\dalizihub-bridge\`；`config\bridge.json` 关键键：`mcpServerUrl`、`workbuddyCliPath`、`codexCliPath`（现=standalone 真 exe：`D:\2-ruanjian\codex-standalone\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`，0.159.3，SHA256 `57E1BDAB…05A7`）、`tunnelDormant: true`。配置改动留 `.bak`（现有 `.bak-20261001`、`.bak-20261001-ops` 两例）。
- tunnel：**休眠**（`tunnelDormant=true`，ChatGPT App 侧弃用；再启用路径见 bridge 根 `TUNNEL-DORMANT.md`）。

### 重启后拉起（主控今日亲验计划任务 XML）

- 计划任务 `DaliziHubBridgeWatchdog`：**LogonTrigger（用户 Arthur 登录即触发）+ TimeTrigger（约 2 分钟轮询）**；`MultipleInstancesPolicy=IgnoreNew`（常驻循环，拒重入）；`ExecutionTimeLimit=PT0S`（无时限）；`RestartOnFailure`（看门狗自身崩溃会被任务计划重启）；InteractiveToken（**需该用户登录会话**，注销/未登录不跑，锁屏不影响）；动作=`bin\watchdog-launcher-v2.exe` 包裹 `pwsh scripts\Watch-DaliziHubBridge.ps1`。
- **结论：重启后无需手动操作——登录 Windows 即触发看门狗，发现 bridge/dispatcher 缺席会自动 recovery_start 拉起生产**。验证手段 = 跑 Status 脚本看 `ready: true`（注意下条代理坑）。

### 生产变更铁律（两次实证付过学费，手册必须原样收录）

- **生产启动/重启只交给看门狗**：在 WorkBuddy 会话里跑 Start 拉起的 dispatcher，会随会话进程树退出被连坐收割（job object，两次实证）。标准变更流程 = ①Disable-ScheduledTask + 杀掉 `Watch-DaliziHubBridge.ps1` 循环进程（杀前核 CommandLine 身份）→ ②Stop 脚本 → ③改配置（留 .bak）→ ④Enable-ScheduledTask + Start-ScheduledTask 让看门狗 recovery_start → ⑤Status 验证 ready。
- **在 WB 会话里跑 Status 脚本前先清代理四变量**：`Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:http_proxy,Env:https_proxy`——`Get-HttpStatus` 走 legacy HttpWebRequest 吃代理，沙箱代理会导致 404 假阴性（看门狗在 Task Scheduler 干净环境运行不受影响）。

### 日常使用

- WorkBuddy Desktop 连接：`http://127.0.0.1:18490/mcp`（Bearer 由 bridge 侧注入，用户侧已由主控配置完毕；卡片渲染走 MCP App resource `ui://dalizi-dispatcher/task-card.html`）。
- 派任务：`dispatch_task(agent, project, task, model, effort?, request_id?)`——agent ∈ `workbuddy`/`codex`/`antigravity`；project = 已注册 alias 或受控目录；**request_id 自带幂等**（同 request_id+同 payload 重放返回同 job，不同 payload 拒单 `idempotency_conflict`）。
- 看状态/看卡：`get_task(job_id)` / `render_task_card(job_id)`；卡片支持手动刷新、长结果缩略/就地展开（500 字符/8 行阈值）、自动刷新开关（仅用户操作改变）。
- **RECOVERY_REQUIRED（崩溃恢复不确定态）**：dispatcher 不会自动重跑，人工确认后用 `npm run resolve-recovery -- --job <job_id> --confirm --evidence "<证据摘要>"` 解除（写审计记录）。
- 注册新项目目录：`node scripts/register-project.js --alias <名> --cwd <目录>`（canary 脚本实证用法）。
- 语义边界：**单实例单任务**（busy 拒单）；多项目并行 = 每项目独立状态目录的独立 dispatcher 实例；三 CLI 之外的 MCP 客户端**未验收、不得宣称**。

### 维护项

- **codex standalone 升级**：固定副本不自动升级（这正是它的意义）；升级 = 重跑 `npm install -g "@openai/codex" --prefix "D:\2-ruanjian\codex-standalone" --no-fund --no-audit` 后按铁律流程重启；桌面版自动升级从此与生产无关。
- **agy（Antigravity）**：会自动升级（1.2.11→1.2.14 实证），就地替换二进制且可能改写 `~/.gemini/antigravity-cli/settings.json`；调度器专用账号=`jiangarthur110@gmail.com`（固定不轮换）；换号 = 删 Windows 凭据管理器 Antigravity 条目后重登。
- **agy 出口**：agy/codex 子进程由 dispatcher 定向注入 Clash 代理 `127.0.0.1:7890`（`src/egress-proxy.js`）；workbuddy 不注入。
- 日志：bridge `logs\` 目录（看门狗日志按日切分，如 `watchdog-20261001.log`）；dispatcher job 台账 = 仓库 `.dispatcher-data\*.json`。

### README 现状（主控已核实）

- 第 1 行 `# Dalizi Dispatcher V0`；agent 描述只列 WorkBuddy/Codex；**全篇无 "antigravity"**（grep 零命中）；三工具与 HTTP loopback/Bearer 约束描述与源码一致（可保留）；卡片 CANCELLED 渲染描述与源码一致（可保留，但注意：dispatcher 不产生 CANCELLED 态，蓝图 §5:103，属防御渲染）。

## 施工要求

### README.md（改）

1. 标题/自述刷为 V1（收官态）；agent 列表补 `antigravity`（顺序与 `src/mcp-server.js:17-34` allowlist 一致）；测试口径 `176/176`（`node --test --test-concurrency=1`）。
2. 补「生产运行」与「文档入口」段：入口指向 = 蓝图（需求与验收）、`docs/handoff/OPERATIONS.md`（生产操作）、`docs/impl/COMMANDER-RUNBOOK.md`（主控规程）、`docs/handoff/ASSET_INVENTORY.md`（代码索引）、`docs/impl/IMPLEMENTATION.md`（技术文档）、`docs/handoff/V1-POST-CLOSEOUT-INVENTORY-2026-10-01.md`（竣工盘点）。
3. 保留仍属实的段落；最小改动，不重排无关内容；**禁止**写"支持任意 MCP 客户端"等未验收表述；WorkBuddy Desktop 兼容性可写「已验收（蓝图 A1）」。

### docs/handoff/OPERATIONS.md（新建）

按以下骨架成文（标题可微调，内容必须全覆盖；所有技术表述以上述锚点或你亲自核实的文件为准）：

1. **这是什么**：一段大白话 + 组件关系（bridge 托管 dispatcher / 看门狗守护 / tunnel 休眠 / 三 CLI / 端口 18490）。
2. **重启后怎么拉起**：自启机制（LogonTrigger 实况）→「登录即自愈」结论 → 验证步骤（Status ready）→ 看门狗未起时的手动兜底（Enable+Start 计划任务）→ 连坐收割警告（为什么不要在 WB 会话里手动 Start）。
3. **生产怎么开始用**：Desktop 连接 → 派任务（含 request_id 幂等说明）→ 看卡片 → 人工恢复（resolve-recovery）→ 注册新项目。
4. **日常维护**：配置变更标准流程（看门狗铁律六步）→ codex standalone 升级 → agy 升级/换号注意 → 日志与台账位置。
5. **故障速查表**：ready=false / Status 404 假阴性（代理四变量）/ 卡片不渲染（`mcpAppsEntryEnabled` 门控）/ RECOVERY_REQUIRED 处置 / dispatcher 疑似死亡（先看门狗日志，别手动拉）。
6. **边界与长期项**：单任务语义、多项目多实例、tunnel 休眠与再启用指针、不得宣称其他客户端、长期项（bridge 独立版本化 / agy wall_duration_ms live 复验 / CODEX_HOME 共享维持现状）。

## 测试与证据

1. 文档卡无代码改动：开工基线与回传前各跑一次 `node --test --test-concurrency=1`，**必须均为 176/176**（证明零代码触碰）。
2. README 中每条技术表述须在源码有出处（agent allowlist、三工具、Bearer/loopback）；回传附 `git diff README.md` 原文与 OPERATIONS.md 全文行数。

## 验收

主控四件套：git status 只许 2 个文件（1 改 1 新）；亲跑全量 176/176；grep 在码（README 的 V1/antigravity/176 口径、手册的铁律流程/LogonTrigger/standalone 路径/resolve-recovery）；红线核查（含 `.workbuddy/` mtime 扫描与 bridge 只读白名单遵守）。

## 回传格式

```
RESULT=PASS|FAIL|PARTIAL|BLOCKED
开工基线=<git status 原文 + 测试计数原文>
改动文件=<清单>
测试计数=<开工与完工各一次，必须均为 176/176>
改动摘要=<README 改了哪几段 / OPERATIONS.md 骨架六节各一两句>
证据=<git diff README.md 原文；OPERATIONS.md 行数；bridge 白名单内读过的文件清单>
锚点复核=<卡内锚点抽查结果：符/不符（至少抽查 5 条）>
遗留风险=<没有就写"无">
```
