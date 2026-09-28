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
const model = "gemini-3.8-flash-high";
const canaryAlias = "agy-canary";
const marker = `AGY_CANARY_MARKER_${randomUUID()}`;
const root = await mkdtemp(path.join(os.tmpdir(), "dalizi-dispatcher-agy-canary-"));
let firstClient;
let secondClient;
let dispatchedJobId = null;
let childExitVerified = false;

const workspace = path.join(root, "workspace");

function environment() {
  return {
    ...process.env,
    DISPATCHER_DATA_DIR: path.join(root, "jobs"),
  };
}

async function connect() {
  const client = new Client({ name: "dalizi-agy-canary", version: "0.0.0" });
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
  throw new Error("canary timed out waiting for Antigravity");
}

function childHasExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
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
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  await execFile("git", ["init"], { cwd: workspace, windowsHide: true });
  await writeFile(path.join(workspace, "PROJECT_MARKER"), `${marker}\n`, "utf8");

  await execFile(process.execPath, [registerScriptPath, "--alias", canaryAlias, "--cwd", workspace], { env: environment(), windowsHide: true });

  firstClient = await connect();
  const receipt = toolJson(await firstClient.callTool({
    name: "dispatch_task",
    arguments: {
      agent: "antigravity",
      project: canaryAlias,
      model,
      effort: "high",
      task: "Read PROJECT_MARKER and return only its full contents. Do not modify files.",
    },
  }));

  assert.match(receipt.job_id, /^[0-9a-f-]{36}$/);
  dispatchedJobId = receipt.job_id;
  assert.ok(["QUEUED", "RUNNING"].includes(receipt.status));

  const completed = await waitForCompleted(firstClient, receipt.job_id);
  if (completed.status !== "COMPLETED") {
    childExitVerified = typeof completed.pid === "number" && childHasExited(completed.pid);
    console.error("Antigravity canary failed:", completed.error, JSON.stringify(completed.diagnostics));
    throw new Error(completed.error ?? "Antigravity canary failed");
  }

  // Verify result fields
  assert.equal(completed.agent, "antigravity");
  assert.equal(completed.requested_model, model);
  assert.equal(completed.actual_model, model);
  assert.equal(completed.effort, "high");
  assert.equal(typeof completed.final_text, "string");
  assert.ok(completed.final_text.length > 0);
  assert.match(completed.final_text, new RegExp(marker));
  assert.equal(typeof completed.pid, "number");
  assert.equal(childHasExited(completed.pid), true, "owned Antigravity child is still running");
  childExitVerified = true;

  // Verify file status in canary workspace: zero files modified, marker unchanged
  const markerContent = await (await import("node:fs/promises")).readFile(path.join(workspace, "PROJECT_MARKER"), "utf8");
  assert.equal(markerContent, `${marker}\n`, "PROJECT_MARKER was unexpectedly modified");
  const files = (await (await import("node:fs/promises")).readdir(workspace)).filter((f) => f !== ".git");
  assert.deepEqual(files, ["PROJECT_MARKER"], `Unexpected files created: ${files}`);

  // Test persistence across MCP client reconnect
  await firstClient.close();
  firstClient = undefined;
  secondClient = await connect();
  const recovered = toolJson(await secondClient.callTool({ name: "get_task", arguments: { job_id: receipt.job_id } }));
  assert.deepEqual(recovered, completed);

  console.log(JSON.stringify({
    job_id: receipt.job_id,
    agent: completed.agent,
    project: canaryAlias,
    state_sequence: [receipt.status, "RUNNING", completed.status],
    project_marker_match: true,
    files_modified: 0,
    requested_model: completed.requested_model,
    actual_model: completed.actual_model,
    effort: completed.effort,
    token_usage: completed.diagnostics?.token_usage ?? null,
    persisted_after_restart: true,
    antigravity_diagnostics: completed.diagnostics,
  }, null, 2));
} finally {
  await secondClient?.close();
  await firstClient?.close();
  if (!dispatchedJobId || childExitVerified) {
    await removeCanaryDirectory();
  } else {
    console.error(`canary directory retained because child exit was not verified: ${root}`);
  }
}
