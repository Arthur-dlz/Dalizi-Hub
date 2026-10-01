import test from "node:test";
import assert from "node:assert/strict";
import { DispatcherError, validateDispatchInput, resolveProject } from "../src/contracts.js";

test("only workbuddy and codex agents and a registered alias are accepted", () => {
  assert.throws(
    () => validateDispatchInput({ agent: "unknown", project: "canary-project", task: "read", model: "custom-local:step-5-preview" }),
    { code: "unsupported_agent" },
  );
  assert.throws(
    () => resolveProject("unknown", { resolve() { throw new DispatcherError("unknown_project", "project is not registered"); } }),
    { code: "unknown_project" },
  );
});

const REQUEST_INPUT = { agent: "workbuddy", project: "canary-project", task: "read", model: "custom-local:step-5-preview" };
const MODELS = new Set(["custom-local:step-5-preview"]);

test("request_id is optional but strictly validated when present (8-128 URL-safe)", () => {
  // 缺省允许（旧调用兼容；无重试保证）。
  assert.equal(validateDispatchInput(REQUEST_INPUT, MODELS).request_id, null);
  assert.equal(validateDispatchInput({ ...REQUEST_INPUT, request_id: null }, MODELS).request_id, null);

  const valid = validateDispatchInput({ ...REQUEST_INPUT, request_id: "retry-20260929-0001_ABC" }, MODELS);
  assert.equal(valid.request_id, "retry-20260929-0001_ABC");

  assert.throws(() => validateDispatchInput({ ...REQUEST_INPUT, request_id: "short7" }, MODELS), { code: "invalid_request_id" });
  const tooLong = "a".repeat(129);
  assert.throws(() => validateDispatchInput({ ...REQUEST_INPUT, request_id: tooLong }, MODELS), { code: "invalid_request_id" });
  assert.equal(validateDispatchInput({ ...REQUEST_INPUT, request_id: "a".repeat(128) }, MODELS).request_id.length, 128);
  for (const bad of ["with space", "with/slash", "中文请求标识", "with+plus", "with:colon", 12345678]) {
    assert.throws(
      () => validateDispatchInput({ ...REQUEST_INPUT, request_id: bad }, MODELS),
      { code: "invalid_request_id" },
      `request_id ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

// T5 canary root cause (2026-10-01): the blanket effort default "medium" made
// every tier-suffixed agy model except *-medium fail with agy's hard
// "invalid model selection" error. The dispatcher must derive the default
// from the model suffix and reject explicit mismatches up front.
test("antigravity default effort is derived from the model tier suffix", () => {
  const agyModels = {
    antigravity: new Set(["gemini-3.8-flash-low", "gemini-3.1-pro-high", "gpt-oss-120b-medium", "claude-sonnet-4-6"]),
  };
  const base = { agent: "antigravity", project: "canary-project", task: "read" };
  assert.equal(validateDispatchInput({ ...base, model: "gemini-3.8-flash-low" }, agyModels).effort, "low");
  assert.equal(validateDispatchInput({ ...base, model: "gemini-3.1-pro-high" }, agyModels).effort, "high");
  assert.equal(validateDispatchInput({ ...base, model: "gpt-oss-120b-medium" }, agyModels).effort, "medium");
  // Suffixless models keep the "medium" default.
  assert.equal(validateDispatchInput({ ...base, model: "claude-sonnet-4-6" }, agyModels).effort, "medium");
});

test("antigravity explicit effort must match the model tier suffix", () => {
  const agyModels = { antigravity: new Set(["gemini-3.8-flash-low", "gemini-3.1-pro-high"]) };
  const base = { agent: "antigravity", project: "canary-project", task: "read" };
  // Matching effort is accepted.
  assert.equal(validateDispatchInput({ ...base, model: "gemini-3.8-flash-low", effort: "low" }, agyModels).effort, "low");
  // Conflicting effort is rejected at validation, not by burning a CLI run.
  assert.throws(
    () => validateDispatchInput({ ...base, model: "gemini-3.8-flash-low", effort: "medium" }, agyModels),
    { code: "invalid_effort" },
  );
  assert.throws(
    () => validateDispatchInput({ ...base, model: "gemini-3.1-pro-high", effort: "low" }, agyModels),
    { code: "invalid_effort" },
  );
  // Unsupported level still rejected.
  assert.throws(
    () => validateDispatchInput({ ...base, model: "gemini-3.8-flash-low", effort: "minimal" }, agyModels),
    { code: "invalid_effort" },
  );
});
