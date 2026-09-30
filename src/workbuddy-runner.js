import { spawn as spawnChild } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { StreamJsonDecoder, RunInterpreter, finalizeRun } from "./stream-json.js";
import { UsageAggregator } from "./usage.js";

export const CODEBUDDY_SCRIPT = process.env.WORKBUDDY_CLI_PATH;
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
const EVENT_SCHEMA_VERSION = 1;
const AGENT_NAME = "workbuddy";

// WB usage field mapping (CodeBuddy 2.147.0, static evidence from the installed
// bundle; no live stream sample yet — flagged "pending real-sample calibration").
// Each canonical metric lists candidate source paths inside a usage dict; the
// first hit wins and is recorded as the metric's source_field.
const USAGE_FIELD_MAP = [
  { name: "input_tokens", paths: ["input_tokens"], unit: "tokens" },
  { name: "output_tokens", paths: ["output_tokens"], unit: "tokens" },
  { name: "total_tokens", paths: ["total_tokens"], unit: "tokens" },
  { name: "cache_read_tokens", paths: ["cache_read_input_tokens", "prompt_cache_hit_tokens"], unit: "tokens" },
  { name: "cache_write_tokens", paths: ["cache_creation_input_tokens", "prompt_cache_write_tokens"], unit: "tokens" },
  { name: "reasoning_tokens", paths: ["reasoning_tokens", "prompt_tokens_details.reasoning_tokens"], unit: "tokens" },
  { name: "wall_duration_ms", paths: ["duration_ms"], unit: "ms" },
  { name: "model_duration_ms", paths: ["duration_api_ms"], unit: "ms" },
  { name: "num_turns", paths: ["num_turns"], unit: "turns" },
  { name: "total_cost_usd", paths: ["total_cost_usd"], unit: "usd" },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPath(source, path) {
  let node = source;
  for (const key of path.split(".")) {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

function isCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Maps one WB usage dict onto canonical metrics. Every canonical name yields an
// entry: a hit is reported with the concrete source_field it was found at; a
// miss is stored as null + unavailable_reason (absent is not zero).
function mapUsageDict(usage, { scope, prefix }) {
  const mapped = {};
  for (const { name, paths, unit } of USAGE_FIELD_MAP) {
    let hit = null;
    let hitPath = null;
    for (const path of paths) {
      const candidate = readPath(usage, path);
      if (isCount(candidate)) {
        hit = candidate;
        hitPath = path;
        break;
      }
    }
    if (hit !== null) {
      mapped[name] = { value: hit, unit, scope, source_field: `${prefix}.${hitPath}`, quality: "reported" };
    } else {
      mapped[name] = { value: null, unit, scope, source_field: `${prefix}.${paths[0]}`, quality: "unavailable", unavailable_reason: "source_field_absent" };
    }
  }
  return mapped;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// Tool-use observations: standalone tool_use events, or tool_use blocks inside
// assistant message content. Unknown label shapes fall back to "tool_use"
// instead of guessing a tool name.
function toolUseObservations(event) {
  const observations = [];
  if (event.type === "tool_use") {
    observations.push({
      label: firstString(event.name, event.tool_name, event.tool_use?.name, event.tool?.name) ?? "tool_use",
      state: firstString(event.status),
    });
  } else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (!isPlainObject(block) || block.type !== "tool_use") continue;
      observations.push({
        label: firstString(block.name, block.tool_name, block.input?.name) ?? "tool_use",
        state: firstString(block.status),
      });
    }
  }
  return observations;
}

function resolveCodebuddyScript({ codebuddyScript, environment }) {
  const candidate = codebuddyScript ?? environment.WORKBUDDY_CLI_PATH;
  const source = codebuddyScript === undefined ? "WORKBUDDY_CLI_PATH" : "codebuddyScript";
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(`${source} must reference an existing file`);
  }
  try {
    const resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile()) throw new Error("not a file");
    return resolved;
  } catch {
    throw new Error(`${source} must reference an existing file`);
  }
}

export class WorkBuddyRunner {
  constructor({ codebuddyScript, environment = process.env, nodeExecutable = process.execPath, spawn = spawnChild } = {}) {
    try {
      this.codebuddyScript = resolveCodebuddyScript({ codebuddyScript, environment });
      this.codebuddyScriptError = null;
    } catch (error) {
      this.codebuddyScript = null;
      this.codebuddyScriptError = error;
    }
    this.nodeExecutable = nodeExecutable;
    this.spawn = spawn;
  }

  async run({ cwd, model, effort, task, onStarted, emit }) {
    const aggregator = new UsageAggregator({ inclusion: { input_includes_cache: null, output_includes_reasoning: null } });
    let emitErrors = 0;
    let sessionId = null;

    // Emits a partial event envelope (IMPLEMENTATION.md §3.2 minus job_id and
    // seq, which belong to the dispatcher wiring layer). Emit is an
    // observation side channel: failures are counted, never fatal.
    const emitEvent = (kind, payload, event = null) => {
      if (typeof emit !== "function") return;
      const envelope = {
        schema_version: EVENT_SCHEMA_VERSION,
        observed_at: new Date().toISOString(),
        source: {
          agent: AGENT_NAME,
          cli_version: null,
          session_id: sessionId,
          event_id: firstString(event?.id, event?.event_id),
        },
        kind,
        payload,
      };
      try {
        const returned = emit(envelope);
        if (returned && typeof returned.catch === "function") returned.catch(() => { emitErrors += 1; });
      } catch {
        emitErrors += 1;
      }
    };

    if (this.codebuddyScriptError) {
      const error = `codebuddy_path_error: ${this.codebuddyScriptError.message}`;
      emitEvent("error", { kind: "codebuddy_path_error", message: error });
      return { pid: null, status: "FAILED", finalText: null, error, actualModel: "NOT_OBSERVABLE", usage: aggregator.snapshot(), emit_errors: emitErrors };
    }

    const interpreter = new RunInterpreter();
    const observeEvent = (event) => {
      interpreter.observe(event);
      if (typeof event.session_id === "string" && event.session_id) sessionId = event.session_id;

      let usageObserved = false;
      if (event.type === "result" && isPlainObject(event.usage)) {
        aggregator.applyResultUsage(mapUsageDict(event.usage, { scope: "session", prefix: "usage" }));
        usageObserved = true;
      } else {
        const snapshotSources = [
          [event.usage, "usage"],
          [event.message?.usage, "message.usage"],
          [event.usage_update, "usage_update"],
        ];
        for (const [dict, prefix] of snapshotSources) {
          if (!isPlainObject(dict)) continue;
          const mapped = mapUsageDict(dict, { scope: "turn", prefix });
          for (const [name, fields] of Object.entries(mapped)) aggregator.applySnapshot(name, fields);
          usageObserved = true;
        }
      }
      for (const [key, dict] of [["custom_model_usage", event.custom_model_usage], ["section_usage", event.section_usage]]) {
        if (!isPlainObject(dict)) continue;
        aggregator.setBackgroundUsage(mapUsageDict(dict, { scope: "session", prefix: key }), { source_field: key });
        usageObserved = true;
      }
      if (usageObserved) emitEvent("usage", aggregator.snapshot(), event);

      for (const observation of toolUseObservations(event)) {
        emitEvent("activity", { kind: "tool_use", label: observation.label, state: observation.state }, event);
      }
    };
    const decoder = new StreamJsonDecoder({
      onEvent: observeEvent,
      onMalformed: () => interpreter.noteMalformed(),
    });

    const args = [this.codebuddyScript, "-p", "--output-format", "stream-json", "--model", model, "--effort", effort, task];
    let child;
    try {
      child = this.spawn(this.nodeExecutable, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const message = `spawn_error: ${error.message}`;
      emitEvent("error", { kind: "spawn_error", message });
      return { pid: null, status: "FAILED", finalText: null, error: message, actualModel: "NOT_OBSERVABLE", usage: aggregator.snapshot(), emit_errors: emitErrors };
    }

    emitEvent("started", { pid: child.pid ?? null });

    const stderrChunks = [];
    let capturedBytes = 0;
    let outputExceeded = false;
    let spawnError = null;
    const track = (chunk) => {
      if (outputExceeded) return;
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
    };
    child.stdout.on("data", (chunk) => {
      track(chunk);
      if (!outputExceeded) decoder.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      track(chunk);
      if (!outputExceeded) stderrChunks.push(chunk);
    });
    const exit = new Promise((resolve) => {
      let settled = false;
      const finish = (code) => {
        if (!settled) {
          settled = true;
          resolve(Number.isInteger(code) ? code : 1);
        }
      };
      child.once("error", (error) => {
        spawnError = error;
        finish(1);
      });
      child.once("close", finish);
    });

    let startupError = null;
    try {
      await onStarted?.(child.pid ?? null);
    } catch (error) {
      startupError = error;
      child.kill();
    }
    const exitCode = await exit;

    if (startupError) {
      const error = `pid_persistence_error: ${startupError.message}`;
      emitEvent("error", { kind: "pid_persistence_error", message: error });
      return { pid: child.pid ?? null, status: "FAILED", finalText: null, error, actualModel: "NOT_OBSERVABLE", usage: aggregator.snapshot(), emit_errors: emitErrors };
    }
    if (outputExceeded) {
      emitEvent("error", { kind: "output_limit_exceeded", message: "output_limit_exceeded" });
      return { pid: child.pid ?? null, status: "FAILED", finalText: null, error: "output_limit_exceeded", actualModel: "NOT_OBSERVABLE", usage: aggregator.snapshot(), emit_errors: emitErrors };
    }
    if (spawnError) {
      const error = `spawn_error: ${spawnError.message}`;
      emitEvent("error", { kind: "spawn_error", message: error });
      return { pid: child.pid ?? null, status: "FAILED", finalText: null, error, actualModel: "NOT_OBSERVABLE", usage: aggregator.snapshot(), emit_errors: emitErrors };
    }

    decoder.flush();
    const verdict = finalizeRun(interpreter, { stderr: Buffer.concat(stderrChunks).toString("utf8"), exitCode });
    aggregator.deriveTotalTokens();
    aggregator.deriveThroughput();
    emitEvent("usage", aggregator.snapshot());
    if (verdict.status === "COMPLETED") {
      emitEvent("result", { final_text: verdict.finalText, actual_model: verdict.actualModel, usage: aggregator.snapshot() });
    } else {
      emitEvent("error", { kind: verdict.diagnostics?.error_category ?? "runner_error", message: verdict.error });
    }
    return { pid: child.pid ?? null, ...verdict, usage: aggregator.snapshot(), emit_errors: emitErrors };
  }
}
