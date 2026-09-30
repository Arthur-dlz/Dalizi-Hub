import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobStore } from "../src/job-store.js";
import { IdempotencyIndex } from "../src/idempotency-index.js";
import { DispatcherError } from "../src/contracts.js";

async function tempDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function entry(requestId, jobId, digest = "digest-1", createdAt = "2026-09-29T12:00:00.000Z") {
  return { request_id: requestId, job_id: jobId, request_digest: digest, created_at: createdAt };
}

async function fileExists(file) {
  return access(file).then(() => true, () => false);
}

async function countLogLines(index) {
  const raw = await readFile(index.logFile, "utf8").catch((error) => {
    if (error && error.code === "ENOENT") return "";
    throw error;
  });
  return raw.split("\n").filter((line) => line.trim() !== "").length;
}

// 观测器：append 被调用时，job 记录必须已落盘（写入顺序契约的回归保护）。
class OrderObservingIndex extends IdempotencyIndex {
  constructor(options, probe) {
    super(options);
    this.probe = probe;
  }

  async append(entryValue) {
    await this.probe(this);
    return super.append(entryValue);
  }
}

test("append records one entry per request_id and duplicate appends stay idempotent", async () => {
  const directory = await tempDirectory("dalizi-index-append-");
  try {
    const index = new IdempotencyIndex({ directory });
    const first = await index.append(entry("req-1", "job-1"));
    assert.deepEqual(index.lookup("req-1"), first);
    assert.equal(index.size, 1);

    const again = await index.append(entry("req-1", "job-1"));
    assert.deepEqual(again, first, "a duplicate append must not create a second entry");
    assert.equal(index.size, 1);
    assert.equal(await countLogLines(index), 1, "a duplicate append must not write a second log line");
    assert.ok(await fileExists(index.logFile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("append refuses a request_id already bound to a different job", async () => {
  const directory = await tempDirectory("dalizi-index-conflict-");
  try {
    const index = new IdempotencyIndex({ directory });
    await index.append(entry("req-1", "job-1"));
    await assert.rejects(
      index.append(entry("req-1", "job-2")),
      (error) => error instanceof DispatcherError && error.code === "idempotency_conflict",
    );
    assert.equal(index.size, 1);
    assert.deepEqual(index.lookup("req-1").job_id, "job-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the job record is durable before the index line is appended (A5 write-order evidence)", async () => {
  const directory = await tempDirectory("dalizi-index-order-");
  try {
    const store = new JobStore(directory);
    const jobFile = path.join(directory, "job-1.json");
    const observations = [];
    const index = new OrderObservingIndex({ directory }, async (currentIndex) => {
      observations.push({
        jobRecordDurable: await fileExists(jobFile),
        logLinesBefore: await countLogLines(currentIndex),
      });
    });

    await store.create({
      job_id: "job-1",
      status: "QUEUED",
      request_id: "req-1",
      request_digest: "digest-1",
      created_at: "2026-09-29T11:59:00.000Z",
    });
    await index.append(entry("req-1", "job-1", "digest-1"));

    assert.deepEqual(observations, [{ jobRecordDurable: true, logLinesBefore: 0 }]);
    assert.equal(await countLogLines(index), 1);
    const logged = JSON.parse((await readFile(index.logFile, "utf8")).trim());
    assert.deepEqual(logged, entry("req-1", "job-1", "digest-1"));
    assert.deepEqual(index.lookup("req-1"), entry("req-1", "job-1", "digest-1"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale log missing its tail line is repaired by rebuild from job records", async () => {
  const directory = await tempDirectory("dalizi-index-stale-");
  try {
    const store = new JobStore(directory);
    const index = new IdempotencyIndex({ directory });
    const jobs = [
      { job_id: "job-1", status: "QUEUED", request_id: "req-1", request_digest: "digest-1", created_at: "2026-09-29T11:59:00.000Z" },
      { job_id: "job-2", status: "RUNNING", request_id: "req-2", request_digest: "digest-2", created_at: "2026-09-29T12:00:00.000Z" },
    ];
    for (const job of jobs) await store.create(job);
    await index.append(entry("req-1", "job-1", "digest-1", jobs[0].created_at));
    await index.append(entry("req-2", "job-2", "digest-2", jobs[1].created_at));

    // 崩溃窗口：日志本身完好（仍是合法 JSONL），但缺最后一行。
    const raw = await readFile(index.logFile, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    await writeFile(index.logFile, `${lines.slice(0, -1).join("\n")}\n`);
    assert.equal(await countLogLines(index), 1, "the log itself remains intact but lost its tail entry");

    const recovered = new IdempotencyIndex({ directory });
    const report = await recovered.rebuild(await store.listAll());
    assert.deepEqual(recovered.lookup("req-2"), entry("req-2", "job-2", "digest-2", jobs[1].created_at));
    assert.deepEqual(recovered.lookup("req-1"), entry("req-1", "job-1", "digest-1", jobs[0].created_at));
    assert.equal(report.jobsScanned, 2);
    assert.equal(report.entries, 2);
    assert.deepEqual(report.duplicates, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completely missing log rebuilds to the same map as the recovered one", async () => {
  const directory = await tempDirectory("dalizi-index-nolog-");
  try {
    const store = new JobStore(directory);
    const jobs = [
      { job_id: "job-1", status: "COMPLETED", request_id: "req-1", request_digest: "digest-1", created_at: "2026-09-29T11:59:00.000Z" },
      { job_id: "job-2", status: "COMPLETED", request_id: "req-2", request_digest: "digest-2", created_at: "2026-09-29T12:00:00.000Z" },
      { job_id: "job-3", status: "COMPLETED", created_at: "2026-09-29T12:01:00.000Z" },
    ];
    for (const job of jobs) await store.create(job);

    const original = new IdempotencyIndex({ directory });
    await original.append(entry("req-1", "job-1", "digest-1", jobs[0].created_at));
    await original.append(entry("req-2", "job-2", "digest-2", jobs[1].created_at));
    const before = [...original].map((item) => item).sort((left, right) => left.request_id.localeCompare(right.request_id));

    await rm(path.join(directory, "run"), { recursive: true, force: true });
    assert.equal(await fileExists(path.join(directory, "run", "idempotency-index.jsonl")), false);

    const recovered = new IdempotencyIndex({ directory });
    await recovered.rebuild(await store.listAll());
    const after = [...recovered].sort((left, right) => left.request_id.localeCompare(right.request_id));
    assert.deepEqual(after, before, "rebuild without any log must reproduce the same map");
    assert.equal(recovered.size, before.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rebuild keeps the first record when two jobs share a request_id and reports the duplicate", async () => {
  const directory = await tempDirectory("dalizi-index-dup-");
  try {
    const store = new JobStore(directory);
    await store.create({ job_id: "job-1", status: "QUEUED", request_id: "req-1", request_digest: "digest-1", created_at: "2026-09-29T11:59:00.000Z" });
    await store.create({ job_id: "job-2", status: "QUEUED", request_id: "req-1", request_digest: "digest-2", created_at: "2026-09-29T12:00:00.000Z" });

    const index = new IdempotencyIndex({ directory });
    const report = await index.rebuild(await store.listAll());
    assert.equal(index.size, 1);
    assert.equal(index.lookup("req-1").job_id, "job-1", "the earliest record wins and the conflict is reported, not thrown");
    assert.deepEqual(report.duplicates, [{ request_id: "req-1", kept_job_id: "job-1", conflicting_job_id: "job-2" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("load treats the log as audit only and tolerates malformed lines", async () => {
  const directory = await tempDirectory("dalizi-index-load-");
  try {
    const index = new IdempotencyIndex({ directory });
    const missing = await index.load();
    assert.equal(missing.exists, false);
    assert.equal(index.size, 0);

    const valid = JSON.stringify(entry("req-1", "job-1", "digest-1"));
    await mkdir(path.dirname(index.logFile), { recursive: true });
    await writeFile(index.logFile, `${valid}\nnot-json-at-all\n\n${JSON.stringify(entry("req-2", "job-2"))}\n`);
    const loaded = await index.load();
    assert.equal(loaded.exists, true);
    assert.equal(loaded.entries, 2);
    assert.deepEqual(loaded.malformed, [2]);
    assert.deepEqual(index.lookup("req-1"), entry("req-1", "job-1", "digest-1"));
    assert.equal(index.lookup("nope"), undefined);
    assert.equal(index.has("req-2"), true);
    assert.equal(index.has(42), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("append validates entries and rebuild requires an iterable of records", async () => {
  const directory = await tempDirectory("dalizi-index-invalid-");
  try {
    const index = new IdempotencyIndex({ directory });
    await assert.rejects(index.append({ job_id: "job-1" }), (error) => error instanceof DispatcherError && error.code === "invalid_index_entry");
    await assert.rejects(index.append({ request_id: "req-1", job_id: "" }), (error) => error instanceof DispatcherError && error.code === "invalid_index_entry");
    await assert.rejects(index.append("nope"), (error) => error instanceof DispatcherError && error.code === "invalid_index_entry");
    await assert.rejects(index.rebuild(null), (error) => error instanceof DispatcherError && error.code === "invalid_rebuild_input");
    assert.equal(index.size, 0);

    const empty = await index.rebuild([]);
    assert.deepEqual(empty, { jobsScanned: 0, entries: 0, duplicates: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
