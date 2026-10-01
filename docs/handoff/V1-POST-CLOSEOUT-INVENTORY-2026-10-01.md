# V1 竣工后状态盘点（2026-10-01）

> 主控亲验盘点。所有结论附证据；凡文档记载与当前实测不一致处，以实测为准并单列。
> 唯一需求源仍为 [`../v1-mcp-agent-dispatch-blueprint.md`](../v1-mcp-agent-dispatch-blueprint.md)。

## 0. 判定

**V1 按蓝图 §11 定义整体 PASS（竣工）**，当前处于「收官后待命、无在途施工卡」状态。
本次盘点**未发现功能性缺陷**；发现的问题集中在**文档陈旧与状态行未回填**（§6），不影响代码与生产可用性。

## 1. 基线事实（本次亲验）

| 项 | 实测值 | 证据 |
|---|---|---|
| HEAD | `0ecc963` docs: V1 closeout | `git log --oneline -1` |
| 分支 / 远端 | `main` 跟踪 `origin/main`，**已同步** | `git status -sb` |
| 工作区 | **干净**（含未跟踪文件 0） | `git status --porcelain -uall` |
| 跟踪文件数 | 73 | `git ls-files \| wc -l` |
| 测试 | **176 / 176 pass**，0 fail / 0 cancelled / 0 skipped，25.99s | `npm test` 亲跑 |
| Tag | 无 | `git tag -l` |

## 2. 交付物台账

| 类别 | 数量 | 内容 |
|---|---|---|
| 源码模块 | 18 | `src/*.js`（contracts / dispatcher / job-store / idempotency(-index) / instance-lock / recovery / project-registry / mcp-server / http-mcp-server / stream-json / usage / egress-proxy / 三个 runner / task-card(.js/.html) / antigravity-usage） |
| 测试 | 17 | `test/*.test.js`，覆盖 store/契约/准入/锁/恢复/三 runner/usage/卡片/HTTP-MCP |
| 脚本 | 5 | `scripts/`：e2e-canary、antigravity-e2e-canary、http-e2e-canary、register-project、resolve-recovery |
| 文档 | 21 | 蓝图 1 + `docs/impl/`（IMPLEMENTATION / RUNBOOK / HANDOFF / agy 决策）+ 施工卡 14 + e2e 证据 1 + `docs/handoff/` 3 |
| 实验 | 1 组 | `experiments/chatgpt-task-card-poc/`（9 文件，V0 期概念验证，未跟踪保留） |

## 3. 验收矩阵 A1–A8

**全绿**（蓝图 §11 已改写为竣工口径）。

| 编号 | 项 | 结论 |
|---|---|---|
| A1 | 卡片渲染 + 刷新原位更新 | PASS（10-01 13:14 用户目视「过了」闭合） |
| A2 | 客户端中立契约（claim/lease/trusted exe） | PASS |
| A3 | 实时状态（activity 流） | PASS |
| A4 | 用量准确（null ≠ 0） | PASS |
| A5 | 无重复执行（幂等双分支） | PASS |
| A6 | 可信恢复 | PASS（自动路径；人工出边仅 `resolve-recovery`） |
| A7 | 刷新稳健 | PASS |
| A8 | 完整链路 | PASS（三 CLI canary 终态） |

## 4. 生产运行态（本次实测）

| 项 | 实测值 | 证据 |
|---|---|---|
| dispatcher | **PID 29116** 监听 `127.0.0.1:18490` | `netstat -ano` + `run/dispatcher.json` |
| 启动 | 2026-10-01T03:49:25Z（= 11:49:25 +08:00），由**看门狗自愈拉起** | `run/dispatcher.json` |
| 进程身份 | `D:\2-ruanjian\Node\22.18.0\node.exe` + `src/http-mcp-server.js` | `run/dispatcher.json` |
| 看门狗 | 11:48:13 started → 11:49:31 `recovery_ready`；运行至今约 2h 无新重启 | `logs/watchdog-20261001.log` |
| bridge | `tunnelDormant = true`；`codexCliPath` → standalone 真 exe | `config/bridge.json` |
| bridge 备份 | `bridge.json.bak-20261001`、`bridge.json.bak-20261001-ops` 均在 | `config/` 列表 |
| job 台账 | **62 条**：45 COMPLETED / 15 FAILED | `.dispatcher-data/*.json` 统计 |
| 最新 job | `72a7d1d7` = canary c01（codex / dlz-t5-canary，COMPLETED，03:50:59Z→03:52:30Z） | 同上 |

> 说明：15 条 FAILED 系开发期探针与早期失败样本，非当前故障；生产切换后的 canary c01 为 COMPLETED。
> 看门狗日志中 01:08–02:35 的一串 failure/recovery 属部署调试期循环，11:48 起为生产切换后的正常自愈记录。

## 5. 代码风险清单复核（对照 ASSET_INVENTORY「已知代码风险」）

该清单为 V1 施工**前**诊断，逐条复核结果：

| # | 原风险 | 现状 | 证据 |
|---|---|---|---|
| 1 | 准入竞争（检查与 claim 之间 await） | **已闭合** | `dispatcher.js:66` 单一 async mutex 串行准入链；`dispatcher.js:265` claim 前置于 spawn |
| 2 | 快照更新竞争（读改写未串行） | **已闭合** | `job-store.js:197-201,264-272,326-330` per-job FIFO 串行 reducer seam |
| 3 | 无运行恢复 | **已实现** | `recovery.js:81` `scanRecovery` → RECOVERY_REQUIRED（running/unknown 双分支） |
| 4 | 无实时过程视图 | **已实现** | activity 流（A3 验收通过） |
| 5 | 自动刷新偏好覆盖用户选择 | **已修复** | `task-card.html:202` `!isTerminal && autoBox.checked`；`:215` 尊重关闭 |
| 6 | 终态差异（卡片识别 CANCELLED，dispatcher 不产生） | **设计边界** | 蓝图 §5:103「V1 无取消路径」+ §1:24 非目标清单；§8 为「安全与权限」章节，非取消条款；非缺陷 |

**结论：6 条中 5 条已闭合、1 条属范围外设计边界。该清单已过时，需同步（见 §6）。**

## 6. 文档陈旧度分级（本次盘点新发现）

### 严重 —— 交接包三文件中两份口径已失效

| 文件 | 偏差 |
|---|---|
| `docs/handoff/START_HERE.md` | 称候选 branch `fix/new-pc-local-recovery-r1`、HEAD `87e42ec9`、`npm test` 63 pass、**A1–A8 未验收**、蓝图 SHA256 `6B4C7306…`（现为 `048BB68F…`）——全部与现状矛盾 |
| `docs/handoff/VERIFY_AND_CONTINUE.md` | 同上口径（HEAD 87e42ec9 / 63 pass / A1–A8 未验收），作为「续做入口」已具误导性 |

### 中等 —— 索引类文档停在 V0 视角

| 文件 | 偏差 |
|---|---|
| `docs/handoff/ASSET_INVENTORY.md` | ①「当前调用链」仍描述 V0 单进程路径，未含 claim/reducer/recovery；②「已知代码风险」6 条中 5 条已闭合（§5）；③「README 漂移」段仍指 README 自称 V0 |

### 轻微 —— 状态行与口径残留

| 位置 | 偏差 |
|---|---|
| 施工卡状态行 | `T4ux`/`T5cal`/`OPS` 卡首行仍写「待施工」，`T5` 写「待授权」；RUNBOOK §2 已判 PASS |
| T6 卡 | **无独立卡片文件**，仅见于 RUNBOOK §2 顺序行与 HANDOFF |
| `COMMANDER-RUNBOOK.md` | §3 写「当前 151/151」与 §1「176/176」并存；§2 顺序行「T5（届时授权）」未回填 |
| 多处时点快照 | HEAD 记 `4a8374f`/`2ccf347`/`7872fc6`、生产 PID 记 `14628`/`29116`/`34180`——属**不同时点快照**而非错误，但未标注时点 |

> 说明：以上**不影响代码与生产**，但会误导下一位接续者（尤其 START_HERE 声称「A1–A8 未验收」与现状相反）。

## 7. 遗留项（不阻塞，已知并背书）

| # | 内容 | 性质 |
|---|---|---|
| C1 | `dalizihub-bridge` 独立版本化 | 长期项（收官后未决） |
| C2 | agy `wall_duration_ms` live 复验（随下次 agy canary） | 长期项 |
| C3 | 其他 MCP 客户端传输/认证/展示兼容性 | 长期项（**不得提前宣称**） |
| C4 | standalone 与桌面版 codex 共享 `~/.codex`（CODEX_HOME） | 维持现状 |
| C5 | RECOVERY_REQUIRED running/unknown 分支 live 不可达（仅单测覆盖） | 注记 |
| C6 | claude 系 agy 模型 effort 语义未经 live 校准 | 注记 |
| C7 | 单实例内并发为范围外；多项目 = 每项目独立实例 | 范围边界 |
| C8 | 蓝图 §1:24 明确不做清单（队列/并行编排/会话续接/取消审批/自动重试/历史分析/计费/自动 Git 等） | 范围边界 |

## 8. 建议动作（按优先级，均待授权）

| 优先级 | 动作 | 理由 |
|---|---|---|
| P1 | 处理 `docs/handoff/` 三文件：将 START_HERE / VERIFY_AND_CONTINUE **标退役或改指向** RUNBOOK + HANDOFF-2026-10-01 | 当前口径与现状相反，误导风险最高 |
| P2 | 更新 `ASSET_INVENTORY.md`：调用链刷至 V1、风险清单 6 条改写为闭合状态 | 代码定位索引是常用入口 |
| P3 | 回填施工卡状态行（T4ux/T5/T5cal/OPS）；T6 补卡或明确不立卡 | 状态一致性 |
| P4 | RUNBOOK §3 测试数口径统一为 176/176；§2 顺序行回填 | 消除自相矛盾 |

## 附：盘点取证命令

```bash
git log --oneline -8 && git branch -vv && git status --porcelain -uall
npm test                                    # 176/176
netstat -ano | grep :18490                  # PID 29116 LISTEN
cat <bridge>/run/dispatcher.json             # pid/executable/marker
cat <bridge>/logs/watchdog-20261001.log      # 自愈时间线
grep -o '"status"...' .dispatcher-data/*.json | uniq -c   # 45 COMPLETED / 15 FAILED
```
