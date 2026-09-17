import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { Dispatcher } from "./dispatcher.js";
import { DispatcherError } from "./contracts.js";
import { JobStore } from "./job-store.js";
import { WorkBuddyRunner } from "./workbuddy-runner.js";

const VERIFIED_MODELS = new Set(["custom-local:step-3.7-flash"]);

function errorResult(error) {
  const code = error instanceof DispatcherError ? error.code : "internal_error";
  const message = error instanceof DispatcherError ? error.message : "Dispatcher failed";
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] };
}

function successResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function loadRegistry(raw) {
  if (!raw) return {};
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    throw new DispatcherError("invalid_registry", "DISPATCHER_PROJECT_REGISTRY must be JSON");
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new DispatcherError("invalid_registry", "DISPATCHER_PROJECT_REGISTRY must be an object");
  }
  for (const [alias, cwd] of Object.entries(registry)) {
    if (alias !== "canary-project" || typeof cwd !== "string" || !path.isAbsolute(cwd)) {
      throw new DispatcherError("invalid_registry", "registry aliases and paths are invalid");
    }
  }
  return registry;
}

export function createDispatcherFromEnvironment(environment = process.env) {
  const dataDirectory = environment.DISPATCHER_DATA_DIR || path.join(process.cwd(), ".dispatcher-data");
  return new Dispatcher({
    registry: loadRegistry(environment.DISPATCHER_PROJECT_REGISTRY),
    allowedModels: VERIFIED_MODELS,
    store: new JobStore(dataDirectory),
    runner: new WorkBuddyRunner(),
  });
}

export function createMcpServer(dispatcher) {
  const server = new McpServer({ name: "dalizi-dispatcher", version: "0.0.0" });
  server.registerTool(
    "dispatch_task",
    {
      description: "Queue one WorkBuddy task for an explicitly registered project alias.",
      inputSchema: z.object({
        agent: z.string().max(80),
        project: z.string().max(80),
        task: z.string().max(8_000),
        model: z.string().max(160),
        effort: z.string().max(20).optional(),
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
      inputSchema: z.object({ job_id: z.string().max(128) }),
    },
    async ({ job_id: jobId }) => {
      try {
        return successResult(await dispatcher.get(jobId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void serveStdio(() => createMcpServer(createDispatcherFromEnvironment()));
}
