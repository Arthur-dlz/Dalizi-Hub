import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEMO_JOB_ID, RESOURCE_MIME_TYPE, RESOURCE_URI, getDemoTask, resetDemoTask, startServer } from './server.js';

test('demo state is deterministic and isolated', () => {
  assert.equal(getDemoTask(DEMO_JOB_ID, 1_000, 0).status, 'RUNNING');
  const completed = getDemoTask(DEMO_JOB_ID, 12_000, 0);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.result_summary, '演示任务已成功完成。');
  assert.equal(completed.current_activity, '演示任务已完成');
  assert.equal(getDemoTask(DEMO_JOB_ID, 5_000, 0).current_activity, '正在处理隔离演示任务');
  assert.equal(getDemoTask('production-job-id'), null);
});

test('reset returns the demo to a fresh RUNNING state deterministically', () => {
  const resetAt = 1_000_000;
  const reset = resetDemoTask(resetAt);
  assert.equal(reset.status, 'RUNNING');
  assert.equal(reset.elapsed, '0s');
  assert.equal(reset.current_activity, '正在处理隔离演示任务');
  // elapsed is measured from the reset point, not from a previous start
  assert.equal(getDemoTask(DEMO_JOB_ID, resetAt + 5_000).elapsed, '5s');
  assert.equal(getDemoTask(DEMO_JOB_ID, resetAt + 5_000).status, 'RUNNING');
  // the ~12s completion logic still applies after a reset
  assert.equal(getDemoTask(DEMO_JOB_ID, resetAt + 12_000).status, 'COMPLETED');
  // restore a fresh state for the HTTP test below
  resetDemoTask();
});

test('Streamable HTTP exposes UI link, resource, and all three tools', async t => {
  const { httpServer, handler } = startServer(0);
  await new Promise(resolve => httpServer.once('listening', resolve));
  t.after(async () => {
    await handler.close();
    await new Promise(resolve => httpServer.close(resolve));
  });
  const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
  let id = 0;
  async function rpc(method, params) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `${method}: ${body}`);
    const packet = body.includes('data: ') ? JSON.parse(body.match(/^data: (.+)$/m)[1]) : JSON.parse(body);
    assert.equal(packet.id, id);
    assert.ok(packet.result, `${method}: ${body}`);
    return packet.result;
  }
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'poc-test', version: '0.1.0' },
  });
  assert.ok(initialized.serverInfo);

  const { tools } = await rpc('tools/list', {});
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_task', 'render_task_card', 'reset_demo_task']);
  const resetTool = tools.find(tool => tool.name === 'reset_demo_task');
  assert.ok(resetTool, 'reset_demo_task must be registered');
  assert.match(resetTool.description, /isolated demo/i);
  assert.equal(tools.find(tool => tool.name === 'render_task_card')._meta.ui.resourceUri, RESOURCE_URI);
  const { resources } = await rpc('resources/list', {});
  assert.equal(resources.length, 1);
  assert.equal(resources[0].uri, RESOURCE_URI);
  assert.equal(resources[0].mimeType, RESOURCE_MIME_TYPE);
  assert.deepEqual(resources[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });

  const resource = await rpc('resources/read', { uri: RESOURCE_URI });
  assert.equal(resource.contents[0].mimeType, RESOURCE_MIME_TYPE);
  assert.deepEqual(resource.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.match(resource.contents[0].text, /ui\/initialize/);
  assert.match(resource.contents[0].text, /name: 'get_task'/);
  assert.match(resource.contents[0].text, /大力子任务卡/);

  for (const name of ['render_task_card', 'get_task']) {
    const result = await rpc('tools/call', { name, arguments: { job_id: DEMO_JOB_ID } });
    assert.equal(result.structuredContent.job_id, DEMO_JOB_ID);
    assert.equal(result.structuredContent.status, 'RUNNING');
    assert.equal(result.structuredContent.current_activity, '正在处理隔离演示任务');
    assert.equal(result.content[0].type, 'text');
    assert.ok(!JSON.stringify(result).includes('stdout'));
  }

  // reset_demo_task puts the demo back to a fresh RUNNING state
  const resetResult = await rpc('tools/call', { name: 'reset_demo_task', arguments: { job_id: DEMO_JOB_ID } });
  assert.equal(resetResult.structuredContent.status, 'RUNNING');
  assert.equal(resetResult.structuredContent.elapsed, '0s');
  const afterReset = await rpc('tools/call', { name: 'get_task', arguments: { job_id: DEMO_JOB_ID } });
  assert.equal(afterReset.structuredContent.status, 'RUNNING');

  const unknown = await rpc('tools/call', { name: 'get_task', arguments: { job_id: 'other' } });
  assert.equal(unknown.isError, true);
  const badOrigin = await fetch(url, {
    method: 'POST', headers: { origin: 'https://unapproved.example', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(badOrigin.status, 403);
});

test('UI is self-contained and uses Chinese key copy', async () => {
  const html = await readFile(fileURLToPath(new URL('./card.html', import.meta.url)), 'utf8');
  for (const field of ['agent', 'project', 'status', 'elapsed', 'current_activity', 'last_observed_at', 'result_summary']) {
    assert.match(html, new RegExp(`id="${field}"`));
  }
  for (const text of ['大力子任务卡', '执行 Agent', '项目', '已运行', '当前活动', '模型 / 思考强度', '最后更新', '刷新', '自动刷新（3秒）', '任务执行中，状态将自动刷新。', '任务已结束，自动刷新已停止。']) {
    assert.ok(html.includes(text), `missing Chinese copy: ${text}`);
  }
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|<img[^>]+src=/i);
});
