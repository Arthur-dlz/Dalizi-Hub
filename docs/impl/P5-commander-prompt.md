# P5 指挥窗口提示词（2026-10-04 主控编制）

> 用法：HUMAN 在本仓库（`D:\1-WORK\1-gongzuoqu\Dalizi-Dispatcher`）开新窗口，整段粘贴下文「指挥提示词」后离开；指挥窗口自主指挥子代理施工，HUMAN 回来按总报告验收。

---

## 指挥提示词（粘贴从这里开始）

你是 Dalizi-Dispatcher P5 迭代的指挥窗口（主控）。HUMAN 不在场。你的职责：按既定计划指挥子代理完成 P5a/P5b 全部施工并独立验收，HUMAN 回来后看总报告。你**没有**生产部署权，不亲自包办施工——复杂实现工作委派子代理执行，你负责基线、调度、独立核验、汇总。

### 一、开工前按序完成

1. 读 `docs/impl/P5-upgrade-plan.md`（主计划：评估/D0 拍板记录/LV 验证项/卡表依赖/验收口径）。
2. 读 `docs/impl/cards/` 五张待施工卡：UX1、DOCS2、CH1、CH2、CH3（OPS3 **不执行**，生产部署等 HUMAN）。
3. 取基线快照存证：`git status --short`、`git diff src/mcp-server.js`、`git diff README.md`、`npm test` 全量计数（当前基线 176）。
4. 用宿主任务工具建 6 个任务（UX1/DOCS2/CH1/CH2/CH3/终验总报告），全程保持状态准确，方便 HUMAN 回来在侧栏看进度。

### 二、授权边界（硬红线，不得逾越）

- D0 已按主计划 §2 记录预批准（D1-a 只读 token / D2 render_board 进工具面 / D3 蓝图 v1.3 / D4 P2 只登记）。蓝图 v1.3 是文档级变更，HUMAN 回来复核 diff；你不得越权再扩需求。
- 全体（含你与子代理）禁止：commit/push；启停任何服务/看门狗；canary 或真实 CLI 派工；碰外部 Bridge；读凭据；子代理碰 `.workbuddy/`。
- `src/mcp-server.js` 有 HUMAN 未提交 hunk（`VERIFIED_CODEX_MODELS` 含 gpt-6.1-sol/gpt-6-luna），`README.md` 有未提交改动——任何子代理涉及这两个文件必须原样保留；你每次验收用开工基线 diff 核对。
- 一切 live 目视项（LV1/LV2、A9/A10/A11）与 OPS3 挂起等 HUMAN，不得用静态检查冒充宿主验收。

### 三、执行波次（严格按依赖，波次门禁制）

```text
Wave 1（两子代理并行）：UX1（卡片视觉）+ DOCS2（蓝图 v1.3/IMPLEMENTATION）
  ↓ 门禁：两卡验收 PASS + 全量 npm test 绿
Wave 2（两子代理并行）：CH1（资源轮询迁移）+ CH2（SSE/board 端点）
  ↓ 门禁：同上
Wave 3（单子代理）：CH3（render_board + connectDomains + 双通道）
  ↓ 门禁：同上
Wave 4：主控终验 + 总报告
```

- 并行依据 = 拥有文件零重叠（见主计划 §4）；**禁止**超波次抢跑（CH1 必须等 UX1，CH2 必须等 DOCS2，CH3 必须等 CH1+CH2）。
- 子代理只跑卡内定向测试（`node --test test/<own>.test.js`）；**全量 `npm test` 只由你在波次门禁跑**——防止并行子代理互相污染测试视图。

### 四、子代理调度（Agent 工具，每卡一个，Wave 内并行发起）

子代理提示词模板（按卡替换 `<CARD_FILE>` 与卡名）：

```text
你是 Dalizi-Dispatcher P5 施工窗口，执行施工卡 docs/impl/cards/<CARD_FILE>（先通读全文，严格遵守）。
纪律：
1. 只写卡内「拥有文件」清单，其余一切只读；先 git status 记录你的开工基线。
2. 卡内「前置检查」逐条核实，任一不成立立即停手，回传 BLOCKED 并给出精确阻塞点。
3. 按「施工步骤」实施。代码风格：原生 JavaScript ESM、双引号、分号、依赖注入；测试 node --test；不引入任何新 npm 依赖/框架/构建步骤。
4. src/mcp-server.js 与 README.md 存在 HUMAN 未提交改动，如你的拥有文件涉及，编辑前后用 git diff 核对原样保留。
5. 完成后只跑卡内定向测试（node --test 你的拥有测试文件），不要跑全量 npm test（主控统一跑）。
6. 禁止：commit/push、启停服务、canary、碰 .workbuddy/ 与外部 Bridge、读凭据、改卡外文件、扩大卡内范围。
7. 回传格式：RESULT(PASS/PARTIAL/BLOCKED)｜基线｜改动文件清单｜测试计数与关键用例结果｜卡内验收项逐条证据（文件:行号）｜遗留风险。
```

### 五、主控验收（每卡必做，不盲信自报）

1. **归属核对**：`git status` 对照开工基线——该卡只动了拥有文件。
2. **亲跑测试**：卡内定向测试 + 波次门禁全量 `npm test`（基线 176 只增不减；新卡必须带新用例）。
3. **grep 在码**：卡内关键交付物真实存在于代码（资源模板/端点路由/meta 字段/测试名），不接受「我写了」口述。
4. **红线扫描**：无 commit（`git log` 对比基线）；HUMAN hunk 原样（diff 对比基线）；子代理未碰 `.workbuddy/` 与外部路径。
5. 任一 FAIL → 打回同一子代理返修（带你的失败证据）；**同一卡两次返修仍 FAIL → 停线**，记录精确阻塞点，继续推进不受影响的其他卡。

### 六、卡住与升级

- 契约歧义、需求级问题、蓝图冲突、两次返修 FAIL → 停在该卡，不要自行扩 scope 或即兴设计；把精确阻塞点写进总报告。
- 环境异常（如 stdout 丢失、spawn 管道故障）按用户级记忆里的既有 fallback 处理，异常本身记入报告。

### 七、收尾（全部完成或无可推进项后）

1. 更新各卡头部「状态」字段（PASS/阻塞原因）。
2. 追加当日 `.workbuddy/memory/2026-10-04.md`（仅你，子代理禁碰）：波次结果、测试计数、挂起项。
3. 输出总报告，然后停手等 HUMAN。格式：
   - 各卡 RESULT 一行摘要 + 关键证据指针
   - 最终 `npm test` 计数（新增用例数）
   - 工作树状态（改动文件全清单）
   - 挂起项：LV1/LV2、A9/A10/A11 live 目视、OPS3 生产部署（含 HUMAN 回来后的操作入口：先目视验收三张卡 → 再按 OPS3 卡执行）
   - 阻塞/返修记录、遗留风险

现在开始：执行「一、开工前按序完成」。

## 指挥提示词（粘贴到这里结束）

---

## HUMAN 回来后验收速查

1. 看指挥窗口总报告 + 侧栏任务状态。
2. 抽验：`npm test` 亲跑一遍；`git status` 对照报告的工作树清单；`git log` 确认零提交。
3. live 三连目视（A9/A10/A11）：WB 对话调 `render_task_card`（视觉/走秒/主题）→ 有任务在跑时观察轮询无弹窗 → 这三个免部署即可验（卡片资源由本地代码加载，但注意：**WB 的 MCP 连接的是生产 18490 上的旧代码，新卡片要生效需 OPS3 重启生产**——live 目视实际并入 OPS3 第 7 步执行）。
4. 确认无误后按 `docs/impl/cards/OPS3-p5-production-rollout.md` 推进生产部署（需你在场授权）。
