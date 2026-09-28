import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AntigravityRunner, parseAntigravityRun } from "../src/antigravity-runner.js";
import { parseAntigravityUsage } from "../src/antigravity-usage.js";
import { Dispatcher } from "../src/dispatcher.js";
import { JobStore } from "../src/job-store.js";
import { validateDispatchInput } from "../src/contracts.js";

const models = {
  workbuddy: new Set(["custom-local:step-5-preview"]),
  codex: new Set(["gpt-6-sol"]),
  antigravity: new Set(["gemini-3.8-flash-high", "gemini-3.8-flash-medium"]),
};

async function fakeAntigravity(directory, source) {
  const script = path.join(directory, "fake-agy.js");
  await writeFile(script, source, "utf8");
  let invocation;
  const runner = new AntigravityRunner({
    environment: {},
    spawn(executable, args, options) {
      invocation = { executable, args, options };
      return spawnChild(process.execPath, [script, ...args], options);
    },
  });
  return { runner, invocation: () => invocation };
}

test("Antigravity runner passes model, effort and canonical cwd through argv with no shell", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-"));
  try {
    const streamOutput = [
      JSON.stringify({ event: "init", conversation_id: "conv-1", init: { model: "gemini-3.8-flash-high", cwd: directory } }),
      JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", usage: { total_tokens: 100 } } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "agy-marker-ok", usage: { total_tokens: 100 } } }),
    ].join("\n");
    const { runner, invocation } = await fakeAntigravity(directory, `console.log(${JSON.stringify(streamOutput)});`);
    const run = await runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read marker" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "agy-marker-ok");
    assert.equal(run.actualModel, "gemini-3.8-flash-high");
    assert.equal(run.diagnostics.process_exit_code, 0);
    assert.deepEqual(run.diagnostics.event_types, ["init", "step_update", "result"]);
    assert.deepEqual(run.diagnostics.step_types, ["agent_response"]);
    assert.equal(run.diagnostics.conversation_id, "conv-1");
    assert.deepEqual(run.diagnostics.token_usage, { total_tokens: 100 });
    assert.deepEqual(invocation().args, [
      "-p",
      "read marker",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash-high",
      "--effort",
      "high",
      "--dangerously-skip-permissions",
    ]);
    assert.equal(invocation().options.cwd, directory);
    assert.equal(invocation().options.shell, false);
    assert.deepEqual(invocation().options.stdio, ["ignore", "pipe", "pipe"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit ANTIGRAVITY_CLI_PATH is canonicalized and used without changing argv", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-path-"));
  try {
    const streamOutput = [
      JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-high" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "path-ok" } }),
    ].join("\n");
    const { runner: fake } = await fakeAntigravity(directory, `console.log(${JSON.stringify(streamOutput)});`);
    let spawned;
    const runner = new AntigravityRunner({
      environment: { ANTIGRAVITY_CLI_PATH: process.execPath },
      spawn(executable, args, options) {
        spawned = { executable, args, options };
        return fake.spawn(executable, args, options);
      },
    });
    const run = await runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "medium", task: "read marker" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "path-ok");
    assert.equal(spawned.executable, process.execPath);
    assert.deepEqual(spawned.args, [
      "-p",
      "read marker",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash-high",
      "--effort",
      "medium",
      "--dangerously-skip-permissions",
    ]);
    assert.equal(spawned.options.shell, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid ANTIGRAVITY_CLI_PATH fails closed without launching or persisting path text", async () => {
  for (const value of ["relative/agy.exe", path.join(os.tmpdir(), "missing-agy.exe"), os.tmpdir(), ""]) {
    let spawned = false;
    const runner = new AntigravityRunner({ environment: { ANTIGRAVITY_CLI_PATH: value }, spawn() { spawned = true; } });
    const run = await runner.run({ cwd: os.tmpdir(), model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(run.error, "antigravity_launch_error");
    assert.equal(run.diagnostics.launch_error_code, "INVALID_ANTIGRAVITY_CLI_PATH");
    assert.equal(spawned, false);
    assert.doesNotMatch(JSON.stringify(run), /missing-agy|relative\/agy/);
  }
});

test("Antigravity runner distinguishes model, terminal, auth, process and launch failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-"));
  try {
    for (const [source, expected] of [
      [
        `console.log(JSON.stringify({event:'result',result:{status:'ERROR',error:'invalid model selection: model not recognized'}}));process.exitCode=1;`,
        "antigravity_model_error",
      ],
      [
        `console.log(JSON.stringify({event:'result',result:{status:'ERROR',error:'authentication failed: unauthorized'}}));process.exitCode=1;`,
        "antigravity_auth_error",
      ],
      [
        `console.log(JSON.stringify({event:'result',result:{status:'ERROR',error:'something broke'}}));process.exitCode=1;`,
        "antigravity_terminal_error",
      ],
      [
        `process.exitCode=3;`,
        "antigravity_process_exit_3",
      ],
    ]) {
      const { runner } = await fakeAntigravity(directory, source);
      const run = await runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
      assert.equal(run.status, "FAILED");
      assert.equal(run.error, expected);
    }
    const failed = await new AntigravityRunner({
      environment: {},
      spawn() { throw Object.assign(new Error("secret path"), { code: "ENOENT" }); },
    }).run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(failed.error, "antigravity_launch_error");
    assert.equal(failed.diagnostics.launch_error_code, "ENOENT");
    assert.doesNotMatch(JSON.stringify(failed), /secret path/);

    const { EventEmitter } = await import("node:events");
    const asyncFailed = await new AntigravityRunner({
      executable: process.execPath,
      environment: {},
      spawn() {
        const ee = new EventEmitter();
        ee.stdout = new EventEmitter();
        ee.stderr = new EventEmitter();
        ee.stdout.setEncoding = () => {};
        ee.stderr.setEncoding = () => {};
        process.nextTick(() => ee.emit("error", Object.assign(new Error("async fail"), { code: "ENOENT" })));
        return ee;
      },
    }).run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(asyncFailed.error, "antigravity_launch_error");
    assert.equal(asyncFailed.diagnostics.launch_error_code, "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Antigravity runner redacts secrets and bearer tokens from finalText", () => {
  const raw = [
    JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-high" } }),
    JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "Sensitive: Bearer secret-token-12345 api_key=super-secret-key-abc",
      },
    }),
  ].join("\n");
  const parsed = parseAntigravityRun({ stdout: raw, stderr: "", exitCode: 0 });
  assert.equal(parsed.status, "COMPLETED");
  assert.doesNotMatch(parsed.finalText, /secret-token-12345/);
  assert.doesNotMatch(parsed.finalText, /super-secret-key-abc/);
  assert.match(parsed.finalText, /Bearer \[REDACTED\]/);
});

test("Antigravity runner handles protocol errors and missing terminal results safely", () => {
  const malformed = parseAntigravityRun({ stdout: "not-json\n", stderr: "", exitCode: 0 });
  assert.equal(malformed.status, "FAILED");
  assert.equal(malformed.error, "antigravity_protocol_error");

  const incomplete = parseAntigravityRun({
    stdout: JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-high" } }),
    stderr: "",
    exitCode: 0,
  });
  assert.equal(incomplete.status, "FAILED");
  assert.equal(incomplete.error, "antigravity_missing_terminal_result");
});

test("Dispatcher routes Antigravity to its runner, rejects invalid models/efforts, and persists result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-dispatcher-"));
  try {
    const streamOutput = [
      JSON.stringify({ event: "init", conversation_id: "conv-persist", init: { model: "gemini-3.8-flash-high" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "antigravity-persisted-ok" } }),
    ].join("\n");
    const { runner } = await fakeAntigravity(directory, `console.log(${JSON.stringify(streamOutput)});`);
    const jobs = path.join(directory, "jobs");
    const dispatcher = new Dispatcher({
      registry: { resolve(alias) { assert.equal(alias, "canary"); return directory; } },
      allowedModels: models,
      store: new JobStore(jobs),
      runner: { run() { throw new Error("WorkBuddy must not run"); } },
      codexRunner: { run() { throw new Error("Codex must not run"); } },
      antigravityRunner: runner,
    });

    // Model validation
    await assert.rejects(
      () => dispatcher.dispatch({ agent: "antigravity", project: "canary", task: "read", model: "unregistered-gemini" }),
      { code: "invalid_model" },
    );
    await assert.rejects(
      () => dispatcher.dispatch({ agent: "antigravity", project: "canary", task: "read", model: "gpt-6-sol" }),
      { code: "invalid_model" },
    );

    // Effort validation
    await assert.rejects(
      () => dispatcher.dispatch({ agent: "antigravity", project: "canary", task: "read", model: "gemini-3.8-flash-high", effort: "minimal" }),
      { code: "invalid_effort" },
    );
    await assert.rejects(
      () => dispatcher.dispatch({ agent: "antigravity", project: "canary", task: "read", model: "gemini-3.8-flash-high", effort: "xhigh" }),
      { code: "invalid_effort" },
    );

    // Successful dispatch
    const receipt = await dispatcher.dispatch({
      agent: "antigravity",
      project: "canary",
      task: "read marker",
      model: "gemini-3.8-flash-high",
      effort: "high",
    });
    assert.match(receipt.job_id, /^[0-9a-f-]{36}$/);

    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = await new JobStore(jobs).get(receipt.job_id);
      if (job.status === "COMPLETED" || job.status === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(job.status, "COMPLETED", job.error);
    assert.equal(job.agent, "antigravity");
    assert.equal(job.requested_model, "gemini-3.8-flash-high");
    assert.equal(job.actual_model, "gemini-3.8-flash-high");
    assert.equal(job.effort, "high");
    assert.equal(job.final_text, "antigravity-persisted-ok");
    assert.equal((await readFile(path.join(jobs, `${receipt.job_id}.json`), "utf8")).includes("antigravity-persisted-ok"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("contracts validates antigravity effort levels", () => {
  for (const effort of ["low", "medium", "high", "max"]) {
    const validated = validateDispatchInput(
      { agent: "antigravity", project: "p", task: "t", model: "gemini-3.8-flash-high", effort },
      models,
    );
    assert.equal(validated.effort, effort);
  }
  for (const effort of ["minimal", "xhigh", "unsupported"]) {
    assert.throws(
      () => validateDispatchInput(
        { agent: "antigravity", project: "p", task: "t", model: "gemini-3.8-flash-high", effort },
        models,
      ),
      { code: "invalid_effort" },
    );
  }
});

test("Antigravity usage parser extracts groups and buckets safely", () => {
  const sample = {
    conversation_id: "",
    status: "SUCCESS",
    response: "text summary",
    command: {
      name: "usage",
      data: {
        description: "Quota overview",
        groups: [
          {
            name: "Gemini Models",
            description: "Gemini models group",
            buckets: [
              {
                id: "gemini-weekly",
                name: "Weekly Limit",
                window: "weekly",
                remaining_fraction: 0.98,
                reset_time: "2026-09-28T15:18:56Z",
              },
            ],
          },
        ],
      },
    },
  };

  const parsed = parseAntigravityUsage(JSON.stringify(sample));
  assert.equal(parsed.status, "SUCCESS");
  assert.equal(parsed.error, null);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].name, "Gemini Models");
  assert.equal(parsed.groups[0].buckets.length, 1);
  assert.equal(parsed.groups[0].buckets[0].id, "gemini-weekly");
  assert.equal(parsed.groups[0].buckets[0].remaining_fraction, 0.98);
  assert.equal(parsed.groups[0].buckets[0].reset_time, "2026-09-28T15:18:56Z");

  const malformed = parseAntigravityUsage("invalid-json");
  assert.equal(malformed.status, "FAILED");
  assert.equal(malformed.error, "malformed_usage_json");

  const empty = parseAntigravityUsage(null);
  assert.equal(empty.status, "FAILED");
  assert.equal(empty.error, "invalid_usage_output");
});
