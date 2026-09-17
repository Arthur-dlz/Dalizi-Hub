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

test("a parsed final result wins over a non-zero process exit code", () => {
  const run = interpretRun({
    stdout: '{"type":"result","result":"PROJECT_MARKER=violet","is_error":false}\n',
    stderr: "",
    exitCode: 1,
  });
  assert.deepEqual(run, { status: "COMPLETED", finalText: "PROJECT_MARKER=violet", error: null, actualModel: "NOT_OBSERVABLE" });
});

test("a parsed error wins over a zero process exit code", () => {
  const run = interpretRun({
    stdout: '{"type":"error","error":{"message":"model rejected"}}\n',
    stderr: "ignored",
    exitCode: 0,
  });
  assert.equal(run.status, "FAILED");
  assert.match(run.error, /model rejected/);
});
