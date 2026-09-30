# T2：P1 串行准入 + 幂等 + 实例锁 + 恢复 + 人工解除（含 AGY 权限决策记录）

阶段：P1 ｜ 依赖：T1（使用其 JobStore/索引 API） ｜ 并行：完成后解锁 T3a/b/c、T4 ｜ 状态：**已完成**（主控验收 PASS，2026-09-29；110/110 三轮全绿；AGY 决策记录待用户拍板）
设计锚点：蓝图 §4 request_id、§7 心跳/锁/恢复/出边、§8 AGY 权限、§10 A5/A6；IMPLEMENTATION.md §5.1–5.5

## 目标

关闭 V0 准入竞争，落地 request_id 幂等、执行 claim、实例锁、启动恢复扫描与 RECOVERY_REQUIRED 人工解除路径；产出 AGY 权限策略决策记录模板并交用户拍板。

## 前置检查

- T1 已回传 RESULT=PASS，API 契约可用；`npm test` 全绿。

## 拥有文件（单写者）

- `src/dispatcher.js`、`src/contracts.js`、`src/mcp-server.js`（改）
- `src/idempotency.js`、`src/instance-lock.js`、`src/recovery.js`、`scripts/resolve-recovery.js`（新）
- `package.json`（仅加 `resolve-recovery` script）
- `test/dispatcher.test.js`、`test/contracts.test.js`、`test/mcp.test.js`（改）；`test/idempotency.test.js`、`test/instance-lock.test.js`、`test/recovery.test.js`（新）
- `docs/impl/agy-permission-decision.md`（新，模板）
其余只读。

## 施工步骤

1. 串行准入区间：lookup(request_id)→busy→create+索引→claim 全在同一 mutex 区间；区间外无上述读写。
2. request_id：contracts 校验（可选、8–128 URL-safe）；mcp-server schema 与回执接线；同 id 同摘要→返回原 job；同 id 不同摘要→`idempotency_conflict`；缺省允许但工具描述注明无重试保证。
3. claim：spawn 前持久化（owner identity、PID、创建时间、可信 executable）；execution_state 流转 claimed→spawning→running→stopped。
4. owner 心跳：5s 周期、15s 过期标记（仅影响可信度显示，不触发 kill/重跑/释放）。
5. instance-lock：排他 acquire、heartbeat 更新、release；**stale 判定**（heartbeat 过期 30s 且 owner PID 身份不存在/不匹配→归档旧锁后接管；心跳新鲜或 PID 存活→拒绝启动）；第二活 owner 拒绝启动（stdio 与 HTTP 同状态目录同锁）。
6. recovery：启动扫描 listNonTerminal，按 IMPLEMENTATION §5.4 决策表分类；RECOVERY_REQUIRED 保留占用并在快照明示。
7. resolve-recovery：`--job --confirm --evidence` 缺一拒绝；仅对 RECOVERY_REQUIRED 生效；**前置条件=目标 owner 已停止**：命令先 acquire 实例锁（含 stale 判定），锁被活 owner 持有则拒绝并提示；获锁后走临时文件+rename、revision+1 写 FAILED(interrupted_confirmed)+审计行+释放持久 claim；终端回执。
8. 终态写 completion_evidence（协议终态/会话匹配/退出码/结果持久）；冲突证据不得报成功。
9. AGY 决策记录：在 `docs/impl/agy-permission-decision.md` 模板中列现状（antigravity-runner.js:177 的 `--dangerously-skip-permissions`）、选项（保留/移除/替代）与影响分析；标注"待用户拍板"，T3c 以其结论为输入。

## 测试与证据

- A5：同 request_id 并发两请求→仅 1 次 spawn、同 job_id；冲突请求拒绝；模拟响应丢失后用同 id 找回原 job；第二 owner 启动被拒；崩溃注入（claim 后 spawn 前）不自动重跑。
- A6：fixture 覆盖 §5.4 全表（未启动/已停缺结果/存活/PID 复用/身份未知）；resolve-recovery 审计记录实测；实例锁双进程测试（活锁拒绝启动、stale 锁接管、PID 复用不误判）。
- `npm test` 全绿。

## 验收（对应 A 项）

A5（无重复执行）、A6（可信恢复）取得源码级证据；A2 的幂等/契约部分就绪。Windows 实测点单独标注。

## 禁止事项

禁改 job-store/idempotency-index（T1 文件；有缺口回传）；禁改 runner/卡片文件；禁把 resolve-recovery 暴露为 MCP 工具；禁自动释放占用/自动重跑/kill 未知进程；禁替用户拍板 AGY 权限；禁 commit/push；禁启服务。

## 回传格式

RESULT｜基线｜改动文件清单｜测试计数与关键用例（spawn 次数断言等）｜A5/A6 证据摘要｜AGY 决策记录位置与待用户项｜遗留风险。
