# T1：P1 存储底座（JobStore reducer + 快照 v2 + request_id 索引）

阶段：P1 ｜ 依赖：无（建议与 T0 并行） ｜ 并行：T2 依赖本卡，不可并行 ｜ 状态：**已完成**（主控验收 PASS，2026-09-29；81/81 含本卡新增 18 项）
设计锚点：蓝图 §4 索引形态、§5 快照/事件；IMPLEMENTATION.md §3.1–3.3、§5.2

## 目标

把 JobStore 从"裸 read-merge-write"升级为带串行 reducer seam 的快照存储，落地快照 schema v2（含 v1 兼容读取）与 request_id 索引（内存 Map + append-only 日志 + 启动重建）。关闭 V0 丢更新风险，为 T2 的串行准入/幂等/恢复提供 API 底座。

## 前置检查

- `git rev-parse HEAD` 与主控基线一致；`npm test` 现有测试全绿（以实际输出计数为准，主控 2026-09-29 实测 63 pass）。

## 拥有文件（单写者）

- `src/job-store.js`（改）
- `src/idempotency-index.js`（新）
- `test/store-parser.test.js`（改）
- `test/idempotency-index.test.js`（新）
其余文件只读；发现必须改他卡文件时停手回传。

## 施工步骤

1. 快照 v2：写入时带 `schema_version: 2`、`revision`（每次变更 +1）、`updated_at` 及 IMPLEMENTATION §3.1 全部新字段（默认 null/初值）；读取时无 `schema_version` 的旧文件按 v1 兼容（新字段补 null），不伪造历史心跳。
2. `apply(job_id, event)`：per-job FIFO 串行应用；临时文件+rename 落盘保留；事件按 kind 更新 activity/liveness/usage/status；revision 单调。
3. `listNonTerminal()`：供恢复扫描。
4. 索引：append（创建 job 后，写入顺序恒为 job 记录先落盘、索引后追加）；**启动恒对账重建**——从 job 记录全量重建内存 Map，索引日志仅作审计（覆盖"日志完好但缺尾条目"窗口）。
5. 保留既有 create/get 行为与临时文件 rename 语义；不削弱既有测试断言。

## 测试与证据

- 并发 apply 交错（多事件源）→ 无丢更新、revision 连续。
- 索引：重复追加同 request_id 不产生双条目；**stale-log 窗口**：构造"job 已落盘、索引缺最后一行（日志本身完好）"→ 启动对账重建后 Map 必含该 request_id；日志整体缺失→重建结果与原 Map 一致。
- v1 旧快照读取兼容测试。
- `npm test` 全绿（新旧合计）。

## 验收（对应 A 项）

- A5 前置：索引与写入顺序测试证据。
- A6 前置：listNonTerminal 与快照持久性测试证据。
- 交付 API 契约说明（供 T2 使用）：方法签名、错误语义、写入顺序保证。

## 禁止事项

禁改 dispatcher/mcp-server/contracts/runner/卡片文件；禁引入数据库/新框架；禁 commit/push；禁启服务；禁削弱既有断言来凑绿。

## 回传格式

RESULT｜基线（HEAD/蓝图 SHA256 `048BB68F…`，v1.2）｜改动文件清单｜测试计数（pass/fail/新增项）｜API 契约摘要｜遗留风险。
