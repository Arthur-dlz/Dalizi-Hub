# AGY（Antigravity runner）权限策略决策记录

状态：**已拍板（2026-09-29 选项 C）＋已执行完毕（2026-09-30 T3c：分支1 实锤落地，见 §6）** ｜ 创建：2026-09-29（T2 施工产出）｜ 消费方：T3c（antigravity adapter，以其结论为输入）

> 本文件只记录现状、选项与影响分析，不替用户做决定。T3c 在施工前必须回读本文件的用户拍板结论；未拍板前 T3c 不得改动权限 flag 行为。

## 1. 现状（证据）

- `src/antigravity-runner.js` 第 177 行（AntigravityRunner.run 的 argv）：

  ```js
  const args = ["-p", task, "--output-format", "stream-json", "--model", model, "--effort", effort, "--dangerously-skip-permissions"];
  ```

- 该 flag 在 V0 既有代码中即存在（基线 commit `d346d6f` 起），不是本次监控改造引入的授权扩大。
- `--dangerously-skip-permissions` 的效果：AGY CLI 跳过工具使用的交互式权限确认，实现无人值守运行。
- 蓝图 §8 约束（v1.2）：不能因为监控改造扩大权限，也不能静默删除后假定无交互运行仍然成功；需要交互时明确报告限制，不建设自动批准流程。

## 2. 选项与影响分析

| 选项 | 描述 | 影响 |
|---|---|---|
| **A. 保留现状** | 继续 `--dangerously-skip-permissions` | ✅ 无交互运行可靠，canary/生产路径不变；❌ AGY 任务在项目目录内拥有无确认的工具执行权（文件写、命令执行等），权限面大于 WB/Codex 路径；与"最小权限"原则存在张力 |
| **B. 直接移除** | 删除该 flag，无替代 | ✅ 权限面最小；❌ 无人值守任务大概率在首个权限确认点挂起（stdin 为 `ignore`，无法交互），表现为超时/无输出失败；违反"静默删除后假定无交互运行仍然成功"的禁止项，除非明确接受 AGY 无人值守路径不可用 |
| **C. 替代机制** | 使用 AGY 官方提供的非交互授权机制（如配置化的权限模式/白名单/审批文件，具体以安装版本文档为准），逐项授权所需工具 | ✅ 兼顾无人值守与最小权限；❌ 需要实证安装版本是否支持、语义是否等价、配置落点（项目级/全局级）与迁移成本；实施前需要一次只读能力检查（P0 式探查） |
| **D. 可配置开关** | 默认安全（无 flag），仅在用户显式配置（环境变量/配置文件）时携带 skip-permissions | ✅ 默认最小权限，需要无人值守的用户显式选择；❌ 多一个配置面，canary/生产部署需同步设置；语义上接近 A 但把授权决策显式化并留痕 |

## 3. 决策需要回答的问题（用户拍板项）

1. AGY 目标 CLI 在 Dispatcher 项目目录内的无确认工具执行权是否可接受（选项 A/D）？
2. 若不可接受：AGY 无人值守路径是否接受"大概率不可用"（选项 B），还是要求先做只读能力检查评估选项 C？
3. 决策适用范围：仅本项目 Dispatcher，还是作为后续多项目部署的默认策略？

## 4. 拍板记录

- 决策：**选项 C**——以 AGY 官方权限规则承载目录白名单政策，**移除** `--dangerously-skip-permissions`
- 日期：2026-09-29
- 适用范围：仅本项目 Dispatcher；后续多项目部署逐项目沿用同一政策模板
- 备注/前提条件：
  1. **放行 = 按任务粒度**：仅该任务所在的项目目录 + `D:\3-huancun`（显式 allow 读写规则）。**禁止跨项目读取/写入**（用户 2026-09-29 明确：曾有 Agent 翻出其他项目历史文件造乱，此规则即为防此）。⚠️ **修正（2026-09-30 T3c R2/R4 探针证伪）**：原假设"AGY 工作区 cwd 默认自动放行，不写入 settings.json"**不成立**——R2 实测 cwd 默认被拦截；`--add-dir` 亦不带写权限。**per-job 项目目录必须显式写 `read_file/write_file(<项目目录>)` allow 规则**（已落地 Dispatcher 项目目录两条；多项目部署按此逐项目追加）。政策目标（放行范围）不变，实现路径按实测修正。
  2. **deny 兜底（放行区内也永远拦截）**：`write_file(.workbuddy/)`、`write_file(.git/)`、凭据/SSH 路径读写、`command(rm -rf)`、`command(sudo)`。
  3. **命令类先窄后宽**：第一版命令全部默认拦截（Ask=headless 下明确失败），T3c 受控取样取得 AGY 实际所需命令证据后，逐项加 allow。
  4. **前置只读验证**：T3c 先验证 Windows agy 1.2.11 细粒度引擎是否生效；不生效则退化上一代（`toolPermission:"proceed-in-sandbox"` + `trustedWorkspaces:[D:\3-huancun]`，per-job 项目目录依赖 cwd 默认——需在验证中一并确认上一代对 cwd 的默认语义）；两代均不可用则回退选项 A（保留 flag 并记录）。
  5. **授权**：用户已显式授权修改 `~/.gemini/antigravity-cli/settings.json`（仅 permissions / sandbox / trustedWorkspaces 相关键，其余不碰）。

## 5. 主控评估与推荐（2026-09-29，应用户"按目录地图白名单放行"提议）

**用户提议**：按全局目录地图授权——项目目录（`D:\1-WORK\1-gongzuoqu\<项目>`）与缓存目录（`D:\3-huancun`）内自动放行，其余拦截；问自建简易审核 vs 官方自动授权。

**取证结论（官方文档 + 本机探测）**：

1. **官方细粒度权限引擎存在且正是此用途**（antigravity.google/docs/permissions）：`~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow/ask/deny` 三列表，规则语法 `action(target)`（read_file/write_file/command/mcp/read_url 等），**优先级 deny > ask > allow**，默认策略=工作区内文件读写自动放行、命令/MCP/URL/工作区外默认 Ask。本机 `agy --help` 实证另有 `--sandbox`（终端沙箱，Windows 为 AppContainer）、`--add-dir`（加工作区目录）、`--mode`。
2. **Windows 关键不确定性**：第三方实证（对 agy 1.1.21）称细粒度引擎当时仅 macOS/Linux 生效，Windows 走上一代系统（`toolPermission` 四模式 + `trustedWorkspaces`）。本机 agy 1.2.11 + Windows，**是否已启用细粒度引擎必须实测**；且本机当前**无 settings.json**（目录已核实），现状行为=全默认 + argv 的 skip-permissions。
3. **豁免项必须设计**：AGY 自身数据目录（`~/.gemini/antigravity-cli/`，会话/日志落盘）不能被"白名单外拦截"误伤；王冠宝石（`~/.workbuddy/`、凭据/SSH、`.git/`、系统目录）应入 deny 显式兜底。

**推荐方案 = 选项 C 落地（官方机制承载用户目录政策），分两步**：

- **T3c 前置只读验证**（新增）：写入候选 settings.json → 受控探针验证规则在 Windows agy 1.2.11 实际命中/拦截行为（不跑真实任务）。
  - 若细粒度引擎生效 → 采用规则草案（下），**移除** `--dangerously-skip-permissions`；白名单外在 headless 下自然失败并如实报告（符合蓝图"需要交互时明确报告限制"）。
  - 若未生效 → 退化到上一代：`toolPermission:"proceed-in-sandbox"` + `enableTerminalSandbox:true` + `trustedWorkspaces:[项目目录, D:\3-huancun]`，同样移除 flag。
  - 若两代均不可用 → 回退选项 A（保留 flag，显式记录）。
- **规则草案**（按用户目录地图翻译；路径按 Windows 规范化——去盘符、反斜杠转正斜杠）：
  - allow：`write_file`/`read_file` 项目目录（Dispatcher 项目根；未来多项目按部署追加）、`D:\3-huancun`（或 runner 用 `--add-dir` 把 huancun 加成工作区目录吃默认放行）
  - deny：`write_file(.workbuddy/)`、`read_file`/`write_file` 凭据与 SSH 路径、`write_file(.git/)`、`command(rm -rf)`、`command(sudo)`
  - 其余不写规则 → 默认 Ask（headless 下=明确失败，即"拦截"语义）

**授权请求**：配置/修改全局 `~/.gemini/antigravity-cli/settings.json` 属蓝图 §8"全局 CLI 配置"范畴，需用户在拍板中一并显式授权（仅此文件、仅 permissions/sandbox/trustedWorkspaces 相关键）。

## 6. 执行结果记录（2026-09-30 T3c，主控验收 PASS）

- **前置只读验证结论 = 分支1 实锤**：细粒度权限引擎在 Windows agy headless（`-p`）**生效**（1.2.11 落地，1.2.14 复核静态证据沿用；四轮受控探针：allow 命中放行 ✅ / deny 命中拦截报 "Matches user-configured deny rule" ✅ / 白名单外 headless 自动拒并提示所需规则 ✅ / allow 规则全局按目标路径与 cwd 无关 ✅）。探针工件存档 `D:\3-huancun\dlz-agy-probe\`（round1-5）。
- **已落地 settings.json**：allow=`D:\3-huancun` 读写 + `D:\1-WORK\1-gongzuoqu\Dalizi-Dispatcher` 读写（证伪修正后补入）；deny 同 §4 备注 2；命令类不写 allow（备注 3 先窄后宽）；未写 ask（默认 Ask=headless 明确失败）。
- **runner 已移除 `--dangerously-skip-permissions`**（argv=`["-p",task,"--output-format","stream-json","--model",M,"--effort",E]`，测试显式断言无 flag）。
- **trustedWorkspaces 处置（主控拍板）**：`[C:\Windows\System32, D:\1-WORK\2-zahuo]` 系用户交互自跑 agy 时 CLI 自动写入，**属用户交互域配置，headless 调度路径不消费**（R2 已证 cwd/trusted 均不产生写放行）——与 §4 备注 1"禁跨项目"政策（约束调度器 job 域）**无张力，维持现状不删**。多项目部署时亦无需管它。
- **环境备忘**：agy 出网须经本机 Clash `127.0.0.1:7890`（WB 沙箱代理白名单不含 Google 域）；生产 dispatcher 由 bridge 派生、不受 WB 沙箱代理变量污染，部署时验证直连即可。agy 会自动升级（当日 1.2.11→1.2.14），版本敏感配置复查纳入部署检查单。
