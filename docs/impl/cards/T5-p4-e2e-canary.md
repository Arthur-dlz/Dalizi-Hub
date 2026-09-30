# T5：P4 受控端到端 canary（需用户显式授权后启动）

阶段：P4 ｜ 依赖：T2+T3a/b/c+T4 全部 RESULT=PASS + 用户 canary 授权 + 独立 canary 项目就绪 ｜ 并行：无（最后执行） ｜ 状态：待授权
设计锚点：蓝图 §10 A8、§6 Desktop 体验；IMPLEMENTATION.md §6

## 目标

对每种启用 CLI 跑一项受控真实任务，走通 Desktop→隧道→Dispatcher→CLI→卡片 全链路，产出 A1/A2/A3/A4/A8 的真实环境证据。**本卡派发真实工作，不是只读验证；未获用户明确授权不得启动。**

## 前置检查（缺一不可）

- T2/T3a/b/c/T4 回传全部 PASS；T0 Desktop 能力结论为"支持"（若为"不支持"，回传主控走蓝图 §6 缺口流程，不擅自降级）。
- 用户显式授权文本（允许跑哪些 CLI、canary 项目路径）。
- canary 项目为独立测试目录，非真实业务仓库。

## 拥有文件

- 不改仓库源码；产出 `docs/impl/e2e-evidence/`（新目录，证据记录）。
- canary 项目目录内的任务产物属被测对象，如实记录不清理（由用户处置）。

## 施工步骤

1. 环境记录：各 CLI 版本/路径、Dispatcher 候选 HEAD、隧道状态（仅记录实际可达性，不断言健康）。
2. 每种启用 CLI 一项受控任务：从 WorkBuddy Desktop dispatch_task（携带 request_id）→ render_task_card → 观察活动/心跳/usage 实时更新 → 手动刷新按钮 → 终态结果。
3. 重放验证：同 request_id 重复 dispatch → 同 job 不重复执行。
4. 恢复验证（可选，用户单独授权）：受控 kill owner 进程→重启→观察 RECOVERY_REQUIRED 与人工解除路径。
5. 每 CLI 记录：job_id、版本、进程/CLI 证据、快照序列、结果、不可观测项清单。

## 测试与证据

- A1：Desktop 卡片渲染+按钮原位更新实测记录（无新聊天消息、无新 dispatch）。
- A2：至少两种 WB Desktop Agent/模型组合走同一接口的真实调用记录。
- A3/A4：CLI 结束前可查询真实步骤/心跳；usage 与 CLI 自报对账，缺口列不可观测项。
- A8：每 CLI 全链路记录+无越界改动检查（git status 仅预期文件）。

## 验收（对应 A 项）

A1、A2、A3、A4、A8 真实环境证据；A5/A6/A7 在真实环境抽验（已在 T2/T4 有源码级证据）。

## 禁止事项

未经授权禁启动；禁用真实业务项目当 canary；禁修改 Dispatcher 权限/配置迁就测试；禁把"CLI 输出最终答复"宣称为业务验收通过；禁 commit/push/部署。

## 回传格式

RESULT｜环境基线｜每 CLI 证据包（job_id/版本/快照序列/结果/不可观测项）｜A 项逐项判定｜发现的缺口与建议。
