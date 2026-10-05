import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate, ResourceNotFoundError } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { Dispatcher } from "./dispatcher.js";
import { DispatcherError } from "./contracts.js";
import { JobStore } from "./job-store.js";
import { IdempotencyIndex } from "./idempotency-index.js";
import { InstanceLock } from "./instance-lock.js";
import { ProjectRegistry, projectRegistryPath } from "./project-registry.js";
import {
  TASK_CARD_MIME_TYPE,
  TASK_CARD_RESOURCE_URI,
  readTaskCardHtml,
  taskCardResourceMeta,
  BOARD_MIME_TYPE,
  BOARD_RESOURCE_URI,
  BOARD_HTTP_ORIGIN,
  readBoardHtml,
  boardResourceMeta,
} from "./task-card.js";
import { WorkBuddyRunner } from "./workbuddy-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { AntigravityRunner } from "./antigravity-runner.js";

const VERIFIED_MODELS = new Set(["custom-local:step-5-preview"]);
const VERIFIED_CODEX_MODELS = new Set(["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"]);
export const VERIFIED_ANTIGRAVITY_MODELS = new Set([
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
]);

function errorResult(error) {
  const code = error instanceof DispatcherError ? error.code : "internal_error";
  const message = error instanceof DispatcherError ? error.message : "Dispatcher failed";
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] };
}

// P5 只读资源 dlz://job/{job_id}（蓝图 §12.1 / IMPLEMENTATION §9.1）：MCP Apps widget 经
// app.readServerResource（免授权只读 GET）轮询，取代每 3s 反向 tools/call 踩审批通道；
// 宿主不支持该通道时卡片本会话内永久降级 tools/call get_task，此处资源仍供其他客户端读取。
const JOB_RESOURCE_URI_TEMPLATE = "dlz://job/{job_id}";
const JOB_RESOURCE_MIME_TYPE = "application/json";

// P5 CH3 聚合看板（蓝图 §12.2/§12.3 / IMPLEMENTATION §9.1）：dlz://board 固定 URI 只读资源 +
// render_board App Tool + board UI 资源（CSP 白名单见 task-card.js boardResourceMeta）。
// read_token 只经本已认证工具调用动态下发（board_url query param 携带）：不写进任何
// 静态资源/模板/日志/错误体；未配置或不足 32 字符时 board_url/read_token 为 null 并
// 显式声明降级——widget 走 dlz://board 资源轮询（board.html 运行时双通道）。
const BOARD_DATA_RESOURCE_URI = "dlz://board";
const BOARD_RESOURCE_MIME_TYPE = "application/json";
const HTTP_READ_TOKEN_ENV = "DISPATCHER_HTTP_READ_TOKEN";
const READ_TOKEN_MIN_LENGTH = 32;
// render_board structuredContent.jobs 摘要字段（IMPLEMENTATION §9.1）：与 dlz://board
// 同源的紧凑投影；顺序即声明序。
const BOARD_SUMMARY_FIELDS = ["job_id", "status", "project", "agent", "created_at", "updated_at", "revision"];

// 与 http-mcp-server.js configuredReadToken 同纪律（≥32 字符独立凭据，否则视为未配置）。
// 本地复刻而非 import：避免 mcp-server（stdio）反向依赖 http 模块造成环。
function configuredBoardReadToken(environment) {
  const token = environment[HTTP_READ_TOKEN_ENV];
  if (typeof token !== "string" || token.length < READ_TOKEN_MIN_LENGTH) return null;
  return token;
}

function summarizeBoardJob(job) {
  const summary = {};
  if (job !== null && typeof job === "object") {
    for (const field of BOARD_SUMMARY_FIELDS) {
      if (Object.hasOwn(job, field)) summary[field] = job[field];
    }
  }
  return summary;
}

function successResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function jobResult(job) {
  return { content: [{ type: "text", text: JSON.stringify(job) }], structuredContent: job };
}

export function createDispatcherFromEnvironment(environment = process.env) {
  if (environment.DISPATCHER_PROJECT_REGISTRY !== undefined) {
    throw new DispatcherError("invalid_registry", "DISPATCHER_PROJECT_REGISTRY is not supported; use the local project registry file");
  }
  const dataDirectory = environment.DISPATCHER_DATA_DIR || path.join(process.cwd(), ".dispatcher-data");
  return new Dispatcher({
    registry: new ProjectRegistry(projectRegistryPath(dataDirectory)),
    allowedModels: {
      workbuddy: VERIFIED_MODELS,
      codex: VERIFIED_CODEX_MODELS,
      antigravity: VERIFIED_ANTIGRAVITY_MODELS,
    },
    store: new JobStore(dataDirectory),
    idempotencyIndex: new IdempotencyIndex({ directory: dataDirectory }),
    instanceLock: new InstanceLock({ directory: path.join(dataDirectory, "run") }),
    runner: new WorkBuddyRunner(),
    codexRunner: new CodexRunner({ environment }),
    antigravityRunner: new AntigravityRunner({ environment }),
  });
}

export function createMcpServer(dispatcher, environment = process.env) {
  const server = new McpServer({ name: "dalizi-dispatcher", version: "0.0.0" });
  const readJob = (jobId) => dispatcher.get(jobId);
  const listBoard = () => dispatcher.listBoard();
  const jobTool = async ({ job_id: jobId }) => {
    try {
      return jobResult(await readJob(jobId));
    } catch (error) {
      return errorResult(error);
    }
  };
  const jobInputSchema = () => z.object({ job_id: z.string().max(128) });
  server.registerTool(
    "dispatch_task",
    {
      description: "Queue one WorkBuddy, Codex, or Antigravity task for a registered alias or unique approved workspace directory. agent names the target CLI and model the target CLI model. Send a unique high-entropy request_id (8-128 URL-safe characters) so network retries reuse the same job; omitting request_id is allowed but provides no retry guarantee.",
      inputSchema: z.object({
        agent: z.string().max(80),
        project: z.string().max(80),
        task: z.string().max(8_000),
        model: z.string().max(160),
        effort: z.string().max(20).optional(),
        request_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
      }),
    },
    async (input) => {
      try {
        return successResult(await dispatcher.dispatch(input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "get_task",
    {
      description: "Read the persisted status and final result of one Dispatcher job.",
      inputSchema: jobInputSchema(),
    },
    jobTool,
  );
  server.registerTool(
    "render_task_card",
    {
      title: "Render Dispatcher task card",
      description: "Render the interactive Task Card for one Dispatcher job; the card refreshes its own state through get_task.",
      inputSchema: jobInputSchema(),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: TASK_CARD_RESOURCE_URI } },
    },
    jobTool,
  );
  server.registerResource(
    "Dalizi Task Card",
    TASK_CARD_RESOURCE_URI,
    { mimeType: TASK_CARD_MIME_TYPE, _meta: taskCardResourceMeta() },
    async () => ({
      contents: [{
        uri: TASK_CARD_RESOURCE_URI,
        mimeType: TASK_CARD_MIME_TYPE,
        text: await readTaskCardHtml(),
        _meta: taskCardResourceMeta(),
      }],
    }),
  );
  // P5 CH3：聚合看板 UI 资源（render_board 的 _meta.ui.resourceUri）。CSP 白名单仅
  // http://127.0.0.1:18490 一个 origin（蓝图 §12.5）；单任务卡 meta 不动（见上方注册）。
  server.registerResource(
    "Dalizi Board",
    BOARD_RESOURCE_URI,
    { mimeType: BOARD_MIME_TYPE, _meta: boardResourceMeta() },
    async () => ({
      contents: [{
        uri: BOARD_RESOURCE_URI,
        mimeType: BOARD_MIME_TYPE,
        text: await readBoardHtml(),
        _meta: boardResourceMeta(),
      }],
    }),
  );
  // P5 CH1：注册只读资源模板 dlz://job/{job_id}（mimeType application/json）。read 回调复用
  // dispatcher.get，载荷与 get_task 的 structuredContent 完全同形；未知/缺失/非法 job 一律以
  // 标准资源错误响应（不外泄内部路径）。本资源不启动、不恢复执行；get/job_id 关联不是授权。
  server.registerResource(
    "Dalizi Job",
    new ResourceTemplate(JOB_RESOURCE_URI_TEMPLATE, {}),
    { mimeType: JOB_RESOURCE_MIME_TYPE },
    async (uri, variables) => {
      const jobId = typeof variables?.job_id === "string" ? variables.job_id : "";
      try {
        const job = await readJob(jobId);
        return { contents: [{ uri: uri.toString(), mimeType: JOB_RESOURCE_MIME_TYPE, text: JSON.stringify(job) }] };
      } catch {
        throw new ResourceNotFoundError(uri.toString());
      }
    },
  );
  // P5 CH3：固定 URI 只读资源 dlz://board（蓝图 §12.2 / IMPLEMENTATION §9.1）。handler 复用
  // dispatcher.listBoard，载荷 {jobs, truncated, total}（jobs 项与 dlz://job 同形）；读失败
  // 同样不外泄内部路径（标准资源错误）。本资源不启动、不恢复执行。
  server.registerResource(
    "Dalizi Board Snapshot",
    BOARD_DATA_RESOURCE_URI,
    { mimeType: BOARD_RESOURCE_MIME_TYPE },
    async () => {
      try {
        const board = await listBoard();
        return { contents: [{ uri: BOARD_DATA_RESOURCE_URI, mimeType: BOARD_RESOURCE_MIME_TYPE, text: JSON.stringify(board) }] };
      } catch {
        throw new ResourceNotFoundError(BOARD_DATA_RESOURCE_URI);
      }
    },
  );
  // P5 CH3：render_board（蓝图 §12.3）。只读；structuredContent 动态下发 board_url +
  // read_token（query param 携带，仅本已认证通道可见）；未配置只读凭据时二者为 null 并
  // 显式声明降级（widget 走 dlz://board 资源轮询）。不替代 render_task_card（单 job 不变）。
  const boardTool = async () => {
    try {
      const board = await listBoard();
      const jobs = (Array.isArray(board?.jobs) ? board.jobs : []).map(summarizeBoardJob);
      const readToken = configuredBoardReadToken(environment);
      const generatedAt = new Date().toISOString();
      const structuredContent = readToken === null
        ? {
          jobs,
          board_url: null,
          read_token: null,
          generated_at: generatedAt,
          notice: "未配置只读凭据（DISPATCHER_HTTP_READ_TOKEN）：board_url/read_token 不可用，widget 经 dlz://board 资源轮询（约 2s）取数。",
        }
        : {
          jobs,
          board_url: `${BOARD_HTTP_ORIGIN}/board?read_token=${encodeURIComponent(readToken)}`,
          read_token: readToken,
          generated_at: generatedAt,
          notice: null,
        };
      return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) {
      return errorResult(error);
    }
  };
  server.registerTool(
    "render_board",
    {
      title: "Render Dispatcher board",
      description: "Render the aggregated Dispatcher board (all non-terminal jobs plus a bounded newest-first terminal window); the board refreshes itself through the local SSE endpoint when reachable, otherwise through the dlz://board read-only resource. This tool dispatches nothing and modifies no job.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: BOARD_RESOURCE_URI } },
    },
    boardTool,
  );
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 启动路径：实例锁 acquire（第二 owner 拒绝启动）→ 索引加载/重建 → 恢复扫描，
  // 完成后才对外提供工具。
  void serveStdio(async () => {
    const dispatcher = createDispatcherFromEnvironment();
    await dispatcher.initialize();
    return createMcpServer(dispatcher, process.env);
  });
}
