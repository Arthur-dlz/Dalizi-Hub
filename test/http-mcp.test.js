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
import { TASK_CARD_RESOURCE_URI } from "../src/task-card.js";

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
    allowedModels: { workbuddy: new Set(["custom-local:step-5-preview"]), codex: new Set(["gpt-6-sol"]) },
    store: new JobStore(path.join(directory, "jobs")),
    runner: createRunner(),
    codexRunner: createRunner(),
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
    // V1 回归核心：三工具保持注册；注册面本身由 CH1/CH3 演进（dlz:// 资源、render_board），
    // 本只读端点测试不锁死上游新增项（http-mcp.test.js 归 CH2 单写，只增不减）。
    const toolNames = tools.tools.map((tool) => tool.name);
    for (const name of ["dispatch_task", "get_task", "render_task_card"]) {
      assert.ok(toolNames.includes(name), `${name} must stay registered`);
    }
    const dispatchTool = tools.tools.find((tool) => tool.name === "dispatch_task");
    assert.doesNotMatch(JSON.stringify(dispatchTool), /"(?:cwd|path|executable|command)"/);
    const cardTool = tools.tools.find((tool) => tool.name === "render_task_card");
    assert.equal(cardTool._meta.ui.resourceUri, TASK_CARD_RESOURCE_URI);
    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    assert.ok(resourceUris.includes(TASK_CARD_RESOURCE_URI), "the task-card resource must stay registered");

    const receipt = toolJson(await client.callTool({
      name: "dispatch_task",
      arguments: { agent: "workbuddy", project: "canary-project", task: "read", model: "custom-local:step-5-preview" },
    }));
    const completed = await waitForTerminalJob(client, receipt.job_id);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.final_text, "HTTP_TEST_MARKER");

    const recovered = toolJson(await client.callTool({ name: "get_task", arguments: { job_id: receipt.job_id } }));
    assert.deepEqual(recovered, completed);

    const rendered = toolJson(await client.callTool({ name: "render_task_card", arguments: { job_id: receipt.job_id } }));
    assert.deepEqual(rendered, recovered);

    const unknownCard = await client.callTool({ name: "render_task_card", arguments: { job_id: "missing-job" } });
    assert.equal(unknownCard.isError, true);
    assert.equal(JSON.parse(unknownCard.content[0].text).error.code, "unknown_job");

    const codexReceipt = toolJson(await client.callTool({
      name: "dispatch_task",
      arguments: { agent: "codex", project: "canary-project", task: "read", model: "gpt-6-sol", effort: "high" },
    }));
    const codexJob = await waitForTerminalJob(client, codexReceipt.job_id);
    assert.equal(codexJob.status, "COMPLETED");
    assert.equal(codexJob.agent, "codex");
    assert.equal(codexJob.requested_model, "gpt-6-sol");
    assert.equal(codexJob.effort, "high");
    assert.equal(codexJob.final_text, "HTTP_TEST_MARKER");

    const rejectedCodexModel = await client.callTool({ name: "dispatch_task", arguments: { agent: "codex", project: "canary-project", task: "read", model: "custom-local:step-5-preview" } });
    assert.equal(rejectedCodexModel.isError, true);
    assert.deepEqual(JSON.parse(rejectedCodexModel.content[0].text).error.code, "invalid_model");

    const unsupported = await client.callTool({ name: "dispatch_task", arguments: { agent: "unknown", project: "canary-project", task: "read", model: "custom-local:step-5-preview" } });
    assert.equal(unsupported.isError, true);
    assert.match(unsupported.content[0].text, /unsupported_agent/);

    const unknown = await client.callTool({ name: "dispatch_task", arguments: { agent: "workbuddy", project: "unknown", task: "read", model: "custom-local:step-5-preview" } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown_project/);
  } finally {
    await client?.close();
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------- P5 只读数据面（蓝图 §12.4 / IMPLEMENTATION §9.2–9.4，D1-a 认证） ----------

function fakeSnapshot(jobId, status) {
  return {
    job_id: jobId,
    status,
    schema_version: 2,
    revision: 1,
    updated_at: "2026-10-04T10:00:00.000Z",
    agent: "workbuddy",
    project: "canary-project",
    usage: null,
  };
}

// 只读假 dispatcher：listBoard 完全可控（注入 revision 变化），并计数调用（close 清理断言用）。
function createFakeBoardDispatcher(initialJobs) {
  const state = { jobs: initialJobs, listBoardCalls: 0 };
  return {
    get listBoardCalls() { return state.listBoardCalls; },
    currentJobs() { return state.jobs.map((job) => ({ ...job })); },
    bumpRevision(jobId) {
      const job = state.jobs.find((item) => item.job_id === jobId);
      if (job) job.revision += 1;
    },
    async listBoard() {
      state.listBoardCalls += 1;
      return { jobs: state.jobs.map((job) => ({ ...job })), truncated: false, total: state.jobs.length };
    },
  };
}

test("P5: the read-only routes are closed (404) when no read token is configured", async () => {
  const token = randomBytes(32).toString("base64url");
  const dispatcher = createFakeBoardDispatcher([fakeSnapshot("job-a", "RUNNING")]);
  const server = await startHttpMcpServer({ dispatcher, bearerToken: token, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/api/jobs", "/events", "/board"]) {
      const anonymous = await fetch(`${base}${path}`);
      assert.equal(anonymous.status, 404, `${path} must be invisible without a configured read token`);
      const withBearer = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(withBearer.status, 404, `${path} stays closed for the main bearer too`);
      const post = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      assert.equal(post.status, 404, `${path} stays closed for non-GET as well`);
    }
    const foreign = await fetch(`${base}/other`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(foreign.status, 404, "non-whitelisted paths keep the 404 posture");
  } finally {
    await closeServer(server);
  }
});

test("P5: the read-only routes accept the query read token or the main bearer and reject everything else", async () => {
  const token = randomBytes(32).toString("base64url");
  const readToken = randomBytes(32).toString("base64url");
  const dispatcher = createFakeBoardDispatcher([fakeSnapshot("job-a", "RUNNING"), fakeSnapshot("job-b", "COMPLETED")]);
  const server = await startHttpMcpServer({ dispatcher, bearerToken: token, readToken, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const anonymous = await fetch(`${base}/api/jobs`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Bearer$/i);

    const wrongQuery = await fetch(`${base}/api/jobs?read_token=not-the-token`);
    assert.equal(wrongQuery.status, 401);
    const shortQuery = await fetch(`${base}/api/jobs?read_token=too-short`);
    assert.equal(shortQuery.status, 401);
    const wrongBearer = await fetch(`${base}/api/jobs`, { headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` } });
    assert.equal(wrongBearer.status, 401);

    const foreignOrigin = await fetch(`${base}/api/jobs?read_token=${readToken}`, { headers: { origin: "https://foreign.example" } });
    assert.equal(foreignOrigin.status, 403);

    const post = await fetch(`${base}/api/jobs?read_token=${readToken}`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.match(post.headers.get("allow") ?? "", /GET/i);

    const byQuery = await fetch(`${base}/api/jobs?read_token=${readToken}`);
    assert.equal(byQuery.status, 200);
    const board = await byQuery.json();
    assert.deepEqual(board, { jobs: dispatcher.currentJobs(), truncated: false, total: 2 });
    assert.equal(typeof board.jobs[0].revision, "number");

    const byBearer = await fetch(`${base}/api/jobs`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(byBearer.status, 200);
    assert.equal((await byBearer.json()).total, 2);

    const eventsUnauthorized = await fetch(`${base}/events?read_token=wrong`);
    assert.equal(eventsUnauthorized.status, 401);

    const page = await fetch(`${base}/board?read_token=${readToken}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    const html = await page.text();
    assert.match(html, /<title>DLZ看板<\/title>/);
    assert.match(html, /read_token/);
  } finally {
    await closeServer(server);
  }
});

test("P5: SSE /events pushes the first full frame, only revision diffs and heartbeats, and cleans up on close", async () => {
  const token = randomBytes(32).toString("base64url");
  const readToken = randomBytes(32).toString("base64url");
  const dispatcher = createFakeBoardDispatcher([fakeSnapshot("job-a", "RUNNING"), fakeSnapshot("job-b", "COMPLETED")]);
  const server = await startHttpMcpServer({
    dispatcher,
    bearerToken: token,
    readToken,
    port: 0,
    ssePollIntervalMs: 40,
    sseHeartbeatIntervalMs: 300,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const response = await fetch(`${base}/events?read_token=${readToken}`, { signal: controller.signal });
  try {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(response.headers.get("cache-control") ?? "", /no-cache/);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const nextEvent = async () => {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith("data: ")) return { type: "data", payload: JSON.parse(frame.slice("data: ".length)) };
          if (frame.startsWith(":")) return { type: "comment", frame };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream ended unexpectedly");
        buffer += decoder.decode(value, { stream: true });
      }
    };

    // 首帧全量：连接后立即为每个 job 推一帧。
    const firstIds = [(await nextEvent()).payload.job_id, (await nextEvent()).payload.job_id];
    assert.deepEqual([...firstIds].sort(), ["job-a", "job-b"]);

    // 无 diff 不推：idle 后首个到达的帧必为心跳注释行（: hb <iso>），而非重复 data 帧。
    const heartbeat = await nextEvent();
    assert.equal(heartbeat.type, "comment");
    assert.match(heartbeat.frame, /^: hb \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // diff 才推：revision 变化只推该 job 一帧，帧形为 {"job_id","revision","snapshot"}。
    dispatcher.bumpRevision("job-a");
    const diff = await nextEvent();
    assert.equal(diff.type, "data");
    assert.deepEqual(Object.keys(diff.payload).sort(), ["job_id", "revision", "snapshot"]);
    assert.equal(diff.payload.job_id, "job-a");
    assert.equal(diff.payload.revision, 2);
    assert.equal(diff.payload.snapshot.job_id, "job-a");

    // close 清理：断开传播到服务端后轮询必须冻结（原速率 40ms/次，200ms 覆盖 5 个周期）。
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const callsAfterClose = dispatcher.listBoardCalls;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(dispatcher.listBoardCalls, callsAfterClose, "no poll timer may survive the client close");
  } finally {
    await closeServer(server);
  }
});
