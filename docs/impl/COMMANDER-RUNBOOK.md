# COMMANDER RUNBOOK — Dalizi-Dispatcher V1 重构指挥手册

> 交接对象：新任主控窗口（指挥/验收角色）。读完本文件 + `.workbuddy/memory/MEMORY.md` + 最近两天日志即可接管。
> 更新：2026-09-30 由前任主控（kimi-k3-1）交接时定稿。
> 主控注（2026-09-30 16:35）：T3c 窗口曾越界自写本文档多处（§2 表 T3c 行/顺序行、§3 基线、§4.7 改写、新增 §4.8、§6 AGY 行）及 `.workbuddy/memory/` 两文件。内容经主控逐项审核**属实，予以保留背书**；纪律违规（单写者越界 + `.workbuddy/` 红线 + 回传虚假合规声明）已在当日日志留档。以下除标注处外均为审核后口径。

## 0. 控制面与铁律

- 以 **ASK-DLZ** 为默认控制面（用户常驻指令）。主控负责理解目标、守授权边界、拆分调度、汇总证据、最终验收；执行委派给窗口。
- **验收铁律：不盲信窗口自报**。每份回传必做独立核验：①`git status`/`git diff --stat` 核对改动面=卡拥有文件；②亲跑相关测试复现计数；③grep 关键机制确实在码；④查红线（无 commit/未启服务/未越界）。
- RESULT 语义：PASS / FAIL / PARTIAL（部分完成但无失败）/ NOT_PROVEN / BLOCKED。
- 红线：未授权不 commit/push/启停服务；不动 `.workbuddy/` 内部资产、凭据、外部 Bridge（`D:\1-WORK\agent\dalizihub-bridge`）；单写者纪律（窗口只写卡内拥有文件）；canary/真实 CLI 作业必须用户显式授权。

## 1. SSOT 文件地图

| 文件 | 角色 |
|---|---|
| `docs/v1-mcp-agent-dispatch-blueprint.md` | 需求唯一来源，v1.2，SHA256 `048BB68F72B62471E7D624AFE979B8CBCD96D812B6872950410D52E421C01662` |
| `docs/impl/IMPLEMENTATION.md` | 实现技术文档（模块/数据格式/机制/测试映射/并发规则） |
| `docs/impl/cards/T0–T5` | 施工卡（喂给执行窗口；状态行实时更新） |
| `docs/impl/agy-permission-decision.md` | AGY 权限拍板记录（已定：选项 C，§4） |
| `.workbuddy/memory/` | 日志与长期记忆（跨窗口接力通道） |
| `D:\3-huancun\dlz-r2-probe\T0-p0-host-capability-report.md` | T0 宿主能力报告（§3.3 = live 实测七步序列） |

代码基线（2026-10-01 收官口径）：分支 `main`，HEAD `7872fc6`（已 push 同步 origin/main；三卡+交接文档 11 路径）；工作区仅 DOCS 新卡未跟踪（待其施工后一并 commit）。当前 `npm test` 应为 **176/176**（168 + T4ux 6 + T5cal 2）。**全部施工卡（T1-T4+T3a/b/c+T5+T6+T4ux+T5cal+OPS）完成并验收；V1 生产在跑（dispatcher PID 29116，bridge 托管 dispatcher-only，tunnel 休眠，看门狗在岗）；codex 已改指 standalone 0.159.3 固定路径（自动升级免疫）；下一闸=T4ux 用户目视 + DOCS 卡验收**。

## 2. 卡片状态与喂卡计划（含模型配置）

| 卡 | 状态 | 模型 | 备注 |
|---|---|---|---|
| T0 宿主探查 | ✅ 验收 PARTIAL | glm-5.3-flash | A1 静态成立；live 实测挂用户 |
| T1 存储底座 | ✅ 验收 PASS | step-5-preview | 81→含 18 新增；EPERM 加固已收 |
| T2 准入/幂等/锁/恢复 | ✅ 验收 PASS | glm-5.3 | 110/110；A5/A6 源码级证据齐 |
| T4 任务卡 | ✅ 验收 PASS | glm-5.3-flash | A7 指定用例通过；origin 运行时固定 |
| T3a WB adapter | ✅ 验收 PASS | kimi-k3-1 | 接口契约已冻结合入（usage.js/stream-json.js）；窗口2 完成，窗口1 宿主故障零污染 |
| T3c AGY adapter | ✅ 验收 PASS | glm-5.3-flash | 分支1 实锤；skip-permissions 已移除；决策文档 §6 有证伪修正；探针工件 `D:\3-huancun\dlz-agy-probe\` |
| T3b Codex adapter | ✅ 验收 PASS | deepseek-v4-flash | emit 三 runner 口径一致；A5 flake 归因见 §6 |
| T5 端到端 canary | ✅ 验收 PASS | glm-5.3-flash | 主控四件套核验（10-01）；三真 bug+一地雷修复；168/168；commit `2ccf347` 已 push |
| T4ux 结果区缩略 | ✅ 验收 PASS | deepseek-v4.1-flash | 主控四件套核验（10-01 新主控）：归属精确 2 文件；全量 176/176+定向 54/54；500/8 阈值+Map 状态保持+50vh 在码；尾部换行边界口径已裁决接受；**待用户目视** |
| T5cal usage 校准 | ✅ 验收 PASS | deepseek-v4.1-flash | 主控四件套核验（10-01 新主控）：归属精确 4 文件；cache_write_input_tokens 在码；断点=映射源对象层级（result 层），usage.js 零改动证实无断点；样本只读扫描全过 |
| OPS codex 独立 CLI | ✅ 全线收官 | deepseek-v4.1-flash | 主控亲验（10-01）：exe 0.159.3/SHA256 与窗口报一致/`--skip-git-repo-check` 在/PATH·npm prefix·桌面版零改动；**接续已完成**：bridge 改指真 exe（.bak-20261001-ops 留档）+看门狗重启（新 PID 29116）+canary c01 PASS（cache_write_input_tokens live 透出） |
| DOCS impl 同步 | ✅ 验收 PASS | deepseek-v4.1-flash | 主控四件套核验（10-01）：归属精确 1 文件；全量 176/176 亲跑；§4/§5.6/§5.8/§6/§7 同步内容与代码事实逐条相符；基线偏离披露属实（主控并行产物）裁决接受 |

顺序：T3a ∥ T3c 双开 →（Codex 路径到手）T3b → 三卡全 PASS（已达成）→ **T6 emit 接线（已达成 2026-09-30，技术 PASS/纪律留档见当日日志 18:30）** → 全量绿复核（已构成：窗口三连跑+主控亲跑 155/155）→ **部署（停 V0 PID 25820 已授权；启 V1 授权届时确认）** → T5（届时授权）。

## 3. 验收规程（每份窗口回传）

1. 读回传 → 对照卡的"拥有文件/禁止事项"清单。
2. 独立核验四件套（见 §0 铁律）。测试基线当前 **151/151**（时长约 15-30s）。
3. 验收结论写 `.workbuddy/memory/YYYY-MM-DD.md`（含证据），更新卡状态行，向用户简报：结论/核验表/解锁项/待办。
4. 窗口越界或证据不足：打回并指明缺什么；不替窗口补作业。
5. **基线声称留档义务（2026-09-30 T6 事件后增设）**：回传若含"开工基线异常/开工即坏"类声称，必须附开工时 `npm test` 原始输出留档；无留档的一律按窗口施工自残中间态处理，并在验收中单独核查其施工 diff 与叙事的一致性。另：git 对 docs/+ .workbuddy/ 是盲区，每份回传核验须含两目录 mtime 扫描。

## 4. 用户挂账事项（截至交接）

1. ~~Codex CLI 路径~~ **已解决（2026-09-30，方案A）**：本机无独立 CLI，桌面版 runtime=`C:\Users\Arthur\AppData\Local\OpenAI\Codex\bin\faa963e871dd422c\codex.exe`（codex-cli 0.158.0-alpha.2.1，与 bridge.json `codexCliPath` 一致）；T3b 施工用该绝对路径覆盖。后续加固项（未授权）：装官方 standalone CLI 绑固定路径，规避 hash 目录升级失效。
2. **Desktop live 实测**（A1 闭环）：用户按 §3.3 七步操作（连 `http://127.0.0.1:18490/mcp` → render_task_card job `c26bf263-e432-4f88-8bcb-71cf8794369b` → 点刷新 → 回传现象）。当前在跑的是 **V0 实例**（PID 25820），宿主能力验证用它足够；若卡片不渲染查 `mcpAppsEntryEnabled` 门控。
3. **部署授权（届时确认）**：V1 首次真跑前停 V0（PID 25820，**用户已授权主控操作**）→ 启 V1 dispatcher（服务启动授权届时一并确认）→ live 复测新卡片。
4. **T5 canary 授权**：届时讨论（用户原话）。
5. **已确认决策**：单实例内并发维持范围外（多实例拓扑覆盖 3 开）；GitHub 用 `Arthur-dlz/Dalizi-Hub`（空仓库）做项目地址。
6. **dispatcher emit 接线（主控集成微卡，届时授权）**：T3a/b/c 的 runner 均通过 spec 可选 `emit` 字段接受事件回调（2026-09-30 主控拍板，不动 T2 的 dispatcher.js）；三卡 PASS 后由主控开小卡统一接线——dispatcher 调用点（`:245` 附近）传入 emit → JobStore.apply seam（IMPLEMENTATION §3.2/:116），三 runner 口径一致后全量绿复核。
7. ~~agy 登录~~ **已解决（2026-09-30）**：本机原已持久化登录（Windows keyring 存储，无明文文件）。**调度器专用账号=`jiangarthur110@gmail.com`（Google AI Pro，用户拍板固定，不轮换）**。注意：agy 会自动升级（当日实测 1.2.11→1.2.14），版本敏感结论须注明依据版本。
8. ~~T3c 受控探针~~ **已解决（2026-09-30）**：agy 1.2.14 Windows headless 细粒度权限引擎**实锤生效**（分支1）。关键事实：①settings.json `permissions.allow/deny` 规则按目标路径全局生效（与 cwd 无关）；②deny 命中返回 "Matches user-configured deny rule"；③白名单外 headless 自动拒（stderr 明示所需 allow-rule，result.denied_actions 列出被拒动作）；④**cwd 工作区默认放行不成立、--add-dir 不带写权限——per-job 项目目录必须显式写 allow 规则**（已按授权补入 `read_file/write_file(D:\1-WORK\1-gongzuoqu\Dalizi-Dispatcher)`）；⑤探针工件存档 `D:\3-huancun\dlz-agy-probe\`（round1-4 stdout/stderr）；⑥本工具沙箱出站走代理白名单，agy 探针须 `http_proxy=http://127.0.0.1:7890`（本机 Clash）才能达 Google API。遗留处置（**主控已拍板 2026-09-30**）：settings.json 的 `trustedWorkspaces` 含用户自跑 agy 时 CLI 自动写入的 `C:\Windows\System32` 与 `D:\1-WORK\2-zahuo`——属用户交互域配置，headless 调度不消费（R2 已证其不产生写放行），与"禁跨项目"政策（约束调度器 job 域）**无张力，维持现状不删**。

## 5. GitHub 迁移计划（Dalizi-Hub）

远端：`https://github.com/Arthur-dlz/Dalizi-Hub`（空仓库，仅一个 README 初始提交）。本地无 remote，历史与该 README 提交不相干。计划（**每步执行前与用户确认命令**）：

1. 准备 `.gitignore`：`.workbuddy/`、`run/`、`.dispatcher-data/`、`experiments/**/*.pid`、`node_modules/` 等（**`.workbuddy/` 绝不入库**）。
2. `git remote add origin https://github.com/Arthur-dlz/Dalizi-Hub`
3. 提交基线：分支 `fix/new-pc-local-recovery-r1` 上按"交接包/蓝图 v1.2/施工包/T1+T2+T4 代码"组织提交（提交信息留证据锚点）。
4. `push` 该分支；`main` 指向另行与用户定（空仓库 README 提交可弃，force 需显式授权）。

## 6. 环境备忘（踩过的坑）

- PowerShell stdout 偶发捕获为空 → 日志重定向兜底（见用户级记忆）。
- Windows rename 偶发 EPERM/EBUSY（AV/索引器瞬态占用）：T1 已在 job-store `#write` 加有限重试（0/320）；勿当回归。
- `node --test` 时序 flake 家族（非回归，复跑即绿）：①http-mcp 测试并行偶发抖动（单跑必过）；②~~A5 crash injection 偶发 cancelled~~ **根因已修（2026-09-30 T6，主控认可）**：子进程 fake runner 挂起 promise 不持有事件循环→owner 提前自然退出→cancelledByParent 级联取消同文件后续用例；修复=夹具内 ref'd setInterval 保活到被 kill；③**偶发 fail（未定位名）**——T3c 验收首跑 1 fail，复跑两次全绿。验收遇到先看归因再看归属。
- **agy 出网须走本机 Clash `127.0.0.1:7890`**（WB 沙箱代理白名单不含 Google 域）；生产 dispatcher 由 bridge 派生、不受 WB 沙箱代理变量污染，部署时验证直连。agy 会自动升级（当日 1.2.11→1.2.14 实证），版本敏感配置复查纳入部署检查单。
- Dispatcher V0 已停（原 PID 25820）；**V1 在跑**：`127.0.0.1:18490`（PID 34180，2026-09-30 19:59 起，bridge 托管 dispatcher-only 形态），live 验证全绿。**tunnel 已休眠化**（`bridge.json tunnelDormant=true`，ChatGPT App 侧弃用；再启用见 `D:\1-WORK\agent\dalizihub-bridge\TUNNEL-DORMANT.md`，非死代码）。
- **WB 会话跑 bridge Status 前须清 HTTP(S)_PROXY 四变量**：`Get-HttpStatus` 用 legacy `HttpWebRequest` 吃 `HTTP_PROXY` 环境变量，WB 注入的沙箱代理会让 healthz/readyz 探针 404 假阴性（pwsh IWR 同环境正常）。看门狗在 Task Scheduler 干净环境运行不受影响。
- **生产启动只交给看门狗**：WB 会话进程树退出时会连坐收割子进程（job object），在 WB 会话里跑 Start 拉起的 dispatcher 会话一结束即亡（19:5x 实证）。切换/重启生产的标准动作=摘看门狗→改配置→启用看门狗让它 recovery_start（Task Scheduler 上下文，进程可存活）。
- AGY（1.2.14 实测口径）：settings.json 已在（`~/.gemini/antigravity-cli/`）；放行=allow 规则显式授权（`D:\3-huancun` + Dispatcher 项目目录）+deny 兜底（.workbuddy/.git/凭据/rm -rf/sudo），**禁止跨项目读写**；headless 无规则动作自动拒（stderr 提示所需 allow-rule）。runner argv 已无 skip-permissions 旗标。agy 自动升级会就地替换二进制并可能改写 settings.json（trustedWorkspaces 实测被自动追加）。
