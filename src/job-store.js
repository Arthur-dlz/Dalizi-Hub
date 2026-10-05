import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DispatcherError } from "./contracts.js";

// 快照 schema 版本（IMPLEMENTATION §3.1）。读旧文件（无 schema_version 或显式 1）按 v1 兼容；
// 高于本版本的快照拒绝解读，避免把未来结构误标为当前语义。
export const SNAPSHOT_SCHEMA_VERSION = 2;

// 终态集合：listNonTerminal 恢复扫描只应看到非终态；RECOVERY_REQUIRED（T2）是非终态，必须被扫到。
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
// reducer 接受的事件 kind 闭集（IMPLEMENTATION §3.2 / 蓝图 §5）。
const EVENT_KINDS = new Set(["started", "activity", "usage", "heartbeat", "result", "error"]);
const JOB_FILE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function now() {
  return new Date().toISOString();
}

function noop() {}

// Windows 下 AV/索引器等短嘱占用目标文件时 rename 可能返回 EPERM/EBUSY（瞬态；与 V0 同路径，
// A/B 实测同概率存在）。rename 是原子操作：有限次重试不产生部分写、不改变落盘语义，
// 只压缩瞬态失败窗口——否则一次瞬态 EPERM 会让有序更新整体落入 dispatcher 的 FAILED 分支。
async function renameWithRetry(temporary, filename) {
  const delaysMs = [5, 20, 80];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, filename);
      return;
    } catch (error) {
      const transient = Boolean(error) && (error.code === "EPERM" || error.code === "EBUSY");
      if (!transient || attempt >= delaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

function emptyLiveness() {
  return {
    owner_heartbeat_at: null,
    process_checked_at: null,
    process_state: null,
    last_event_at: null,
    last_output_at: null,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jobPath(directory, jobId) {
  if (typeof jobId !== "string" || !JOB_FILE_PATTERN.test(jobId)) {
    throw new DispatcherError("invalid_job_id", "job_id has an invalid format");
  }
  return path.join(directory, `${jobId}.json`);
}

// v2 写入信封：调用方显式提供的值优先，缺省补 §3.1 默认值；观测类字段不伪造。
function snapshotEnvelope(job) {
  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    revision: typeof job.revision === "number" && job.revision >= 0 ? job.revision : 1,
    updated_at: typeof job.updated_at === "string" ? job.updated_at : now(),
    request_id: job.request_id ?? null,
    request_digest: job.request_digest ?? null,
    activity: job.activity ?? null,
    liveness: { ...emptyLiveness(), ...(isPlainObject(job.liveness) ? job.liveness : {}) },
    usage: job.usage ?? null,
    execution_state: job.execution_state ?? "idle",
    completion_evidence: job.completion_evidence ?? null,
  };
}

// v1 兼容读取：无 schema_version（或显式 1）的旧文件补 null/初值，不伪造历史心跳与 revision；
// 仅在内存中规范化视图，不回头改写旧文件。高于 2 的版本显式报错，不误标。
function normalizeRead(record) {
  if (!isPlainObject(record)) return record;
  const version = record.schema_version;
  if (version === undefined || version === 1) {
    return {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      revision: typeof record.revision === "number" ? record.revision : null,
      updated_at: typeof record.updated_at === "string" ? record.updated_at : null,
      request_id: record.request_id ?? null,
      request_digest: record.request_digest ?? null,
      activity: record.activity ?? null,
      usage: record.usage ?? null,
      execution_state: record.execution_state ?? null,
      completion_evidence: record.completion_evidence ?? null,
      ...record,
      liveness: { ...emptyLiveness(), ...(isPlainObject(record.liveness) ? record.liveness : {}) },
    };
  }
  if (version !== SNAPSHOT_SCHEMA_VERSION) {
    throw new DispatcherError("unsupported_snapshot_version", `snapshot schema_version ${version} is newer than supported ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  return record;
}

// reducer 前必须通过的事件校验（快速失败，不进队列）。
function validateEvent(event) {
  if (!isPlainObject(event)) {
    throw new DispatcherError("invalid_event", "event must be an object");
  }
  if (typeof event.job_id !== "string" || !JOB_FILE_PATTERN.test(event.job_id)) {
    throw new DispatcherError("invalid_event", "event.job_id has an invalid format");
  }
  if (!EVENT_KINDS.has(event.kind)) {
    throw new DispatcherError("invalid_event", `unsupported event kind: ${JSON.stringify(event.kind)}`);
  }
}

function baseRevision(current) {
  return typeof current.revision === "number" && current.revision >= 0 ? current.revision : 0;
}

// 纯函数：当前快照 × 事件 → 下一快照。revision 单调 +1；终态粘滞（首个终态胜出，迟到的
// started/result/error 不改状态），liveness/activity/usage 观测照常刷新。
function reduceSnapshot(current, event) {
  const next = {
    ...current,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    revision: baseRevision(current) + 1,
    updated_at: now(),
  };
  const payload = isPlainObject(event.payload) ? event.payload : null;
  const observedAt = typeof event.observed_at === "string" ? event.observed_at : null;
  const eventAt = observedAt ?? next.updated_at;
  const liveness = { ...emptyLiveness(), ...(isPlainObject(current.liveness) ? current.liveness : {}) };
  liveness.last_event_at = eventAt;
  const terminal = TERMINAL_STATUSES.has(current.status);

  switch (event.kind) {
    case "started": {
      next.execution_state = "running";
      if (!terminal) next.status = "RUNNING";
      break;
    }
    case "activity": {
      const label = payload && typeof payload.label === "string" ? payload.label : null;
      next.activity = {
        kind: payload && typeof payload.kind === "string" ? payload.kind : null,
        label,
        state: payload && typeof payload.state === "string" ? payload.state : null,
        source: isPlainObject(event.source) && typeof event.source.agent === "string" ? event.source.agent : null,
        observed_at: observedAt,
      };
      if (label !== null) next.current_activity = label; // 蓝图 §4：卡片字符串展示形式保留
      break;
    }
    case "usage": {
      // payload 直接是 §5.6 指标字典，或包一层 { usage }；整体替换（snapshot 语义），不做累加推导。
      const usage = payload && isPlainObject(payload.usage) ? payload.usage : payload;
      if (usage) next.usage = usage;
      break;
    }
    case "heartbeat": {
      liveness.owner_heartbeat_at = eventAt;
      liveness.process_checked_at = eventAt;
      if (payload && typeof payload.process_state === "string") liveness.process_state = payload.process_state;
      break;
    }
    case "result": {
      if (!terminal) {
        next.status = "COMPLETED";
        next.execution_state = "stopped";
        if (payload && "final_text" in payload) next.final_text = payload.final_text ?? null;
        if (payload && typeof payload.actual_model === "string") next.actual_model = payload.actual_model;
        if (payload && isPlainObject(payload.usage)) next.usage = payload.usage;
        if (payload && isPlainObject(payload.completion_evidence)) next.completion_evidence = payload.completion_evidence;
      }
      break;
    }
    case "error": {
      if (!terminal) {
        next.status = "FAILED";
        next.execution_state = "stopped";
        const kind = payload && typeof payload.kind === "string" ? payload.kind : "runner_error";
        const message = payload && typeof payload.message === "string" ? payload.message : null;
        next.error = payload && payload.diagnostics !== undefined
          ? { kind, message, diagnostics: payload.diagnostics }
          : { kind, message };
        if (payload && isPlainObject(payload.usage)) next.usage = payload.usage;
      }
      break;
    }
    default:
      throw new DispatcherError("invalid_event", `unsupported event kind: ${JSON.stringify(event.kind)}`);
  }

  next.liveness = liveness;
  return next;
}

// JobStore：快照持久化 + per-job FIFO 串行 reducer seam（IMPLEMENTATION §5.2）。
// 所有状态变更（apply / 遗留 update）都流经同一串行队列与同一临时文件+rename 落盘路径，
// 关闭 V0 read-merge-write 丢更新风险；禁止调用方旁路直接写快照。
export class JobStore {
  #queues = new Map(); // job_id -> 串行链尾Promise

  constructor(directory) {
    if (typeof directory !== "string" || directory.length === 0) {
      throw new DispatcherError("invalid_store_directory", "store directory must be a non-empty string");
    }
    this.directory = directory;
  }

  // 创建 job：保留调用方全部字段，补 v2 信封（schema_version 恒 2、revision 起 1）。
  // 重复 create 同名 job 由覆盖写语义保持 V0 行为；防重复创建由 T2 准入区间负责。
  async create(job) {
    if (!isPlainObject(job) || typeof job.job_id !== "string") {
      throw new DispatcherError("invalid_job", "job must include job_id");
    }
    const record = { ...job, ...snapshotEnvelope(job) };
    await this.#write(jobPath(this.directory, job.job_id), record);
    return record;
  }

  // 读取快照：v2 原样返回；v1 兼容补 null/初值（不伪造历史心跳），仅在内存中规范化。
  async get(jobId) {
    const filename = jobPath(this.directory, jobId);
    let raw;
    try {
      raw = await readFile(filename, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new DispatcherError("unknown_job", "job_id was not found");
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DispatcherError("snapshot_corrupt", `job snapshot is not valid JSON: ${jobId}`);
    }
    return normalizeRead(parsed);
  }

  // 遗留补丁路径（V0 兼容）：仍走同一串行 seam，revision +1、updated_at 刷新；
  // job_id 与 revision 权威归 seam 所有，patch 不能覆盖。
  async update(jobId, patch) {
    jobPath(this.directory, jobId);
    if (!isPlainObject(patch)) {
      throw new DispatcherError("invalid_patch", "patch must be an object");
    }
    return this.#enqueue(jobId, async () => {
      const current = await this.get(jobId);
      const next = {
        ...current,
        ...patch,
        job_id: current.job_id,
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        revision: baseRevision(current) + 1,
        updated_at: now(),
      };
      await this.#write(jobPath(this.directory, jobId), next);
      return next;
    });
  }

  // reducer 入口：per-job FIFO 串行应用事件（读快照 → 归约 → revision+1 → rename 落盘）。
  // 校验先于入队，失败不污染队列；未知 job 在队列内按 unknown_job 失败。
  async apply(jobId, event) {
    jobPath(this.directory, jobId);
    validateEvent(event);
    if (event.job_id !== jobId) {
      throw new DispatcherError("invalid_event", "event.job_id does not match the target job");
    }
    return this.#enqueue(jobId, async () => {
      const current = await this.get(jobId);
      const next = reduceSnapshot(current, event);
      await this.#write(jobPath(this.directory, jobId), next);
      return next;
    });
  }

  // 全量扫描（含终态）：幂等索引对账重建的记录来源（蓝图 §4 v1.2 恒对账）。
  // 忽略 .tmp 残尾与非 job 文件名；损坏快照显式报错，绝不静默跳过（跳过会向恢复扫描隐瞒非终态占用）。
  // P5 OPS3 修复（2026-10-04 live）：JOB_FILE_PATTERN 宽松（字母数字下划线连字符），
  // 同目录的 project-registry.json / workspace-roots.json 等运营文件会过筛，
  // 经 normalizeRead v1 兼容补齐后被误当无终态 job 记录（看板头部残缺项、恢复扫描脏数据）。
  // 权威判据 = 记录内容自带 job_id；无 job_id 的合法 JSON 属非 job 运营文件，跳过（非"损坏快照"，
  // 无非终态占用可言，不违反上方"绝不静默跳过坏快照"原则）。
  async listAll() {
    let names;
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error && error.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const jobId = name.slice(0, -".json".length);
      if (!JOB_FILE_PATTERN.test(jobId)) continue;
      const parsed = await this.#readSnapshotFile(jobPath(this.directory, jobId), jobId);
      if (parsed === null) continue; // 扫描瞬间被消费/改名
      if (typeof parsed.job_id !== "string" || parsed.job_id.length === 0) continue; // 非 job 运营文件（如 registry/roots）
      records.push(parsed);
    }
    records.sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")));
    return records;
  }

  // 恢复扫描入口：仅非终态（QUEUED/RUNNING/RECOVERY_REQUIRED 等）。
  async listNonTerminal() {
    const records = await this.listAll();
    return records.filter((record) => !TERMINAL_STATUSES.has(record.status));
  }

  async #readSnapshotFile(filename, jobId) {
    let raw;
    try {
      raw = await readFile(filename, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DispatcherError("snapshot_corrupt", `job snapshot is not valid JSON: ${jobId}`);
    }
    return normalizeRead(parsed);
  }

  // per-job FIFO 串行链：同一 job 的变更严格排队；前一个任务失败不堵死后续（reducer 具备容错前进语义）。
  // 每个调用方通过返回的 run 观察自己任务的成败；存储用的链尾只承担串行职责，失败不二次传播，
  // 避免无后续任务时链尾 rejection 变成 unhandledRejection。
  #enqueue(jobId, task) {
    const previous = this.#queues.get(jobId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(noop, noop).finally(() => {
      if (this.#queues.get(jobId) === tail) this.#queues.delete(jobId);
    });
    this.#queues.set(jobId, tail);
    return run;
  }

  async #write(filename, value) {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(temporary, filename);
  }
}
