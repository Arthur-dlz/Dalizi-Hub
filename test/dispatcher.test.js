import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Dispatcher, isOwnerHeartbeatStale, BOARD_TERMINAL_WINDOW, BOARD_MAX_BYTES } from "../src/dispatcher.js";
import { JobStore } from "../src/job-store.js";
import { IdempotencyIndex } from "../src/idempotency-index.js";
import { InstanceLock } from "../src/instance-lock.js";

const deadProbe = async () => ({ alive: false, startTime: null });

function slowFakeRunner({ calls = [], delayMs = 60, executable = "C:/tools/fake-cli.exe", result } = {}) {
  return {
    executable,
    async run(input) {
      calls.push(input);
      if (input.onStarted) await input.onStarted(4242);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return result ?? {
        pid: 4242,
        status: "COMPLETED",
        finalText: "PROJECT_MARKER=violet",
        error: null,
        actualModel: "NOT_OBSERVABLE",
        diagnostics: { process_exit_code: 0, stderr_present: false },
      };
    },
  };
}

async function makeDispatcher({
  directory,
  runner,
  index = true,
  lock = false,
  probe = deadProbe,
  ownerHeartbeatIntervalMs = 5_000,
}) {
  const store = new JobStore(path.join(directory, "jobs"));
  return new Dispatcher({
    registry: { resolve(project) { if (project !== "canary-project") throw new Error("unexpected project"); return directory; } },
    allowedModels: new Set(["custom-local:step-5-preview"]),
    store,
    runner,
    idempotencyIndex: index ? new IdempotencyIndex({ directory }) : null,
    instanceLock: lock ? new InstanceLock({ directory: path.join(directory, "run") }) : null,
    processProbe: probe,
    ownerHeartbeatIntervalMs,
  });
}

async function waitFor(read) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const job = await read();
    if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "RECOVERY_REQUIRED") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not settle");
}

test("dispatch persists a completed WorkBuddy result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-dispatcher-"));
  try {
    const calls = [];
    const dispatcher = new Dispatcher({
      registry: { resolve(project) { if (project !== "canary-project") throw new Error("unexpected project"); return directory; } },
      allowedModels: new Set(["custom-local:step-5-preview"]),
      store: new JobStore(path.join(directory, "jobs")),
      runner: { async run(input) { calls.push(input); return { pid: 4321, status: "COMPLETED", finalText: "PROJECT_MARKER=violet", error: null, actualModel: "NOT_OBSERVABLE", diagnostics: { process_exit_code: 0, stderr_present: false } }; } },
    });

    const receipt = await dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-5-preview", effort: "high" });
    assert.match(receipt.job_id, /^[0-9a-f-]{36}$/);
    const completed = await waitFor(() => dispatcher.get(receipt.job_id));
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.final_text, "PROJECT_MARKER=violet");
    assert.equal(completed.requested_model, "custom-local:step-5-preview");
    assert.deepEqual(completed.diagnostics, { process_exit_code: 0, stderr_present: false });
    assert.equal(calls[0].cwd, directory);
    // T2：claim 在 spawn 前持久化，终态释放占用并写完成证据。
    assert.equal(completed.execution_state, "stopped");
    assert.equal(completed.claim.owner_pid, process.pid);
    assert.equal(completed.claim.trusted_executable, null); // 该 fake runner 未暴露 executable
    assert.ok(completed.claim.claimed_at);
    assert.ok(completed.claim.released_at);
    assert.equal(completed.completion_evidence.protocol_terminal, true);
    assert.equal(completed.completion_evidence.exit_code, 0);
    assert.equal(completed.completion_evidence.result_persisted, true);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("A5: concurrent requests with the same request_id spawn exactly once and return the same job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-idem-concurrent-"));
  try {
    const calls = [];
    const runner = slowFakeRunner({ calls, delayMs: 120 });
    const dispatcher = await makeDispatcher({ directory, runner });

    const input = { agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-5-preview", request_id: "req-concurrent-0001" };
    const [first, second, third] = await Promise.all([
      dispatcher.dispatch(input),
      dispatcher.dispatch({ ...input }),
      dispatcher.dispatch({ ...input }),
    ]);
    // 同 id 并发 → 同 job_id（模拟响应丢失后用同 id 找回原 job）。
    // spawn 计数在 settle 后断言：setImmediate 执行晚于 Promise.all 微任务。
    assert.equal(first.job_id, second.job_id);
    assert.equal(first.job_id, third.job_id);
    assert.equal(first.request_id, "req-concurrent-0001");
    const job = await waitFor(() => dispatcher.get(first.job_id));
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.request_id, "req-concurrent-0001");
    assert.equal(calls.length, 1); // 同 id 并发仅 1 次 spawn；终态后仍只有一次执行
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("A5: the same request_id with a different request is rejected as idempotency_conflict even while busy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-idem-conflict-"));
  try {
    const calls = [];
    const runner = slowFakeRunner({ calls, delayMs: 120 });
    const dispatcher = await makeDispatcher({ directory, runner });

    const first = await dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-5-preview", request_id: "req-conflict-0001" });
    // job 运行中（busy），同 id 不同摘要必须报冲突而不是 busy（查表先于 busy）。
    await assert.rejects(
      () => dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "different task", model: "custom-local:step-5-preview", request_id: "req-conflict-0001" }),
      { code: "idempotency_conflict" },
    );
    // 不同 id 在占用中被拒为 busy。
    await assert.rejects(
      () => dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-5-preview", request_id: "req-other-id-0002" }),
      { code: "dispatcher_busy" },
    );
    await waitFor(() => dispatcher.get(first.job_id));
    assert.equal(calls.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("A5: a second live owner sharing the state directory is refused by the instance lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-idem-owners-"));
  try {
    const calls = [];
    const runner = slowFakeRunner({ calls, delayMs: 100 });
    const first = await makeDispatcher({ directory, runner, lock: true });
    const receipt = await first.dispatch({ agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-5-preview", request_id: "req-owners-0001" });

    // 第二 owner：同状态目录同锁，initialize 阶段 acquire 失败 → dispatch 拒绝。
    const callsSecond = [];
    const second = await makeDispatcher({ directory, runner: slowFakeRunner({ calls: callsSecond }), lock: true });
    await assert.rejects(
      () => second.dispatch({ agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-5-preview", request_id: "req-owners-0002" }),
      { code: "instance_lock_held" },
    );
    await waitFor(() => first.get(receipt.job_id));
    assert.equal(calls.length, 1);
    assert.equal(callsSecond.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the owner heartbeat is persisted through the reducer seam and expiry never kills or reruns", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-idem-heartbeat-"));
  try {
    const calls = [];
    const runner = slowFakeRunner({ calls, delayMs: 120 });
    const dispatcher = await makeDispatcher({ directory, runner, ownerHeartbeatIntervalMs: 20 });

    const receipt = await dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-5-preview" });
    const job = await waitFor(() => dispatcher.get(receipt.job_id));
    assert.equal(job.status, "COMPLETED");
    assert.ok(job.liveness.owner_heartbeat_at, "owner heartbeat must be persisted during execution");
    assert.ok(Date.parse(job.liveness.owner_heartbeat_at) >= Date.parse(job.started_at));
    assert.equal(calls.length, 1); // 心跳过期不触发重跑/kill：执行恰好一次
    // 15s 过期标记是纯展示判定：不影响已终态结果。
    assert.equal(isOwnerHeartbeatStale(job.liveness, { atMs: Date.parse(job.liveness.owner_heartbeat_at) + 16_000 }), true);
    assert.equal(isOwnerHeartbeatStale(job.liveness, { atMs: Date.parse(job.liveness.owner_heartbeat_at) + 1_000 }), false);
    assert.equal(isOwnerHeartbeatStale(null), null); // 从未观测 → 不可观测
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("completion evidence with a non-zero exit code must not report success", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-idem-conflict-evidence-"));
  try {
    const runner = slowFakeRunner({
      result: { pid: 4242, status: "COMPLETED", finalText: "looks done", error: null, actualModel: "NOT_OBSERVABLE", diagnostics: { process_exit_code: 1, stderr_present: false } },
    });
    const dispatcher = await makeDispatcher({ directory, runner });
    const receipt = await dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-5-preview" });
    const job = await waitFor(() => dispatcher.get(receipt.job_id));
    assert.equal(job.status, "FAILED");
    assert.equal(job.completion_evidence.protocol_terminal, true);
    assert.equal(job.completion_evidence.exit_code, 1);
    assert.match(job.completion_evidence.notes, /exit code 1 conflicts/);
    assert.equal(job.error.kind, "completion_evidence_conflict");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A5 崩溃注入：claim/spawn 后进程死亡 → 新实例恢复扫描不自动重跑；同 request_id 重试
// 找回原 job（RECOVERY_REQUIRED），绝不产生第二次执行。
test("A5: crash injection after claim does not auto-rerun and the same request_id recovers the original job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-idem-crash-"));
  const moduleUrls = {
    dispatcher: new URL("../src/dispatcher.js", import.meta.url).href,
    store: new URL("../src/job-store.js", import.meta.url).href,
    index: new URL("../src/idempotency-index.js", import.meta.url).href,
  };
  // 子进程：真实 Dispatcher，fake runner 被调用后写 spawn 标记并永久挂起（模拟
  // claim → spawn 后、结果回写前崩溃前的长执行）。
  const childSource = `
    const { Dispatcher } = await import(process.env.DALIZI_TEST_DISPATCHER);
    const { JobStore } = await import(process.env.DALIZI_TEST_STORE);
    const { IdempotencyIndex } = await import(process.env.DALIZI_TEST_INDEX);
    const { appendFile, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const directory = process.env.DALIZI_TEST_DIR;
    const runner = {
      executable: "C:/tools/fake-cli.exe",
      async run(input) {
        await appendFile(path.join(directory, "spawn-count"), "1\\n");
        await input.onStarted(4242);
        // 真实长执行会让 owner 的事件循环挂着 ref'd 句柄（子进程 stdout 管道）；本 fake 没有
        // 子进程，补一个 ref'd 定时器等价保持 owner 存活直至父进程注入崩溃（kill）——否则
        // 挂起 promise 不持有事件循环，owner 会提前自然退出，kill/exit 监听竞态使测试偶发取消。
        setInterval(() => {}, 60_000);
        await new Promise(() => {});
      },
    };
    const dispatcher = new Dispatcher({
      registry: { resolve: () => directory },
      allowedModels: new Set(["custom-local:step-5-preview"]),
      store: new JobStore(path.join(directory, "jobs")),
      runner,
      idempotencyIndex: new IdempotencyIndex({ directory }),
      processProbe: async () => ({ alive: false, startTime: null }),
    });
    const receipt = await dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "crash test", model: "custom-local:step-5-preview", request_id: "req-crash-0001" });
    await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt), "utf8");
  `;
  let child;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
      env: {
        ...process.env,
        DALIZI_TEST_DIR: directory,
        DALIZI_TEST_DISPATCHER: moduleUrls.dispatcher,
        DALIZI_TEST_STORE: moduleUrls.store,
        DALIZI_TEST_INDEX: moduleUrls.index,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => process.stderr.write(`[crash-child] ${chunk}`));

    // 等 receipt + spawn 标记 + 快照进入 running 且 pid 落盘（确定性命中"已停缺结果"分支）。
    const receipt = JSON.parse(await waitForFile(path.join(directory, "receipt.json")));
    await waitForFile(path.join(directory, "spawn-count"));
    await waitUntil(async () => {
      const job = JSON.parse(await readFile(path.join(directory, "jobs", `${receipt.job_id}.json`), "utf8"));
      return job.execution_state === "running" && job.pid === 4242;
    });

    // 注入崩溃：杀掉 owner 进程（不 release 锁/占用）。
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal((await readFile(path.join(directory, "spawn-count"), "utf8")).trim().split("\n").length, 1);

    // 重启：新 Dispatcher 实例，恢复扫描分类（身份探针：进程已停止且结果缺失 →
    // FAILED(interrupted) 自动收尾，释放占用，不自动重跑）。
    const callsAfterRestart = [];
    const restarted = await makeDispatcher({ directory, runner: slowFakeRunner({ calls: callsAfterRestart }), probe: deadProbe });
    const recovered = await restarted.dispatch({ agent: "workbuddy", project: "canary-project", task: "crash test", model: "custom-local:step-5-preview", request_id: "req-crash-0001" });
    // 同 request_id 找回原 job：同 job_id，不再次启动。
    assert.equal(recovered.job_id, receipt.job_id);
    assert.equal(recovered.status, "FAILED");
    const job = await restarted.get(receipt.job_id);
    assert.equal(job.status, "FAILED");
    assert.equal(job.error.kind, "interrupted");
    assert.ok(job.claim.released_at, "confirmed-stopped occupancy is released by the automatic path");
    assert.equal(callsAfterRestart.length, 0, "recovery must never rerun the task");
    assert.equal((await readFile(path.join(directory, "spawn-count"), "utf8")).trim().split("\n").length, 1);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function waitForFile(filename) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return await readFile(filename, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`file did not appear: ${filename}`);
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

// ---------- T6：runner emit 接线（事件流经 per-job FIFO seam 驱动快照） ----------

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 轮询直到快照满足谓词（事件经 FIFO 异步落盘，测试侧确定性等待；read 返回 null 表示 job 尚未可见）。
async function waitSnapshot(read, predicate, label) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const job = await read();
    if (job && predicate(job)) return job;
    await sleepMs(10);
  }
  throw new Error(`snapshot did not reach expected state: ${label}`);
}

// 包装 store.apply 捕获进入 seam 的完整封套（job_id/seq/封套形状断言用）。
function tapAppliedEvents(store, tapped) {
  const original = store.apply.bind(store);
  store.apply = (jobId, event) => {
    tapped.push(event);
    return original(jobId, event);
  };
}

function t6Registry(directory) {
  return { resolve(project) { if (project !== "canary-project") throw new Error("unexpected project"); return directory; } };
}

const T6_MODELS = new Set(["custom-local:step-5-preview"]);

test("T6: runner emit stream drives the snapshot step by step through the reducer seam", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-t6-stream-"));
  try {
    const store = new JobStore(path.join(directory, "jobs"));
    const applied = [];
    tapAppliedEvents(store, applied);
    let jobId = null;
    const readJob = async () => (jobId ? store.get(jobId) : null);
    let eventId = 0;
    const runner = {
      executable: "C:/tools/fake-cli.exe",
      async run(input) {
        assert.equal(typeof input.emit, "function", "dispatcher must always pass emit to runner.run");
        await input.onStarted(4242);
        const emit = (kind, payload) => input.emit({
          schema_version: 1,
          observed_at: new Date().toISOString(),
          source: { agent: "workbuddy", cli_version: "0.0-test", session_id: "s-1", event_id: `e-${(eventId += 1)}` },
          kind,
          payload,
        });
        emit("started", { pid: 4242 });
        const running = await waitSnapshot(readJob, (j) => j.liveness.last_event_at !== null, "started");
        assert.equal(running.status, "RUNNING");
        assert.equal(running.execution_state, "running");
        emit("activity", { kind: "tool_use", label: "Read", state: "running" });
        const acting = await waitSnapshot(readJob, (j) => j.activity && j.activity.label === "Read", "activity");
        assert.equal(acting.current_activity, "Read");
        assert.equal(acting.activity.source, "workbuddy");
        emit("usage", { input_tokens: { value: 10, unit: "tokens", scope: "turn", kind: "snapshot", source_field: "usage.input_tokens", quality: "reported" } });
        await waitSnapshot(readJob, (j) => j.usage && j.usage.input_tokens && j.usage.input_tokens.value === 10, "usage");
        emit("result", { final_text: "done-text", actual_model: "m-1" });
        await waitSnapshot(readJob, (j) => j.status === "COMPLETED" && j.final_text === "done-text", "result");
        return { pid: 4242, status: "COMPLETED", finalText: "done-text", error: null, actualModel: "m-1", diagnostics: { process_exit_code: 0, stderr_present: false } };
      },
    };
    const dispatcher = new Dispatcher({
      registry: t6Registry(directory),
      allowedModels: T6_MODELS,
      store,
      runner,
      processProbe: deadProbe,
      ownerHeartbeatIntervalMs: 60_000, // 排除心跳干扰：seq 断言只看 runner 事件
    });
    const receipt = await dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "emit stream", model: "custom-local:step-5-preview" });
    jobId = receipt.job_id;
    // 等 dispatcher 权威终态落盘（result 事件先到、completion_evidence 由终态更新后补），避免读到中间态。
    const job = await waitSnapshot(() => dispatcher.get(jobId), (j) => j.status === "COMPLETED" && j.completion_evidence, "terminal update");
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.final_text, "done-text");
    assert.equal(job.actual_model, "m-1");
    assert.equal(job.completion_evidence.protocol_terminal, true); // run 返回后的 completion_evidence 流程保持原语义
    // 封套补全：job_id/schema_version 由 dispatcher 注入；seq per-job 从 1 单调无空洞。
    assert.equal(applied.length, 4);
    for (const event of applied) {
      assert.equal(event.job_id, jobId);
      assert.equal(event.schema_version, 1);
    }
    assert.deepEqual(applied.map((event) => event.kind), ["started", "activity", "usage", "result"]);
    assert.deepEqual(applied.map((event) => event.seq), [1, 2, 3, 4]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("T6: concurrent jobs on a shared store keep isolated per-job seq and event streams", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-t6-isolation-"));
  try {
    const store = new JobStore(path.join(directory, "jobs"));
    const applied = [];
    tapAppliedEvents(store, applied);
    const makeRunner = (marker, holdMs) => ({
      executable: "C:/tools/fake-cli.exe",
      async run(input) {
        await input.onStarted(4242);
        input.emit({ kind: "started", payload: { pid: 4242 } });
        await sleepMs(holdMs); // 交错窗口：两 job 的事件流真实并发进入同一 store 的 seam
        input.emit({ kind: "activity", payload: { kind: "tool_use", label: marker, state: "running" } });
        input.emit({ kind: "result", payload: { final_text: `final-${marker}` } });
        return { pid: 4242, status: "COMPLETED", finalText: `final-${marker}`, error: null, actualModel: "m-1", diagnostics: { process_exit_code: 0 } };
      },
    });
    const makeIsolatedDispatcher = (runner) => new Dispatcher({
      registry: t6Registry(directory),
      allowedModels: T6_MODELS,
      store,
      runner,
      processProbe: deadProbe,
      ownerHeartbeatIntervalMs: 60_000,
      recoveryEnabled: false, // seam 隔离单测：两实例共享 store，关闭恢复扫描避免互相分类对方在途 job
    });
    const first = makeIsolatedDispatcher(makeRunner("alpha", 30));
    const second = makeIsolatedDispatcher(makeRunner("bravo", 60));
    const [receipt1, receipt2] = await Promise.all([
      first.dispatch({ agent: "workbuddy", project: "canary-project", task: "job alpha", model: "custom-local:step-5-preview" }),
      second.dispatch({ agent: "workbuddy", project: "canary-project", task: "job bravo", model: "custom-local:step-5-preview" }),
    ]);
    assert.notEqual(receipt1.job_id, receipt2.job_id);
    const [job1, job2] = await Promise.all([
      waitFor(() => first.get(receipt1.job_id)),
      waitFor(() => second.get(receipt2.job_id)),
    ]);
    assert.equal(job1.status, "COMPLETED");
    assert.equal(job2.status, "COMPLETED");
    for (const [jobId, marker] of [[receipt1.job_id, "alpha"], [receipt2.job_id, "bravo"]]) {
      const events = applied.filter((event) => event.job_id === jobId);
      assert.deepEqual(events.map((event) => event.kind), ["started", "activity", "result"]);
      assert.deepEqual(events.map((event) => event.seq), [1, 2, 3], "per-job seq 各自从 1 单调递增");
      for (const event of events.filter((entry) => entry.kind === "activity")) {
        assert.equal(event.payload.label, marker, "事件流不串 job");
      }
      const snapshot = await store.get(jobId);
      assert.equal(snapshot.final_text, `final-${marker}`);
      assert.equal(snapshot.current_activity, marker);
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("T6: the first terminal event sticks and a late result cannot rewrite a FAILED job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-t6-sticky-"));
  try {
    const store = new JobStore(path.join(directory, "jobs"));
    let jobId = null;
    const readJob = async () => (jobId ? store.get(jobId) : null);
    const runner = {
      executable: "C:/tools/fake-cli.exe",
      async run(input) {
        await input.onStarted(4242);
        input.emit({ kind: "error", payload: { kind: "runner_error", message: "boom-first" } });
        const failed = await waitSnapshot(readJob, (j) => j.status === "FAILED", "error event terminal");
        assert.equal(failed.error.kind, "runner_error");
        assert.equal(failed.error.message, "boom-first");
        // 迟到终态事件：reducer 终态粘滞（首个终态胜出），不得改写已落盘终态。
        input.emit({ kind: "result", payload: { final_text: "late-win", actual_model: "m-late" } });
        await sleepMs(80); // 给迟到事件充分落盘窗口
        const after = await store.get(jobId);
        assert.equal(after.status, "FAILED", "终态粘滞：迟到 result 不得改写 FAILED");
        assert.equal(after.final_text, null);
        assert.equal(after.error.message, "boom-first");
        return { pid: 4242, status: "FAILED", finalText: null, error: "boom-first", actualModel: "m-1", diagnostics: { process_exit_code: 1, stderr_present: true } };
      },
    };
    const dispatcher = new Dispatcher({ registry: t6Registry(directory), allowedModels: T6_MODELS, store, runner, processProbe: deadProbe });
    const receipt = await dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "sticky terminal", model: "custom-local:step-5-preview" });
    jobId = receipt.job_id;
    // 等 dispatcher 权威终态落盘（completion_evidence 由终态更新写入）。
    const job = await waitSnapshot(() => dispatcher.get(jobId), (j) => j.status === "FAILED" && j.completion_evidence, "terminal update");
    assert.equal(job.status, "FAILED");
    assert.equal(job.error.kind, "runner_error");
    assert.equal(job.error.message, "boom-first");
    assert.equal(job.final_text, null);
    assert.equal(job.completion_evidence.exit_code, 1);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("T6: malformed emits and apply failures are counted aside and never change the job outcome", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-t6-emiterr-"));
  try {
    const store = new JobStore(path.join(directory, "jobs"));
    const applied = [];
    const originalApply = store.apply.bind(store);
    store.apply = (jobId, event) => {
      applied.push(event);
      if (event.kind === "usage") throw new Error("forced apply failure"); // 包装/入队异常注入（同步抛出路径）
      return originalApply(jobId, event);
    };
    const runner = {
      executable: "C:/tools/fake-cli.exe",
      async run(input) {
        await input.onStarted(4242);
        // 畸形部分封套：emit 入口对 runner 永不抛错，只旁路计数。
        input.emit(null);
        input.emit("not-an-envelope");
        input.emit({});
        input.emit({ kind: 42, payload: {} });
        input.emit({ kind: "started", payload: { pid: 4242 } });
        input.emit({ kind: "usage", payload: { input_tokens: { value: 1, unit: "tokens", scope: "turn", kind: "snapshot", source_field: "usage.input_tokens", quality: "reported" } } }); // apply 强制失败
        input.emit({ kind: "result", payload: { final_text: "ok-final" } });
        return { pid: 4242, status: "COMPLETED", finalText: "ok-final", error: null, actualModel: "m-1", diagnostics: { process_exit_code: 0, stderr_present: false } };
      },
    };
    const dispatcher = new Dispatcher({
      registry: t6Registry(directory),
      allowedModels: T6_MODELS,
      store,
      runner,
      processProbe: deadProbe,
      ownerHeartbeatIntervalMs: 60_000,
    });
    const receipt = await dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "emit errors", model: "custom-local:step-5-preview" });
    // 等 dispatcher 权威终态落盘（diagnostics/completion_evidence 由终态更新写入），避免读到事件先到产生的中间态。
    const job = await waitSnapshot(() => dispatcher.get(receipt.job_id), (j) => j.status === "COMPLETED" && j.completion_evidence, "terminal update");
    assert.equal(job.status, "COMPLETED", "emit 异常不拖垮 job、不改变终局判定");
    assert.equal(job.final_text, "ok-final");
    assert.equal(job.usage, null, "apply 失败的 usage 不落盘");
    assert.deepEqual(job.diagnostics, { process_exit_code: 0, stderr_present: false }, "emit 旁路计数不进 diagnostics");
    // 畸形封套从未进入 seam；强制失败的 usage 到过 seam 入口（消耗 seq）但未生效。
    assert.deepEqual(applied.map((event) => event.kind), ["started", "usage", "result"]);
    assert.deepEqual(applied.map((event) => event.seq), [1, 2, 3]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ---------- P5：dispatcher.listBoard 只读投影（蓝图 §12.2 / IMPLEMENTATION §9.1） ----------

// store 探针：只提供 listBoard 需要的两个只读 list；其余方法一旦被调用即记名并抛错，
// 以此断言 listBoard 零写、零单点读。
function createStoreProbe({ all = [], nonTerminal = [] } = {}) {
  const writes = [];
  return {
    writes,
    async listAll() { return all; },
    async listNonTerminal() { return nonTerminal; },
    async get(jobId) { writes.push(["get", jobId]); throw new Error("listBoard must not read a single job"); },
    async create(job) { writes.push(["create", job.job_id]); throw new Error("listBoard must not create"); },
    async update(jobId) { writes.push(["update", jobId]); throw new Error("listBoard must not update"); },
    async apply(jobId) { writes.push(["apply", jobId]); throw new Error("listBoard must not apply"); },
  };
}

function makeReadOnlyDispatcher(store) {
  return new Dispatcher({
    registry: { resolve() { throw new Error("listBoard must not resolve projects"); } },
    allowedModels: new Set(["custom-local:step-5-preview"]),
    store,
    runner: { async run() { throw new Error("listBoard must not run"); } },
  });
}

function boardRecord({ job_id, status, updated_at, finished_at = null, final_text = null }) {
  return {
    schema_version: 2,
    revision: 1,
    job_id,
    status,
    agent: "workbuddy",
    project: "canary-project",
    created_at: "2026-10-04T00:00:00.000Z",
    updated_at,
    finished_at,
    final_text,
    usage: null,
    execution_state: status === "QUEUED" ? "idle" : "stopped",
    liveness: { owner_heartbeat_at: null, process_checked_at: null, process_state: null, last_event_at: null, last_output_at: null },
  };
}

test("P5: dispatcher.listBoard is a read-only projection with the {jobs, truncated, total} contract", async () => {
  const records = [
    boardRecord({ job_id: "queued-a", status: "QUEUED", updated_at: "2026-10-04T08:00:00.000Z" }),
    boardRecord({ job_id: "queued-b", status: "QUEUED", updated_at: "2026-10-04T09:00:00.000Z" }),
    boardRecord({ job_id: "running-c", status: "RUNNING", updated_at: "2026-10-04T10:00:00.000Z" }),
    boardRecord({ job_id: "done-y", status: "COMPLETED", updated_at: "2026-10-04T11:00:00.000Z", finished_at: "2026-10-04T11:00:00.000Z" }),
    boardRecord({ job_id: "done-x", status: "FAILED", updated_at: "2026-10-04T12:00:00.000Z", finished_at: "2026-10-04T12:00:00.000Z" }),
  ];
  const store = createStoreProbe({ all: records, nonTerminal: records.slice(0, 3) });
  const dispatcher = makeReadOnlyDispatcher(store);

  const board = await dispatcher.listBoard();

  // 契约：非终态在前（updated_at 降序），终态按 finished_at 降序；不写 store、不单点读。
  assert.deepEqual(board.jobs.map((job) => job.job_id), ["running-c", "queued-b", "queued-a", "done-x", "done-y"]);
  assert.equal(board.truncated, false);
  assert.equal(board.total, 5);
  assert.equal(store.writes.length, 0, "listBoard must not write or read individual jobs through the store");
  for (const job of board.jobs) {
    assert.equal(typeof job.job_id, "string");
    assert.equal(typeof job.status, "string");
    assert.equal(typeof job.revision, "number");
    assert.equal(job.schema_version, 2);
  }
});

test("P5: listBoard bounds the terminal window to the newest 50 and flags truncation", async () => {
  const nonTerminal = [
    boardRecord({ job_id: "queued-a", status: "QUEUED", updated_at: "2026-10-04T08:00:00.000Z" }),
    boardRecord({ job_id: "running-c", status: "RUNNING", updated_at: "2026-10-04T10:00:00.000Z" }),
  ];
  const terminal = Array.from({ length: 60 }, (_, index) => boardRecord({
    job_id: `done-${String(index).padStart(2, "0")}`,
    status: "COMPLETED",
    updated_at: `2026-10-04T10:${String(index).padStart(2, "0")}:00.000Z`,
    finished_at: `2026-10-04T10:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const store = createStoreProbe({ all: [...terminal, ...nonTerminal], nonTerminal });
  const dispatcher = makeReadOnlyDispatcher(store);

  const board = await dispatcher.listBoard();

  assert.equal(BOARD_TERMINAL_WINDOW, 50);
  assert.equal(board.total, 62); // total 是未截断全量条数，不是显示条数
  assert.equal(board.truncated, true);
  assert.equal(board.jobs.length, nonTerminal.length + BOARD_TERMINAL_WINDOW);
  // 非终态在前；终态窗口取 finished_at 最近的 50 条（done-59 最新，done-10 是窗口边缘）。
  assert.deepEqual(board.jobs.slice(0, 2).map((job) => job.job_id), ["running-c", "queued-a"]);
  assert.equal(board.jobs[2].job_id, "done-59");
  assert.equal(board.jobs[board.jobs.length - 1].job_id, "done-10");
  assert.equal(store.writes.length, 0);
});

test("P5: listBoard trims the payload to the 1 MiB byte budget while keeping the total", async () => {
  const bigText = "x".repeat(700 * 1024);
  const twoBig = [
    boardRecord({ job_id: "big-a", status: "QUEUED", updated_at: "2026-10-04T08:00:00.000Z", final_text: bigText }),
    boardRecord({ job_id: "big-b", status: "COMPLETED", updated_at: "2026-10-04T09:00:00.000Z", finished_at: "2026-10-04T09:00:00.000Z", final_text: bigText }),
  ];
  const store = createStoreProbe({ all: twoBig, nonTerminal: twoBig.slice(0, 1) });
  const board = await makeReadOnlyDispatcher(store).listBoard();
  assert.equal(BOARD_MAX_BYTES, 1024 * 1024);
  assert.equal(board.total, 2);
  assert.equal(board.truncated, true);
  assert.equal(board.jobs.length, 1); // 同序从头保留，超限从尾部截断
  assert.equal(board.jobs[0].job_id, "big-a");
  assert.ok(Buffer.byteLength(JSON.stringify(board), "utf8") <= BOARD_MAX_BYTES);

  // 单条即超限：jobs 为空但 total 与截断标记保留（不静默丢弃信号）。
  const hugeText = "y".repeat(2 * 1024 * 1024);
  const oneHuge = [boardRecord({ job_id: "huge", status: "QUEUED", updated_at: "2026-10-04T08:00:00.000Z", final_text: hugeText })];
  const hugeStore = createStoreProbe({ all: oneHuge, nonTerminal: oneHuge });
  const hugeBoard = await makeReadOnlyDispatcher(hugeStore).listBoard();
  assert.equal(hugeBoard.total, 1);
  assert.equal(hugeBoard.truncated, true);
  assert.deepEqual(hugeBoard.jobs, []);
  assert.equal(hugeStore.writes.length, 0);
});
