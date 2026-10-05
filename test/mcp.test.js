import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDispatcherFromEnvironment, createMcpServer } from "../src/mcp-server.js";
import { DispatcherError } from "../src/contracts.js";
import { projectRegistryPath, registerProject } from "../src/project-registry.js";
import { TASK_CARD_MIME_TYPE, TASK_CARD_RESOURCE_URI, BOARD_MIME_TYPE, BOARD_RESOURCE_URI, BOARD_HTTP_ORIGIN } from "../src/task-card.js";

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

test("the stdio MCP server exposes exactly four tools and fails closed", async () => {
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
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["dispatch_task", "get_task", "render_board", "render_task_card"]);
    const dispatchTool = tools.tools.find((tool) => tool.name === "dispatch_task");
    const getTool = tools.tools.find((tool) => tool.name === "get_task");
    const cardTool = tools.tools.find((tool) => tool.name === "render_task_card");
    const boardTool = tools.tools.find((tool) => tool.name === "render_board");
    assert.deepEqual(Object.keys(dispatchTool.inputSchema.properties).sort(), ["agent", "effort", "model", "project", "request_id", "task"]);
    assert.deepEqual(Object.keys(getTool.inputSchema.properties), ["job_id"]);
    assert.deepEqual(Object.keys(cardTool.inputSchema.properties), ["job_id"]);
    assert.deepEqual(Object.keys(boardTool.inputSchema.properties), []);
    assert.equal(cardTool._meta.ui.resourceUri, TASK_CARD_RESOURCE_URI);
    assert.equal(cardTool.annotations.readOnlyHint, true);
    assert.equal(boardTool._meta.ui.resourceUri, BOARD_RESOURCE_URI);
    assert.equal(boardTool.annotations.readOnlyHint, true);
    assert.doesNotMatch(JSON.stringify(dispatchTool), /"(?:cwd|path|executable|command)"/);
    // T2：工具描述写明"目标 CLI/目标 CLI 模型"与 request_id 重试语义（A2 契约部分）。
    assert.match(dispatchTool.description, /target CLI model/);
    assert.match(dispatchTool.description, /request_id/);
    assert.match(dispatchTool.description, /no retry guarantee/);

    // P5 CH3：固定资源三条（task-card UI + board UI + dlz://board 数据资源）；
    // dlz://job/{job_id} 为模板，不进 resources/list。
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 3);
    assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [TASK_CARD_RESOURCE_URI, BOARD_RESOURCE_URI, "dlz://board"].sort());
    const boardUi = resources.resources.find((resource) => resource.uri === BOARD_RESOURCE_URI);
    assert.equal(boardUi.mimeType, BOARD_MIME_TYPE);
    const boardData = resources.resources.find((resource) => resource.uri === "dlz://board");
    assert.equal(boardData.mimeType, "application/json");

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

// T2：request_id 回执接线 + idempotency_conflict 错误码经 MCP 层透传 +
// 环境工厂注入幂等索引与实例锁（stdio 与 HTTP 同状态目录同锁）。
test("dispatch_task echoes request_id, surfaces idempotency_conflict, and stays client-neutral", async () => {
  const dispatches = [];
  const stubDispatcher = {
    async dispatch(input) {
      dispatches.push(input);
      if (input.request_id === "mcp-conflict-0001" && input.task === "different") {
        throw new DispatcherError("idempotency_conflict", "request_id is already bound to a different request");
      }
      return { job_id: "11111111-1111-4111-8111-111111111111", status: "QUEUED", request_id: input.request_id ?? null };
    },
    async get(jobId) { return { job_id: jobId, status: "QUEUED" }; },
  };
  const server = createMcpServer(stubDispatcher);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dalizi-test-client", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const receipt = await client.callTool({
      name: "dispatch_task",
      arguments: { agent: "workbuddy", project: "canary-project", task: "read", model: "custom-local:step-5-preview", request_id: "mcp-hit-00000001" },
    });
    assert.equal(receipt.isError, undefined);
    const payload = JSON.parse(receipt.content[0].text);
    assert.equal(payload.request_id, "mcp-hit-00000001");
    assert.equal(payload.status, "QUEUED");

    const conflict = await client.callTool({
      name: "dispatch_task",
      arguments: { agent: "workbuddy", project: "canary-project", task: "different", model: "custom-local:step-5-preview", request_id: "mcp-conflict-0001" },
    });
    assert.equal(conflict.isError, true);
    assert.equal(JSON.parse(conflict.content[0].text).error.code, "idempotency_conflict");

    // schema 层 request_id 格式约束（客户端中立契约，绑定 zod 而非某发起方）。
    const malformed = await client.callTool({
      name: "dispatch_task",
      arguments: { agent: "workbuddy", project: "canary-project", task: "read", model: "custom-local:step-5-preview", request_id: "no" },
    });
    assert.equal(malformed.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

// P5 CH1：dlz://job/{job_id} 只读资源模板（蓝图 §12.1 / IMPLEMENTATION §9.1）。
// stub dispatcher（不碰真实 runner）：get 返回固定 v2 快照，dispatch 回执 request_id。
test("the dlz://job/{job_id} resource template serves the get_task snapshot and fails closed", async () => {
  const snapshot = {
    job_id: "11111111-1111-4111-8111-111111111111",
    schema_version: 2,
    revision: 3,
    status: "COMPLETED",
    agent: "workbuddy",
    project: "canary-project",
    task: "read marker",
    requested_model: "custom-local:step-5-preview",
    effort: "high",
    request_id: "job-resource-0001",
    created_at: "2026-10-04T00:00:00.000Z",
    started_at: "2026-10-04T00:00:01.000Z",
    finished_at: "2026-10-04T00:00:09.000Z",
    updated_at: "2026-10-04T00:00:09.000Z",
    final_text: "TASK_CARD_MARKER",
    error: null,
    current_activity: null,
    activity: null,
    liveness: { owner_heartbeat_at: null, process_checked_at: null, process_state: null, last_event_at: null, last_output_at: null },
    usage: { input_tokens: null, output_tokens: null, reasoning_tokens: null },
  };
  const stubDispatcher = {
    async dispatch(input) { return { job_id: snapshot.job_id, status: "QUEUED", request_id: input.request_id ?? null }; },
    async get(jobId) {
      if (jobId !== snapshot.job_id) throw new DispatcherError("unknown_job", "job_id was not found");
      return snapshot;
    },
  };
  const server = createMcpServer(stubDispatcher);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dalizi-test-client", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // 工具集不变：get_task 保留（其他客户端与降级兜底依赖），只增资源与 render_board
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["dispatch_task", "get_task", "render_board", "render_task_card"]);

    // 资源模板注册：SDK v2 ResourceTemplate，mimeType application/json
    const templates = await client.listResourceTemplates();
    assert.equal(templates.resourceTemplates.length, 1);
    const [template] = templates.resourceTemplates;
    assert.equal(template.name, "Dalizi Job");
    assert.equal(template.uriTemplate, "dlz://job/{job_id}");
    assert.equal(template.mimeType, "application/json");

    // P5 CH3：固定资源三条；模板资源不进 resources/list（卡片直读 uri，不依赖枚举）
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 3);
    assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [TASK_CARD_RESOURCE_URI, BOARD_RESOURCE_URI, "dlz://board"].sort());

    // 同形断言：资源载荷与 get_task structuredContent 完全一致（逐字段 deepEqual）
    const fetched = await client.callTool({ name: "get_task", arguments: { job_id: snapshot.job_id } });
    assert.equal(fetched.isError, undefined);
    assert.deepEqual(fetched.structuredContent, snapshot);

    const read = await client.readResource({ uri: `dlz://job/${snapshot.job_id}` });
    assert.equal(read.contents.length, 1);
    assert.equal(read.contents[0].uri, `dlz://job/${snapshot.job_id}`);
    assert.equal(read.contents[0].mimeType, "application/json");
    const resourceJob = JSON.parse(read.contents[0].text);
    assert.deepEqual(Object.keys(resourceJob).sort(), Object.keys(fetched.structuredContent).sort());
    assert.deepEqual(resourceJob, fetched.structuredContent);

    // 错误路径：job 不存在 / 空段 / 点段穿越（URL 规范化后不匹配模板）/ 编码斜线 →
    // 标准资源错误，且不外泄内部路径（消息仅含请求 uri，无数据目录/文件名）
    for (const uri of ["dlz://job/missing-job", "dlz://job/", "dlz://job/..", "dlz://job/a%2Fb"]) {
      await assert.rejects(
        () => client.readResource({ uri }),
        (error) => {
          assert.equal(error.code, -32602);
          assert.match(error.message, /Resource not found/);
          assert.doesNotMatch(error.message, /\.json|dispatcher-data|jobs/);
          return true;
        },
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// P5 CH3：render_board 工具契约 + dlz://board 只读资源（蓝图 §12.2/§12.3 / IMPLEMENTATION §9.1）。
// stub dispatcher：listBoard 完全可控；dispatch/get 保持最小回执（不碰真实 runner）。
function boardSnapshot(jobId, status, revision) {
  return {
    job_id: jobId,
    schema_version: 2,
    revision,
    status,
    agent: "workbuddy",
    project: "canary-project",
    task: "read marker",
    requested_model: "custom-local:step-5-preview",
    effort: "high",
    request_id: `board-${jobId}`,
    created_at: "2026-10-04T00:00:00.000Z",
    started_at: "2026-10-04T00:00:01.000Z",
    finished_at: status === "COMPLETED" ? "2026-10-04T00:00:09.000Z" : null,
    updated_at: "2026-10-04T00:00:09.000Z",
    final_text: status === "COMPLETED" ? "BOARD_MARKER" : null,
    error: null,
    current_activity: null,
    activity: null,
    liveness: { owner_heartbeat_at: null, process_checked_at: null, process_state: null, last_event_at: null, last_output_at: null },
    usage: { input_tokens: null, output_tokens: null, reasoning_tokens: null },
  };
}

function createBoardStubDispatcher(board) {
  return {
    async dispatch(input) { return { job_id: "11111111-1111-4111-8111-111111111111", status: "QUEUED", request_id: input.request_id ?? null }; },
    async get(jobId) { throw new DispatcherError("unknown_job", `job_id was not found: ${jobId}`); },
    async listBoard() { return board; },
  };
}

test("render_board publishes {jobs, board_url, read_token, generated_at, notice} and serves dlz://board with one connectDomains origin", async () => {
  const readToken = "board-read-token-0123456789abcdef"; // ≥32 字符独立只读凭据
  const board = {
    jobs: [boardSnapshot("job-running", "RUNNING", 3), boardSnapshot("job-done", "COMPLETED", 2)],
    truncated: true,
    total: 57,
  };
  const server = createMcpServer(createBoardStubDispatcher(board), { DISPATCHER_HTTP_READ_TOKEN: readToken });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dalizi-test-client", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["dispatch_task", "get_task", "render_board", "render_task_card"]);
    const boardTool = tools.tools.find((tool) => tool.name === "render_board");
    assert.equal(boardTool.annotations.readOnlyHint, true);
    assert.equal(boardTool._meta.ui.resourceUri, BOARD_RESOURCE_URI);
    assert.equal(boardTool.inputSchema.type, "object");
    assert.deepEqual(Object.keys(boardTool.inputSchema.properties), []);
    assert.match(boardTool.description, /read-only resource|dlz:\/\/board/);

    // board UI 资源：mimeType text/html;profile=mcp-app；CSP 白名单恰好一个 origin，
    // resourceDomains 维持空（蓝图 §12.5：禁扩大白名单范围）。
    const resources = await client.listResources();
    const boardUi = resources.resources.find((resource) => resource.uri === BOARD_RESOURCE_URI);
    assert.equal(boardUi.mimeType, BOARD_MIME_TYPE);
    assert.deepEqual(JSON.parse(JSON.stringify(boardUi._meta.ui.csp)), { connectDomains: ["http://127.0.0.1:18490"], resourceDomains: [] });
    assert.equal(BOARD_HTTP_ORIGIN, "http://127.0.0.1:18490");
    assert.equal(boardUi._meta.ui.csp.connectDomains.length, 1, "connectDomains 必须恰好一个 origin");

    // render_board structuredContent 契约：token 经本已认证工具调用动态下发
    const rendered = await client.callTool({ name: "render_board", arguments: {} });
    assert.equal(rendered.isError, undefined);
    assert.deepEqual(Object.keys(rendered.structuredContent).sort(), ["board_url", "generated_at", "jobs", "notice", "read_token"]);
    assert.equal(rendered.structuredContent.read_token, readToken);
    assert.equal(rendered.structuredContent.board_url, `http://127.0.0.1:18490/board?read_token=${readToken}`);
    assert.equal(rendered.structuredContent.notice, null);
    assert.match(rendered.structuredContent.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(rendered.structuredContent.jobs.length, 2);
    for (const summary of rendered.structuredContent.jobs) {
      assert.deepEqual(Object.keys(summary).sort(), ["agent", "created_at", "job_id", "project", "revision", "status", "updated_at"]);
    }
    assert.deepEqual(rendered.structuredContent.jobs[0], {
      job_id: "job-running",
      status: "RUNNING",
      project: "canary-project",
      agent: "workbuddy",
      created_at: "2026-10-04T00:00:00.000Z",
      updated_at: "2026-10-04T00:00:09.000Z",
      revision: 3,
    });
    // text 内容与 structuredContent 同源（同一已认证通道）
    assert.deepEqual(JSON.parse(rendered.content[0].text), rendered.structuredContent);

    // dlz://board：固定 URI 只读资源，载荷与 listBoard 契约一致
    const read = await client.readResource({ uri: "dlz://board" });
    assert.equal(read.contents.length, 1);
    assert.equal(read.contents[0].uri, "dlz://board");
    assert.equal(read.contents[0].mimeType, "application/json");
    assert.deepEqual(JSON.parse(read.contents[0].text), board);
  } finally {
    await client.close();
    await server.close();
  }
});

test("render_board degrades to null board_url/read_token with an explicit notice when no valid read token is configured", async () => {
  for (const environment of [{}, { DISPATCHER_HTTP_READ_TOKEN: "too-short" }]) {
    const server = createMcpServer(createBoardStubDispatcher({ jobs: [], truncated: false, total: 0 }), environment);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dalizi-test-client", version: "0.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const degraded = await client.callTool({ name: "render_board", arguments: {} });
      assert.equal(degraded.isError, undefined);
      assert.equal(degraded.structuredContent.jobs.length, 0);
      // 未配置 / 过短（<32 字符）均按未配置处理：不得下发不可用凭据，board_url/read_token 为 null
      assert.equal(degraded.structuredContent.board_url, null);
      assert.equal(degraded.structuredContent.read_token, null);
      assert.match(degraded.structuredContent.notice, /DISPATCHER_HTTP_READ_TOKEN/);
      assert.match(degraded.structuredContent.notice, /dlz:\/\/board 资源轮询/);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("render_board and dlz://board fail closed without leaking internals when listBoard throws", async () => {
  const brokenDispatcher = {
    async dispatch(input) { return { job_id: "board-error", status: "QUEUED", request_id: input.request_id ?? null }; },
    async get() { throw new DispatcherError("unknown_job", "job_id was not found"); },
    async listBoard() { throw new Error("EACCES: permission denied, open 'D:/secret/dispatcher-data/jobs/board.json'"); },
  };
  const server = createMcpServer(brokenDispatcher, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dalizi-test-client", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const rendered = await client.callTool({ name: "render_board", arguments: {} });
    assert.equal(rendered.isError, true);
    const payload = JSON.parse(rendered.content[0].text);
    assert.equal(payload.error.code, "internal_error");
    assert.doesNotMatch(rendered.content[0].text, /EACCES|dispatcher-data|D:\/secret/);
    assert.ok(!rendered.structuredContent, "失败不得返回 structured content");

    await assert.rejects(
      () => client.readResource({ uri: "dlz://board" }),
      (error) => {
        assert.equal(error.code, -32602);
        assert.match(error.message, /Resource not found/);
        assert.doesNotMatch(error.message, /EACCES|dispatcher-data|D:\/secret/);
        return true;
      },
    );
  } finally {
    await client.close();
    await server.close();
  }
});
