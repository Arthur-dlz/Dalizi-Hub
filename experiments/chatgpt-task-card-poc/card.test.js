import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

function task(status) {
  return {
    job_id: 'demo-task-001', agent: 'Demo', project: 'POC', status, elapsed: '3s',
    current_activity: 'Checking', model: 'demo-model', effort: 'demo',
    last_observed_at: '2026-09-25T00:00:00.000Z',
    ...(status === 'COMPLETED' ? { result_summary: '演示任务已成功完成。' } : {}),
  };
}

async function makeCard(openai) {
  const html = await readFile(fileURLToPath(new URL('./card.html', import.meta.url)), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, textContent: '', disabled: false, checked: false, hidden: false,
      listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
    });
    return elements.get(id);
  };
  const events = {};
  const outgoing = [];
  const intervals = new Map();
  let nextTimer = 1;
  const parent = { postMessage(packet) { outgoing.push(packet); } };
  const window = { parent, openai, addEventListener(name, callback) { events[name] = callback; } };
  runInNewContext(script, {
    window, document: { getElementById: element },
    setTimeout: () => nextTimer++, clearTimeout() {},
    setInterval: callback => { const id = nextTimer++; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
  });
  const receive = packet => events.message({ source: parent, data: { jsonrpc: '2.0', ...packet } });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  return { element, events, outgoing, intervals, receive, settle };
}

test('card auto-enables refresh on RUNNING, stops on every terminal status, and keeps one interval', async () => {
  const card = await makeCard();
  assert.equal(card.outgoing[0].method, 'ui/initialize');
  assert.equal(card.outgoing[0].params.protocolVersion, '2026-01-26');
  card.receive({ id: card.outgoing[0].id, result: { hostCapabilities: { serverTools: {} } } });
  await card.settle();
  assert.equal(card.outgoing[1].method, 'ui/notifications/initialized');
  card.receive({ method: 'ui/notifications/tool-input', params: { arguments: { job_id: 'demo-task-001' } } });
  card.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: task('RUNNING') } });
  assert.equal(card.element('agent').textContent, 'Demo');
  assert.equal(card.element('status').textContent, 'RUNNING');
  // RUNNING: auto-refresh auto-enabled, exactly one interval
  assert.equal(card.element('auto_refresh').checked, true);
  assert.equal(card.element('auto_refresh').disabled, false);
  assert.equal(card.intervals.size, 1);
  assert.equal(card.element('message').textContent, '任务执行中，状态将自动刷新。');

  // no duplicate intervals even if the change event fires again
  card.element('auto_refresh').listeners.change();
  assert.equal(card.intervals.size, 1);

  // manual refresh still works while auto-refresh is on
  card.element('refresh').listeners.click();
  const manual = card.outgoing.at(-1);
  assert.equal(manual.method, 'tools/call');
  assert.equal(manual.params.name, 'get_task');
  assert.equal(manual.params.arguments.job_id, 'demo-task-001');
  card.receive({ id: manual.id, result: { structuredContent: task('RUNNING') } });
  await card.settle();
  assert.equal(card.intervals.size, 1);

  // automatic tick also calls get_task
  card.intervals.values().next().value();
  const automatic = card.outgoing.at(-1);
  assert.equal(automatic.method, 'tools/call');
  card.receive({ id: automatic.id, result: { structuredContent: task('COMPLETED') } });
  await card.settle();
  assert.equal(card.element('status').textContent, 'COMPLETED');
  assert.equal(card.element('result_summary').textContent, '演示任务已成功完成。');
  assert.equal(card.element('message').textContent, '任务已结束，自动刷新已停止。');
  // COMPLETED: interval cleared, checkbox unchecked and disabled
  assert.equal(card.intervals.size, 0);
  assert.equal(card.element('auto_refresh').checked, false);
  assert.equal(card.element('auto_refresh').disabled, true);

  // FAILED is also terminal
  card.intervals.clear();
  card.receive({ method: 'ui/notifications/tool-input', params: { arguments: { job_id: 'demo-task-001' } } });
  card.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: task('RUNNING') } });
  assert.equal(card.intervals.size, 1);
  card.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: task('FAILED') } });
  await card.settle();
  assert.equal(card.element('status').textContent, 'FAILED');
  assert.equal(card.intervals.size, 0);
  assert.equal(card.element('auto_refresh').checked, false);
  assert.equal(card.element('auto_refresh').disabled, true);

  // CANCELLED is also terminal
  card.receive({ method: 'ui/notifications/tool-input', params: { arguments: { job_id: 'demo-task-001' } } });
  card.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: task('RUNNING') } });
  assert.equal(card.intervals.size, 1);
  card.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: task('CANCELLED') } });
  await card.settle();
  assert.equal(card.element('status').textContent, 'CANCELLED');
  assert.equal(card.intervals.size, 0);
  assert.equal(card.element('auto_refresh').checked, false);

  card.receive({ id: 99, method: 'ui/resource-teardown', params: { reason: 'test' } });
  assert.deepEqual(JSON.parse(JSON.stringify(card.outgoing.at(-1))), { jsonrpc: '2.0', id: 99, result: {} });
});

test('ChatGPT callTool is used only when standard serverTools is unavailable', async () => {
  const calls = [];
  const card = await makeCard({ callTool: async (name, args) => {
    calls.push({ name, args });
    return { structuredContent: task('COMPLETED') };
  } });
  card.receive({ id: card.outgoing[0].id, result: { hostCapabilities: {} } });
  await card.settle();
  card.receive({ method: 'ui/notifications/tool-input', params: { arguments: { job_id: 'demo-task-001' } } });
  card.element('refresh').listeners.click();
  await card.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ name: 'get_task', args: { job_id: 'demo-task-001' } }]);
  assert.equal(card.element('status').textContent, 'COMPLETED');
  assert.equal(card.outgoing.some(packet => packet.method === 'tools/call'), false);
  assert.equal(card.intervals.size, 0);
});
