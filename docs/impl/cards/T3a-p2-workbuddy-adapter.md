# T3a：P2 WorkBuddy/CodeBuddy 实时 adapter

阶段：P2 ｜ 依赖：T2 ｜ 并行：与 T3b、T3c、T4 并行 ｜ 状态：✅ 验收 PASS（2026-09-30 窗口2，主控四件套核验：改动仅卡内 5 文件、HEAD 未动、npm test 亲跑 135/135、usage.js/stream-json.js 导出在码、dispatcher.js 未动、runner.test.js 零删除行。接口契约已冻结合入，T3b/T3c 可消费）
设计锚点：蓝图 §5 事件与用量、§10 A3/A4；IMPLEMENTATION.md §5.2、§5.6

## 目标

把 workbuddy-runner 从"进程 close 后一次性解析"改为增量 stream-json 事件解析，经 emit 向 reducer 供 started/activity/usage/result 事件；建立 WB usage 字段映射（含 CodeBuddy 后台任务 usage 语义）。本卡同时交付三 runner 共用的 `src/usage.js` 与 stream-json 增量解码增强。

## 前置检查

- T2 RESULT=PASS；T0 的 WB 样本来源清单可用（若无本机样本，按官方 headless 文档字段先行映射并标注"待真实样本校准"）。

## 拥有文件（单写者）

- `src/workbuddy-runner.js`（改）
- `src/usage.js`（新，三 runner 共用接口）
- `src/stream-json.js`（改，增量解码增强；T3b/T3c 只消费不修改）
- `test/runner.test.js`（改）；`test/usage.test.js`（新）
其余只读。T3b/T3c 窗口如需动这两个共享文件，由主控协调，不私自改。

## 施工步骤

1. 增量解码：UTF-8 跨 chunk、半行、多行、无换行结尾、坏 JSON 容错；输出上限保留（MAX_CAPTURED_OUTPUT_BYTES 语义平移到事件流）。
2. emit 事件封套（IMPLEMENTATION §3.2）：started（spawn+版本/会话证据）、activity（步骤/阶段事件，无事件不编造）、usage（按 §5.6 语义）、result（协议终态+文本）、error。
3. usage.js：指标语义对象、snapshot 替换/delta 累加/result 最终替代规则；后台子任务与主任务重叠无证据时分列并标"覆盖不明"。
4. WB 字段映射：每字段记录 source_field 与 quality；语义不明字段存 null 并标不可观测。
5. 保留可信 executable 路径、argv 约束、shell:false、隐藏窗口。

## 测试与证据

- fixture：chunk 边界/半行/坏 JSON/静默期（无 activity 编造）/终态与退出码冲突。
- usage：脱敏样本期望值、缺字段→null、重放→不重复累计、result 替代临时聚合。
- `npm test` 全绿。

## 验收（对应 A 项）

A3（WB 实时状态）、A4（WB 用量准确）源码级证据；真实事件样本缺口列入 T5 输入。

## 禁止事项

禁改 dispatcher/job-store/mcp-server/其他 runner/卡片文件；禁用账号额度冒充 job usage；禁编造"正在思考"/进度百分比；禁扩大权限；禁 commit/push；禁跑真实 CLI 作业。

## 回传格式

RESULT｜基线｜改动文件清单｜usage.js 接口契约（供 T3b/c）｜测试计数与关键用例｜A3/A4 证据摘要｜待真实样本校准项。
