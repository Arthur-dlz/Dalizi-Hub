// Egress proxy injection for CLI child processes. agy (Google) and codex
// (OpenAI) cannot reach their APIs directly from this network; the local
// Clash proxy at 127.0.0.1:7890 is the verified egress path (T5 canary
// root cause + proxy probe, 2026-10-01). Injection is scoped per-runner so
// local-gateway CLIs (workbuddy custom-local) are never proxied, and the
// bridge process environment stays untouched.
//
// Precedence for the proxy URL: runner-specific env var
// (ANTIGRAVITY_PROXY_URL / CODEX_PROXY_URL) > DEFAULT_EGRESS_PROXY_URL.
// Ambient HTTP(S)_PROXY in the environment is deliberately NOT trusted: the
// WorkBuddy sandbox injects its own proxy (127.0.0.1:55889) which blocks
// Google domains, and persisted user values may point at a dead port — both
// observed killing agy during T5. Only the runner-specific var may override
// the verified default; set it to "direct" (or "none", case-insensitive) to
// disable injection explicitly.
export const DEFAULT_EGRESS_PROXY_URL = "http://127.0.0.1:7890";
export const EGRESS_NO_PROXY = "localhost,127.0.0.1,::1";

export function egressProxyEnv(environment, urlEnvName) {
  const configured = environment?.[urlEnvName];
  if (typeof configured === "string" && /^(?:direct|none)$/i.test(configured.trim())) {
    return {};
  }
  const url = (typeof configured === "string" && configured.trim()) ||
    DEFAULT_EGRESS_PROXY_URL;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: EGRESS_NO_PROXY,
    no_proxy: EGRESS_NO_PROXY,
  };
}
