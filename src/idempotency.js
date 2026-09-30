import { createHash } from "node:crypto";

// request_id 幂等判定（IMPLEMENTATION §4 / 蓝图 §4）。
//
// 规范化：validateDispatchInput 完成后的目标 CLI、项目标识、模型、effort、任务文本
// 即为规范化请求；摘要只存 digest，不另存明文 prompt。
// 判定：同 id 同摘要 → 命中（返回原 job，不再次启动）；同 id 不同摘要 → idempotency_conflict。

// 固定键序的规范化请求串（JSON 字段顺序即规范化的一部分，避免键序抖动产生不同摘要）。
export function canonicalRequest(validated) {
  return JSON.stringify({
    agent: validated.agent,
    project: validated.project,
    model: validated.model,
    effort: validated.effort,
    task: validated.task,
  });
}

// 规范化请求摘要：sha256 hex。不含明文 prompt 全文（快照/索引只保存本摘要）。
export function requestDigest(validated) {
  return createHash("sha256").update(canonicalRequest(validated), "utf8").digest("hex");
}

// 查表判定：miss / hit / conflict。
// hit 要求索引条目携带相同 request_digest；条目缺摘要时按 conflict 处理（不能确认一致，
// 宁可拒绝也不重复执行——重复执行的代价高于一次显式冲突报错）。
export function adjudicateRequest(entry, digest) {
  if (entry === undefined || entry === null) return "miss";
  if (typeof entry.request_digest === "string" && entry.request_digest === digest) return "hit";
  return "conflict";
}
