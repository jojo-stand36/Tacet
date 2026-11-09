# ADR-003: Wire protocols (conductor↔mini, UI events, MCP surface for workers)

- Status: proposed
- Date: 2026-11-09

Resolves issue #4. Builds on ADR-002 (TypeScript on Node). It ratifies, with changes, the protocol table in `docs/RESEARCH.md` §4.

## Context

We need fixed wire contracts for three boundaries before M1 code is written. The mini-conductor, the Conductor, the UI and every adapter all serialize these shapes, and each one is persisted in the event log, so they are expensive to change later.

| Boundary | Draft in RESEARCH.md §4 |
|---|---|
| Conductor ↔ Mini-conductor | Small JSON-RPC over local WebSocket, shaped like A2A tasks |
| Conductor ↔ UI (web, TUI) | AG-UI-style typed event stream |
| Worker agents ↔ Mini-conductor | MCP server exposed by each mini-conductor |

Hard rules in force (`AGENTS.md`, `docs/ARCHITECTURE.md` §6): servers bind to `127.0.0.1` with a token by default, remote access is opt-in, and no secrets appear in logs.

### Verified protocol facts

Checked 2026-11-09. Documentation hosts for A2A, AG-UI and MCP were not reachable from the authoring session, so facts come from each project's GitHub repo (the source the docs sites are built from) or its published npm package.

| Fact | Source |
|---|---|
| **A2A** latest released version is `1.0.0`. The version is negotiated as `Major.Minor` via the `A2A-Version` service parameter; an empty value means `0.3`. An unsupported version returns `VersionNotSupportedError` (JSON-RPC `-32009`). | https://github.com/a2aproject/A2A/blob/main/docs/specification.md §3.6, §5.4 |
| A2A JSON serialization is camelCase. Enums are ProtoJSON strings, e.g. `"TASK_STATE_INPUT_REQUIRED"`, `"ROLE_USER"`. | same, §5.5 |
| A2A `Task` = `{id (required, server-generated), contextId, status (required), artifacts[], history[], metadata}`. `TaskStatus` = `{state, message?, timestamp?}`. `TaskState` ∈ `SUBMITTED, WORKING, COMPLETED, FAILED, CANCELED, INPUT_REQUIRED, REJECTED, AUTH_REQUIRED` (each prefixed `TASK_STATE_`, plus `UNSPECIFIED`). `Message` = `{messageId, contextId?, taskId?, role, parts[], metadata?, extensions[]?, referenceTaskIds[]?}`. `Part` is one of `text`, `raw`, `url`, `data`, plus optional `metadata`, `filename`, `mediaType`. `StreamResponse` is one of `task`, `message`, `statusUpdate`, `artifactUpdate`. | https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto |
| A2A JSON-RPC methods are PascalCase: `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, … The standard JSON-RPC binding is over HTTP(S) with SSE streaming. Custom bindings (such as WebSocket) SHOULD be identified by a URI in `protocolBinding`. | spec §5.3, §5.8, §9.1 |
| A2A extension data goes in `metadata` keyed by the extension URI, and the URI is listed in `message.extensions`. | spec §4.6 |
| **AG-UI** events have a `type` (UPPER_SNAKE on the wire, e.g. `RUN_FINISHED`), plus optional `timestamp`, `rawEvent` and `metadata`. Most events accept `subagentRunId`. Categories: lifecycle (`RUN_STARTED/FINISHED/ERROR`, `STEP_STARTED/FINISHED`), text, tool call, state (`STATE_SNAPSHOT/DELTA` as JSON Patch, `MESSAGES_SNAPSHOT`), activity (`ACTIVITY_SNAPSHOT/DELTA`), subagent (`SUBAGENT_STARTED/FINISHED/ERROR`), reasoning, special (`RAW`, `CUSTOM`). `THINKING_*` events are deprecated. | https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/events.mdx |
| AG-UI `RUN_FINISHED.outcome` is `{type:"success"}` or `{type:"interrupt", interrupts: Interrupt[]}`. `Interrupt` = `{id, reason, message?, toolCallId?, responseSchema?, expiresAt?, metadata?, subagentRunId?}`. `RUN_STARTED.parentRunId` records run lineage. The interrupt and outcome types ship in `@ag-ui/core` 1.0.4, even though the events page still labels the extended lifecycle "DRAFT". | https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/interrupts.mdx, `@ag-ui/core@1.0.4` `dist/*.d.ts` |
| **MCP** latest spec revision is `2026-07-28`, and it is stateless. The `initialize` handshake and `Mcp-Session-Id` are removed. Each request carries its protocol version and client capabilities in `_meta`. `server/discover` is mandatory. Server-initiated requests (elicitation, sampling, roots) are replaced by multi-round-trip `input_required` results. Tasks moved to the extension `io.modelcontextprotocol/tasks`. Tools keep `inputSchema`/`outputSchema` (JSON Schema 2020-12), `structuredContent`, `isError` and `annotations`. Servers SHOULD list tools in a deterministic order. Roots, Sampling and Logging are deprecated. | https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx, `schema/2026-07-28/schema.ts` |
| Claude Code connects to MCP servers over stdio, HTTP, SSE (deprecated) and WebSocket. `.mcp.json` `headers` support `${VAR}` expansion. The tool-call timeout (`MCP_TOOL_TIMEOUT` or per-server `timeout`) defaults to about 28 h, but `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` defaults to 5 min for HTTP and 30 min for stdio. Its v2 runtime negotiates 2026-07-28 with servers that support it and otherwise "connects … as v1 does". | https://code.claude.com/docs/en/mcp |
| Claude Agent SDK (TS) can host in-process MCP servers (`createSdkMcpServer`, `tool()` with zod schemas and `annotations`). | https://code.claude.com/docs/en/agent-sdk/typescript |
| Codex app-server can listen on `stdio://`, `unix://` or `ws://IP:PORT`. | https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs |

**UNVERIFIED** (follow-up issue needed before M1 code depends on them):
- Which MCP revisions Codex, Gemini CLI and OpenCode clients speak today, and whether `@modelcontextprotocol/server` v2 still answers clients that use the `2025-11-25` `initialize` handshake.
- How each non-Claude adapter injects per-session MCP server config, including HTTP headers (Codex config overrides, ACP `session/new` `mcpServers`, OpenCode config).
- Idle and tool-call timeouts in Codex, Gemini CLI and OpenCode.

## Decision

### 1. One transport envelope and one event envelope

**Transport:** every Tacet socket carries **JSON-RPC 2.0** messages (request, response, notification) as UTF-8 text frames, one message per frame, with no batching. This matches A2A's JSON-RPC binding, ACP, MCP and Codex app-server, so there is one framing model in the codebase.

**Event envelope:** every state change, whether it originates in a worker, an adapter, the mini or the Conductor, is stored in the event log and forwarded upward wrapped in this envelope:

```jsonc
{
  "v": 1,                          // envelope schema major
  "id": "01JCX…",                  // ULID, unique, sortable; idempotency key
  "ts": "2026-11-09T12:00:00.000Z",
  "source": { "kind": "worker" | "mini" | "conductor" | "adapter", "id": "…" },
  "repo": "api-service",           // mini id, absent for conductor-global events
  "taskId": "…",                   // A2A Task.id when task-scoped
  "sessionId": "…",                // worker session (one per handoff generation)
  "correlationId": "…",            // e.g. escalationId, JSON-RPC request id
  "causationId": "01JCX…",         // id of the event that caused this one
  "type": "agent.message.delta",   // dotted, see below
  "data": { /* type-specific payload, schema per type */ }
}
```

`type` namespaces: `agent.*` (the normalized `AgentEvent` from `ARCHITECTURE.md` §3; its `t` becomes the suffix, e.g. `agent.usage`), `task.*`, `escalation.*`, `decision.*`, `handoff.*`, `worker.*`, `budget.*`. The envelope carries no secrets, and adapters must redact tool inputs that match known secret patterns before emitting them.

### 2. Versioning

- **Tacet wire protocol:** an integer major, starting at `1`, negotiated in `tacet/hello`. The client sends `protocolVersions: [1]` and the server picks the highest version both support, or closes the socket with code 4406. Additive changes (new optional fields, methods or event types) do not bump the major. They are advertised as `capabilities` flags, and receivers **must ignore unknown fields and unknown event types**. Removing or changing the meaning of anything bumps the major. The Conductor supports N and N−1 for at least one minor release so minis can upgrade independently.
- **Schemas:** each JSON Schema has `$id: "urn:tacet:schema:<name>:v<major>"` and lives in `packages/core/schema/v<major>/`. The event envelope carries `v`.
- **Pinned external versions:** A2A shapes at `1.0`; AG-UI per `@ag-ui/core` `1.x`; MCP server answers `2026-07-28` and, if the SDK allows, `2025-11-25` (see UNVERIFIED). Upgrading any of these is a normal PR with a changelog line; it does not need a new ADR unless the mapping below changes.

### 3. Auth-token handshake (all local servers)

1. **Binding.** The Conductor and each mini-conductor bind `127.0.0.1` (and `::1`) on an OS-assigned port by default. Binding any other interface requires an explicit `remote: true` setting plus TLS, and is out of scope for v0.
2. **Token.** On start, each daemon generates a 256-bit random token from `crypto.randomBytes` and writes `{pid, port, token, protocolVersions, startedAt}` to a runtime file only the user can read: `~/.tacet/run/conductor.json`, or `~/.tacet/run/minis/<repo-hash>.json` for a mini. The mode is 0600 on POSIX; on Windows the file inherits the user-profile ACL. The file is never inside the repo, so it cannot be committed. The token rotates on every start and is never logged or included in events, errors or crash reports.
3. **Programmatic clients** (mini→Conductor, CLI, TUI) read the runtime file and send `Authorization: Bearer <token>` on the WebSocket upgrade.
4. **Browsers** cannot set headers on a WebSocket upgrade. `tacet open` launches `http://127.0.0.1:<port>/#code=<one-time-code>`, and the page exchanges the code (single use, 60 s lifetime) at `POST /auth/session` for an `HttpOnly; SameSite=Strict` session cookie. The token itself never reaches the browser.
5. **Every HTTP and WebSocket request** is rejected unless the `Host` is `127.0.0.1:<port>`, `[::1]:<port>` or `localhost:<port>` (DNS-rebinding defence), and, for browser requests, the `Origin` matches the served origin. Failures close the socket with 4401, or return 401/403 for HTTP.
6. **Hello.** The first frame after upgrade must be the `tacet/hello` request: `{protocolVersions, role: "mini" | "ui" | "cli", clientInfo: {name, version}, capabilities}`. For `role: "mini"` it also carries `{repoId, repoPath, adapters[], miniVersion}`, which acts as a lightweight Agent Card. The reply is `{protocolVersion, serverInfo, capabilities, sessionId}`. Any other method before hello gets error `-32600` and the socket closes.
7. **Workers never see these tokens.** They get their own scoped MCP token (§6).

### 4. Conductor ↔ Mini-conductor: A2A shapes over a JSON-RPC WebSocket

- **Topology.** The Conductor listens and minis dial in, then hello with `role: "mini"`. After hello the socket is bidirectional JSON-RPC: either side may send requests. In A2A terms the **Conductor is the A2A client and the mini is the A2A server (agent)**, even though the mini opened the socket. This keeps one Conductor port, needs no mini port discovery, and works when a mini starts before the Conductor (it retries with backoff). A mini in standalone mode serves the same methods on its own port to the CLI and UI.
- **Binding identity.** This is an A2A *custom binding* with `protocolBinding: "urn:tacet:binding:a2a-ws-jsonrpc:v1"` (A2A §5.8). The A2A version is implied (`1.0`) by the Tacet protocol major, so no `A2A-Version` header is sent per message. If we later expose a real A2A endpoint, it is the standard HTTP+JSON-RPC binding with that header.
- **A2A methods used as-is** (Conductor → mini), with A2A params and results:
  - `SendMessage`: create a task, or continue one by setting `message.taskId`.
  - `GetTask`, `ListTasks`, `CancelTask`.
  - `SubscribeToTask`: returns `{subscriptionId}`. Stream items arrive as notifications `tacet/stream` with params `{subscriptionId, response: StreamResponse}`, because a WebSocket has no SSE.
  - Not used in v0: push-notification config methods, `GetExtendedAgentCard`, `SendStreamingMessage` (use `SendMessage` + `SubscribeToTask`).
- **Tacet-only methods** (outside A2A, namespaced):
  - `tacet/hello` (§3).
  - `tacet/event` (mini → Conductor notification): batched event envelopes the Conductor needs for its aggregated index, cost ledger and UI. Only summary-grade types are sent upward by default (`task.*`, `escalation.*`, `decision.*`, `handoff.*`, `agent.usage`, `worker.*`), never full transcripts, in line with "summary packets, never transcripts". The UI can request a live per-worker stream on demand (`tacet/attach`).
  - `tacet/attach` / `tacet/detach` (Conductor → mini): open or close a live forward of one worker's full event stream (and PTY bytes, see §5) while someone is watching.
  - `tacet/decision.record` (Conductor → mini, and mini → Conductor): broadcast a recorded user decision so other minis can reuse it as precedent.
- **Errors.** A2A error codes (`-32001`…`-32009`) for A2A methods. Tacet-specific codes use `-32010`…`-32019`. That range does not collide with A2A, and it falls inside MCP's implementation-defined range (`-32000`…`-32019`), so the same codes are safe to reuse on the MCP server. MCP reserves `-32020`…`-32099` for its own spec. Codes are listed in the schema package.

#### Task mapping (Tacet Task → A2A Task)

| Tacet concept (`ARCHITECTURE.md` §2.1) | A2A representation |
|---|---|
| Task id | `Task.id`, **generated by the mini** (A2A says server-generated). The Conductor correlates via the `messageId` it chose. |
| Cross-repo goal / workflow | `contextId`, supplied by the Conductor (the Conductor understands the mini's handling, as A2A §3.4.1 requires) |
| Goal | First `Message` (`role: "ROLE_USER"`), `parts[0].text` |
| Acceptance criteria, budget, priority, autonomy override, tier overrides, deadline | `message.metadata["urn:tacet:a2a-ext:task:v1"]`, with that URI listed in `message.extensions`. Copied to `Task.metadata` under the same key. |
| Parent task / dependency | `message.referenceTaskIds` |
| Sub-tasks inside a repo | Internal to the mini; not exposed as A2A tasks in v0 (sent upward only as `task.*` summary events) |
| Status | `TaskStatus.state`: queued→`SUBMITTED`, running→`WORKING`, waiting on user→`INPUT_REQUIRED`, done and verified→`COMPLETED`, failed verification after the escalation ladder→`FAILED`, cancelled→`CANCELED`, refused by policy→`REJECTED`. `AUTH_REQUIRED` is used when a vendor CLI needs the user to log in (Tacet never handles the token; it just tells the user). |
| Escalation that reached the user | `state: INPUT_REQUIRED`, `status.message` with the question as `text`, plus `metadata["urn:tacet:a2a-ext:escalation:v1"] = {escalationId, options?, urgency, blockedWorkers, contextRef}` |
| User's answer | `SendMessage` with `message.taskId` set, the answer as `text`, plus `metadata["urn:tacet:a2a-ext:decision:v1"] = {escalationId, choice, rationale?, scope}` |
| Summary packet / final result | `Artifact` with a `data` part holding the packet and `mediaType: "application/vnd.tacet.summary+json"` |
| HandoffPacket (if forwarded upward) | `Artifact` with a `data` part and `mediaType: "application/vnd.tacet.handoff+json"` |

Exposing a mini as a real A2A agent later then only needs an HTTP binding and an Agent Card. Task shapes do not change.

### 5. Conductor ↔ UI: AG-UI event subset

- **Direction split.** Server→UI uses **AG-UI events** (validated with `@ag-ui/core` schemas) carried as JSON-RPC notifications `tacet/ui.event` with params `{stream, event}`. UI→server uses ordinary Tacet JSON-RPC requests (`tacet/decide`, `tacet/task.create`, `tacet/task.cancel`, `tacet/attach`, …). We do **not** use AG-UI's `RunAgentInput` for commands, because the UI is a dashboard over many runs, not a chat client starting runs.
- **Identity mapping.** AG-UI `threadId` = Tacet task id. `runId` = worker session id. A handoff starts a new run with `parentRunId` = the previous session, so AG-UI lineage and our handoff chain line up. Workers under a mini-level run appear as subagents (`subagentRunId` = worker session id).
- **Subset (v1):**

| AG-UI event | Tacet use |
|---|---|
| `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` | Session start, end and crash. `RUN_FINISHED.outcome` is `success`, or `interrupt` when the session ended to wait on an escalation (handoff-style waiting). |
| `STEP_STARTED`, `STEP_FINISHED` | Plan steps and verification commands (`stepName` = `verify:pnpm test`, …) |
| `TEXT_MESSAGE_START` / `CONTENT` / `END` (and `TEXT_MESSAGE_CHUNK` if convenient) | Agent text from workers, the mini and the Conductor |
| `TOOL_CALL_START` / `ARGS` / `END` / `RESULT` | Tool activity in the timeline |
| `STATE_SNAPSHOT`, `STATE_DELTA` (JSON Patch) | The board: tasks, workers, budgets, **decision inbox**. A snapshot is sent on connect and on resync. |
| `MESSAGES_SNAPSHOT` | Hydrating a task timeline when the user attaches |
| `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA` | `report_progress` updates and context-usage bars (`activityType`: `PROGRESS`, `CONTEXT`, `VERIFY`, `HANDOFF`) |
| `SUBAGENT_STARTED`, `SUBAGENT_FINISHED`, `SUBAGENT_ERROR` | Worker lifecycle under a mini run |
| `CUSTOM` | Tacet-specific items, with `name` ∈ `tacet.usage`, `tacet.escalation`, `tacet.decision`, `tacet.budget` |

  Excluded in v1: `REASONING_*` (cost, privacy; possible opt-in later), deprecated `THINKING_*`, and `RAW` (debug builds only).
- **Inbox items reuse the AG-UI `Interrupt` shape** (`id` = escalationId, `reason` = urgency class, `message` = question, `responseSchema` built from the options, `expiresAt`), so a stock AG-UI renderer can show them. They live in the state document rather than only in `RUN_FINISHED`, because the inbox spans many runs.
- **Terminals** (xterm.js, PTY adapter) do not go through AG-UI. They use a separate authenticated WebSocket path `/pty/<sessionId>` with binary frames, opened only while a view is attached.
- An SSE endpoint that serves the same events to stock `@ag-ui/client` consumers is a possible follow-up, not v1.

### 6. Workers ↔ Mini-conductor: MCP tool surface

- **Transport.** The mini serves MCP over **Streamable HTTP** at `http://127.0.0.1:<port>/mcp`. Adapters whose agents only support stdio MCP get a tiny `tacet mcp-stdio` bridge that forwards to it. The Claude SDK adapter may register the same tool definitions in-process via `createSdkMcpServer`; this is an optimization, not a different contract.
- **Per-worker capability token.** When the mini spawns a worker, it mints a token bound to `{workerSessionId, taskId}` and injects it into that session's MCP config as `Authorization: Bearer …`. For the stdio bridge, it is passed as an env var to the bridge only. The token is revoked when the session closes. **Tools take no `taskId` or `workerId` argument**: the server derives identity from the token, so a worker cannot act on another task. The token never appears in events.
- **Statelessness.** The tools fit MCP 2026-07-28's stateless model: cross-call state uses server-minted ids passed as arguments (`escalationId`, `handoffId`). No tool blocks waiting for a human, because client idle timeouts (5 min for Claude Code over HTTP) would kill it.
- **Tools (v1).** Each has an `inputSchema`, an `outputSchema` and returns `structuredContent`, and the list is returned in this fixed order:

| Tool | Input | Output | Annotations / notes |
|---|---|---|---|
| `read_task` | `{}` | `{goal, acceptanceCriteria[], constraints, budgetRemaining, relevantDecisions[], handoff?: HandoffPacket}` | `readOnlyHint: true`. Called at session start; a resumed session gets its seed packet here. |
| `report_progress` | `{summary, step?, percent?, filesTouched?[]}` | `{ack: true}` | Non-blocking; becomes an `ACTIVITY_DELTA`. Rate-limited per worker. |
| `escalate` | `{question, options?[], urgency: "low" \| "normal" \| "high" \| "blocking", context?, contextRef?}` | `{escalationId, status: "resolved" \| "pending", answer?, source?: "policy" \| "precedent" \| "mini" \| "user"}` | The escalation gate (`ARCHITECTURE.md` §2.2) runs synchronously within a short bound (a few seconds). If it resolves, the answer comes back immediately. Otherwise the result is `pending`, and the text content tells the worker: "continue independent work, or end your turn if blocked; the answer will arrive as your next message." The mini delivers the answer through the adapter's `send()`. |
| `get_decision` | `{escalationId}` | `{status, answer?, source?}` | `readOnlyHint: true`. Polling fallback for adapters without multi-turn input. |
| `request_handoff` | `{reason, packet: HandoffPacket}` | `{accepted: true, handoffId}` or `isError: true` with `{errors[]}` | The packet is validated against the HandoffPacket schema (`RESEARCH.md` §5). An invalid packet (e.g. missing `nextAction`) returns `isError` so the model regenerates it. When accepted, the mini closes the session and seeds a new one. |
| `record_decision` | `{topic, decision, rationale, scope: "task" \| "repo"}` | `{decisionId, status: "recorded" \| "needs_approval"}` | Task-scope decisions are recorded directly. Repo-scope decisions become precedent only if repo policy and the autonomy setting allow it; otherwise they become an escalation. |
| `search_decisions` | `{query, limit?}` | `{decisions[]}` | `readOnlyHint: true`. Lets a worker check precedent before escalating, which reduces inbox load. |

  Deliberately **not** exposed to workers in v1: `spawn_worker` (fan-out stays a mini decision for cost control; reconsider in M2+), and anything that touches other tasks, config or budgets.
- MCP **resources, prompts, sampling, roots and logging** are not used (the last three are deprecated in 2026-07-28). The MCP **tasks extension** is not used in v1. It is a candidate for `escalate` once the major agent clients support it.

### 7. JSON Schema stubs (acceptance item, deferred to the scaffold)

`@tacet/core` does not exist yet, and `AGENTS.md` forbids scaffolding packages outside their issue. So the stubs are specified here and created by the `@tacet/core` scaffold issue:

- **Source of truth:** zod 4 schemas in `packages/core/src/schema/`. zod is already a dependency of the MCP TS SDK v2 and the Claude Agent SDK's `tool()`. JSON Schema 2020-12 files are generated into `packages/core/schema/v1/*.json` with `z.toJSONSchema`, committed, and checked in CI the same way `ROADMAP.md` is (`--check`).
- **Files (v1):** `envelope`, `hello`, `task-ext` (the `urn:tacet:a2a-ext:task:v1` metadata), `escalation-ext`, `decision-ext`, `summary-packet`, `handoff-packet`, `agent-event` (the `AgentEvent` union), `ui-custom-events` (the `CUSTOM` payloads), and one input/output pair per MCP tool in §6. A2A and AG-UI types are **imported** from `@a2a-js/sdk` and `@ag-ui/core`, not redefined. Adding those runtime dependencies has to be justified in the scaffold PR, per the Conventions section of `AGENTS.md`.
- **Contract tests:** a round-trip fixture per schema, plus a test that every `tacet/ui.event` payload validates against `@ag-ui/core`.

## Consequences

- `docs/ARCHITECTURE.md` needs, in the PR that accepts this ADR:
  - §1 diagram label "JSON-RPC/WS (A2A-shaped tasks)" stays, with a note that the Conductor listens and minis dial in.
  - §3 gains the event envelope and states that `AgentEvent` is the payload of `agent.*` envelope types.
  - §6 gains the token-file, one-time-code and Host/Origin rules.
  - The MCP tool list in `docs/RESEARCH.md` §4 is updated to match §6 here (`spawn_worker` dropped for v1; `get_decision` and `search_decisions` added).
- Follow-up issues (all `area:core` unless noted):
  1. Scaffold `@tacet/core` schemas per §7 (closes the "JSON Schema stubs" acceptance item of #4).
  2. Local auth module: token file, hello handshake, Host/Origin checks, one-time-code exchange. Security-sensitive, so it needs `reviewer`.
  3. `agent:claude`: verify per-vendor MCP client details (the UNVERIFIED list above) and record them in `docs/adapters/capability-matrix.md`.
  4. Decide whether the MCP server must also answer pre-2026-07-28 `initialize` clients, based on item 3.
  5. Later: an AG-UI SSE endpoint for stock clients; a real A2A HTTP binding for minis.
- The escalation UX depends on adapters supporting "answer arrives as the next user turn". Adapters without multi-turn input fall back to `get_decision` polling, which the capability matrix must record.
- Risk: AG-UI's interrupt/outcome lifecycle is still labelled draft in its docs even though it ships in 1.0.4. We use only the `Interrupt` shape and `outcome`, and pin `@ag-ui/core` to `1.x`.

## Alternatives considered

### Conductor ↔ Mini
- **Full A2A over HTTP+SSE now.** Standard and interoperable, but it needs two servers per machine, push-config machinery and per-request version headers, which is heavy for localhost and slower to M1. Our A2A-shaped custom binding keeps the upgrade path. Reversal cost: low (add a binding).
- **Bespoke task model and RPC.** Fastest to write, but it loses A2A alignment and makes a later A2A exposure a translation layer. Reversal cost: medium-high once events are persisted.
- **gRPC (A2A's gRPC binding).** Strong typing, but adds protobuf tooling for contributors and is awkward in browsers. Rejected for v0.
- **Minis listen and the Conductor dials.** Needs port discovery per repo and N listening sockets. Rejected in favour of a single Conductor port; standalone minis still listen for their own CLI/UI.

### UI events
- **Full AG-UI, including `RunAgentInput` commands.** Doesn't fit a multi-run dashboard; commands stay in Tacet JSON-RPC.
- **Own event vocabulary.** Simpler at first, but loses CopilotKit-style interop and a maintained, documented vocabulary.
- **SSE instead of WebSocket.** Matches stock AG-UI clients but needs a second channel for commands and terminals. Deferred as an extra endpoint.

### Worker surface
- **Blocking `escalate` that waits for the human.** Simplest for models, but it breaks on client idle timeouts (5 min HTTP in Claude Code) and holds a worker session idle, burning wall-clock and sometimes tokens. Rejected.
- **MCP elicitation / `input_required` for escalations.** Elicitation goes to the agent's *client* UI (the vendor CLI), not to Tacet's inbox, and was redesigned in 2026-07-28. Wrong direction.
- **MCP tasks extension for escalations.** Promising, but client support is unverified. Revisit later.
- **Adapter-only (no MCP).** Works for tier-1 adapters, but loses "any MCP-speaking agent can join the hierarchy", which is the key trick in `RESEARCH.md` §4.
- **Token in tool arguments instead of transport auth.** Leaks into transcripts and logs. Rejected.
