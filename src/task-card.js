import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const TASK_CARD_RESOURCE_URI = "ui://dalizi-dispatcher/task-card.html";
export const TASK_CARD_MIME_TYPE = "text/html;profile=mcp-app";

// P5 CH3 聚合看板 UI 资源（蓝图 §12.3/§12.5 / IMPLEMENTATION §9.4）：render_board 的
// _meta.ui.resourceUri 指向该资源；widget 内 SSE 直连需 connectDomains 申报本地 origin，
// SSE 不可达时降级 dlz://board 资源轮询。单任务卡（task-card.html）meta 维持原样，
// 不因看板扩大白名单——它走 resources/read，无需直连。
export const BOARD_RESOURCE_URI = "ui://dalizi-dispatcher/board.html";
export const BOARD_MIME_TYPE = "text/html;profile=mcp-app";
// board widget 唯一许可直连的 origin（蓝图 §12.5：必须 127.0.0.1 不用 localhost，避 IPv6 假 404）。
// render_board 的 board_url 与此同源，单一事实源；禁扩大白名单范围（仅此一个 origin）。
export const BOARD_HTTP_ORIGIN = "http://127.0.0.1:18490";

const taskCardPath = fileURLToPath(new URL("./task-card.html", import.meta.url));
const boardPath = fileURLToPath(new URL("./board.html", import.meta.url));

export function taskCardResourceMeta() {
  return { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } };
}

// board widget CSP：connectDomains 恰好一个 origin（本地只读数据面）；resourceDomains 维持空。
export function boardResourceMeta() {
  return { ui: { csp: { connectDomains: [BOARD_HTTP_ORIGIN], resourceDomains: [] }, prefersBorder: true } };
}

export function readTaskCardHtml() {
  return readFile(taskCardPath, "utf8");
}

export function readBoardHtml() {
  return readFile(boardPath, "utf8");
}
