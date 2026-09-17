import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Dispatcher } from "../src/dispatcher.js";
import { DispatcherError } from "../src/contracts.js";
import { startHttpMcpServer } from "../src/http-mcp-server.js";
import { JobStore } from "../src/job-store.js";

function toolJson(response) {
  assert.equal(response.isError, undefined, response.content?.[0]?.text);
  assert.equal(response.content?.[0]?.type, "text");
  return JSON.parse(response.content[0].text);
}

function createRunner() {
  return {
    async run({ onStarted }) {
      await onStarted(4242);
      return { pid: 4242, status: "COMPLETED", finalText: "HTTP_TEST_MARKER", error: null, actualModel: "test-model" };
    },
  };
}

async function waitForTerminalJob(client, jobId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const job = toolJson(await client.callTool({ name: "get_task", arguments: { job_id: jobId } }));
    if (job.status === "COMPLETED" || job.status === "FAILED") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("HTTP MCP test job did not finish");
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("the loopback HTTP MCP endpoint requires Bearer auth and shares Dispatcher behavior", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-http-mcp-"));
  const token = randomBytes(32).toString("base64url");
  const dispatcher = new Dispatcher({
    registry: { resolve(project) { if (project !== "canary-project") throw new DispatcherError("unknown_project", "project is not registered"); return directory; } },
    allowedModels: new Set(["custom-local:step-3.7-flash"]),
    store: new JobStore(path.join(directory, "jobs")),
    runner: createRunner(),
  });
  const server = await startHttpMcpServer({ dispatcher, bearerToken: token, port: 0 });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.equal(address.address, "127.0.0.1");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  let client;
  try {
    const unauthorizedPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const missing = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: unauthorizedPayload });
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate") ?? "", /^Bearer$/i);

    const invalid = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer invalid", "content-type": "application/json" }, body: unauthorizedPayload });
    assert.equal(invalid.status, 401);

    const foreignOrigin = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "https://foreign.example" }, body: unauthorizedPayload });
    assert.equal(foreignOrigin.status, 403);

    const clientTransport = new StreamableHTTPClientTransport(endpoint, { authProvider: { token: async () => token } });
    client = new Client({ name: "dalizi-http-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["dispatch_task", "get_task"]);
    const dispatchTool = tools.tools.find((tool) => tool.name === "dispatch_task");
    assert.doesNotMatch(JSON.stringify(dispatchTool), /"(?:cwd|path|executable|command)"/);

    const receipt = toolJson(await client.callTool({
      name: "dispatch_task",
      arguments: { agent: "workbuddy", project: "canary-project", task: "read", model: "custom-local:step-3.7-flash" },
    }));
    const completed = await waitForTerminalJob(client, receipt.job_id);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.final_text, "HTTP_TEST_MARKER");

    const recovered = toolJson(await client.callTool({ name: "get_task", arguments: { job_id: receipt.job_id } }));
    assert.deepEqual(recovered, completed);

    const unsupported = await client.callTool({ name: "dispatch_task", arguments: { agent: "codex", project: "canary-project", task: "read", model: "custom-local:step-3.7-flash" } });
    assert.equal(unsupported.isError, true);
    assert.match(unsupported.content[0].text, /unsupported_agent/);

    const unknown = await client.callTool({ name: "dispatch_task", arguments: { agent: "workbuddy", project: "unknown", task: "read", model: "custom-local:step-3.7-flash" } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown_project/);
  } finally {
    await client?.close();
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});
