# ZC1：P6 看板 ZCode 风格 UI 重构（board.html 纯前端）

阶段：P6 ｜ 依赖：`resources/read` 线名修复已在工作树（与 ZC1 同行）｜ 并行：可与 Phase A 部署并行；**Phase C 部署前必须 PASS** ｜ 状态：待施工
设计锚点：`docs/impl/P6-methodfix-zcode-board-plan.md`；调研报告 §4.1（ZCode WorkflowTimeline / WorkflowRunPhaseList）§8.2 位面 2；HUMAN 诉求「能用 ZCode 的 UI 渲染最次也要 WB 原生渲染」（WB 原生渲染已由 Phase A 修复顶上，本卡冲 ZCode）

## 目标

把 `board.html` 看板视觉升级为 **ZCode `/workflow` 看板设计语言**，同时保持已验收的数据通道与降级逻辑一行不动。HUMAN 目视验收至少 1 轮迭代。

## 前置检查

- 工作树已含 `resources/read` 修复（`src/board.html` 中 `send("resources/read", …)`）；本卡在其上施工。
- 读 `docs/research/2026-10-03-workbuddy-native-and-zcode-workflow.md` §4.1 的 WorkflowTimeline/RunPhaseList 描述（视觉蓝本）。
- 读现 `src/board.html` 全文，分清「数据/通道区」（禁区）与「渲染区」（可改）。

## 拥有文件（单写者）

- `src/board.html`（改）
- `test/task-card.test.js`（改：board 相关断言区，DOM 断言随 UI 演进同步更新）
其余只读。**禁区文件**：`task-card.html`、`task-card.js`、`mcp-server.js`、`http-mcp-server.js`、`job-store.js`、`dispatcher.js`、其他测试。

## 施工步骤

1. **DLZ 语义 → ZCode 视觉映射**（不要照搬 ZCode 的 phase/agent 假结构，DLZ 没有 phase 与子代理）：
   - 阶段带 = 三态：QUEUED（排队）/ RUNNING（执行中）/ 终态窗口——时间线式横向排列（ZCode WorkflowTimeline 语言：站点式分组轴 + job pill），或垂直 spine 式分组（RunPhaseList 语言：组灯 + 行卡）。形态由你按 ZCode 视觉蓝本推定，HUMAN 目视时迭代。
   - 每 job = pill/行卡：状态徽章（五态不动）+ job_id 截断显示 + **本地走秒**（非终态 1s setInterval，沿用现有 `elapsedTick` 机制）+ meta 行（pid/心跳/活动/用量摘要）。
   - 非终态区置顶且**自动展开**（有任务时显活细节）；终态窗口（50 条）收拢为紧凑列表；空态显示「(无任务)」。
   - 运行中 job 视觉突出（ZCode「灯亮」语义）；FAILED/RECOVERY_REQUIRED 给警示色但不用大字报。
2. **禁区（一行不动）**：EventSource 直连与降级（`connectSse`/`startPolling`/`pollBoard`/`onToolResult`/`resourceBoardOf`）、`setChannel` 底部数据源诚实标注（四种通道文案语义不变：浏览器 SSE / widget SSE / widget 资源轮询+原因 / 未配置凭据）、token 取自 URL query 或 tool-result（**禁止把凭据写进静态文件**）、dispose 清理。
3. 组件/排版细节：无 CSS/JS 框架（原生 CSS + DOM，和现文件同族）；中文文案统一「DLZ看板」口径（review 记录在案，勿回退）；窄宽自适应（widget inline 容器可能很窄）。
4. `test/task-card.test.js` 的 board 断言区：更新 DOM 结构断言（新类名/新结构 ID），**保留**：title「DLZ看板」、`send("resources/read"` 在码、`dlz://board` 常量、`window.parent === window` 浏览器态判定、read_token URL query、`id="channel"` 数据源声明、空态文案。
5. 跑全量 `npm test`（基线 206，只增不减），回传。

## 测试与证据

- 定向：`node --test test/task-card.test.js`。
- 全量：`npm test` 206+ 全绿。
- 自证：board 断言的 DOM 钩子全部命中；禁区内函数名 grep 在码（connectSse/startPolling/onToolResult/resourceBoardOf/setChannel）。

## 验收

源码级 + 全量绿 + 回传 RESULT。视觉验收归 HUMAN（Phase D，至少 1 轮目视迭代）。

## 禁止事项

禁改禁区文件；禁动数据通道/降级/CSP meta；禁新依赖；禁 token 落静态文件；禁 commit/push；禁启停服务/看门狗；禁碰 `.workbuddy/` 与外部 Bridge；禁读凭据。

## 回传格式

RESULT｜基线｜改动文件清单｜测试计数与关键用例结果｜视觉形态说明（时间线 vs spine 选择理由 + 分区结构图）｜禁区函数 grep 在码证据｜遗留风险。
