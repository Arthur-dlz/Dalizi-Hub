import { spawn as spawnChild } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;

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
  return "agy";
}

function launchFailure(code) {
  const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "UNKNOWN";
  return {
    pid: null,
    status: "FAILED",
    finalText: null,
    error: "antigravity_launch_error",
    actualModel: "NOT_OBSERVABLE",
    diagnostics: { process_exit_code: null, launch_error_code: safeCode },
  };
}

function redact(value) {
  return String(value)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|credential)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export function parseAntigravityRun({ stdout, stderr, exitCode }) {
  const eventTypes = new Set();
  const stepTypes = new Set();
  let finalText = null;
  let actualModel = "NOT_OBSERVABLE";
  let completed = false;
  let failure = null;
  let conversationId = null;
  let tokenUsage = null;

  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return {
        status: "FAILED",
        finalText: null,
        error: "antigravity_protocol_error",
        actualModel,
        diagnostics: {
          process_exit_code: exitCode,
          stderr_present: Boolean(String(stderr ?? "").trim()),
          event_types: [...eventTypes],
        },
      };
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.event !== "string") {
      return {
        status: "FAILED",
        finalText: null,
        error: "antigravity_protocol_error",
        actualModel,
        diagnostics: {
          process_exit_code: exitCode,
          stderr_present: Boolean(String(stderr ?? "").trim()),
          event_types: [...eventTypes],
        },
      };
    }
    eventTypes.add(event.event);
    if (typeof event.conversation_id === "string" && event.conversation_id.trim()) {
      conversationId = event.conversation_id.trim();
    }

    if (event.event === "init") {
      if (typeof event.init?.model === "string" && event.init.model.trim()) {
        actualModel = event.init.model.trim();
      }
    } else if (event.event === "step_update") {
      if (typeof event.step_update?.step_type === "string") {
        stepTypes.add(event.step_update.step_type);
      }
      if (event.step_update?.usage && typeof event.step_update.usage === "object") {
        tokenUsage = event.step_update.usage;
      }
    } else if (event.event === "result") {
      const res = event.result;
      if (typeof res?.conversation_id === "string" && res.conversation_id.trim()) {
        conversationId = res.conversation_id.trim();
      }
      if (res?.usage && typeof res.usage === "object") {
        tokenUsage = res.usage;
      }
      if (typeof res?.actual_model === "string" && res.actual_model.trim()) {
        actualModel = res.actual_model.trim();
      }
      if (res?.status === "SUCCESS") {
        completed = true;
        if (typeof res.response === "string") {
          finalText = res.response.trim();
        }
      } else if (res?.status === "ERROR") {
        failure = res.error || "terminal failure";
      }
    }
  }

  const combinedError = `${failure ?? ""} ${stderr ?? ""}`;
  const authFailure = Boolean(failure || exitCode !== 0) && /(?:auth|login|unauthori[sz]ed|forbidden|credential|permission denied)/i.test(combinedError);
  const modelFailure = Boolean(failure || exitCode !== 0) && /(?:invalid.*model|model.*not recognized|unsupported model|model unavailable)/i.test(combinedError);

  const diagnostics = {
    process_exit_code: exitCode,
    stderr_present: Boolean(String(stderr ?? "").trim()),
    event_types: [...eventTypes],
    step_types: [...stepTypes],
    conversation_id: conversationId,
    token_usage: tokenUsage,
    error_category: authFailure
      ? "auth_failure"
      : modelFailure
        ? "model_failure"
        : failure
          ? "terminal_failure"
          : null,
  };

  if (failure || exitCode !== 0) {
    const error = authFailure
      ? "antigravity_auth_error"
      : modelFailure
        ? "antigravity_model_error"
        : failure
          ? "antigravity_terminal_error"
          : `antigravity_process_exit_${exitCode}`;
    return { status: "FAILED", finalText: null, error, actualModel, diagnostics };
  }

  if (!completed || !finalText) {
    return { status: "FAILED", finalText: null, error: "antigravity_missing_terminal_result", actualModel, diagnostics };
  }

  return { status: "COMPLETED", finalText: redact(finalText), error: null, actualModel, diagnostics };
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
  }

  async run({ cwd, model, effort, task, onStarted }) {
    if (this.executableError) return launchFailure("INVALID_ANTIGRAVITY_CLI_PATH");
    const args = ["-p", task, "--output-format", "stream-json", "--model", model, "--effort", effort, "--dangerously-skip-permissions"];
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
      let settled = false;
      const finish = (code) => {
        if (!settled) {
          settled = true;
          resolve(Number.isInteger(code) ? code : 1);
        }
      };
      child.once("error", (error) => {
        launchError = error;
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
    if (startupError) return { pid, status: "FAILED", finalText: null, error: "pid_persistence_error", actualModel: "NOT_OBSERVABLE", diagnostics: { process_exit_code: exitCode } };
    if (outputExceeded) return { pid, status: "FAILED", finalText: null, error: "output_limit_exceeded", actualModel: "NOT_OBSERVABLE", diagnostics: { process_exit_code: exitCode } };
    if (launchError) return launchFailure(launchError.code);
    return { pid, ...parseAntigravityRun({ stdout, stderr, exitCode }) };
  }
}
