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
import { TASK_CARD_MIME_TYPE, TASK_CARD_RESOURCE_URI, readTaskCardHtml, BOARD_MIME_TYPE, BOARD_RESOURCE_URI, BOARD_HTTP_ORIGIN, readBoardHtml } from "../src/task-card.js";

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
        id, textContent: "", className: "", hidden: false, disabled: false, checked: false, scrollTop: 0,
        offsetWidth: 0, offsetHeight: 0, listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
      });
    }
    return elements.get(id);
  };
  const events = {};
  const outgoing = [];
  const targets = [];
  const intervals = new Map(); // 数据轮询计时器（3s，refresh 回调）
  const elapsedIntervals = new Map(); // 走秒计时器（1s，dlzTimerKind === "elapsed"）
  const timeouts = new Map(); // setTimeout 全部收集（send 超时 / size 去抖），不在桩内自动执行
  const observers = []; // ResizeObserver 实例
  const hostVars = new Map(); // 宿主注入的 CSS 变量（--cb-* 等）
  let nextTimer = 1;
  const parent = { postMessage(packet, targetOrigin) { outgoing.push(packet); targets.push(targetOrigin ?? null); } };
  const documentElement = {
    dataset: {},
    style: { setProperty(name, value) { hostVars.set(name, value); } },
  };
  const window = { parent, openai, addEventListener(name, callback) { events[name] = callback; } };
  let nowMs = now;
  class TestDate extends Date { static now() { return nowMs; } }
  class TestResizeObserver {
    constructor(callback) { this.callback = callback; this.observed = new Set(); this.disconnected = false; observers.push(this); }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.disconnected = true; }
    trigger() { this.callback(); }
  }
  runInNewContext(script[1], {
    window,
    document: { getElementById: element, documentElement },
    Date: TestDate,
    ResizeObserver: TestResizeObserver,
    setTimeout: (callback) => { const id = nextTimer++; timeouts.set(id, callback); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval: (callback) => {
      const id = nextTimer++;
      if (callback && callback.dlzTimerKind === "elapsed") elapsedIntervals.set(id, callback);
      else intervals.set(id, callback);
      return id;
    },
    clearInterval: (id) => { intervals.delete(id); elapsedIntervals.delete(id); },
  });
  const receive = (packet, origin) => events.message({ source: parent, origin, data: { jsonrpc: "2.0", ...packet } });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  const start = async (initResult = { hostCapabilities: { serverTools: {} } }) => {
    receive({ id: outgoing[0].id, result: initResult });
    await settle();
  };
  const toolCalls = () => outgoing.filter((packet) => packet.method === "tools/call");
  const resourceReads = () => outgoing.filter((packet) => packet.method === "resources/read"); // CH1 资源读探测/轮询包
  const sizeReports = () => outgoing.filter((packet) => packet.method === "ui/notifications/size-changed");
  const tick = () => { for (const callback of [...intervals.values()]) callback(); };
  const elapsedTick = () => { for (const callback of [...elapsedIntervals.values()]) callback(); };
  const flushTimeouts = () => { for (const callback of [...timeouts.values()]) callback(); timeouts.clear(); };
  const enableAuto = (on = true) => { const box = element("auto_refresh"); box.checked = on; box.listeners.change(); };
  return { element, outgoing, targets, intervals, elapsedIntervals, timeouts, observers, hostVars, documentElement, receive, settle, start, toolCalls, resourceReads, sizeReports, tick, elapsedTick, flushTimeouts, events, parent, enableAuto, advance(ms) { nowMs += ms; } };
}

// Retired PoC-only identifiers, assembled from fragments so that a repository-wide
// search for the removed demo identifiers stays clean.
const RETIRED_POC_TOKENS = ["reset" + "_demo" + "_task", "demo" + "-task-001", "COMPLETE" + "_AFTER_MS", "demo" + "StartedAt"];

// CH1 降级引导：模拟宿主未实现 resources/read 线名（method not found；app.readServerResource 仅为 SDK 库入口名）——首次资源探测失败 →
// 本会话内永久降级 tools/call get_task；降级后立即以工具路径完成本次刷新，功能不缺失。
// 供沿用 CH1 前 get_task 断言的既有用例使用（降级路径覆盖）。
async function downgradeCardToToolChannel(card, snapshot) {
  card.element("refresh").listeners.click();
  assert.equal(card.resourceReads().length, 1, "首次 refresh 必须先探测资源通道");
  card.receive({ id: card.resourceReads()[0].id, error: { message: "Method not found" } });
  await card.settle();
  assert.equal(card.toolCalls().length, 1, "降级必须立即转 tools/call 完成本次刷新");
  assert.equal(card.toolCalls()[0].params.name, "get_task");
  card.receive({ id: card.toolCalls()[0].id, result: { structuredContent: snapshot } });
  await card.settle();
}

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
  // CH1 双路径在码（蓝图 §12.1）：资源优先 resources/read（SDK 线名）读 dlz://job/{job_id}；
  // 探测失败本会话内永久降级 tools/call get_task（行为断言见 CH1 新增用例）。
  assert.match(html, /send\('resources\/read'/);
  assert.match(html, /'dlz:\/\/job\//);
  assert.match(html, /resourceChannel = false/);
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
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["dispatch_task", "get_task", "render_board", "render_task_card"]);
    assert.equal(tools.tools.some((tool) => tool.name.startsWith("reset")), false);
    const getTool = tools.tools.find((tool) => tool.name === "get_task");
    const cardTool = tools.tools.find((tool) => tool.name === "render_task_card");
    const boardTool = tools.tools.find((tool) => tool.name === "render_board");
    assert.deepEqual(cardTool.inputSchema, getTool.inputSchema);
    assert.deepEqual(JSON.parse(JSON.stringify(cardTool.inputSchema.properties.job_id)), { type: "string", maxLength: 128 });
    assert.equal(cardTool._meta.ui.resourceUri, TASK_CARD_RESOURCE_URI);
    assert.equal(cardTool.annotations.readOnlyHint, true);
    // P5 CH3：render_board 为新增只读工具，绑定 board UI 资源；不替代 render_task_card
    assert.equal(boardTool._meta.ui.resourceUri, BOARD_RESOURCE_URI);
    assert.equal(boardTool.annotations.readOnlyHint, true);

    // P5 CH3：固定资源三条（task-card UI + board UI + dlz://board）；单任务卡 meta 零改动
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 3);
    const cardResource = resources.resources.find((resource) => resource.uri === TASK_CARD_RESOURCE_URI);
    assert.ok(cardResource, "单任务卡资源必须保留");
    assert.equal(cardResource.mimeType, TASK_CARD_MIME_TYPE);
    assert.deepEqual(JSON.parse(JSON.stringify(cardResource._meta.ui.csp)), { connectDomains: [], resourceDomains: [] });
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
  // CH1：首次资源探测被宿主拒绝（method not found）→ 本会话永久降级 tools/call；
  // 以下断言即降级后的 get_task 兜底语义（CH1 前行为零回退）。
  await downgradeCardToToolChannel(card, cardTask({ status: "QUEUED", revision: 1 }));
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
  // （CH1 降级引导已产生第 1 次 get_task；此处为降级后的轮询调用）
  card.tick();
  assert.equal(card.toolCalls().length, 2);
  assert.equal(card.toolCalls()[1].params.name, "get_task");
  assert.deepEqual(JSON.parse(JSON.stringify(card.toolCalls()[1].params.arguments)), { job_id: "job-1" });

  // busy guard: a second tick while the first call is unresolved must not stack
  card.tick();
  assert.equal(card.toolCalls().length, 2);

  card.receive({ id: card.toolCalls()[1].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 2 }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");
  assert.equal(card.element("message").textContent, "任务执行中，状态将自动刷新。");
  assert.equal(card.intervals.size, 1);

  // manual refresh works while auto-refresh is on and keeps a single interval
  card.element("refresh").listeners.click();
  assert.equal(card.toolCalls().length, 3);
  card.receive({ id: card.toolCalls()[2].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 3 }) } });
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
  // CH1：宿主未实现资源通道 → 首次探测失败即永久降级 tools/call；初始 RUNNING 快照经降级引导装载
  await downgradeCardToToolChannel(card, cardTask({ status: "RUNNING", revision: 1 }));
  assert.equal(card.element("status").textContent, "RUNNING");

  // 用户开启后显式关闭自动刷新
  card.enableAuto(true);
  assert.equal(card.intervals.size, 1);
  card.enableAuto(false);
  assert.equal(card.element("auto_refresh").checked, false);
  assert.equal(card.intervals.size, 0);

  // 手动刷新 → 收到 RUNNING 快照（蓝图 §10 A7 指定序列；降级引导已产生 1 次 get_task）
  card.element("refresh").listeners.click();
  assert.equal(card.toolCalls().length, 2);
  card.receive({ id: card.toolCalls()[1].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 2, current_activity: "仍在推进" }) } });
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
  // CH1：宿主未实现资源通道 → 永久降级 tools/call；初始 RUNNING 快照经降级引导装载
  await downgradeCardToToolChannel(card, cardTask({ status: "RUNNING", revision: 2, current_activity: "正在编译" }));
  assert.equal(card.element("status").textContent, "RUNNING");

  // 手动刷新 → 宿主返回协议错误 → 保留快照（降级引导已产生 1 次 get_task）
  card.element("refresh").listeners.click();
  assert.equal(card.toolCalls().length, 2);
  card.receive({ id: card.toolCalls()[1].id, error: { message: "host bridge broken" } });
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
  assert.equal(card.toolCalls().length, 3);
  card.receive({ id: card.toolCalls()[2].id, result: { structuredContent: cardTask({ status: "COMPLETED", revision: 3, final_text: "done" }) } });
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

  // 固定后：发送 targetOrigin 收紧为固定值（CH1 资源探测包同样收紧）
  card.element("refresh").listeners.click();
  assert.equal(card.targets.at(-1), "https://host.example");
  const [probe] = card.resourceReads();
  assert.equal(probe.params.uri, "dlz://job/job-1");

  // 偏离固定 origin 的宿主消息被丢弃（含对资源探测包的冒名响应）
  card.receive({ id: probe.id, error: { message: "Method not found" } }, "https://evil.example");
  await card.settle();
  assert.equal(card.resourceReads().length, 1, "偏离 origin 的响应不得结算 pending");
  assert.equal(card.toolCalls().length, 0, "探测未结算：不得降级");

  // 与固定 origin 一致的 method-not-found → 永久降级 tools/call，响应正常接受
  card.receive({ id: probe.id, error: { message: "Method not found" } }, "https://host.example");
  await card.settle();
  assert.equal(card.toolCalls().length, 1);
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
  // CH1：opaque 宿主的资源探测合法响应（contents JSON 文本）→ 走 showTask 渲染
  assert.deepEqual(JSON.parse(JSON.stringify(opaque.resourceReads()[0].params)), { uri: "dlz://job/job-1" });
  opaque.receive(
    { id: opaque.resourceReads()[0].id, result: { contents: [{ uri: "dlz://job/job-1", mimeType: "application/json", text: JSON.stringify(cardTask({ status: "RUNNING", revision: 1 })) }] } },
    "null",
  );
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

// P5 UX1 新增用例 ————————————————————————————————

test("走秒解耦：非终态 1s 走秒、终态停表、两个计时器与 dispose/pagehide 清理", async () => {
  const card = await makeCard({ now: Date.parse("2026-09-26T16:00:00.000Z") });
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: 1, started_at: "2026-09-26T15:59:30.000Z" }) } });
  await card.settle();
  assert.equal(card.element("elapsed").textContent, "30s");

  // 非终态：走秒计时器独立启动，数据轮询 map 不受影响（未开自动刷新 → 0）
  assert.equal(card.elapsedIntervals.size, 1);
  assert.equal(card.intervals.size, 0);
  assert.equal(card.toolCalls().length, 0);

  // 每秒仅重算已运行文本，不触发查询
  card.advance(1000);
  card.elapsedTick();
  assert.equal(card.element("elapsed").textContent, "31s");
  card.advance(59000);
  card.elapsedTick();
  assert.equal(card.element("elapsed").textContent, "1m 30s");
  assert.equal(card.toolCalls().length, 0, "走秒不得触发数据查询");
  assert.equal(card.resourceReads().length, 0, "走秒不得触发资源读");
  assert.equal(card.intervals.size, 0, "走秒不得重建数据轮询");

  // 两类计时器并存：自动刷新开启后各跑各的
  card.enableAuto(true);
  assert.equal(card.intervals.size, 1);
  assert.equal(card.elapsedIntervals.size, 1);
  const readsBefore = card.resourceReads().length;
  card.advance(1000);
  card.tick();
  card.elapsedTick();
  // CH1：数据轮询 tick 默认走资源读（免授权通道），只读一次；tools/call 零调用
  assert.equal(card.resourceReads().length, readsBefore + 1, "数据轮询 tick 只读一次资源");
  assert.equal(card.toolCalls().length, 0, "资源通道下不得走 tools/call");
  assert.equal(card.element("elapsed").textContent, "1m 31s");

  // 终态：停表——走秒计时器清除，elapsed 固定为 finished_at 定值（资源读响应）
  card.receive({
    id: card.resourceReads().at(-1).id,
    result: { contents: [{ uri: "dlz://job/job-1", mimeType: "application/json", text: JSON.stringify(cardTask({ status: "COMPLETED", revision: 2, started_at: "2026-09-26T15:59:30.000Z", finished_at: "2026-09-26T16:01:30.000Z" })) }] },
  });
  await card.settle();
  assert.equal(card.elapsedIntervals.size, 0, "终态必须停走秒");
  assert.equal(card.element("elapsed").textContent, "2m 0s");
  card.advance(60000);
  assert.equal(card.element("elapsed").textContent, "2m 0s", "停表后不随时钟推进");

  // 非终态恢复后走秒重启，pagehide 清理两个计时器
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-2" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ job_id: "job-2", status: "RUNNING", revision: 1 }) } });
  await card.settle();
  card.enableAuto(true);
  assert.equal(card.intervals.size, 1);
  assert.equal(card.elapsedIntervals.size, 1);
  card.events.pagehide();
  assert.equal(card.intervals.size, 0, "pagehide 必须清理数据轮询计时器");
  assert.equal(card.elapsedIntervals.size, 0, "pagehide 必须清理走秒计时器");
});

test("teardown 断连 ResizeObserver 并清理 size 去抖计时器", async () => {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status: "RUNNING", revision: 1 }) } });
  await card.settle();
  assert.equal(card.observers.length, 1);
  card.element("card_root").offsetWidth = 640;
  card.element("card_root").offsetHeight = 480;
  card.observers[0].trigger();
  assert.equal(card.timeouts.size, 1, "尺寸变化应先进入去抖窗口");
  assert.equal(card.sizeReports().length, 0);

  // teardown：observer 断连、去抖计时器清除，残留回调不再上报
  card.receive({ id: 99, method: "ui/resource-teardown", params: { reason: "test" } });
  assert.equal(card.observers[0].disconnected, true, "dispose 必须断连 ResizeObserver");
  assert.equal(card.timeouts.size, 0, "dispose 必须清理 size 去抖计时器");
  card.flushTimeouts();
  assert.equal(card.sizeReports().length, 0, "dispose 后不得再发 size-changed");
});

test("宿主主题：host-context-changed 写 dataset 锁定并热更；首帧空对象保持 CSS 兜底", async () => {
  // 首帧 hostContext 空对象（@mcp-ui/client@7.1.1 已知行为）：不锁定，交给 CSS 层 color-scheme 兜底
  const firstFrameEmpty = await makeCard();
  await firstFrameEmpty.start({ hostCapabilities: { serverTools: {} }, hostContext: {} });
  assert.equal(firstFrameEmpty.documentElement.dataset.theme, undefined, "首帧空 hostContext 不得锁定主题");
  const html = await readTaskCardHtml();
  assert.match(html, /color-scheme: light dark/, "CSS 层必须保留明暗兜底");

  // initialize 首帧带 hostContext：立即锁定，宿主 --cb-* 变量落到根元素
  const card = await makeCard();
  await card.start({
    hostCapabilities: { serverTools: {} },
    hostContext: { theme: "dark", styles: { variables: { "--cb-color-text-primary": "#f2f2f2" } } },
  });
  assert.equal(card.documentElement.dataset.theme, "dark", "initialize 首帧 hostContext 应锁定主题");
  assert.equal(card.hostVars.get("--cb-color-text-primary"), "#f2f2f2", "宿主样式变量应落到根元素");

  // 热更：明暗切换即时生效
  card.receive({ method: "ui/notifications/host-context-changed", params: { theme: "light" } });
  assert.equal(card.documentElement.dataset.theme, "light", "host-context-changed 应热更主题");

  // 未知 theme 值（如 system）不改写已锁定状态
  card.receive({ method: "ui/notifications/host-context-changed", params: { theme: "system" } });
  assert.equal(card.documentElement.dataset.theme, "light", "未知 theme 值不得改写锁定");
});

test("size-changed：ResizeObserver 观察根卡片，去抖后上报；同尺寸不重发", async () => {
  const card = await makeCard();
  await card.start();
  assert.equal(card.observers.length, 1, "必须挂载 ResizeObserver");
  assert.equal(card.observers[0].observed.has(card.element("card_root")), true, "必须观察根卡片");

  // 高度变化 → 去抖窗口内不发，flush 后按 spec 参数结构上报
  card.element("card_root").offsetWidth = 640;
  card.element("card_root").offsetHeight = 480;
  card.observers[0].trigger();
  assert.equal(card.sizeReports().length, 0);
  card.flushTimeouts();
  const first = card.sizeReports();
  assert.equal(first.length, 1, "去抖后应上报一次");
  assert.deepEqual(JSON.parse(JSON.stringify(first[0].params)), { width: 640, height: 480 });

  // 去抖窗口内连续回调只保留一次上报
  card.element("card_root").offsetHeight = 500;
  card.observers[0].trigger();
  card.observers[0].trigger();
  assert.equal(card.timeouts.size, 1);
  card.flushTimeouts();
  assert.equal(card.sizeReports().length, 2, "去抖应合并连续变化");

  // 尺寸未变：回调不产生新上报
  card.observers[0].trigger();
  card.flushTimeouts();
  assert.equal(card.sizeReports().length, 2, "同尺寸不重发");
});

test("徽章五态 + 阶段条映射：RUNNING 脉冲/运行中关键行高亮/终态回落/未知状态缺省", async () => {
  const html = await readTaskCardHtml();
  assert.match(html, /\.badge\.running::before/, "RUNNING 徽章必须带脉冲点（伪元素）");
  assert.match(html, /key-fields\.hot/, "运行中关键行必须有浅色高亮样式");
  const cases = [
    { status: "QUEUED", badge: "badge queued", phase: "phase-bar queued", hot: true },
    { status: "RUNNING", badge: "badge running", phase: "phase-bar running", hot: true },
    { status: "COMPLETED", badge: "badge completed", phase: "phase-bar terminal", hot: false },
    { status: "FAILED", badge: "badge failed", phase: "phase-bar terminal", hot: false },
    { status: "CANCELLED", badge: "badge cancelled", phase: "phase-bar terminal", hot: false },
    { status: "RECOVERY_REQUIRED", badge: "badge recovery", phase: "phase-bar recovery", hot: true },
    { status: "WEIRD_STATUS", badge: "badge", phase: "phase-bar", hot: true },
  ];
  let revision = 0;
  for (const { status, badge, phase, hot } of cases) {
    const card = await makeCard();
    await card.start();
    card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
    card.receive({ method: "ui/notifications/tool-result", params: { structuredContent: cardTask({ status, revision: (revision += 1) }) } });
    await card.settle();
    assert.equal(card.element("status").textContent, status, `${status}: 徽章文本`);
    assert.equal(card.element("status").className, badge, `${status}: 徽章类映射`);
    assert.equal(card.element("phase_bar").className, phase, `${status}: 阶段条映射`);
    assert.equal(card.element("key_fields").className, hot ? "key-fields hot" : "key-fields", `${status}: 关键行高亮`);
  }
});

// P5 CH1 双路径（蓝图 §12.1 / IMPLEMENTATION §9.1）————————————————————————————

test("CH1 资源优先：refresh 首发 resources/read，contents JSON 文本走 showTask 且 tools/call 零调用", async () => {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.element("refresh").listeners.click();
  const [read] = card.resourceReads();
  assert.equal(read.method, "resources/read");
  assert.deepEqual(JSON.parse(JSON.stringify(read.params)), { uri: "dlz://job/job-1" });
  assert.equal(card.toolCalls().length, 0, "资源通道下不得再踩 tools/call 审批通道");
  card.receive({ id: read.id, result: { contents: [{ uri: "dlz://job/job-1", mimeType: "application/json", text: JSON.stringify(cardTask({ status: "RUNNING", revision: 1 })) }] } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");
  assert.equal(card.element("current_activity").textContent, "正在处理任务");
  assert.equal(card.element("agent").textContent, "workbuddy");
  assert.equal(card.element("message").textContent, "任务执行中，可手动刷新或勾选自动刷新。");
});

test("CH1 资源通道：自动刷新 tick 只读资源；资源路径 revision 防旧生效", async () => {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  // 首次探测成功：合法 contents 文本（一次性探测后保持资源通道）
  card.element("refresh").listeners.click();
  card.receive({ id: card.resourceReads()[0].id, result: { contents: [{ uri: "dlz://job/job-1", mimeType: "application/json", text: JSON.stringify(cardTask({ status: "RUNNING", revision: 1 })) }] } });
  await card.settle();
  card.enableAuto(true);

  card.tick();
  const staleRead = card.resourceReads().at(-1);
  assert.equal(card.toolCalls().length, 0, "资源通道下不得走 tools/call");
  card.receive({ id: staleRead.id, result: { contents: [{ text: JSON.stringify(cardTask({ status: "RUNNING", revision: 0, current_activity: "旧步骤" })) }] } });
  await card.settle();
  assert.equal(card.element("current_activity").textContent, "正在处理任务", "资源路径 revision 防旧必须生效");

  card.tick();
  const freshRead = card.resourceReads().at(-1);
  card.receive({ id: freshRead.id, result: { contents: [{ text: JSON.stringify(cardTask({ status: "COMPLETED", revision: 2, final_text: "done" })) }] } });
  await card.settle();
  assert.equal(card.element("status").textContent, "COMPLETED");
  assert.equal(card.element("result").textContent, "done");
  assert.equal(card.intervals.size, 0, "终态停轮询");
});

test("CH1 探测失败：宿主 method not found → 本会话永久降级 tools/call，后续 tick 不再探测", async () => {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.element("refresh").listeners.click();
  card.receive({ id: card.resourceReads()[0].id, error: { message: "Method not found" } });
  await card.settle();
  // 降级立即转工具路径完成本次刷新，功能不缺失
  assert.equal(card.resourceReads().length, 1);
  assert.equal(card.toolCalls().length, 1);
  assert.equal(card.toolCalls()[0].params.name, "get_task");
  card.receive({ id: card.toolCalls()[0].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 1 }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");

  // 本会话内永久降级：自动刷新 tick 也走 tools/call，绝不复发资源探测
  card.enableAuto(true);
  card.tick();
  assert.equal(card.resourceReads().length, 1, "永久降级后不得复发资源读");
  assert.equal(card.toolCalls().length, 2);
  card.receive({ id: card.toolCalls()[1].id, result: { structuredContent: cardTask({ status: "COMPLETED", revision: 2 }) } });
  await card.settle();
  assert.equal(card.element("status").textContent, "COMPLETED");

  // 降级后失败语义不回退：工具路径查询失败（切换 job 后无成功快照）→ 错误提示 + 允许重试
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-2" } } });
  card.element("refresh").listeners.click();
  assert.equal(card.toolCalls().length, 3);
  card.receive({ id: card.toolCalls()[2].id, error: { message: "host bridge broken" } });
  await card.settle();
  assert.match(card.element("message").textContent, /^刷新失败：host bridge broken；尚无成功快照，可重试。$/);
  assert.equal(card.element("refresh").disabled, false, "失败后必须允许重试");
});

test("CH1 探测失败：宿主无响应（send 超时）与结构不可用（缺 contents）均触发永久降级", async () => {
  // 宿主静默：资源读 5s 无响应 → 判宿主无资源通道
  const silent = await makeCard();
  await silent.start();
  silent.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  silent.element("refresh").listeners.click();
  assert.equal(silent.resourceReads().length, 1);
  assert.equal(silent.timeouts.size, 1, "资源读应挂 5s 超时守卫");
  silent.flushTimeouts();
  await silent.settle();
  assert.equal(silent.toolCalls().length, 1, "宿主无响应 → 永久降级并立即转 tools/call");
  silent.receive({ id: silent.toolCalls()[0].id, result: { structuredContent: cardTask({ status: "RUNNING", revision: 1 }) } });
  await silent.settle();
  assert.equal(silent.element("status").textContent, "RUNNING");
  assert.equal(silent.resourceReads().length, 1, "降级后不得复发资源读");

  // 结构不可用：宿主给了 result 但 contents 里没有 JSON 文本 → 判宿主无资源通道
  const broken = await makeCard();
  await broken.start();
  broken.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  broken.element("refresh").listeners.click();
  broken.receive({ id: broken.resourceReads()[0].id, result: { contents: [] } });
  await broken.settle();
  assert.equal(broken.toolCalls().length, 1, "结构不可用 → 永久降级并立即转 tools/call");
  broken.receive({ id: broken.toolCalls()[0].id, result: { structuredContent: cardTask({ status: "QUEUED", revision: 1 }) } });
  await broken.settle();
  assert.equal(broken.element("status").textContent, "QUEUED");
});

test("CH1 探测成功后资源读失败等同查询失败：保留快照、可重试、不降级", async () => {
  const card = await makeCard();
  await card.start();
  card.receive({ method: "ui/notifications/tool-input", params: { arguments: { job_id: "job-1" } } });
  card.element("refresh").listeners.click();
  card.receive({ id: card.resourceReads()[0].id, result: { contents: [{ text: JSON.stringify(cardTask({ status: "RUNNING", revision: 1, current_activity: "正在编译" })) }] } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING");

  // 资源读查询性失败（宿主 error）：保留上次成功快照 + 错误提示 + 允许重试；不降级
  card.element("refresh").listeners.click();
  card.receive({ id: card.resourceReads()[1].id, error: { message: "Resource not found: dlz://job/job-1" } });
  await card.settle();
  assert.equal(card.element("status").textContent, "RUNNING", "查询失败不得改写 job 状态");
  assert.equal(card.element("current_activity").textContent, "正在编译", "查询失败保留上次成功快照");
  assert.match(card.element("message").textContent, /^刷新失败：Resource not found/);
  assert.equal(card.element("refresh").disabled, false, "失败后必须允许重试");

  // 重试仍走资源通道（未降级），成功后状态提示恢复
  card.element("refresh").listeners.click();
  assert.equal(card.resourceReads().length, 3, "查询性失败不得触发降级");
  assert.equal(card.toolCalls().length, 0, "查询性失败不得降级到 tools/call");
  card.receive({ id: card.resourceReads()[2].id, result: { contents: [{ text: JSON.stringify(cardTask({ status: "COMPLETED", revision: 2, final_text: "done" })) }] } });
  await card.settle();
  assert.equal(card.element("status").textContent, "COMPLETED");
  assert.equal(card.element("result").textContent, "done");
  assert.equal(card.element("message").textContent, "任务已结束，自动刷新已停止。");
});

// P5 CH3 看板（board.html 运行时双通道）——————————————————————————————————————————
// VM harness 与 makeCard 同族：widget 态（window.parent !== window）注入 EventSource/DOM/
// 计时器桩（不提供 fetch/location——widget 不得依赖二者）；浏览器态 window 自引用 +
// location/fetch 桩（CH2 原行为锁定）。

function boardJob(jobId, status, revision, overrides = {}) {
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
    current_activity: status === "RUNNING" ? "正在编译" : null,
    activity: null,
    liveness: {
      owner_heartbeat_at: status === "RUNNING" ? "2026-10-04T00:00:05.000Z" : null,
      process_checked_at: null,
      process_state: status === "RUNNING" ? "ALIVE" : null,
      last_event_at: null,
      last_output_at: null,
    },
    usage: { input_tokens: null, output_tokens: null, reasoning_tokens: null },
    ...overrides,
  };
}

const BOARD_READ_TOKEN = "widget-read-token-0123456789abcdef";

// render_board structuredContent 形状（含 token 有/无两种配置，与 mcp.test.js 契约同源）。
function boardStructured(overrides = {}) {
  return {
    jobs: [{
      job_id: "job-run",
      status: "RUNNING",
      project: "canary-project",
      agent: "workbuddy",
      created_at: "2026-10-04T00:00:00.000Z",
      updated_at: "2026-10-04T00:00:09.000Z",
      revision: 3,
    }],
    board_url: `http://127.0.0.1:18490/board?read_token=${BOARD_READ_TOKEN}`,
    read_token: BOARD_READ_TOKEN,
    generated_at: "2026-10-04T00:00:10.000Z",
    notice: null,
    ...overrides,
  };
}

async function makeBoard({ widget = true, readToken = "browser-token-0123456789abcdef", boardPayload = { jobs: [], truncated: false, total: 0 }, now = FIXED_NOW } = {}) {
  const html = await readBoardHtml();
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(script, "the board must embed exactly one inline module script");
  const created = [];
  const relink = (element) => {
    for (let index = 0; index < element.children.length; index += 1) {
      element.children[index].nextSibling = element.children[index + 1] ?? null;
    }
  };
  const matchesSimple = (element, selector) => (
    selector.startsWith(".") ? String(element.className).split(/\s+/).includes(selector.slice(1)) : element.tagName === selector
  );
  const queryIn = (element, selector) => {
    const parts = selector.trim().split(/\s+/);
    const last = parts.at(-1);
    const ancestors = parts.slice(0, -1);
    for (const child of element.children) {
      if (ancestors.every((part) => matchesSimple(element, part)) && matchesSimple(child, last)) return child;
      const found = queryIn(child, selector);
      if (found !== null) return found;
    }
    return null;
  };
  const makeElement = (tagName) => {
    const element = {
      tagName,
      _text: "",
      get textContent() {
        // DOM 语义聚合：自身有文本返回自身；否则聚合子孙文本（供卡内断言使用）
        return this._text !== "" ? this._text : this.children.map((kid) => kid.textContent ?? "").join("");
      },
      set textContent(value) { this._text = String(value); },
      className: "",
      hidden: false,
      disabled: false,
      dataset: {},
      children: [],
      nextSibling: null,
      offsetWidth: 0,
      offsetHeight: 0,
      append(...kids) { for (const kid of kids) { element.children.push(kid); } relink(element); },
      replaceChildren(...kids) { element.children.length = 0; element.children.push(...kids); relink(element); },
      addEventListener() {},
      querySelector(selector) { return queryIn(element, selector); },
    };
    created.push(element);
    return element;
  };
  const elementsById = new Map();
  const hostVars = new Map();
  const documentElement = { dataset: {}, style: { setProperty(name, value) { hostVars.set(name, value); } } };
  const document = {
    getElementById(id) {
      if (!elementsById.has(id)) elementsById.set(id, makeElement("div"));
      return elementsById.get(id);
    },
    createElement: (tagName) => makeElement(tagName),
    createTextNode: (text) => ({ textContent: text }),
    documentElement,
    querySelectorAll(selector) { return created.filter((element) => matchesSimple(element, selector)); },
  };
  const outgoing = [];
  const targets = [];
  const events = {};
  const parent = { postMessage(packet, targetOrigin) { outgoing.push(packet); targets.push(targetOrigin ?? null); } };
  const window = {};
  window.parent = widget ? parent : window; // widget 态宿主为父帧；浏览器态自引用
  window.addEventListener = (name, callback) => { events[name] = callback; };
  const location = { search: readToken === null ? "" : `?read_token=${encodeURIComponent(readToken)}` };
  const sources = [];
  class TestEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = TestEventSource.CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      sources.push(this);
    }
    close() { this.readyState = TestEventSource.CLOSED; }
    open() { this.readyState = TestEventSource.OPEN; this.onopen?.(); }
    fail() { this.onerror?.(); }
    emit(data) { this.onmessage?.({ data }); }
  }
  const fetchCalls = [];
  const fetchStub = async (url) => {
    fetchCalls.push({ url: String(url) });
    return { ok: true, status: 200, json: async () => boardPayload };
  };
  const intervals = new Map();
  const elapsedIntervals = new Map();
  const timeouts = new Map();
  const observers = [];
  let nextTimer = 1;
  let nowMs = now;
  class TestDate extends Date { static now() { return nowMs; } }
  class TestResizeObserver {
    constructor(callback) { this.callback = callback; this.observed = new Set(); this.disconnected = false; observers.push(this); }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.disconnected = true; }
    trigger() { this.callback(); }
  }
  const sandbox = {
    window,
    document,
    EventSource: TestEventSource,
    URL,
    URLSearchParams,
    Date: TestDate,
    ResizeObserver: TestResizeObserver,
    setTimeout: (callback) => { const id = nextTimer++; timeouts.set(id, callback); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (callback) => {
      const id = nextTimer++;
      if (callback && callback.dlzTimerKind === "elapsed") elapsedIntervals.set(id, callback);
      else intervals.set(id, callback);
      return id;
    },
    clearInterval: (id) => { intervals.delete(id); elapsedIntervals.delete(id); },
  };
  if (!widget) {
    // 浏览器态专用：URL query 取 token + /api/jobs 初载；widget 态不得依赖二者
    sandbox.location = location;
    sandbox.fetch = fetchStub;
  }
  runInNewContext(script[1], sandbox);
  const receive = (packet, origin) => events.message({ source: parent, origin, data: { jsonrpc: "2.0", ...packet } });
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
  const start = async (initResult = { hostCapabilities: { serverTools: {} } }) => {
    receive({ id: outgoing[0].id, result: initResult });
    await settle();
  };
  const sendToolResult = async (structured) => {
    receive({ method: "ui/notifications/tool-result", params: { structuredContent: structured } });
    await settle();
  };
  const resourceReads = () => outgoing.filter((packet) => packet.method === "resources/read");
  const toolCalls = () => outgoing.filter((packet) => packet.method === "tools/call");
  const sizeReports = () => outgoing.filter((packet) => packet.method === "ui/notifications/size-changed");
  const tick = () => { for (const callback of [...intervals.values()]) callback(); };
  const elapsedTick = () => { for (const callback of [...elapsedIntervals.values()]) callback(); };
  const flushTimeouts = () => { for (const callback of [...timeouts.values()]) callback(); timeouts.clear(); };
  const advance = (ms) => { nowMs += ms; };
  return {
    element: (id) => document.getElementById(id), outgoing, targets, sources, intervals, elapsedIntervals, timeouts, observers, hostVars, documentElement, fetchCalls,
    receive, settle, start, sendToolResult, resourceReads, toolCalls, sizeReports, tick, elapsedTick, flushTimeouts, events, advance,
  };
}

test("P5 CH3：board UI 资源 meta（connectDomains 恰好一个 origin）与单任务卡 meta 零改动", async () => {
  assert.equal(BOARD_RESOURCE_URI, "ui://dalizi-dispatcher/board.html");
  assert.equal(BOARD_MIME_TYPE, "text/html;profile=mcp-app");
  assert.equal(BOARD_HTTP_ORIGIN, "http://127.0.0.1:18490");

  const boardHtml = await readBoardHtml();
  assert.match(boardHtml, /<html lang="zh-CN">/);
  assert.match(boardHtml, /<title>DLZ看板<\/title>/);
  // CH3 双通道在码：资源轮询兜底（dlz://board + resources/read）、
  // 通道态判定（widget/浏览器）、token 取自 URL query（静态页不内置凭据）。
  assert.match(boardHtml, /dlz:\/\/board/);
  assert.match(boardHtml, /send\("resources\/read"/);
  assert.match(boardHtml, /window\.parent === window/);
  assert.match(boardHtml, /read_token/);
  assert.match(boardHtml, /id="channel"/, "底部数据源声明必须在码");
  assert.match(boardHtml, /进程\/心跳/, "子进程级字段 roster 嵌套行必须在码");
  assert.doesNotMatch(boardHtml, /<script[^>]+src=|<link[^>]+href=|<img[^>]+src=/i);
  // P6 ZC1：ZCode RunPhaseList 视觉语言在码（垂直 spine 阶段带 = 组灯 + 行卡）
  assert.match(boardHtml, /class="spine"/, "垂直 spine 阶段带容器必须在码");
  assert.match(boardHtml, /data-stage="queued"/);
  assert.match(boardHtml, /data-stage="active"/);
  assert.match(boardHtml, /data-stage="terminal"/);
  assert.match(boardHtml, /stage-light/, "阶段灯（组灯）必须在码");
  assert.match(boardHtml, /createJobRow/, "任务行卡构建器必须在码");
  assert.match(boardHtml, /job-row/, "任务行卡类名必须在码");

  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-board-meta-"));
  const { client, server } = await connect(createDispatcher(directory));
  try {
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 3);
    const boardResource = resources.resources.find((resource) => resource.uri === BOARD_RESOURCE_URI);
    assert.ok(boardResource, "board UI 资源必须注册");
    assert.equal(boardResource.mimeType, BOARD_MIME_TYPE);
    // board meta：connectDomains 恰好一个 origin，resourceDomains 维持空（蓝图 §12.5）
    assert.deepEqual(JSON.parse(JSON.stringify(boardResource._meta.ui.csp)), { connectDomains: ["http://127.0.0.1:18490"], resourceDomains: [] });
    assert.equal(boardResource._meta.ui.csp.connectDomains.length, 1, "connectDomains 必须恰好一个 origin");
    const read = await client.readResource({ uri: BOARD_RESOURCE_URI });
    assert.equal(read.contents.length, 1);
    assert.equal(read.contents[0].uri, BOARD_RESOURCE_URI);
    assert.equal(read.contents[0].mimeType, BOARD_MIME_TYPE);
    assert.equal(read.contents[0].text, boardHtml);
    assert.ok(read.contents[0].text.includes("DLZ看板"));
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CH3 board widget：tool-result 带凭据时 SSE 优先建流，帧合并渲染", async () => {
  const board = await makeBoard();
  assert.equal(board.outgoing[0].method, "ui/initialize");
  assert.equal(board.outgoing[0].params.appInfo.name, "Dalizi Board");
  assert.equal(board.outgoing[0].params.protocolVersion, "2026-01-26");
  await board.start();
  assert.equal(board.outgoing[1].method, "ui/notifications/initialized");
  assert.equal(board.element("connection").textContent, "等待看板数据…");
  assert.equal(board.toolCalls().length, 0);

  await board.sendToolResult(boardStructured());
  // EventSource 指向 board_url 同源 /events，read_token 经 query 携带
  assert.equal(board.sources.length, 1);
  assert.equal(board.sources[0].url, `http://127.0.0.1:18490/events?read_token=${BOARD_READ_TOKEN}`);
  assert.equal(board.element("connection").textContent, "连接中…");
  assert.match(board.element("channel").textContent, /SSE 实时推送/);
  assert.equal(board.timeouts.size, 1, "启动期必须挂超时守卫");
  // tool-result 摘要先行渲染（执行中列 1 张卡）
  assert.equal(board.element("column-active").children.length, 1);

  board.sources[0].open();
  await board.settle();
  assert.equal(board.element("connection").textContent, "SSE 已连接");
  assert.equal(board.timeouts.size, 0, "建流后启动超时必须清除");
  assert.equal(board.elapsedIntervals.size, 1, "建流后启动走秒");

  // SSE 全量快照帧合并（摘要 → 完整快照），liveness 行照实渲染
  board.sources[0].emit(JSON.stringify({ job_id: "job-run", revision: 4, snapshot: boardJob("job-run", "RUNNING", 4, { started_at: "2026-09-26T16:00:00.000Z", created_at: "2026-09-26T15:59:30.000Z", updated_at: "2026-09-26T16:00:05.000Z" }) }));
  await board.settle();
  assert.equal(board.element("column-active").children.length, 1);
  assert.equal(board.element("truncation").textContent, "当前 1 张卡");
  const card = board.element("column-active").children[0];
  // P6 ZC1：ZCode spine 结构 —— 行卡类名 + 执行中阶段灯点亮 + 阶段计数同步
  assert.match(card.className, /job-row/, "任务行卡类名");
  assert.equal(board.element("stage-active").dataset.live, "true", "执行中阶段灯应点亮");
  assert.equal(board.element("count-active").textContent, "1", "阶段计数应同步");
  assert.match(card.querySelector(".job-line b").nextSibling.textContent, /^10s$/, "已运行必须走秒");
  assert.match(card.textContent, /进程 ALIVE/, "进程级字段按 roster 风格嵌套展示");
  board.advance(1000);
  board.elapsedTick();
  assert.equal(card.querySelector(".job-line b").nextSibling.textContent, "11s", "走秒每秒重算");
  assert.equal(board.toolCalls().length, 0, "SSE 通道不得走 tools/call");
});

test("CH3 board widget：EventSource 启动期失败（onerror）→ 闭源降级 dlz://board 2s 轮询接管", async () => {
  const board = await makeBoard();
  await board.start();
  await board.sendToolResult(boardStructured());
  assert.equal(board.sources.length, 1);

  board.sources[0].fail(); // 启动期 onerror：CSP 拦截 / 端点 401/403 均走此路径
  await board.settle();
  assert.equal(board.sources[0].readyState, 2, "降级前必须闭源");
  assert.equal(board.element("connection").textContent, "资源轮询（2s）");
  assert.match(board.element("channel").textContent, /dlz:\/\/board 资源轮询（约 2s）/);
  assert.match(board.element("channel").textContent, /SSE 连接未建立/);
  assert.equal(board.intervals.size, 1, "必须建立 2s 轮询计时器");
  // 立即首询已发出（免授权资源读，不踩审批通道）
  assert.equal(board.resourceReads().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(board.resourceReads()[0].params)), { uri: "dlz://board" });
  assert.equal(board.toolCalls().length, 0);

  // 资源响应 → 全量快照替换渲染 + 截断声明
  board.receive({
    id: board.resourceReads()[0].id,
    result: { contents: [{ uri: "dlz://board", mimeType: "application/json", text: JSON.stringify({ jobs: [boardJob("job-run", "RUNNING", 5), boardJob("job-done", "COMPLETED", 2)], truncated: true, total: 57 }) }] },
  });
  await board.settle();
  assert.equal(board.element("column-active").children.length, 1);
  assert.equal(board.element("column-terminal").children.length, 1);
  assert.equal(board.element("truncation").hidden, false);
  assert.match(board.element("truncation").textContent, /结果已截断：当前 2 张卡 \/ 全量 57 条/);
  assert.equal(board.element("notice").hidden, true, "轮询成功后清除 transient 错误提示");

  // 周期轮询继续（tick 一次 = 一次资源读），仍不走 tools/call
  board.tick();
  assert.equal(board.resourceReads().length, 2);
  assert.equal(board.toolCalls().length, 0);
});

test("CH3 board widget：SSE 启动超时（onerror 静默不触发）→ 确定性降级资源轮询", async () => {
  const board = await makeBoard();
  await board.start();
  await board.sendToolResult(boardStructured());
  assert.equal(board.sources.length, 1);
  assert.equal(board.timeouts.size, 1);

  board.flushTimeouts();
  await board.settle();
  assert.equal(board.sources[0].readyState, 2, "超时降级同样必须闭源");
  assert.equal(board.element("connection").textContent, "资源轮询（2s）");
  assert.match(board.element("channel").textContent, /SSE 连接超时未建立/);
  assert.equal(board.intervals.size, 1);
  assert.equal(board.resourceReads().length, 1, "降级后立即首询");
});

test("CH3 board widget：未配置只读凭据（read_token/board_url 为 null）→ 不尝试 SSE，直接资源轮询并诚实标注", async () => {
  const board = await makeBoard();
  await board.start();
  await board.sendToolResult({
    jobs: [],
    board_url: null,
    read_token: null,
    generated_at: "2026-10-04T00:00:10.000Z",
    notice: "未配置只读凭据（DISPATCHER_HTTP_READ_TOKEN）：board_url/read_token 不可用，widget 经 dlz://board 资源轮询（约 2s）取数。",
  });
  assert.equal(board.sources.length, 0, "无凭据不得尝试 SSE");
  assert.equal(board.intervals.size, 1);
  assert.equal(board.resourceReads().length, 1);
  assert.match(board.element("notice").textContent, /未配置只读凭据/);
  assert.match(board.element("channel").textContent, /未配置只读凭据，board_url 不可用/);
});

test("CH3 board widget：轮询失败保留已加载视图并按周期重试；teardown 清理通道与计时器", async () => {
  const board = await makeBoard();
  await board.start();
  await board.sendToolResult(boardStructured());
  board.sources[0].fail();
  await board.settle();

  // 首询失败（宿主 error）：保留 tool-result 摘要视图，提示重试，不降级 tools/call
  board.receive({ id: board.resourceReads()[0].id, error: { message: "Resource not found: dlz://board" } });
  await board.settle();
  assert.match(board.element("notice").textContent, /资源轮询失败：Resource not found/);
  assert.equal(board.element("column-active").children.length, 1, "查询失败保留已加载视图");
  assert.equal(board.toolCalls().length, 0, "资源通道失败不得降级 tools/call");

  // 周期重试成功 → 清除 transient 错误提示
  board.tick();
  assert.equal(board.resourceReads().length, 2);
  board.receive({ id: board.resourceReads()[1].id, result: { contents: [{ text: JSON.stringify({ jobs: [boardJob("job-run", "RUNNING", 5)], truncated: false, total: 1 }) }] } });
  await board.settle();
  assert.equal(board.element("notice").hidden, true);

  // teardown：闭源、停轮询、停走秒、清 pending，并回执
  board.receive({ id: 99, method: "ui/resource-teardown", params: { reason: "test" } });
  assert.equal(board.intervals.size, 0, "teardown 必须停资源轮询");
  assert.equal(board.elapsedIntervals.size, 0, "teardown 必须停走秒");
  assert.equal(board.timeouts.size, 0, "teardown 必须清 pending 超时");
  assert.deepEqual(JSON.parse(JSON.stringify(board.outgoing.at(-1))), { jsonrpc: "2.0", id: 99, result: {} });
  // dispose 后残留回调不再发起请求
  board.tick();
  assert.equal(board.resourceReads().length, 2, "dispose 后不得再发起资源读");
});

test("CH3 board widget：size-changed 去抖上报与 host-context 主题适配（与 UX1 同族）", async () => {
  const board = await makeBoard();
  await board.start({
    hostCapabilities: { serverTools: {} },
    hostContext: { theme: "dark", styles: { variables: { "--cb-color-text-primary": "#f2f2f2" } } },
  });
  assert.equal(board.documentElement.dataset.theme, "dark", "initialize 首帧 hostContext 应锁定主题");
  assert.equal(board.hostVars.get("--cb-color-text-primary"), "#f2f2f2", "宿主样式变量应落到根元素");
  assert.equal(board.observers.length, 1, "必须挂载 ResizeObserver");
  assert.equal(board.observers[0].observed.has(board.element("board_root")), true, "必须观察看板根");

  board.element("board_root").offsetWidth = 640;
  board.element("board_root").offsetHeight = 480;
  board.observers[0].trigger();
  assert.equal(board.sizeReports().length, 0, "去抖窗口内不上报");
  board.flushTimeouts();
  const reports = board.sizeReports();
  assert.equal(reports.length, 1, "去抖后应上报一次");
  assert.deepEqual(JSON.parse(JSON.stringify(reports[0].params)), { width: 640, height: 480 });

  // 同尺寸不重发
  board.observers[0].trigger();
  board.flushTimeouts();
  assert.equal(board.sizeReports().length, 1, "同尺寸不重发");

  // 主题热更
  board.receive({ method: "ui/notifications/host-context-changed", params: { theme: "light" } });
  assert.equal(board.documentElement.dataset.theme, "light", "host-context-changed 应热更主题");
});

test("CH3 board 浏览器态（present_files）：无 MCP 桥，token 取 URL query，/api/jobs 初载 + 相对 /events 纯 SSE", async () => {
  const board = await makeBoard({
    widget: false,
    readToken: "browser-token-0123456789abcdef",
    boardPayload: { jobs: [boardJob("job-run", "RUNNING", 2)], truncated: false, total: 1 },
  });
  assert.equal(board.outgoing.length, 0, "浏览器态不得发起 MCP 桥握手");
  await board.settle();
  // CH2 原行为锁定：/api/jobs 初载 + 相对路径 /events（同源）
  assert.equal(board.fetchCalls.length, 1);
  assert.match(board.fetchCalls[0].url, /^\/api\/jobs\?read_token=/);
  assert.equal(board.sources.length, 1);
  assert.equal(board.sources[0].url, `/events?read_token=${encodeURIComponent("browser-token-0123456789abcdef")}`);
  assert.match(board.element("channel").textContent, /GET \/events/);
  assert.equal(board.element("column-active").children.length, 1);

  board.sources[0].open();
  await board.settle();
  assert.equal(board.element("connection").textContent, "已连接");
  board.sources[0].emit(JSON.stringify({ job_id: "job-run", revision: 3, snapshot: boardJob("job-run", "RUNNING", 3) }));
  await board.settle();
  assert.equal(board.elapsedIntervals.size, 1);

  // pagehide 清理：走秒停表、EventSource 关闭
  board.events.pagehide();
  assert.equal(board.elapsedIntervals.size, 0, "pagehide 必须清理走秒");
  assert.equal(board.sources[0].readyState, 2, "pagehide 必须关闭 EventSource");
});

test("CH3 board 浏览器态：URL 缺 read_token → 未认证提示，不建流不请求", async () => {
  const board = await makeBoard({ widget: false, readToken: null });
  await board.settle();
  assert.equal(board.sources.length, 0);
  assert.equal(board.fetchCalls.length, 0);
  assert.equal(board.element("connection").textContent, "未认证");
  assert.match(board.element("notice").textContent, /read_token/);
});

