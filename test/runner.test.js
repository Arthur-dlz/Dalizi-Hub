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

test("incremental decoding survives a multi-byte UTF-8 character split across chunks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, [
      "const payload = JSON.stringify({type:'result',subtype:'success',is_error:false,result:'任务完成✓'}) + '\\n';",
      "const bytes = Buffer.from(payload, 'utf8');",
      "let splitAt = -1;",
      "for (let i = 0; i < bytes.length; i++) { if (bytes[i] >= 0x80) { splitAt = i + 1; break; } }",
      "process.stdout.write(bytes.subarray(0, splitAt));",
      "process.stdout.write(bytes.subarray(splitAt));",
    ].join("\n"), "utf8");
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({ cwd: directory, model: "custom-local:step-5-preview", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "任务完成✓");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("incremental decoding handles half lines, multi-line chunks and a missing trailing newline", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, [
      "const assistant = JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'partial line'}]}});",
      "const result = JSON.stringify({type:'result',subtype:'success',is_error:false,result:'split-ok'});",
      "const half = assistant.slice(0, Math.floor(assistant.length / 2));",
      "process.stdout.write(half);",
      "setTimeout(() => { process.stdout.write(assistant.slice(half.length) + '\\n' + result); }, 60);",
    ].join("\n"), "utf8");
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({ cwd: directory, model: "custom-local:step-5-preview", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "split-ok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed stream line fails the run as a protocol error and emits the terminal error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, [
      "process.stdout.write('not-json\\n');",
      "process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}) + '\\n');",
    ].join("\n"), "utf8");
    const events = [];
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({
      cwd: directory,
      model: "custom-local:step-5-preview",
      effort: "high",
      task: "read",
      emit: (envelope) => { events.push(envelope); },
    });
    assert.equal(run.status, "FAILED");
    assert.equal(run.error, "stream_json_protocol_error");
    assert.equal(events[0].kind, "started");
    const terminal = events[events.length - 1];
    assert.equal(terminal.kind, "error");
    assert.equal(terminal.payload.kind, "stream_json_protocol");
    assert.equal(terminal.payload.message, "stream_json_protocol_error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a protocol success wins over a non-zero exit code and the result event still carries the final text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, [
      "process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'conflict-ok'}) + '\\n');",
      "process.exitCode = 1;",
    ].join("\n"), "utf8");
    const events = [];
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({
      cwd: directory,
      model: "custom-local:step-5-preview",
      effort: "high",
      task: "read",
      emit: (envelope) => { events.push(envelope); },
    });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "conflict-ok");
    assert.equal(run.diagnostics.process_exit_code, 1);
    const terminal = events[events.length - 1];
    assert.equal(terminal.kind, "result");
    assert.equal(terminal.payload.final_text, "conflict-ok");
    assert.equal(terminal.payload.actual_model, "NOT_OBSERVABLE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("without emit the run stays V0-equivalent, diagnostics field-for-field", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, [
      "const lines = [",
      "  JSON.stringify({type:'assistant',model:'custom-local:step-5-preview',message:{content:[{type:'text'},{type:'tool_use',name:'read_file'}]}}),",
      "  JSON.stringify({type:'result',subtype:'success',is_error:false,result:'v0-ok'}),",
      "];",
      "process.stdout.write(lines.join('\\n') + '\\n');",
    ].join("\n"), "utf8");
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({ cwd: directory, model: "custom-local:step-5-preview", effort: "high", task: "read" });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "v0-ok");
    assert.equal(run.actualModel, "custom-local:step-5-preview");
    assert.deepEqual(run.diagnostics, {
      process_exit_code: 0,
      stderr_present: false,
      event_types: ["assistant", "result"],
      terminal_result_seen: true,
      terminal_subtype: "success",
      terminal_is_error: false,
      result_field_present: true,
      errors_present: false,
      errors_info_present: false,
      assistant_content_block_types: ["text", "tool_use"],
      error_event_keys: [],
      error_category: null,
      safe_error_summary: null,
    });
    assert.equal(run.emit_errors, 0);
    assert.equal(run.usage.schema_version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a throwing emit side channel never changes the run outcome and is counted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, "process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'emit-proof'}) + '\\n');", "utf8");
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({
      cwd: directory,
      model: "custom-local:step-5-preview",
      effort: "high",
      task: "read",
      emit: () => { throw new Error("emit boom"); },
    });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "emit-proof");
    assert.ok(run.emit_errors > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emit receives started, activity, usage and terminal result events with usage replaced by the result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, [
      "const lines = [",
      "  JSON.stringify({type:'system',subtype:'init',session_id:'sess-123'}),",
      "  JSON.stringify({type:'tool_use',name:'web_search',status:'running'}),",
      "  JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'read_file'}]}}),",
      "  JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'working'}],usage:{input_tokens:40,output_tokens:10}}}),",
      "  JSON.stringify({type:'usage_update',usage_update:{input_tokens:60,output_tokens:20}}),",
      "  JSON.stringify({type:'result',subtype:'success',is_error:false,result:'flow-ok',usage:{input_tokens:100,output_tokens:50,total_tokens:150,duration_ms:1000,num_turns:2,total_cost_usd:0.01}}),",
      "];",
      "process.stdout.write(lines.join('\\n') + '\\n');",
    ].join("\n"), "utf8");
    const events = [];
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({
      cwd: directory,
      model: "custom-local:step-5-preview",
      effort: "high",
      task: "read",
      emit: (envelope) => { events.push(envelope); },
    });
    assert.equal(run.status, "COMPLETED", run.error);

    const started = events[0];
    assert.equal(started.kind, "started");
    assert.equal(started.payload.pid, run.pid);
    assert.deepEqual(Object.keys(started.source).sort(), ["agent", "cli_version", "event_id", "session_id"]);
    assert.equal(started.source.agent, "workbuddy");
    assert.equal(started.source.cli_version, null);
    assert.equal(started.source.session_id, null);

    const activities = events.filter((event) => event.kind === "activity");
    assert.deepEqual(activities.map((event) => event.payload), [
      { kind: "tool_use", label: "web_search", state: "running" },
      { kind: "tool_use", label: "read_file", state: null },
    ]);
    assert.ok(activities.every((event) => event.source.session_id === "sess-123"));

    const usageEvents = events.filter((event) => event.kind === "usage");
    assert.equal(usageEvents.length, 4);
    assert.equal(usageEvents[0].payload.metrics.input_tokens.value, 40);
    assert.equal(usageEvents[0].payload.metrics.input_tokens.scope, "turn");
    assert.equal(usageEvents[1].payload.metrics.input_tokens.value, 60, "a turn snapshot replaces, never adds");
    const finalUsage = usageEvents[3].payload.metrics;
    assert.equal(finalUsage.input_tokens.value, 100, "result usage replaces the temporary aggregate");
    assert.equal(finalUsage.total_tokens.value, 150);
    assert.equal(finalUsage.total_tokens.quality, "reported");
    assert.equal(finalUsage.num_turns.value, 2);
    assert.equal(finalUsage.total_cost_usd.value, 0.01);
    assert.equal(finalUsage.job_output_tokens_per_second.value, 50);
    assert.equal(finalUsage.job_output_tokens_per_second.quality, "derived");

    const terminal = events[events.length - 1];
    assert.equal(terminal.kind, "result");
    assert.equal(terminal.payload.final_text, "flow-ok");
    assert.equal(terminal.payload.usage.metrics.input_tokens.value, 100);
    assert.equal(terminal.source.session_id, "sess-123");
    for (const event of events) {
      assert.equal(event.schema_version, 1);
      assert.match(event.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a silent run without tool_use events never fabricates activity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, [
      "process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'quietly thinking'}]}}) + '\\n');",
      "setTimeout(() => { process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'quiet-ok'}) + '\\n'); }, 80);",
    ].join("\n"), "utf8");
    const events = [];
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({
      cwd: directory,
      model: "custom-local:step-5-preview",
      effort: "high",
      task: "read",
      emit: (envelope) => { events.push(envelope); },
    });
    assert.equal(run.status, "COMPLETED", run.error);
    assert.equal(run.finalText, "quiet-ok");
    assert.deepEqual(events.map((event) => event.kind), ["started", "usage", "result"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an early pid persistence failure still emits started and the terminal error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-runner-"));
  try {
    const script = path.join(directory, "fake-codebuddy.js");
    await writeFile(script, "process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'never'}) + '\\n');", "utf8");
    const events = [];
    const run = await new WorkBuddyRunner({ codebuddyScript: script }).run({
      cwd: directory,
      model: "custom-local:step-5-preview",
      effort: "high",
      task: "read",
      emit: (envelope) => { events.push(envelope); },
      onStarted: async () => { throw new Error("disk full"); },
    });
    assert.equal(run.status, "FAILED");
    assert.match(run.error, /pid_persistence_error: disk full/);
    assert.equal(events[0].kind, "started");
    assert.equal(events[events.length - 1].kind, "error");
    assert.equal(events[events.length - 1].payload.kind, "pid_persistence_error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
