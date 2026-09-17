import { randomBytes, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createDispatcherFromEnvironment } from "../src/mcp-server.js";
import { HTTP_MCP_PORT, startHttpMcpServer } from "../src/http-mcp-server.js";
import { CODEBUDDY_SCRIPT } from "../src/workbuddy-runner.js";

const execFile = promisify(execFileCallback);
const preferredModel = "custom-local:step-3.7-flash";
const registerScriptPath = fileURLToPath(new URL("./register-project.js", import.meta.url));
const canaryAlias = "registry-canary";
let currentStage = "startup";
let failureClass = "not_classified";

function toolJson(response) {
  if (response.isError || response.content?.[0]?.type !== "text") throw new Error("MCP tool response was not successful text content");
  return JSON.parse(response.content[0].text);
}

async function discoverPreferredModel() {
  const { stdout } = await execFile(process.execPath, [CODEBUDDY_SCRIPT, "--help"], { windowsHide: true, maxBuffer: 512 * 1024 });
  const supported = stdout.match(/Currently supported:\s*\(([^)]+)\)/s)?.[1]?.split(",").map((item) => item.trim()) ?? [];
  if (!supported.includes(preferredModel)) throw new Error("preferred WorkBuddy model is not currently supported");
  return preferredModel;
}

async function waitForCompleted(client, jobId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = toolJson(await client.callTool({ name: "get_task", arguments: { job_id: jobId } }));
    if (job.status === "COMPLETED" || job.status === "FAILED") return job;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("HTTP canary timed out waiting for WorkBuddy");
}

function childHasExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function classifyTerminalFailure(error) {
  if (typeof error !== "string") return "no_terminal_error";
  if (error.startsWith("spawn_error:")) return "launcher_spawn_error";
  if (error.startsWith("pid_persistence_error:")) return "pid_persistence_error";
  if (error === "output_limit_exceeded") return "output_limit_exceeded";
  if (error.startsWith("parsed_error:")) return "workbuddy_parsed_error";
  if (error.startsWith("process_exit_")) return "workbuddy_nonzero_exit";
  if (error === "missing_parsed_result") return "workbuddy_missing_result";
  return "unclassified_terminal_failure";
}

async function removeCanaryDirectory(root) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 1, retryDelay: 500 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error("HTTP canary temporary directory could not be removed");
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dalizi-http-canary-"));
  const marker = `PROJECT_MARKER=${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  const model = await discoverPreferredModel();
  let client;
  let secondClient;
  let server;
  let childExitVerified = false;
  let dispatchedJobId;

  try {
    currentStage = "initialize_temporary_project";
    await execFile("git", ["init"], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, "PROJECT_MARKER"), `${marker}\n`, "utf8");
    const environment = {
      ...process.env,
      DISPATCHER_DATA_DIR: path.join(root, "jobs"),
    };
    currentStage = "register_temporary_project";
    await execFile(process.execPath, [registerScriptPath, "--alias", canaryAlias, "--cwd", root], { env: environment, windowsHide: true });
    currentStage = "start_loopback_http_mcp";
    server = await startHttpMcpServer({ dispatcher: createDispatcherFromEnvironment(environment), bearerToken: token, port: HTTP_MCP_PORT });
    const endpoint = new URL(`http://127.0.0.1:${HTTP_MCP_PORT}/mcp`);
    const connect = async () => {
      const nextClient = new Client({ name: "dalizi-http-e2e-canary", version: "0.0.0" });
      await nextClient.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: { token: async () => token } }));
      return nextClient;
    };

    currentStage = "connect_authorized_http_mcp";
    client = await connect();
    currentStage = "dispatch_workbuddy_canary";
    const receipt = toolJson(await client.callTool({
      name: "dispatch_task",
      arguments: {
        agent: "workbuddy",
        project: canaryAlias,
        model,
        effort: "high",
        task: "只读 PROJECT_MARKER，并仅返回标记的完整内容；不得修改文件。",
      },
    }));
    if (typeof receipt.job_id !== "string" || !["QUEUED", "RUNNING"].includes(receipt.status)) throw new Error("HTTP canary dispatch receipt was invalid");
    dispatchedJobId = receipt.job_id;

    currentStage = "wait_for_workbuddy_result";
    const completed = await waitForCompleted(client, receipt.job_id);
    if (completed.status !== "COMPLETED") {
      failureClass = classifyTerminalFailure(completed.error);
      throw new Error("HTTP canary WorkBuddy result did not complete");
    }
    if (typeof completed.final_text !== "string" || !completed.final_text.includes(marker)) {
      failureClass = "marker_not_observed";
      throw new Error("HTTP canary WorkBuddy result did not prove marker read");
    }
    if (typeof completed.pid !== "number" || !childHasExited(completed.pid)) {
      failureClass = "owned_child_exit_not_verified";
      throw new Error("owned WorkBuddy child exit was not verified");
    }
    childExitVerified = true;

    await client.close();
    client = undefined;
    await closeServer(server);
    server = undefined;
    currentStage = "restart_and_verify_registry_and_persistence";
    const restartedDispatcher = createDispatcherFromEnvironment(environment);
    if (restartedDispatcher.registry.resolve(canaryAlias) !== root) throw new Error("registered project did not resolve after Dispatcher restart");
    server = await startHttpMcpServer({ dispatcher: restartedDispatcher, bearerToken: token, port: HTTP_MCP_PORT });
    secondClient = await connect();
    const recovered = toolJson(await secondClient.callTool({ name: "get_task", arguments: { job_id: receipt.job_id } }));
    if (JSON.stringify(recovered) !== JSON.stringify(completed)) {
      failureClass = "persistence_mismatch";
      throw new Error("HTTP canary job was not persisted after a new client connection");
    }

    console.log(JSON.stringify({ job_id: receipt.job_id, project: canaryAlias, state_sequence: [receipt.status, completed.status], project_marker_match: true, registry_resolved_after_restart: true, persisted_after_restart: true, bind_address: "127.0.0.1", port: HTTP_MCP_PORT }));
  } finally {
    await secondClient?.close();
    await client?.close();
    if (server) await closeServer(server);
    if (!dispatchedJobId || childExitVerified) await removeCanaryDirectory(root);
  }
}

main().catch(() => {
  process.stderr.write(`HTTP canary failed at ${currentStage}: ${failureClass}\n`);
  process.exitCode = 1;
});
