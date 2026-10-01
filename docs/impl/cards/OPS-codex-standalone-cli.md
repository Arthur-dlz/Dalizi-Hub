# OPS-codex-standalone：独立 Codex CLI 稳定路径安装（调研 + 安装 + 验证，不含配置切换）

阶段：运维加固 ｜ 依赖：无 ｜ 并行：可与任何卡并行（不碰仓库）｜ 状态：待施工
来源：证据包 §3.4 长期建议——生产 dispatcher 当前消费桌面版 Codex（`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`），hash 目录随自动升级轮换（0.158→0.159.2 已炸过一次，T5 排雷）。目标 = 装一份**不自动升级、路径永久稳定**的独立 Codex CLI，供 bridge 改指。

---

## ⛔ 红线（先读本节再动手；违反 = 返工 + 纪律留档）

1. **禁止触碰任何项目的 `.workbuddy/` 目录。**
2. 本卡**只允许**：①查官方文档/仓库（只读网络）；②在 `D:\2-ruanjian\codex-standalone\` 目录内写文件；③在 `D:\3-huancun\` 写日志/证据；④运行本卡规定的验证命令。**其余一切路径只读。**
3. **禁止**修改 `D:\1-WORK\agent\dalizihub-bridge\` 下任何文件（bridge.json 切换由主控做，不是你的活）。
4. **禁止**启动、停止、重启任何服务/进程；禁止运行 dispatch_task；禁止用新装的 codex 跑任何真实任务（只允许 `--version` 与 `--help` 级验证）。
5. **禁止**永久修改系统/用户 PATH、环境变量、注册表；禁止 `npm config set prefix` 全局写入（用命令行 `--prefix` 一次性参数代替）。
6. **禁止**卸载、停用、改动现有桌面版 Codex 及其自动升级——它在岗服役，你只是装平行副本。
7. 禁止 `git commit` / `git push`。
8. 回传只写事实；卡住写 BLOCKED，禁止编造。
9. **开工第一步（未做=回传拒收）**：记录基线——`node --version`、系统 node 的 npm 版本、现有桌面 codex 版本输出，原文贴进回传。

## 背景事实（已核实，直接采信）

- 现役：桌面版 Codex `0.159.2`，exe = `C:\Users\Arthur\AppData\Local\OpenAI\Codex\bin\c6fe824d725f02d7\codex.exe`
- dispatcher 消费方式：bridge 启动时把 exe 绝对路径注入 `CODEX_CLI_PATH` 环境变量；codex-runner 直接 spawn 该 exe（**不能是 .cmd/.ps1 shim**，必须是真 exe）
- 本机目录规则（用户铁律）：普通软件装 `D:\2-ruanjian`；缓存/下载/临时进 `D:\3-huancun`；**禁止永久改 PATH**
- 出网：npm registry 若直连失败，用 Clash 代理 `http://127.0.0.1:7890`（命令行临时环境变量，禁止写入配置）

## 施工步骤

### 1. 调研（只读网络，产出写进回传）

确认 npm 包 `@openai/codex` 的：①最新版本号；②Windows x64 平台二进制的包内布局（真 exe 在哪个子路径，形如 `node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\...\codex.exe`，以实际安装后为准）；③与桌面版 0.159.2 的版本对应关系。官方来源优先（npm registry 页 / GitHub openai/codex）。

### 2. 安装（限定路径）

```powershell
# 用系统 node 的 npm，一次性 --prefix，禁止 npm config set
& "D:\2-ruanjian\Node\22.18.0\npm.cmd" install -g "@openai/codex" --prefix "D:\2-ruanjian\codex-standalone"
# 若 registry 超时/被拦：
$env:HTTPS_PROXY="http://127.0.0.1:7890"; $env:HTTP_PROXY="http://127.0.0.1:7890"
# 重跑上面的 install；完成后 Remove-Item 这两个临时变量
```

### 3. 定位真 exe + 验证

1. 在 `D:\2-ruanjian\codex-standalone\` 内递归找到真 `codex.exe`（不是 .cmd shim），记录完整绝对路径。
2. 执行 `<真exe路径> --version`，输出版本号原文进回传。
3. 执行 `<真exe路径> exec --help`，确认 `exec` 子命令与 `--skip-git-repo-check` 旗标存在（dispatcher argv 依赖它），输出关键行进回传。
4. 记录 exe 文件大小与 SHA256（`Get-FileHash`），作为锚定证据。

### 4. 回传即交棒

安装验证完即收工。**bridge.json 改指、dispatcher 重启、生产验证全部由主控执行**，与你无关。

## 完成判定

- `D:\2-ruanjian\codex-standalone\` 内存在真 codex.exe，`--version` 正常输出版本 ≥ 0.159.2
- `exec --help` 含 `--skip-git-repo-check`
- 系统 PATH / npm 全局配置 / 桌面版 Codex 零改动（主控会核查）
- 若 npm 路线走不通（包不存在/平台二进制缺失）：写 BLOCKED + 已尝试命令与报错原文 + 备选方案建议（如 GitHub Releases 官方 zip），**不许自行改走其他安装渠道**

## 回传格式

```
RESULT=PASS|BLOCKED
开工基线=<node/npm/桌面codex 版本原文>
安装路径=<真 exe 绝对路径>
版本=<--version 输出原文>
exec --skip-git-repo-check=<存在|不存在 + 证据行>
SHA256=<哈希>
包布局=<真 exe 相对包的子路径>
网络=<直连|Clash代理>
越界自检=<PATH/npm config/桌面版 三项零改动确认>
遗留风险=<如：npm 包版本与桌面版行为差异未知项>
```
