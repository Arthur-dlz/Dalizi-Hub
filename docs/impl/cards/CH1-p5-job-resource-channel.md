# CH1：P5 任务数据资源化（dlz://job/{job_id} + 轮询迁免授权通道）

阶段：P5b ｜ 依赖：UX1 合入（共享 task-card.html）、DOCS2 完成、LV1 探针结果已知 ｜ 并行：与 CH2 并行（文件零重叠）｜ 状态：**PASS（2026-10-04 主控独立验收：资源注册/双路径/降级标记 grep 在码、HUMAN hunk 原样、定向测试 5+28 亲跑全绿；LV1/A10 live 挂 HUMAN）**
设计锚点：蓝图 v1.3 §12；调研 §8.1-B2（tools/call 审批通道）/§8.2 位面 1；IMPLEMENTATION P5 增补章

## 目标

把卡片数据刷新从 `tools/call`（每 3s 踩审批通道）迁到 `app.readServerResource`（免授权安全 GET）：服务端注册 `dlz://job/{job_id}` 资源模板，卡片优先走资源读取，`tools/call get_task` 降级为兜底。刷新语义（revision 防旧、失败保留快照）零回退。

## 前置检查

- UX1 已合入（本卡在 UX1 版 task-card.html 上改，不回退其视觉/走秒/主题/size-changed 改动）。
- DOCS2 已定义资源载荷契约（与 `get_task` structuredContent 同形）。
- LV1 结果：若已证免授权不成立，本卡仍做服务端资源（其他客户端可用），卡片迁移范围降级为「尝试资源读取，失败即永久降级 tools/call」。
- ⚠️ `src/mcp-server.js` 存在 HUMAN 未提交 hunk（`VERIFIED_CODEX_MODELS` 扩充）——**原样保留，不回滚、不代提交**。

## 拥有文件（单写者）

- `src/mcp-server.js`（改）
- `src/task-card.html`（改）
- `test/mcp.test.js`（改）
- `test/task-card.test.js`（改）
其余只读。

## 施工步骤

1. **资源模板**：用 SDK v2 `ResourceTemplate` 注册 `dlz://job/{job_id}`（mimeType `application/json`）；handler 复用 `dispatcher.get(jobId)`，返回与 `get_task` structuredContent 完全同形的 JSON 文本；job 不存在/ID 非法返回标准资源错误（不泄漏内部路径）。
2. **卡片迁移**：`refresh()` 优先 `send('app.readServerResource', { uri: `dlz://job/${jobId}` }, true)`（方法名以 MCP Apps spec 2026-01-26 为准，施工时核对；LV1 已实证则按实证方法名）；解析 text → 走现有 `showTask` 管线。方法不存在/宿主报错 → 标记能力缺失，本会话内永久降级现有 `tools/call get_task` 路径（两者共用 `useResult`/`showTask` 与 revision 防旧）。
3. `get_task` 工具保留不动（其他客户端与兜底依赖）。
4. 资源读取失败语义等同查询失败：保留上次成功快照 + 错误提示 + 允许重试（复用 `reportQueryFailure`）。
5. 初始化时能力探测一次（读自身 `ui://` 资源或直接首次 job 读），不做周期探测。

## 测试与证据

- 新增用例：资源模板 URI 解析与 job JSON 同形断言（对照 get_task structuredContent 字段集）；job 不存在错误路径；卡片资源优先/降级双路径；revision 防旧在两条路径下都生效。
- 既有 mcp/task-card 用例全数保留通过；`npm test` 全绿（只增不减）。
- live（挂 HUMAN）：Desktop 目视轮询期间**无审批弹窗/无工具调用卡反复出现**，刷新内容正常。

## 验收

A10（resources/read 轮询 live，或降级通道声明 + 理由）；源码级 grep 在码（资源注册、双路径、降级标记）。

## 禁止事项

禁改 `task-card.js`（connectDomains 归 CH3）/`http-mcp-server.js`/dispatcher/store/runner；禁动 HUMAN 未提交 hunk；禁卡片内直连 localhost fetch/EventSource；禁携带凭据；禁 commit/push；禁碰 `.workbuddy/` 与外部 Bridge。

## 回传格式

RESULT｜基线｜改动文件清单｜测试计数与新增用例结果｜LV1 结论如何影响范围（全量迁移/降级声明）｜live 目视记录｜遗留风险。
