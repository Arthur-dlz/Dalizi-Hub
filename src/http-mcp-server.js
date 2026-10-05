import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createDispatcherFromEnvironment, createMcpServer } from "./mcp-server.js";

export const HTTP_MCP_HOST = "127.0.0.1";
export const HTTP_MCP_PORT = 18490;
export const HTTP_MCP_PATH = "/mcp";
export const HTTP_BEARER_TOKEN_ENV = "DISPATCHER_HTTP_BEARER_TOKEN";
export const HTTP_READ_TOKEN_ENV = "DISPATCHER_HTTP_READ_TOKEN";

// P5 只读数据面（蓝图 §12.4 / IMPLEMENTATION §9.2）：白名单式路由——除 /mcp 外仅这三个
// GET 只读路径放行，其余路径维持 404；不新增任何写路径。
export const HTTP_API_JOBS_PATH = "/api/jobs";
export const HTTP_EVENTS_PATH = "/events";
export const HTTP_BOARD_PATH = "/board";
const READ_ONLY_ROUTES = new Set([HTTP_API_JOBS_PATH, HTTP_EVENTS_PATH, HTTP_BOARD_PATH]);

// SSE 时序（IMPLEMENTATION §9.2 实现声明值）：1s 轮询 diff、15s 心跳注释行。
// 可经 createHttpMcpServer/startHttpMcpServer 注入以便测试，生产默认以下值。
export const SSE_POLL_INTERVAL_MS = 1_000;
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

const MAX_REQUEST_BYTES = 1_000_000;

const boardPagePath = fileURLToPath(new URL("./board.html", import.meta.url));

function configuredBearerToken(environment) {
  const token = environment[HTTP_BEARER_TOKEN_ENV];
  if (typeof token !== "string" || token.length < 32) {
    throw new Error(`${HTTP_BEARER_TOKEN_ENV} must be a non-empty dedicated credential of at least 32 characters`);
  }
  return token;
}

function hasBearerToken(header, expectedToken) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// 只读凭据（D1-a，IMPLEMENTATION §9.3）：未配置返回 null——三只读路径整体 404（默认安全）。
// 配置了但不足 32 字符视为无效，只读面保持关闭；警告不含凭据本身。
export function configuredReadToken(environment = process.env) {
  const token = environment[HTTP_READ_TOKEN_ENV];
  if (token === undefined) return null;
  if (typeof token !== "string" || token.length < 32) {
    process.stderr.write(`${HTTP_READ_TOKEN_ENV} is set but is not a dedicated credential of at least 32 characters; read-only routes stay disabled\n`);
    return null;
  }
  return token;
}

// 定长比较（与主 bearer 同一比较纪律）：长度不等直接拒，防 timingSafeEqual 抛异常。
function tokensMatch(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

// 只读访问判定（D1-a）：query param read_token 命中只读凭据，或 Authorization 头命中主
// bearer，二者皆通过。query 值与只读凭据比较；Authorization 头只与主 bearer 比较。
// 凭据不出现在日志与错误体中——失败只回 401。
function hasReadAccess(request, { readToken, bearerToken }) {
  const url = new URL(request.url ?? "/", `http://${HTTP_MCP_HOST}`);
  const queryToken = url.searchParams.get("read_token");
  if (queryToken !== null) return tokensMatch(queryToken, readToken);
  return hasBearerToken(request.headers.authorization, bearerToken);
}

function sendEmpty(response, statusCode, headers = {}) {
  response.writeHead(statusCode, headers);
  response.end();
}

async function readBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BYTES) throw new RangeError("request_body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function allowedOrigin(request, port) {
  const origin = request.headers.origin;
  return origin === undefined || origin === `http://${HTTP_MCP_HOST}:${port}`;
}

async function toWebRequest(request, port) {
  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
  return new Request(`http://${HTTP_MCP_HOST}:${port}${request.url ?? HTTP_MCP_PATH}`, {
    method,
    headers: requestHeaders(request),
    body: body?.length ? body : undefined,
  });
}

async function writeWebResponse(response, webResponse) {
  const headers = Object.fromEntries(webResponse.headers.entries());
  response.writeHead(webResponse.status, headers);
  if (!webResponse.body) {
    response.end();
    return;
  }
  Readable.fromWeb(webResponse.body).pipe(response);
}

function sendBoardJson(response, board) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(board));
}

async function sendBoardPage(response) {
  const html = await readFile(boardPagePath, "utf8");
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

// SSE（IMPLEMENTATION §9.2）：首轮立即轮询并推全量；之后每 pollIntervalMs 轮询 listBoard，
// 按 job 的 revision diff 推送 {"job_id","revision","snapshot"} 帧，无变化不推；
// 无事件满 heartbeatIntervalMs 发注释行心跳；客户端 close 时清理计时器与在途轮询——
// 无客户端即无轮询（单连接内存有界：revisions 表随 board.jobs 增减）。
function streamBoardEvents(request, response, dispatcher, { pollIntervalMs, heartbeatIntervalMs }) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const revisions = new Map();
  let timer = null;
  let cleaned = false;
  let inFlight = false;
  let lastEventAt = Date.now();
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  request.on("close", cleanup);
  response.on("error", cleanup);
  const write = (chunk) => {
    if (cleaned) return;
    try {
      response.write(chunk);
    } catch {
      cleanup();
    }
  };
  const tick = async () => {
    if (cleaned || inFlight) return; // 上一轮未结束不重入；积压由下一轮承接
    inFlight = true;
    try {
      const board = await dispatcher.listBoard();
      if (cleaned) return;
      const seen = new Set();
      let pushed = 0;
      for (const snapshot of board.jobs) {
        seen.add(snapshot.job_id);
        const previous = revisions.get(snapshot.job_id);
        revisions.set(snapshot.job_id, snapshot.revision);
        if (previous === snapshot.revision) continue;
        pushed += 1;
        write(`data: ${JSON.stringify({ job_id: snapshot.job_id, revision: snapshot.revision, snapshot })}\n\n`);
      }
      for (const jobId of [...revisions.keys()]) {
        if (!seen.has(jobId)) revisions.delete(jobId);
      }
      const now = Date.now();
      if (pushed > 0) {
        lastEventAt = now;
      } else if (now - lastEventAt >= heartbeatIntervalMs) {
        lastEventAt = now;
        write(`: hb ${new Date(now).toISOString()}\n\n`);
      }
    } catch {
      // 读失败静默跳过本轮，下一轮再试；内部错误不进入流内。
    } finally {
      inFlight = false;
    }
  };
  void tick(); // 首帧全量
  timer = setInterval(() => { void tick(); }, pollIntervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return cleanup;
}

export function createHttpMcpServer({
  dispatcher,
  bearerToken,
  readToken = null,
  ssePollIntervalMs = SSE_POLL_INTERVAL_MS,
  sseHeartbeatIntervalMs = SSE_HEARTBEAT_INTERVAL_MS,
}) {
  if (!dispatcher) throw new Error("dispatcher is required");
  if (typeof bearerToken !== "string" || bearerToken.length < 32) throw new Error("bearerToken must be a dedicated credential of at least 32 characters");
  // D1-a 默认关闭：未配置（或无效）只读 token 时，三只读路径一律 404。
  const readRoutesEnabled = typeof readToken === "string" && readToken.length >= 32;

  const handler = createMcpHandler(() => createMcpServer(dispatcher));
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : HTTP_MCP_PORT;
      const expectedHost = `${HTTP_MCP_HOST}:${port}`;
      const requestPath = new URL(request.url ?? HTTP_MCP_PATH, `http://${expectedHost}`).pathname;

      if (READ_ONLY_ROUTES.has(requestPath)) {
        // P5 只读数据面（蓝图 §12.4）：默认关闭 → 方法检查 → origin → 只读认证 → 分派。
        if (!readRoutesEnabled) return sendEmpty(response, 404);
        if (request.method !== "GET") return sendEmpty(response, 405, { allow: "GET" });
        if (!allowedOrigin(request, port)) return sendEmpty(response, 403);
        if (!hasReadAccess(request, { readToken, bearerToken })) return sendEmpty(response, 401, { "www-authenticate": "Bearer" });
        try {
          if (requestPath === HTTP_API_JOBS_PATH) return sendBoardJson(response, await dispatcher.listBoard());
          if (requestPath === HTTP_BOARD_PATH) return await sendBoardPage(response);
          return streamBoardEvents(request, response, dispatcher, { pollIntervalMs: ssePollIntervalMs, heartbeatIntervalMs: sseHeartbeatIntervalMs });
        } catch {
          if (response.headersSent) response.end();
          else sendEmpty(response, 500);
        }
        return;
      }

      if (requestPath !== HTTP_MCP_PATH) return sendEmpty(response, 404);
      if (!allowedOrigin(request, port)) return sendEmpty(response, 403);
      if (!hasBearerToken(request.headers.authorization, bearerToken)) return sendEmpty(response, 401, { "www-authenticate": "Bearer" });

      try {
        await writeWebResponse(response, await handler.fetch(await toWebRequest(request, port)));
      } catch (error) {
        if (error instanceof RangeError && error.message === "request_body_too_large") return sendEmpty(response, 413);
        sendEmpty(response, 500);
      }
    })();
  });
  return server;
}

export async function startHttpMcpServer(options) {
  const { port = HTTP_MCP_PORT, ...serverOptions } = options;
  const server = createHttpMcpServer(serverOptions);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: HTTP_MCP_HOST, port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export function startHttpMcpServerFromEnvironment(environment = process.env) {
  return startHttpMcpServer({
    dispatcher: createDispatcherFromEnvironment(environment),
    bearerToken: configuredBearerToken(environment),
    readToken: configuredReadToken(environment),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startHttpMcpServerFromEnvironment().catch((error) => {
    process.stderr.write(`HTTP MCP startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
