# T5-cal：usage 映射校准（codex cache_write + agy duration 链路）

阶段：P4-校准 ｜ 依赖：T5（已完成，证据包 §5）｜ 并行：可与 T4-ux 并行（文件不相交）｜ 状态：验收 PASS（证据：COMMANDER-RUNBOOK.md §2 T5cal 行）
来源：`docs/impl/e2e-evidence/T5-canary-evidence.md` §5 遗留校准项 1 与 5（真实样本驱动）。

---

## ⛔ 红线（先读本节再动手；违反 = 返工 + 纪律留档）

1. **禁止触碰 `.workbuddy/` 目录（含其下所有文件）——日志由主控写，你只回传。**
2. 只允许修改「拥有文件」列出的文件，其余一切只读（`.dispatcher-data/` 与 `D:\3-huancun\` 下的样本文件**只许读、一个字节都不许改**）。
3. 禁止 `git commit` / `git push` / 任何 git 写操作。
4. 禁止启动、停止、重启任何服务或进程；**禁止运行 dispatch_task 或任何真实 CLI 作业**（本卡全部用既有样本做离线校准，不需要也不允许新的 live 运行）。
5. 禁止读取 `secrets/`、凭据、token。
6. 禁止碰 `D:\1-WORK\agent\dalizihub-bridge\`。
7. 回传只写事实；做不成的写 `NOT_PROVEN`，禁止编造。
8. **开工第一步（未做=回传拒收）**：`git status --porcelain` + `node --test --test-concurrency=1`，输出原文贴进回传「开工基线」。当前正确基线 = 工作区干净、168/168。不符则停止并回传 BLOCKED。

## 拥有文件（单写者）

- `src/codex-runner.js`（改，仅 `USAGE_FIELD_MAP` 区域）
- `src/antigravity-runner.js`（改，仅当 duration 断点定位在 runner 时）
- `src/usage.js`（改，仅当 duration 断点定位在聚合器时）
- `test/codex.test.js`（改）
- `test/antigravity.test.js`（改，仅当改了 antigravity-runner 时）
- `test/usage.test.js`（改，仅当改了 usage.js 时；若该文件不存在则在既有对应测试文件内追加）

**不允许**改 dispatcher.js / job-store.js / mcp-server.js / contracts.js / 其他任何 src。

## 校准项 1：codex `cache_write_input_tokens` 映射

**事实**（证据包 §5.1，已核实）：codex 0.159.2 真实样本的 `turn.completed.usage` 含字段 `cache_write_input_tokens`；当前 `src/codex-runner.js:20-25` 的 `USAGE_FIELD_MAP` 中 `cache_write_tokens` 的 paths 只有 `cache_write_tokens` 与 `cache_creation_input_tokens`，未覆盖 → 快照 cache_write_tokens 恒 `unavailable(source_field_absent)`。

**做法**：把 `"cache_write_input_tokens"` 追加进 `cache_write_tokens` 的 paths 数组（放末尾，不改变既有优先级）。就这么一处，不许顺手"优化"别的映射。

**样本取证**（只读）：`.dispatcher-data/32ef5285-fdce-47b8-8328-1602288e3046.json`（c02 作业）与 `D:\3-huancun\dlz-t5-canary\codex-probe3.log` 中有真实 usage 形状，提取进测试夹具。

## 校准项 2：agy `duration_seconds` → 快照链路排查

**事实**（证据包 §5.5）：agy result.usage 有 `duration_seconds`（探针样本 6.118），但快照 duration 仍 unavailable。注意 `src/antigravity-runner.js:30` **已存在** `{ name: "wall_duration_ms", paths: ["duration_seconds"], unit: "ms", scale: 1000 }`——所以断点不在"没映射"，而在链路下游。你的工作：

1. 读 `src/usage.js`（重点 `:12` 已知指标清单、`:37` 单位表、`:211` `#projectMetric` 附近）与 `src/antigravity-runner.js` 的 usage 上报路径，**定位 `wall_duration_ms` 在哪一环被丢弃/拒收**（可能：聚合器 canonical 名单未收录、单位表缺项、快照投影未透出——以代码事实为准，禁止猜测）。
2. 用最小改动修通：agy 真实样本的 duration_seconds 应以毫秒值出现在快照对应字段；**null≠0 语义不许破坏**（字段缺失时必须仍是 unavailable，不许伪造 0）。
3. 若修通需要动 `src/usage.js` 的 canonical 名单，只追加 `wall_duration_ms` 一项，不得重排既有项。

**样本取证**（只读）：`.dispatcher-data/3fd712b4-f484-461c-a008-ed2e2b071858.json`（a04 作业）与 `D:\3-huancun\dlz-t5-canary\sched-agy-probe.log`。

## 明确范围外（证据包 §5 其余项，本卡不做）

§5.2 RECOVERY_REQUIRED 分支、§5.3 actual_model、§5.4 claude 系 effort live 校准、§5.6 看门狗链、§5.7 WB 沙箱——**全部是注记项或需 live 授权项，不许碰**。

## 测试与证据

1. codex：夹具含 `cache_write_input_tokens: <正整数>` 的 turn.completed usage → cache_write_tokens 上报为该值；夹具不含该字段 → 仍 `unavailable(source_field_absent)`（回归不破坏）。
2. agy：夹具含 `duration_seconds: 6.118` → 快照对应字段 = 6118（ms）；字段缺失 → unavailable（回归不破坏）。
3. **全量回归**：`node --test --test-concurrency=1` 全绿（基线 168 + 你新增用例数）。

## 验收

主控四件套：git status 只许拥有清单内文件；亲跑全量；grep 在码（`cache_write_input_tokens`、duration 链路断点修复点）；红线核查（特别查 `.dispatcher-data` 与样本目录 mtime——只读承诺）。

## 回传格式

```
RESULT=PASS|FAIL|PARTIAL|BLOCKED
开工基线=<git status 原文 + npm test 计数>
改动文件=<清单>
校准项1=<改动点 + 测试结果>
校准项2=<断点定位结论（文件:行 + 一句话机理）+ 修复点 + 测试结果>
测试计数=<基线168 + 新增N = 总数，通过数>
遗留风险=<没有就写"无">
```
