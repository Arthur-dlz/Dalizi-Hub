# V1 实现技术文档（IMPLEMENTATION）

日期：2026-09-29；2026-10-04 增补 §9（P5 表面，对应蓝图 v1.3）。状态：V1 已收官（A1–A8 全绿，全量测试 176/176）；P5 新增表面待 CH1–CH3/OPS3 施工。
对应蓝图：`docs/v1-mcp-agent-dispatch-blueprint.md` v1.3，SHA256 `019B3DFCB4424AAB20CCBA8BE2BD71E9D450F0C2AF5EB777421A6D9574FA5F8E`（2026-10-05 P5 收官标记后重锁；口径：LF 行尾的蓝图全文除去文末 SHA256 记录行，与该行记录同值）。v1.3 初锁 `A9F16789…9969`；v1.2 旧锁 `048BB68F…C01662` 对应 41a5b8b 版蓝图；0ecc963 收官修订蓝图 §11 时未刷新该锁，v1.3 起以本锁为准。
需求以蓝图为唯一来源；本文只做"蓝图 → 代码"的实现映射，不复制需求、不新增需求。若本文与蓝图冲突，以蓝图为准并修正本文。

## 1. 文档关系与执行模型

- 蓝图（需求 SSOT）→ 本文（模块与机制设计）→ `cards/T0–T5`（喂给执行窗口的施工单元）。
- 每张卡声明**拥有文件**（单写者）：并行窗口不得写同一份文件；卡外文件只读。
- 全程不 commit/push、不启停服务、不动 `.workbuddy/`、不动外部 Bridge；canary 与真实 CLI 作业仅在 T5 且用户显式授权后执行。
- 代码风格：原生 JavaScript ESM、双引号、分号、依赖注入；测试用 `node --test`，不引入新框架/数据库。

## 2. 现状 → 目标调用链

现状（V0）：dispatch → 校验/解析 → 写 QUEUED → setImmediate 执行 → 进程 close 后一次性解析 → 写终态。内存 `activeJobId` 单占用，无幂等、无恢复、无实时事件。

目标（V1）：

```text
dispatch_task(input + request_id)
  → 串行准入区间（单一 async mutex）：
      校验 → 规范化+摘要 → 幂等查表(内存 Map O(1))
        命中且请求一致 → 返回原 job_id
        命中但请求不同 → idempotency_conflict
        未命中 → busy 检查 → 写 QUEUED(含 request_id/摘要) → 追加索引日志
      → 持久化执行 claim → spawn
  → Runner.run(spec, emit)：增量 NDJSON → 事件封套
  → per-job reducer 串行 apply(job_id, event) → 持久快照 revision+1
  → 终态：协议终态+进程退出+持久结果 → completion_evidence

启动路径：实例锁 acquire（第二 owner 拒绝启动）
  → 索引加载/重建 → 恢复扫描（非终态分类处理）

人工路径：npm run resolve-recovery（本地命令，非 MCP 工具）
```

## 3. 数据格式

### 3.1 TaskSnapshot v2（job JSON 文件，每 job 一份）

在现有字段（job_id/agent/project/requested_model/actual_model/effort/status/created_at 等时间字段/`final_text`/error）之上新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| schema_version | number | 恒 2；读旧文件（无此字段）按 v1 兼容处理 |
| revision | number | 单调递增，每次 apply +1；卡片防旧依据 |
| updated_at | string(UTC) | 最近 apply 时间 |
| request_id | string\|null | 幂等键；旧调用缺省为 null |
| request_digest | string\|null | 规范化请求摘要（不含明文 prompt 全文） |
| activity | object\|null | {kind,label,state,source,observed_at}；无观测为 null |
| liveness | object | {owner_heartbeat_at, process_checked_at, process_state, last_event_at, last_output_at}，各项可 null |
| usage | object\|null | 指标字典，见 §5.6 |
| execution_state | string | idle\|claimed\|spawning\|running\|stopped\|unknown |
| completion_evidence | object\|null | {protocol_terminal, session_match, exit_code, result_persisted, notes} |

error 结构扩展：`{kind, message, diagnostics?}`；恢复相关 kind：`interrupted`、`interrupted_confirmed`。

### 3.2 事件封套（reducer 输入）

```js
{
  schema_version: 1,
  job_id, seq, observed_at,          // seq 为 Dispatcher 顺序
  source: { agent, cli_version, session_id, event_id },
  kind: "started" | "activity" | "usage" | "heartbeat" | "result" | "error",
  payload
}
```

增量解码须处理 UTF-8 跨 chunk、半行、多行、无换行结尾、坏 JSON、输出上限；未知事件记有限诊断，不自行解释成功。证据有大小上限；快照不默认保存完整 transcript。

### 3.3 request_id 索引日志（`run/idempotency-index.jsonl`）

每行一条 JSON：`{request_id, job_id, request_digest, created_at}`。只追加，**仅作审计/历史，不作权威来源**。内存 Map 为查询入口；**启动时恒从 job 记录全量对账重建 Map**（O(n) 启动成本，随有界磁盘增长可接受）——覆盖"日志完好但缺尾条目"的崩溃窗口，保证崩溃后同 id 重试必命中。

### 3.4 实例锁（`run/instance.lock`）

内容：`{owner_id, pid, created_at, heartbeat_at}`。以排他创建（`wx`）获取；持有期间每 5s 更新 heartbeat_at（mtime 亦为心跳证据）。获取失败即第二 owner：拒绝启动并明确报错。锁文件消失 ≠ 旧 CLI 已停止，恢复判定见 §5.4。

### 3.5 恢复审计（`run/recovery-audit.jsonl`）

每行：`{job_id, operator, resolved_at, evidence, action}`。resolve-recovery 每次执行追加，人工路径的唯一审计入口。

## 4. 模块变更清单（per file）

| 文件 | 改动 | 所属卡 |
|---|---|---|
| `src/job-store.js` | 新增 `apply(job_id, event)`（per-job 串行 reducer seam，替换裸 update 的并发面）；快照 v2 读写与 v1 兼容；`listNonTerminal()`；request_digest 存取 | T1 |
| `src/idempotency-index.js`（新） | 内存 Map + append-only 日志；load/append/rebuild；启动接入 | T1 |
| `src/idempotency.js`（新） | 规范化（trim/default/校验后 agent/project/model/effort/task）→ digest；lookup 判定：一致→命中、不同→conflict | T2 |
| `src/contracts.js` | request_id 可选校验：string，8–128 字符，URL-safe；缺省允许（无重试保证） | T2 |
| `src/mcp-server.js` | dispatch_task schema 增加 request_id；回执含 request_id；`idempotency_conflict` 错误；工具描述写明"目标 CLI/目标模型" | T2 |
| `src/dispatcher.js` | 串行准入区间（lookup→busy→create→claim 同区间）；spawn 前持久化 claim（owner identity + PID/创建时间/executable）；启动恢复扫描钩子；心跳（owner 5s/15s 过期标记，仅影响可信度显示）；终态写 completion_evidence | T2 |
| `src/instance-lock.js`（新） | acquire/heartbeat/release；第二 owner 拒绝启动 | T2 |
| `src/recovery.js`（新） | 非终态扫描分类（§5.4）；RECOVERY_REQUIRED 保留占用 | T2 |
| `scripts/resolve-recovery.js`（新） | 人工解除命令：`--job --confirm --evidence`；写审计；FAILED(interrupted_confirmed) + 释放占用；`package.json` 增加 `resolve-recovery` script | T2 |
| `src/workbuddy-runner.js` | 增量 stream-json 解析；emit started/activity/usage/result；WB usage 映射（安装版本样本校准） | T3a |
| `src/codex-runner.js` | 增量事件解析；turn.completed.usage 映射（`cache_write_tokens` 候选路径按序为 `cache_write_tokens`/`cache_creation_input_tokens`/`cache_write_input_tokens`）；保留可信路径/argv 约束 | T3b（T5cal 校准） |
| `src/antigravity-runner.js` | 增量 step_update/result 解析；usage 映射（路径相对 `result` payload：token 带 `usage.` 前缀，`duration_seconds`/`num_turns` 为 payload 层裸路径）；**权限 flag 行为按 T2 决策记录执行，不擅自改动** | T3c（T5cal 校准） |
| `src/usage.js`（新） | 指标语义对象与聚合规则（§5.6），三 runner 共用 | T3a（T3b/c 只调用） |
| `src/task-card.html` | 自动刷新开关不再被快照重置（仅用户操作改变）；revision/job_id 防旧响应；查询失败保留上次成功快照+错误提示+可重试；RECOVERY_REQUIRED 明确展示；结果区缩略与就地展开（§5.8）；postMessage 收敛（§8） | T4（T4ux 增补） |
| `src/task-card.js` | 资源注册随快照 v2 字段调整 | T4 |
| `src/http-mcp-server.js` | 不改（认证/loopback/Origin/body 限制保留） | — |
| `src/project-registry.js` | 不改（受控目标解析保留） | — |
| `test/*` | 各卡自带新增/修改测试；不削弱既有断言 | 各卡 |

## 5. 关键机制

### 5.1 串行准入区间

单一进程内 async mutex（`this.admission = this.admission.then(step)` 链或显式锁）。区间内完成：request_id 查表 → busy 检查 → 创建 QUEUED + 索引追加 → 设置 activeJobId/claim。区间外不做任何上述读写。这同时关闭 V0 的 await 窗口竞争与"查找/占用/创建"非原子问题。

### 5.2 事件 reducer

每 job 一个 FIFO 队列，单消费者串行 `JobStore.apply`：读快照 → 应用事件（revision+1、updated_at、按 kind 更新 activity/liveness/usage/status）→ 临时文件 rename 落盘。runner emit、owner 心跳、dispatcher 终态全部走同一 seam，禁止旁路直接写快照。这关闭 V0 read-merge-write 丢更新风险。

### 5.3 实例锁（Windows）

排他创建 `run/instance.lock`；持有者周期更新 heartbeat_at；stdio 入口与 HTTP 入口共用同一状态目录时同锁。**stale 判定**：acquire 失败时读锁——heartbeat 新鲜（默认阈值 30s，可配置）或 owner PID 身份确认存活（校验 PID+创建时间，防 PID 复用误判）→ 拒绝启动；heartbeat 过期且 PID 身份不存在/不匹配 → 判定 stale，旧锁改名 `instance.lock.stale-<时间戳>` 归档后获取新锁。锁只防"双 writer"；stale 接管不证明旧 CLI 停止，旧执行记录仍按 §5.4 分类。操作者人工确认后也可直接删除锁文件。

### 5.4 恢复扫描决策表

启动时对 `listNonTerminal()` 逐 job 判定：

| 证据 | 判定 | 动作 |
|---|---|---|
| 有 claim、无 spawn 证据（从未启动） | 中断于 spawn 前 | FAILED(interrupted)，释放占用 |
| 进程身份确认已停止且结果缺失 | 执行中断 | FAILED(interrupted)，释放占用 |
| 进程确认存活 | 执行仍在 | execution_state=running，保留占用，继续观察 |
| 身份不可读/证据矛盾 | unknown | RECOVERY_REQUIRED + execution_state=unknown，保留占用，卡片明示 |
| spawn 后身份未落盘窗口 | 不推断"没有进程" | 按 unknown 处理 |

自动路径永不释放"未知"占用，永不 kill 身份未知进程，永不自动重跑。

### 5.5 resolve-recovery 流程

`npm run resolve-recovery -- --job <id> --confirm --evidence "<摘要>"`：缺 `--confirm` 或 `--evidence` 直接拒绝；仅对 RECOVERY_REQUIRED（或明确 interrupted 待确认）job 生效。**前置条件：目标 owner 已停止**——命令先 acquire 该状态目录实例锁（含 §5.3 stale 判定），锁被活 owner 持有则拒绝并提示先停 owner；获锁后自身即唯一写者，不与任何内存占用态冲突。写回走 reducer 同款临时文件+rename、revision+1：FAILED(interrupted_confirmed) + 审计行 + 释放持久 claim。终端输出操作回执。不是 MCP 工具，不暴露到 HTTP/stdio。

### 5.6 usage 聚合规则

每指标：`{value, unit, scope, kind, source_field, quality, unavailable_reason?}`。规则：null≠0（源明确报零才存 0）；同一 scope 的 snapshot 替换旧值，唯一 delta 才累加；最终 result 累计替代临时聚合，不重复加；input/cache/output/reasoning 包含关系由 adapter 按安装版本声明，关系不明不推导合计；provider total 优先；后台子任务与主任务重叠无证据则分列标"覆盖不明"；吞吐命名区分任务平均输出吞吐/模型吞吐/生成速度，证据不足即不可观测。账号额度（antigravity-usage.js）与 job usage 严格分离。

映射源校准（T5cal）：codex `cache_write_tokens` 的候选路径按序为 `cache_write_tokens` → `cache_creation_input_tokens` → `cache_write_input_tokens`（0.159.x 实测 `turn.completed.usage` 报 `cache_write_input_tokens`；前两项优先级不变）；agy 的映射源对象为 `result` payload——token 字段位于 `result.usage.*`，而 `duration_seconds`（scale 1000 → `wall_duration_ms`）与 `num_turns` 是与 `usage` 同级的 payload 裸路径，故其 `source_field` 前缀为 `result.`（非 `result.usage.`）。

### 5.7 卡片桥接收敛

postMessage 目标 origin 不用 `'*'`：P0 查明宿主 origin 后写死白名单；查明前过渡期：校验消息结构、job_id 绑定、event.source，并在卡片内标注。A1 证据需包含实际生效的校验方式。

### 5.8 结果区缩略与就地展开（T4ux）

结果区长文本默认缩略、可就地展开/收起，不弹窗不跳转；短文本零行为变化。

- **可折叠判定**：文本长度 > `RESULT_PREVIEW_LIMIT`（500）或行数 > `RESULT_LINE_LIMIT`（8）即可折叠；行数用 `split('\n').length` 计，**文本以换行结尾会多计一行**（边界口径已裁决接受）。
- **缩略预览**：取前 500 字符，在其中最后一个换行处截断；无换行则硬截 500；末尾拼接 ` …`。
- **展开态**：全文渲染并挂载 `.expanded`（`max-height: 50vh; overflow-y: auto`），保留滚动位置。
- **状态保持**：`resultExpansion`（`Map`，job_id → `{expanded, scrollTop}`）按 job 记忆——同 job_id 刷新保持展开与 scrollTop，切换 job 回到缩略默认；展开中重渲染前先把实时 scrollTop 记回状态，避免丢位置。
- **空结果**：`result_block` 保持隐藏且无折叠按钮（不回归）。

## 6. 测试策略（A1–A8 映射）

| A 项 | 证据来源 | 所在卡 |
|---|---|---|
| A1 Desktop 卡片 | 真实 Desktop 渲染+按钮调 get_task 操作记录 | T0（能力）→ T4（实现）→ T5 |
| A2 客户端中立契约 | schema/路由/幂等不绑发起方的契约检查 + 两种 WB Agent/模型组合真实调用 | T2 → T5 |
| A3 实时状态 | 受控 runner fixture（chunk/半行/坏 JSON）+ 每 CLI 真实事件样本 | T3a/b/c |
| A4 用量准确 | 脱敏样本期望值、缺字段/重放/重复累计测试 | T3a/b/c |
| A5 无重复执行 | 并发/双 owner/响应丢失/崩溃注入测试 + spawn 次数断言 | T2 |
| A6 可信恢复 | 进程身份 fixture（PID 复用/未知/存活/缺结果）+ resolve-recovery 审计实测 | T2 |
| A7 刷新稳健 | UI 行为测试（关自动刷新→手动刷新→RUNNING 快照仍关）+ Desktop 实测 | T4 → T5 |
| A8 完整链路 | 每启用 CLI 一个受控 canary job 全链路记录 | T5（需用户授权） |

**全量测试基线**：`node --test --test-concurrency=1` = **176/176**。演变口径：168（T5 收官）→ +6（T4ux）→ +2（T5cal 净增）= 176。

**T4ux/T5cal 新增用例映射**（净 +8）：A7 UI 行为 +6（结果区阈值边界矩阵、缩略预览截断、就地展开/收起、同 job_id 刷新保持与切换重置、短文本零行为变化、空结果隐藏不回归）；A4 用量准确 +2（codex `cache_write_input_tokens` 命中并记 `source_field`；agy 缺 `duration_seconds` 时 `wall_duration_ms` 保持 unavailable 不补零）。另 A3 有 1 例按 agy 真实流形状改写（净 0）。

源码单测、CLI 实测、Desktop 实测分开报告；静态 HTML 检查不冒充宿主验收。

## 7. 施工卡索引与并发规则

| 卡 | 内容 | 依赖 | 可与其并行的卡 |
|---|---|---|---|
| T0 | P0 宿主能力探查（只读） | 无 | 全部（只读不冲突） |
| T1 | P1 存储底座：apply reducer + 快照 v2 + 索引 | 无 | T0 |
| T2 | P1 准入/幂等/实例锁/恢复/resolve-recovery + AGY 决策记录 | T1 | T0（T2 完成后解锁 T3a/T4） |
| T3a | P2 WB adapter + usage.js/stream-json 共享接口 | T2 | T0、T4 |
| T3b/T3c | P2 Codex / AGY adapter | T2 + **T3a 接口已回传冻结**（只消费 usage.js/stream-json） | 彼此并行、T4 |
| T4 | P3 任务卡修复 | T1（快照字段）；建议 T2 后启动以展示 RECOVERY_REQUIRED | T3a/b/c |
| T5 | P4 受控端到端 canary | T2+T3+T4 全完成 + 用户显式授权 | 无 |
| T4ux | P3 结果区缩略/就地展开（T4 后续微卡） | T4 | — |
| T5cal | P4 usage 映射校准（codex cache_write / agy payload 层） | T3b、T3c | — |
| OPS | codex 独立 CLI 固定路径（环境变更，仓库零改动） | T3b | — |
| DOCS | IMPLEMENTATION.md 同步三卡变更（收口卡） | T4ux、T5cal、OPS | — |

**收官状态（2026-10-01）**：T4ux、T5cal、OPS 均验收 PASS，commit `7872fc6`；DOCS（本卡）施工中。

**执行序**：T0 ∥ 全程；T1 → T2 → T3a →（T3b ∥ T3c）；T4 在 T1 后可起步、与 T3 系并行；T5 最后。

**单写者纪律**：每卡"拥有文件"之外一律只读；需要改他卡文件时，停手回传，由主控协调。同一时刻同一文件只有一个窗口写。

## 8. 明确不做（照蓝图，复述仅为执行边界）

多任务队列/并行编排、会话续接、取消/审批产品、自动重试、历史分析、计费、worker/critic、自动 Git 操作、其他客户端接入实现、单实例内并发（需求级变更须用户显式批准）。

## 9. P5 数据通道与看板表面（对应蓝图 v1.3 §12）

本节为蓝图 v1.3 §12 的"蓝图 → 代码"实现映射，不新增需求；与 V1 各章的冲突检查见 §9.5（结论：无冲突，无需回改）。施工卡与依赖见 `docs/impl/P5-upgrade-plan.md` §4（DOCS2 前置已完工 → CH1 → CH2 → CH3 → OPS3）；对应验收项 A9–A11（蓝图 §10，live 目视项挂 HUMAN）。

### 9.1 资源注册：dlz://job/{job_id} 与 dlz://board（CH1/CH3）

- `src/mcp-server.js` 以官方 SDK v2 的 `ResourceTemplate` 注册资源模板 `dlz://job/{job_id}`（list 回调枚举当前已知 job；read 回调按 job_id 取持久快照）；`dlz://board` 为静态 URI 资源，read 回调返回聚合视图。
- 载荷：`dlz://job/{job_id}` 返回该 job 的 TaskSnapshot（与 `get_task` 的 `structuredContent` 同形，字段见 §3.1）；`dlz://board` 返回 `{jobs, truncated, total}`——`jobs` 为快照数组（项与 job 资源同形），`truncated` 为是否截断，`total` 为未截断全量条数。
- board 边界常量（实现声明值，调值属实现细节、不改需求）：终态窗口 50 条（按 `finished_at` 降序取最近）；响应字节上限 1 MiB；非终态全量优先入数组，超限按同序截断并置 `truncated=true`。
- 卡片轮询迁移（CH1）：`src/task-card.html` 优先 `app.readServerResource("dlz://job/<job_id>")`（免授权只读 GET）；宿主抛错/不支持时回退现有 `tools/call get_task` 桥；回退路径保留 A1/A7 既有行为与断言。
- `render_board` 的 `structuredContent.jobs` 为 board 摘要数组（与 board 资源同源的紧凑投影），摘要字段：`{job_id, status, project, agent, created_at, updated_at, revision}`。

### 9.2 SSE：GET /events（CH2）

- `src/http-mcp-server.js` 路由由单路径（非 `/mcp` 即 404）扩为白名单式：`/mcp`（原 bearer 认证不变）+ `/api/jobs`、`/events`、`/board`（只读，认证见 §9.3）；其余路径维持 404。
- 数据源：`JobStore`（`listAll()` / `listNonTerminal()` 已有）；board 与 `/api/jobs` 视图按 §9.1 边界常量裁剪。
- 推送：服务端每 1s 轮询 store，逐 job 比对 `revision`，有变化者以 SSE `data:` 行推送 `{"job_id","revision","snapshot"}`；无变化不推。
- 心跳：每 15s 发送 SSE 注释行（如 `: hb <iso>`）保活，防中间层静默断链。
- 连接清理：`req.on("close")` 摘除该连接的轮询引用与响应写入口；无客户端即无轮询，防定时器/引用泄漏。响应头 `Content-Type: text/event-stream`、`Cache-Control: no-cache`。

### 9.3 只读 token 模型（CH2，D1 拍板）

- 环境变量 `DISPATCHER_HTTP_READ_TOKEN`：独立凭据，≥32 字符高熵；与 MCP bearer 不同源；**不进 git、不进快照、不进任何静态 UI 资源、不进日志**；未配置时 §9.2 三个只读路径一律 404（默认关闭），由运维在 OPS3 阶段配置后生效。
- 校验顺序：query param `read_token` 存在 → 与服务端值以 `crypto.timingSafeEqual` 定长比较（先比长度，不等长直接拒，防抛异常）；否则 `Authorization: Bearer <主 bearer>` 按现有逻辑校验通过亦放行只读访问；均不满足返回 401。未配置与凭据错误对调用方呈现不同状态码，但不泄露路径存在性之外的细节。
- `render_board` 的 `structuredContent.read_token` 与 `board_url` 所带 query param 即该值，经已认证 MCP 工具调用动态下发（蓝图 §12.3）；`board.html` 从自身 URL query 取 token 供 `/api/jobs`、`/events` 复用；静态 HTML 不内置任何凭据。
- MCP 入口（`/mcp`，POST）的认证、loopback、Origin 与 body 限制零改动。

### 9.4 board 页双挂载（CH2/CH3）

- `src/board.html`（CH2 新文件，静态页归 CH2 单写者）：数据 = `GET /api/jobs`（初载）+ `GET /events`（SSE 实时）；token 取自页面 URL query。
- 挂载一：MCP Apps iframe——`render_board` 的 `_meta.ui.resourceUri` 指向 board UI 资源；受 widget CSP 管辖，`connectDomains` 申报 `http://127.0.0.1:18490`（蓝图 §12.5）后才可直连本地端点；SSE 不可达时 CH3 运行时双通道降级为 `dlz://board` 轮询（LV2/A11，功能不缺失）。
- 挂载二：`present_files` 内置浏览器——URL `http://127.0.0.1:18490/board?read_token=…`，**必须 `127.0.0.1` 不用 `localhost`**（IPv6 假 404 风险）；不受 widget CSP 管辖，SSE 原生可用；WB Bash 沙箱 curl 不可达属已知宿主行为，不改变该路径结论。

### 9.5 与 V1 各章冲突检查（结论：无冲突）

- §4 工具契约：`dispatch_task`/`get_task`/`render_task_card` 输入输出与快照语义不变；`render_board` 为新增只读工具；request_id 幂等机制不扩展至只读路径。
- §8 安全与权限：只读端点无写路径；loopback/Origin/body 限制保留；只读 token 是二级凭据，不替代、不削弱主 bearer；"卡片不直连"规则（§8）仅对 board widget 按蓝图 §12.5 白名单有限放开且只读。
- §3 数据格式：快照 schema 无字段变更；board 聚合为既有 TaskSnapshot 的有界投影。
- §11 演进项：P2 六项按 D4 拍板只登记于蓝图 §11（另立 P6 评估），本文不施工、不列入任何 P5 卡承诺。
