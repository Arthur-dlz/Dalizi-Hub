import { spawn as spawnChild } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { interpretRun } from "./stream-json.js";

export const CODEBUDDY_SCRIPT = process.env.WORKBUDDY_CLI_PATH;
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;

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

  async run({ cwd, model, effort, task, onStarted }) {
    if (this.codebuddyScriptError) {
      return { pid: null, status: "FAILED", finalText: null, error: `codebuddy_path_error: ${this.codebuddyScriptError.message}`, actualModel: "NOT_OBSERVABLE" };
    }
    const args = [this.codebuddyScript, "-p", "--output-format", "stream-json", "--model", model, "--effort", effort, task];
    let child;
    try {
      child = this.spawn(this.nodeExecutable, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return { pid: null, status: "FAILED", finalText: null, error: `spawn_error: ${error.message}`, actualModel: "NOT_OBSERVABLE" };
    }

    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let outputExceeded = false;
    let spawnError = null;
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
    if (startupError) return { pid: child.pid ?? null, status: "FAILED", finalText: null, error: `pid_persistence_error: ${startupError.message}`, actualModel: "NOT_OBSERVABLE" };
    if (outputExceeded) return { pid: child.pid ?? null, status: "FAILED", finalText: null, error: "output_limit_exceeded", actualModel: "NOT_OBSERVABLE" };
    if (spawnError) return { pid: child.pid ?? null, status: "FAILED", finalText: null, error: `spawn_error: ${spawnError.message}`, actualModel: "NOT_OBSERVABLE" };
    return { pid: child.pid ?? null, ...interpretRun({ stdout, stderr, exitCode }) };
  }
}
