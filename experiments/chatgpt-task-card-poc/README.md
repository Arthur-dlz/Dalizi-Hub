# Dalizi Task Card MCP Apps POC

An isolated, read-only demo. It uses a single in-memory job (`demo-task-001`) and never loads Dispatcher jobs, prompts, stdout, secrets, or production configuration. The server binds only to `127.0.0.1` and exposes only `/mcp`.

## Install and run

Requires Node.js 22 or newer. In this directory:

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

The local MCP endpoint is `http://127.0.0.1:3737/mcp`. Override the port with `PORT`, for example `$env:PORT='3738'; npm.cmd start`. No build step or external UI assets are needed. This POC uses the official `@modelcontextprotocol/server` v2 package and the MCP Apps wire protocol directly in the inline card script. Runtime files read by the POC are limited to `card.html` and normal Node modules.

The first successful `get_task` or `render_task_card` call starts a 12-second timer. `get_task` returns `RUNNING` before that timer expires and `COMPLETED` with `result_summary` afterward. Restart the POC process to repeat the progression. There is no production job lookup.

## MCP Inspector verification

In another terminal, run `npx.cmd @modelcontextprotocol/inspector@latest`. Select **Streamable HTTP**, enter `http://127.0.0.1:3737/mcp`, and connect. Check:

1. `tools/list` advertises `get_task` and `render_task_card`.
2. `render_task_card` has `_meta.ui.resourceUri` exactly `ui://dalizi-task-card-poc/card.html`.
3. `resources/list` and `resources/read` return that URI with MIME type `text/html;profile=mcp-app` and `_meta.ui.csp` containing empty `connectDomains` and `resourceDomains` arrays. No permissions or external domains are requested.
4. Call `render_task_card` with `{"job_id":"demo-task-001"}`. Its `structuredContent.status` is `RUNNING` if called within 12 seconds of the first valid task call. Call `get_task` with the same arguments after 12 seconds; expect `COMPLETED` and `result_summary`.
5. An unknown `job_id` is rejected by the input schema; it cannot access any other job.

Inspector verifies the MCP surface and resource. Whether Inspector displays the HTML card depends on its UI support; the included tests also exercise the card's MCP Apps message flow in a simulated host. They do not prove ChatGPT rendering.

## Temporary ChatGPT Developer Mode verification (HUMAN)

Use a **new temporary HTTPS tunnel pointed only at `127.0.0.1:3737`**. Do not reuse or reconfigure the production Tunnel or MCP connection. For example, `ngrok http 3737` provides a temporary `https://<temporary-host>` URL. Set the exact hostname (add a port only if the tunnel forwards one in its Host header) before starting this POC server:

```powershell
$env:POC_TUNNEL_HOST='<temporary-host>'
npm.cmd start
```

If the POC server was already running, stop and restart **that POC process only** after setting `POC_TUNNEL_HOST`. The setting allows only that Host header in addition to localhost; it is not a credential. The server remains bound to `127.0.0.1`. Browser requests with a nonlocal `Origin` header are rejected. Use a tunnel that forwards server-to-server MCP requests without adding such an Origin header.

In ChatGPT web, enable Developer mode if available to your account/workspace, create a **new temporary** MCP connection/plugin using `https://<temporary-host>/mcp`, and review the discovered tool metadata. In a new conversation, select that temporary connection and ask: `Call render_task_card with job_id demo-task-001.` Confirm the card renders inside the conversation, displays all fields, and its Refresh button changes state by calling `get_task` from the card. To observe `RUNNING → COMPLETED`, restart the POC server immediately before the ChatGPT tool call, then refresh within and after 12 seconds. Enable Auto-refresh while running and verify it stops on completion. Remove the temporary ChatGPT connection and stop the temporary tunnel after the check.

**Actual ChatGPT rendering and host-mediated card tool calls remain HUMAN verification until this POC is connected in ChatGPT UI.** Do not infer those outcomes from local tests or Inspector.

## Local evidence

`node --test` checks the Streamable HTTP `initialize`, `tools/list`, `resources/list`, `resources/read`, both `tools/call` paths, `RUNNING → COMPLETED`, closed CSP, unknown job rejection, self-contained HTML, bridge `ui/initialize` and tool-result handling, Refresh `tools/call`, auto-refresh stop, teardown, and feature-detected `window.openai.callTool` fallback. See `server.test.js` and `card.test.js`. The test uses an ephemeral localhost port and closes it after completion.

Protocol references: [MCP Apps overview](https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html), [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx), [OpenAI UI guide](https://developers.openai.com/plugins/build/chatgpt-ui), [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), and [MCP Inspector](https://github.com/modelcontextprotocol/inspector).
