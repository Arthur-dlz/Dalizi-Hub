# T3b：P2 Codex 实时 adapter

阶段：P2 ｜ 依赖：T2 + **T3a 的 usage.js/stream-json 接口已回传冻结**（只消费） ｜ 并行：与 T3c、T4 并行（T3a 接口冻结后启动） ｜ 状态：✅ 验收 PASS（2026-09-30，主控四件套+归因核验：改动仅卡内 2 文件、HEAD 未动、npm test 亲跑 148/148（1 cancelled=T2 A5 时序 flake，复跑全绿，非本卡引入）、codex.test.js 零删除行、共享文件 mtime 未动、emit/UsageAggregator/StreamJsonDecoder 消费在码、codex.exe 路径未硬编码=CODEX_CLI_PATH 参数化）
设计锚点：蓝图 §5、§9 Codex events.ts 参考；IMPLEMENTATION.md §5.2、§5.6

## 目标

codex-runner 增量事件解析 + `turn.completed.usage` 五字段（input/cached/cache_write/output/reasoning）映射，经 emit 供 reducer 实时快照。

## 前置检查

- T2 RESULT=PASS；**T3a 已回传且 src/usage.js、src/stream-json.js 接口已合入仓库可用**（import 可解析、现有测试可跑）；未满足则停手等 T3a，不按草案接口先行。

## 拥有文件（单写者）

- `src/codex-runner.js`（改）
- `test/codex.test.js`（改）
其余只读；**不得**修改 src/usage.js、src/stream-json.js（T3a 文件），需要变更时回传主控。

## 施工步骤

1. 复用 T3a 的增量解码与 emit 封套，接 Codex `--json` 事件流。
2. 终态：turn.completed 协议终态 + 正常退出码 + 结果持久三者齐备才 COMPLETED；非零退出与成功结果冲突时报 FAILED 并留诊断。
3. usage 映射：cached/cache_write 与 input 的包含关系按安装版本语义声明；关系不明不推导合计；provider total 优先；actual_model 不可观测时保持不可观测。
4. 保留可信绝对路径覆盖/PATH 回退、argv `exec -m … --json` 约束。

## 测试与证据

- fixture：turn/item 事件序列、终态+退出码冲突、usage 重放不重复累计。
- 脱敏样本期望值比对；`npm test` 全绿。

## 验收（对应 A 项）

A3、A4（Codex 部分）源码级证据。

## 禁止事项

同 T3a（不重复罗列）：不动他卡文件、不编造、不扩权、不跑真实作业、不 commit/push。

## 回传格式

RESULT｜基线｜改动文件清单｜测试计数与关键用例｜A3/A4 证据摘要｜待真实样本校准项。
