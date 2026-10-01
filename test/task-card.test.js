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
    revision: 1,
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
  const targets = [];
  const intervals = new Map();
  let nextTimer = 1;
  const parent = { postMessage(packet, targetOrigin) { outgoing.push(packet); targets.push(targetOrigin ?? null); } };
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
  const receive = (packet, origin) => events.message({ source: parent, origin, data: { jsonrpc: "2.0", ...packet } });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  const start = async () => {
    receive({ id: outgoing[0].id, result: { hostCapabilities: { serverTools: {} } } });
    await settle();
  };
  const toolCalls = () => outgoing.filter((packet) => packet.method === "tools/call");
  const tick = () => { for (const callback of [...intervals.values()]) callback(); };
  const enableAuto = (on = true) => { const box = element("auto_refresh"); box.checked = on; box.listeners.change(); };
  return { element, outgoing, targets, intervals, receive, settle, start, toolCalls, tick, events, parent, enableAuto };
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
    "大力子任务卡", "执行 Agent", "项目", "已运行", "当前活动", "模型", "思考强度", "最后更新", "心跳/观察", "用量", "结果",
    "刷新", "自动刷新（3秒）", "任务排队中，状态将自动刷新。", "任务执行中，状态将自动刷新。", "任务状态将自动刷新。",
    "任务排队中，可手动刷新或勾选自动刷新。", "任务执行中，可手动刷新或勾选自动刷新。", "任务状态可手动刷新，或勾选自动刷新。",
    "任务已结束，自动刷新已停止。", "正在加载任务…", "等待任务…", "不可观测（未收到用量指标）", "RECOVERY_REQUIRED",
    "刷新失败：", "已保留最后成功快照",
  ]) {
    assert.ok(html.includes(copy), `missing Chinese copy: ${copy}`);
  }
  for (const id of ["agent", "project", "status", "elapsed", "current_activity", "requested_model", "effort", "last_updated", "liveness", "usage", "result", "usage_block", "result_block", "refresh", "auto_refresh", "message"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing element id: ${id}`);
  }
  for (const field of ["created_at", "started_at", "finished_at", "current_activity", "requested_model", "effort", "final_text", "error", "revision", "updated_at", "activity", "liveness", "usage", "observed_at", "owner_heartbeat_at", "last_event_at", "last_output_at", "process_state"]) {
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
  for (const id of ["agent", "project", "current_activity", "requested_model", "effort", "elapsed", "last_updated", "liveness"]) {
    assert.equal(minimal.element(id).textContent, "—", `${id} must fall back to a placeholder`);
  }
  assert.equal(minimal.element("status").textContent, "QUEUED");
  assert.equal(minimal.element("result_block").hidden, true);
  assert.equal(minimal.element("usage_block").hidden, false);
  assert.equal(minimal.element("usage").textContent, "不可观测（未收到用量指标）");
  // 自动刷新默认关闭（A7：仅用户操作改变开关）
  assert.equal(minimal.element("auto_refresh").checked, false);
  assert.equal(minimal.element("auto_refresh").disabled, false);
  assert.equal(minimal.intervals.size, 0);
  assert.equal(minimal.element("message").textContent, "任务排队中，可手动刷新或勾选自动刷新。");

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
  assert.equal(mismatched.element("status").textContent, "—", "a payload for another job must be ignored");
  assert.equal(mismatched.element("agent").textContent, "—");
  assert.equal(mismatched.element("message").textContent, "正在加载任务…");
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
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "QUEUED", revision: 1 }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "QUEUED");
  // A7：自动刷新默认关闭，仅用户操作开启
  assert.equal(card.element("auto_refresh").checked, false);
  assert.equal(card.element("auto_refresh").disabled, false);
  assert.equal(card.intervals.size, 0);
  assert.equal(card.element("message").textContent, "任务排队中，可手动刷新或勾选自动刷新。");

  // 用户开启自动刷新 → 单一 interval，提示随实际状态切换
  card.enableAuto(true);
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

  card.receive({ id: card.toolCalls()[0].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 2 }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");
  assert.equal(card.element("message").textContent, "任务执行中，状态将自动刷新。");
  assert.equal(card.intervals.size, 1);

  // manual refresh works while auto-refresh is on and keeps a single interval
  card.element("refresh").listeners.click();
  assert.equal(card.toolCalls().length, 2);
  card.receive({ id: card.toolCalls()[1].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 3 }) } });
  await card.settle();
  assert.equal(card.intervals.size, 1);

  let revision = 3;
  for (const status of ["COMPLETED", "FAILED", "CANCELLED"]) {
    card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
    card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: revision + 1 }) } });
    await card.settle();
    revision += 1;
    assert.equal(card.intervals.size, 1, `${status}: auto-refresh must run while RUNNING`);
    card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status, revision: revision + 1 }) } });
    await card.settle();
    revision += 1;
    assert.equal(card.element("status").textContent, status);
    assert.equal(card.intervals.size, 0, `${status}: auto-refresh must stop`);
    // A7：终态停表但不清除用户开关状态，开关对用户不可用
    assert.equal(card.element("auto_refresh").checked, true, `${status}: snapshots must not rewrite the user toggle`);
    assert.equal(card.element("auto_refresh").disabled, true);
    assert.equal(card.element("message").textContent, "任务已结束，自动刷新已停止。");
    // 终态后仍可手动刷新（A7）
    assert.equal(card.element("refresh").disabled, false);
    const callsBeforeTerminalRefresh = card.toolCalls().length;
    card.element("refresh").listeners.click();
    assert.equal(card.toolCalls().length, callsBeforeTerminalRefresh + 1, `${status}: terminal manual refresh must issue a call`);
    card.receive({ id: card.toolCalls().at(-1).id, result: { structuredContent: cardTask({ status, revision: revision + 1 }) } });
    await card.settle();
    revision += 1;
    assert.equal(card.element("status").textContent, status);
    assert.equal(card.intervals.size, 0, `${status}: manual refresh at terminal must not restart auto-refresh`);
  }

  // teardown clears the live interval and neutralises an already-created tick
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: revision + 1 }) } });
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
  assert.equal(card.element("auto_refresh").checked, true, "dispose 只停表，不改写用户开关");
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

test("A7: 用户关闭自动刷新后，手动刷新收到 RUNNING 快照，开关保持关闭且无周期计时器", async () => {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: 1 }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");

  // 用户开启后显式关闭自动刷新
  card.enableAuto(true);
  assert.equal(card.intervals.size, 1);
  card.enableAuto(false);
  assert.equal(card.element("auto_refresh").checked, false);
  assert.equal(card.intervals.size, 0);

  // 手动刷新 → 收到 RUNNING 快照（蓝图 §10 A7 指定序列）
  card.element("refresh").listeners.click();
  assert.equal(card.toolCalls().length, 1);
  card.receive({ id: card.toolCalls()[0].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 2, current_activity: "仍在推进" }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");
  assert.equal(card.element("current_activity").textContent, "仍在推进");
  assert.equal(card.element("auto_refresh").checked, false, "非终态快照不得重新打开用户关闭的自动刷新");
  assert.equal(card.intervals.size, 0, "不得重建周期查询计时器");
  assert.equal(card.element("message").textContent, "任务执行中，可手动刷新或勾选自动刷新。");

  // 后续非终态快照（宿主推送）同样不得重新打开开关或重建计时器
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: 3 }) } });
  await card.settle();
  assert.equal(card.element("auto_refresh").checked, false);
  assert.equal(card.intervals.size, 0);
});

test("旧 revision、重复 revision、跨 job 与降级 v1 响应均不覆盖新状态", async () => {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: 5, current_activity: "第五步" }) } });
  await card.settle();
  assert.equal(card.element("current_activity").textContent, "第五步");

  // 乱序：更旧的 revision 不覆盖
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: 3, current_activity: "旧步骤" }) } });
  await card.settle();
  assert.equal(card.element("current_activity").textContent, "第五步", "旧 revision 响应不得覆盖");

  // 重复：相同 revision 不重放
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: 5, current_activity: "重复步骤" }) } });
  await card.settle();
  assert.equal(card.element("current_activity").textContent, "第五步");

  // 跨 job：不同 job_id 的响应不覆盖
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ job_id: "job-2", revision: 9, current_activity: "别的任务" }) } });
  await card.settle();
  assert.equal(card.element("current_activity").textContent, "第五步");

  // 降级：已接受 v2 后，无 revision 的 v1 响应不覆盖
  const v1 = cardTask({ status: "RUNNING", current_activity: "v1 步骤" });
  delete v1.revision;
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: v1 } });
  await card.settle();
  assert.equal(card.element("current_activity").textContent, "第五步");

  // 更新的 revision 正常覆盖
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "COMPLETED", revision: 6, final_text: "ok" }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "COMPLETED");
  assert.equal(card.element("result").textContent, "ok");
});

test("查询失败保留上次成功快照、显示错误与最后更新时间、可重试；不得渲染为 job 失败", async () => {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: 2, current_activity: "正在编译" }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");

  // 手动刷新 → 宿主返回协议错误 → 保留快照
  card.element("refresh").listeners.click();
  assert.equal(card.toolCalls().length, 1);
  card.receive({ id: card.toolCalls()[0].id, error: { message: "host bridge broken" } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING", "查询失败不得改写 job 状态");
  assert.equal(card.element("current_activity").textContent, "正在编译", "查询失败保留上次成功快照");
  assert.equal(
    card.element("message").textContent,
    `刷新失败：host bridge broken；已保留最后成功快照（更新于 ${card.element("last_updated").textContent}），可重试。`,
  );
  assert.equal(card.element("refresh").disabled, false, "失败后必须允许重试");
  assert.equal(card.element("result_block").hidden, true);

  // 重试成功 → 状态提示恢复
  card.element("refresh").listeners.click();
  assert.equal(card.toolCalls().length, 2);
  card.receive({ id: card.toolCalls()[1].id, result: { structuredContent: cardTask({ status: "COMPLETED", revision: 3, final_text: "done" }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "COMPLETED");
  assert.equal(card.element("result").textContent, "done");
  assert.equal(card.element("message").textContent, "任务已结束，自动刷新已停止。");
});

test("RECOVERY_REQUIRED 显著标识；usage/activity/liveness 诚实展示不编造", async () => {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-r" } } });
  card.receive({
    method: "ui/notifications/tool-result",
    params: {
      structuredContent: cardTask({
        job_id: "job-r",
        status: "RECOVERY_REQUIRED",
        revision: 4,
        current_activity: null,
        activity: null,
        liveness: { owner_heartbeat_at: null, process_checked_at: null, process_state: null, last_event_at: "2026-09-26T15:59:30.000Z", last_output_at: null },
        usage: {
          input_tokens: { value: null, unit: "tokens", unavailable_reason: "来源未提供" },
          output_tokens: { value: 120, unit: "tokens" },
          reasoning_tokens: null,
        },
      }),
    },
  });
  await card.settle();
  assert.equal(card.element("status").textContent, "RECOVERY_REQUIRED");
  assert.equal(card.element("status").className, "badge recovery");
  assert.match(card.element("message").textContent, /RECOVERY_REQUIRED/);
  assert.doesNotMatch(card.element("message").textContent, /将自动刷新|执行中/, "恢复状态不得表述为永久 RUNNING");
  assert.equal(card.element("current_activity").textContent, "—", "无活动观测不得编造");
  assert.equal(card.element("liveness").textContent, "事件 2026-09-26 15:59:30Z");
  assert.equal(card.element("usage_block").hidden, false);
  const usageText = card.element("usage").textContent;
  assert.match(usageText, /input_tokens：不可观测（来源未提供）/);
  assert.match(usageText, /output_tokens：120 tokens/);
  assert.match(usageText, /reasoning_tokens：不可观测/);

  // usage 整体缺失 → 不可观测；activity 有观测 → 显示步骤+观测时间
  const observed = await makeCard();
  await observed.start();
  observed.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  observed.receive({
    method: "ui/notifications/tool-result",
    params: {
      structuredContent: cardTask({
        status: "RUNNING",
        revision: 1,
        usage: null,
        activity: { kind: "tool", label: "正在检索", state: "active", observed_at: "2026-09-26T15:59:50.000Z" },
      }),
    },
  });
  await observed.settle();
  assert.equal(observed.element("usage").textContent, "不可观测（未收到用量指标）");
  assert.equal(observed.element("current_activity").textContent, "正在检索（观测于 2026-09-26 15:59:50Z）");
  assert.equal(observed.element("liveness").textContent, "—");
});

test("桥接收敛：结构/event.source 校验、首帧运行时固定 origin、targetOrigin 收紧", async () => {
  const card = await makeCard();
  // 固定前：目标 origin 过渡使用 '*'
  assert.equal(card.targets[0], "*");
  await card.start();
  assert.equal(card.targets[1], "*");

  // event.source 不是 window.parent → 忽略（可观测证据：消息未进入处理分支）
  card.events.message({ source: { imposter: true }, data: { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } } });
  assert.equal(card.element("message").textContent, "等待任务…");

  // 非法结构（非 jsonrpc 封套）→ 忽略
  card.events.message({ source: card.parent, data: { method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } } });
  assert.equal(card.element("message").textContent, "等待任务…");

  // 首个合法封套：运行时固定宿主 origin（T0 §3.2：origin 不可静态枚举）
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } }, "https://host.example");
  assert.equal(card.element("message").textContent, "正在加载任务…");
  assert.equal(card.element("refresh").disabled, false);

  // 固定后：发送 targetOrigin 收紧为固定值
  card.element("refresh").listeners.click();
  assert.equal(card.targets.at(-1), "https://host.example");

  // 偏离固定 origin 的宿主消息被丢弃
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: 1 }) } }, "https://evil.example");
  await card.settle();
  assert.equal(card.element("status").textContent, "—");

  // 与固定 origin 一致的响应正常接受
  card.receive({ id: card.toolCalls()[0].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 1 }) } }, "https://host.example");
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");

  // opaque origin（"null"）可固定用于接收校验，但不能作为 targetOrigin → 过渡保留 '*'
  const opaque = await makeCard();
  await opaque.start();
  opaque.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } }, "null");
  assert.equal(opaque.element("message").textContent, "正在加载任务…");
  opaque.element("refresh").listeners.click();
  assert.equal(opaque.targets.at(-1), "*");
  opaque.receive({ id: opaque.toolCalls()[0].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 1 }) } }, "null");
  await opaque.settle();
  assert.equal(opaque.element("status").textContent, "RUNNING");
});

// 结果区缩略 + 就地展开（微卡 T4-ux）
async function renderResult(text, { jobId = "job-1", revision = 1, status = "COMPLETED" } = {}) {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: jobId } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ job_id: jobId, status, revision, final_text: text }) } });
  await card.settle();
  return card;
}

test("结果区阈值：>500 字符或 >8 行才可折叠（边界矩阵）", async () => {
  const cases = [
    { name: "500 字符整（单行）", text: "a".repeat(500), collapsible: false },
    { name: "501 字符（单行）", text: "a".repeat(501), collapsible: true },
    { name: "8 行整（总长 <500）", text: Array.from({ length: 8 }, () => "b".repeat(10)).join("\n"), collapsible: false },
    { name: "9 行", text: Array.from({ length: 9 }, () => "b".repeat(10)).join("\n"), collapsible: true },
  ];
  for (const { name, text, collapsible } of cases) {
    const card = await renderResult(text);
    assert.equal(card.element("result_block").hidden, false, name);
    assert.equal(card.element("result_toggle").hidden, !collapsible, `${name}: 折叠按钮可见性`);
    if (collapsible) {
      assert.notEqual(card.element("result").textContent, text, `${name}: 可折叠时应缩略`);
      assert.equal(card.element("result_toggle").textContent, `展开全文（共 ${text.length} 字符）`);
    } else {
      assert.equal(card.element("result").textContent, text, `${name}: 短文本逐字节一致`);
    }
  }
});

test("缩略预览：在不超过 500 的最后一个换行处截断；无换行则硬截 500", async () => {
  // 前 500 字符内最后一个换行在索引 400 → 在换行处截断（不含换行）
  const withBreak = await renderResult("a".repeat(400) + "\n" + "b".repeat(300));
  assert.equal(withBreak.element("result").textContent, "a".repeat(400) + " …");
  assert.equal(withBreak.element("result_toggle").textContent, "展开全文（共 701 字符）");

  // 无换行 → 硬截前 500 字符
  const hard = await renderResult("x".repeat(600));
  assert.equal(hard.element("result").textContent, "x".repeat(500) + " …");
  assert.equal(hard.element("result_toggle").textContent, "展开全文（共 600 字符）");
});

test("就地展开：渲染全文并挂载滚动容器类；收起回到缩略", async () => {
  const text = "y".repeat(600);
  const card = await renderResult(text);
  assert.equal(card.element("result").className, "");
  assert.equal(card.element("result").textContent, "y".repeat(500) + " …");

  card.element("result_toggle").listeners.click();
  assert.equal(card.element("result").textContent, text);
  assert.equal(card.element("result").className, "expanded");
  assert.equal(card.element("result_toggle").textContent, "收起");

  card.element("result_toggle").listeners.click();
  assert.equal(card.element("result").textContent, "y".repeat(500) + " …");
  assert.equal(card.element("result").className, "");
  assert.equal(card.element("result_toggle").textContent, "展开全文（共 600 字符）");
});

test("同 job_id 刷新保持展开与 scrollTop；切换 job_id 回到缩略默认", async () => {
  const text = "z".repeat(700);
  const card = await renderResult(text);
  card.element("result_toggle").listeners.click();
  assert.equal(card.element("result").className, "expanded");
  card.element("result").scrollTop = 321;

  // 同 job_id 快照刷新（revision 递增）→ 保持展开状态与滚动位置
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "COMPLETED", revision: 2, final_text: text }) } });
  await card.settle();
  assert.equal(card.element("result").textContent, text, "刷新后仍显示全文");
  assert.equal(card.element("result").className, "expanded", "刷新后保持展开");
  assert.equal(card.element("result").scrollTop, 321, "刷新后恢复滚动位置");

  // 切换到不同 job_id → 缩略默认（无展开、无滚动记忆）
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-2" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ job_id: "job-2", status: "COMPLETED", revision: 1, final_text: text }) } });
  await card.settle();
  assert.equal(card.element("result").textContent, "z".repeat(500) + " …");
  assert.equal(card.element("result").className, "");
  assert.equal(card.element("result").scrollTop, 0);
  assert.equal(card.element("result_toggle").textContent, "展开全文（共 700 字符）");
});

test("短文本：无折叠按钮，textContent 与现状逐字节一致", async () => {
  const text = "短结果：一行搞定。";
  const card = await renderResult(text);
  assert.equal(card.element("result").textContent, text);
  assert.equal(card.element("result").className, "");
  assert.equal(card.element("result_toggle").hidden, true);
  assert.equal(card.element("result_toggle").textContent, "");
  // 点击不可见按钮无副作用（非折叠文本不改变渲染）
  card.element("result_toggle").listeners.click();
  assert.equal(card.element("result").textContent, text);
});

test("空结果：result_block 保持隐藏且无折叠按钮", async () => {
  const card = await renderResult("", { status: "COMPLETED" });
  assert.equal(card.element("result_block").hidden, true);
  assert.equal(card.element("result").textContent, "");
  assert.equal(card.element("result_toggle").hidden, true);
});

