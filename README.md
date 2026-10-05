# Dalizi Dispatcher V1

Local MCP backend (stdio + loopback HTTP) with exactly three tools: `dispatch_task`,
`get_task`, and `render_task_card`, plus one MCP Apps UI resource. It dispatches a
single owned WorkBuddy, Codex, or Antigravity child at a time.

## Contract and plan

- Inputs are boundary-validated. `agent` must be `workbuddy`, `codex`, or `antigravity`; `project` is a
  registry alias or unique direct child of an approved workspace root, never a client-controlled path; `model`, `effort`,
  and task text are size-limited.
- `dispatch_task` returns a UUID and `QUEUED`/`RUNNING`; it persists one JSON
  record per job before spawning the child. `get_task` retrieves that record
  after a process restart.
- `get_task` returns the persisted job both as JSON text and as
  `structuredContent`. `render_task_card` is read-only, reads the same job
  through the same path, and points the host at `ui://dalizi-dispatcher/task-card.html`.
  For an unknown `job_id`, both tools fail identically with `unknown_job`.
- CodeBuddy is launched as a fixed Node script with an argument array, resolved
  project cwd, explicit `--model`, `--effort`, and `--output-format stream-json`.
- Codex is launched through the local `codex exec` CLI with an argument array,
  the resolved project cwd, explicit `-m` and `model_reasoning_effort`, and JSON events.
  The Bridge supplies its trusted executable through `CODEX_CLI_PATH`; a local
  invocation may use `codex` on `PATH`. Codex uses the operator's existing CLI
  configuration and authorization policy.
- Antigravity is launched through the local `agy` CLI with an argument array, the
  resolved project cwd, explicit `--model` and `--effort`, and
  `--output-format stream-json`. It passes no skip-permissions flag, so actions
  outside the configured allow rules fail explicitly rather than silently.
- Parsed stream error/result takes precedence over exit code. Result records
  keep requested model and set actual model to `NOT_OBSERVABLE` unless emitted.
- Work sequence: validate/store -> parser/runner -> MCP stdio -> real temporary
  Git canary. Unit seams are validator/resolver, store, parser, and tool calls.

## Commands

`npm test` runs focused unit and MCP-client integration tests (currently 176/176
passing via `node --test --test-concurrency=1`). `npm run canary`
runs the one-off WorkBuddy canary after it locally registers a temporary project.

The trusted local operator may register an explicit alias:

```powershell
npm run register-project -- --alias my-project --cwd D:\trusted\project
```

The registry is persisted as `.dispatcher-data/project-registry.json` by default
(or beneath `DISPATCHER_DATA_DIR` when set) and is reloaded for every dispatch.
For automatic discovery, create `workspace-roots.json` in the same data directory:

```json
{ "roots": ["D:\\trusted\\workspace"] }
```

Roots must be existing absolute directories. The resolver checks the registry
first, then exact direct child directory names, then a unique case-insensitive
match on Windows. It canonicalizes each resulting cwd and checks containment
within a configured root. Ambiguous names and paths escaping a root fail closed.
Without the roots file, existing aliases still work and discovery is disabled;
a malformed roots file fails closed. These local files are gitignored; do not
commit local paths. MCP exposes no registry-mutation tool or cwd/root/path input.
The WorkBuddy model allowlist contains the
dynamically verified `custom-local:step-5-preview` only. The separate Codex
allowlist contains the locally verified `gpt-6-sol`, `gpt-6.1-sol`, and
`gpt-6-luna`. Antigravity has its own
verified model allowlist (Gemini / Claude / gpt-oss tiers) in `src/mcp-server.js`.

## Task Card UI

`render_task_card` renders `ui://dalizi-dispatcher/task-card.html`
(`text/html;profile=mcp-app`, self-contained, no external assets) straight from the
persisted Dispatcher job: agent, project, status, elapsed time, current activity,
requested model, effort, last update, and the result (`error` first, then
`final_text`). P5 (2026-10-05): the card refreshes data through the
**authorization-free `app.readServerResource` channel** (`dlz://job/{job_id}`,
falling back to `get_task` when the host lacks the capability), while **elapsed
time ticks locally every second** (decoupled from data polling). The card follows
host theme changes (`host-context-changed`), reports its size to avoid inline
clipping, and keeps the user-only auto-refresh semantics on terminal stop.
This transport is shared by the stdio and HTTP entry points.

`render_board` (P5, no arguments, read-only) returns an aggregate snapshot of all
non-terminal jobs plus a bounded newest-terminal window
(`structuredContent.jobs / board_url / read_token`), and points the host at the
board UI resource `ui://dalizi-dispatcher/board.html` (CSP `connectDomains`
allows exactly `http://127.0.0.1:18490`). Opening `board_url` in a browser
(e.g. via `present_files`) renders the same board over **SSE** (`GET /events`).
Note (2026-10-05 live): WorkBuddy Desktop may render `render_board` results with
its native tool UI instead of the MCP App iframe; the browser board is the
verified display path.

## Boundaries

No tunnel, cancel, ZCode, skill handling, arbitrary cwd,
arbitrary executables, or secret/token storage reads are implemented.

## Local Streamable HTTP MCP

The stdio transport remains available through `npm start`. The independent HTTP
transport listens only at `http://127.0.0.1:18490/mcp` and requires a dedicated
credential in `DISPATCHER_HTTP_BEARER_TOKEN` (at least 32 characters):

```powershell
$env:DISPATCHER_HTTP_BEARER_TOKEN = "set-a-new-dedicated-credential-outside-the-repository"
npm run start:http
```

Clients send `Authorization: Bearer <token>`. Requests without a valid token or
with a foreign Origin are rejected before they reach MCP. The HTTP entry never
reads `CONTROL_PLANE_API_KEY`, WorkBuddy credentials, cookies, or storage.

P5 read-only data plane (2026-10-05): `GET /api/jobs`, `GET /events` (SSE),
`GET /board` are disabled by default and enabled by a **separate** read-only
credential `DISPATCHER_HTTP_READ_TOKEN` (at least 32 characters, passed via the
`read_token` query parameter; `timingSafeEqual` checked; the main Bearer header is
also accepted). `render_board` hands `board_url` with the token to authenticated
MCP clients only — the token is never embedded in static resources or logs.
All other paths keep returning 404.

## Production run

Production is hosted by the local Dalizi Hub bridge, not by `npm start`. The
bridge runs `node src/http-mcp-server.js` on `127.0.0.1:18490/mcp`, injects the
Bearer token from its own secret store, and is supervised by a Windows scheduled
task (`DaliziHubBridgeWatchdog`) that self-heals the dispatcher after logon. Start
it through the watchdog, never from a WorkBuddy session. The full restart / usage
/ maintenance / troubleshooting runbook is in `docs/handoff/OPERATIONS.md`.

Only the WorkBuddy Desktop MCP client is verified (blueprint A1); no other MCP
client is validated.

## Documentation

- `docs/v1-mcp-agent-dispatch-blueprint.md` — requirements and acceptance (single source of truth)
- `docs/handoff/OPERATIONS.md` — production operations manual (restart / use / maintain / troubleshoot)
- `docs/impl/COMMANDER-RUNBOOK.md` — commander / coordination runbook
- `docs/handoff/ASSET_INVENTORY.md` — code index
- `docs/impl/IMPLEMENTATION.md` — implementation / technical design
- `docs/handoff/V1-POST-CLOSEOUT-INVENTORY-2026-10-01.md` — post-closeout inventory
