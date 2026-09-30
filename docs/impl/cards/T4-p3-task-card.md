# T4：P3 任务卡修复（刷新稳健 + 展示补全 + 桥接收敛）

阶段：P3 ｜ 依赖：T1（快照 v2 字段）；建议 T2 后启动（RECOVERY_REQUIRED 展示有真源） ｜ 并行：与 T3a/b/c 并行 ｜ 状态：**已完成**（主控验收 PASS，2026-09-29，卡范围 12/12；全量绿复核归 T2 收敛后/T5 入口）
设计锚点：蓝图 §6 手动刷新体验、§8 桥接收敛、§10 A7；IMPLEMENTATION.md §5.7

## 目标

修复任务卡四个已确认问题：自动刷新开关被快照重置、旧响应覆盖新状态、查询失败丢快照、桥接 postMessage 过宽；补 RECOVERY_REQUIRED 与 usage/activity/liveness 的诚实展示。

## 前置检查

- T1 快照 v2 字段契约可用（revision/updated_at/activity/liveness/usage/execution_state）。

## 拥有文件（单写者）

- `src/task-card.html`（改）
- `src/task-card.js`（改）
- `test/task-card.test.js`（改）
其余只读。

## 施工步骤

1. 自动刷新开关：仅用户操作改变 `autoBox.checked`；`showTask` 不再触碰开关（删除 `:157` 的重置逻辑）；终态自动停止计时器保留。
2. 防旧响应：响应携带 job_id+revision；仅当 job_id 匹配且 revision 更新时替换快照；刷新中去重并发请求，结束后恢复按钮。
3. 失败保留：查询失败保留上次成功快照，显示错误与最后更新时间，允许重试；不得把查询失败渲染为 job 失败。
4. 展示：RECOVERY_REQUIRED 显著标识（非永久 RUNNING）；usage 各指标含 null→"不可观测"；activity 无观测时显示最近观测步骤+时间，不编造。
5. 桥接收敛：postMessage 目标 origin 不用 `'*'`（按 T0 结论写死白名单；未查明前按 IMPLEMENTATION §5.7 过渡校验并在卡片标注）。
6. CANCELLED 防御渲染分支保留（蓝图 §5 已声明无取消路径）。

## 测试与证据

- A7 指定用例：关闭自动刷新→手动刷新→收到 RUNNING 快照→断言开关仍关闭且无周期计时器。
- revision 乱序/跨 job 响应不覆盖；失败保留快照+重试；终态后仍可手动刷新。
- postMessage 校验逻辑测试（结构/job_id/event.source；origin 白名单若 T0 已查明）。
- `npm test` 全绿。

## 验收（对应 A 项）

A7（刷新稳健）源码级证据；A1 的实现侧就绪，宿主实测归 T5。

## 禁止事项

禁改 dispatcher/runner/store 文件；禁把卡片改成直连 localhost fetch；禁在卡片内携带凭据；禁用静态 HTML 检查冒充 Desktop 验收；禁 commit/push。

## 回传格式

RESULT｜基线｜改动文件清单｜测试计数与 A7 关键用例结果｜桥接收敛方式（白名单/过渡）｜遗留风险。
