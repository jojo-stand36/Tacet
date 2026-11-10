# Spike #61: ACP session semantics (cancel, stdio framing, fork, usage)

Checked 2026-11-09. Closes gap 4 in [`capability-matrix.md`](../../capability-matrix.md).

## Sources

`agentclientprotocol.com` does not resolve from this environment. The site is built from the `docs/` folder of the protocol repo, so I read the prose there. It is the same primary text.

- Repo `agentclientprotocol/agent-client-protocol` at commit `75438f7` (2026-11-09).
- Prose: `docs/protocol/v1/transports.mdx`, `cancellation.mdx`, `prompt-turn.mdx`, `docs/protocol/v2/migration.mdx`, `docs/rfds/*.mdx`. RFD stages come from the navigation groups in `docs/docs.json`.
- Schemas: `schema/v1/schema.json` and `schema.unstable.json` (schema release `1.30.0`, 2026-11-09), and `schema/v2/` (`2.0.0-alpha.14`).
- Live: the `initialize` response of `gemini --experimental-acp` (0.67.0) and `opencode acp` (1.19.5) (`fixtures/`, `harness/acp-init.mjs`). The bundled JS/binary was searched for `usage_update` emission.

## Findings

### stdio framing (v1 `transports.mdx`)

- JSON-RPC 2.0, UTF-8. The client launches the agent as a subprocess.
- One message per line, delimited by `\n`. Messages **must not** contain embedded newlines.
- The agent's stdout carries only valid ACP messages. stderr is free-form logging that the client may capture or ignore. The client writes only ACP messages to stdin.
- stdio is the only defined transport. Streamable HTTP/WebSocket is an Active RFD.
- v2 adds: request ids must be a string or integer (never `null`), and no JSON-RPC batches.

### Cancel flow (v1 `prompt-turn.mdx` → Cancellation, `cancellation.mdx`)

1. Client sends **notification** `session/cancel {sessionId}`. There is no response.
2. Client **should** mark the turn's unfinished tool calls `cancelled` immediately.
3. Client **must** answer every pending `session/request_permission` with outcome `cancelled`. It does not wait for the agent.
4. Agent **should** stop model requests and tool calls. It **may** still send `session/update`s, but only before it responds.
5. Agent **must** answer the original `session/prompt` with `stopReason: "cancelled"`, and **must** catch abort exceptions rather than returning an error. Clients **should** still accept tool-call updates that arrive after cancel.

General request cancellation is `$/cancel_request {requestId}` (RFD `request-cancellation`, Completed). Support is optional. The receiver must still answer the original request, either with a normal result (e.g. `cancelled` stop reason or outcome) or with error `-32800`. Internally cancelled requests should use `-32800` too.

### Fork and `set_model`

| Feature | Status | Detail |
|---|---|---|
| `session/fork` | **UNSTABLE**: in `schema.unstable.json` only, RFD `session-fork` in Draft | Gated by `agentCapabilities.sessionCapabilities.fork` (`{}` = supported). The schema says it "may be removed or changed at any point" |
| `session/set_model` | not present in v1 or v2, stable or unstable | Model switching is a session config option with category `model` (RFD `model-config-category`, **Completed**) via `session/set_config_option` |
| `session/resume`, `session/close`, `session/list`, `session/delete` | Completed RFDs, in v1 stable schema | gated by `sessionCapabilities` |

### `usage_update` (RFD `session-usage`, Completed)

| Agent | Sends `usage_update`? | Fields | Evidence |
|---|---|---|---|
| Gemini CLI 0.67.0 | yes, after model responses | `used` (input + output tokens of the turn), `size` (model token limit); **no `cost`** | bundled source `gemini-*.js` (`sessionUpdate: "usage_update"`); not observed live (no model key) |
| OpenCode 1.19.5 | yes | `used`, `size` (context limit), `cost: {amount, currency: "USD"}` (total session cost) | binary contains the emitting code (`sessionUpdate:"usage_update",used:…,size:…,cost:{amount:…,currency:"USD"}`); not observed live |
| Claude and Codex ACP adapters | not checked | | spike #62 |

`end-turn-token-usage` (per-turn token counts on the prompt response) is a Draft RFD. Do not rely on it.

### Agent capabilities observed (`initialize`, protocol version 1)

| Agent | `loadSession` | `sessionCapabilities` | `mcpCapabilities` |
|---|---|---|---|
| Gemini CLI 0.67.0 | true | none | http, sse |
| OpenCode 1.19.5 | true | `close`, `fork` (unstable), `list`, `resume` | http, sse |

### ACP v2 is coming

ACP v2 (schema `2.0.0-alpha.14`, Active RFD group) is a consolidation release. Its main changes:

- `session/prompt` only acknowledges acceptance; the turn ends via `state_update` notifications, which carry the stop reason.
- Updates are upserts by id.
- The client filesystem, terminal and session-modes APIs are removed.
- Capabilities are reorganised.

The migration guide tells implementers to support v1 and v2 side by side and negotiate the version per connection.

Status, live agent support and the go/no-go: [spike #85](../85-acp-v2/README.md) (2026-11-10).

## Implications for the generic ACP adapter (#13)

- Implement **v1** now: newline-delimited JSON-RPC over stdio, with stderr captured to the Worker log.
- Cancel: send `session/cancel`, resolve any pending permission request as `cancelled`, keep accepting updates, and treat `stopReason: "cancelled"` (or `-32800`) as a cancelled turn, not an error.
- `capabilities()`: report fork only when `sessionCapabilities.fork` is advertised, and label it unstable. Otherwise fall back to HandoffPacket emulation. Report live context usage as "if the agent sends `usage_update`" (Gemini: tokens only; OpenCode: tokens + USD).
- Model switch: look for a config option with category `model`.
- Keep the transport and prompt-turn code isolated, so a v2 path (prompt ack + `state_update`) can be added behind a flag later. Track v2 stabilisation as a follow-up.
