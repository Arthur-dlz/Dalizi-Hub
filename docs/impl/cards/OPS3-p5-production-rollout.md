# OPS3：P5 生产部署与收官验收（看门狗舞蹈 + token 配置 + live 三连）

阶段：P5c ｜ 依赖：CH3 合入 + 全量测试绿 + **HUMAN 显式授权**（生产重启与 canary）｜ 并行：无（收尾）｜ 状态：**PASS（2026-10-05 主控执行完毕：两次看门狗舞蹈【初部署 PID 22596 / listAll 修复 PID 17168】、read token 配置、端点矩阵冒烟全绿、canary 真实派工端到端 PASS、live 三连 A9/A10 PASS + A11 浏览器通道 PASS【widget 版宿主走原生 UI，LV2 widget 侧挂遗留观察项】；证据 2026-10-04/05 工作区日志 + D:\3-huancun\p5-* 日志族）**
设计锚点：`P5-upgrade-plan.md` §5；生产运维铁律（2026-09-30 实证，见工作区 MEMORY）；OPS2 README/运维手册

## 目标

把 P5 全部成果安全送上生产（bridge 托管的 dispatcher `127.0.0.1:18490`），完成 live 三连验收并宣布 P5 收官。**本卡由主控执行、HUMAN 在场授权关键步骤；不是普通施工窗口卡。**

## 前置检查（缺一不可）

1. UX1/DOCS2/CH1/CH2/CH3 全 PASS，`npm test` 全绿。
2. **工作区未提交改动盘点**：`git status` 全量列出（含 HUMAN 在途 hunk：`VERIFIED_CODEX_MODELS` 扩充、README 改动、docs/research/ 等），HUMAN 逐项确认哪些随本次重启生效。是否 git 提交由 HUMAN 定（窗口纪律不 commit，本卡不强制）。
3. HUMAN 提供/生成 `DISPATCHER_HTTP_READ_TOKEN`（≥32 字符，独立于 MCP bearer）——主控不读凭据明文，只确认已配置进 bridge 的 dispatcher 环境。
4. 确认生产当前形态：bridge 托管 dispatcher-only、tunnelDormant、看门狗在岗（Status 只读探针，WB 会话先清 HTTP(S)_PROXY 四变量防 404 假阴性）。

## 拥有文件（单写者）

- 无代码文件。`README.md` 与 OPS 运维手册的 P5 增补（端点说明、token 配置位、看板使用方式）允许本卡修改。
其余只读；bridge 侧操作严格按下述规程，不越界改 bridge 配置结构。

## 施工步骤（生产运维铁律：生产启动只交看门狗）

1. **摘狗**：暂停看门狗自愈（Task Scheduler 上下文，按既有规程）。
2. **落码**：确认生产 dispatcher 工作目录即本仓库（`D:\1-WORK\1-gongzuoqu\Dalizi-Dispatcher`），代码文件已是 P5 合入态（文件级核对关键 hunk：资源模板、render_board、只读端点）。
3. **配 token**：把 `DISPATCHER_HTTP_READ_TOKEN` 配进 bridge 拉起 dispatcher 的环境（按 bridge 既有 env 传递方式；值不落本文档）。
4. **启狗自愈**：恢复看门狗，确认 dispatcher 新进程起来且 PID 变更、实例锁正常。
5. **只读冒烟**：清代理变量后 Status 探针 + `curl -H "Authorization: Bearer …" http://127.0.0.1:18490/mcp` 旧流程回归 + `curl "http://127.0.0.1:18490/api/jobs?token=…"` 三端点 200/401 矩阵。
6. **canary**：`npm run canary:http`（真实派工，HUMAN 已授权）PASS。
7. **live 三连（HUMAN 目视）**：① WB 对话调 render_task_card → UX1 视觉/走秒/刷新无弹窗（CH1 成果同验）；② 调 render_board → 聚合看板渲染、通道标注诚实（LV2 落档）；③ present_files(board_url) → 右侧浏览器全功能看板 SSE 实时。
8. **文档收尾**：README/OPS 手册补 P5 端点与看板用法；蓝图 §11 标记 P5 收官 + LV1/LV2 结论；当日工作区日志留痕。

## 测试与证据

进程证据（新 PID/实例锁）、三端点矩阵 curl 输出、canary 输出、live 三连目视记录、文档 diff。

## 验收

P5 收官 = 六卡全 PASS + 生产跑新代码 + canary 绿 + live 三连 HUMAN 目视确认。任一不过：回滚 = 摘狗 → 还原改动文件 → 启狗 → 复烟（旧代码无新端点依赖，回滚安全）。

## 禁止事项

禁在 WB 会话里 Start-Process 直接拉生产（会话退出连坐收割）；禁绕过看门狗；禁把 token 写入仓库/日志/回传；禁在未经授权前执行第 1/4/6 步；禁动 tunnel 配置。

## 回传格式

RESULT｜未提交改动处置清单（HUMAN 逐项确认记录）｜新 PID/实例锁证据｜三端点矩阵｜canary 结果｜live 三连记录（含 LV1/LV2 最终结论）｜文档 diff｜遗留风险。
