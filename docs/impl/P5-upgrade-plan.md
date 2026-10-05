# P5 迭代计划：任务卡视觉重构 × 数据通道升级（WorkBuddy 原生能力 × ZCode 启发）

日期：2026-10-04 ｜ 状态：**D0 已拍板（2026-10-04）；P5b 施工中（DOCS2 已施工，待主控审读）** ｜ 主控编制
需求来源：`docs/research/2026-10-03-workbuddy-native-and-zcode-workflow.md`（调研报告，下称「调研」）
基线：V1 已收官（A1–A8 全绿，npm test 176/176，生产 dispatcher `127.0.0.1:18490` bridge 托管看门狗守护）。本计划不动 V1 已验收语义。

---

## 0. 结论速览

**能做，且证据充分。** 调研列出的 P0/P1 吸收点全部落在现有架构的自然延伸面上，无协议层障碍、无新运行时、无新依赖。按三期推进：**P5a 纯前端视觉重构（UX1，可立即启动）→ P5b 数据通道（DOCS2 蓝图 v1.3 前置，CH1→CH2→CH3）→ P5c 生产部署（OPS3，HUMAN 授权）**。ZCode 调度语义（原 P2）只登记进蓝图 §11 演进项，本轮不施工。

唯一需要 HUMAN 事前拍板的是 4 个决策点（§2，均附推荐方案，可一次性批准）。

---

## 1. 可行性评估（主控独立核验，证据锚点）

| 吸收点 | 结论 | 代码证据（2026-10-04 亲验） |
|---|---|---|
| P0-1 走秒与轮询解耦 | ✅ 纯前端可做的 | 快照已含 `started_at/created_at/finished_at`（`task-card.html:136-141` 已在算 elapsed，只需改为 1s 本地计时器重算） |
| P0-2 进度条/徽章/视觉 | ✅ 纯前端可做 | 现卡为表单风 dl 列表（`task-card.html:40-49`），徽章类已有 4 态（L15-19），扩展即可 |
| P0-3 宿主主题/尺寸 | ✅ 纯前端可做 | 现卡未接 `host-context-changed`、未发 `size-changed`（全文无此调用）；协议通路已在 |
| P1-1 connectDomains 解禁 | ✅ 一行 meta | `task-card.js:10` 现为空数组，改为白名单即可（仅 CH3 需要，见 §4 说明） |
| P1-2 SSE 端点 | ✅ HTTP 骨架现成 | `http-mcp-server.js` 单路径路由（L92 `!== "/mcp"` 即 404），扩只读路径是自然延伸；生产在跑证明该进程形态稳定 |
| P1-3 聚合看板 | ✅ 数据源现成 | `job-store.js` 已有 `listAll()`（L282）/ `listNonTerminal()`（L304），只缺 dispatcher 只读透出与展示层 |
| P1-6 轮询迁 resources/read（免授权） | ✅ SDK 支持 | `@modelcontextprotocol/server` v2 dist 含 `ResourceTemplate`；`mcp-server.js` 注册资源模板即可。免授权行为需 live 验证（LV1），有降级路径 |
| P1-5 present_files 看板 | ✅ 宿主能力 | 调研 §1.5 已核实（必须 `127.0.0.1`，WB 沙箱 curl 不可达但内置浏览器可达——本机已知） |
| P2 调度语义 | ⚠️ 只登记 | 触 dispatcher 核心与快照 schema，属蓝图演进项；本轮登记不施工 |

**关键约束（决定设计形态，来自调研 §8.1 已核实边界）：**

1. **宿主不推数据**——实时只能 widget 侧拉；走秒必须本地计时器，数据刷新靠 `resources/read`（免授权）或 SSE 直连。
2. **`tools/call` 是审批通道**——现卡每 3s 轮询都在踩它（`task-card.html:348`），这是迁 `resources/read` 的核心动机。
3. **EventSource 不能带 Authorization 头**——SSE 端点认证不能用现有 bearer 头方案，需二级只读凭据（D1 决策点）。
4. **read token 不能嵌进静态 UI 资源**——任何客户端都能读资源；必须由已认证工具调用动态下发（CH3 设计闭环，见卡）。

---

## 2. D0 决策点（HUMAN 一次性拍板，附主控推荐）

| # | 决策 | 选项 | 主控推荐 |
|---|---|---|---|
| D1 | 只读端点（/events /board /api/jobs）认证模型 | a. 独立只读 token（≥32 字符，与 MCP bearer 不同），query param 传递，timingSafeEqual 校验，主 bearer 亦接受；b. /board 首过 bearer 后 Set-Cookie 会话；c. 纯 loopback 不设防 | **a**。无状态、与现有 bearer 实现同族、可经 render_board 工具动态下发给 widget；c 是对现有安全姿势的降级，不接受 |
| D2 | render_board 是否进 MCP 工具面 | a. 进（新工具，structuredContent 带 board_url+read_token，iframe 与 present_files 双挂载）；b. 不进，board 只走 HTTP | **a**。工具是模型可发现的入口，同时解决 token 下发通道 |
| D3 | 蓝图修订策略 | a. v1.3 增量修订（新增 P5 表面章节 + §11 登记演进项，SHA256 重锁，不改 V1 已验收语义）；b. 不修订直接施工 | **a**。「需求以蓝图为唯一来源」是项目铁律，新工具/新资源/新端点必须先入蓝图 |
| D4 | P2 调度语义（phase/report/增量重跑等 6 项） | a. 本轮只登记进蓝图 §11；b. 本轮施工 | **a**。与 V1 收官基线隔离，另立项评估 |

**拍板方式**：~~HUMAN 回复「按推荐执行」或逐项改判，主控更新本文件 §2 后开工。UX1 不依赖任何决策点，可与拍板并行启动。~~
**已拍板（2026-10-04）**：HUMAN 指令「按计划推进，指挥窗口自主指挥」——D1–D4 **按主控推荐预批准**，HUMAN 回来后复核全部 diff（蓝图 v1.3 为文档级、可回滚；read token 机制默认关闭（未配置=404），实际生效取决于 OPS3 时 HUMAN 配置凭据，故预批准不造成安全姿势变更）。**明确不在预批准范围**：OPS3 全部内容（生产重启/canary/token 配置）、LV1/LV2/A9/A10/A11 一切 live 目视项——挂起等 HUMAN。

**拍板结论逐项落位（2026-10-04）**：

- D1 = **a**：只读端点用独立只读 token（≥32 字符、与 MCP bearer 不同源），query param 传递、timingSafeEqual 校验，主 bearer 亦接受；不采纳 cookie 会话（b）与纯 loopback 不设防（c）。
- D2 = **a**：`render_board` 进 MCP 工具面（`structuredContent` 带 `board_url` + `read_token`，iframe 与 present_files 双挂载）；不是"board 只走 HTTP"。
- D3 = **a**：蓝图 v1.3 增量修订（新增 P5 表面章节 + §11 登记演进项，SHA256 重锁，V1 已验收语义零改动）；不是"不修订直接施工"。
- D4 = **a**：P2 调度语义 6 项只登记进蓝图 §11（另立 P6 评估），本轮不施工。

---

## 3. Live 验证项（都有降级路径，不阻塞施工）

| # | 验证什么 | 何时做 | 不通过的降级 |
|---|---|---|---|
| LV1 | WB 桌面端 `app.readServerResource` 读 `ui://` 资源是否免授权（无弹窗） | UX1 live 目视时主控顺带探针（读现有 card 资源即可，不依赖新代码） | CH1 照做服务端资源，卡片轮询维持 `tools/call` |
| LV2 | MCP Apps iframe 内 EventSource 直连 `127.0.0.1` 是否被 CSP 放行（connectDomains 申报后） | CH3 施工后 live 验收 | CH3 运行时双通道自带降级：EventSource onerror → `dlz://board` 资源 2s 轮询，功能不缺失 |

---

## 4. 卡表与依赖

| 卡 | 内容 | 拥有文件（单写者） | 依赖 | 可并行 |
|---|---|---|---|---|
| **UX1** `cards/UX1-p5-card-visual-rebuild.md` | 卡片视觉重构：走秒解耦、状态阶段条、徽章体系、宿主主题热更、size-changed 防截断 | `src/task-card.html`、`test/task-card.test.js` | 无 | ✅ 立即启动 |
| **DOCS2 ✅** `cards/DOCS2-p5-blueprint-v13.md` | 蓝图 v1.3 + IMPLEMENTATION 同步：P5 新表面（资源/工具/端点/token 模型）+ §11 演进登记（**已施工 2026-10-04：蓝图 v1.3 纯新增+新锁、IMPLEMENTATION §9、本文 §2/§4；待主控审读**） | `docs/v1-mcp-agent-dispatch-blueprint.md`、`docs/impl/IMPLEMENTATION.md` | D0 拍板 | ✅ 与 UX1 并行 |
| **CH1** `cards/CH1-p5-job-resource-channel.md` | `dlz://job/{job_id}` 资源模板 + 卡片轮询迁 `app.readServerResource`（降级保留） | `src/mcp-server.js`、`src/task-card.html`、`test/mcp.test.js`、`test/task-card.test.js` | UX1 合入（共享 task-card.html）、DOCS2 | ❌ 串行 |
| **CH2** `cards/CH2-p5-sse-board-endpoint.md` | dispatcher 只读 list 透出 + `/api/jobs` + `/events`(SSE) + `/board` 静态页 + 只读 token | `src/http-mcp-server.js`、`src/dispatcher.js`、`src/board.html`(新)、`test/http-mcp.test.js`、`test/dispatcher.test.js` | DOCS2 | ✅ 与 UX1/CH1 并行（文件零重叠） |
| **CH3** `cards/CH3-p5-render-board-tool.md` | `render_board` 工具（token 动态下发）+ `dlz://board` 资源 + connectDomains 解禁 + 运行时双通道 | `src/mcp-server.js`、`src/task-card.js`、`src/board.html`、`test/mcp.test.js`、`test/task-card.test.js` | CH1、CH2 合入 | ❌ 串行 |
| **OPS3** `cards/OPS3-p5-production-rollout.md` | 生产部署：看门狗舞蹈、read token 配置、canary、Desktop live 三连验收 | 无代码文件（运维规程）+ README/OPS 手册 | CH3 + 全量绿 + HUMAN 显式授权 | ❌ 收尾 |

**依赖图**：

```text
D0 拍板 ──→ DOCS2 ──→ CH2 ──┐
（并行）  └──→ CH1 ──┤（CH1 另需 UX1 合入）
UX1 ────────┘        ↓
                    CH3 ──→ 全量绿 ──→ OPS3（HUMAN 授权）──→ P5 收官
```

**冲突纪律**（在 V1 纪律之上追加）：

1. `src/mcp-server.js` 当前有**未提交 hunk**（`VERIFIED_CODEX_MODELS` 扩充，HUMAN 在途改动）——CH1/CH3 窗口必须原样保留，不得回滚、不得代为提交。
2. `src/board.html` 归 CH2 拥有；CH3 仅在 CH2 合入后做必要小改，需大改则回主控裁决。
3. 窗口一律不 commit/push、不启停生产服务、不碰 `.workbuddy/` 与外部 Bridge、不读凭据；canary 与生产重启仅在 OPS3 且 HUMAN 显式授权后执行。

---

## 5. 验收口径

- **每卡**：`npm test` 全绿（基线 176，只增不减）+ 卡内指定用例 + 回传 RESULT 格式（RESULT/基线/改动清单/测试计数/证据/遗留风险）。
- **源码级验收**：主控独立核验（git status 归属、亲跑测试、grep 在码、红线扫描），不盲信窗口自报。
- **live 验收**（挂 HUMAN 目视，类 A1）：UX1 卡片渲染/走秒/主题热更/不截断；CH1 轮询不再过审批通道；CH3 render_board 渲染与刷新、present_files 打开 board。
- **P5 收官**：六卡全 PASS + 生产跑新代码 + canary:http 绿 + live 三连目视确认。

---

## 6. P2 演进登记（本轮只登记，DOCS2 顺带写入蓝图 §11）

调研 §5 P2-1~P2-6：phase 里程碑计数、`report()` 中间结果透出、结果契约四字段（conclusion/findings/verified/notCovered）、子任务粒度增量重跑、人工介入状态位 + `sendMessage('fill')`、并发槽位自适应。均触 dispatcher 核心与快照 schema，另立 P6 评估，不动 V1/P5 基线。

## 7. 明确不做（调研结论背书）

- show_widget 承载实时进度（一次性渲染，机制错配）。
- ZCode TS DSL/沙箱引擎整体引入（体量超 DLZ 薄调度器定位；Apache-2.0 合规成本另计）。
- 宿主 UI 注入/覆盖（触腾讯协议 9.2，违规）。
- WorkBuddy Agent Teams 替换 DLZ 多窗口纪律（与 ASK-DLZ 控制面冲突）。
