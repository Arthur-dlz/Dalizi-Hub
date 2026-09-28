import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexRunner } from "../src/codex-runner.js";
import { Dispatcher } from "../src/dispatcher.js";
import { JobStore } from "../src/job-store.js";

const models = { workbuddy: new Set(["custom-local:step-5-preview"]), codex: new Set(["gpt-6-sol"]) };

async function fakeCodex(directory, source) {
  const script = path.join(directory, "fake-codex.js");
  await writeFile(script, source, "utf8");
  let invocation;
  const runner = new CodexRunner({
    environment: {},
    spawn(executable, args, options) {
      invocation = { executable, args, options };
      return spawnChild(process.execPath, [script, ...args], options);
    },
  });
  return { runner, invocation: () => invocation };
}

test("Codex runner passes model, effort and canonical cwd through argv with no shell", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { runner, invocation } = await fakeCodex(directory, "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'marker-ok'}}));console.log(JSON.stringify({type:'turn.completed'}));");
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read marker" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "marker-ok");
    assert.equal(run.diagnostics.process_exit_code, 0);
    assert.equal(invocation().executable, "codex");
    assert.deepEqual(invocation().args, ["exec", "-m", "gpt-6-sol", "-c", "model_reasoning_effort=high", "-C", directory, "--json", "read marker"]);
    assert.equal(invocation().options.cwd, directory);
    assert.equal(invocation().options.shell, false);
    assert.deepEqual(invocation().options.stdio, ["ignore", "pipe", "pipe"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit CODEX_CLI_PATH is canonicalized and used without changing argv", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-path-"));
  try {
    const { runner: fake } = await fakeCodex(directory, "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'path-ok'}}));console.log(JSON.stringify({type:'turn.completed'}));");
    let spawned;
    const runner = new CodexRunner({
      environment: { CODEX_CLI_PATH: process.execPath },
      spawn(executable, args, options) {
        spawned = { executable, args, options };
        return fake.spawn(executable, args, options);
      },
    });
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read marker" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "path-ok");
    assert.equal(spawned.executable, process.execPath);
    assert.deepEqual(spawned.args, ["exec", "-m", "gpt-6-sol", "-c", "model_reasoning_effort=high", "-C", directory, "--json", "read marker"]);
    assert.equal(spawned.options.shell, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid CODEX_CLI_PATH fails closed without launching or persisting path text", async () => {
  for (const value of ["relative/codex.exe", path.join(os.tmpdir(), "missing-codex.exe"), os.tmpdir(), ""]) {
    let spawned = false;
    const runner = new CodexRunner({ environment: { CODEX_CLI_PATH: value }, spawn() { spawned = true; } });
    const run = await runner.run({ cwd: os.tmpdir(), model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(run.error, "codex_launch_error");
    assert.equal(run.diagnostics.launch_error_code, "INVALID_CODEX_CLI_PATH");
    assert.equal(spawned, false);
    assert.doesNotMatch(JSON.stringify(run), /missing-codex|relative\/codex/);
  }
});

test("Codex runner distinguishes model, terminal, process and launch failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    for (const [source, expected] of [
      ["console.log(JSON.stringify({type:'turn.failed',error:{message:'model unavailable'}}));process.exitCode=1;", "codex_model_error"],
      ["console.log(JSON.stringify({type:'turn.failed',error:{message:'tool failed'}}));process.exitCode=1;", "codex_terminal_error"],
      ["process.exitCode=2;", "codex_process_exit_2"],
    ]) {
      const { runner } = await fakeCodex(directory, source);
      const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
      assert.equal(run.status, "FAILED");
      assert.equal(run.error, expected);
    }
    const failed = await new CodexRunner({ environment: {}, spawn() { throw Object.assign(new Error("private path"), { code: "ENOENT" }); } }).run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(failed.error, "codex_launch_error");
    assert.equal(failed.diagnostics.launch_error_code, "ENOENT");
    assert.doesNotMatch(JSON.stringify(failed), /private path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Dispatcher routes Codex to its runner, rejects other models, and persists result across instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { runner } = await fakeCodex(directory, "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'persisted-ok'}}));console.log(JSON.stringify({type:'turn.completed'}));");
    const jobs = path.join(directory, "jobs");
    const dispatcher = new Dispatcher({
      registry: { resolve(alias) { assert.equal(alias, "canary"); return directory; } },
      allowedModels: models,
      store: new JobStore(jobs),
      runner: { run() { throw new Error("WorkBuddy must not run"); } },
      codexRunner: runner,
    });
    await assert.rejects(() => dispatcher.dispatch({ agent: "codex", project: "canary", task: "read", model: "gpt-5.6-sol" }), { code: "invalid_model" });
    await assert.rejects(() => dispatcher.dispatch({ agent: "codex", project: "canary", task: "read", model: "custom-local:step-5-preview" }), { code: "invalid_model" });
    const receipt = await dispatcher.dispatch({ agent: "codex", project: "canary", task: "read", model: "gpt-6-sol", effort: "high" });
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = await new JobStore(jobs).get(receipt.job_id);
      if (job.status === "COMPLETED" || job.status === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(job.status, "COMPLETED", job.error);
    assert.equal(job.agent, "codex");
    assert.equal(job.requested_model, "gpt-6-sol");
    assert.equal(job.actual_model, "NOT_OBSERVABLE");
    assert.equal(job.effort, "high");
    assert.equal(job.final_text, "persisted-ok");
    assert.equal((await readFile(path.join(jobs, `${receipt.job_id}.json`), "utf8")).includes("persisted-ok"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
