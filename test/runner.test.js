import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkBuddyRunner } from "../src/workbuddy-runner.js";

test("runner fails safely when child stream output exceeds its ceiling", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, "process.stdout.write('x'.repeat(1_100_000));", "utf8");
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({ cwd: directory, model: "custom-local:step-3.7-flash", effort: "high", task: "read" });
    assert.equal(run.status, "FAILED");
    assert.equal(run.error, "output_limit_exceeded");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner waits for owned PID persistence before returning a final result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, "console.log(JSON.stringify({type:'result',result:'ok'}));", "utf8");
    let persisted = false;
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({
      cwd: directory,
      model: "custom-local:step-3.7-flash",
      effort: "high",
      task: "read",
      onStarted: async () => { await new Promise((resolve) => setTimeout(resolve, 300)); persisted = true; },
    });
    assert.equal(persisted, true);
    assert.equal(run.status, "COMPLETED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
