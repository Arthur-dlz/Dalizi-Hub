import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DispatcherError } from "./contracts.js";

const execFileAsync = promisify(execFile);

// 实例锁（IMPLEMENTATION §3.4/§5.3 / 蓝图 §7）：一个状态目录只有一个 writer。
// stdio 与 HTTP 入口共用同一状态目录时同锁；获取失败即第二 owner：拒绝启动。
//
// stale 判定（acquire 失败时读锁）：
//   heartbeat 新鲜（默认 30s，可配置）                        → 拒绝启动；
//   heartbeat 过期 且 owner PID 不存在                        → stale，归档旧锁后接管；
//   heartbeat 过期 且 PID 存活但创建时间晚于锁创建时间（复用） → stale，归档旧锁后接管；
//   heartbeat 过期 且 PID 存活、创建时间不晚于锁创建          → owner 存活，拒绝启动；
//   PID 存活但身份不可读                                       → 保守拒绝（不能证明 stale）。
// stale 接管只放行新 owner 启动，不证明旧 CLI 已停止。

export const DEFAULT_STALE_THRESHOLD_MS = 30_000;
export const DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS = 5_000;

function nowIso() {
  return new Date().toISOString();
}

function stampForArchive() {
  return nowIso().replace(/[:.]/g, "");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 进程身份探针：pid -> { alive: boolean, startTime: string|null }（ISO 时间）。
// startTime 为 null 表示身份不可读（调用方按 unknown 处理，不得推断存活或死亡）。
async function readProcessStartTimePosix(pid) {
  let stat;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const rest = stat.slice(stat.lastIndexOf(")") + 2);
  const fields = rest.split(" ");
  const startTicks = Number(fields[19]); // /proc stat 第 22 字段（1 起数）：自 boot 的时钟嘀嗒
  if (!Number.isFinite(startTicks)) return null;
  let uptime;
  try {
    uptime = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
  } catch {
    return null;
  }
  if (!Number.isFinite(uptime)) return null;
  const bootMs = Date.now() - uptime * 1000;
  return new Date(bootMs + (startTicks * 1000) / 100).toISOString(); // USER_HZ 按 100
}

async function readProcessStartTimeWindows(pid) {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `((Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate).ToUniversalTime().ToString("o")`,
      ],
      { timeout: 5000, windowsHide: true },
    );
    const raw = String(stdout).trim();
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

async function readProcessStartTime(pid) {
  if (process.platform === "win32") return readProcessStartTimeWindows(pid);
  return readProcessStartTimePosix(pid);
}

// 默认探针：process.kill(pid, 0) 判存在（ESRCH = 不存在）；存在时尽力读创建时间。
// Windows 创建时间经 PowerShell CIM 查询（约 1s 量级，仅在身份判定需要时调用）。
export function createDefaultProcessProbe() {
  return async function probeProcessIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return { alive: false, startTime: null };
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && (error.code === "ESRCH" || error.code === "EINVAL")) alive = false;
    }
    if (!alive) return { alive: false, startTime: null };
    const startTime = await readProcessStartTime(pid);
    return { alive: true, startTime };
  };
}

function parseMs(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

// 持锁判定（不产生副作用）：fresh / alive / unknown → 拒绝；stale → 可接管；unreadable → 保守拒绝。
async function judgeHeldLock(lockPath, { staleThresholdMs, probe }) {
  let record;
  try {
    record = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return { verdict: "unreadable", reason: "lock file missing or corrupt; resolve manually if the owner is stopped" };
  }
  if (!isPlainObject(record)) {
    return { verdict: "unreadable", reason: "lock content is not an object; resolve manually" };
  }
  const heartbeatMs = parseMs(record.heartbeat_at);
  if (Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs < staleThresholdMs) {
    return { verdict: "fresh", reason: "lock heartbeat is fresh" };
  }
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { verdict: "stale", reason: "heartbeat expired and lock records no usable owner pid" };
  }
  const identity = await probe(pid);
  if (!identity || identity.alive === false) {
    return { verdict: "stale", reason: `heartbeat expired and owner pid ${pid} does not exist` };
  }
  const startMs = parseMs(identity.startTime);
  const createdMs = parseMs(record.created_at);
  // 锁创建时刻必然晚于 owner 进程启动：当前持同 PID 进程若晚于锁创建才开始，必是 PID 复用。
  if (Number.isFinite(startMs) && Number.isFinite(createdMs)) {
    if (startMs > createdMs) {
      return { verdict: "stale", reason: `heartbeat expired and pid ${pid} was reused by a newer process` };
    }
    return { verdict: "alive", reason: `owner pid ${pid} is alive and predates the lock` };
  }
  return { verdict: "unknown", reason: `pid ${pid} is alive but its identity is unreadable` };
}

export class InstanceLock {
  #timer = null;

  constructor({
    directory,
    filename = "instance.lock",
    staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
    heartbeatIntervalMs = DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS,
    probe = createDefaultProcessProbe(),
    owner_id = randomUUID(),
    pid = process.pid,
  } = {}) {
    if (typeof directory !== "string" || directory.length === 0) {
      throw new DispatcherError("invalid_lock_config", "instance lock directory must be a non-empty string");
    }
    this.directory = directory;
    this.filename = filename;
    this.path = path.join(directory, filename);
    this.staleThresholdMs = staleThresholdMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.probe = probe;
    this.ownerId = owner_id;
    this.pid = pid;
    this.acquired = false;
  }

  // 排他获取。成功返回 { acquired: true, staleTakeover, archived? }；
  // 被活 owner 持有抛 instance_lock_held（第二 owner 拒绝启动）。
  async acquire() {
    await mkdir(this.directory, { recursive: true });
    const record = {
      owner_id: this.ownerId,
      pid: this.pid,
      created_at: nowIso(),
      heartbeat_at: nowIso(),
    };
    try {
      await writeFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      this.acquired = true;
      return { acquired: true, staleTakeover: false };
    } catch (error) {
      if (!(error && (error.code === "EEXIST" || error.code === "EISDIR"))) throw error;
    }
    const judgment = await judgeHeldLock(this.path, { staleThresholdMs: this.staleThresholdMs, probe: this.probe });
    if (judgment.verdict !== "stale") {
      throw new DispatcherError("instance_lock_held", `instance lock is held: ${judgment.reason}`);
    }
    // 旧锁归档后接管（stale 接管不证明旧 CLI 停止，旧执行记录仍按恢复决策表分类）。
    const archive = `${this.path}.stale-${stampForArchive()}`;
    await rename(this.path, archive);
    try {
      await writeFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error && error.code === "EEXIST")) throw error;
      throw new DispatcherError("instance_lock_held", "instance lock was re-acquired during stale takeover");
    }
    this.acquired = true;
    return { acquired: true, staleTakeover: true, archived: archive, reason: judgment.reason };
  }

  // 心跳更新：读-校验 owner-改写。锁已丢失（被归档/接管）时停止并报告，不复活覆盖新锁。
  async heartbeat() {
    if (!this.acquired) {
      throw new DispatcherError("instance_lock_not_held", "cannot heartbeat an instance lock this owner does not hold");
    }
    let record;
    try {
      record = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.acquired = false;
        throw new DispatcherError("instance_lock_lost", "instance lock file disappeared");
      }
      throw error;
    }
    if (!isPlainObject(record) || record.owner_id !== this.ownerId) {
      this.acquired = false;
      throw new DispatcherError("instance_lock_lost", "instance lock is now owned by another owner");
    }
    const next = { ...record, heartbeat_at: nowIso() };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    return next;
  }

  // 释放：仅当锁仍归本 owner 时删除；已丢失则如实报告。
  async release() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (!this.acquired) return { released: false, reason: "not held" };
    let record = null;
    try {
      record = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (!(error && error.code === "ENOENT")) throw error;
    }
    if (!isPlainObject(record) || record.owner_id !== this.ownerId) {
      this.acquired = false;
      return { released: false, lost: true, reason: "lock no longer belongs to this owner" };
    }
    try {
      await unlink(this.path);
    } catch (error) {
      if (!(error && error.code === "ENOENT")) throw error;
    }
    this.acquired = false;
    return { released: true };
  }

  // 周期心跳（默认 5s）；心跳失败（锁丢失）即停止。定时器 unref：不阻止进程退出。
  startHeartbeat(intervalMs = this.heartbeatIntervalMs) {
    if (this.#timer) return this.#timer;
    this.#timer = setInterval(() => {
      void this.heartbeat().catch(() => {
        if (this.#timer) {
          clearInterval(this.#timer);
          this.#timer = null;
        }
      });
    }, intervalMs);
    if (typeof this.#timer.unref === "function") this.#timer.unref();
    return this.#timer;
  }

  stopHeartbeat() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
