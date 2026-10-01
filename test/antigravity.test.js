import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AntigravityRunner, parseAntigravityRun } from "../src/antigravity-runner.js";
import { DEFAULT_EGRESS_PROXY_URL } from "../src/egress-proxy.js";
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
    // Permission decision record (docs/impl/agy-permission-decision.md §4,
    // option C, branch 1 verified live on agy 1.2.14): the runner must NOT
    // pass --dangerously-skip-permissions; the settings.json permission engine
    // carries the directory whitelist instead.
    assert.equal(invocation().args.includes("--dangerously-skip-permissions"), false);
    assert.deepEqual(invocation().args, [
      "-p",
      "read marker",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash-high",
      "--effort",
      "high",
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
    ]);
    assert.equal(spawned.args.includes("--dangerously-skip-permissions"), false);
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

test("contracts validates antigravity effort levels against the model tier", () => {
  // agy 1.2.14 live evidence (T5 canary 2026-10-01): a tier-suffixed model
  // hard-errors on a conflicting --effort, so only the tier-matching level is
  // valid for gemini-3.8-flash-high.
  const validated = validateDispatchInput(
    { agent: "antigravity", project: "p", task: "t", model: "gemini-3.8-flash-high", effort: "high" },
    models,
  );
  assert.equal(validated.effort, "high");
  for (const effort of ["low", "medium", "max"]) {
    assert.throws(
      () => validateDispatchInput(
        { agent: "antigravity", project: "p", task: "t", model: "gemini-3.8-flash-high", effort },
        models,
      ),
      { code: "invalid_effort" },
      `tier-conflicting effort ${effort} must be rejected`,
    );
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

test("Antigravity runner maps step_update tool sequence to activity events and never surfaces message steps", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-act-"));
  try {
    const streamOutput = [
      JSON.stringify({ event: "init", conversation_id: "conv-act", init: { model: "gemini-3.8-flash-high" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", usage: { total_tokens: 50 } } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool", tool_name: "write_to_file" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "agent_response" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 6, state: "ERROR", step_type: "tool", tool_name: "write_to_file", tool_info: { error: { message: "permission denied" } } } }),
      JSON.stringify({ event: "result", result: { conversation_id: "conv-act", status: "SUCCESS", response: "done" } }),
    ].join("\n");
    const script = "console.log(" + JSON.stringify(streamOutput) + ");";
    const { runner } = await fakeAntigravity(directory, script);
    const events = [];
    const run = await runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read", emit: (envelope) => events.push(envelope) });
    assert.equal(run.status, "COMPLETED", run.error);

    const activities = events.filter((e) => e.kind === "activity").map((e) => e.payload);
    assert.deepEqual(activities, [
      { kind: "tool_use", label: "write_to_file", state: "running" },
      { kind: "tool_use", label: "write_to_file", state: "completed" },
      { kind: "tool_use", label: "write_to_file", state: "failed" },
    ]);

    // Partial §3.2 envelope shape: schema, agent, session id from the stream.
    const started = events.find((e) => e.kind === "started");
    assert.equal(started.schema_version, 1);
    assert.equal(started.source.agent, "antigravity");
    const resultEvent = events.find((e) => e.kind === "result");
    assert.equal(resultEvent.source.session_id, "conv-act");
    assert.equal(resultEvent.payload.final_text, "done");
    assert.equal(run.emit_errors, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Antigravity runner maps result usage to canonical metrics without double counting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-usage-"));
  try {
    // Live stream shape (sched-agy-probe.log, 2026-09-30): token metrics live in
    // result.usage, while duration_seconds and num_turns are siblings of `usage`
    // at the result payload level. step_update usage is NOT aggregated (per task
    // card); result usage replaces the whole aggregation, and a replayed result
    // event must not add on top.
    const usage = { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 3, total_tokens: 15 };
    const result = { status: "SUCCESS", response: "u", duration_seconds: 6.118, num_turns: 1, usage };
    const streamOutput = [
      JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-high" } }),
      JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", usage: { input_tokens: 90, output_tokens: 9, total_tokens: 99 } } }),
      JSON.stringify({ event: "result", result }),
      JSON.stringify({ event: "result", result }),
    ].join("\n");
    const script = "console.log(" + JSON.stringify(streamOutput) + ");";
    const { runner } = await fakeAntigravity(directory, script);
    const run = await runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);

    const metrics = run.usage.metrics;
    assert.equal(metrics.input_tokens.value, 10);
    assert.equal(metrics.input_tokens.source_field, "result.usage.input_tokens");
    assert.equal(metrics.output_tokens.value, 5);
    assert.equal(metrics.total_tokens.value, 15);
    assert.equal(metrics.total_tokens.quality, "reported");
    assert.equal(metrics.cache_read_tokens.value, 3);
    assert.equal(metrics.reasoning_tokens.value, 2);
    assert.equal(metrics.reasoning_tokens.source_field, "result.usage.thinking_tokens");
    // duration_seconds is reported in seconds and surfaces in ms (T5-cal).
    assert.equal(metrics.wall_duration_ms.value, 6118);
    assert.equal(metrics.wall_duration_ms.quality, "reported");
    assert.equal(metrics.wall_duration_ms.source_field, "result.duration_seconds");
    assert.equal(metrics.num_turns.value, 1);
    assert.equal(metrics.num_turns.source_field, "result.num_turns");
    assert.equal(metrics.cache_write_tokens.value, null);
    assert.equal(metrics.cache_write_tokens.unavailable_reason, "source_field_absent");
    assert.deepEqual(run.usage.inclusion, { input_includes_cache: null, output_includes_reasoning: true });
    assert.equal(run.usage.schema_version, 1);

    // Replay never doubles: total stays the reported value, not summed.
    assert.equal(metrics.total_tokens.value, 15);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// T5-cal (2026-10-01): a missing duration_seconds must stay unavailable, never a
// fabricated zero, and the dependent throughput stays unavailable too.
test("Antigravity runner keeps wall_duration_ms unavailable when the result omits duration_seconds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-nodur-"));
  try {
    const streamOutput = [
      JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-high" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "no-duration", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }),
    ].join("\n");
    const script = "console.log(" + JSON.stringify(streamOutput) + ");";
    const { runner } = await fakeAntigravity(directory, script);
    const run = await runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);

    const metrics = run.usage.metrics;
    assert.equal(metrics.wall_duration_ms.value, null);
    assert.equal(metrics.wall_duration_ms.quality, "unavailable");
    assert.equal(metrics.wall_duration_ms.unavailable_reason, "source_field_absent");
    assert.equal(metrics.num_turns.value, null);
    assert.equal(metrics.num_turns.unavailable_reason, "source_field_absent");
    assert.equal(metrics.job_output_tokens_per_second.value, null);
    assert.equal(metrics.job_output_tokens_per_second.unavailable_reason, "wall_duration_ms_unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Antigravity runner resolves terminal-versus-exit conflicts as failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-conflict-"));
  try {
    // A SUCCESS terminal result contradicted by a non-zero exit stays FAILED.
    const successButExit = await fakeAntigravity(
      directory,
      "console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'ok'}}));process.exitCode=3;",
    );
    const runA = await successButExit.runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(runA.status, "FAILED");
    assert.equal(runA.error, "antigravity_process_exit_3");
    assert.equal(runA.finalText, null);

    // An ERROR terminal result with a zero exit is a terminal failure.
    const errorButZeroExit = await fakeAntigravity(
      directory,
      "console.log(JSON.stringify({event:'result',result:{status:'ERROR',error:'boom'}}));",
    );
    const runB = await errorButZeroExit.runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(runB.status, "FAILED");
    assert.equal(runB.error, "antigravity_terminal_error");
    assert.equal(runB.diagnostics.error_category, "terminal_failure");

    // A SUCCESS terminal with an empty response has no final text: missing
    // terminal result, not COMPLETED with empty output.
    const emptyResponse = await fakeAntigravity(
      directory,
      "console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:''}}));",
    );
    const runC = await emptyResponse.runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(runC.status, "FAILED");
    assert.equal(runC.error, "antigravity_missing_terminal_result");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// T5 canary (2026-10-01): agy failed through the live dispatcher with
// "model unavailable" because the dispatcher environment has no proxy and
// Google is unreachable directly. The runner now injects the Clash egress
// proxy into the child environment only.
test("Antigravity runner injects the default egress proxy into the child environment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-env-"));
  try {
    const { runner, invocation } = await fakeAntigravity(
      directory,
      "console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'proxy-ok'}}));",
    );
    const run = await runner.run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(invocation().options.env.HTTPS_PROXY, DEFAULT_EGRESS_PROXY_URL);
    assert.equal(invocation().options.env.HTTP_PROXY, DEFAULT_EGRESS_PROXY_URL);
    assert.equal(invocation().options.env.https_proxy, DEFAULT_EGRESS_PROXY_URL);
    assert.match(invocation().options.env.NO_PROXY, /127\.0\.0\.1/);
    // The parent environment is preserved underneath the injection.
    const parentPath = process.env.Path ?? process.env.PATH;
    assert.equal(invocation().options.env.Path ?? invocation().options.env.PATH, parentPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ANTIGRAVITY_PROXY_URL overrides the default; 'direct' disables the injection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-agy-env2-"));
  try {
    const source = "console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'ok'}}));";
    const script = path.join(directory, "fake-agy.js");
    await writeFile(script, source, "utf8");
    const seen = [];
    const makeRunner = (environment) => new AntigravityRunner({
      environment,
      spawn(executable, args, options) {
        seen.push(options);
        return spawnChild(process.execPath, [script, ...args], options);
      },
    });
    const overridden = await makeRunner({ ANTIGRAVITY_PROXY_URL: "http://127.0.0.1:9999" })
      .run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(overridden.status, "COMPLETED", overridden.error);
    assert.equal(seen[0].env.HTTPS_PROXY, "http://127.0.0.1:9999");

    const direct = await makeRunner({ ANTIGRAVITY_PROXY_URL: "direct" })
      .run({ cwd: directory, model: "gemini-3.8-flash-high", effort: "high", task: "read" });
    assert.equal(direct.status, "COMPLETED", direct.error);
    // No injection: the child sees exactly what the parent has (possibly undefined).
    assert.equal(seen[1].env.HTTPS_PROXY, process.env.HTTPS_PROXY);
    assert.equal(seen[1].env.NO_PROXY, process.env.NO_PROXY);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
