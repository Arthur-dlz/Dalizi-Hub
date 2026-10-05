# UX1：P5 任务卡视觉重构（走秒解耦 + 徽章体系 + 宿主主题 + 防截断）

阶段：P5a ｜ 依赖：无（可立即启动）｜ 并行：与 DOCS2/CH2 并行；**必须先于 CH1 合入**（共享 task-card.html）｜ 状态：**PASS（2026-10-04 主控独立验收：归属/HUMAN hunk/定向测试 23/23 亲跑/grep 在码/红线扫描全过；A9 live 目视挂 HUMAN）**
设计锚点：`docs/impl/P5-upgrade-plan.md` §1/§3；调研报告 §2（截图拆解）§5 P0；蓝图 §6（卡片体验，不改契约）

## 目标

把任务卡从「表单风 dl 列表」重构为「看板风状态卡」，视觉/实时性与 WorkBuddy 原生渲染的进度看板卡同级：走秒与数据轮询解耦、状态阶段条、RUNNING/QUEUED 徽章区分、消费宿主主题并热更新、上报尺寸防 inline 截断。**纯前端改造，不改任何数据契约与 MCP 表面。**

## 前置检查

- 现状基线：`task-card.html` 已有 revision 防旧、失败保留快照、结果缩略/展开、诚实展示（null≠0）——全部保留，不得回退。
- 快照字段 `started_at/created_at/finished_at/updated_at` 已在数据面（job-store snapshotEnvelope），无需服务端改动。

## 拥有文件（单写者）

- `src/task-card.html`（改）
- `test/task-card.test.js`（改）
其余只读。**禁碰 `src/task-card.js`**（connectDomains 变更归 CH3）。

## 施工步骤

1. **走秒解耦**：快照到达时把 `started_at ?? created_at` 与 `finished_at` 存为本地变量；新增 1s `setInterval` 仅重算 elapsed 文本（非终态 = `Date.now() - start`，终态 = `finished_at - start` 定值后停表）。与现有 3s 数据轮询互不触发；`dispose()` 与 `pagehide` 清理两个计时器。
2. **状态阶段条**：头部加单任务阶段指示（QUEUED → RUNNING → 终态三态映射，RECOVERY_REQUIRED 单独警示态）。**只映射真实 status/execution_state，不虚报百分比**（诚实展示原则）；多任务聚合进度条不归本卡（归 CH3 board）。
3. **徽章体系**：RUNNING 蓝（带脉冲点）、QUEUED 灰、COMPLETED 绿、FAILED 红、CANCELLED 紫、RECOVERY_REQUIRED 橙；运行中关键行浅色高亮。沿用现有 `.badge` 类扩展。
4. **布局重构**：dl 表单 → 分区卡片（头部状态行 + 阶段条 + 关键字段网格 + usage/result 折叠区保留现有交互）；窄屏媒体查询保留；`max-width` 适度放宽。
5. **宿主主题**：监听 `ui/notifications/host-context-changed`（方法名以 MCP Apps spec 2026-01-26 为准，施工时核对）；theme 写入元素 dataset 驱动 CSS；首帧 hostContext 可能为空对象（已知行为）——CSS 层用 `light-dark()` 或 `color-scheme` 兜底，JS 层收到通知后锁定。宿主注入的 `--cb-*` 变量优先 `var(--cb-*, 现有回退值)` 消费。
6. **size-changed 上报**：`ResizeObserver` 观察根卡片，高度变化时向宿主发尺寸通知（方法名按 spec 核对），防 inline 截断；注意去抖与 dispose 断连。
7. 既有行为回归：自动刷新开关语义、revision 防旧、查询失败保留快照、结果缩略/展开、usage 诚实展示——逐一保留。

## 测试与证据

- 新增用例：走秒计时器启停（非终态走秒、终态停表、dispose 清理）；`host-context-changed` 处理与首帧空值兜底；size-changed 上报（含 dispose 后不再发）；徽章类五态映射。
- 既有 `task-card.test.js` 用例全数保留通过。
- `npm test` 全绿（基线 176，只增不减）。

## 验收（对应项）

源码级：上述用例 + grep 在码。Desktop live（挂 HUMAN 目视，类 A1）：渲染、走秒、明暗主题切换热更、长内容不截断、缩略/展开与自动刷新语义不回退。**主控顺带做 LV1 探针**（`app.readServerResource` 读 `ui://dalizi-dispatcher/task-card.html` 是否免授权无弹窗，结果记入回传）。

## 禁止事项

禁改 `task-card.js`/`mcp-server.js`/dispatcher/store/runner 任何文件；禁动 connectDomains；禁卡片内直连 localhost fetch/EventSource；禁携带凭据；禁用静态 HTML 检查冒充 Desktop 验收；禁 commit/push；禁碰 `.workbuddy/` 与外部 Bridge。

## 回传格式

RESULT｜基线（改动前 git 状态）｜改动文件清单｜测试计数与新增用例结果｜LV1 探针结果（live 时）｜视觉对照说明（改了哪些区）｜遗留风险。
