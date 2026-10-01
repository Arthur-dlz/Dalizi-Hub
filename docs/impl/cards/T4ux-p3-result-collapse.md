# T4-ux：任务卡结果区缩略 + 就地展开（微卡）

阶段：P3-ux ｜ 依赖：T4（已完成）｜ 并行：可与其他卡并行 ｜ 状态：验收 PASS（全线收官；证据：COMMANDER-RUNBOOK.md §2 T4ux 行；用户目视 2026-10-01 13:14 通过）
来源：用户目视痛点（终态卡片结果区全文平铺、卡片巨大）→ 主控微卡。

---

## ⛔ 红线（先读本节再动手；违反 = 返工 + 纪律留档）

1. **禁止触碰 `.workbuddy/` 目录（含其下所有文件，含 `memory/`）——工作日志由主控撰写，你只负责回传。已有三个窗口因写此目录被记过，你是第四个会被检查的。**
2. 只允许修改「拥有文件」列出的 2 个文件，其余一切文件只读。
3. 禁止 `git commit` / `git push` / 任何 git 写操作。
4. 禁止启动、停止、重启任何服务或进程（dispatcher、bridge、看门狗一律不碰）。
5. 禁止读取 `secrets/`、凭据、token、环境变量中的密钥。
6. 禁止碰 `D:\1-WORK\agent\dalizihub-bridge\` 下任何东西（只读也不行）。
7. 回传只写事实；做不成的写 `NOT_PROVEN` 或 `BLOCKED`，**禁止编造成功叙事**（前车之鉴：T6 窗口因编造开工基线被记纪律 FAIL）。
8. **开工第一步（未做=回传拒收）**：执行 `git status --porcelain` 和 `npm test`（串行，命令见下），把输出原文贴进回传的「开工基线」一节。当前正确基线 = 工作区干净、168/168。若你的基线不是这个，**停止施工并立即回传 BLOCKED**。

## 拥有文件（单写者）

- `src/task-card.html`（改）
- `test/task-card.test.js`（改）

其余只读。`src/task-card.js` **本卡不改**（资源注册逻辑不动）。

## 目标

终态任务卡的结果区（final_text）目前全文平铺，长结果（数千字）把卡片撑得巨大。改为：默认缩略，用户点击后**就地展开**阅读全文，可再收起。

## 现状锚点（已核实，直接引用）

- HTML 结构：`:52-55` — `<section id="result_block" class="result" hidden>` 内含 `<h2>结果</h2>` 与 `<p id="result"></p>`
- 渲染逻辑：`:248-250` — `fields.result.textContent = result; resultBlock.hidden = result === '';`
- 样式：`:23-25` — `.result` / `.result p`（`white-space: pre-wrap`）
- 文本来源：`:137-142` — `resultText(task)`
- 测试模式：`test/task-card.test.js` 用 `node:vm` 的 `runInNewContext` 把 HTML 内联脚本加载进 VM 上下文驱动断言——**新测试必须沿用同一模式**，先看懂现有 2 个用例怎么写的再仿写。

## 施工要求（全部必须满足）

1. **阈值**：结果文本 `length > 500` 字符 **或** 行数 `> 8` 行 → 进入可折叠形态；否则渲染与今天完全一致（无按钮、无折叠、零行为变化）。
2. **缩略态**：显示前 500 字符（在不超过 500 的最后一个换行处截断；无换行则硬截 500）+ 末尾拼接 ` …`；下方一个按钮 `展开全文（共 N 字符）`（N=完整文本长度）。
3. **展开态**：显示完整文本，容器 `max-height: 50vh; overflow-y: auto;`（超长内部滚动，不撑爆卡片）；按钮变为 `收起`。点击收起回到缩略态。
4. **就地**：展开/收起只改当前区块高度，不弹窗、不跳转、不影响卡片其他区块（usage/activity 等）布局。
5. **刷新保持（核心难点）**：以 `job_id` 为键记忆 `expanded` 布尔与展开态容器的 `scrollTop`；快照刷新（同一 job_id 的 showTask 重渲染）后恢复展开状态与滚动位置；切换到不同 job_id 时重置为缩略默认。**禁止**把状态写进全局可变对象污染跨 job 行为——用 `Map<job_id, {expanded, scrollTop}>` 或等价结构。
6. 空结果（`result === ''`）时 `resultBlock.hidden = true` 的现有逻辑**必须原样保留**。
7. `white-space: pre-wrap` 保留（中文/排版不换行错乱）。
8. 不引入任何外部依赖、不发网络请求、不改动桥接/postMessage 逻辑。

## 测试与证据（`test/task-card.test.js` 新增，沿用 runInNewContext 模式）

1. 边界矩阵：500 字符整 / 501 字符 / 8 行整 / 9 行 → 是否可折叠的判定正确。
2. 缩略预览文本正确（换行处截断 vs 硬截两例）。
3. 展开→渲染全文+容器样式类存在；收起→回到缩略。
4. 同 job_id 刷新后：展开状态与 scrollTop 保持；异 job_id：重置缩略。
5. 短文本（<500 且 ≤8 行）：无按钮、textContent 与现状逐字节一致。
6. 空结果：resultBlock 隐藏逻辑不回归。
7. **全量回归**：`node --test --test-concurrency=1` 全绿（基线 168，加上你新增的用例数）。

## 验收

主控四件套：git status 只许 2 个文件改动；亲跑全量；grep 在码（阈值/Map 状态键/50vh）；红线核查。

## 回传格式

```
RESULT=PASS|FAIL|PARTIAL|BLOCKED
开工基线=<git status 原文 + npm test 计数>
改动文件=<清单>
测试计数=<基线168 + 新增N = 总数，通过数>
关键设计=<缩略截断策略 / 状态保持实现方式，各一句话>
证据=<上述 6 项测试逐条结果>
遗留风险=<没有就写"无">
```
