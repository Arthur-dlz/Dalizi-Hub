import { spawn as spawnChild } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { egressProxyEnv } from "./egress-proxy.js";
import { StreamJsonDecoder } from "./stream-json.js";
import { UsageAggregator } from "./usage.js";

const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
const EVENT_SCHEMA_VERSION = 1;
const AGENT_NAME = "codex";
const ACTUAL_MODEL_UNOBSERVABLE = "NOT_OBSERVABLE";
const PATH_FALLBACK = "codex";

// Codex turn.completed.usage -> canonical metrics. Candidate source paths are
// tried in order; the first finite non-negative hit wins and is recorded as the
// metric's source_field. A miss is stored as null + unavailable_reason, because
// absent is not zero. codex-cli 0.158 reported no cache-write field, but a real
// 0.159.2 sample (T5 canary probe, 2026-10-01) shows turn.completed.usage
// carrying cache_write_input_tokens, so that path is covered too.
const USAGE_FIELD_MAP = [
  { name: "input_tokens", paths: ["input_tokens"], unit: "tokens" },
  { name: "output_tokens", paths: ["output_tokens"], unit: "tokens" },
  { name: "total_tokens", paths: ["total_tokens"], unit: "tokens" },
  { name: "cache_read_tokens", paths: ["cached_input_tokens", "cache_read_input_tokens"], unit: "tokens" },
  { name: "cache_write_tokens", paths: ["cache_write_tokens", "cache_creation_input_tokens", "cache_write_input_tokens"], unit: "tokens" },
  { name: "reasoning_tokens", paths: ["reasoning_output_tokens", "reasoning_tokens"], unit: "tokens" },
];

// Inclusion semantics declared for the installed Codex version
// (codex-cli 0.158.0-alpha.2.1, Responses-style usage): cached_input_tokens is a
// subset of input_tokens and reasoning_output_tokens is a subset of
// output_tokens, so a derived total is input_tokens + output_tokens only. A
// provider-reported total_tokens always wins. Pending real-sample calibration.
export const CODEX_USAGE_INCLUSION = { input_includes_cache: true, output_includes_reasoning: true };

// Codex item types that represent observable tool work; any other item that is
// neither a message nor an internal reasoning step is surfaced as a neutral
// step label rather than a guessed tool name.
const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "web_search",
  "file_change",
  "patch_apply",
  "local_shell_call",
  "tool_call",
  "function_call",
]);

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

// Maps one Codex usage dict onto canonical metrics. Every canonical name yields
// an entry: a hit is reported with the concrete source_field it was found at; a
// miss is stored as null + unavailable_reason (absent is not zero).
function mapUsageDict(usage, { scope, prefix }) {
  const mapped = {};
  for (const { name, paths, unit } of USAGE_FIELD_MAP) {
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
      mapped[name] = { value: hit, unit, scope, source_field: `${prefix}.${hitPath}`, quality: "reported" };
    } else {
      mapped[name] = { value: null, unit, scope, source_field: `${prefix}.${paths[0]}`, quality: "unavailable", unavailable_reason: "source_field_absent" };
    }
  }
  return mapped;
}

// Trusted absolute path override wins; otherwise PATH fallback. A candidate that
// is present but not an absolute existing file fails closed (never silently
// falls back to PATH).
function resolveExecutable(executable, environment) {
  const candidate = executable === undefined ? environment.CODEX_CLI_PATH : executable;
  if (candidate === undefined) return PATH_FALLBACK;
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new Error("invalid Codex CLI path");
  try {
    const resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile()) throw new Error("not a file");
    return resolved;
  } catch {
    throw new Error("invalid Codex CLI path");
  }
}

function redact(value) {
  return String(value)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|credential)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function safeLaunchErrorCode(code) {
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "UNKNOWN";
}

// Folds a stream of parsed Codex --json events into the run summary state. Codex
// differs from the WB stream: its protocol terminal is turn.completed (not a
// result subtype), so this is a Codex-specific interpreter over the shared
// incremental decoder rather than the WB RunInterpreter.
class CodexInterpreter {
  constructor() {
    this.eventTypes = new Set();
    this.actualModel = ACTUAL_MODEL_UNOBSERVABLE;
    this.sessionId = null;
    this.finalText = null;
    this.completed = false;
    this.failure = null;
    this.protocolError = false;
  }

  observe(event) {
    if (!isPlainObject(event) || typeof event.type !== "string" || !event.type.trim()) {
      this.protocolError = true;
      return;
    }
    this.eventTypes.add(event.type);
    if (typeof event.session_id === "string" && event.session_id.trim()) this.sessionId = event.session_id.trim();
    if (event.type === "thread.started") {
      this.sessionId = firstString(event.thread_id, event.session_id) ?? this.sessionId;
    }
    if (typeof event.model === "string" && event.model.trim()) this.actualModel = event.model.trim();
    if (typeof event.actual_model === "string" && event.actual_model.trim()) this.actualModel = event.actual_model.trim();
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      this.finalText = event.item.text.trim() || this.finalText;
    }
    if (event.type === "turn.completed") this.completed = true;
    if (event.type === "turn.failed" || event.type === "error") {
      this.failure = firstString(event.error?.message, event.message, event.error) ?? "terminal failure";
    }
  }

  noteMalformed() {
    this.protocolError = true;
  }
}

// Codex verdict: COMPLETED requires the turn.completed protocol terminal, a
// zero process exit and a persisted result. A non-zero exit conflicting with a
// reported success is a failure with diagnostics; conflicts never report
// success. Field set mirrors the V0 codex verdict so downstream consumers keep
// working.
function codexVerdict(interpreter, { stderr, exitCode }) {
  const diagnostics = {
    process_exit_code: exitCode,
    stderr_present: Boolean(String(stderr ?? "").trim()),
    event_types: [...interpreter.eventTypes],
    error_category: null,
  };
  const result = (status, finalText, error) => ({
    status,
    finalText,
    error,
    actualModel: interpreter.actualModel,
    diagnostics,
  });

  if (interpreter.protocolError) return result("FAILED", null, "codex_protocol_error");

  const failureText = `${interpreter.failure ?? ""} ${stderr ?? ""}`;
  const modelFailure = Boolean(interpreter.failure || exitCode !== 0) && /(?:model|unsupported|not found|unavailable)/i.test(failureText);
  if (modelFailure) diagnostics.error_category = "model_failure";
  else if (interpreter.failure) diagnostics.error_category = "terminal_failure";

  if (interpreter.failure || exitCode !== 0) {
    const error = modelFailure ? "codex_model_error" : interpreter.failure ? "codex_terminal_error" : `codex_process_exit_${exitCode}`;
    return result("FAILED", null, error);
  }
  if (!interpreter.completed || !interpreter.finalText) return result("FAILED", null, "codex_missing_terminal_result");
  return result("COMPLETED", redact(interpreter.finalText), null);
}

// Activity observations come from explicit Codex item events only. Message text
// and internal reasoning items are not surfaced (no fabricated "thinking" or
// progress); an unknown item type becomes a neutral "step" rather than a guessed
// tool name.
function activityForEvent(event) {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return null;
  const item = event.item;
  if (!isPlainObject(item) || typeof item.type !== "string" || !item.type.trim()) return null;
  if (item.type === "agent_message" || item.type === "reasoning") return null;
  return {
    kind: TOOL_ITEM_TYPES.has(item.type) ? "tool_use" : "step",
    label: firstString(item.name, item.tool, item.tool_name, item.command, item.query, item.type),
    state: event.type === "item.completed" ? "completed" : "running",
  };
}

export class CodexRunner {
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
    const aggregator = new UsageAggregator({ inclusion: CODEX_USAGE_INCLUSION });
    const interpreter = new CodexInterpreter();
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
      error: "codex_launch_error",
      actualModel: ACTUAL_MODEL_UNOBSERVABLE,
      diagnostics: { process_exit_code: null, launch_error_code: safeLaunchErrorCode(code) },
      usage: aggregator.snapshot(),
      emit_errors: emitErrors,
    });

    if (this.executableError) {
      emitEvent("error", { kind: "codex_launch_error", message: "codex_launch_error" });
      return launchFailureResult("INVALID_CODEX_CLI_PATH");
    }

    const observeEvent = (event) => {
      interpreter.observe(event);
      if (interpreter.sessionId) sessionId = interpreter.sessionId;

      // turn.completed.usage is the authoritative terminal usage for the
      // invocation: it replaces the whole aggregation, so a replayed terminal
      // event never double counts.
      if (event.type === "turn.completed" && isPlainObject(event.usage)) {
        aggregator.applyResultUsage(mapUsageDict(event.usage, { scope: "session", prefix: "usage" }));
        emitEvent("usage", aggregator.snapshot(), event);
      }

      const activity = activityForEvent(event);
      if (activity) emitEvent("activity", activity, event);
    };
    const decoder = new StreamJsonDecoder({
      onEvent: observeEvent,
      onMalformed: () => interpreter.noteMalformed(),
    });

    // --skip-git-repo-check: the dispatcher's own registry + workspace-roots
    // are the trust arbitration layer (approved project dirs need not be git
    // repos); codex's git-repo trust check duplicates and conflicts with it.
    // codex 0.159.2 hard-fails without this flag outside a git repo (T5
    // canary, 2026-10-01).
    const args = ["exec", "-m", model, "-c", `model_reasoning_effort=${effort}`, "-C", cwd, "--json", "--skip-git-repo-check", task];
    let child;
    try {
      // Egress proxy scoped to this child only (egress-proxy.js header):
      // codex reaches the OpenAI API via the local Clash proxy; override or
      // disable via CODEX_PROXY_URL.
      const env = { ...process.env, ...egressProxyEnv(this.environment, "CODEX_PROXY_URL") };
      child = this.spawn(this.executable, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    } catch (error) {
      emitEvent("error", { kind: "codex_launch_error", message: "codex_launch_error" });
      return launchFailureResult(error?.code);
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
    const pid = child.pid ?? null;

    if (startupError) {
      const error = `pid_persistence_error: ${startupError.message}`;
      emitEvent("error", { kind: "pid_persistence_error", message: error });
      return { pid, status: "FAILED", finalText: null, error, actualModel: ACTUAL_MODEL_UNOBSERVABLE, diagnostics: { process_exit_code: exitCode }, usage: aggregator.snapshot(), emit_errors: emitErrors };
    }
    if (outputExceeded) {
      emitEvent("error", { kind: "output_limit_exceeded", message: "output_limit_exceeded" });
      return { pid, status: "FAILED", finalText: null, error: "output_limit_exceeded", actualModel: ACTUAL_MODEL_UNOBSERVABLE, diagnostics: { process_exit_code: exitCode }, usage: aggregator.snapshot(), emit_errors: emitErrors };
    }
    if (spawnError) {
      emitEvent("error", { kind: "codex_launch_error", message: "codex_launch_error" });
      return launchFailureResult(spawnError.code);
    }

    decoder.flush();
    const verdict = codexVerdict(interpreter, { stderr: Buffer.concat(stderrChunks).toString("utf8"), exitCode });
    aggregator.deriveTotalTokens();
    aggregator.deriveThroughput();
    emitEvent("usage", aggregator.snapshot());
    if (verdict.status === "COMPLETED") {
      emitEvent("result", { final_text: verdict.finalText, actual_model: verdict.actualModel, usage: aggregator.snapshot() });
    } else {
      emitEvent("error", { kind: verdict.diagnostics?.error_category ?? "codex_error", message: verdict.error });
    }
    return { pid, ...verdict, usage: aggregator.snapshot(), emit_errors: emitErrors };
  }
}
