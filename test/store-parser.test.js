import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobStore } from "../src/job-store.js";
import { DispatcherError } from "../src/contracts.js";
import { interpretRun } from "../src/stream-json.js";

const EMPTY_LIVENESS = {
  owner_heartbeat_at: null,
  process_checked_at: null,
  process_state: null,
  last_event_at: null,
  last_output_at: null,
};

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DispatcherError, `expected DispatcherError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

function startedEvent(jobId, seq) {
  return {
    schema_version: 1,
    job_id: jobId,
    seq,
    observed_at: "2026-09-29T10:00:00.000Z",
    source: { agent: "workbuddy", cli_version: "1.0.0", session_id: "session-1", event_id: "event-1" },
    kind: "started",
    payload: {},
  };
}

function activityEvent(jobId, label, seq) {
  return {
    schema_version: 1,
    job_id: jobId,
    seq,
    observed_at: "2026-09-29T10:00:01.000Z",
    source: { agent: "workbuddy", cli_version: "1.0.0", session_id: "session-1", event_id: `event-${seq}` },
    kind: "activity",
    payload: { kind: "tool", label, state: "running" },
  };
}

function heartbeatEvent(jobId, seq) {
  return {
    schema_version: 1,
    job_id: jobId,
    seq,
    observed_at: "2026-09-29T10:00:02.000Z",
    source: { agent: "workbuddy", cli_version: "1.0.0", session_id: "session-1", event_id: `event-${seq}` },
    kind: "heartbeat",
    payload: { process_state: "alive" },
  };
}

function usageEvent(jobId, usage, seq) {
  return {
    schema_version: 1,
    job_id: jobId,
    seq,
    observed_at: "2026-09-29T10:00:03.000Z",
    source: { agent: "workbuddy", cli_version: "1.0.0", session_id: "session-1", event_id: `event-${seq}` },
    kind: "usage",
    payload: usage,
  };
}

function resultEvent(jobId, finalText, seq) {
  return {
    schema_version: 1,
    job_id: jobId,
    seq,
    observed_at: "2026-09-29T10:00:04.000Z",
    source: { agent: "workbuddy", cli_version: "1.0.0", session_id: "session-1", event_id: `event-${seq}` },
    kind: "result",
    payload: { final_text: finalText },
  };
}

function errorEvent(jobId, seq) {
  return {
    schema_version: 1,
    job_id: jobId,
    seq,
    observed_at: "2026-09-29T10:00:05.000Z",
    source: { agent: "workbuddy", cli_version: "1.0.0", session_id: "session-1", event_id: `event-${seq}` },
    kind: "error",
    payload: { kind: "runner_error", message: "upstream rejected request", diagnostics: { process_exit_code: 1 } },
  };
}

test("a job survives a new store instance with a v2 snapshot envelope", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-store-"));
  try {
    const job = { job_id: "job-1", status: "QUEUED", requested_model: "custom-local:step-5-preview", final_text: null };
    const created = await new JobStore(directory).create(job);
    assert.equal(created.schema_version, 2);
    assert.equal(created.revision, 1);
    assert.equal(typeof created.updated_at, "string");
    assert.equal(created.request_id, null);
    assert.equal(created.request_digest, null);
    assert.equal(created.activity, null);
    assert.deepEqual(created.liveness, EMPTY_LIVENESS);
    assert.equal(created.usage, null);
    assert.equal(created.execution_state, "idle");
    assert.equal(created.completion_evidence, null);
    assert.equal(created.status, "QUEUED");
    assert.equal(created.requested_model, "custom-local:step-5-preview");
    assert.equal(created.final_text, null);

    const recovered = await new JobStore(directory).get("job-1");
    assert.deepEqual(recovered, created);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a v1 snapshot without schema_version reads back with nulled v2 fields and no fabricated heartbeat", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-store-v1-"));
  try {
    const legacy = {
      job_id: "legacy-1",
      status: "RUNNING",
      requested_model: "custom-local:step-5-preview",
      actual_model: "NOT_OBSERVABLE",
      effort: "high",
      created_at: "2026-09-01T00:00:00.000Z",
      started_at: "2026-09-01T00:00:01.000Z",
      finished_at: null,
      pid: null,
      final_text: null,
      error: null,
    };
    await writeFile(path.join(directory, "legacy-1.json"), `${JSON.stringify(legacy, null, 2)}\n`);

    const recovered = await new JobStore(directory).get("legacy-1");
    assert.equal(recovered.schema_version, 2);
    assert.equal(recovered.revision, null);
    assert.equal(recovered.updated_at, null);
    assert.equal(recovered.request_id, null);
    assert.equal(recovered.request_digest, null);
    assert.equal(recovered.activity, null);
    assert.deepEqual(recovered.liveness, EMPTY_LIVENESS);
    assert.equal(recovered.usage, null);
    assert.equal(recovered.execution_state, null);
    assert.equal(recovered.completion_evidence, null);
    for (const [key, value] of Object.entries(legacy)) {
      assert.deepEqual(recovered[key], value, `legacy field ${key} must survive`);
    }

    const onDisk = JSON.parse(await readFile(path.join(directory, "legacy-1.json"), "utf8"));
    assert.equal(onDisk.schema_version, undefined, "v1 compatibility read must not rewrite the legacy file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply advances the snapshot reducer by kind and keeps revision monotonic", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-apply-"));
  try {
    const store = new JobStore(directory);
    const created = await store.create({ job_id: "job-1", status: "QUEUED", created_at: "2026-09-29T09:59:00.000Z" });

    const started = await store.apply("job-1", startedEvent("job-1", 1));
    assert.equal(started.status, "RUNNING");
    assert.equal(started.execution_state, "running");
    assert.equal(started.revision, created.revision + 1);
    assert.equal(started.liveness.last_event_at, "2026-09-29T10:00:00.000Z");

    const activity = await store.apply("job-1", activityEvent("job-1", "reading files", 2));
    assert.deepEqual(activity.activity, {
      kind: "tool",
      label: "reading files",
      state: "running",
      source: "workbuddy",
      observed_at: "2026-09-29T10:00:01.000Z",
    });
    assert.equal(activity.current_activity, "reading files");
    assert.equal(activity.revision, started.revision + 1);

    const heartbeat = await store.apply("job-1", heartbeatEvent("job-1", 3));
    assert.equal(heartbeat.liveness.owner_heartbeat_at, "2026-09-29T10:00:02.000Z");
    assert.equal(heartbeat.liveness.process_checked_at, "2026-09-29T10:00:02.000Z");
    assert.equal(heartbeat.liveness.process_state, "alive");

    const usage = { input_tokens: { value: 10, unit: "tokens", scope: "turn", kind: "snapshot", source_field: "usage.input", quality: "reported" } };
    const used = await store.apply("job-1", usageEvent("job-1", usage, 4));
    assert.deepEqual(used.usage, usage);

    const done = await store.apply("job-1", resultEvent("job-1", "PROJECT_MARKER=violet", 5));
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.execution_state, "stopped");
    assert.equal(done.final_text, "PROJECT_MARKER=violet");
    assert.equal(done.revision, used.revision + 1);
    assert.equal(typeof done.updated_at, "string");

    assert.deepEqual(await new JobStore(directory).get("job-1"), done);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an error event persists the extended error structure and terminal status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-error-"));
  try {
    const store = new JobStore(directory);
    await store.create({ job_id: "job-1", status: "QUEUED", created_at: "2026-09-29T09:59:00.000Z" });

    const failed = await store.apply("job-1", errorEvent("job-1", 1));
    assert.equal(failed.status, "FAILED");
    assert.deepEqual(failed.error, {
      kind: "runner_error",
      message: "upstream rejected request",
      diagnostics: { process_exit_code: 1 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a terminal snapshot ignores later status changes but still records liveness", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-terminal-"));
  try {
    const store = new JobStore(directory);
    await store.create({ job_id: "job-1", status: "QUEUED", final_text: null, created_at: "2026-09-29T09:59:00.000Z" });
    const failed = await store.apply("job-1", errorEvent("job-1", 1));
    assert.equal(failed.status, "FAILED");

    const lateStart = await store.apply("job-1", startedEvent("job-1", 2));
    assert.equal(lateStart.status, "FAILED", "the first terminal status wins");
    assert.equal(lateStart.revision, failed.revision + 1);
    assert.equal(lateStart.liveness.last_event_at, "2026-09-29T10:00:00.000Z");

    const lateResult = await store.apply("job-1", resultEvent("job-1", "late text", 3));
    assert.equal(lateResult.status, "FAILED");
    assert.equal(lateResult.final_text, null, "a late result must not rewrite terminal output");

    const lateActivity = await store.apply("job-1", activityEvent("job-1", "late observation", 4));
    assert.equal(lateActivity.activity.label, "late observation", "liveness and activity observations still land");
    assert.equal(lateActivity.revision, lateResult.revision + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent apply calls from interleaved sources lose no updates and keep revision continuous", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-concurrency-"));
  try {
    const store = new JobStore(directory);
    const created = await store.create({ job_id: "job-1", status: "RUNNING", created_at: "2026-09-29T09:59:00.000Z" });
    const total = 24;
    const sources = ["alpha", "beta", "gamma"];
    const results = await Promise.all(
      Array.from({ length: total }, (_, index) => {
        const event = activityEvent("job-1", `${sources[index % sources.length]}-step-${index}`, index + 1);
        return store.apply("job-1", event);
      }),
    );
    const revisions = results.map((result) => result.revision).sort((left, right) => left - right);
    assert.deepEqual(revisions, Array.from({ length: total }, (_, index) => created.revision + 1 + index));

    const finalSnapshot = await store.get("job-1");
    assert.equal(finalSnapshot.revision, created.revision + total);
    assert.ok(
      results.some((result) => result.activity.label === finalSnapshot.activity.label),
      "the persisted snapshot must equal one committed event, not a torn merge",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("update keeps the legacy patch path serialized and revision-aware", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-update-"));
  try {
    const store = new JobStore(directory);
    const created = await store.create({ job_id: "job-1", status: "QUEUED", created_at: "2026-09-29T09:59:00.000Z" });

    const [first, second] = await Promise.all([
      store.update("job-1", { status: "RUNNING", started_at: "2026-09-29T10:00:00.000Z" }),
      store.update("job-1", { pid: 4321 }),
    ]);
    assert.equal(first.status, "RUNNING");
    assert.equal(second.pid, 4321);
    assert.equal([first.revision, second.revision].sort((left, right) => left - right).join(","), `${created.revision + 1},${created.revision + 2}`);

    const finalSnapshot = await store.get("job-1");
    assert.equal(finalSnapshot.status, "RUNNING");
    assert.equal(finalSnapshot.pid, 4321);
    assert.equal(finalSnapshot.revision, created.revision + 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("create preserves caller-provided idempotency fields for the admission area", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-idem-fields-"));
  try {
    const store = new JobStore(directory);
    const created = await store.create({
      job_id: "job-1",
      status: "QUEUED",
      request_id: "req-0123456789abcdef",
      request_digest: "digest-1",
      created_at: "2026-09-29T09:59:00.000Z",
    });
    assert.equal(created.request_id, "req-0123456789abcdef");
    assert.equal(created.request_digest, "digest-1");
    assert.equal(created.schema_version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listNonTerminal returns only jobs awaiting recovery and ignores tmp leftovers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-list-"));
  try {
    const store = new JobStore(directory);
    await store.create({ job_id: "queued-1", status: "QUEUED", created_at: "2026-09-29T09:00:00.000Z" });
    await store.create({ job_id: "running-1", status: "RUNNING", created_at: "2026-09-29T09:01:00.000Z" });
    await store.create({ job_id: "done-1", status: "COMPLETED", created_at: "2026-09-29T09:02:00.000Z" });
    await store.create({ job_id: "failed-1", status: "FAILED", created_at: "2026-09-29T09:03:00.000Z" });
    await writeFile(path.join(directory, "queued-1.json.5f2c9a10-1111-4222-8333-444455556666.tmp"), "{partial");
    await writeFile(path.join(directory, "not-a-job.txt"), "noise");

    const nonTerminal = await store.listNonTerminal();
    assert.deepEqual(nonTerminal.map((record) => record.job_id), ["queued-1", "running-1"]);
    assert.deepEqual((await store.listAll()).map((record) => record.job_id), ["queued-1", "running-1", "done-1", "failed-1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listAll skips operational JSON files without job_id (registry/roots) — P5 OPS3 live fix", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-ops-"));
  try {
    const store = new JobStore(directory);
    await store.create({ job_id: "queued-1", status: "QUEUED", created_at: "2026-10-04T09:00:00.000Z" });
    // 同目录运营文件：文件名过 JOB_FILE_PATTERN、内容为合法 JSON、无 job_id——
    // 修复前会被 normalizeRead v1 兼容补齐后误当无终态 job 混入 listAll/listNonTerminal/listBoard。
    await writeFile(path.join(directory, "project-registry.json"), JSON.stringify({ projects: [{ alias: "dlz", cwd: "D:\\x", enabled: true }] }));
    await writeFile(path.join(directory, "workspace-roots.json"), JSON.stringify({ roots: ["D:\\x"] }));

    assert.deepEqual((await store.listAll()).map((record) => record.job_id), ["queued-1"]);
    assert.deepEqual((await store.listNonTerminal()).map((record) => record.job_id), ["queued-1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listAll refuses to silently skip a corrupt snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-corrupt-"));
  try {
    const store = new JobStore(directory);
    await store.create({ job_id: "job-1", status: "QUEUED", created_at: "2026-09-29T09:00:00.000Z" });
    await writeFile(path.join(directory, "job-2.json"), "{not-json");
    await rejectsWithCode(store.listAll(), "snapshot_corrupt");
    await rejectsWithCode(store.get("job-2"), "snapshot_corrupt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply rejects unknown jobs, mismatched ids and unsupported kinds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-apply-invalid-"));
  try {
    const store = new JobStore(directory);
    await store.create({ job_id: "job-1", status: "QUEUED", created_at: "2026-09-29T09:59:00.000Z" });

    await rejectsWithCode(store.apply("missing-job", startedEvent("missing-job", 1)), "unknown_job");
    await rejectsWithCode(store.apply("job-1", startedEvent("other-job", 1)), "invalid_event");
    await rejectsWithCode(store.apply("job-1", { ...startedEvent("job-1", 1), kind: "mystery" }), "invalid_event");
    await rejectsWithCode(store.apply("job-1", "not-an-event"), "invalid_event");
    await rejectsWithCode(store.apply("bad id!", startedEvent("bad id!", 1)), "invalid_job_id");
    await rejectsWithCode(store.get("missing-job"), "unknown_job");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("a successful CodeBuddy result wins over a non-zero process exit code", () => {
  const run = interpretRun({
    stdout: '{"type":"result","subtype":"success","result":"PROJECT_MARKER=violet","is_error":false}\n',
    stderr: "",
    exitCode: 1,
  });
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.finalText, "PROJECT_MARKER=violet");
  assert.equal(run.error, null);
  assert.equal(run.actualModel, "NOT_OBSERVABLE");
  assert.deepEqual(run.diagnostics, {
    process_exit_code: 1,
    stderr_present: false,
    event_types: ["result"],
    terminal_result_seen: true,
    terminal_subtype: "success",
    terminal_is_error: false,
    result_field_present: true,
    errors_present: false,
    errors_info_present: false,
    assistant_content_block_types: [],
    error_event_keys: [],
    error_category: null,
    safe_error_summary: null,
  });
});

test("a parsed error wins over a zero process exit code", () => {
  const run = interpretRun({
    stdout: '{"type":"error","error":{"message":"model rejected"}}\n',
    stderr: "ignored",
    exitCode: 0,
  });
  assert.equal(run.status, "FAILED");
  assert.equal(run.error, "parsed_error: model_configuration;message=model rejected");
});

test("a top-level error preserves safe structural keys and its message classification", () => {
  const run = interpretRun({
    stdout: '{"type":"error","message":"permission denied"}\n',
    stderr: "",
    exitCode: 0,
  });

  assert.equal(run.status, "FAILED");
  assert.equal(run.error, "parsed_error: authentication_or_permission;message=permission denied");
  assert.deepEqual(run.diagnostics.error_event_keys, ["type", "message"]);
});

test("a top-level nested error preserves code and message keys", () => {
  const run = interpretRun({
    stdout: '{"type":"error","error":{"code":"MODEL_NOT_FOUND","message":"model not found"}}\n',
    stderr: "",
    exitCode: 0,
  });

  assert.equal(run.status, "FAILED");
  assert.equal(run.error, "parsed_error: model_configuration;code=MODEL_NOT_FOUND;message=model not found");
  assert.deepEqual(run.diagnostics.error_event_keys, ["type", "error", "error.code", "error.message"]);
});

test("a top-level deeply nested error preserves its safe key paths", () => {
  const run = interpretRun({
    stdout: '{"type":"error","error":{"details":{"name":"PermissionDenied","message":"permission denied"}}}\n',
    stderr: "",
    exitCode: 0,
  });

  assert.equal(run.status, "FAILED");
  assert.equal(run.error, "parsed_error: authentication_or_permission;message=permission denied");
  assert.deepEqual(run.diagnostics.error_event_keys, ["type", "error", "error.details", "error.details.name", "error.details.message"]);
});

test("an empty top-level error preserves structure despite a missing terminal result", () => {
  const run = interpretRun({
    stdout: '{"type":"error","error":{}}\n',
    stderr: "",
    exitCode: 0,
  });

  assert.equal(run.status, "FAILED");
  assert.equal(run.error, "parsed_error: empty_error_event");
  assert.deepEqual(run.diagnostics.error_event_keys, ["type", "error"]);
  assert.equal(run.diagnostics.error_category, "parsed_error");
  assert.equal(run.diagnostics.safe_error_summary, "empty_error_event");
});

test("a top-level error redacts secrets before preserving its safe message", () => {
  const run = interpretRun({
    stdout: '{"type":"error","message":"upstream diagnostic token=private-value"}\n',
    stderr: "",
    exitCode: 0,
  });

  assert.equal(run.status, "FAILED");
  assert.equal(run.error, "parsed_error: authentication_or_permission;message=upstream diagnostic token=[REDACTED]");
  assert.doesNotMatch(run.error, /private-value/);
});

test("top-level credential errors stay diagnostic and safe through job persistence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-redaction-"));
  const cases = [
    ["Authorization: plain-secret", "Authorization: [REDACTED]", "plain-secret"],
    ["Authorization: Bearer bearer-secret", "Authorization: Bearer [REDACTED]", "bearer-secret"],
    ["CoOkIe = cookie-secret", "CoOkIe = [REDACTED]", "cookie-secret"],
    ["session=session-secret", "session=[REDACTED]", "session-secret"],
    ["credential: credential-secret", "credential: [REDACTED]", "credential-secret"],
  ];
  try {
    const store = new JobStore(directory);
    for (const [index, [input, expected, secret]] of cases.entries()) {
      const run = interpretRun({
        stdout: `${JSON.stringify({ type: "error", message: `upstream rejected request; retry later; ${input}` })}\n`,
        stderr: "",
        exitCode: 0,
      });
      const jobId = `redaction-${index}`;
      await store.create({ job_id: jobId, status: run.status, error: run.error, diagnostics: run.diagnostics });
      const persisted = await store.get(jobId);

      assert.equal(run.status, "FAILED");
      assert.match(run.error, /upstream rejected request; retry later/);
      assert.ok(run.error.includes(expected));
      assert.deepEqual(persisted.error, run.error);
      assert.deepEqual(persisted.diagnostics, run.diagnostics);
      assert.doesNotMatch(JSON.stringify(run), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(persisted), new RegExp(secret));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an otherwise-unclassified top-level error retains its safe message", () => {
  const run = interpretRun({
    stdout: '{"type":"error","message":"upstream frobulate issue"}\n',
    stderr: "",
    exitCode: 0,
  });

  assert.equal(run.error, "parsed_error: unclassified_error;message=upstream frobulate issue");
});

test("an opaque top-level error code is retained only as present", () => {
  const run = interpretRun({
    stdout: '{"type":"error","error":{"code":"token-secret-value","message":"upstream issue"}}\n',
    stderr: "",
    exitCode: 0,
  });

  assert.equal(run.error, "parsed_error: unclassified_error;code=PRESENT;message=upstream issue");
  assert.doesNotMatch(run.error, /secret-value/);
});

test("an error result without a result field preserves its CodeBuddy error", () => {
  const run = interpretRun({
    stdout: '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":[{"message":"network unavailable"}]}\n',
    stderr: "",
    exitCode: 0,
  });
  assert.equal(run.status, "FAILED");
  assert.equal(run.error, "workbuddy_error:error_during_execution:network");
});

test("malformed stream output is reported as a protocol failure", () => {
  const run = interpretRun({ stdout: "not-json\n", stderr: "", exitCode: 0 });
  assert.equal(run.status, "FAILED");
  assert.equal(run.error, "stream_json_protocol_error");
});

test("a clean process exit without a terminal result is reported distinctly", () => {
  const run = interpretRun({ stdout: '{"type":"assistant","message":{"content":[]}}\n', stderr: "", exitCode: 0 });
  assert.equal(run.status, "FAILED");
  assert.equal(run.error, "missing_terminal_result");
});

test("error-result diagnostics retain only safe stream structure", () => {
  const run = interpretRun({
    stdout: [
      '{"type":"assistant","message":{"content":[{"type":"text"},{"type":"tool_use"}]}}',
      '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":[{"message":"bearer secret-value session=private-value"}]}',
    ].join("\n"),
    stderr: "local failure details",
    exitCode: 1,
  });
  assert.deepEqual(run.diagnostics, {
    process_exit_code: 1,
    stderr_present: true,
    event_types: ["assistant", "result"],
    terminal_result_seen: true,
    terminal_subtype: "error_during_execution",
    terminal_is_error: true,
    result_field_present: false,
    errors_present: true,
    errors_info_present: false,
    assistant_content_block_types: ["text", "tool_use"],
    error_event_keys: [],
    error_category: "workbuddy_error",
    safe_error_summary: "authentication_or_permission",
  });
  assert.doesNotMatch(JSON.stringify(run.diagnostics), /secret-value|private-value/);
});
