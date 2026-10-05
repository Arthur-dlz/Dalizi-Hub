import { randomUUID } from "node:crypto";
import { DispatcherError, resolveProject, validateDispatchInput } from "./contracts.js";
import { adjudicateRequest, requestDigest } from "./idempotency.js";
import { scanRecovery } from "./recovery.js";
import { createDefaultProcessProbe } from "./instance-lock.js";

const TERMINAL = new Set(["COMPLETED", "FAILED"]);

// owner 心跳工程初值（蓝图 §7，可配置）：5s 周期、15s 观察过期。
// 过期只影响可信度显示，不触发 kill、重跑或释放占用。
export const OWNER_HEARTBEAT_INTERVAL_MS = 5_000;
export const OWNER_HEARTBEAT_STALE_MS = 15_000;

function now() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 二分找最大可见前缀：载荷序列化不超过 BOARD_MAX_BYTES 的最大条数。
// 测量固定以 truncated=false 计（比最终 true 长 1 字节，保守），保证最终响应必然在限内。
function largestPrefixWithinBudget(jobs, total, windowTruncated) {
  const payloadBytes = (count) => Buffer.byteLength(
    JSON.stringify({ jobs: jobs.slice(0, count), truncated: false, total }),
    "utf8",
  );
  let low = 0;
  let high = jobs.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (payloadBytes(middle) <= BOARD_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  return low;
}

// P5 只读看板聚合边界（蓝图 §12.2 / IMPLEMENTATION §9.1 实现声明常量）：
// 终态窗口 50 条（按 finished_at 降序取最近）+ 响应字节上限 1 MiB；
// 超限按同序截断并保留 total 与截断标记，不静默丢弃。
export const BOARD_TERMINAL_WINDOW = 50;
export const BOARD_MAX_BYTES = 1024 * 1024;

// 展示辅助：owner 心跳是否已过期（true/false）；从未观测返回 null（不可观测，不伪造）。
export function isOwnerHeartbeatStale(liveness, { atMs = Date.now(), thresholdMs = OWNER_HEARTBEAT_STALE_MS } = {}) {
  const heartbeatMs = liveness && typeof liveness.owner_heartbeat_at === "string"
    ? Date.parse(liveness.owner_heartbeat_at)
    : NaN;
  if (!Number.isFinite(heartbeatMs)) return null;
  return atMs - heartbeatMs > thresholdMs;
}

// 可信 executable 证据：runner 已解析的可执行文件（wb 为 node 可执行）。
function runnerTrustedExecutable(runner) {
  if (!runner) return null;
  if (typeof runner.executable === "string") return runner.executable;
  if (typeof runner.nodeExecutable === "string") return runner.nodeExecutable;
  return null;
}

// 完成证据（蓝图 §7 / IMPLEMENTATION §3.1）：COMPLETED 要求协议终态 + 持久结果 + 正常退出；
// 冲突证据不得报成功。session_match 在 V0 runner 契约下不可观测（T3 adapter 落地）。
function buildCompletionEvidence(run) {
  const exitCode = run && run.diagnostics && Number.isInteger(run.diagnostics.process_exit_code)
    ? run.diagnostics.process_exit_code
    : null;
  const protocolTerminal = Boolean(run) && run.status === "COMPLETED";
  const resultPersisted = Boolean(run) && typeof run.finalText === "string" && run.finalText.length > 0;
  const notes = [];
  if (protocolTerminal && !resultPersisted) notes.push("protocol terminal without a persisted result");
  if (exitCode !== null && exitCode !== 0) notes.push(`non-zero process exit code ${exitCode} conflicts with the reported completion`);
  if (protocolTerminal && resultPersisted && exitCode === null) notes.push("process exit code not observed");
  const completed = protocolTerminal && resultPersisted && (exitCode === null || exitCode === 0);
  return {
    completed,
    exit_code: exitCode,
    evidence: {
      protocol_terminal: protocolTerminal,
      session_match: null,
      exit_code: exitCode,
      result_persisted: resultPersisted,
      notes: notes.length > 0 ? notes.join("; ") : null,
    },
  };
}

export class Dispatcher {
  #admission = Promise.resolve(); // 串行准入区间（单一 async mutex 链）
  #initialized = null; // 启动路径单飞 promise：锁 → 索引重建 → 恢复扫描
  #ownerId = randomUUID();

  constructor({
    registry,
    allowedModels,
    store,
    runner,
    codexRunner,
    antigravityRunner,
    idempotencyIndex = null,
    instanceLock = null,
    processProbe = createDefaultProcessProbe(),
    ownerHeartbeatIntervalMs = OWNER_HEARTBEAT_INTERVAL_MS,
    recoveryEnabled = true,
  }) {
    this.registry = registry;
    this.allowedModels = allowedModels;
    this.store = store;
    this.runner = runner;
    this.codexRunner = codexRunner;
    this.antigravityRunner = antigravityRunner;
    this.idempotencyIndex = idempotencyIndex;
    this.instanceLock = instanceLock;
    this.processProbe = processProbe;
    this.ownerHeartbeatIntervalMs = ownerHeartbeatIntervalMs;
    this.recoveryEnabled = recoveryEnabled;
    this.activeJobId = null;
  }

  // 启动路径（幂等、单飞）：实例锁 acquire（第二 owner 拒绝）→ 索引审计加载 + 权威重建 →
  // 恢复扫描（§5.4）。锁必须在扫描前取得：先成为唯一写者，再动非终态记录。
  async initialize() {
    if (!this.#initialized) {
      this.#initialized = (async () => {
        if (this.instanceLock) {
          const acquired = await this.instanceLock.acquire();
          this.instanceLockAcquisition = acquired;
          this.instanceLock.startHeartbeat();
        }
        if (this.idempotencyIndex) {
          await this.idempotencyIndex.load();
          // 只对账真正的 job 记录：状态目录中的非 job JSON（project-registry 等）不进索引。
          const jobRecords = (await this.store.listAll())
            .filter((record) => Boolean(record) && typeof record === "object"
              && typeof record.job_id === "string" && record.job_id.length > 0);
          await this.idempotencyIndex.rebuild(jobRecords);
        }
        if (this.recoveryEnabled) {
          this.lastRecoveryScan = await scanRecovery({ store: this.store, probe: this.processProbe });
        }
      })();
    }
    return this.#initialized;
  }

  async dispatch(input) {
    await this.initialize();
    return this.#enqueueAdmission(async () => this.#admit(input));
  }

  async get(jobId) {
    return this.store.get(jobId);
  }

  // P5 只读看板聚合（蓝图 §12.2 / IMPLEMENTATION §9.1）：store 两个只读 list 合并为
  // 快照信封数组——非终态全量在前（updated_at 降序），终态按 finished_at 降序取最近
  // BOARD_TERMINAL_WINDOW 条；整体再受 BOARD_MAX_BYTES 字节上限约束，超限按同序从尾部
  // 截断并置 truncated。纯只读：不写 store、不动实例锁、不触发恢复扫描。
  // 终态集合权威归 store（listNonTerminal 的补集），此处不复制状态集。
  async listBoard() {
    const all = await this.store.listAll();
    const nonTerminal = await this.store.listNonTerminal();
    const nonTerminalIds = new Set(nonTerminal.map((record) => record.job_id));
    const total = all.length;
    const orderedNonTerminal = [...nonTerminal].sort((left, right) =>
      String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
    const orderedTerminal = all
      .filter((record) => !nonTerminalIds.has(record.job_id))
      .sort((left, right) => String(right.finished_at ?? "").localeCompare(String(left.finished_at ?? "")));
    const windowedTerminal = orderedTerminal.slice(0, BOARD_TERMINAL_WINDOW);
    const jobs = [...orderedNonTerminal, ...windowedTerminal];
    const windowTruncated = orderedTerminal.length > windowedTerminal.length;
    const visible = largestPrefixWithinBudget(jobs, total, windowTruncated);
    return {
      jobs: jobs.slice(0, visible),
      truncated: windowTruncated || visible < jobs.length,
      total,
    };
  }

  // 串行准入区间（IMPLEMENTATION §5.1）：区间内完成 lookup(request_id) → busy →
  // 创建 QUEUED + 索引追加 → 设置占用；区间外无上述读写。
  #enqueueAdmission(step) {
    const run = this.#admission.then(step, step);
    this.#admission = run.then(() => undefined, () => undefined);
    return run;
  }

  async #admit(input) {
    const validated = validateDispatchInput(input, this.allowedModels);
    const cwd = await resolveProject(validated.project, this.registry);
    const digest = requestDigest(validated);

    // 幂等查表先于 busy：运行中重试能取回原 job。
    if (validated.request_id && this.idempotencyIndex) {
      const entry = this.idempotencyIndex.lookup(validated.request_id);
      const verdict = adjudicateRequest(entry, digest);
      if (verdict === "hit") {
        const job = await this.store.get(entry.job_id);
        return { job_id: job.job_id, status: job.status, request_id: validated.request_id };
      }
      if (verdict === "conflict") {
        throw new DispatcherError("idempotency_conflict", "request_id is already bound to a different request");
      }
    }

    if (this.activeJobId) {
      throw new DispatcherError("dispatcher_busy", "only one Dispatcher job may run at a time");
    }

    const jobId = randomUUID();
    this.activeJobId = jobId;
    try {
      // 崩溃写入顺序契约：先持久化 job 记录（含 request_id 与摘要），再追加索引日志。
      const job = await this.store.create({
        job_id: jobId,
        agent: validated.agent,
        project: validated.project,
        cwd,
        requested_model: validated.model,
        actual_model: "NOT_OBSERVABLE",
        effort: validated.effort,
        status: "QUEUED",
        created_at: now(),
        started_at: null,
        finished_at: null,
        pid: null,
        final_text: null,
        error: null,
        request_id: validated.request_id ?? null,
        request_digest: validated.request_id ? digest : null,
      });
      if (validated.request_id && this.idempotencyIndex) {
        await this.idempotencyIndex.append({
          request_id: validated.request_id,
          job_id: jobId,
          request_digest: digest,
          created_at: now(),
        });
      }
      setImmediate(() => void this.#execute(job, validated));
      return { job_id: job.job_id, status: job.status, request_id: validated.request_id ?? null };
    } catch (error) {
      this.activeJobId = null;
      throw error;
    }
  }

  // per-job 事件 sink（IMPLEMENTATION §3.2/§5.2）：runner 部分封套在此补全 job_id 与
  // per-job 单调递增 seq，经 JobStore.apply 进入 per-job FIFO 串行 seam——apply 本身即
  // 队列入口，sink 不另建旁路队列。owner 心跳与 runner 事件共享同一 seq 空间、同一 seam，
  // 禁止任何旁路直写快照。emit 入口对 runner 永不抛错：包装/入队异常只旁路计数，
  // 不进 diagnostics、不拖垮 job、不改变终局判定。
  #createEventSink(jobId, agent) {
    const state = { seq: 0, emitErrors: 0 };
    const applyEvent = (kind, payload, partial = {}) => {
      state.seq += 1;
      return this.store.apply(jobId, {
        schema_version: 1,
        job_id: jobId,
        seq: state.seq,
        observed_at: typeof partial.observed_at === "string" ? partial.observed_at : now(),
        source: isPlainObject(partial.source)
          ? partial.source
          : { agent, cli_version: null, session_id: null, event_id: null },
        kind,
        payload,
      });
    };
    return {
      applyEvent,
      get emitErrors() { return state.emitErrors; },
      emit(partial) {
        try {
          if (!isPlainObject(partial) || typeof partial.kind !== "string") {
            state.emitErrors += 1;
            return;
          }
          void applyEvent(partial.kind, partial.payload, partial).catch(() => { state.emitErrors += 1; });
        } catch {
          state.emitErrors += 1;
        }
      },
    };
  }

  // owner 心跳（蓝图 §7 / IMPLEMENTATION §5.2）：经 sink 进入与 runner 事件相同的
  // per-job FIFO seam、共享同一 seq 空间；过期只影响可信度显示，不触发 kill/重跑/释放。
  // payload 只声明 owner 自身存活（心跳即证据），不推断子进程身份——身份判定归恢复扫描。
  async #emitHeartbeat(sink) {
    await sink.applyEvent("heartbeat", { process_state: "alive" });
  }

  async #execute(job, input) {
    let heartbeatTimer = null;
    let settled = false;
    let claim = {
      owner_id: this.#ownerId,
      owner_pid: process.pid,
      claimed_at: now(),
      trusted_executable: null,
      child_pid: null,
      child_start_time: null,
      released_at: null,
    };
    try {
      const runner = input.agent === "codex"
        ? this.codexRunner
        : input.agent === "antigravity"
          ? this.antigravityRunner
          : this.runner;
      claim.trusted_executable = runnerTrustedExecutable(runner);

      // spawn 前持久化执行 claim（owner identity、PID、创建时间、可信 executable）。
      await this.store.update(job.job_id, {
        status: "RUNNING",
        started_at: now(),
        execution_state: "claimed",
        claim,
      });
      await this.store.update(job.job_id, { execution_state: "spawning" });

      // per-job 事件 sink：runner emit 与 owner 心跳共享同一 seq 空间、同一 reducer seam。
      const sink = this.#createEventSink(job.job_id, input.agent);

      // owner 心跳：5s 周期，走与 runner 事件同一 reducer seam；不触发 kill/重跑/释放。
      heartbeatTimer = setInterval(() => {
        void this.#emitHeartbeat(sink).catch(() => {});
      }, this.ownerHeartbeatIntervalMs);
      if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

      const run = await runner.run({
        cwd: job.cwd,
        model: input.model,
        effort: input.effort,
        task: input.task,
        emit: sink.emit,
        onStarted: async (pid) => {
          claim = { ...claim, child_pid: pid };
          await this.store.update(job.job_id, { pid, execution_state: "running", claim });
          // 子进程身份证据尽力异步落盘（崩溃窗口由恢复扫描按 unknown 处理）。
          void Promise.resolve(this.processProbe(pid))
            .then((identity) => {
              if (settled || !identity || !identity.alive || typeof identity.startTime !== "string") return undefined;
              claim = { ...claim, child_start_time: identity.startTime };
              return this.store.update(job.job_id, { claim });
            })
            .catch(() => {});
        },
      });

      settled = true;
      // 终态收敛（IMPLEMENTATION §5.2）：runner 的 result/error 事件已先行经 sink 进入同一
      // per-job FIFO（reducer 终态粘滞=首个终态胜出）；此处的权威终态写携带 completion_evidence
      // 全量语义在同队列随后落盘——patch 语义即"dispatcher 终局判定优先"，事件不会改写它，
      // 迟到事件也无法打破已落盘终态（reducer 对终态 job 只刷新 liveness/activity/usage 观测）。
      const verdict = buildCompletionEvidence(run);
      const current = await this.store.get(job.job_id);
      await this.store.update(job.job_id, {
        pid: Number.isInteger(run.pid) ? run.pid : current.pid,
        status: verdict.completed ? "COMPLETED" : "FAILED",
        actual_model: run.actualModel ?? "NOT_OBSERVABLE",
        final_text: run.finalText,
        error: verdict.completed
          ? null
          : (typeof run.error === "string" && run.error.length > 0
            ? { kind: "runner_error", message: run.error }
            : { kind: "completion_evidence_conflict", message: verdict.evidence.notes ?? "completion evidence conflict" }),
        diagnostics: run.diagnostics ?? null,
        finished_at: now(),
        execution_state: "stopped",
        claim: current.claim ? { ...current.claim, released_at: now() } : claim,
        completion_evidence: verdict.evidence,
      });
    } catch (error) {
      settled = true;
      const current = await this.store.get(job.job_id).catch(() => null);
      await this.store.update(job.job_id, {
        status: "FAILED",
        error: { kind: "dispatcher_error", message: String(error?.message ?? error) },
        finished_at: now(),
        execution_state: "stopped",
        claim: current?.claim ? { ...current.claim, released_at: now() } : claim,
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.activeJobId = null;
    }
  }
}
