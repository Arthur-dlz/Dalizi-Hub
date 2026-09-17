import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Dispatcher } from "../src/dispatcher.js";
import { JobStore } from "../src/job-store.js";

test("dispatch persists a completed WorkBuddy result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-dispatcher-"));
  try {
    const calls = [];
    const dispatcher = new Dispatcher({
      registry: { resolve(project) { if (project !== "canary-project") throw new Error("unexpected project"); return directory; } },
      allowedModels: new Set(["custom-local:step-3.7-flash"]),
      store: new JobStore(path.join(directory, "jobs")),
      runner: { async run(input) { calls.push(input); return { pid: 4321, status: "COMPLETED", finalText: "PROJECT_MARKER=violet", error: null, actualModel: "NOT_OBSERVABLE" }; } },
    });

    const receipt = await dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-3.7-flash", effort: "high" });
    assert.match(receipt.job_id, /^[0-9a-f-]{36}$/);
    const completed = await waitFor(() => dispatcher.get(receipt.job_id));
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.final_text, "PROJECT_MARKER=violet");
    assert.equal(completed.requested_model, "custom-local:step-3.7-flash");
    assert.equal(calls[0].cwd, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(read) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const job = await read();
    if (job.status === "COMPLETED" || job.status === "FAILED") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not settle");
}
