import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EGRESS_PROXY_URL, EGRESS_NO_PROXY, egressProxyEnv } from "../src/egress-proxy.js";

// T5 canary root cause (2026-10-01): the dispatcher process has no proxy in
// its environment, so agy/codex children could not reach Google/OpenAI and
// failed with "model unavailable". Per-runner egress injection is the fix;
// these tests pin its precedence and opt-out semantics.

test("egressProxyEnv injects the default Clash proxy with an empty environment", () => {
  const env = egressProxyEnv({}, "ANTIGRAVITY_PROXY_URL");
  assert.equal(env.HTTP_PROXY, DEFAULT_EGRESS_PROXY_URL);
  assert.equal(env.HTTPS_PROXY, DEFAULT_EGRESS_PROXY_URL);
  assert.equal(env.http_proxy, DEFAULT_EGRESS_PROXY_URL);
  assert.equal(env.https_proxy, DEFAULT_EGRESS_PROXY_URL);
  assert.equal(env.NO_PROXY, EGRESS_NO_PROXY);
  assert.equal(env.no_proxy, EGRESS_NO_PROXY);
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
});

test("runner-specific env var overrides the default", () => {
  const env = egressProxyEnv({ ANTIGRAVITY_PROXY_URL: "http://127.0.0.1:9999" }, "ANTIGRAVITY_PROXY_URL");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:9999");
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:9999");
});

test("ambient HTTPS_PROXY in the environment is NOT trusted (WB sandbox proxy blocks Google)", () => {
  // Observed live during T5: with the WorkBuddy sandbox proxy
  // (127.0.0.1:55889) in the environment, agy died pre-init. The verified
  // Clash default must win over any ambient value.
  const env = egressProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:55889" }, "CODEX_PROXY_URL");
  assert.equal(env.HTTPS_PROXY, DEFAULT_EGRESS_PROXY_URL);
});

test("runner-specific var wins over environment HTTPS_PROXY", () => {
  const env = egressProxyEnv(
    { CODEX_PROXY_URL: "http://127.0.0.1:1111", HTTPS_PROXY: "http://10.0.0.1:8080" },
    "CODEX_PROXY_URL",
  );
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:1111");
});

test("'direct'/'none' disables injection explicitly (case-insensitive, trimmed)", () => {
  assert.deepEqual(egressProxyEnv({ ANTIGRAVITY_PROXY_URL: "direct" }, "ANTIGRAVITY_PROXY_URL"), {});
  assert.deepEqual(egressProxyEnv({ ANTIGRAVITY_PROXY_URL: " NONE " }, "ANTIGRAVITY_PROXY_URL"), {});
});

test("whitespace-only runner-specific var falls through to the default", () => {
  const env = egressProxyEnv({ CODEX_PROXY_URL: "   " }, "CODEX_PROXY_URL");
  assert.equal(env.HTTPS_PROXY, DEFAULT_EGRESS_PROXY_URL);
});

test("missing environment object still yields the default", () => {
  const env = egressProxyEnv(undefined, "ANTIGRAVITY_PROXY_URL");
  assert.equal(env.HTTPS_PROXY, DEFAULT_EGRESS_PROXY_URL);
});
