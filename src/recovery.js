// 恢复扫描（IMPLEMENTATION §5.4 / 蓝图 §7）：启动时对 listNonTerminal() 逐 job 分类。
//
// 决策表（probe 身份 = { alive, startTime }，startTime 不可读为 null）：
//   有 claim、无 spawn 证据（从未启动）            → interrupted：FAILED(interrupted)，释放占用
//   进程身份确认已停止且结果缺失                    → interrupted：FAILED(interrupted)，释放占用
//   PID 存活但身份与记录不符（PID 复用，原进程已停）→ interrupted：FAILED(interrupted)，释放占用
//   进程确认存活                                    → RECOVERY_REQUIRED + execution_state=running，保留占用
//   身份不可读 / spawn 后身份未落盘窗口             → RECOVERY_REQUIRED + execution_state=unknown，保留占用
//
// 自动路径永不释放"未知"占用，永不 kill 身份未知进程，永不自动重跑。
// V1 蓝图 §7：存活也进 RECOVERY_REQUIRED（重启后 stdout 已丢失，结果无法回收），
// 人工出边只有 resolve-recovery。

function pickPid(job) {
  if (job.claim && Number.isInteger(job.claim.child_pid) && job.claim.child_pid > 0) return job.claim.child_pid;
  if (Number.isInteger(job.pid) && job.pid > 0) return job.pid;
  return null;
}

// 纯分类函数：给定 job 快照与（可选的）进程身份探针结果，返回 { classification, reason }。
// classification ∈ interrupted | running | unknown。
export function classifyRecovery(job, identity) {
  const executionState = typeof job.execution_state === "string" ? job.execution_state : null;
  const pid = pickPid(job);

  if (!pid) {
    // 无 spawn 证据：claim 已持久化但从未进入 spawn，或 QUEUED 阶段崩溃（V0 记录同理：
    // V0 在 spawn 前才写 RUNNING，QUEUED 即未启动）。
    if (executionState === "claimed") {
      return { classification: "interrupted", reason: "claim persisted before spawn; execution never started" };
    }
    if (executionState === "spawning" || executionState === "running" || job.status === "RUNNING") {
      // spawn 后身份未落盘窗口：不得推断"没有进程"。
      return { classification: "unknown", reason: "spawn window: process identity was not persisted" };
    }
    if (job.status === "QUEUED") {
      return { classification: "interrupted", reason: "queued before claim; execution never started" };
    }
    return { classification: "unknown", reason: "no process identity recorded" };
  }

  if (!identity) return { classification: "unknown", reason: "process identity not probed" };
  if (identity.alive === false) {
    return { classification: "interrupted", reason: `owner process ${pid} confirmed stopped with no persisted result` };
  }
  const startMs = typeof identity.startTime === "string" ? Date.parse(identity.startTime) : NaN;
  const recordedMs = job.claim && typeof job.claim.child_start_time === "string"
    ? Date.parse(job.claim.child_start_time)
    : NaN;
  if (Number.isFinite(startMs) && Number.isFinite(recordedMs)) {
    if (startMs === recordedMs) {
      return { classification: "running", reason: `owner process ${pid} confirmed alive with matching identity` };
    }
    return { classification: "interrupted", reason: `pid ${pid} was reused; the original process stopped with no persisted result` };
  }
  return { classification: "unknown", reason: `process ${pid} is alive but its identity is unreadable` };
}

function interruptedPatch(job, reason, now) {
  return {
    status: "FAILED",
    execution_state: "stopped",
    error: { kind: "interrupted", message: `recovery: ${reason}` },
    finished_at: now(),
    claim: job.claim
      ? { ...job.claim, released_at: now(), released_by: "recovery-scan" }
      : job.claim ?? null,
  };
}

// 启动扫描：分类并落盘。写回走 JobStore 同一串行 seam（临时文件+rename、revision+1）。
// 防御：状态目录里可能存在非 job 的 JSON（如 project-registry.json）——listAll 按
// 文件名模式收集，只有携带合法 job_id 的记录才是 job；其余跳过，不得误写。
function isJobRecord(record) {
  return Boolean(record)
    && typeof record === "object"
    && typeof record.job_id === "string"
    && record.job_id.length > 0;
}

export async function scanRecovery({ store, probe, now = () => new Date().toISOString() }) {
  const jobs = (await store.listNonTerminal()).filter(isJobRecord);
  const results = [];
  for (const job of jobs) {
    const pid = pickPid(job);
    const identity = pid ? await probe(pid) : null;
    const verdict = classifyRecovery(job, identity);
    let action;
    if (verdict.classification === "interrupted") {
      await store.update(job.job_id, interruptedPatch(job, verdict.reason, now));
      action = "failed_interrupted_released";
    } else if (verdict.classification === "running") {
      await store.update(job.job_id, {
        status: "RECOVERY_REQUIRED",
        execution_state: "running",
      });
      action = "recovery_required_running_occupied";
    } else {
      await store.update(job.job_id, {
        status: "RECOVERY_REQUIRED",
        execution_state: "unknown",
      });
      action = "recovery_required_unknown_occupied";
    }
    results.push({
      job_id: job.job_id,
      status_before: job.status,
      classification: verdict.classification,
      reason: verdict.reason,
      action,
    });
  }
  return results;
}
