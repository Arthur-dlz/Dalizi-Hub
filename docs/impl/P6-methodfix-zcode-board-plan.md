# P6 剩余工作计划：resources/read 线名修复部署 + ZC1 ZCode 风格看板重构

日期：2026-10-05 ｜ 主控编制 ｜ 状态：Phase A 待部署（门禁已绿），Phase B 待窗口施工
触发：HUMAN 截图实证——聊天窗看板轮询报 `Method not found`（宿主不认 `app.readServerResource`）；HUMAN 要求「最次 WB 原生渲染，最好 ZCode UI」。官方 SDK 源码实锤：线名 = `resources/read`（`app.readServerResource` 仅是 SDK 库入口名），修复已在工作树 + 206/206 绿。

## 1. 背景事实（已核实）

- **bug**：CH1/CH3 把 SDK 库方法名 `app.readServerResource` 当线协议方法名发 → WB 宿主报 `Method not found` → 单任务卡一直走 tools/call 降级（会话 Always allow 所以无弹窗，A10 的「无弹窗」是降级路径的假象）；看板 widget 轮询彻底失败。
- **修复**：`send('resources/read', { uri })`（params 标准 MCP 形状，响应 `{contents:[{text}]}`——解析层早已按此实现，零改动）。改动：`src/task-card.html`（2 处调用+注释）、`src/board.html`（1 处调用+注释）、`test/task-card.test.js`（断言+注释）。证据：`@modelcontextprotocol/ext-apps@2.0.3` app-bridge.js 源码（`resources/read` handler + 原样转发 MCP 服务器）+ WB 官方文档「readServerResource(params) → JSON-RPC method `resources/read`」。
- **另一现象**：截图标题「大力子看板」（"大力子"系"大狸子"历史误写，保留当时现象原样）= 宿主按对话缓存 ui:// 资源（昨晚旧对话），**新对话调 render_board 即新内容**，非 bug。
- **验收窗口遗留**：ZCode UI 诉求——`WorkflowTimeline`/`WorkflowRunPhaseList` 视觉语言（调研 §4.1：水平时间线 phase 站/pill 折叠、垂直 spine 组灯、运行中展开、roster 钉住 failed/asking）。

## 2. 相位划分

```text
Phase A（主控，10 分钟）：第三次看门狗舞蹈——部署 resources/read 修复 → 冒烟 → HUMAN 快速目视
Phase B（执行窗口）：ZC1 卡——board.html ZCode 风格 UI 重构（纯前端，数据通道零改）
Phase C（主控）：第四次舞蹈——部署 ZC1 成果
Phase D（HUMAN）：live 四连验收
```

## 3. Phase B 卡（← 执行窗口唯一施工依据）

见 `docs/impl/cards/ZC1-p6-zcode-board-ui.md`。要点：`src/board.html` + `test/task-card.test.js` 单写拥有；数据通道（EventSource/polling/tool-result/降级/`setChannel` 诚实标注）一行不动；ZCode 视觉语言映射 DLZ 语义（阶段带=QUEUED/RUNNING/终态、job=pill/行卡、非终态置顶+终态窗口收拢）；无新依赖；视觉形态给 HUMAN 迭代空间。

## 4. 冲突与纪律

- ZC1 拥有 `src/board.html` + `test/task-card.test.js`（board 断言区）；其余只读。Phase A 部署与 Phase B 施工**可并行**（A 是运维动作，B 是文件改动，但 **Phase C 部署前 B 必须已 PASS**）。
- 施工窗口：禁 commit/push、禁启停服务/看门狗、禁碰 `.workbuddy/` 与外部 Bridge、禁读凭据、禁动 task-card.html/task-card.js/mcp-server.js/http-mcp-server.js/job-store.js/dispatcher.js。
- Phase A/C 部署规程同 OPS3（摘狗→停桥→启狗自愈→冒烟；bridge 脚本留 `.bak` 惯例）。
- `resources/read` 修复与 ZC1 成果都将由 Phase C 同台部署——ZC1 只需保证全量绿 + 工作树合入，不需要中间部署。

## 5. 验收口径

- Phase A：生产 PID 变更 + 端点冒烟矩阵 + **HUMAN 目视**：新会话 dispatch→render_task_card（自动刷新期间无弹窗、卡片走秒正常）；render_board 在看不到弹窗情况下刷新（资源轮询通道）或指示 SSE。
- Phase B：`npm test` 206+ 全绿、在码断言全过、回传 RESULT 格式。
- Phase C：部署冒烟 + 浏览器看板（present_files）正常。
- Phase D：HUMAN 目视 ZC 版看板（视觉迭代至少 1 轮）+ 原功能回归（走秒/徽章/通道标注/终态窗口 50 条）。
