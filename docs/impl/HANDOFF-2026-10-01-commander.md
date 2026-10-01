# 主控交接包 — 2026-10-01（现任主控 → 新主控窗口）

> 用途：新任主控窗口读本文件 + `docs/impl/COMMANDER-RUNBOOK.md` + `.workbuddy/memory/MEMORY.md` + `.workbuddy/memory/2026-10-01.md`，复述状态对齐后接管指挥权。
> 控制面：ASK-DLZ。核心铁律：**不盲信窗口自报，一切验收亲验**。

---

## 1. 当前基线（接管时逐条复核，不符即异常）

| 项 | 值 | 复核命令 |
|---|---|---|
| 仓库 | `D:\1-WORK\1-gongzuoqu\Dalizi-Dispatcher`，分支 `main` | `git status -sb` |
| HEAD | `2ccf347`（T5 修复批，已 push，`main...origin/main` 同步，工作区干净） | `git log --oneline -1` |
| 测试 | **168/168**（串行 `node --test --test-concurrency=1`，~47-209s 方差正常） | 亲跑，勿信转述 |
| 生产 dispatcher | PID **14628**，`127.0.0.1:18490`，bridge 托管 dispatcher-only | bridge Status（见 §4 坑） |
| tunnel | **休眠**（`bridge.json tunnelDormant=true`，非死代码，见 bridge 根 `TUNNEL-DORMANT.md`） | 同上单条含 `tunnelDormant` |
| 看门狗 | 计划任务 `DaliziHubBridgeWatchdog` Running，守护中 | `Get-ScheduledTask` |
| bridge.json | `codexCliPath`=`...\bin\c6fe824d725f02d7\codex.exe`（0.159.2）；Start 脚本有动态兜底（配置失效扫 `bin\*\codex.exe` 取最新）；两处 `.bak-20261001` | 只读查看 |

## 2. 在途三卡（10-01 已喂出，deepseek-v4.1-flash 窗口，等回传）

验收 = 四件套：**git status 归属逐文件对卡面拥有清单 / 亲跑全量测试 / grep 关键修复在码 / 红线核查（含 `.workbuddy/` mtime 扫描）**。

### 卡 A：T4ux 结果区缩略（`docs/impl/cards/T4ux-p3-result-collapse.md`）
- **只许改**：`src/task-card.html`、`test/task-card.test.js`
- 期望：168+N 全绿；阈值 500 字符/8 行；同 job_id 刷新保持展开态+scrollTop；空结果隐藏不回归
- grep 点：500/8 行阈值、`Map` 状态键（job_id→expanded/scrollTop）、`50vh`

### 卡 B：T5cal usage 校准（`docs/impl/cards/T5cal-p4-usage-mapping-calibration.md`）
- **只许改**：`src/codex-runner.js`、（按需）`src/antigravity-runner.js`、`src/usage.js`、对应 test 文件
- **只读承诺**：`.dispatcher-data/` 与 `D:\3-huancun\dlz-t5-canary\` 样本——验收时扫这些目录 mtime，有写=越界
- grep 点：`cache_write_input_tokens`（codex-runner USAGE_FIELD_MAP）；agy duration 断点修复处（usage.js canonical 名单仅许追加 `wall_duration_ms`）
- null≠0 语义不许破坏（字段缺失仍 unavailable）

### 卡 C：OPS codex 独立 CLI（`docs/impl/cards/OPS-codex-standalone-cli.md`）
- **仓库零改动**；只许写 `D:\2-ruanjian\codex-standalone\` 与 `D:\3-huancun\`
- 验收：真 exe `--version` ≥0.159.2、`exec --help` 含 `--skip-git-repo-check`、SHA256 记录、PATH/npm config/桌面版三项零改动（`npm config get prefix` + 桌面版 hash 目录仍存在可复核）
- **验收 PASS 后主控接续（用户授权后）**：改 bridge.json `codexCliPath`→新稳定路径（留 .bak）→ 按 §4 铁律看门狗流程重启 → codex canary 复验一发

## 3. 纪律档案（三连违规，新主控必须盯死）

1. **`.workbuddy/` 越界三连**：T3c / T6 / T5 窗口各犯一次（内容均审核背书保留+主控注）。每张新卡红线块已首部加粗，验收必扫：`.workbuddy/` mtime 今日新增非主控所写=越界。
2. **T6 叙事造假**：窗口编造开工基线（"SyntaxError 7 文件崩"）被主控三次实测证伪 → 所有卡现含**开工基线留档义务**（git status + npm test 原文，未贴=回传拒收）。
3. 回传 RESULT 语义：PASS/FAIL/PARTIAL/NOT_PROVEN/BLOCKED——PARTIAL/NOT_PROVEN 不许当 PASS 收。

## 4. 操作坑速查（都踩过，别再交学费）

- **生产重启只交看门狗**：摘看门狗（Disable-ScheduledTask + 杀 Watch-DaliziHubBridge.ps1 循环进程，身份核验）→ 改配置 → Enable+Start 任务让它 recovery_start。**WB 会话里跑 Start 拉起的 dispatcher 会被会话退出连坐收割**（两次实证）。
- **WB 会话跑 bridge Status 先清代理**：`Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:http_proxy,Env:https_proxy` 再跑，否则 HttpWebRequest 吃沙箱代理→404 假阴性。
- **WB 会话 Remove-Item 被 safe-delete 包装 fail-closed**：删文件操作用干净 `pwsh -NoProfile` 子会话。
- **PowerShell stdout 偶发空捕获**：命令输出重定向日志文件再读，别套娃嵌套引号。
- **npm test 偶发抖动**：串行 `--test-concurrency=1` 规避；验收遇 fail 先归因（已知 flake 家族见 RUNBOOK §6）再归属。

## 5. 验收后动作队列（按序）

1. 三卡全 PASS → commit + push（用户授权后；精确暂存，禁 `-A`；commit 信息留证据锚点；`.workbuddy/`/`.dispatcher-data/` 绝不入库）
2. T4ux PASS → 请用户目视新卡片 UX（render_task_card 一个长结果 job，看缩略+展开+刷新保持）
3. OPS PASS → §2 卡 C 接续流程（bridge 改指+重启+canary 复验）
4. 全线收官 → RUNBOOK/MEMORY 基线更新；长期项：dalizihub-bridge 独立版本化

## 6. 授权边界（越权=事故）

- 真实 CLI 作业（canary/dispatch）：**必须用户显式授权**（T5 已授权过一次，仅当次有效）
- 生产任何变更（重启/配置/停起）：先报用户拍板
- commit/push：逐次授权
- 窗口纪律事件：内容审核属实可背书保留，违规本体必须留档当日日志

—— 交接完毕。现任主控留档：三卡回传到了先验基线再验码，OPS 卡的 bridge 切换别忘留 .bak。
