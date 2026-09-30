import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore } from "../src/job-store.js";
import { classifyRecovery, scanRecovery } from "../src/recovery.js";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/resolve-recovery.js", import.meta.url));

const NOW = () => "2026-09-29T12:00:00.000Z";
const CLAIM_BASE = {
  owner_id: "owner-1",
  owner_pid: 1000,
  claimed_at: "2026-09-29T11:59:00.000Z",
  trusted_executable: "C:/tools/cli.exe",
  child_pid: null,
  child_start_time: null,
  released_at: null,
};

function baseJob(jobId, overrides = {}) {
  return {
    job_id: jobId,
    agent: "workbuddy",
    project: "canary",
    status: "RUNNING",
    created_at: "2026-09-29T11:58:00.000Z",
    started_at: "2026-09-29T11:59:00.000Z",
    pid: null,
    ...overrides,
  };
}

async function prepare(fixtures) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-recovery-"));
  const store = new JobStore(path.join(directory, "jobs"));
  for (const fixture of fixtures) await store.create(fixture);
  return { directory, store };
}

// §5.4 决策表全表（A6 fixture：未启动 / 已停缺结果 / 存活 / PID 复用 / 身份未知）。
test("recovery scan classifies every §5.4 row and only releases confirmed-stopped occupancy", async () => {
  const childStart = "2026-09-29T11:59:01.000Z";
  const { directory, store } = await prepare([
    baseJob("job-never-started", {
      status: "RUNNING",
      execution_state: "claimed",
      claim: { ...CLAIM_BASE },
    }),
    baseJob("job-queued-crash", {
      status: "QUEUED",
      execution_state: "idle",
    }),
    baseJob("job-stopped-missing-result", {
      execution_state: "running",
      pid: 4242,
      claim: { ...CLAIM_BASE, child_pid: 4242, child_start_time: childStart },
    }),
    baseJob("job-alive", {
      execution_state: "running",
      pid: 4243,
      claim: { ...CLAIM_BASE, child_pid: 4243, child_start_time: childStart },
    }),
    baseJob("job-pid-reused", {
      execution_state: "running",
      pid: 4244,
      claim: { ...CLAIM_BASE, child_pid: 4244, child_start_time: childStart },
    }),
    baseJob("job-identity-unknown", {
      execution_state: "running",
      pid: 4245,
      claim: { ...CLAIM_BASE, child_pid: 4245 },
    }),
    baseJob("job-spawn-window", {
      status: "RUNNING",
      execution_state: "spawning",
      claim: { ...CLAIM_BASE },
    }),
    baseJob("job-legacy-v0-running", {
      status: "RUNNING",
    }),
    baseJob("job-terminal-completed", { status: "COMPLETED", final_text: "done" }),
  ]);

  try {
    const probe = async (pid) => {
      if (pid === 4242) return { alive: false, startTime: null };
      if (pid === 4243) return { alive: true, startTime: childStart }; // 身份匹配 → 存活
      if (pid === 4244) return { alive: true, startTime: "2026-09-29T12:30:00.000Z" }; // PID 复用
      if (pid === 4245) return { alive: true, startTime: null }; // 身份不可读
      return { alive: false, startTime: null };
    };
    const summary = await scanRecovery({ store, probe, now: NOW });

    const byId = new Map(summary.map((row) => [row.job_id, row]));
    assert.equal(byId.get("job-never-started").classification, "interrupted");
    assert.equal(byId.get("job-queued-crash").classification, "interrupted");
    assert.equal(byId.get("job-stopped-missing-result").classification, "interrupted");
    assert.equal(byId.get("job-alive").classification, "running");
    assert.equal(byId.get("job-pid-reused").classification, "interrupted");
    assert.equal(byId.get("job-identity-unknown").classification, "unknown");
    assert.equal(byId.get("job-spawn-window").classification, "unknown");
    assert.equal(byId.get("job-legacy-v0-running").classification, "unknown");
    assert.equal(byId.get("job-terminal-completed"), undefined); // 终态不进入扫描
    assert.equal(summary.length, 8);

    const neverStarted = await store.get("job-never-started");
    assert.equal(neverStarted.status, "FAILED");
    assert.equal(neverStarted.error.kind, "interrupted");
    assert.equal(neverStarted.execution_state, "stopped");
    assert.equal(neverStarted.claim.released_by, "recovery-scan");
    assert.ok(neverStarted.claim.released_at);

    const alive = await store.get("job-alive");
    assert.equal(alive.status, "RECOVERY_REQUIRED"); // 蓝图 §7：存活也进 RECOVERY_REQUIRED（stdout 已丢失）
    assert.equal(alive.execution_state, "running"); // 但保留占用、继续观察
    assert.equal(alive.claim.released_at, null); // 占用未释放

    const reused = await store.get("job-pid-reused");
    assert.equal(reused.status, "FAILED");
    assert.equal(reused.error.kind, "interrupted");

    const unknown = await store.get("job-identity-unknown");
    assert.equal(unknown.status, "RECOVERY_REQUIRED");
    assert.equal(unknown.execution_state, "unknown");
    assert.equal(unknown.claim.released_at, null); // 未知占用永不自动释放

    const spawnWindow = await store.get("job-spawn-window");
    assert.equal(spawnWindow.status, "RECOVERY_REQUIRED");
    assert.equal(spawnWindow.execution_state, "unknown");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("classifyRecovery is a pure table over (snapshot, identity)", () => {
  const childStart = "2026-09-29T11:59:01.000Z";
  const claim = { ...CLAIM_BASE, child_pid: 4242, child_start_time: childStart };
  assert.deepEqual(
    classifyRecovery(baseJob("a", { execution_state: "claimed", claim: { ...CLAIM_BASE } }), null),
    { classification: "interrupted", reason: "claim persisted before spawn; execution never started" },
  );
  assert.equal(classifyRecovery(baseJob("b", { execution_state: "running", pid: 4242, claim }), { alive: false, startTime: null }).classification, "interrupted");
  assert.equal(classifyRecovery(baseJob("c", { execution_state: "running", pid: 4242, claim }), { alive: true, startTime: childStart }).classification, "running");
  assert.equal(classifyRecovery(baseJob("d", { execution_state: "running", pid: 4242, claim }), { alive: true, startTime: "2026-09-29T13:00:00.000Z" }).classification, "interrupted");
  assert.equal(classifyRecovery(baseJob("e", { execution_state: "running", pid: 4242, claim }), { alive: true, startTime: null }).classification, "unknown");
});

async function runResolveRecovery(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

// resolve-recovery 人工解除路径（A6：确认标记 + 证据摘要 + 审计记录）。
test("resolve-recovery refuses without confirm/evidence, refuses live owners, and resolves with audit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-resolve-"));
  const dataDirectory = path.join(directory, "data");
  const env = { DISPATCHER_DATA_DIR: dataDirectory };
  try {
    const store = new JobStore(dataDirectory);
    await store.create(baseJob("job-rr", {
      execution_state: "unknown",
      status: "RECOVERY_REQUIRED",
      claim: { ...CLAIM_BASE, child_pid: 4242 },
    }));

    // 缺 --confirm / --evidence：拒绝。
    const missingConfirm = await runResolveRecovery(["--job", "job-rr", "--evidence", "checked task manager"], env);
    assert.notEqual(missingConfirm.code, 0);
    assert.match(missingConfirm.stderr, /Refused/);
    const missingEvidence = await runResolveRecovery(["--job", "job-rr", "--confirm"], env);
    assert.notEqual(missingEvidence.code, 0);

    // 前置条件：活 owner 持有实例锁（心跳新鲜）→ 拒绝并提示先停 owner。
    await mkdir(path.join(dataDirectory, "run"), { recursive: true });
    await writeFile(
      path.join(dataDirectory, "run", "instance.lock"),
      `${JSON.stringify({ owner_id: "live-owner", pid: process.pid, created_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() })}\n`,
      "utf8",
    );
    const refusedByLiveOwner = await runResolveRecovery(["--job", "job-rr", "--confirm", "--evidence", "checked task manager"], env);
    assert.notEqual(refusedByLiveOwner.code, 0);
    assert.match(refusedByLiveOwner.stderr, /live owner/);
    // 拒绝路径不得改写 job。
    assert.equal((await store.get("job-rr")).status, "RECOVERY_REQUIRED");
    assert.equal((await store.get("job-rr")).claim.released_at, null);

    // 移除活锁后：stale/无锁场景可解除（此处无锁=旧 owner 已停止的受控模拟）。
    await rm(path.join(dataDirectory, "run", "instance.lock"), { force: true });
    const resolved = await runResolveRecovery(["--job", "job-rr", "--confirm", "--evidence", "task manager shows no CLI process"], env);
    assert.equal(resolved.code, 0, resolved.stderr);
    const receipt = JSON.parse(resolved.stdout);
    assert.equal(receipt.job_id, "job-rr");
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.error_kind, "interrupted_confirmed");
    assert.ok(receipt.claim_released_at);

    const job = await store.get("job-rr");
    assert.equal(job.status, "FAILED");
    assert.equal(job.error.kind, "interrupted_confirmed");
    assert.equal(job.execution_state, "stopped");
    assert.ok(job.claim.released_at);
    assert.equal(job.claim.released_by, receipt.operator);
    assert.ok(job.revision >= 2);

    // 审计记录实测：{job_id, operator, resolved_at, evidence, action}。
    const audit = (await readFile(path.join(dataDirectory, "run", "recovery-audit.jsonl"), "utf8")).trim().split("\n");
    assert.equal(audit.length, 1);
    const entry = JSON.parse(audit[0]);
    assert.equal(entry.job_id, "job-rr");
    assert.equal(entry.evidence, "task manager shows no CLI process");
    assert.equal(entry.action, "failed_interrupted_confirmed");
    assert.equal(entry.operator, receipt.operator);

    // 幂等防护：已解除的 job（FAILED 非 RECOVERY_REQUIRED）再次解除被拒绝。
    const alreadyResolved = await runResolveRecovery(["--job", "job-rr", "--confirm", "--evidence", "again"], env);
    assert.notEqual(alreadyResolved.code, 0);
    assert.match(alreadyResolved.stderr, /not RECOVERY_REQUIRED/);

    // 未知 job 拒绝。
    const unknownJob = await runResolveRecovery(["--job", "no-such-job", "--confirm", "--evidence", "x"], env);
    assert.notEqual(unknownJob.code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// 崩溃注入后的完整人工链路：RECOVERY_REQUIRED（unknown）→ resolve-recovery 解除。
test("resolve-recovery completes the crash-injection manual path with stale lock takeover", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-resolve-stale-"));
  const dataDirectory = path.join(directory, "data");
  const env = { DISPATCHER_DATA_DIR: dataDirectory };
  try {
    const store = new JobStore(dataDirectory);
    await store.create(baseJob("job-crash", {
      execution_state: "unknown",
      status: "RECOVERY_REQUIRED",
      claim: { ...CLAIM_BASE, child_pid: 999_999 },
    }));
    // 旧 owner 留下的 stale 锁：心跳过期且 PID 不存在 → 命令接管锁后解除。
    await mkdir(path.join(dataDirectory, "run"), { recursive: true });
    await writeFile(
      path.join(dataDirectory, "run", "instance.lock"),
      `${JSON.stringify({ owner_id: "dead-owner", pid: 999_999, created_at: new Date(Date.now() - 120_000).toISOString(), heartbeat_at: new Date(Date.now() - 120_000).toISOString() })}\n`,
      "utf8",
    );
    const resolved = await runResolveRecovery(["--job", "job-crash", "--confirm", "--evidence", "process list verified empty"], env);
    assert.equal(resolved.code, 0, resolved.stderr);
    const receipt = JSON.parse(resolved.stdout);
    assert.equal(receipt.stale_lock_takeover, true);
    const job = await store.get("job-crash");
    assert.equal(job.status, "FAILED");
    assert.equal(job.error.kind, "interrupted_confirmed");
    // 锁被释放：后续 owner 可正常 acquire。
    const { InstanceLock } = await import("../src/instance-lock.js");
    const lock = new InstanceLock({ directory: path.join(dataDirectory, "run") });
    assert.equal((await lock.acquire()).acquired, true);
    await lock.release();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
