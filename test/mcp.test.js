import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDispatcherFromEnvironment } from "../src/mcp-server.js";
import { projectRegistryPath, registerProject } from "../src/project-registry.js";

const serverPath = fileURLToPath(new URL("../src/mcp-server.js", import.meta.url));

test("the removed inline registry configuration fails closed", () => {
  assert.throws(
    () => createDispatcherFromEnvironment({ DISPATCHER_PROJECT_REGISTRY: JSON.stringify({ "canary-project": "C:/not-allowed" }) }),
    { code: "invalid_registry" },
  );
});

test("the stdio MCP server exposes only two tools and fails closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-mcp-"));
  const client = new Client({ name: "dalizi-test-client", version: "0.0.0" });
  try {
    const dataDirectory = path.join(directory, "jobs");
    await registerProject({ registryFile: projectRegistryPath(dataDirectory), alias: "canary-project", cwd: directory });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, DISPATCHER_DATA_DIR: dataDirectory },
      stderr: "pipe",
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["dispatch_task", "get_task"]);
    const dispatchTool = tools.tools.find((tool) => tool.name === "dispatch_task");
    assert.doesNotMatch(JSON.stringify(dispatchTool), /"(?:cwd|path|executable|command)"/);

    const unsupported = await client.callTool({ name: "dispatch_task", arguments: { agent: "codex", project: "canary-project", task: "read", model: "custom-local:step-3.7-flash" } });
    assert.equal(unsupported.isError, true);
    assert.match(unsupported.content[0].text, /unsupported_agent/);

    const unknown = await client.callTool({ name: "dispatch_task", arguments: { agent: "workbuddy", project: "unknown", task: "read", model: "custom-local:step-3.7-flash" } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown_project/);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
