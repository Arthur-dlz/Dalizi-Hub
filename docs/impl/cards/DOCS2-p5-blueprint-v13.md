# DOCS2：P5 蓝图 v1.3 修订 + IMPLEMENTATION 同步（新表面入 SSOT）

阶段：P5b ｜ 依赖：D0 拍板（P5-upgrade-plan §2）｜ 并行：与 UX1/CH2 并行；**必须先于 CH1/CH2/CH3 施工完成** ｜ 状态：**PASS（2026-10-04 主控独立验收：蓝图纯增 48/0、SHA 复算一致、蓝图↔IMPLEMENTATION 三处对齐审读通过；v1.3 diff 留 HUMAN 过目）**
设计锚点：`docs/impl/P5-upgrade-plan.md` 全文；调研报告 §5/§8；蓝图 v1.2 §11；IMPLEMENTATION §1（蓝图唯一需求源铁律）

## 目标

把 P5 新增的 MCP/HTTP 表面写入需求 SSOT：蓝图升 v1.3（只增不改，V1 已验收条目语义不动），IMPLEMENTATION 增补对应实现章节，SHA256 重锁。**本卡只写文档，不施工代码。**

## 前置检查

- D0 四决策点已由 HUMAN 拍板（D1 只读 token 模型 / D2 render_board 进工具面 / D3 蓝图 v1.3 / D4 P2 只登记），拍板结论记录在 P5-upgrade-plan §2。
- 现蓝图 v1.2 SHA256 `048BB68F…C01662`，IMPLEMENTATION 头部引用之——修订后同步更新。

## 拥有文件（单写者）

- `docs/v1-mcp-agent-dispatch-blueprint.md`（改，v1.3）
- `docs/impl/IMPLEMENTATION.md`（改，增补章节）
- `docs/impl/P5-upgrade-plan.md`（改：§2 记录拍板结论，§4 卡表状态）
其余只读。

## 施工步骤

1. **蓝图 v1.3**，新增章节（建议 §12「P5 卡片与数据通道演进表面」），覆盖：
   - `dlz://job/{job_id}` 只读资源模板（application/json，载荷与 `get_task` structuredContent 同形；供 MCP Apps widget 免授权轮询）。
   - `dlz://board` 只读资源（聚合快照数组，含非终态全量 + 有界终态窗口；声明条数/字节上限与截断规则）。
   - `render_board` 工具（readOnlyHint；`_meta.ui.resourceUri`；structuredContent 契约：`{jobs 摘要, board_url, read_token}`——read_token 经此已认证通道动态下发，**不得嵌入静态 UI 资源**）。
   - HTTP 只读端点族：`GET /api/jobs`（JSON）、`GET /events`（SSE，revision diff 推送 + 心跳）、`GET /board`（静态页）；认证 = D1 拍板模型（独立只读 token query param，timingSafeEqual，主 bearer 亦接受；其余路径维持 404 + 原 bearer 不变）。
   - connectDomains 白名单演进（仅 board widget 需要时申报 `http://127.0.0.1:18490`）。
   - 验收项新增：A9（P5 卡片视觉与走秒 live）、A10（resources/read 轮询 live）、A11（SSE/board live 或降级通道声明）。
   - §11 更新：登记 P2 演进项 6 条（phase 计数 / report 透出 / 结果四字段契约 / 增量重跑 / 人工介入状态位 / 并发自适应），标注「另立 P6 评估」。
2. **v1.3 修订注记**：文件头追加修订行（日期、依据 P5-upgrade-plan、不改变 V1 已验收语义的声明）；重新计算并记录 SHA256。
3. **IMPLEMENTATION 增补**：资源模板注册方式（SDK v2 ResourceTemplate）；SSE 机制（1s store 轮询 diff revision 推送、15s 心跳注释行、连接清理）；只读 token 模型（env `DISPATCHER_HTTP_READ_TOKEN` ≥32 字符、独立凭据、不进 git）；board 页双挂载（MCP Apps iframe / present_files 内置浏览器）；与 V1 各章冲突检查（有冲突以蓝图为准修本文）。
4. P5-upgrade-plan §2 记录 HUMAN 拍板原文结论；§4 卡表状态推进。

## 测试与证据

- 蓝图↔IMPLEMENTATION 交叉读：新表面字段名、端点路径、认证模型三处一致。
- V1 已验收条目（A1–A8、§4/§7 语义）diff 级确认零改动。
- 新 SHA256 与 IMPLEMENTATION 头部引用一致。

## 验收

主控审读一致性 PASS；HUMAN 过目 v1.3 diff（需求级变更，留目视确认）。

## 禁止事项

禁改任何 `src/`、`test/` 文件；禁改 V1 已验收条目语义；禁把 P2 写成已承诺施工项；禁 commit/push；禁碰 `.workbuddy/` 与外部 Bridge。

## 回传格式

RESULT｜拍板结论记录位置｜改动文件清单｜v1.3 新 SHA256｜一致性自检清单（字段/端点/认证三处对齐证据）｜V1 语义零改动 diff 证据｜遗留风险。
