import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const RESOURCE_URI = 'ui://dalizi-task-card-poc/card.html';
export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
export const DEMO_JOB_ID = 'demo-task-001';
const COMPLETE_AFTER_MS = 12_000;
let demoStartedAt;
const cardPath = fileURLToPath(new URL('./card.html', import.meta.url));

export function getDemoTask(jobId, now = Date.now(), startedAt) {
  if (jobId !== DEMO_JOB_ID) return null;
  const elapsedMs = Math.max(0, now - (startedAt ?? (demoStartedAt ??= now)));
  const completed = elapsedMs >= COMPLETE_AFTER_MS;
  return {
    job_id: DEMO_JOB_ID,
    agent: 'Dalizi Demo Agent',
    project: 'Task Card POC',
    status: completed ? 'COMPLETED' : 'RUNNING',
    elapsed: `${Math.floor(elapsedMs / 1000)}s`,
    current_activity: completed ? '演示任务已完成' : '正在处理隔离演示任务',
    model: 'demo-model',
    effort: 'demo',
    last_observed_at: new Date(now).toISOString(),
    ...(completed ? { result_summary: '演示任务已成功完成。' } : {}),
  };
}

export function resetDemoTask(now = Date.now()) {
  demoStartedAt = now;
  return getDemoTask(DEMO_JOB_ID, now);
}

function taskResult(jobId) {
  const task = getDemoTask(jobId);
  if (!task) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown demo job_id: ${jobId}` }],
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(task) }],
    structuredContent: task,
  };
}

export function makeMcpServer() {
  const server = new McpServer({ name: 'dalizi-task-card-poc', version: '0.1.0' });
  const inputSchema = z.object({ job_id: z.literal(DEMO_JOB_ID) });

  server.registerTool('get_task', {
    title: 'Get demo task',
    description: 'Read the isolated demo task state.',
    inputSchema,
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ job_id }) => taskResult(job_id));

  server.registerTool('reset_demo_task', {
    title: 'Reset demo task',
    description: 'Reset the isolated demo task back to RUNNING. Affects only the isolated demo-task-001 of this PoC server; it never touches any production dispatcher job.',
    inputSchema,
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ job_id }) => {
    if (job_id !== DEMO_JOB_ID) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown demo job_id: ${job_id}` }],
      };
    }
    const task = resetDemoTask();
    return {
      content: [{ type: 'text', text: JSON.stringify(task) }],
      structuredContent: task,
    };
  });

  server.registerTool('render_task_card', {
    title: 'Render demo task card',
    description: 'Show an interactive card for the isolated demo task.',
    inputSchema,
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, async ({ job_id }) => taskResult(job_id));

  const resourceMeta = { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } };
  server.registerResource('Dalizi Task Card POC', RESOURCE_URI, {
    mimeType: RESOURCE_MIME_TYPE,
    _meta: resourceMeta,
  }, async () => ({
    contents: [{
      uri: RESOURCE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(cardPath, 'utf8'),
      _meta: resourceMeta,
    }],
  }));
  return server;
}

export function startServer(port = Number(process.env.PORT ?? 3737)) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const handler = createMcpHandler(makeMcpServer);
  const httpServer = createServer(async (req, res) => {
    if (req.url !== '/mcp' || !['GET', 'POST', 'DELETE'].includes(req.method)) {
      res.writeHead(404).end();
      return;
    }
    const host = req.headers.host;
    const tunnelHost = process.env.POC_TUNNEL_HOST;
    const localHost = /^((localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$/i.test(host ?? '');
    const tunnelAllowed = tunnelHost && host === tunnelHost;
    if (!localHost && !tunnelAllowed) {
      res.writeHead(403).end();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const request = new Request(`http://${host}/mcp`, {
        method: req.method,
        headers: req.headers,
        ...(req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (error) {
      console.error('POC MCP request failed:', error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  httpServer.listen(port, '127.0.0.1');
  return { httpServer, handler };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { httpServer } = startServer();
  httpServer.on('listening', () => {
    console.log(`Dalizi Task Card POC: http://127.0.0.1:${httpServer.address().port}/mcp`);
  });
}
