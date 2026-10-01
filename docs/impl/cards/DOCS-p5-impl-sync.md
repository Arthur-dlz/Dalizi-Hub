# DOCS：IMPLEMENTATION.md 同步 T4ux/T5cal/OPS 三卡变更（收口卡）

阶段：P3/P4 收口 ｜ 依赖：T4ux、T5cal、OPS（均已验收 PASS，commit `7872fc6`）｜ 并行：可与主控生产操作并行 ｜ 状态：✅ 验收 PASS（10-01 主控四件套亲验）
来源：三卡合入后技术 SSOT（IMPLEMENTATION.md）与代码事实出现文档漂移 → 主控收口卡。

---

## ⛔ 红线（先读本节再动手；违反 = 返工 + 纪律留档）

1. **禁止触碰 `.workbuddy/` 目录（含其下所有文件，含 `memory/`）——工作日志由主控撰写，你只负责回传。已有三个窗口因写此目录被记过。**
2. 只允许修改「拥有文件」列出的 **1 个**文件，其余一切文件只读。
3. 禁止 `git commit` / `git push` / 任何 git 写操作。
4. 禁止启动、停止、重启任何服务或进程（dispatcher、bridge、看门狗一律不碰）。
5. 禁止读取 `secrets/`、凭据、token、环境变量中的密钥。
6. 禁止碰 `D:\1-WORK\agent\dalizihub-bridge\` 下任何东西（只读也不行）。
7. 回传只写事实；做不成的写 `NOT_PROVEN` 或 `BLOCKED`，**禁止编造成功叙事**（前车之鉴：T6 窗口因编造开工基线被记纪律 FAIL）。
8. **开工第一步（未做=回传拒收）**：执行 `git status --porcelain` 和 `node --test --test-concurrency=1`，把输出原文贴进回传的「开工基线」一节。当前正确基线 = HEAD `7872fc6`、工作区干净、**176/176**。若你的基线不是这个，**停止施工并立即回传 BLOCKED**。
9. **本卡是文档同步卡：禁止改动任何代码/测试语义。文档内容必须以代码事实为准（亲自读码核实），禁止照抄本卡或任何叙事性文字充数。**

## 拥有文件（单写者）

- `docs/impl/IMPLEMENTATION.md`（改）

其余全部只读（包括 `docs/v1-mcp-agent-dispatch-blueprint.md`——需求唯一来源，**本卡不动**）。

## 目标

把 IMPLEMENTATION.md 同步到 commit `7872fc6` 的代码事实，消除三处文档漂移：T4ux 缩略机制未记录、T5cal usage 映射修正未记录、测试映射过时（151/155/168 口径混杂）。只改事实性技术描述，不改设计意图表述，不重排文档骨架。

## 现状锚点（已核实，直接引用）

代码事实（主控验收时已 grep 核验，你施工前必须自行再核一遍）：

- `src/task-card.html`：`RESULT_PREVIEW_LIMIT = 500`（:78）、`RESULT_LINE_LIMIT = 8`（:79）、可折叠判定（:249）、截断逻辑（:252 起，前 500 字符内最后一个换行处截断，无换行硬截 500，末尾拼 ` …`）、`resultExpansion = new Map()`（:81，job_id → `{expanded, scrollTop}`）、`.result p.expanded { max-height: 50vh; overflow-y: auto; }`（:26）。**边界口径（已裁决接受）**：行数判定用 `split('\n').length`，文本以换行结尾会多计一行。
- `src/codex-runner.js`：`USAGE_FIELD_MAP` 的 `cache_write_tokens` paths 末尾已追加 `"cache_write_input_tokens"`（:25，既有两项 `cache_write_tokens`、`cache_creation_input_tokens` 优先级不变）。
- `src/antigravity-runner.js`：USAGE_FIELD_MAP 路径改为相对 `result` payload——token 各字段加 `usage.` 前缀（:30-35,38），`duration_seconds`（:36，scale 1000 → `wall_duration_ms`）与 `num_turns`（:37）为 payload 层裸路径；调用点 `mapUsageDict(event.result, { scope: "session", prefix: "result" })`（:330）。`src/usage.js` canonical 名单本已含 `wall_duration_ms`（:14/:39），**未改动**。
- 测试：`test/task-card.test.js` +6（:635 起，阈值矩阵/缩略预览/展开收起/刷新保持/短文本/空结果）；`test/codex.test.js` +1（:295，cache_write_input_tokens）；`test/antigravity.test.js` +2（改写真实流形状 1 + 缺字段回归 1，:444）。全量基线 168 → **176**。
- OPS 卡：`docs/impl/cards/OPS-codex-standalone-cli.md`（仓库零改动，独立 CLI 装在 `D:\2-ruanjian\codex-standalone\`，属环境变更不在本文档记录范围——**§7 索引提及即可**）。

文档漂移点（你要改的地方）：

- §4 模块变更清单（:85 起）：`task-card.html`、`codex-runner.js`、`antigravity-runner.js` 三行需补充上述变更。
- §5.6 usage 聚合规则（:140 起）：补 codex `cache_write_input_tokens` 第三候选路径；补 agy 映射源对象=result payload 层的事实（duration_seconds/num_turns 与 usage 为兄弟节点）。
- §5.7 卡片桥接收敛（:144 起）或其后新增小节：补结果区缩略机制（阈值/截断/Map 状态保持/50vh/空结果隐藏不回归/尾部换行边界口径）。
- §6 测试策略（:148 起）：测试计数口径更新为 176，并补 8 个新用例到 A 映射对应行。
- §7 施工卡索引（:163 起）：补 T4ux/T5cal/OPS 三行（状态=验收 PASS，commit `7872fc6`）；DOCS 本卡可自登记一行（状态=施工中）。

## 施工要求

1. 先读 IMPLEMENTATION.md 全文，再读上述代码文件核实锚点，**发现锚点与代码不符 → 停止施工回传 BLOCKED 并指出不符处**（禁止将错就错照抄锚点）。
2. 改动最小化：只补三卡相关事实，不顺手润色无关章节，不改标题层级结构。
3. 数字口径统一：全文档测试计数以 176 为准；如出现其他历史计数（151/155/168），改为 176 并注明演变（168 = T5 收官，+6 T4ux，+2 T5cal）。
4. 不引入未发生的事实：bridge 改指/生产切换属于主控待办，**禁止写成已完成**。

## 测试与证据

1. 本卡无代码改动，无需跑测试新增用例；但开工基线与回传前各跑一次 `node --test --test-concurrency=1`，计数必须保持 176/176（证明你零代码触碰）。
2. 回传附你改动段的 diff 摘要（`git diff docs/impl/IMPLEMENTATION.md` 原文）。

## 验收

主控四件套：git status 只许 1 个文件改动；亲跑全量 176/176；grep 在码（500/8 阈值、cache_write_input_tokens、result payload 层级、176 口径在文档中）；红线核查（含 `.workbuddy/` mtime 扫描）。

## 回传格式

```
RESULT=PASS|FAIL|PARTIAL|BLOCKED
开工基线=<git status 原文 + 测试计数原文>
改动文件=<清单>
测试计数=<开工与完工各一次，必须均为 176/176>
改动摘要=<按 §4/§5.6/§5.7/§6/§7 分节列出各改了什么，每节一两句>
证据=<git diff 原文>
锚点复核=<上述现状锚点逐条核实结果：符/不符>
遗留风险=<没有就写"无">
```
