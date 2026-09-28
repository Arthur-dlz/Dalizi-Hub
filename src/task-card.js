import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const TASK_CARD_RESOURCE_URI = "ui://dalizi-dispatcher/task-card.html";
export const TASK_CARD_MIME_TYPE = "text/html;profile=mcp-app";

const taskCardPath = fileURLToPath(new URL("./task-card.html", import.meta.url));

export function taskCardResourceMeta() {
  return { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } };
}

export function readTaskCardHtml() {
  return readFile(taskCardPath, "utf8");
}
