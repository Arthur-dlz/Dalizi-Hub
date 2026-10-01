import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexRunner } from "../src/codex-runner.js";
import { DEFAULT_EGRESS_PROXY_URL } from "../src/egress-proxy.js";
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

// Writes a fake codex script whose stdout is the given JSONL lines, then runs it
// with an emit collector. Returns the run result and the collected envelopes.
async function runWithEvents(directory, lines, { emit = true, extra = {} } = {}) {
  const script = [
    "const lines = " + JSON.stringify(lines) + ";",
    "process.stdout.write(lines.join('\\n') + '\\n');",
  ].join("\n");
  const { runner } = await fakeCodex(directory, script);
  const events = [];
  const run = await runner.run({
    cwd: directory,
    model: "gpt-6-sol",
    effort: "high",
    task: "read",
    ...(emit ? { emit: (envelope) => { events.push(envelope); } } : {}),
    ...extra,
  });
  return { run, events };
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
    // --skip-git-repo-check is mandatory: the dispatcher registry/roots are
    // the trust layer; codex 0.159.2 hard-fails outside a git repo otherwise.
    assert.deepEqual(invocation().args, ["exec", "-m", "gpt-6-sol", "-c", "model_reasoning_effort=high", "-C", directory, "--json", "--skip-git-repo-check", "read marker"]);
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
    assert.deepEqual(spawned.args, ["exec", "-m", "gpt-6-sol", "-c", "model_reasoning_effort=high", "-C", directory, "--json", "--skip-git-repo-check", "read marker"]);
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

// ---- T3b additions: A3 (incremental real-time state) + A4 (usage accuracy) ----

test("incremental decoding survives a multi-byte UTF-8 character split across chunks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const script = [
      "const msg = JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'任务完成✓'}});",
      "const done = JSON.stringify({type:'turn.completed'});",
      "const bytes = Buffer.from(msg + '\\n' + done + '\\n', 'utf8');",
      "let splitAt = -1;",
      "for (let i = 0; i < bytes.length; i++) { if (bytes[i] >= 0x80) { splitAt = i + 1; break; } }",
      "process.stdout.write(bytes.subarray(0, splitAt));",
      "process.stdout.write(bytes.subarray(splitAt));",
    ].join("\n");
    const { runner } = await fakeCodex(directory, script);
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "任务完成✓");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("incremental decoding handles half lines, multi-line chunks and a missing trailing newline", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const script = [
      "const message = JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'split-ok'}});",
      "const done = JSON.stringify({type:'turn.completed'});",
      "const half = message.slice(0, Math.floor(message.length / 2));",
      "process.stdout.write(half);",
      "setTimeout(() => { process.stdout.write(message.slice(half.length) + '\\n' + done); }, 60);",
    ].join("\n");
    const { runner } = await fakeCodex(directory, script);
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "split-ok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed stream line fails the run as a protocol error and emits the terminal error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { run, events } = await runWithEvents(directory, ["not-json", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }), JSON.stringify({ type: "turn.completed" })]);
    assert.equal(run.status, "FAILED");
    assert.equal(run.error, "codex_protocol_error");
    assert.equal(events[0].kind, "started");
    const terminal = events[events.length - 1];
    assert.equal(terminal.kind, "error");
    assert.equal(terminal.payload.message, "codex_protocol_error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emit carries started, activity, usage and the terminal result with a partial envelope", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { run, events } = await runWithEvents(directory, [
      JSON.stringify({ type: "thread.started", thread_id: "thread-xyz" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "ls -la" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "ls -la", exit_code: 0 } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "codex-flow-ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 10 } }),
    ]);
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "codex-flow-ok");

    const started = events[0];
    assert.equal(started.kind, "started");
    assert.equal(started.payload.pid, run.pid);
    assert.deepEqual(Object.keys(started.source).sort(), ["agent", "cli_version", "event_id", "session_id"]);
    assert.equal(started.source.agent, "codex");
    assert.equal(started.source.cli_version, null);
    assert.equal(started.source.session_id, null);

    const activities = events.filter((event) => event.kind === "activity");
    assert.deepEqual(activities.map((event) => event.payload), [
      { kind: "tool_use", label: "ls -la", state: "running" },
      { kind: "tool_use", label: "ls -la", state: "completed" },
    ]);
    assert.ok(activities.every((event) => event.source.session_id === "thread-xyz"));

    const usageEvents = events.filter((event) => event.kind === "usage");
    assert.equal(usageEvents.length, 2, "one usage at turn.completed, one after close");
    assert.equal(usageEvents[0].payload.metrics.input_tokens.value, 100);

    const terminal = events[events.length - 1];
    assert.equal(terminal.kind, "result");
    assert.equal(terminal.payload.final_text, "codex-flow-ok");
    assert.equal(terminal.payload.actual_model, "NOT_OBSERVABLE");
    assert.equal(terminal.payload.usage.metrics.input_tokens.value, 100);
    assert.equal(terminal.source.session_id, "thread-xyz");
    for (const event of events) {
      assert.equal(event.schema_version, 1);
      assert.match(event.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      assert.equal(Object.hasOwn(event, "job_id"), false, "job_id belongs to the dispatcher wiring layer");
      assert.equal(Object.hasOwn(event, "seq"), false, "seq belongs to the dispatcher wiring layer");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("turn.completed usage maps the five fields and a provider total wins", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { run } = await runWithEvents(directory, [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "usage-ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 200 } }),
    ]);
    assert.equal(run.status, "COMPLETED", run.error);
    const metrics = run.usage.metrics;
    assert.equal(metrics.input_tokens.value, 100);
    assert.equal(metrics.input_tokens.source_field, "usage.input_tokens");
    assert.equal(metrics.input_tokens.quality, "reported");
    assert.equal(metrics.output_tokens.value, 50);
    assert.equal(metrics.cache_read_tokens.value, 20);
    assert.equal(metrics.cache_read_tokens.source_field, "usage.cached_input_tokens");
    assert.equal(metrics.reasoning_tokens.value, 10);
    assert.equal(metrics.reasoning_tokens.source_field, "usage.reasoning_output_tokens");
    assert.equal(metrics.total_tokens.value, 200, "provider total is used as-is");
    assert.equal(metrics.total_tokens.quality, "reported");
    assert.equal(metrics.cache_write_tokens.value, null, "this fixture carries no cache-write field: absent is not zero");
    assert.equal(metrics.cache_write_tokens.quality, "unavailable");
    assert.equal(metrics.cache_write_tokens.unavailable_reason, "source_field_absent");
    assert.equal(metrics.job_output_tokens_per_second.value, null, "no wall duration observed -> throughput unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// T5-cal (2026-10-01): codex 0.159.2 reports cache_write_input_tokens in
// turn.completed.usage (live probe sample), which the map previously missed.
test("turn.completed usage reports cache_write_input_tokens when codex sends it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { run } = await runWithEvents(directory, [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "cache-write-ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 202633, cached_input_tokens: 187520, cache_write_input_tokens: 4096, output_tokens: 443, reasoning_output_tokens: 91 } }),
    ]);
    assert.equal(run.status, "COMPLETED", run.error);
    const metric = run.usage.metrics.cache_write_tokens;
    assert.equal(metric.value, 4096);
    assert.equal(metric.quality, "reported");
    assert.equal(metric.source_field, "usage.cache_write_input_tokens");
    assert.equal(metric.unavailable_reason, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("total_tokens is derived from input + output only when the provider omits it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { run } = await runWithEvents(directory, [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "derived-ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 10 } }),
    ]);
    assert.equal(run.status, "COMPLETED", run.error);
    const total = run.usage.metrics.total_tokens;
    assert.equal(total.value, 150, "input_tokens + output_tokens; cache and reasoning are already included");
    assert.equal(total.quality, "derived");
    assert.equal(total.source_field, "derived:input_tokens+output_tokens");
    assert.deepEqual(run.usage.inclusion, { input_includes_cache: true, output_includes_reasoning: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replayed turn.completed usage never double counts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const usage = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 10 };
    const { run, events } = await runWithEvents(directory, [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "replay-ok" } }),
      JSON.stringify({ type: "turn.completed", usage }),
      JSON.stringify({ type: "turn.completed", usage }),
    ]);
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.usage.metrics.input_tokens.value, 100, "a replayed terminal replaces, never accumulates");
    assert.equal(run.usage.metrics.output_tokens.value, 50);
    assert.equal(run.usage.metrics.total_tokens.value, 150);
    const usageEvents = events.filter((event) => event.kind === "usage");
    assert.equal(usageEvents.length, 3);
    assert.equal(usageEvents[1].payload.metrics.input_tokens.value, 100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a turn.completed success conflicting with a non-zero exit code is a failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const script = [
      "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'looks-done'}}));",
      "console.log(JSON.stringify({type:'turn.completed'}));",
      "process.exitCode = 1;",
    ].join("\n");
    const { runner } = await fakeCodex(directory, script);
    const events = [];
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read", emit: (envelope) => { events.push(envelope); } });
    assert.equal(run.status, "FAILED");
    assert.equal(run.error, "codex_process_exit_1");
    assert.equal(run.finalText, null);
    assert.equal(run.diagnostics.process_exit_code, 1);
    const terminal = events[events.length - 1];
    assert.equal(terminal.kind, "error");
    assert.equal(terminal.payload.message, "codex_process_exit_1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a protocol terminal without a persisted result is not a completion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { runner } = await fakeCodex(directory, "console.log(JSON.stringify({type:'turn.completed'}));");
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(run.status, "FAILED");
    assert.equal(run.error, "codex_missing_terminal_result");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("without emit the run stays V0-equivalent, diagnostics field-for-field", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { runner } = await fakeCodex(directory, "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'v0-ok'}}));console.log(JSON.stringify({type:'turn.completed'}));");
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "v0-ok");
    assert.equal(run.actualModel, "NOT_OBSERVABLE");
    assert.deepEqual(run.diagnostics, {
      process_exit_code: 0,
      stderr_present: false,
      event_types: ["item.completed", "turn.completed"],
      error_category: null,
    });
    assert.equal(run.emit_errors, 0);
    assert.equal(run.usage.schema_version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a throwing emit side channel never changes the run outcome and is counted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { runner } = await fakeCodex(directory, "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'emit-proof'}}));console.log(JSON.stringify({type:'turn.completed'}));");
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read", emit: () => { throw new Error("emit boom"); } });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "emit-proof");
    assert.ok(run.emit_errors > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reasoning and message items never fabricate activity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { run, events } = await runWithEvents(directory, [
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "internal chain of thought" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "quiet-ok" } }),
      JSON.stringify({ type: "turn.completed" }),
    ]);
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "quiet-ok");
    assert.deepEqual(events.filter((event) => event.kind === "activity"), []);
    // No usage dict on this turn.completed, so the only usage event is the
    // post-close terminal snapshot.
    assert.deepEqual(events.map((event) => event.kind), ["started", "usage", "result"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the completed final text is redacted before it is returned", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-"));
  try {
    const { runner } = await fakeCodex(directory, "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done token=abc123'}}));console.log(JSON.stringify({type:'turn.completed'}));");
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "done token=[REDACTED]");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Same egress-proxy root cause as agy (T5 canary, 2026-10-01): codex reaches
// the OpenAI API through the local Clash proxy, injected per-child only.
test("Codex runner injects the default egress proxy into the child environment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-env-"));
  try {
    const { runner, invocation } = await fakeCodex(
      directory,
      "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'proxy-ok'}}));console.log(JSON.stringify({type:'turn.completed'}));",
    );
    const run = await runner.run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(invocation().options.env.HTTPS_PROXY, DEFAULT_EGRESS_PROXY_URL);
    assert.equal(invocation().options.env.HTTP_PROXY, DEFAULT_EGRESS_PROXY_URL);
    assert.match(invocation().options.env.NO_PROXY, /127\.0\.0\.1/);
    const parentPath = process.env.Path ?? process.env.PATH;
    assert.equal(invocation().options.env.Path ?? invocation().options.env.PATH, parentPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CODEX_PROXY_URL overrides the default; 'direct' disables the injection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-codex-env2-"));
  try {
    const script = path.join(directory, "fake-codex.js");
    await writeFile(
      script,
      "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}));console.log(JSON.stringify({type:'turn.completed'}));",
      "utf8",
    );
    const seen = [];
    const makeRunner = (environment) => new CodexRunner({
      environment,
      spawn(executable, args, options) {
        seen.push(options);
        return spawnChild(process.execPath, [script, ...args], options);
      },
    });
    const overridden = await makeRunner({ CODEX_PROXY_URL: "http://127.0.0.1:9999" })
      .run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(overridden.status, "COMPLETED", overridden.error);
    assert.equal(seen[0].env.HTTPS_PROXY, "http://127.0.0.1:9999");

    const direct = await makeRunner({ CODEX_PROXY_URL: "direct" })
      .run({ cwd: directory, model: "gpt-6-sol", effort: "high", task: "read" });
    assert.equal(direct.status, "COMPLETED", direct.error);
    assert.equal(seen[1].env.HTTPS_PROXY, process.env.HTTPS_PROXY);
    assert.equal(seen[1].env.NO_PROXY, process.env.NO_PROXY);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
