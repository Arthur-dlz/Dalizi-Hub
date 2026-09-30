import test from "node:test";
import assert from "node:assert/strict";
import { adjudicateRequest, canonicalRequest, requestDigest } from "../src/idempotency.js";
import { IdempotencyIndex } from "../src/idempotency-index.js";
import { JobStore } from "../src/job-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE = { agent: "workbuddy", project: "canary", model: "custom-local:step-5-preview", effort: "medium", task: "read the marker" };

test("canonicalRequest uses a stable key order and requestDigest is deterministic", () => {
  const first = canonicalRequest(BASE);
  const second = canonicalRequest({ effort: BASE.effort, task: BASE.task, model: BASE.model, project: BASE.project, agent: BASE.agent });
  assert.equal(first, second);
  assert.equal(requestDigest(BASE), requestDigest(BASE));
  assert.match(requestDigest(BASE), /^[0-9a-f]{64}$/);
});

test("a change in any normalized field changes the digest", () => {
  for (const override of [
    { agent: "codex" },
    { project: "other" },
    { model: "gpt-6-sol" },
    { effort: "high" },
    { task: "read the markers" },
  ]) {
    assert.notEqual(requestDigest({ ...BASE, ...override }), requestDigest(BASE));
  }
});

test("adjudicateRequest distinguishes miss, hit and conflict", () => {
  const digest = requestDigest(BASE);
  assert.equal(adjudicateRequest(undefined, digest), "miss");
  assert.equal(adjudicateRequest(null, digest), "miss");
  assert.equal(adjudicateRequest({ request_id: "r", job_id: "j", request_digest: digest }, digest), "hit");
  assert.equal(adjudicateRequest({ request_id: "r", job_id: "j", request_digest: requestDigest({ ...BASE, task: "different" }) }, digest), "conflict");
  // 条目缺摘要：不能确认一致 → 冲突，不重复执行。
  assert.equal(adjudicateRequest({ request_id: "r", job_id: "j", request_digest: null }, digest), "conflict");
});

test("index rebuild from job records recovers entries lost from the log tail", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dalizi-idem-"));
  try {
    const store = new JobStore(path.join(directory, "jobs"));
    const index = new IdempotencyIndex({ directory });
    // 崩溃窗口模拟：job 记录已落盘（含 request_id/digest），索引日志缺该条目。
    await store.create({ job_id: "job-a", status: "COMPLETED", request_id: "recover-me-0001", request_digest: "deadbeef" });
    await index.load();
    await index.rebuild(await store.listAll());
    assert.equal(index.lookup("recover-me-0001").job_id, "job-a");
    assert.equal(index.lookup("recover-me-0001").request_digest, "deadbeef");
    assert.equal(adjudicateRequest(index.lookup("recover-me-0001"), "deadbeef"), "hit");
    assert.equal(adjudicateRequest(index.lookup("recover-me-0001"), "cafebabe"), "conflict");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
