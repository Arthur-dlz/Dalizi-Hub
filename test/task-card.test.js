import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Dispatcher } from "../src/dispatcher.js";
import { DispatcherError } from "../src/contracts.js";
import { JobStore } from "../src/job-store.js";
import { createMcpServer } from "../src/mcp-server.js";
import { TASK_CARD_MIME_TYPE, TASK_CARD_RESOURCE_URI, readTaskCardHtml } from "../src/task-card.js";

const FIXED_NOW = Date.parse("2026-09-26T16:00:10.000Z");
const SRC = (name) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

function stubRunner() {
  return {
    async run({ onStarted }) {
      await onStarted(4242);
      return { pid: 4242, status: "COMPLETED", finalText: "TASK_CARD_MARKER", error: null, actualModel: "test-model", diagnostics: null };
    },
  };
}

function createDispatcher(directory, runner = stubRunner()) {
  return new Dispatcher({
    registry: { resolve(project) { if (project !== "canary-project") throw new DispatcherError("unknown_project", "project is not registered"); return directory; } },
    allowedModels: { workbuddy: new Set(["custom-local:step-5-preview"]), codex: new Set(["gpt-6-sol"]) },
    store: new JobStore(path.join(directory, "jobs")),
    runner,
    codexRunner: runner,
  });
}

async function connect(dispatcher) {
  const server = createMcpServer(dispatcher);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dalizi-task-card-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function waitForTerminal(client, jobId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await client.callTool({ name: "get_task", arguments: { job_id: jobId } });
    const job = response.structuredContent;
    if (job.status === "COMPLETED" || job.status === "FAILED") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("task card test job did not finish");
}

function cardTask(overrides = {}) {
  return {
    job_id: "job-1",
    agent: "workbuddy",
    project: "canary-project",
    status: "RUNNING",
    created_at: "2026-09-26T15:59:00.000Z",
    started_at: "2026-09-26T16:00:00.000Z",
    finished_at: null,
    current_activity: "正在处理任务",
    requested_model: "custom-local:step-5-preview",
    effort: "high",
    final_text: null,
    error: null,
    ...overrides,
  };
}

async function makeCard({ openai, now = FIXED_NOW } = {}) {
  const html = await readTaskCardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, "the task card must embed exactly one inline script");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, textContent: "", className: "", hidden: false, disabled: false, checked: false, listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
      });
    }
    return elements.get(id);
  };
  const events = {};
  const outgoing = [];
  const intervals = new Map();
  let nextTimer = 1;
  const parent = { postMessage(packet) { outgoing.push(packet); } };
  const window = { parent, openai, addEventListener(name, callback) { events[name] = callback; } };
  class TestDate extends Date { static now() { return now; } }
  runInNewContext(script[1], {
    window,
    document: { getElementById: element },
    Date: TestDate,
    setTimeout: () => nextTimer++,
    clearTimeout() {},
    setInterval: (callback) => { const id = nextTimer++; intervals.set(id, callback); return id; },
    clearInterval: (id) => { intervals.delete(id); },
  });
  const receive = (packet) => events.message({ source: parent, data: { jsonrpc: "2.0", ...packet } });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  const start = async () => {
    receive({ id: outgoing[0].id, result: { hostCapabilities: { serverTools: {} } } });
    await settle();
  };
  const toolCalls = () => outgoing.filter((packet) => packet.method === "tools/call");
  const tick = () => { for (const callback of [...intervals.values()]) callback(); };
  return { element, outgoing, intervals, receive, settle, start, toolCalls, tick };
}

// Retired PoC-only identifiers, assembled from fragments so that a repository-wide
// search for the removed demo identifiers stays clean.
const RETIRED_POC_TOKENS = ["reset" + "_demo" + "_task", "demo" + "-task-001", "COMPLETE" + "_AFTER_MS", "demo" + "StartedAt"];

test("the UI resource constants, Chinese copy, and Dispatcher field mapping are production-correct", async () => {
  assert.equal(TASK_CARD_RESOURCE_URI, "ui://dalizi-dispatcher/task-card.html");
  assert.equal(TASK_CARD_MIME_TYPE, "text/html;profile=mcp-app");

  const html = await readTaskCardHtml();
  assert.match(html, /<html lang="zh-CN">/);
  for (const copy of [
    "大力子任务卡", "执行 Agent", "项目", "已运行", "当前活动", "模型", "思考强度", "最后更新", "结果",
    "刷新", "自动刷新（3秒）", "任务排队中，状态将自动刷新。", "任务执行中，状态将自动刷新。", "任务已结束，自动刷新已停止。",
  ]) {
    assert.ok(html.includes(copy), `missing Chinese copy: ${copy}`);
  }
  for (const id of ["agent", "project", "status", "elapsed", "current_activity", "requested_model", "effort", "last_updated", "result"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing element id: ${id}`);
  }
  for (const field of ["created_at", "started_at", "finished_at", "current_activity", "requested_model", "effort", "final_text", "error"]) {
    assert.ok(html.includes(field), `missing Dispatcher job field mapping: ${field}`);
  }
  // the card refreshes through the production read tool only
  assert.match(html, /name: 'get_task'/);
  assert.doesNotMatch(html, /dispatch_task|render_task_card/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|<img[^>]+src=/i);
});

test("no retired PoC demo or reset logic is migrated into production sources", async () => {
  const sources = await Promise.all(["task-card.js", "task-card.html", "mcp-server.js"].map((name) => readFile(SRC(name), "utf8")));
  for (const source of sources) {
    for (const token of RETIRED_POC_TOKENS) {
      assert.ok(!source.includes(token), `retired PoC identifier leaked into production source: ${token}`);
    }
    assert.doesNotMatch(source, /demo/i);
  }
});

test("render_task_card is registered read-only, serves the resource, and mirrors get_task", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-task-card-"));
  const { client, server } = await connect(createDispatcher(directory));
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["dispatch_task", "get_task", "render_task_card"]);
    assert.equal(tools.tools.some((tool) => tool.name.startsWith("reset")), false);
    const getTool = tools.tools.find((tool) => tool.name === "get_task");
    const cardTool = tools.tools.find((tool) => tool.name === "render_task_card");
    assert.deepEqual(cardTool.inputSchema, getTool.inputSchema);
    assert.deepEqual(JSON.parse(JSON.stringify(cardTool.inputSchema.properties.job_id)), { type: "string", maxLength: 128 });
    assert.equal(cardTool._meta.ui.resourceUri, TASK_CARD_RESOURCE_URI);
    assert.equal(cardTool.annotations.readOnlyHint, true);

    const resources = await client.listResources();
    assert.equal(resources.resources.length, 1);
    const [resource] = resources.resources;
    assert.equal(resource.uri, TASK_CARD_RESOURCE_URI);
    assert.equal(resource.mimeType, TASK_CARD_MIME_TYPE);
    assert.deepEqual(JSON.parse(JSON.stringify(resource._meta.ui.csp)), { connectDomains: [], resourceDomains: [] });
    const read = await client.readResource({ uri: TASK_CARD_RESOURCE_URI });
    assert.equal(read.contents.length, 1);
    assert.equal(read.contents[0].uri, TASK_CARD_RESOURCE_URI);
    assert.equal(read.contents[0].mimeType, TASK_CARD_MIME_TYPE);
    assert.equal(read.contents[0].text, await readTaskCardHtml());
    assert.ok(read.contents[0].text.includes("大力子任务卡"));

    const receipt = JSON.parse((await client.callTool({
      name: "dispatch_task",
      arguments: { agent: "workbuddy", project: "canary-project", task: "read marker", model: "custom-local:step-5-preview", effort: "high" },
    })).content[0].text);
    const job = await waitForTerminal(client, receipt.job_id);
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.final_text, "TASK_CARD_MARKER");
    assert.equal(job.requested_model, "custom-local:step-5-preview");
    assert.equal(job.effort, "high");
    assert.equal(typeof job.created_at, "string");
    assert.equal(typeof job.started_at, "string");
    assert.equal(typeof job.finished_at, "string");

    const rendered = await client.callTool({ name: "render_task_card", arguments: { job_id: receipt.job_id } });
    const fetched = await client.callTool({ name: "get_task", arguments: { job_id: receipt.job_id } });
    assert.equal(rendered.isError, undefined);
    assert.deepEqual(rendered.structuredContent, job);
    assert.deepEqual(rendered.structuredContent, fetched.structuredContent);
    assert.equal(rendered.content[0].type, "text");
    assert.deepEqual(JSON.parse(rendered.content[0].text), fetched.structuredContent);

    const unknownCard = await client.callTool({ name: "render_task_card", arguments: { job_id: "missing-job" } });
    const unknownGet = await client.callTool({ name: "get_task", arguments: { job_id: "missing-job" } });
    assert.equal(unknownCard.isError, true);
    assert.equal(unknownGet.isError, true);
    assert.equal(unknownCard.content[0].text, unknownGet.content[0].text);
    assert.ok(!unknownCard.structuredContent, "an unknown job must not return structured content");
    const payload = JSON.parse(unknownCard.content[0].text);    assert.deepEqual(Object.keys(payload), ["error"]);
    assert.equal(payload.error.code, "unknown_job");

    // the real persisted job renders onto the visible card fields
    const card = await makeCard();
    await card.start();
    card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: job.job_id } } });
    card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: job } });
    await card.settle();
    assert.equal(card.element("agent").textContent, "workbuddy");
    assert.equal(card.element("project").textContent, "canary-project");
    assert.equal(card.element("requested_model").textContent, "custom-local:step-5-preview");
    assert.equal(card.element("effort").textContent, "high");
    assert.equal(card.element("current_activity").textContent, "—");
    assert.equal(card.element("status").textContent, "COMPLETED");
    assert.equal(card.element("result").textContent, "TASK_CARD_MARKER");
    assert.equal(card.element("result_block").hidden, false);
    assert.equal(card.intervals.size, 0);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the card computes 已运行 from (started_at ?? created_at) to (finished_at ?? now)", async () => {
  const fallback = await makeCard();
  await fallback.start();
  fallback.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  fallback.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ created_at: "2026-09-26T16:00:00.000Z", started_at: null }) } });
  await fallback.settle();
  assert.equal(fallback.element("elapsed").textContent, "10s");
  assert.equal(fallback.element("last_updated").textContent, "2026-09-26 16:00:00Z");

  const running = await makeCard();
  await running.start();
  running.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  running.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ created_at: "2026-09-26T15:58:00.000Z", started_at: "2026-09-26T15:58:40.000Z" }) } });
  await running.settle();
  assert.equal(running.element("elapsed").textContent, "1m 30s");
  assert.equal(running.element("last_updated").textContent, "2026-09-26 15:58:40Z");

  const frozen = await makeCard({ now: Date.parse("2026-09-26T16:30:00.000Z") });
  await frozen.start();
  frozen.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  frozen.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "COMPLETED", finished_at: "2026-09-26T16:00:10.000Z" }) } });
  await frozen.settle();
  assert.equal(frozen.element("elapsed").textContent, "10s");
  assert.equal(frozen.element("last_updated").textContent, "2026-09-26 16:00:10Z");

  const absent = await makeCard();
  await absent.start();
  absent.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  absent.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ created_at: null, started_at: null, finished_at: null }) } });
  await absent.settle();
  assert.equal(absent.element("elapsed").textContent, "—");
  assert.equal(absent.element("last_updated").textContent, "—");
});

test("the card tolerates missing optional Dispatcher fields and prefers error over final_text", async () => {
  const minimal = await makeCard();
  await minimal.start();
  minimal.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-x" } } });
  minimal.receive({ method: "ui/notifications/tool-result", params: { structuredContent: { job_id: "job-x", status: "QUEUED" } } });
  await minimal.settle();
  for (const id of ["agent", "project", "current_activity", "requested_model", "effort", "elapsed", "last_updated"]) {
    assert.equal(minimal.element(id).textContent, "—", `${id} must fall back to a placeholder`);
  }
  assert.equal(minimal.element("status").textContent, "QUEUED");
  assert.equal(minimal.element("result_block").hidden, true);
  assert.equal(minimal.intervals.size, 1);

  const failed = await makeCard();
  await failed.start();
  failed.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  failed.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "FAILED", error: "dispatcher_error: boom", final_text: "must not win" }) } });
  await failed.settle();
  assert.equal(failed.element("result").textContent, "dispatcher_error: boom");
  assert.equal(failed.element("result_block").hidden, false);
  assert.equal(failed.intervals.size, 0);

  const mismatched = await makeCard();
  await mismatched.start();
  mismatched.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  mismatched.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ job_id: "other-job" }) } });
  await mismatched.settle();
  assert.equal(mismatched.element("status").textContent, "", "a payload for another job must be ignored");
  assert.equal(mismatched.element("agent").textContent, "");
  assert.equal(mismatched.intervals.size, 0);
});

test("the card auto-refreshes non-terminal jobs every 3s, keeps one interval, and stops on terminal", async () => {
  const card = await makeCard();
  assert.equal(card.outgoing[0].method, "ui/initialize");
  assert.equal(card.outgoing[0].params.appInfo.name, "Dalizi Task Card");
  assert.equal(card.outgoing[0].params.protocolVersion, "2026-01-26");
  await card.start();
  assert.equal(card.outgoing[1].method, "ui/notifications/initialized");
  assert.equal(card.toolCalls().length, 0);

  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "QUEUED" }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "QUEUED");
  assert.equal(card.element("auto_refresh").checked, true);
  assert.equal(card.element("auto_refresh").disabled, false);
  assert.equal(card.intervals.size, 1);
  assert.equal(card.element("message").textContent, "任务排队中，状态将自动刷新。");

  // duplicate change events must not create a second interval
  card.element("auto_refresh").listeners.change();
  assert.equal(card.intervals.size, 1);

  // one automatic tick calls the production read tool exactly once
  card.tick();
  assert.equal(card.toolCalls().length, 1);
  assert.equal(card.toolCalls()[0].params.name, "get_task");
  assert.deepEqual(JSON.parse(JSON.stringify(card.toolCalls()[0].params.arguments)), { job_id: "job-1" });

  // busy guard: a second tick while the first call is unresolved must not stack
  card.tick();
  assert.equal(card.toolCalls().length, 1);

  card.receive({ id: card.toolCalls()[0].id, result: { structuredContent: cardTask({ status: "RUNNING" }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");
  assert.equal(card.element("message").textContent, "任务执行中，状态将自动刷新。");
  assert.equal(card.intervals.size, 1);

  // manual refresh works while auto-refresh is on and keeps a single interval
  card.element("refresh").listeners.click();
  assert.equal(card.toolCalls().length, 2);
  card.receive({ id: card.toolCalls()[1].id, result: { structuredContent: cardTask({ status: "RUNNING" }) } });
  await card.settle();
  assert.equal(card.intervals.size, 1);

  for (const status of ["COMPLETED", "FAILED", "CANCELLED"]) {
    card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
    card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING" }) } });
    await card.settle();
    assert.equal(card.intervals.size, 1, `${status}: auto-refresh must run while RUNNING`);
    card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status }) } });
    await card.settle();
    assert.equal(card.element("status").textContent, status);
    assert.equal(card.intervals.size, 0, `${status}: auto-refresh must stop`);
    assert.equal(card.element("auto_refresh").checked, false);
    assert.equal(card.element("auto_refresh").disabled, true);
    assert.equal(card.element("message").textContent, "任务已结束，自动刷新已停止。");
  }

  // teardown clears the live interval and neutralises an already-created tick
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING" }) } });
  await card.settle();
  assert.equal(card.intervals.size, 1);
  const [staleTimer] = [...card.intervals.values()];
  card.receive({ id: 99, method: "ui/resource-teardown", params: { reason: "test" } });
  assert.equal(card.intervals.size, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(card.outgoing.at(-1))), { jsonrpc: "2.0", id: 99, result: {} });
  const callsBeforeStaleTick = card.toolCalls().length;
  staleTimer();
  await card.settle();
  assert.equal(card.toolCalls().length, callsBeforeStaleTick);
  assert.equal(card.element("auto_refresh").checked, false);
});

test("the card falls back to the host bridge and still only reads get_task", async () => {
  const calls = [];
  const card = await makeCard({
    openai: { async callTool(name, args) { calls.push({ name, args }); return { structuredContent: cardTask({ status: "COMPLETED" }) }; } },
  });
  card.receive({ id: card.outgoing[0].id, result: { hostCapabilities: {} } });
  await card.settle();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.element("refresh").listeners.click();
  await card.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ name: "get_task", args: { job_id: "job-1" } }]);
  assert.equal(card.toolCalls().length, 0);
  assert.equal(card.element("status").textContent, "COMPLETED");
  assert.equal(card.intervals.size, 0);
});
