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
import { TASK_CARD_MIME_TYPE, TASK_CARD_RESOURCE_URI } from "../src/task-card.js";

const serverPath = fileURLToPath(new URL("../src/mcp-server.js", import.meta.url));

test("the removed inline registry configuration fails closed", () => {
  assert.throws(
    () => createDispatcherFromEnvironment({ DISPATCHER_PROJECT_REGISTRY: JSON.stringify({ "canary-project": "C:/not-allowed" }) }),
    { code: "invalid_registry" },
  );
});

test("the retired WorkBuddy model is rejected before dispatch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-retired-model-"));
  try {
    const dataDirectory = path.join(directory, "jobs");
    await registerProject({ registryFile: projectRegistryPath(dataDirectory), alias: "canary-project", cwd: directory });
    const dispatcher = createDispatcherFromEnvironment({ DISPATCHER_DATA_DIR: dataDirectory });

    await assert.rejects(
      () => dispatcher.dispatch({ agent: "workbuddy", project: "canary-project", task: "read", model: "custom-local:step-3.7-flash" }),
      { code: "invalid_model" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the stdio MCP server exposes exactly three tools and fails closed", async () => {
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
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["dispatch_task", "get_task", "render_task_card"]);
    const dispatchTool = tools.tools.find((tool) => tool.name === "dispatch_task");
    const getTool = tools.tools.find((tool) => tool.name === "get_task");
    const cardTool = tools.tools.find((tool) => tool.name === "render_task_card");
    assert.deepEqual(Object.keys(dispatchTool.inputSchema.properties).sort(), ["agent", "effort", "model", "project", "task"]);
    assert.deepEqual(Object.keys(getTool.inputSchema.properties), ["job_id"]);
    assert.deepEqual(Object.keys(cardTool.inputSchema.properties), ["job_id"]);
    assert.equal(cardTool._meta.ui.resourceUri, TASK_CARD_RESOURCE_URI);
    assert.equal(cardTool.annotations.readOnlyHint, true);
    assert.doesNotMatch(JSON.stringify(dispatchTool), /"(?:cwd|path|executable|command)"/);

    const resources = await client.listResources();
    assert.equal(resources.resources.length, 1);
    assert.equal(resources.resources[0].uri, TASK_CARD_RESOURCE_URI);
    assert.equal(resources.resources[0].mimeType, TASK_CARD_MIME_TYPE);

    const unsupported = await client.callTool({ name: "dispatch_task", arguments: { agent: "unknown", project: "canary-project", task: "read", model: "custom-local:step-5-preview" } });
    assert.equal(unsupported.isError, true);
    assert.match(unsupported.content[0].text, /unsupported_agent/);

    const unknown = await client.callTool({ name: "dispatch_task", arguments: { agent: "workbuddy", project: "unknown", task: "read", model: "custom-local:step-5-preview" } });
    assert.equal(unknown.isError, true);
    const payload = JSON.parse(unknown.content[0].text);
    assert.deepEqual(Object.keys(payload), ["error"]);
    assert.deepEqual(Object.keys(payload.error), ["code", "message"]);
    assert.equal(payload.error.code, "unknown_project");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
