import test from "node:test";
import assert from "node:assert/strict";
import { validateDispatchInput, resolveProject } from "../src/contracts.js";

test("only the workbuddy agent and a registered alias are accepted", () => {
  assert.throws(
    () => validateDispatchInput({ agent: "codex", project: "canary-project", task: "read", model: "custom-local:step-3.7-flash" }),
    { code: "unsupported_agent" },
  );
  assert.throws(
    () => resolveProject("unknown", { "canary-project": "C:/safe" }),
    { code: "unknown_project" },
  );
});
