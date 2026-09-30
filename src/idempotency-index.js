// IdempotencyIndex：request_id → job_id 幂等索引（IMPLEMENTATION §3.3 / 蓝图 §4）。
//
// 写入顺序契约（T2 准入区间必须遵守）：先持久化 job 记录（含 request_id 与 request_digest），
// 再调用 append() 追加索引日志。索引只作审计/历史，**不作权威来源**：启动时恒由
// rebuild(job 记录全量) 对账重建内存 Map——即使日志完好但缺尾条目（崩溃窗口），
// 同 request_id 重试仍必命中原 job。
//
// 并发语义：append 幂等——同 request_id 同 job 重复调用不产生双条目、不重复写日志；
// 同 request_id 绑到不同 job 抛 idempotency_conflict。本类不自行加锁，串行准入由调用方保证。
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DispatcherError } from "./contracts.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// request_id 的正式格式规则（8–128 URL-safe）由 T2 在 contracts.js 的 MCP 边界校验；
// 索引层只做最小完整性检查，避免与 T2 规则重复或冲突。
function validateEntry(entry) {
  if (!isPlainObject(entry)) {
    throw new DispatcherError("invalid_index_entry", "index entry must be an object");
  }
  if (typeof entry.request_id !== "string" || entry.request_id.trim().length === 0 || entry.request_id.length > 128) {
    throw new DispatcherError("invalid_index_entry", "request_id must be a non-empty string no longer than 128 characters");
  }
  if (typeof entry.job_id !== "string" || entry.job_id.trim().length === 0) {
    throw new DispatcherError("invalid_index_entry", "job_id must be a non-empty string");
  }
}

function normalizeEntry(entry) {
  return {
    request_id: entry.request_id,
    job_id: entry.job_id,
    request_digest: typeof entry.request_digest === "string" ? entry.request_digest : null,
    created_at: typeof entry.created_at === "string" ? entry.created_at : null,
  };
}

export class IdempotencyIndex {
  #entries = new Map();

  constructor({ directory, logFile } = {}) {
    if (typeof directory !== "string" || directory.length === 0) {
      throw new DispatcherError("invalid_index_config", "index directory must be a non-empty string");
    }
    this.directory = directory;
    this.logFile = typeof logFile === "string" && logFile.length > 0
      ? logFile
      : path.join(directory, "run", "idempotency-index.jsonl");
    this.lastLoad = null; // { exists, lines, entries, conflicts, malformed }
    this.lastRebuild = null; // { jobsScanned, entries, duplicates }
  }

  get size() {
    return this.#entries.size;
  }

  // O(1) 查询入口（查询耗时不随历史增长）。
  lookup(requestId) {
    if (typeof requestId !== "string") return undefined;
    return this.#entries.get(requestId);
  }

  has(requestId) {
    return typeof requestId === "string" && this.#entries.has(requestId);
  }

  [Symbol.iterator]() {
    return this.#entries.values();
  }

  // 审计加载：解析 append-only 日志进内存 Map。日志非权威，内容问题不阻断启动——
  // 坏行记入 lastLoad.malformed，同 id 冲突行记入 lastLoad.conflicts（首条胜出）。
  async load() {
    let raw;
    try {
      raw = await readFile(this.logFile, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.lastLoad = { exists: false, lines: 0, entries: 0, conflicts: [], malformed: [] };
        return this.lastLoad;
      }
      throw error;
    }
    const lines = raw.split("\n");
    const conflicts = [];
    const malformed = [];
    let entries = 0;
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
        validateEntry(parsed);
      } catch {
        malformed.push(index + 1);
        continue;
      }
      const entry = normalizeEntry(parsed);
      const existing = this.#entries.get(entry.request_id);
      if (existing === undefined) {
        this.#entries.set(entry.request_id, entry);
        entries += 1;
      } else if (existing.job_id !== entry.job_id) {
        conflicts.push({ request_id: entry.request_id, kept_job_id: existing.job_id, conflicting_job_id: entry.job_id });
      }
    }
    this.lastLoad = { exists: true, lines: lines.length, entries, conflicts, malformed };
    return this.lastLoad;
  }

  // 权威重建：以 job 记录全量替换内存 Map（启动恒调用）。同 request_id 出现多次时
  // 首条记录（调用方给定顺序，JobStore.listAll 按 created_at 排序）胜出，冲突记入 duplicates
  // 供审计，不抛错——重建不得因历史数据问题阻断启动。
  async rebuild(jobRecords) {
    if (!jobRecords || typeof jobRecords[Symbol.iterator] !== "function") {
      throw new DispatcherError("invalid_rebuild_input", "rebuild requires an iterable of job records");
    }
    const entries = new Map();
    const duplicates = [];
    let jobsScanned = 0;
    for (const record of jobRecords) {
      jobsScanned += 1;
      const requestId = isPlainObject(record) ? record.request_id : undefined;
      if (typeof requestId !== "string" || requestId.trim() === "") continue;
      const entry = normalizeEntry(record);
      const existing = entries.get(requestId);
      if (existing === undefined) {
        entries.set(requestId, entry);
      } else if (existing.job_id !== entry.job_id) {
        duplicates.push({ request_id: entry.request_id, kept_job_id: existing.job_id, conflicting_job_id: entry.job_id });
      }
    }
    this.#entries = entries;
    this.lastRebuild = { jobsScanned, entries: entries.size, duplicates };
    return this.lastRebuild;
  }

  // 追加索引行（调用顺序：job 记录先落盘，本追加后执行）。幂等去重见类注释；
  // 先落日志（审计耐久）后进 Map（查询路径），两步之间的崩溃至多留下过期内存态，
  // 由下次启动 rebuild 从 job 记录纠正。
  async append(entry) {
    validateEntry(entry);
    const existing = this.#entries.get(entry.request_id);
    if (existing !== undefined) {
      if (existing.job_id === entry.job_id) return existing;
      throw new DispatcherError("idempotency_conflict", "request_id is already bound to a different job");
    }
    const normalized = normalizeEntry(entry);
    await mkdir(path.dirname(this.logFile), { recursive: true });
    await appendFile(this.logFile, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600 });
    this.#entries.set(normalized.request_id, normalized);
    return normalized;
  }
}
