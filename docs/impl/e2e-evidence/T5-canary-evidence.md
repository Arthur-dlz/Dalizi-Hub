# T5 端到端 canary 证据包

日期：2026-09-30 16:00Z – 2026-10-01（本地 UTC+8 次日凌晨）｜执行：主控窗口（用户已授权三 CLI canary + 基础&恢复验证）
生产基线：dispatcher 经看门狗托管（Task Scheduler 上下文），tunnel 休眠（bridge.json tunnelDormant=true）
收官形态：dispatcher PID 14628，bridge Status ready=true，npm test 168/168（串行，零取消）

---

## 1. A1–A8 逐项裁决

| 项 | 裁决 | 证据要点 |
|---|---|---|
| A1 卡片渲染 + 刷新原位更新 | **PASS** | 9/30 live 复测已目视确认渲染+刷新原位更新（V0 卡片）；T5 期间 render_task_card 对 workbuddy 终态作业渲染成功。RECOVERY_REQUIRED 专属文案已备（task-card.html:195），本形态未触发（见 §5）。 |
| A2 claim / lease / trusted executable | **PASS** | 全部作业 claim 四要素齐全：owner_id/owner_pid、trusted_executable（绝对路径真身）、child_pid/child_start_time、released_at。agy 作业 trusted=`agy.exe` 真身路径；codex 作业 trusted=新哈希目录 `c6fe824d725f02d7\codex.exe`。 |
| A3 activity 实时活动流 | **PASS** | workbuddy：`tool_use Read`（a01）、`Bash`（k01）；agy：`tool_use view_file`（a04）；codex：`command_execution Format-Hex MARKER.txt`（c02）/`pwsh sleep 240`（c03）。均带 source/observed_at 流入快照。 |
| A4 usage null≠0 语义 | **PASS** | workbuddy a01：input 50324/output 258/cache_read 24832 reported，total=unavailable(inclusion_not_declared)；agy a04：五字段齐（input 36597/output 380/total 36977 provider 值/reasoning 308）；codex c02：input 78195/output 176/cache_read 51584/reasoning 46，total derived(input+output)；不可观测字段一律 null+unavailable_reason，无一处伪造 0。 |
| A8 幂等（双分支） | **PASS** | 同 request_id+同 payload → 同 job_id 立即返回 COMPLETED，pid/revision/updated_at 全不变，零副作用（r01 实证）；同 request_id+不同 payload → `idempotency_conflict` 拒单（主控凭记忆重建文本逐字节不符被正确识破）。 |
| 恢复语义（崩溃→扫描→清算） | **PASS（自动路径）** | 受控 kill owner ×2（33176/11396，均身份核验后 Force kill）。状态目录无损；看门狗崩溃自愈 ×2；重启后首个 dispatch 触发惰性 initialize → scanRecovery 自动 FAILED(interrupted) + `released_by=recovery-scan`（k01/c03 实证）；不重跑、不假复活。 |
| resolve-recovery 人工出边 | **PASS（守卫）** | 活 owner 持锁时执行 → `Refused: instance lock is held by a live owner`，exit 3（前置守卫实证）。RECOVERY_REQUIRED 分支本形态结构性不可达（child 随 owner 连坐死亡，见 §5），分支逻辑由 recovery.test.js 单测覆盖。 |
| 生产运维（看门狗） | **PASS** | 本阶段共 5 次看门狗拉起/自愈实证（含 2 次崩溃场景）；生产启动只交看门狗铁律复验（WB 会话 Start 会被连坐收割，§4.4）。 |

---

## 2. 三 CLI canary 终态一览

| CLI | 作业 | 结果 | final_text | 关键观测 |
|---|---|---|---|---|
| workbuddy | a01 `00c6741e` | COMPLETED ~25s | `CANARY-WORKBUDDY canary-marker-12345` | 文件读取任务；usage session 粒度 |
| workbuddy | r01 `e76eac4b` | COMPLETED ~15s | `CANARY-REPLAY-R01` | replay 基线 |
| workbuddy | k02 `76dfc3ba` | COMPLETED ~68s | `CANARY-K02` | 崩溃自愈后首作业，服务恢复实证 |
| antigravity | a04 `3fd712b4` | COMPLETED ~15s | `CANARY-ANTIGRAVITY canary-marker-12345` | effort 自动派生 low；actual_model 从 init 观测；usage 五字段 |
| codex | c02 `32ef5285` | COMPLETED ~61s | `CANARY-CODEX canary-marker-12345` | 新 CLI 路径+代理+git 检查跳过全生效 |

失败作业（全部转化为修复输入，见 §3）：agy a01/a02/a03（effort 冲突）、codex c01（git 检查）、k01/c03（恢复验证注入，按预期 interrupted）。

---

## 3. 故障注入发现 → 修复记录（三处真 bug + 一处生产地雷）

### 3.1 agy effort 默认值与模型档位后缀冲突（根因，HIGH）
- 现象：agy canary 三连败 `antigravity_model_error`，exit 1 秒挂、仅 result 事件、零 usage。
- 实锤：`gemini-3.8-flash-low` + 默认 `--effort medium` → agy 硬错误 `invalid model selection: --model gemini-3.8-flash-low conflicts with --effort=medium`。
- 修复（contracts.js）：`antigravityModelTier()` 从模型名后缀派生默认 effort；显式 effort 与后缀冲突 → `invalid_effort` 拒单（fail fast，不烧 CLI 配额）。附带修正一处误删模型 allowlist 校验顺序的重构错误（测试抓获）。
- 教训：初诊曾误判为"无代理"——代理注入本身仍是正确加固（WB 沙箱代理 127.0.0.1:55889 拦 Google 域，交互探针实证），两 bug 叠加互相掩盖。

### 3.2 出口代理注入（加固，HIGH）
- 新增 `src/egress-proxy.js`：agy/codex 子进程定向注入 `HTTP(S)_PROXY=http://127.0.0.1:7890`（Clash）+ `NO_PROXY=localhost,127.0.0.1,::1`。
- 优先级：`ANTIGRAVITY_PROXY_URL`/`CODEX_PROXY_URL` > 默认 Clash；值 `direct`/`none` 显式关闭。**环境通用代理变量不可信**（WB 沙箱 55889 拦 Google；持久化值可能是死端口——均实证）。
- workbuddy runner 不注入（走 custom-local 本地网关，勿误伤）。

### 3.3 codex 0.159.2 git 仓库信任检查（HIGH）
- 现象：c01 秒挂 exit 1，`Not inside a trusted directory and --skip-git-repo-check was not specified`。
- 修复（codex-runner.js）：argv 加 `--skip-git-repo-check`。理由：dispatcher 的 project-registry + workspace-roots 已是信任裁决层，codex 的 git 检查与之重复冲突。
- 验证：Task Scheduler 上下文探针完整跑通（command_execution 读 MARKER、usage 全字段、code-mode host 正常）。

### 3.4 生产地雷：Start 预检被 codex 自动升级卡死（HIGH，已排）
- Codex 自动升级（0.158→0.159.2）轮换哈希目录 → bridge.json 旧路径失效 → Start-DaliziHubBridge.ps1 第 11 行 Test-Path 预检 throw → **任何重启（含看门狗自愈）都会失败**。
- 修复：bridge.json 指向新路径（c6fe824d725f02d7）；Start 脚本改动态兜底（配置路径失效时扫 `bin\*\codex.exe` 取最新），原文件留 .bak-20261001。
- 长期建议：安装独立 codex CLI 于稳定路径，摆脱哈希目录生命周期（已记 RUNBOOK 口径）。

### 3.5 附带实证的环境事实
- **child 随 owner 连坐死亡**（workbuddy/codex child 均在 owner kill 后同步消失）→ 本部署形态下恢复扫描恒走 interrupted 自动路径。
- dispatcher 恢复扫描为**惰性初始化**：重启后首个 dispatch 触发 initialize 才清算（k01 清算时间戳=c03 dispatch 到达时刻，实锤）。
- WB 会话进程树退出连坐收割子进程：生产启动只交看门狗（本阶段复验一次，Status 抓获空挂）。

---

## 4. 源码变更清单（本窗口，全部测试护航）

| 文件 | 变更 |
|---|---|
| `src/egress-proxy.js` | 新增：定向代理注入 helper（默认 Clash、专属变量覆盖、direct 关闭、不信任环境通用代理） |
| `src/antigravity-runner.js` | spawn env 注入（agy 子进程） |
| `src/codex-runner.js` | spawn env 注入 + argv `--skip-git-repo-check` |
| `src/contracts.js` | `antigravityModelTier()` + agy effort 派生/冲突拒单 |
| `test/egress-proxy.test.js` | 新增 7 测试 |
| `test/antigravity.test.js` | +2 代理注入测试；effort levels 测试更新为档位语义（agy 1.2.14 live 证据） |
| `test/codex.test.js` | +2 代理注入测试；argv 断言加 `--skip-git-repo-check` |
| `test/contracts.test.js` | +2（tier 派生默认值矩阵 + 冲突拒单矩阵） |
| 测试总数 | 155 → **168/168**（串行零取消） |

外部（bridge，用户已授权，留 .bak）：`config/bridge.json` codexCliPath 新路径；`scripts/Start-DaliziHubBridge.ps1` codex 路径动态兜底。

---

## 5. 差距与校准清单（遗留，不阻塞收官）

1. **codex cache_write 映射校准**：0.159.2 真实样本显示 turn.completed.usage 有 `cache_write_input_tokens` 字段（探针值 0），runner 映射表未覆盖 → cache_write_tokens 仍 unavailable(source_field_absent)。安全方向（宁缺勿假），建议 T 卡校准 USAGE_FIELD_MAP。
2. **RECOVERY_REQUIRED running/unknown 分支**：本形态 child 连坐，live 不可达；仅单测覆盖。若未来部署形态变更（child 可逃逸），需补 live 验证。
3. **agy actual_model**：经 init 事件可观测（a04 已得 gemini-3.8-flash-low）；NOT_OBSERVABLE 仅在 init 缺失时出现，语义正确。
4. **claude 系 agy 模型**（claude-sonnet-4-6 等无后缀）：effort 语义未经 live 校准（假设 agy 不报冲突），首跑时注意。
5. **agy usage 字段单位**：result.usage.duration_seconds 存在（探针样本 6.118s）但快照仍 unavailable——runner 未映射秒→毫秒，校准项。
6. **看门狗触发链**：retry trigger 每分钟点火（IgnoreNew），watchdog 进程死亡后 ≤1min 自重启 + 3×30s 阈值自愈——本阶段 5 次实证均值约 2.5–3 分钟恢复。
7. **WB 沙箱限制**：孙进程命名管道（codex code-mode host os error 231）与 Google 域代理白名单——仅影响 WB 内探针，不影响生产路径；探针须走调度任务上下文复刻。

---

## 6. 证据索引

- 作业快照：`.dispatcher-data/<job_id>.json`（job_id 见 §2/§3）
- 探针日志：`D:\3-huancun\dlz-t5-canary\`（agy-probe-proxy.log、effort-m/h.log、codex-probe3.log、sched-agy-probe.log、sched-codex-probe.log、restart-gate*.txt、recovery-*.txt、persisted-proxy.txt）
- bridge 备份：`D:\1-WORK\agent\dalizihub-bridge\config\bridge.json.bak-20261001`、`scripts\Start-DaliziHubBridge.ps1.bak-20261001`
- 测试基线：168/168（`node --test --test-concurrency=1`，duration ~47–209s 方差为 Windows FS 常态）

纪律：本窗口未 commit、未 push；bridge 改动已备份；两个一次性探针计划任务已清理。
