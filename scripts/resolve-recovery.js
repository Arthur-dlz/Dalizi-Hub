// 人工解除命令（IMPLEMENTATION §5.5 / 蓝图 §7）：本地管理命令，不是 MCP 工具。
//
//   npm run resolve-recovery -- --job <job_id> --confirm --evidence "<证据摘要>"
//
// - --job / --confirm / --evidence 缺一即拒绝；
// - 仅对 RECOVERY_REQUIRED 的 job 生效；
// - 前置条件：目标 owner 已停止——命令先 acquire 该状态目录实例锁（含 stale 判定），
//   锁被活 owner 持有则拒绝并提示先停 owner；
// - 获锁后即唯一写者：写回走 JobStore 同款临时文件+rename、revision+1，
//   FAILED(interrupted_confirmed) + 审计行 + 释放持久 claim；
// - 终端输出操作回执。
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { JobStore } from "../src/job-store.js";
import { InstanceLock } from "../src/instance-lock.js";

const USAGE = 'Usage: npm run resolve-recovery -- --job <job_id> --confirm --evidence "<evidence summary>"';

function refuse(message, exitCode) {
  console.error(`Refused: ${message}`);
  process.exitCode = exitCode;
}

async function main() {
  const { values } = parseArgs({
    options: {
      job: { type: "string" },
      confirm: { type: "boolean", default: false },
      evidence: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const job = typeof values.job === "string" ? values.job.trim() : "";
  const evidence = typeof values.evidence === "string" ? values.evidence.trim() : "";
  if (job === "" || values.confirm !== true || evidence === "") {
    refuse(`all of --job, --confirm and a non-empty --evidence are required. ${USAGE}`, 2);
    return;
  }

  const dataDirectory = process.env.DISPATCHER_DATA_DIR || path.join(process.cwd(), ".dispatcher-data");
  const store = new JobStore(dataDirectory);
  const lock = new InstanceLock({ directory: path.join(dataDirectory, "run") });

  // 前置条件：目标 owner 已停止。先取实例锁（含 stale 判定）；活 owner 持锁则拒绝。
  let acquired;
  try {
    acquired = await lock.acquire();
  } catch (error) {
    refuse(`instance lock is held by a live owner — stop the Dispatcher owner first. (${error?.message ?? error})`, 3);
    return;
  }

  try {
    let snapshot;
    try {
      snapshot = await store.get(job);
    } catch (error) {
      refuse(`${error?.code ?? "error"}: ${error?.message ?? error}`, 4);
      return;
    }
    if (snapshot.status !== "RECOVERY_REQUIRED") {
      refuse(`job ${job} is ${snapshot.status}, not RECOVERY_REQUIRED.`, 5);
      return;
    }

    const resolvedAt = new Date().toISOString();
    const operator = os.userInfo().username;
    const claim = snapshot.claim
      ? { ...snapshot.claim, released_at: resolvedAt, released_by: operator }
      : snapshot.claim ?? null;

    // 写回：FAILED(interrupted_confirmed) + 释放持久 claim（临时文件+rename、revision+1）。
    const updated = await store.update(job, {
      status: "FAILED",
      execution_state: "stopped",
      error: {
        kind: "interrupted_confirmed",
        message: "execution interrupted; operator confirmed the owner is stopped",
      },
      finished_at: resolvedAt,
      claim,
    });

    // 审计行（人工路径的唯一审计入口）。
    const auditFile = path.join(dataDirectory, "run", "recovery-audit.jsonl");
    await mkdir(path.dirname(auditFile), { recursive: true });
    await appendFile(
      auditFile,
      `${JSON.stringify({
        job_id: job,
        operator,
        resolved_at: resolvedAt,
        evidence,
        action: "failed_interrupted_confirmed",
        revision: updated.revision,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    console.log(JSON.stringify({
      job_id: job,
      status: updated.status,
      error_kind: updated.error?.kind ?? null,
      revision: updated.revision,
      claim_released_at: updated.claim?.released_at ?? null,
      operator,
      resolved_at: resolvedAt,
      audit_file: auditFile,
      stale_lock_takeover: acquired.staleTakeover === true,
    }, null, 2));
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error(`error: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
