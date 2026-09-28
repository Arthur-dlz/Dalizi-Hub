import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { Dispatcher } from "./dispatcher.js";
import { DispatcherError } from "./contracts.js";
import { JobStore } from "./job-store.js";
import { ProjectRegistry, projectRegistryPath } from "./project-registry.js";
import { TASK_CARD_MIME_TYPE, TASK_CARD_RESOURCE_URI, readTaskCardHtml, taskCardResourceMeta } from "./task-card.js";
import { WorkBuddyRunner } from "./workbuddy-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { AntigravityRunner } from "./antigravity-runner.js";

const VERIFIED_MODELS = new Set(["custom-local:step-5-preview"]);
const VERIFIED_CODEX_MODELS = new Set(["gpt-6-sol"]);
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
    runner: new WorkBuddyRunner(),
    codexRunner: new CodexRunner({ environment }),
    antigravityRunner: new AntigravityRunner({ environment }),
  });
}

export function createMcpServer(dispatcher) {
  const server = new McpServer({ name: "dalizi-dispatcher", version: "0.0.0" });
  const readJob = (jobId) => dispatcher.get(jobId);
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
      description: "Queue one WorkBuddy, Codex, or Antigravity task for a registered alias or unique approved workspace directory.",
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
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void serveStdio(() => createMcpServer(createDispatcherFromEnvironment()));
}
