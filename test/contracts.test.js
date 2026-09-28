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
