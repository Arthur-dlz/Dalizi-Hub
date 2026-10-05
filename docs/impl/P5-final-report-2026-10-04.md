# P5 迭代总报告（P5a + P5b）

日期：2026-10-04 ｜ 指挥窗口：主控（HUMAN 不在场，自主指挥）｜ 依据：`P5-upgrade-plan.md` + 六张施工卡 + ASK-DLZ 控制面

## 0. 总判定

**P5a / P5b 全部施工与独立验收完成：UX1 / DOCS2 / CH1 / CH2 / CH3 五卡全 PASS，最终全量测试 205/205（基线 176，净增 29 例；唯一门禁抖动例为环境性 EBUSY，单跑复证绿，见 §6）。零 commit、零越界、HUMAN 未提交 hunk 全程原样。P5c（OPS3 生产部署）与全部 live 目视项按授权边界挂起等 HUMAN。**

## 1. 各卡 RESULT 摘要（主控独立验收，非窗口自报）

| 卡 | RESULT | 关键证据指针 |
|---|---|---|
| UX1 卡片视觉重构 | **PASS** | 走秒 1s 计时器 `task-card.html:218`、host-context-changed `:550`、ResizeObserver/size-changed `:337-346`、徽章五态 `:33-40`；定向亲跑 23/23 |
| DOCS2 蓝图 v1.3 | **PASS** | 蓝图纯增 48 删 0（V1 语义零改）、新 SHA `A9F16789…`（复算一致，双处记录）、蓝图↔IMPLEMENTATION 字段/端点/认证三处对齐；顺带 remediate 旧锁账实不符（见 §6） |
| CH1 资源通道 | **PASS** | `dlz://job/{job_id}` ResourceTemplate 注册 `mcp-server.js:141-158`、卡片资源优先+永久降级 `task-card.html:519/528`；定向亲跑 mcp 5/5 + task-card 28/28 |
| CH2 SSE/board | **PASS** | 三只读路由 `http-mcp-server.js:17-20,232-247`、timingSafeEqual 定长比较 `:59-64`、token 不进日志/错误体 `:66-73`、`listBoard` 纯只读 `dispatcher.js:160-186`；本地实例 curl 三端点取证（端口 18777，用完即杀）；定向亲跑 http-mcp 4/4 + dispatcher 14/14 |
| CH3 render_board | **PASS** | render_board 工具 `mcp-server.js:231-267`（readOnlyHint、structuredContent `{jobs,board_url,read_token,generated_at,notice}`、未配置 token 显式降级）、`dlz://board` 资源 `:215-229`、board UI meta connectDomains 恰好一个 origin `task-card.js:26`、单任务卡 meta 零改动 `:21`、双通道降级 `board.html:366-483`；静态文件零 token 字面量（grep 实证）；定向亲跑 mcp 8/8 + task-card 37/37 |

验收方式（每卡五条全过）：归属核对（git status 对照基线）／亲跑定向测试／grep 在码／红线扫描（无 commit、HUMAN hunk 内容级核对、未碰 `.workbuddy/` 与外部 Bridge、未碰生产 18490）／契约对齐审读（DOCS2）。

## 2. 测试计数

- 基线（会话开工快照）：**176/176**（HEAD `dc10a81`）
- 波次门禁（主控统一跑，全量串行——原因见 §6）：
  - Wave 1（UX1+DOCS2 后）：**181/181 绿**
  - Wave 2（CH1+CH2 后）：193 例，191 过，2 失败（均环境抖动，单跑 19/19 复证绿）
  - Wave 3（CH3 后）：**205 例，204 过，1 失败**（环境 EBUSY，单跑 29/29 复证绿）
- **净增用例 29**：UX1 +5（走秒/主题/size-changed/徽章）、CH1 +6（资源同形/错误路径/双路径/降级/revision）、CH2 +6（listBoard 契约与截断/404-401-200 矩阵/SSE 三机制）、CH3 +12（render_board 契约三态/board meta/双通道降级/浏览器态等价等）
- 每卡定向测试均由主控亲跑复验，计数与窗口自报一致

## 3. 工作树状态（改动文件全清单，未 commit）

 tracked 修改（12）：

| 文件 | 归属 | 内容 |
|---|---|---|
| `src/task-card.html` | UX1 + CH1 | 视觉重构 + 资源双路径 |
| `test/task-card.test.js` | UX1 + CH1 + CH3 | 37 例 |
| `src/mcp-server.js` | **HUMAN hunk** + CH1 + CH3 | VERIFIED_CODEX_MODELS hunk 与 CH1 增量原样保留，追加 board 资源/工具 |
| `test/mcp.test.js` | CH1 + CH3 | 8 例 |
| `src/dispatcher.js` | CH2 | 纯增量：`listBoard()` + 边界常量 + 二分截断 |
| `src/http-mcp-server.js` | CH2 | +165：只读路由族 + D1-a 认证 + SSE |
| `src/task-card.js` | CH3 | +20：board UI 资源 meta（单任务卡 meta 零改动） |
| `test/dispatcher.test.js` | CH2 | 14 例 |
| `test/http-mcp.test.js` | CH2 | 4 例 |
| `README.md` | **HUMAN 未提交改动** | 全程原样未动 |
| `docs/impl/IMPLEMENTATION.md` | DOCS2 | §9 P5 章 + 头部引用新锁 |
| `docs/v1-mcp-agent-dispatch-blueprint.md` | DOCS2 | v1.3 纯增（§10 A9–A11、§11 P2 登记、§12 全章、SHA 行） |

 新文件（1）：`src/board.html`（CH2 建、CH3 扩展，32 KB，浏览器态 SSE + widget 态双通道）＋未跟踪 P5 文档 9 份（P5-upgrade-plan、六张卡、P5-commander-prompt、concurrency-change-assessment、research/）。六张卡头「状态」字段已由主控更新（五卡 PASS、OPS3 挂起等 HUMAN）。

## 4. 挂起项（等 HUMAN）

1. **OPS3 生产部署**（需 HUMAN 显式授权）：看门狗舞蹈、`DISPATCHER_HTTP_READ_TOKEN` 配置（≥32 字符，未配置=只读端点 404 默认安全）、canary:http、live 三连目视。当前生产仍跑 V1 旧码（PID 12488，未碰）。
2. **live 目视**：A9（UX1 卡片渲染/走秒/明暗热更/不截断）、A10（resources/read 轮询无审批弹窗）、LV1（`app.readServerResource` 免授权探针）、LV2（iframe EventSource CSP 放行）、A11（SSE/board 或降级通道声明）。
3. **蓝图 v1.3 diff 过目**（需求级文档变更，D3 预批准范围内，HUMAN 复核）。

## 5. 阻塞 / 返修记录

- **零返修**：五个施工窗口一次 PASS，无 BLOCKED、无打回。
- 两次门禁失败（Wave 2 的 2 例、Wave 3 的 1 例）均为环境性抖动，处置=隔离复证而非返修（见 §6）。

## 6. 环境异常记录（本机，须 HUMAN 知晓）

本机进程树级 spawn/管道故障较 10-04 早些时候存档进一步恶化：并行 `npm test` 出现大面积 `EPERM/EBUSY`（临时目录 `mkdtemp`/`rmdir` 被拒、测试文件进程整体起不来），全量串行 `node --test --test-concurrency=1` 稳定可过。全量耗时从会话开工时并行 64s 恶化到串行 12–13 分钟。门禁离散失败例（antigravity 路由 `EBUSY rmdir` ×2、T6 时序断言 ×1）均在隔离子跑中全绿（29/29、19/19），且所在文件均非 P5 改动文件（dispatcher.js 经 diff 证明 CH2 纯增量），判定环境抖动非代码回归。**建议 HUMAN 重启机器恢复并行模式；在那之前测试门禁一律串行执行。** 取证日志在 `D:/3-huancun/p5-*.log`。

## 7. 遗留风险（按优先级）

1. **iframe opaque origin × origin 检查**：MCP Apps iframe 为 opaque origin，`http-mcp-server.js` 现有 `allowedOrigin` 可能对 widget 内 `/events` 直连返 403（该文件 CH3 禁改）。双通道降级已功能兜底（onerror/超时即降级 `dlz://board` 轮询）；若 LV2/A11 live 确证 403，需 HUMAN 决策是否给只读端点薄记 origin 白名单。
2. **board_url 端口固定 18490**：按蓝图 §12.5 写死生产端口，HTTP 服务改端口时需同步（实现细节）。
3. **LV1 未实证的错误形态**：若宿主对 `app.readServerResource` 回非标准拒绝，CH1 探测可能落入门询性失败而非降级，最坏 = 探测期每 3s 一次 5s 超时；LV1 实证后一行改动可纳入降级判据。
4. **数据目录纯净度（V1 既有语义）**：`DISPATCHER_DATA_DIR` 混入非 job JSON 会被 `listAll()` 当伪 job 扫入看板——OPS3 交接时强调该目录只放 job 快照。
5. **CH2 注册面断言稳健化**：`test/http-mcp.test.js` 的工具/资源列表断言由写死改为「V1 三工具 + task-card 资源必须仍在」语义（为 CH1/CH3 增量让路，V1 不变量保留）；如需严格锁死注册面可回改。
6. CH2 顺手修复了 board.html `columnOf` 对数组调 `.has()` 的运行时 bug（board.html 归 CH3 单写链条内，CH3 报告在案）。

## 8. HUMAN 回来后的动作清单

1. 复核本报告 + `git status`/`git diff`（重点：蓝图 v1.3 diff、mcp-server.js 中 HUMAN 自己的 hunk 与 P5 增量共存）。
2. 授权 OPS3 → 主控按卡执行生产部署与 live 三连（LV1/LV2/A9/A10/A11 一并落档）。
3. 若方便，重启机器恢复并行测试模式。
4. 决定 read token 是否配置生产凭据（不配置则只读端点保持 404，board widget 走资源轮询降级，功能不缺失）。

---

## 9. OPS3 附录：生产部署与收官验收（2026-10-04 22:00 – 10-05 12:50，主控执行）

**前置核验（10-04 22:20）**：主控独立复验指挥窗口总报告——`npm test` 205/205 全绿（70s，环境抖动未复现）；归属/HUMAN hunk/在码证据/蓝图 SHA 复算全部成立。P5a/P5b 验收通过。

**部署（两次看门狗舞蹈）**：
- 舞蹈一（10-04 22:38-22:41）：Start 脚本备份 `.bak-20261004-ops3` + 增 read token env 传递三处（语法校验 0 错）→ read token 生成直写 `secrets\dispatcher-http-read-token.txt`（64 hex，全程不回显）→ 摘狗（Disable+Stop+杀真看门狗 10688，复核无残留）→ 停桥（旧 PID 12488 退场，18490 释放）→ 启狗自愈 → **PID 22596**，watchdog 日志 `recovery_ready`（~6s）。
- 冒烟（10-04 22:44）：端点矩阵全绿——`/mcp` 无凭据 401 / `/api/jobs` 无 token 401 / 错 token 401 / 好 token 200 / `/board` 200 / 未知路径 404 / SSE 探针 28 超时（流式在流，符合预期）。
- **canary（真实派工，10-04 22:46）**：`dispatch_task(workbuddy, dlz-canary, 只读 marker)` → QUEUED → **COMPLETED**（27s）→ marker 精确匹配、JOB_PERSISTENCE PASS、SECRET_LEAK_SCAN PASS（token 不出现在任何输出）、源码指纹前后一致（`cf64adb8…`，24 项 porcelain 不变）。
- **live 三连**：A9 PASS（本会话 render_task_card：新视觉/走秒/主题，HUMAN 目视「卡片正常」）；A10 PASS（轮询免授权无弹窗，LV1 确证）；A11 浏览器通道 PASS（新窗口验收：present_files 看板「已连接」徽章 = SSE 直连，三列分组/终态窗口 50 条满额，LV2 服务端侧确证）。
- **live 发现与修复**：看板头部 2 条残缺项 `{"updated_at":null,"revision":null}` → 主控确诊 = `listAll` 宽松 JOB_FILE_PATTERN 误吞同目录 `project-registry.json`/`workspace-roots.json`（V1 遗留，非 CH2 引入）→ 修复（记录内容 job_id 权威过滤 + 回归测试）→ 全量 **206/206** 绿 → 舞蹈二（10-05 12:43-12:45）→ **PID 17168**，终验冒烟：残缺项清零（69 真实 job，entries_without_job_id=0）。
- **widget 侧观察项**：聊天窗 render_board 被宿主按原生工具 UI 展示（非 MCP Apps iframe；HUMAN 拍板「这个使用 workbuddy 原生工具插件 UI 渲染」）→ LV2 widget 侧（iframe 内 SSE-over-CSP）无结论，挂遗留观察项，浏览器版为推荐展示通道。

**收官动作**：蓝图 §11 P5 收官标记（内容锁重锁 `019B3DFC…F5F8E`，IMPLEMENTATION 头部同步）；README Task Card/HTTP 段 P5 更新（HUMAN allowlist hunk 原样保留）；OPERATIONS.md 新增 §3.6 P5 看板与只读端点；OPS3 卡状态 PASS；本附录落档。

**最终状态**：六卡全 PASS，P5 收官。生产 PID 17168 跑 P5+修复代码，看门狗在岗。工作树未提交改动 = P5 全部成果 + HUMAN 两个在途 hunk（是否 git 提交由 HUMAN 决定，全程零 commit）。遗留：widget 渲染路径观察项、agy `wall_duration_ms` live 复验（V1 起挂账）、机器重启建议（并行测试模式恢复）。
