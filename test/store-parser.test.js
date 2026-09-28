import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobStore } from "../src/job-store.js";
import { interpretRun } from "../src/stream-json.js";

test("a job survives a new store instance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-store-"));
  try {
    const job = { job_id: "job-1", status: "QUEUED", requested_model: "custom-local:step-5-preview", final_text: null };
    await new JobStore(directory).create(job);
    const recovered = await new JobStore(directory).get("job-1");
    assert.deepEqual(recovered, job);
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
