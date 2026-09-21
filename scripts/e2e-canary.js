import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFile = promisify(execFileCallback);
const serverPath = fileURLToPath(new URL("../src/mcp-server.js", import.meta.url));
const registerScriptPath = fileURLToPath(new URL("./register-project.js", import.meta.url));
const preferredModel = "custom-local:step-3.7-flash";
const canaryAlias = "registry-canary";
const marker = `PROJECT_MARKER=${randomUUID()}`;
const root = await mkdtemp(path.join(os.tmpdir(), "dalizi-dispatcher-canary-"));
let firstClient;
let secondClient;
let dispatchedJobId = null;
let childExitVerified = false;

const model = preferredModel;

function environment() {
  return {
    ...process.env,
    DISPATCHER_DATA_DIR: path.join(root, "jobs"),
  };
}

async function connect() {
  const client = new Client({ name: "dalizi-e2e-canary", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: environment(), stderr: "pipe" }));
  return client;
}

function toolJson(response) {
  assert.equal(response.isError, undefined, response.content?.[0]?.text);
  assert.equal(response.content?.[0]?.type, "text");
  return JSON.parse(response.content[0].text);
}

async function waitForCompleted(client, jobId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = toolJson(await client.callTool({ name: "get_task", arguments: { job_id: jobId } }));
    if (job.status === "COMPLETED" || job.status === "FAILED") return job;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("canary timed out waiting for WorkBuddy");
}

function childHasExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function diagnosticReport(job) {
  const diagnostics = job.diagnostics ?? {};
  return {
    CODEBUDDY_EXIT_CODE: diagnostics.process_exit_code ?? null,
    STDERR_PRESENT: diagnostics.stderr_present === true ? "YES" : "NO",
    EVENT_TYPES: diagnostics.event_types ?? [],
    TERMINAL_RESULT_SEEN: diagnostics.terminal_result_seen === true ? "YES" : "NO",
    TERMINAL_SUBTYPE: diagnostics.terminal_subtype ?? null,
    TERMINAL_IS_ERROR: diagnostics.terminal_is_error ?? null,
    RESULT_FIELD_PRESENT: diagnostics.result_field_present === true ? "YES" : "NO",
    ERRORS_PRESENT: diagnostics.errors_present === true ? "YES" : "NO",
    ERROR_CATEGORY: diagnostics.error_category ?? null,
    SAFE_ERROR_SUMMARY: diagnostics.safe_error_summary ?? null,
  };
}

async function removeCanaryDirectory() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 1, retryDelay: 500 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError;
}

try {
  await execFile("git", ["init"], { cwd: root, windowsHide: true });
  await writeFile(path.join(root, "PROJECT_MARKER"), `${marker}\n`, "utf8");
  await execFile(process.execPath, [registerScriptPath, "--alias", canaryAlias, "--cwd", root], { env: environment(), windowsHide: true });

  firstClient = await connect();
  const receipt = toolJson(await firstClient.callTool({
    name: "dispatch_task",
    arguments: {
      agent: "workbuddy",
      project: canaryAlias,
      model,
      effort: "high",
      task: "只读 PROJECT_MARKER，并仅返回标记的完整内容；不得修改文件。",
    },
  }));
  assert.match(receipt.job_id, /^[0-9a-f-]{36}$/);
  dispatchedJobId = receipt.job_id;
  assert.ok(["QUEUED", "RUNNING"].includes(receipt.status));

  const completed = await waitForCompleted(firstClient, receipt.job_id);
  if (completed.status !== "COMPLETED") {
    childExitVerified = typeof completed.pid === "number" && childHasExited(completed.pid);
    console.log(JSON.stringify({ workbuddy_diagnostic: diagnosticReport(completed) }));
    throw new Error(completed.error ?? "WorkBuddy canary failed");
  }
  assert.equal(typeof completed.final_text, "string");
  assert.ok(completed.final_text.length > 0);
  assert.match(completed.final_text, new RegExp(marker));
  assert.equal(completed.requested_model, model);
  assert.equal(typeof completed.actual_model, "string");
  assert.ok(completed.actual_model.length > 0);
  assert.equal(typeof completed.pid, "number");
  assert.equal(childHasExited(completed.pid), true, "owned WorkBuddy child is still running");
  childExitVerified = true;

  await firstClient.close();
  firstClient = undefined;
  secondClient = await connect();
  const recovered = toolJson(await secondClient.callTool({ name: "get_task", arguments: { job_id: receipt.job_id } }));
  assert.deepEqual(recovered, completed);

  console.log(JSON.stringify({ job_id: receipt.job_id, project: canaryAlias, state_sequence: [receipt.status, completed.status], project_marker_match: true, requested_model: completed.requested_model, actual_model: completed.actual_model, persisted_after_restart: true, workbuddy_diagnostic: diagnosticReport(completed) }));
} finally {
  await secondClient?.close();
  await firstClient?.close();
  if (!dispatchedJobId || childExitVerified) {
    await removeCanaryDirectory();
  } else {
    console.error(`canary directory retained because owned child exit was not verified: ${root}`);
  }
}
