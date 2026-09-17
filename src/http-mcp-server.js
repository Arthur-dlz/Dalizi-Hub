import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createDispatcherFromEnvironment, createMcpServer } from "./mcp-server.js";

export const HTTP_MCP_HOST = "127.0.0.1";
export const HTTP_MCP_PORT = 18490;
export const HTTP_MCP_PATH = "/mcp";
export const HTTP_BEARER_TOKEN_ENV = "DISPATCHER_HTTP_BEARER_TOKEN";

const MAX_REQUEST_BYTES = 1_000_000;

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

export function createHttpMcpServer({ dispatcher, bearerToken }) {
  if (!dispatcher) throw new Error("dispatcher is required");
  if (typeof bearerToken !== "string" || bearerToken.length < 32) throw new Error("bearerToken must be a dedicated credential of at least 32 characters");

  const handler = createMcpHandler(() => createMcpServer(dispatcher));
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : HTTP_MCP_PORT;
      const expectedHost = `${HTTP_MCP_HOST}:${port}`;
      const requestPath = new URL(request.url ?? HTTP_MCP_PATH, `http://${expectedHost}`).pathname;

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

export async function startHttpMcpServer({ dispatcher, bearerToken, port = HTTP_MCP_PORT }) {
  const server = createHttpMcpServer({ dispatcher, bearerToken });
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
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startHttpMcpServerFromEnvironment().catch((error) => {
    process.stderr.write(`HTTP MCP startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
