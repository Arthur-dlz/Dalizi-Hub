# Dalizi Dispatcher V0

Local stdio MCP backend with exactly three tools: `dispatch_task`, `get_task`, and
`render_task_card`, plus one MCP Apps UI resource. It dispatches a single owned
WorkBuddy or native Codex child at a time.

## Contract and plan

- Inputs are boundary-validated. `agent` must be `workbuddy` or `codex`; `project` is a
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
- Parsed stream error/result takes precedence over exit code. Result records
  keep requested model and set actual model to `NOT_OBSERVABLE` unless emitted.
- Work sequence: validate/store -> parser/runner -> MCP stdio -> real temporary
  Git canary. Unit seams are validator/resolver, store, parser, and tool calls.

## Commands

`npm test` runs focused unit and MCP-client integration tests. `npm run canary`
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
allowlist contains the locally verified `gpt-6-sol` only.

## Task Card UI

`render_task_card` renders `ui://dalizi-dispatcher/task-card.html`
(`text/html;profile=mcp-app`, self-contained, no external assets) straight from the
persisted Dispatcher job: agent, project, status, elapsed time, current activity,
requested model, effort, last update, and the result (`error` first, then
`final_text`). The card refreshes only through `get_task(job_id)` every ~3 seconds
while the job is non-terminal, and stops immediately on `COMPLETED`, `FAILED`, or
`CANCELLED`. It keeps a single interval, guards concurrent refreshes, and cleans
up on teardown. This transport is shared by the stdio and HTTP entry points.

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
