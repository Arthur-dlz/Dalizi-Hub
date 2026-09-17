# Dalizi Dispatcher V0

Local stdio MCP backend with exactly two tools: `dispatch_task` and `get_task`.
It only dispatches a single owned WorkBuddy `codebuddy -p` child at a time.

## Contract and plan

- Inputs are boundary-validated. `agent` must be `workbuddy`; `project` is an
  explicit registry alias, never a client-controlled path; `model`, `effort`,
  and task text are size-limited.
- `dispatch_task` returns a UUID and `QUEUED`/`RUNNING`; it persists one JSON
  record per job before spawning the child. `get_task` retrieves that record
  after a process restart.
- CodeBuddy is launched as a fixed Node script with an argument array, resolved
  alias cwd, explicit `--model`, `--effort`, and `--output-format stream-json`.
- Parsed stream error/result takes precedence over exit code. Result records
  keep requested model and set actual model to `NOT_OBSERVABLE` unless emitted.
- Work sequence: validate/store -> parser/runner -> MCP stdio -> real temporary
  Git canary. Unit seams are validator/resolver, store, parser, and tool calls.

## Commands

`npm test` runs focused unit and MCP-client integration tests. `npm run canary`
runs the one-off WorkBuddy canary after its temporary project registry is set.

To start the local stdio server, its operator supplies the explicit registry and
data directory, for example: `DISPATCHER_PROJECT_REGISTRY` with only approved
aliases and `DISPATCHER_DATA_DIR` for the JSON job files, then `npm start`.
The V0 model allowlist contains the dynamically verified
`custom-local:step-3.7-flash` only.

## Boundaries

No tunnel, cancel, Codex, ZCode, skill handling, arbitrary cwd,
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
