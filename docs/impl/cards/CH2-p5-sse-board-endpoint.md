# CH2：P5 只读数据通道（dispatcher list 透出 + /api/jobs + /events SSE + /board 页）

阶段：P5b ｜ 依赖：DOCS2 完成 ｜ 并行：与 UX1/CH1 并行（文件零重叠）｜ 状态：**PASS（2026-10-04 主控独立验收：timingSafeEqual/token 纪律/listBoard 纯只读代码级确认、本地 curl 三端点取证、定向测试 4+14 亲跑全绿；浏览器 live 归 OPS3）**
设计锚点：蓝图 v1.3 §12；调研 §8.2 位面 2/§5 P1-2/P1-3；D1 拍板（只读 token 模型）；IMPLEMENTATION P5 增补章

## 目标

在现有 `http-mcp-server.js`（生产在跑的单路径服务）上扩出只读数据面：dispatcher 只读 list 封装、`GET /api/jobs` 聚合 JSON、`GET /events` SSE 实时流、`GET /board` 静态看板页。为 CH3 的 render_board 与 OPS3 的 present_files 看板提供数据与页面基座。

## 前置检查

- DOCS2 已定：board 载荷契约（快照信封数组 + 有界终态窗口 + 上限/截断规则）、SSE 帧格式、D1 认证模型细节。
- 现状基线：`http-mcp-server.js` 对 `!== "/mcp"` 路径一律 404、bearer ≥32 字符、origin 检查；`job-store.js` `listAll()`(L282)/`listNonTerminal()`(L304) 现成。
- 认证前提：`EventSource` 不能带 Authorization 头 → 只读 token 走 query param（D1-a）。

## 拥有文件（单写者）

- `src/http-mcp-server.js`（改）
- `src/dispatcher.js`（改：仅加只读 list 封装）
- `src/board.html`（新）
- `test/http-mcp.test.js`（改）
- `test/dispatcher.test.js`（改）
其余只读。

## 施工步骤

1. **dispatcher 只读透出**：`async listBoard()`（名字以 DOCS2 为准）——读 store `listNonTerminal()` + `listAll()` 有界窗口，合并为快照信封数组（复用现有 snapshotEnvelope 语义），按 updated_at 排序、按契约截断；纯只读，不写 store、不动实例锁。
2. **认证**：env `DISPATCHER_HTTP_READ_TOKEN`（≥32 字符，独立于 MCP bearer；未配置则只读端点整体关闭回 404——默认安全）；query `?token=` 与主 bearer 头均接受，一律 `timingSafeEqual`；失败 401。**token 不出现在任何日志与错误体中。**
3. **路由**（在现有 createServer 内，原 `/mcp` 流程零改动）：
   - `GET /api/jobs` → 聚合 JSON（同 listBoard 载荷）；
   - `GET /events` → SSE：`text/event-stream`；1s 轮询 listBoard，revision/状态 diff 才推 `data:` 帧；15s 无事件发心跳注释行；连接 close 清理计时器；首帧全量；
   - `GET /board` → `src/board.html` 静态文本（`text/html`）；其余路径维持 404；origin/方法检查沿用现有风格。
4. **board.html**：原生 ES 模块无依赖；从 `location.search` 取 token → `EventSource(`/events?token=…`)`；按状态分组渲染看板（QUEUED/RUNNING/终态分列），每 job 一行卡：状态徽章、agent/project、走秒（本地 1s 计时器，与 UX1 同族）、current_activity、usage 摘要；SSE onerror 显示断线提示并自动重连。视觉与 UX1 卡同族（徽章五态、明暗 `light-dark()`）。
5. 防御：SSE 单连接内存有界；载荷超上限按契约截断并显式标注；不引入任何新 npm 依赖。

## 测试与证据

- 新增用例：只读端点未配置 token → 404；错 token → 401；主 bearer → 200；`/api/jobs` 载荷契约；SSE 首帧全量 + diff 才推 + 心跳帧 + close 清理（fake dispatcher/假 store 注入）；`/board` 200 text/html；原 `/mcp` bearer 流程回归不动；`dispatcher.listBoard` 只读性（store mock 断言零写调用）。
- `npm test` 全绿（只增不减）。
- 窗口本地取证：临时 `DISPATCHER_DATA_DIR`（`D:\3-huancun` 下新建目录）+ 临时端口起实例，curl 三端点取证贴回传；**不得碰生产 18490 进程**。

## 验收

源码级 + 本地实例 curl 证据；SSE 帧格式与契约一致。live 浏览器验收归 OPS3。

## 禁止事项

禁改 `mcp-server.js`/`task-card.*`/store 写路径/runner；禁把 read token 写进仓库任何文件；禁启停生产服务/看门狗；禁 fs.watch 之类平台敏感机制（用轮询 diff）；禁 commit/push；禁碰 `.workbuddy/` 与外部 Bridge。

## 回传格式

RESULT｜基线｜改动文件清单｜测试计数与新增用例结果｜本地实例 curl 证据（三端点各一）｜与 DOCS2 契约对齐自检｜遗留风险。
