import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { InstanceLock } from "../src/instance-lock.js";

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

async function makeDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "dalizi-lock-"));
}

// 写一份"被持有"的锁文件（heartbeat 由参数指定）。
async function writeHeldLock(directory, { heartbeatAt, pid = 999999, createdAt = isoAgo(60_000) }) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(directory, "instance.lock"),
    `${JSON.stringify({ owner_id: "old-owner", pid, created_at: createdAt, heartbeat_at: heartbeatAt })}\n`,
    "utf8",
  );
}

test("acquire takes an exclusive lock and a second live owner is refused", async () => {
  const directory = await makeDirectory();
  try {
    const first = new InstanceLock({ directory });
    const acquired = await first.acquire();
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.staleTakeover, false);

    const second = new InstanceLock({ directory });
    await assert.rejects(() => second.acquire(), { code: "instance_lock_held" });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("heartbeat refreshes heartbeat_at and release frees the lock for the next owner", async () => {
  const directory = await makeDirectory();
  try {
    const lock = new InstanceLock({ directory });
    await lock.acquire();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const updated = await lock.heartbeat();
    assert.ok(Date.parse(updated.heartbeat_at) > Date.now() - 5_000);
    const released = await lock.release();
    assert.equal(released.released, true);
    await assert.rejects(() => lock.heartbeat(), { code: "instance_lock_not_held" });

    const next = new InstanceLock({ directory });
    assert.equal((await next.acquire()).acquired, true);
    await next.release();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a stale lock (expired heartbeat, dead pid) is archived and taken over", async () => {
  const directory = await makeDirectory();
  try {
    await writeHeldLock(directory, { heartbeatAt: isoAgo(60_000), pid: 999_999 });
    const probe = async () => ({ alive: false, startTime: null });
    const lock = new InstanceLock({ directory, staleThresholdMs: 30_000, probe });
    const result = await lock.acquire();
    assert.equal(result.acquired, true);
    assert.equal(result.staleTakeover, true);
    const names = await readdir(directory);
    assert.ok(names.some((name) => /^instance\.lock\.stale-/.test(name)), `archived lock missing: ${names.join(", ")}`);
    await lock.release();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an expired-heartbeat lock whose owner pid is alive (identity predates the lock) refuses startup", async () => {
  const directory = await makeDirectory();
  try {
    const createdAt = isoAgo(60_000);
    await writeHeldLock(directory, { heartbeatAt: isoAgo(60_000), pid: 4242, createdAt });
    const probe = async () => ({ alive: true, startTime: isoAgo(120_000) }); // 进程早于锁创建 → 是 owner 本尊
    const lock = new InstanceLock({ directory, staleThresholdMs: 30_000, probe });
    await assert.rejects(() => lock.acquire(), { code: "instance_lock_held" });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("pid reuse (current pid holder started after lock creation) is detected as stale", async () => {
  const directory = await makeDirectory();
  try {
    const createdAt = isoAgo(60_000);
    await writeHeldLock(directory, { heartbeatAt: isoAgo(60_000), pid: 4242, createdAt });
    const probe = async () => ({ alive: true, startTime: isoAgo(10_000) }); // 更新的进程复用了 pid
    const lock = new InstanceLock({ directory, staleThresholdMs: 30_000, probe });
    const result = await lock.acquire();
    assert.equal(result.staleTakeover, true);
    await lock.release();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an alive pid with unreadable identity is not judged stale (conservative refusal)", async () => {
  const directory = await makeDirectory();
  try {
    await writeHeldLock(directory, { heartbeatAt: isoAgo(60_000), pid: 4242 });
    const probe = async () => ({ alive: true, startTime: null });
    const lock = new InstanceLock({ directory, staleThresholdMs: 30_000, probe });
    await assert.rejects(() => lock.acquire(), { code: "instance_lock_held" });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a fresh heartbeat refuses takeover even if the pid looks dead", async () => {
  const directory = await makeDirectory();
  try {
    await writeHeldLock(directory, { heartbeatAt: isoAgo(1_000), pid: 999_999 });
    const probe = async () => ({ alive: false, startTime: null });
    const lock = new InstanceLock({ directory, staleThresholdMs: 30_000, probe });
    await assert.rejects(() => lock.acquire(), { code: "instance_lock_held" });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// 真实双进程测试：活锁拒绝启动 + owner 死亡且心跳过期后的 stale 接管（默认探针的
// process.kill 存在性检查路径；PID 不存在不需要读创建时间）。
test("dual-process: live owner refuses startup, dead owner allows stale takeover", async () => {
  const directory = await makeDirectory();
  const moduleUrl = new URL("../src/instance-lock.js", import.meta.url).href;
  const serverSource = `
    const { InstanceLock } = await import(process.env.DALIZI_TEST_LOCK_MODULE);
    const lock = new InstanceLock({ directory: process.env.DALIZI_TEST_LOCK_DIR });
    await lock.acquire();
    lock.startHeartbeat(50);
    process.stdout.write("ACQUIRED\\n");
    setInterval(() => {}, 1 << 30); // ref'd 定时器持有事件循环：进程保持存活直到被杀
  `;
  let child;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", serverSource], {
      env: { ...process.env, DALIZI_TEST_LOCK_DIR: directory, DALIZI_TEST_LOCK_MODULE: moduleUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { if (chunk.includes("ACQUIRED")) resolve(); });
      child.once("exit", () => reject(new Error("child exited before acquiring the lock")));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => process.stderr.write(`[lock-child] ${chunk}`));
    });

    // 活 owner（心跳 50ms 新鲜）：本进程作为第二 owner 拒绝启动。
    const contender = new InstanceLock({ directory, staleThresholdMs: 500 });
    await assert.rejects(() => contender.acquire(), { code: "instance_lock_held" });

    // owner 死亡且心跳过期：默认探针确认 PID 不存在 → stale 接管。
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const heir = new InstanceLock({ directory, staleThresholdMs: 500 });
    const result = await heir.acquire();
    assert.equal(result.staleTakeover, true);
    await heir.release();
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
