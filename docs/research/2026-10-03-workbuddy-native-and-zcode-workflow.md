# 调研报告：WorkBuddy 原生能力 × ZCode /workflow —— Dalizi-Dispatcher 可吸收清单

- 日期：2026-10-03
- 触发：实际使用中看到 WorkBuddy 原生渲染的「会自己走秒的进度看板卡」（CLIPProxyAPI 增强三连截图），视觉/实时性明显优于现有 `src/task-card.html`；另要求调研 ZCode `/workflow` 多代理调度能力吸收进 MCP 工具。
- 方法：两个并行子代理分别做文档爬取（workbuddy.cn / workbuddy.ai）与多轮 WebSearch（ZCode）；主进程独立核对本项目 `src/mcp-server.js` / `src/task-card.js` / `src/task-card.html` 现状后合成。
- 结论标注：✅=有直接证据（来源 URL）；⚠️=公开资料未覆盖，标注为空白。

---

## 0. 结论速览

1. **那张好看的看板卡，不是「另一个产品」，就是宿主原生渲染通道的产物**。WorkBuddy（与 CodeBuddy CLI 同源宿主）对 MCP Apps（`io.modelcontextprotocol/ui`，spec 2026-01-26）提供原生 iframe 沙箱渲染 + `structuredContent` 自动推送 + `host-context-changed` 主题热更新。我们的卡片已经走这条协议，**输的是视觉设计和刷新策略，不是协议通路**。
2. **「走秒」的正确姿势是本地计时器，不是高频轮询**。运行时长每秒刷新只需前端 `setInterval` 重算 `Date.now() - startedAt`；数据快照保持 3s 轮询即可（或升级 SSE 直连）。现卡已具备该数据字段，属纯前端改造。
3. **WorkBuddy 侧 Top 吸收点**：MCP Apps 推送模型、`connectDomains`+SSE 自持数据通道、`present_files(127.0.0.1)` 内置浏览器兜底看板、hostContext 主题/尺寸适配、免授权 `readServerResource` 读 + 弹窗 `callServerTool` 写。
4. **ZCode `/workflow` 是智谱自研 ADE 的动态工作流**（3.14.0 引入，TS 脚本 DSL + 子进程 vm 沙箱 + journal 断点续跑 + React 时间线/看板 UI）。对我们的核心启发是**数据契约**而非 UI：phase 进度计数（`nodesSettled/total`）、子代理 roster 状态视图（name/state/lastTool/usage）、`artifact.board` 看板预设、`report()` 即时上报、AmendWorkflow 增量重跑。
5. 落地建议按三期推进：**P0 纯前端视觉重构（1 张施工卡）→ P1 数据通道升级（SSE/board 聚合卡）→ P2 调度语义吸收（phase/report/journal，进蓝图 §11 演进项）**。

---

## 1. WorkBuddy 原生能力全景（五板块）

### 1.1 MCP Apps / 卡片渲染（核心）✅

来源：https://www.workbuddy.ai/docs/cli/mcp-apps （协议全文）；https://www.workbuddy.cn/docs/workbuddy/Conversation （桌面端落地）

- 协议扩展 `io.modelcontextprotocol/ui`，不改 MCP 核心；宿主只识别两处：工具 `_meta.ui.resourceUri`、资源 MIME `text/html;profile=mcp-app`。
- **UI Resource**：URI 必须 `ui://` 开头；`_meta.ui.csp.resourceDomains / connectDomains` 控外域白名单（未列出即被浏览器拦截）；`_meta.ui.permissions` 默认 `allow-scripts allow-same-origin allow-forms`；`prefersBorder` 控边框。
- **App Tool**：工具定义与 `CallToolResult` 两处都要带 `resourceUri`；`structuredContent` 由宿主**自动推送**给 iframe 作 `toolResult`。
- **沙箱**：跨域 sandbox iframe（srcdoc + 代理），经 `postMessage` 上的 JSON-RPC 通信，官方 SDK `@modelcontextprotocol/ext-apps`。
- **刷新模型 = 推送，无轮询**：① 模型每次调关联工具 → `ontoolresult` 自动推 iframe；② 主题切换不重建 iframe，只推 `host-context-changed`；③ widget 内按钮反向 `tools/call` 后局部刷新。
- **Guest→Host 能力表**（关键差异）：
  | 方法 | 授权 |
  |---|---|
  | `app.readServerResource` / `listServerResources` | **免授权（只读）** |
  | `app.callServerTool` | **每次弹窗授权**（`-y` 或会话级 Always allow 才短路） |
  | `app.createSamplingMessage` | 用宿主模型配置 |
  | `app.sendMessage` | 默认 `'send'` 注入主对话并触发 agent；`'fill'` 仅填输入框 |
  | `app.requestDisplayMode` | `inline / fullscreen / pip` 三态全支持 |
  | `app.sendSizeChanged` | 容器高度自适应 |
- **hostContext**：`theme / displayMode / styles（宿主 --cb-* CSS 变量集）/ containerDimensions / locale / toolInfo` 等。⚠️ 首帧 `ui/initialize` 返回空对象（`@mcp-ui/client@7.1.1` 已知行为），需两层回退：CSS `light-dark()` + JS `onhostcontextchanged` 锁定。
- **限制**：HTML >256KB 不预取；终端 TUI / `-p` 模式不支持 widget（回退 `content` 文本）；Web UI 与 IDE 内嵌 UI 支持。
- **桌面端挂载位**：对话内联 + **右侧产物区**两个位置。

### 1.2 show_widget / 内联可视化 ✅（本会话直接观测）

- 双工具协议：`widget_guidelines(modules)` 下发设计规范（5 模块：diagram/mockup/interactive/chart/art），`show_widget` 把**裸 SVG/HTML 片段**内联渲染进对话流（SVG viewBox 固定 `0 0 680`；图表走 Chart.js）。
- **一次性渲染，无原生刷新机制**——「活」的 widget 只能靠自身 JS（计时器/fetch），受 CSP 限制。与 MCP Apps 是**并行两套机制**，不承担实时进度看板。

### 1.3 任务 / 进度 / 通知 / 自动化 ✅

来源：https://www.workbuddy.cn/docs/workbuddy/Task-Management 、`.../Conversation` 、`.../Automation-Guide` 、`.../Right-Sidebar`

- 任务状态机：进行中/已完成/失败/待处理/规划中/已归档；侧栏聚合标记优先级**待确认 > 已完成未读 > 进行中**。
- 消息中心（铃铛）：`任务操作待您确认` / `任务已成功完成` 两类，点击跳转。
- 消息队列：执行中可继续排队发消息、可编辑/排序，不打断当前输出。
- 自动化（Automations）：本地配置 + 定时规则（周/月多天一条规则表达）+ 推送企微 bot / 小程序；无人值守执行。
- MCP 服务加载进度条：「正在连接 MCP 服务 x/y」实时更新，完成后消失不入历史。

### 1.4 子代理 / 多窗口协作 ✅

来源：https://www.workbuddy.ai/docs/cli/agent-teams

- 四原语：`TeamCreate / Agent / SendMessage / TaskCreate(Update)`；成员独立沙箱+独立上下文；完成后收到新消息**自动重启**。
- broadcast 的 token 随成员数线性增长（慎用）；无会话恢复、一会话一团队、不支持嵌套团队。
- 桌面端「专家团」：团长拆解→并行分发→整合交付。

### 1.5 其他对调度器有用的宿主能力 ✅

来源：https://www.workbuddy.cn/docs/workbuddy/Results 、`.../Right-Sidebar`

- **present_files**：统一产物入口，支持本地路径与 http/https；**localhost URL 打开内置浏览器预览**。铁律：预览必须走 HTTP（`file://` 下 fetch/SSE 全废），且**必须 `127.0.0.1`**（`localhost` 有 IPv6 假 404 风险）；WB Bash 沙箱内 `curl localhost` 不可达，仅内置浏览器与用户系统终端可达宿主网络。
- 右侧边栏四区：产物 / 工作空间文件 / 变更 diff / 内置浏览器（多标签、登录态持久、设备视口）。
- 连接器/技能市场、三层记忆体系、Ask/Plan/Craft 工作模式。

---

## 2. 拆解：那张「会走秒的看板卡」是怎么画的

截图（CLIPProxyAPI 增强三连）符合 MCP Apps App Tool 渲染特征，技术路径拆解：

| 视觉元素 | 实现机制 |
|---|---|
| 卡片容器+边框 | `prefersBorder: true` 或自带圆角卡片样式 |
| 整体进度条（T1 0/3） | `structuredContent` 里带聚合计数，前端算百分比 |
| 每任务一行状态徽章 RUNNING/QUEUED | 状态→徽章样式映射（与我们 badge 同思路，视觉更精致） |
| **每秒走秒的运行时长** | **纯前端 `setInterval` + `Date.now() - startedAt`，与数据轮询解耦** |
| `job id / pid / alive / 当前活动 tool_use` | 快照字段透出（我们 job-store 已有同构字段） |
| 底部「数据源 mcp__dlz__get_task · 看板同步 127.0.0.1:8319 · T1 计时每秒自刷新」 | 数据来源声明；同看板另有 localhost 直连通道 |
| 和 DLZ 卡片效果一致 | 说明 DLZ 窗口当时直接调了宿主原生渲染（widget/show_widget 类通道），而非自绘 HTML |

**两条官方认可的实时路径**（与我们相关）：

1. **MCP Apps 正规军**：`ui://` 资源 + 沙箱 iframe + `structuredContent` 推送 + 反向调用。适合可交互、要回写对话的卡。刷新频率受「模型调一次工具推一次」约束——模型侧不频繁调用时，需 widget 自己轮询（现方案）或自己连数据源。
2. **present_files 轻骑兵**：DLZ 本地 HTTP(SSE) 服务 + `present_files("http://127.0.0.1:<port>/board")` 打开右侧内置浏览器。零协议成本、SSE 原生实时、多标签、不受 256KB/沙箱限制。适合纯展示型看板。

---

## 3. 我们现状 vs 差距（证据锚点）

核对文件：`src/mcp-server.js`（L111-134）、`src/task-card.js`、`src/task-card.html`

| 维度 | 现状 | 差距 |
|---|---|---|
| 协议通路 | ✅ 已是 MCP Apps：`ui://dalizi-dispatcher/task-card.html` + `text/html;profile=mcp-app` + resource handler（mcp-server.js L111-134） | 无差距，通路正确 |
| 刷新 | 3s 定时反向调 `get_task`（task-card.html L61、L77） | 走秒未与轮询解耦；未利用 `structuredContent` 自动推送（dispatch/get_task 返回后宿主会免费推一次） |
| 视觉 | 表单风 dl 列表 + badge | 无进度条、无子任务分组卡、无聚合视图；未消费宿主 `styles`（`--cb-*`）与 `containerDimensions` |
| 主题 | `color-scheme: light dark` + CSS 变量回退 | 未接 `onhostcontextchanged` 热更新 |
| 数据通道 | 仅 MCP 反向调用 | `csp.connectDomains: []`（task-card.js L10）——**即使想 SSE 直连本地端口，现在会被自家 CSP 拦死**，这是硬瓶颈 |
| 挂载位 | 对话内联 | 未利用「右侧产物区」挂载 + `requestDisplayMode('fullscreen')` 看大板 |

---

## 4. ZCode `/workflow` 调研（智谱 ADE 的动态工作流）

来源：https://zcode.z.ai/cn/docs ；https://github.com/zai-org/ZCode （Apache-2.0 开源）；DeepWiki（源码派生）3.1/3.2/3.4；https://bingqiangzhou.github.io/posts/zcode-dynamic-workflow ；https://blog.gitcode.com/1ea8f6f757c238e8875966a38b2b53a8.html

**产品定位**：智谱 AI 自研 Agentic Development Environment（桌面 Electron 为主，另含 web/TUI/CLI），自研 harness 深度适配 GLM-5.3；`/workflow` = **动态工作流**（v3.14.0，2026-09 引入）。⚠️ 注意同名混淆（`simonyos/Z-CODE` 无关）。

### 4.1 机制要点

- **触发**：`/workflow` 命令或自然语言点名「用工作流」；点名即约束（必须走 CreateWorkflow），不点名不启动。可运行已保存 workflow。
- **定义**：主 Agent 现场写 **TypeScript 脚本**提交给 `CreateWorkflow`（inline/saved/path 三选一）；编译期禁 import、禁 `process/fetch/fs/Date.now/Math.random`（保证可重放）；顶层 await + 最终 return。
- **DSL 原语**：`agent(name, persona)`（每次调用=全新持久上下文）、`ask<T>(instructions)`（类型化派活，T 为 interface 时运行时合成 JSON Schema）、`phase("…")`（用户可见里程碑）、`world.run(cmd)`（真实命令裁决）、`files.*/git.*`（只读观察，journal 化）、`report(item, id)`（即时上报）、`artifact.file/markdown/chart/table/metrics/board`（交付物+看板预设）、`log/args`。
- **并行**：`Promise.all` 扇出；同一子代理的并发 ask FIFO 串行；`max_concurrency` 只控并发槽数、**运行中可原位调优**（不停不重跑）；引擎内自适应 ConcurrencyController，模型侧错误（限流/过载）不进脚本、无限重试自适应扇出。子代理不允许嵌套 workflow。⚠️ 并发数值上限未公开。
- **汇总**：`report` 即时上报（失败 run 也带出）；artifact 面向用户（`primary: true` 标主件）；return `WorkflowReport{conclusion, findings(evidence+verified 标记), verified, notCovered}` 面向主代理。限幅：report ≤256 条/run、artifact ≤32 个/run 等。
- **看板 UI**：React 组件非纯文本——`WorkflowTimeline`（水平时间线：phase=station、agent=pill，纯 DOM+一层 SVG，>6 个 pill 折叠）+ `WorkflowRunPhaseList`（垂直 spine：phase=灯、agent=灯右侧 pills，运行中 phase 自动展开，Agent Roster pin 住 failed/asking 状态）。
- **子代理状态契约**（`workflowRuns`）：`subagents[]{siteId, ordinal, name, state, instructionsHead, lastTool}` + `health{concurrency, stalled}` + `usage{tokens, nodes observed/running/completed/failed}` + `phases[]{state, rounds, nodesSettled, nodesRunning}`。高频状态更新+journal 持久化。⚠️ 底层推送通道（WS/SSE/轮询）未公开。
- **高级特性**：journal 断点续跑（`ResumeWorkflowRun` 对 stopped run 原样续跑，`(siteId, ordinal)` journal 短路 + `inputHash` 校验保证 replay 逐字一致）；`AmendWorkflow` 运行中修订——按命名子代理逐条 byte 匹配 ask 指令，**零 token 导入已完工工作**只重跑改动部分；人工介入 escalation（每 ask ≤3 次，`ResolveWorkflowQuestion` 回答；兄弟子代理不代停摆者超时）；`SaveWorkflow`（project 作用域 `.zcode/workflows/<name>.dwf.ts` 随仓库提交 / global 作用域）；脚本在子进程+vm 沙箱执行、NDJSON 桥回引擎。

---

## 5. 吸收清单（按优先级映射到施工）

### P0 — 纯前端卡片视觉重构（只改 `task-card.html`，1 张施工卡）

| # | 吸收点 | 来源 | 动作 |
|---|---|---|---|
| P0-1 | 走秒与轮询解耦 | 截图实证 | `elapsed` 改 `setInterval` 前端自算，`startedAt` 从快照取 |
| P0-2 | 进度条 + 任务分组卡 | 截图 + ZCode phase 计数 | 聚合头部进度条（完成/运行/排队计数）；多 job 视图改为每任务一行卡+状态徽章 |
| P0-3 | 消费宿主主题/样式 | MCP Apps hostContext | `onhostcontextchanged` 热更新 + 尽量取宿主 `styles` 的 `--cb-*` 变量，视觉与宿主一致 |
| P0-4 | 状态徽章体系 | 截图（RUNNING/QUEUED 灰蓝双色） | RUNNING 蓝点+高亮边、QUEUED 灰、FAILED 红、COMPLETED 绿；运行中行加浅色高亮 |

### P1 — 数据通道升级（改 `task-card.js` meta + `mcp-server.js`，需评估 SSE 端点归属）

| # | 吸收点 | 来源 | 动作 |
|---|---|---|---|
| P1-1 | `connectDomains` 解禁 | MCP Apps csp 机制 | 白名单加 `http://127.0.0.1:<port>`，否则 widget 内 fetch/EventSource 全被自家 CSP 拦截 |
| P1-2 | SSE 直连进度流 | WorkBuddy 无原生轮询推送的结论 | dispatcher 暴露只读 SSE 端点（现 http-mcp-server 基础上扩 `/events`），卡片订阅实时刷新；MCP 反向调用降级为兜底 |
| P1-3 | 聚合看板卡（多 job board） | ZCode `artifact.board` BoardSpec | 新增 `render_board` App Tool：按 status 分列（列序可声明），每卡一 job，`key` 幂等更新 |
| P1-4 | 子代理 roster 视图 | ZCode `subagents[]{name,state,lastTool}` | 卡内嵌套显示 CLI 子进程级状态（agent/model/pid/alive/当前活动——我们 job-store 已有同构字段） |
| P1-5 | 大屏兜底通道 | present_files + 内置浏览器 | 看板页支持 `present_files("http://127.0.0.1:<port>/board")` 打开右侧浏览器全功能版（SSE、多标签）；注意必须 `127.0.0.1` 非 `localhost` |
| P1-6 | 免授权读 | `readServerResource` 免授权 | 只读查询（任务详情）迁到 `resources/read`；写操作（重试/取消）保留 `callServerTool` 接受弹窗授权 |

### P2 — 调度语义吸收（进蓝图 §11 演进项，不动 V1 收官基线）

| # | 吸收点 | 来源 | 对 DLZ 的映射 |
|---|---|---|---|
| P2-1 | phase 里程碑 + 进度计数 | ZCode `phase()` + `nodesSettled/total` | dispatch 任务可声明 phase 列表，快照透出每 phase 完成度，看板按 phase 分组 |
| P2-2 | `report()` 中间结果上报 | ZCode journal 化 report | CLI runner 解析 stream-json 中间事件透出到快照（现只有 current_activity 粒度），失败也带出 |
| P2-3 | 结果契约四字段 | ZCode `WorkflowReport{conclusion,findings,verified,notCovered}` | job 最终结果结构化分层：结论/证据/已验证范围/未覆盖范围——验收型任务直接受益 |
| P2-4 | 增量重跑思想 | ZCode `AmendWorkflow` 零 token 导入已完工工作 | 失败重试按子任务粒度短路已完成部分（与现有 idempotency-index/recovery 机制同族，可扩展） |
| P2-5 | 人工介入 escalation | ZCode 每 ask ≤3 次 + 不阻塞兄弟任务 | 卡片上加「需要确认」状态位 + `sendMessage('fill')` 预填输入框让 HUMAN 决策 |
| P2-6 | 并发自适应 | ZCode ConcurrencyController | dispatcher 队列并发槽位自适应（限流/过载退避），现固定并发策略的演进项 |

### 明确不建议吸收

- `show_widget` 承载实时进度：一次性渲染、无刷新机制，与需求错配。
- ZCode 整套 TS DSL/沙箱引擎：体量远超 DLZ 定位（DLZ 是「MCP→本地 CLI」薄调度器，不是 ADE）；只取数据契约与 UI 语义。
- WorkBuddy Agent Teams 原语替换 DLZ 多窗口协作：与现有 ASK-DLZ 控制面 + 多窗口纪律冲突，维持现状。

---

## 6. 证据与空白

**已核实（主要来源）**

- MCP Apps 协议：https://www.workbuddy.ai/docs/cli/mcp-apps
- 桌面端行为：https://www.workbuddy.cn/docs/workbuddy/Conversation
- Agent Teams：https://www.workbuddy.ai/docs/cli/agent-teams
- 任务/自动化/侧栏：https://www.workbuddy.cn/docs/workbuddy/Task-Management 等（workbuddy.cn 文档站）
- ZCode 官方：https://zcode.z.ai/cn/docs ；开源仓库 https://github.com/zai-org/ZCode
- ZCode 源码派生：DeepWiki 3.1/3.2/3.4（deepwiki.com/zai-org/ZCode）
- ZCode 动态工作流实操：https://bingqiangzhou.github.io/posts/zcode-dynamic-workflow
- 本项目现状：`src/mcp-server.js` L111-134、`src/task-card.js` L10、`src/task-card.html` L61/L77（直接读码核对）

**公开资料空白（⚠️）**

1. ZCode `max_concurrency` 数值上限。
2. ZCode 看板底层推送通道（WS/SSE/轮询）。
3. ZCode `/workflow` 无独立官方文档页（疑由 dynamic-workflows skill 承载）；各来源版本号有出入，以 zcode.z.ai 实时页面为准。
4. MCP Apps widget 反向调用在 WB 桌面端的弹窗授权细节（`-y`/Always allow 之外是否有会话级记忆）需 live 验证。

---

## 7. 追加核查（2026-10-03 13:50）：两个决策问题的证据答复

### 7.1 ZCode 工作流是否开源？能不能拿来合并？——**开源，但只有「纯引擎」可搬，整体合并不划算**

**开源事实（已核实）**
- 仓库：https://github.com/zai-org/ZCode ；**Apache-2.0**（标准全文，无附加条款），版权 `Copyright 2026 Z.AI Co., Ltd`；另有 `NOTICE.md`（内容为数据流/权限/风险说明，非额外许可）与 `THIRD-PARTY-NOTICES.md`（第三方依赖独立条款）。
- 开源时间 2026-09-20（`feat: open source`），当前 v3.14.3。⚠️ 信任面提示：main 分支**仅 3 个压平 commit**，无完整历史（背景为 2026-09「静默打包上传工作区快照」事件后的补救性开源）。
- **npm 上不存在可安装包**：`@zcode/dynamic-workflow`、`@zcode/dynamic-workflow-runtime` 在仓库内均 `"private": true` 且 `version 0.1.0`，npm registry 实测 404。只能以**仓库源码**形态复用（按根 Apache-2.0 处理）。

**工作流代码在仓库里的分层与耦合度（关键）**

| 层 | 路径 | 耦合度 | 能否搬 |
|---|---|---|---|
| 引擎核心 `@zcode/dynamic-workflow` | `apps/zcode-cli/packages/dynamic-workflow` | **弱**（pure：无 IO/无 session，只依赖 `typescript`） | ✅ 可搬 |
| 沙箱运行时 `@zcode/dynamic-workflow-runtime` | 同层 `.../dynamic-workflow-runtime` | **弱**（自述 app-free，仅依赖引擎包 + node 内建；子进程 + `vm.createContext` + NDJSON 桥） | ✅ 可搬 |
| 工具契约 / `workflowRuns` 状态协议 | `packages/contracts/src/tools/create-workflow.ts`、`packages/shared/src/zcode-protocol-v4/workflow-runs*.ts` | **中**（绑 ZCode Protocol V4 事件/归约模型） | ⚠️ 只能借鉴字段 |
| 生产驱动（真正跑起来的链路） | `packages/bootstrap/src/app/script-workflow-*.ts`、`adapters/src/storage/.../script-workflow-*.ts` | **强**（需 SQLite journal、模型 runner、权限服务、MCP 装配） | ❌ |
| 看板 UI | `packages/ui/src/components/workflow-timeline/*`、`app-shell/WorkflowRunPhaseList.tsx`（React + Zustand） | **强**（React 应用层） | ❌ |

**许可证合规义务（Apache-2.0 §4）**：分发须附 LICENSE 副本、修改文件加醒目「已修改」声明、保留版权/署名声明、含 NOTICE 须一并携带；**§6 不授予商标许可**——不得以「ZCode / Z.AI」名义推广。

**工程可行性结论**
- 只 vendor **纯引擎（+可选 runtime）**：成本**低—中**。但它仍是 **TypeScript workspace 包**（`private`、有 `tsconfig` 与 `libs.generated.ts` 构建产物），搬进 DLZ 意味着**引入构建步骤**——与 DLZ「纯 Node ESM、无构建」的现状冲突；且引擎的 actor 抽象面向「模型驱动的子代理会话」，而 DLZ 的执行体是「CLI 子进程」，需要自写 `WorkflowDriver` 适配，语义并非直接对齐。
- 搬**完整体验**（驱动 + Protocol V4 + SQLite + React 看板）：成本**高**，等于把 ZCode 宿主骨架拉进来，违背 DLZ 薄调度器定位。

**判定：不做整体合并；以「借鉴」为主。**
1. 借鉴数据契约：`workflowRuns` 的 run/actor/node/phase 词汇与有界载荷设计，直接对齐 DLZ 的任务/进度快照协议（零代码依赖）。
2. 借鉴执行隔离：子进程 + `vm` + NDJSON host 桥，与 DLZ「MCP 工具 → 本地 CLI 子进程」同构，可作多子任务编排/进度上报的架构参考。
3. 若确需引擎本体：**选择性 vendor 纯引擎包 + 自写面向 CLI 子进程的 Driver**（须接受构建步骤），并履行 Apache-2.0 合规。

### 7.2 要不要给 DLZ 加「桌面插件」去覆盖宿主左下角资讯/广告区？——**不要；宿主 UI 覆盖不合规也不可行，但「类原生独立窗口看板」可行且推荐**

**A. WorkBuddy 官方扩展点不含 UI**
- 插件体系（`.codebuddy-plugin/plugin.json`）组件类型固定为 **Skills / Agents / Hooks / Commands / MCP Servers / LSP Servers**，**无任何面板/窗口/侧边栏字段**。最接近视觉的 `outputStyles`（文本输出样式）与 `experimental.themes`（CodeBuddy 识别但不加载）**都改不了 UI**。来源：https://www.workbuddy.ai/docs/cli/plugins 、`.../plugins-reference`
- 宿主界面区域（工具栏/侧边栏/对话区/右侧结果区）为**固定内置**，第三方无注入机制。来源：https://www.workbuddy.cn/docs/workbuddy/Overview 、`.../Results`

**B. 覆盖左下角资讯/广告区：无官方途径，注入式=违规**
- WorkBuddy 桌面端确为 **Electron 37.10.3**（只读观察：`D:\2-ruanjian\WorkBuddy\LICENSE.electron.txt`、`version`=37.10.3-24、`resources/app.asar` 317MB、`qimei.dll`/图灵盾 `TuringShieldSDK.dll`）。技术上确可用 `--remote-debugging-port` + CDP 注入 CSS/JS 改 UI（社区先例：AnonBuddy Skin，自述非官方、不改 asar、重启即失效），**但**：
  - 命中《腾讯云 WorkBuddy 软件许可及服务协议》https://rule.tencent.com/rule/202603180001 **9.2(1)(2)(4)(6)(8)**——反编译/突破技术保护措施/修改遮掩官方标识/修改运行中指令数据变更功能与输出，及 **3.3.2** 未明示授权保留；后果见 **9.4.1**（警告→限制→封禁→注销）。
  - 升级即失效、依赖内部 DOM 与 `--cb-*` 变量、需开调试端口（同用户下他程序可连入）、图灵盾对抗。
  - **产品化不可接受**，不作为路线。
- 参考：协议对官方 **Skill** 是「风险提示+自担责任」（3.1.2），**不禁止**——所以走官方扩展点安全，注入不安全。

**C. MCP Apps 也满足不了「常驻窗口」**
- 只能在**对话内联**或**右侧产物区**渲染 iframe；`displayMode` 的 `inline/fullscreen/pip` 全在宿主窗口内，**无 OS 级独立/常驻窗口**；历史 widget 不自动重载（点击才加载）。来源：https://www.workbuddy.ai/docs/cli/mcp-apps

**D. 可行替代路线对比**

| 路线 | 额外运行时 | 形态 | 常驻 | 类原生 | 合规 |
|---|---|---|---|---|---|
| a. `present_files(127.0.0.1)` 内置浏览器 | 无 | 宿主右侧浏览器页签 | ❌ | ❌ | ✅ |
| **b. DLZ 自研独立桌面壳（Tauri / WebView2 托盘+置顶无边框窗）** | Tauri/WebView2 | **独立 OS 窗口/托盘** | ✅ | ✅ | ✅ |
| c. Windows 托盘/置顶小窗/Win11 Widgets | WebView2/WinUI | 托盘/悬浮窗 | ✅ | ✅ | ✅（Widgets 成本高、不真常驻） |
| d. 浏览器扩展/独立浏览器窗口 | 浏览器 | 标签页 | 半 | ❌ | ✅ |
| e. 宿主内注入 | 需 CDP 端口 | 篡改宿主 UI | 半 | ✅ | ❌ |

**判定：推荐路线 b。** DLZ 侧只需新增一个只读 **SSE 端点 + 静态看板页**，桌面壳用 **Tauri（体积小、复用系统 WebView2、原生支持托盘/置顶/无边框）** 或 Node+WebView2 加载 `http://127.0.0.1:<port>/board`，与 WorkBuddy **并行进程、互不侵入**；MCP 工具里可加一个 `present_files` 快捷入口作「一键在 WorkBuddy 内打开」的补充。**不推荐**宿主注入（违规+脆弱）、不推荐把 MCP Apps 当常驻看板（做不到）、Win11 Widgets 成本高且不真常驻。

**新增来源**：https://github.com/zai-org/ZCode （含 LICENSE / NOTICE.md / README / 各 package.json）；https://deepwiki.com/zai-org/ZCode/3.1-dynamic-workflow-engine ；https://www.workbuddy.ai/docs/cli/plugins 、`.../plugins-reference` 、`.../mcp-apps` ；https://www.workbuddy.cn/docs/workbuddy/Overview 、`.../Results` ；https://rule.tencent.com/rule/202603180001 ；https://github.com/2939332182/anonbuddy-skin

---

## 8. 复盘：已有知识 + WorkBuddy 原生边界 → 可做到什么程度（2026-10-04）

### 8.0 已有知识资产盘点

| 资产 | 状态 | 证据锚点 |
|---|---|---|
| V1 调度器本体 | **已收官 PASS**（A1–A8 全绿，npm test 176/176，生产 PID 29116 看门狗托管） | 工作区 MEMORY.md 进度基线 |
| MCP 工具面 | `dispatch_task` / `get_task` / `render_task_card` 三工具 + task-card 资源 | `src/mcp-server.js` L82-134 |
| 任务卡实现 | MCP Apps 合规（协议 2026-01-26、`ui/initialize` 握手、tool-input/tool-result 处理、teardown 响应、revision 防旧快照、查询失败保留快照、结果缩略/展开、诚实展示 null≠0） | `src/task-card.html` 全文 |
| 数据面 | job-store 快照含 agent/project/elapsed/current_activity/requested_model/effort/liveness/usage/activity（含 observed_at） | `src/task-card.html` L136-200 |
| 调研知识 | WB 原生能力全景（§1-2）、ZCode 机制与可复用分层（§4、§7.1）、桌面路线决策（§7.2） | 本报告 |

### 8.1 WorkBuddy 原生能力边界（对上界起决定作用的硬事实）

| # | 边界事实 | 证据 | 对上界的影响 |
|---|---|---|---|
| B1 | **宿主不推数据**：`toolResult` 只在「模型本次调用触发该 widget 工具」时推送；无定时推、无 `resources/updated`、无 subscribe | workbuddy.ai/docs/cli/mcp-apps；spec 2026-01-26 | 实时只能 widget 侧拉 |
| B2 | **两条拉取通道的授权差异是核心杠杆**：`resources/read` = 免授权安全 GET；`callServerTool`/手写桥 `tools/call` = 默认每次弹窗，仅 `-y`/BypassPermissions 或会话级 Always allow 短路；**`settings.json` 的 `permissions.allow` 对 widget 反向调用无效**（独立审批通道 `_codebuddy.ai/mcpUiCallTool`） | 同上文档原文 | 我们现在的轮询走 `tools/call`，**每 3 秒都在踩审批通道** |
| B3 | **CSP 默认全断**：`connectDomains` 空 = widget 内无法访问任何外部/回环地址；WS 在申报范围内，**SSE 无文档背书需实测**；CSP 以 iframe `<meta>` 注入，HTML 自带 meta 优先 | spec 注释 + WB 文档；`src/task-card.js:12` 现为空数组 | widget→127.0.0.1 直连需先补申报 |
| B4 | **无常驻、无 OS 级窗口**：只能对话内联或右侧产物区；`inline/fullscreen/pip` 全在宿主窗口内；**历史对话刷新后 widget 不自动重连**（placeholder，点击才加载） | WB 文档 + workbuddy.cn Conversation | 回看旧对话时实时性不复现 |
| B5 | 体积/内联：HTML >256KB 降级为只传 resourceUri（多一 RTT）；inline 只给 `maxWidth/maxHeight`，**必须自行上报 `size-changed` 否则被截断** | WB 文档 + spec | 我们卡片目前未发 size-changed |
| B6 | 官方无 UI 插件体系（仅 Skills/Agents/Hooks/Commands/MCP/LSP）；覆盖宿主 UI = 注入式，触协议 9.2 多条 | §7.2 已列 | 宿主内 UI 只能长在 MCP Apps 位与右侧产物区 |
| B7 | 手写 postMessage JSON-RPC 桥 = 协议本体，官方 SDK 非必需；SDK 多出 ResizeObserver 自动上报/类型封装，均可手写补齐 | spec + SDK 文档 | 无 SDK 迁移负担 |

### 8.2 判定：三个位面的可达上限

**位面 1：宿主内 MCP Apps 卡片（零新运行时，改现有 HTML/JS 即可）——可达到「和截图同级」的体验**

| 维度 | 上限 | 手段 |
|---|---|---|
| 视觉 | **完全追平**截图观感（进度条/任务行/徽章/走秒） | 前端重构：`setInterval` 走秒与轮询解耦、聚合进度条、RUNNING/QUEUED 徽章体系、消费宿主 `--cb-*` 变量与 `host-context-changed` |
| 数据实时性 | **1–2 秒级**刷新的上限 | **关键改造：轮询通道从 `tools/call` 迁到 `resources/read`（dlz JSON 资源，免授权）**——绕过审批弹窗后可大胆提频；`get_task` 工具调用降级为初始装载与兜底 |
| 交互 | 反向操作（刷新/展开/跳全屏）齐备；写操作（重试/取消）每次弹窗（或会话 Always allow 后静默） | 已具备；写操作接受弹窗成本 |
| 持久性 | **上限即瓶颈**：当前对话内活着时全量实时；旧对话回看不复现；同对话可挂多卡（无文档化数量上限，但宿主持「避免同时挂 dozens of iframes」设计） | B4 |
| 极限 | 真 SSE 流式（<1s、服务端推送）**无文档背书**，需 live 实测；直连 127.0.0.1 需补 `connectDomains`（WS 可行、SSE 待验） | B3 |

**位面 2：宿主内右侧浏览器看板（`present_files(127.0.0.1)`）——本地 HTTP/SSE 原生可用，完全实时**

- 形态：宿主右侧产物区/浏览器页签，SSE/WebSocket **原生可用**（不受 MCP Apps 沙箱 CSP 管辖），无 256KB 阈值，多标签。
- 上限：**完全实时的多任务聚合看板**（全 job board、按状态分列、历史任务检索）；但**生命周期绑宿主**（切走对话即不可见），无常驻。
- 这是「展示型实时」的最优宿主内解，与位面 1 互补：卡片负责「跟着任务走的上下文」，看板负责「全局一屏」。

**位面 3：宿主外独立桌面壳（Tauri/WebView2 托盘+置顶无边框窗）——无边界，可达真原生体验**

- 常驻、置顶、多屏/DPI、开机自启、SSE 全推；与 WB 并行进程、零合规风险（§7.2）。
- 代价：新工程、新运行时、需分发。属「产品形态升级」而非「卡片改造」。

### 8.3 明确不可达（无论怎么改代码）

1. 宿主 UI 内做**常驻/独立窗口**（B4/B6）——MCP Apps 与注入两条路都堵死。
2. **服务端推送**驱动的实时（B1）——宿主不推，只能 widget 拉；位面 2/3 本质也是客户端连本地服务，绕过 B1 而已。
3. 免弹窗的**写操作**（B2）——widget 反向写必须过审批通道。
4. 跨会话的 widget 自动重连（B4）。

### 8.4 最优组合与下一步

**推荐组合：位面 1（重建卡片）+ 位面 2（SSE 看板）为「一期」，位面 3 视需求另立工程。**

一期内性价比最高的三个改造（按收益排序）：
1. **轮询迁 `resources/read`（免授权）**——把数据刷新从审批通道挪到安全 GET，1–2 秒级刷新不弹窗，这是上限解锁的总闸门；
2. 卡片视觉对齐截图（走秒解耦 + 进度条 + 徽章 + 宿主主题变量）+ 补 `ResizeObserver→size-changed` 防截断（B5）；
3. dispatcher 加只读 `GET /events`（SSE）+ 静态 board 页，`present_files(127.0.0.1)` 一键打开。

⚠️ 待 live 验证项（决定 board 在 widget 内直连能否替代轮询）：SSE 从 MCP Apps iframe 连 127.0.0.1 是否被 CSP 放行（WS 已文档可行）；`resources/read` 在 WB 桌面端是否对 job JSON 资源同样免授权。
