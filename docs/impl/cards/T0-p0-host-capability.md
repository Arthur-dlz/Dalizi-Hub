# T0：P0 宿主能力探查（只读）

阶段：P0 ｜ 依赖：无 ｜ 并行：可与所有卡并行（只读，零写冲突） ｜ 状态：**已完成**（主控验收 PARTIAL，2026-09-29；A1 live 实测归用户/T5，报告见 `D:\3-huancun\dlz-r2-probe\T0-p0-host-capability-report.md`）
设计锚点：蓝图 §6、§10 P0 行、§11 最优先缺口；IMPLEMENTATION.md §5.7

## 目标

用只读/版本级探针查明 V1 最大的未知数，产出能力清单，决定 A1 呈现方案是否成立：
1. WorkBuddy Desktop 是否支持 MCP Apps 资源渲染 + 卡片内按钮经桥接调 `get_task`（不接受 mock、不接受聊天轮询替代）。
2. 三个 CLI（WorkBuddy/CodeBuddy、Codex、Antigravity）的安装版本、路径、事件流与 usage 字段的真实样本来源。
3. 卡片桥接宿主 origin 的可枚举性（为 postMessage 收敛提供白名单输入）。

## 前置检查

- `git rev-parse HEAD` 应为 `87e42ec9acabe54327aa532df4fa54a05bd541ef` 或主控公布的新基线；不符先停手回传。
- 确认本卡为只读：不写仓库任何文件（产出物写到主控指定位置或直接在回传报告中给出）。

## 拥有文件

无（只读卡）。不修改仓库内任何文件。

## 施工步骤

1. 版本与路径清单：三 CLI 的 `--version`/`--help` 输出、可执行路径、配置文件位置（不读凭据内容）；WorkBuddy Desktop 版本；Node 版本。
2. 事件/usage 样本来源盘点：查找本机**已有**的 CLI session 日志/历史输出（脱敏后摘录字段名与结构）；没有则用官方文档核对字段清单并标注"缺本机实证"。不新跑真实任务。
3. Desktop 能力实测（需用户配合的步骤明确标注）：由主控/用户在已授权环境中用现有 V0 代码渲染 `render_task_card` 卡片，记录：卡片是否渲染、刷新按钮是否存在、点击是否触发 `get_task` 工具调用、更新是否原位发生。
4. 桥接通道探查：卡片内 `postMessage` 宿主 origin 是否可枚举/可固定；`window.openai` 对象在真实宿主是否存在。

## 测试与证据

- 版本/路径/字段清单（命令+输出摘录，敏感值脱敏）。
- Desktop 实测记录：操作序列、每步结果、截图或日志（若可得）、明确结论（支持/不支持/部分支持）。
- 未证实项逐条列出，不推断。

## 验收（对应 A 项）

- A1（能力判定部分）：Desktop 卡片渲染+按钮调 get_task 得到"支持/不支持"的明确实测结论。
- 为 A3/A4 提供各 CLI 样本来源清单；为 §5.7 提供 origin 结论。

## 禁止事项

禁跑真实 CLI 作业/canary；禁启停服务；禁读 `.workbuddy/`、凭据、token、PID 文件内容；禁修改仓库文件；禁 git 写操作；禁用 mock 或"发聊天刷新"冒充 Desktop 验收。

## 回传格式

RESULT（PASS/FAIL/PARTIAL/NOT_PROVEN）｜基线（HEAD/日期/环境）｜能力清单（每项：支持/不支持/未证实+证据）｜对 A1 呈现方案的结论与建议｜发现的精确缺口。
