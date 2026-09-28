import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkBuddyRunner } from "../src/workbuddy-runner.js";

test("runner resolves the explicit CLI override and preserves Node argv routing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, "console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'override-ok'}));", "utf8");
    let spawned;
    const runner = new WorkBuddyRunner({
      environment: { WORKBUDDY_CLI_PATH: script },
      spawn(nodeExecutable, args, options) {
        spawned = { nodeExecutable, args, options };
        return spawnChild(nodeExecutable, args, options);
      },
    });

    const run = await runner.run({ cwd: directory, model: "custom-local:step-5-preview", effort: "high", task: "read marker" });

    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "override-ok");
    assert.equal(spawned.nodeExecutable, process.execPath);
    assert.deepEqual(spawned.args, [script, "-p", "--output-format", "stream-json", "--model", "custom-local:step-5-preview", "--effort", "high", "read marker"]);
    assert.equal(spawned.options.shell, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner rejects a missing explicit CLI override before it can launch", async () => {
  let spawned = false;
  const runner = new WorkBuddyRunner({
    environment: { WORKBUDDY_CLI_PATH: path.join(os.tmpdir(), "missing-codebuddy-script") },
    spawn() { spawned = true; },
  });

  const run = await runner.run({ cwd: os.tmpdir(), model: "custom-local:step-5-preview", effort: "high", task: "read marker" });

  assert.equal(run.status, "FAILED");
  assert.match(run.error, /WORKBUDDY_CLI_PATH.*existing file/);
  assert.equal(spawned, false);
});

test("runner fails safely when child stream output exceeds its ceiling", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, "process.stdout.write('x'.repeat(1_100_000));", "utf8");
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({ cwd: directory, model: "custom-local:step-5-preview", effort: "high", task: "read" });
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
    await writeFile(script, "console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));", "utf8");
    let persisted = false;
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({
      cwd: directory,
      model: "custom-local:step-5-preview",
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
