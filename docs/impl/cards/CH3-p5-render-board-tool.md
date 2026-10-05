# CH3：P5 聚合看板工具（render_board + dlz://board 资源 + connectDomains + 运行时双通道）

阶段：P5b ｜ 依赖：CH1、CH2 合入 ｜ 并行：无（收尾串行）｜ 状态：**PASS（2026-10-04 主控独立验收：render_board/dlz://board/board UI meta grep 在码、connectDomains 恰好一个 origin、单任务卡 meta 零改动、静态文件零 token 字面量、HUMAN hunk 原样、定向测试 8+37 亲跑全绿；LV2/A11 live 挂 HUMAN）**
设计锚点：蓝图 v1.3 §12；调研 §5 P1-1/P1-3/P1-4、§8.2 位面 1 极限、§8.1-B3（CSP）；D2 拍板；LV2 验证项

## 目标

把多任务聚合看板带进 MCP 工具面：新增 `render_board` App Tool（structuredContent 动态下发 board_url + read_token，解决「token 不能嵌静态资源」），新增 `dlz://board` 聚合资源，解禁 connectDomains，board widget 运行时双通道（SSE 优先、资源轮询兜底）。单任务卡（UX1/CH1 成果）不动。

## 前置检查

- CH1 已合入（`dlz://job/{job_id}` 与资源注册模式可复用）；CH2 已合入（`/events`、`/board`、`dispatcher.listBoard`、read token 机制可用）。
- LV2 未知 → 本卡按**运行时特性探测**设计：EventSource 直连失败（onerror/CSP 拦截）自动降级 `app.readServerResource('dlz://board')` 2s 轮询，两条通道渲染同一载荷，功能等价、实时性分级。
- ⚠️ `src/mcp-server.js` 有 HUMAN 未提交 hunk——原样保留。

## 拥有文件（单写者）

- `src/mcp-server.js`（改）
- `src/task-card.js`（改：board UI 资源 meta）
- `src/board.html`（改：双通道适配；CH2 已合入前提下小改，需大改回主控裁决）
- `test/mcp.test.js`（改）
- `test/task-card.test.js`（改）
其余只读。

## 施工步骤

1. **board UI 资源**：`task-card.js` 增加 `ui://dalizi-dispatcher/task-card.html` 之外的 board 资源定义（如 `ui://dalizi-dispatcher/board.html`，mimeType `text/html;profile=mcp-app`）；其 `_meta.ui.csp.connectDomains` 白名单加 `http://127.0.0.1:18490`（仅此 origin；resourceDomains 维持空）。**单任务卡 meta 不动**（它走 resources/read，无需直连）。
2. **dlz://board 资源**：固定 URI 资源，handler 复用 `dispatcher.listBoard()`，application/json，契约同 CH2/DOCS2。
3. **render_board 工具**：`readOnlyHint: true`，`_meta.ui.resourceUri` 指 board 资源；handler 返回 `structuredContent: { jobs（摘要数组）, board_url: "http://127.0.0.1:18490/board?token=…", read_token, generated_at }`——read_token 从 dispatcher 环境读（`DISPATCHER_HTTP_READ_TOKEN`），**只经此已认证工具调用下发，不写进任何静态资源/日志**；未配置 read token 时 board_url/read_token 为 null 并显式声明降级（widget 走资源轮询）。
4. **board.html 双通道**：widget 模式（MCP Apps 沙箱）：初始化握手同单卡；收 `tool-result` → 取 read_token 尝试 `EventSource(board_url 同源 /events)`；onerror/超时 → 降级 `app.readServerResource('dlz://board')` 2s 轮询；通道状态在卡片底部诚实标注（数据源声明，与截图卡同族）。浏览器模式（present_files 打开）：无 MCP 桥，检测 `window.parent === window` 走纯 SSE（CH2 已有行为）。渲染复用 CH2 分组看板；子进程级字段（agent/pid/liveness/当前活动）按 roster 风格嵌套展示。
5. size-changed 上报与 host-context 主题适配（与 UX1 同族）；teardown/pagehide 清理 EventSource 与计时器。

## 测试与证据

- 新增用例：board 资源注册与 meta（connectDomains 恰好一个 origin）；render_board structuredContent 契约（含 token 有/无两种配置）；widget 双通道降级逻辑（模拟 EventSource 失败 → 资源轮询接管）；单任务卡 meta 零改动断言。
- `npm test` 全绿（只增不减）。
- live（挂 HUMAN，OPS3 可合并验收）：Desktop 调 render_board → 聚合看板渲染、运行中行走秒、通道标注符合实际（LV2 结论落档）；present_files(board_url) 打开浏览器版全功能看板。

## 验收

A11（SSE/board live 或降级通道声明）；源码级 grep 在码；LV2 结论记入蓝图 §11 或当日日志。

## 禁止事项

禁改 dispatcher/store/runner/`http-mcp-server.js`/`task-card.html`；禁把 read token 写入任何静态文件或日志；禁扩大 connectDomains 白名单范围；禁动 HUMAN 未提交 hunk；禁 commit/push；禁碰 `.workbuddy/` 与外部 Bridge。

## 回传格式

RESULT｜基线｜改动文件清单｜测试计数与新增用例结果｜LV2 结论（走了哪条通道）｜live 目视记录｜遗留风险。
