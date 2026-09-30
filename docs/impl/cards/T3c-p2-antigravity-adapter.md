# T3c：P2 Antigravity 实时 adapter

阶段：P2 ｜ 依赖：T2（含 AGY 权限决策记录的用户结论） + **T3a 接口已回传冻结**（只消费） ｜ 并行：与 T3b、T4 并行（T3a 接口冻结后启动） ｜ 状态：✅ 全卡验收 PASS（2026-09-30 主控四件套+补充核验：增量恰好 2 卡内文件、HEAD 未动、npm test 亲跑 151/151（首跑 1 偶发 fail 复跑全绿）、单跑 12/12、测试删除行仅 2 行 skip-permissions 断言、runner 源码 flag 零命中、settings.json allow 补 2 条与回传一致、探针工件 round1-5 在档。步骤0 结论=分支1 实锤；cwd 默认放行证伪→显式 allow 修正，见决策文档 §6。**窗口曾自写本状态行，越主控验收权，已由主控重写并留档**）
设计锚点：蓝图 §5、§8 AGY 权限条款；IMPLEMENTATION.md §5.2、§5.6

## 目标

antigravity-runner 增量 step_update/result 解析 + usage 映射。**严格执行 T2 产出的 AGY 权限决策记录**（保留/移除/替代 `--dangerously-skip-permissions`），不擅自变更权限行为。

## 前置检查

- T2 RESULT=PASS；`docs/impl/agy-permission-decision.md` §4 **已有用户拍板**（2026-09-29：选项 C + 按任务粒度目录白名单，详见该节五条备注）——本卡按其执行；拍板被改动且存疑时停手回传。
- AGY 持久会话累计语义：V1 不采用持久会话，usage 取单次 invocation 口径。

## 施工步骤 0（新增，先于一切改动）：Windows 权限引擎只读验证

按决策 §4 备注 4 执行：写入候选 `~/.gemini/antigravity-cli/settings.json`（已获用户授权，仅权限相关键）→ 受控探针验证规则命中/拦截行为（不跑真实任务）→ 判定"细粒度引擎生效 / 仅上一代可用 / 均不可用"，按对应分支落地并记录证据。验证产出写入本卡回传。

## 拥有文件（单写者）

- `src/antigravity-runner.js`（改）
- `test/antigravity.test.js`（改）
其余只读；不得修改 src/usage.js、src/stream-json.js。

## 施工步骤

1. 复用增量解码与 emit 封套，接 AGY stream-json 事件流。
2. step_update→activity 事件；result→usage（累计语义按文档处理，不重复累加）+终态。
3. usage 映射：cache_read 与 input 关系按安装版本声明；样例争议（蓝图 §5 已标记未坐实）不作为映射依据；不明即 null/不可观测。
4. 权限：按决策记录执行；移除 flag 后如出现交互阻塞，如实报告该限制，不建设自动批准。
5. 保留可信路径/默认 `agy`、argv 约束。

## 测试与证据

- fixture：step_update 序列、result 累计不重复加、终态与退出冲突。
- 决策记录一致性检查：runner 实际 argv 与记录结论一致。
- `npm test` 全绿。

## 验收（对应 A 项）

A3、A4（AGY 部分）源码级证据；权限决策执行证据（argv 对比）。

## 禁止事项

禁擅自删/留权限 flag（必须按决策记录）；禁自动批准机制；禁持久会话口径 usage；禁动他卡文件；禁跑真实作业；禁 commit/push。

## 回传格式

RESULT｜基线｜改动文件清单｜决策记录执行证据｜测试计数｜A3/A4 证据摘要｜限制与不可观测项。
