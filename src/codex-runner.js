import { spawn as spawnChild } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;

function resolveExecutable(executable, environment) {
  const candidate = executable === undefined ? environment.CODEX_CLI_PATH : executable;
  if (candidate === undefined) return "codex";
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new Error("invalid Codex CLI path");
  try {
    const resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile()) throw new Error("not a file");
    return resolved;
  } catch {
    throw new Error("invalid Codex CLI path");
  }
}

function launchFailure(code) {
  const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "UNKNOWN";
  return { pid: null, status: "FAILED", finalText: null, error: "codex_launch_error", actualModel: "NOT_OBSERVABLE", diagnostics: { process_exit_code: null, launch_error_code: safeCode } };
}

function redact(value) {
  return String(value)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|credential)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function parseCodexRun({ stdout, stderr, exitCode }) {
  const eventTypes = new Set();
  let finalText = null;
  let actualModel = "NOT_OBSERVABLE";
  let completed = false;
  let failure = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { status: "FAILED", finalText: null, error: "codex_protocol_error", actualModel, diagnostics: { process_exit_code: exitCode, stderr_present: Boolean(stderr.trim()), event_types: [...eventTypes] } };
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      return { status: "FAILED", finalText: null, error: "codex_protocol_error", actualModel, diagnostics: { process_exit_code: exitCode, stderr_present: Boolean(stderr.trim()), event_types: [...eventTypes] } };
    }
    eventTypes.add(event.type);
    if (typeof event.model === "string" && event.model.trim()) actualModel = event.model;
    if (typeof event.actual_model === "string" && event.actual_model.trim()) actualModel = event.actual_model;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      finalText = event.item.text.trim() || finalText;
    }
    if (event.type === "turn.completed") completed = true;
    if (event.type === "turn.failed" || event.type === "error") failure = event.error?.message ?? event.message ?? "terminal failure";
  }
  const failureText = `${failure ?? ""} ${stderr}`;
  const modelFailure = Boolean(failure || exitCode !== 0) && /(?:model|unsupported|not found|unavailable)/i.test(failureText);
  const diagnostics = { process_exit_code: exitCode, stderr_present: Boolean(stderr.trim()), event_types: [...eventTypes], error_category: modelFailure ? "model_failure" : failure ? "terminal_failure" : null };
  if (failure || exitCode !== 0) {
    const error = modelFailure ? "codex_model_error" : failure ? "codex_terminal_error" : `codex_process_exit_${exitCode}`;
    return { status: "FAILED", finalText: null, error, actualModel, diagnostics };
  }
  if (!completed || !finalText) return { status: "FAILED", finalText: null, error: "codex_missing_terminal_result", actualModel, diagnostics };
  return { status: "COMPLETED", finalText: redact(finalText), error: null, actualModel, diagnostics };
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
  }

  async run({ cwd, model, effort, task, onStarted }) {
    if (this.executableError) return launchFailure("INVALID_CODEX_CLI_PATH");
    const args = ["exec", "-m", model, "-c", `model_reasoning_effort=${effort}`, "-C", cwd, "--json", task];
    let child;
    try {
      child = this.spawn(this.executable, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return launchFailure(error?.code);
    }

    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let outputExceeded = false;
    let launchError = null;
    const append = (target, chunk) => {
      if (outputExceeded) return;
      capturedBytes += Buffer.byteLength(chunk, "utf8");
      if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const exit = new Promise((resolve) => {
      child.once("error", (error) => { launchError = error; });
      child.once("close", (code) => resolve(Number.isInteger(code) ? code : 1));
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
    if (startupError) return { pid, status: "FAILED", finalText: null, error: "pid_persistence_error", actualModel: "NOT_OBSERVABLE", diagnostics: { process_exit_code: exitCode } };
    if (outputExceeded) return { pid, status: "FAILED", finalText: null, error: "output_limit_exceeded", actualModel: "NOT_OBSERVABLE", diagnostics: { process_exit_code: exitCode } };
    if (launchError) return launchFailure(launchError.code);
    return { pid, ...parseCodexRun({ stdout, stderr, exitCode }) };
  }
}
