import { spawn as spawnChild } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { egressProxyEnv } from "./egress-proxy.js";
import { StreamJsonDecoder } from "./stream-json.js";
import { UsageAggregator } from "./usage.js";

const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
const EVENT_SCHEMA_VERSION = 1;
const AGENT_NAME = "antigravity";
const ACTUAL_MODEL_UNOBSERVABLE = "NOT_OBSERVABLE";
const PATH_FALLBACK = "agy";

// AGY usage field mapping (Antigravity CLI 1.2.14, live headless stream samples
// 2026-09-30). agy names the reasoning field "thinking_tokens"; live-sample
// arithmetic shows total_tokens = input_tokens + output_tokens while
// thinking_tokens > 0, so reasoning is a subset of output
// (output_includes_reasoning: true). Whether input_tokens includes
// cache_read_tokens has no sample evidence, so that inclusion flag stays
// undeclared (null) — unproven is not declared. cache_write has no observed
// field and stays unavailable. agy always reports total_tokens, so the derived
// total never overrides the provider value.
const USAGE_FIELD_MAP = [
  { name: "input_tokens", paths: ["input_tokens"], unit: "tokens" },
  { name: "output_tokens", paths: ["output_tokens"], unit: "tokens" },
  { name: "total_tokens", paths: ["total_tokens"], unit: "tokens" },
  { name: "cache_read_tokens", paths: ["cache_read_tokens"], unit: "tokens" },
  { name: "cache_write_tokens", paths: ["cache_write_tokens"], unit: "tokens" },
  { name: "reasoning_tokens", paths: ["thinking_tokens", "reasoning_tokens"], unit: "tokens" },
  { name: "wall_duration_ms", paths: ["duration_seconds"], unit: "ms", scale: 1000 },
  { name: "num_turns", paths: ["num_turns"], unit: "turns" },
  { name: "total_cost_usd", paths: ["total_cost_usd"], unit: "usd" },
];

// Inclusion semantics declared for the installed agy version (1.2.14).
export const ANTIGRAVITY_USAGE_INCLUSION = { input_includes_cache: null, output_includes_reasoning: true };

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPath(source, dottedPath) {
  let node = source;
  for (const key of dottedPath.split(".")) {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

function isCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// Maps one AGY usage dict onto canonical metrics. Every canonical name yields
// an entry: a hit is reported with the concrete source_field it was found at; a
// miss is stored as null + unavailable_reason (absent is not zero). `scale`
// converts a source unit (agy reports duration in seconds) to the canonical
// unit (ms).
function mapUsageDict(usage, { scope, prefix }) {
  const mapped = {};
  for (const { name, paths, unit, scale } of USAGE_FIELD_MAP) {
    let hit = null;
    let hitPath = null;
    for (const candidatePath of paths) {
      const candidate = readPath(usage, candidatePath);
      if (isCount(candidate)) {
        hit = candidate;
        hitPath = candidatePath;
        break;
      }
    }
    if (hit !== null) {
      const value = scale === undefined ? hit : hit * scale;
      mapped[name] = { value, unit, scope, source_field: `${prefix}.${hitPath}`, quality: "reported" };
    } else {
      mapped[name] = { value: null, unit, scope, source_field: `${prefix}.${paths[0]}`, quality: "unavailable", unavailable_reason: "source_field_absent" };
    }
  }
  return mapped;
}

// Trusted absolute path override wins; otherwise the Windows default install
// location; otherwise PATH fallback. A candidate that is present but not an
// absolute existing file fails closed (never silently falls back).
function resolveExecutable(executable, environment) {
  const candidate = executable === undefined ? environment.ANTIGRAVITY_CLI_PATH : executable;
  if (candidate !== undefined) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new Error("invalid Antigravity CLI path");
    try {
      const resolved = realpathSync(candidate);
      if (!statSync(resolved).isFile()) throw new Error("not a file");
      return resolved;
    } catch {
      throw new Error("invalid Antigravity CLI path");
    }
  }
  if (environment.LOCALAPPDATA) {
    const defaultWin = path.join(environment.LOCALAPPDATA, "agy", "bin", "agy.exe");
    try {
      if (statSync(defaultWin).isFile()) return defaultWin;
    } catch {}
  }
  return PATH_FALLBACK;
}

function redact(value) {
  return String(value)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|credential)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function safeLaunchErrorCode(code) {
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "UNKNOWN";
}

// Folds a stream of parsed AGY events into the run summary state. AGY's
// protocol terminal is a result event with status SUCCESS/ERROR (not the WB
// result subtype), so this is an AGY-specific interpreter over the shared
// incremental decoder. Verdict precedence mirrors the V0 whole-output parser:
// protocol error -> terminal/exit failure (auth/model/terminal/exit cascade) ->
// missing terminal result -> COMPLETED.
class AntigravityInterpreter {
  constructor() {
    this.eventTypes = new Set();
    this.stepTypes = new Set();
    this.actualModel = ACTUAL_MODEL_UNOBSERVABLE;
    this.conversationId = null;
    this.tokenUsage = null;
    this.finalText = null;
    this.completed = false;
    this.failure = null;
    this.protocolError = false;
  }

  observe(event) {
    // V0 stops at the first malformed line; once protocolError is set, later
    // events must not influence the verdict or diagnostics.
    if (this.protocolError) return;
    if (!isPlainObject(event) || typeof event.event !== "string" || !event.event.trim()) {
      this.protocolError = true;
      return;
    }
    this.eventTypes.add(event.event);
    if (typeof event.conversation_id === "string" && event.conversation_id.trim()) {
      this.conversationId = event.conversation_id.trim();
    }

    if (event.event === "init") {
      if (typeof event.init?.model === "string" && event.init.model.trim()) {
        this.actualModel = event.init.model.trim();
      }
    } else if (event.event === "step_update") {
      const stepUpdate = event.step_update;
      if (isPlainObject(stepUpdate)) {
        if (typeof stepUpdate.step_type === "string" && stepUpdate.step_type.trim()) {
          this.stepTypes.add(stepUpdate.step_type);
        }
        if (isPlainObject(stepUpdate.usage)) this.tokenUsage = stepUpdate.usage;
      }
    } else if (event.event === "result") {
      const res = event.result;
      if (isPlainObject(res)) {
        if (typeof res.conversation_id === "string" && res.conversation_id.trim()) {
          this.conversationId = res.conversation_id.trim();
        }
        if (isPlainObject(res.usage)) this.tokenUsage = res.usage;
        if (typeof res.actual_model === "string" && res.actual_model.trim()) {
          this.actualModel = res.actual_model.trim();
        }
        if (res.status === "SUCCESS") {
          this.completed = true;
          if (typeof res.response === "string") this.finalText = res.response.trim();
        } else if (res.status === "ERROR") {
          this.failure = res.error || "terminal failure";
        }
      }
    }
  }

  noteMalformed() {
    this.protocolError = true;
  }
}

function antigravityVerdict(interpreter, { stderr, exitCode }) {
  const result = (status, finalText, error, errorCategory = null) => ({
    status,
    finalText,
    error,
    actualModel: interpreter.actualModel,
    diagnostics: {
      process_exit_code: exitCode,
      stderr_present: Boolean(String(stderr ?? "").trim()),
      event_types: [...interpreter.eventTypes],
      step_types: [...interpreter.stepTypes],
      conversation_id: interpreter.conversationId,
      token_usage: interpreter.tokenUsage,
      error_category: errorCategory,
    },
  });

  if (interpreter.protocolError) return result("FAILED", null, "antigravity_protocol_error");

  const combinedError = `${interpreter.failure ?? ""} ${stderr ?? ""}`;
  const authFailure = Boolean(interpreter.failure || exitCode !== 0) && /(?:auth|login|unauthori[sz]ed|forbidden|credential|permission denied)/i.test(combinedError);
  const modelFailure = Boolean(interpreter.failure || exitCode !== 0) && /(?:invalid.*model|model.*not recognized|unsupported model|model unavailable)/i.test(combinedError);

  if (interpreter.failure || exitCode !== 0) {
    if (authFailure) return result("FAILED", null, "antigravity_auth_error", "auth_failure");
    if (modelFailure) return result("FAILED", null, "antigravity_model_error", "model_failure");
    if (interpreter.failure) return result("FAILED", null, "antigravity_terminal_error", "terminal_failure");
    return result("FAILED", null, `antigravity_process_exit_${exitCode}`);
  }
  if (!interpreter.completed || !interpreter.finalText) {
    return result("FAILED", null, "antigravity_missing_terminal_result");
  }
  return result("COMPLETED", redact(interpreter.finalText), null);
}

export function parseAntigravityRun({ stdout, stderr, exitCode }) {
  const interpreter = new AntigravityInterpreter();
  const decoder = new StreamJsonDecoder({
    onEvent: (event) => interpreter.observe(event),
    onMalformed: () => interpreter.noteMalformed(),
  });
  decoder.push(String(stdout ?? ""));
  decoder.flush();
  return antigravityVerdict(interpreter, { stderr, exitCode });
}

// Activity observations come from AGY tool step_update events only. Message
// text, user input and internal reasoning steps are not surfaced (no fabricated
// progress); the tool step state maps to running/completed/failed.
function activityForStepUpdate(stepUpdate) {
  if (!isPlainObject(stepUpdate) || stepUpdate.step_type !== "tool") return null;
  const state =
    stepUpdate.state === "ACTIVE" ? "running" : stepUpdate.state === "DONE" ? "completed" : stepUpdate.state === "ERROR" ? "failed" : null;
  if (state === null) return null;
  return {
    kind: "tool_use",
    label: firstString(stepUpdate.tool_name) ?? "tool",
    state,
  };
}

export class AntigravityRunner {
  constructor({ executable, environment = process.env, spawn = spawnChild } = {}) {
    try {
      this.executable = resolveExecutable(executable, environment);
      this.executableError = null;
    } catch (error) {
      this.executable = null;
      this.executableError = error;
    }
    this.spawn = spawn;
    this.environment = environment;
  }

  async run({ cwd, model, effort, task, onStarted, emit }) {
    const aggregator = new UsageAggregator({ inclusion: ANTIGRAVITY_USAGE_INCLUSION });
    const interpreter = new AntigravityInterpreter();
    let emitErrors = 0;
    let sessionId = null;

    // Partial event envelope (IMPLEMENTATION §3.2 minus job_id and seq, which
    // belong to the dispatcher wiring layer). Emit is an observation side
    // channel: failures are counted, never fatal.
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

    const launchFailureResult = (code) => ({
      pid: null,
      status: "FAILED",
      finalText: null,
      error: "antigravity_launch_error",
      actualModel: ACTUAL_MODEL_UNOBSERVABLE,
      diagnostics: { process_exit_code: null, launch_error_code: safeLaunchErrorCode(code) },
      usage: aggregator.snapshot(),
      emit_errors: emitErrors,
    });

    if (this.executableError) {
      emitEvent("error", { kind: "antigravity_launch_error", message: "antigravity_launch_error" });
      return launchFailureResult("INVALID_ANTIGRAVITY_CLI_PATH");
    }

    const observeEvent = (event) => {
      interpreter.observe(event);
      if (interpreter.conversationId) sessionId = interpreter.conversationId;

      // result.usage is the authoritative terminal usage for the invocation:
      // it replaces the whole aggregation, so a replayed result event never
      // double counts. Per the task card, step_update usage is not aggregated.
      if (event.event === "result" && isPlainObject(event.result?.usage)) {
        aggregator.applyResultUsage(mapUsageDict(event.result.usage, { scope: "session", prefix: "result.usage" }));
        emitEvent("usage", aggregator.snapshot(), event);
      }

      const activity = event.event === "step_update" ? activityForStepUpdate(event.step_update) : null;
      if (activity) emitEvent("activity", activity, event);
    };
    const decoder = new StreamJsonDecoder({
      onEvent: observeEvent,
      onMalformed: () => interpreter.noteMalformed(),
    });

    // Permission policy per docs/impl/agy-permission-decision.md §4 (option C,
    // branch 1 verified live on agy 1.2.14 Windows headless 2026-09-30): no
    // --dangerously-skip-permissions; the fine-grained permission engine in
    // ~/.gemini/antigravity-cli/settings.json carries the directory whitelist,
    // and anything not allowed fails explicitly in headless mode.
    const args = ["-p", task, "--output-format", "stream-json", "--model", model, "--effort", effort];
    let child;
    try {
      // Egress proxy scoped to this child only (egress-proxy.js header): agy
      // reaches Google via the local Clash proxy; override/disable via
      // ANTIGRAVITY_PROXY_URL. Verified by the T5 canary probe 2026-10-01.
      const env = { ...process.env, ...egressProxyEnv(this.environment, "ANTIGRAVITY_PROXY_URL") };
      child = this.spawn(this.executable, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    } catch (error) {
      emitEvent("error", { kind: "antigravity_launch_error", message: "antigravity_launch_error" });
      return launchFailureResult(error?.code);
    }

    emitEvent("started", { pid: child.pid ?? null });

    const stderrChunks = [];
    let capturedBytes = 0;
    let outputExceeded = false;
    let spawnError = null;
    const track = (chunk) => {
      if (outputExceeded) return;
      capturedBytes += Buffer.byteLength(chunk, "utf8");
      if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
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

    let startupError = false;
    try {
      await onStarted?.(child.pid ?? null);
    } catch {
      startupError = true;
      child.kill();
    }
    const exitCode = await exit;
    const pid = child.pid ?? null;

    if (startupError) {
      emitEvent("error", { kind: "pid_persistence_error", message: "pid_persistence_error" });
      return { pid, status: "FAILED", finalText: null, error: "pid_persistence_error", actualModel: ACTUAL_MODEL_UNOBSERVABLE, diagnostics: { process_exit_code: exitCode }, usage: aggregator.snapshot(), emit_errors: emitErrors };
    }
    if (outputExceeded) {
      emitEvent("error", { kind: "output_limit_exceeded", message: "output_limit_exceeded" });
      return { pid, status: "FAILED", finalText: null, error: "output_limit_exceeded", actualModel: ACTUAL_MODEL_UNOBSERVABLE, diagnostics: { process_exit_code: exitCode }, usage: aggregator.snapshot(), emit_errors: emitErrors };
    }
    if (spawnError) {
      emitEvent("error", { kind: "antigravity_launch_error", message: "antigravity_launch_error" });
      return launchFailureResult(spawnError.code);
    }

    decoder.flush();
    const verdict = antigravityVerdict(interpreter, { stderr: stderrChunks.join(""), exitCode });
    aggregator.deriveTotalTokens();
    aggregator.deriveThroughput();
    emitEvent("usage", aggregator.snapshot());
    if (verdict.status === "COMPLETED") {
      emitEvent("result", { final_text: verdict.finalText, actual_model: verdict.actualModel, usage: aggregator.snapshot() });
    } else {
      emitEvent("error", { kind: verdict.diagnostics?.error_category ?? "antigravity_error", message: verdict.error });
    }
    return { pid, ...verdict, usage: aggregator.snapshot(), emit_errors: emitErrors };
  }
}
