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
    const job = { job_id: "job-1", status: "QUEUED", requested_model: "custom-local:step-3.7-flash", final_text: null };
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
  assert.equal(run.error, "parsed_error: model_configuration");
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
    error_category: "workbuddy_error",
    safe_error_summary: "authentication_or_permission",
  });
  assert.doesNotMatch(JSON.stringify(run.diagnostics), /secret-value|private-value/);
});
