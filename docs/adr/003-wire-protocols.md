# ADR-003: Wire protocols (conductor↔mini, UI events, MCP surface for workers)

- Status: accepted
- Date: 2026-11-09
- Accepted by the owner on 2026-11-09.

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
| User's answer | `SendMessage` with `message.taskId` set, the answer as `text`, plus `metadata["urn:tacet:a2a-ext:decision:v1"] = {escalationId, choice, rationale?, scope, code?}`. *Accepted 2026-11-11, approved by the owner on PR #305 ([comment 6803381213](https://github.com/jojo-stand36/Tacet/pull/305#issuecomment-6803381213)) (#269):* `code` is the escalation's one-time answer code, which a standalone Mini-conductor's control port requires; only the terminal of the run that asked shows it. |
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

## Owner answers (2026-11-09)

The owner accepted this ADR in full on 2026-11-09. The ADR has no separate list of questions, so the answers below are mapped to the decision points they cover.

- **Topology (§4):** the Conductor listens on one port and minis dial in. Accepted.
- **Security model (§3, §6):** the token-file, one-time-code and per-worker MCP token model is accepted.
- **Escalation (§6, `escalate`):** non-blocking `escalate` is accepted.
- **MCP tool list (§6):** accepted as recommended.
- **AG-UI subset (§5):** accepted as recommended. No reasoning events in v1. UI commands stay Tacet JSON-RPC.
- **Defaults (§1, §2, §4, §7):** zod 4 schemas, the ids as written, the `-32010`…`-32019` error-code range, and the old-MCP-client question answered as recommended (the MCP server answers `2026-07-28` and, if the SDK allows, `2025-11-25`). The `2025-11-25` check is tracked as a roadmap spike.
- **Note on §3.2:** the sentence about the token file on Windows predates the 2026-11-09 platform decision in ADR-002 (macOS and Linux only). It has no effect while Windows is out of scope. The decision text is left unchanged.

Follow-ups for an accepted ADR, applied with this decision: `docs/ARCHITECTURE.md` (§1, §2.2, §3, §5, §6), `docs/RESEARCH.md` §4 and §8, the MCP and Claude Code timeout facts in `docs/adapters/capability-matrix.md`, and removal of Windows from the scaffold issue (#1) and the ADR-002 issue (#3). The schema follow-up is covered by issue #4. The local auth module follow-up has no roadmap issue yet.

### Addendum (2026-11-09): MCP compatibility for #18

The owner decided how the mini-conductor's MCP server handles older clients. This answers follow-up 4 in Consequences.

- **Revisions served:** the MCP server answers both `2026-07-28` and `2025-11-25` clients, through the SDK's default negotiation.
- **Tools:** the core tools in §6 do not rely on any feature that exists only in `2026-07-28`, so clients on either revision get the same tool surface.
- **Conformance:** a three-client conformance test covers this. It is part of #18. The SDK-level result of spike #69 is still recorded in that spike.
- **Revisit:** when the MCP TypeScript SDK announces that it will remove legacy (`2025-11-25`) serving.
- **Auth module:** follow-up 2 (local auth module) is now a roadmap entry in M1 (`agent:claude`, `priority:p0`, `area:security`, with a reviewer pass required).

### Addendum (2026-11-09): browser session without cookies (§3.4)

- **Owner decision (accepted 2026-11-09):** browser auth does not use cookies. A cookie on `127.0.0.1` is sent to every local server on that host, on any port, including dev servers a Worker starts from repo code, which could replay it. §3.4 changes as follows: `POST /auth/session` exchanges the one-time code for a **browser session token** (no `Set-Cookie`). The page keeps the token in memory only (not `localStorage`), presents it in the `tacet/hello` params on the WebSocket and as `Authorization: Bearer` on HTTP calls. The Host and Origin checks in §3.5 are unchanged. Tracked as a new M1 security issue; it replaces the cookie in the #77 auth module. Because the browser's WebSocket upgrade now carries no credential, the daemon accepts it unauthenticated, but such a socket may only send a `role: "ui"` hello with a valid session token; `cli` and `mini` hellos are accepted only on an upgrade that carried a valid daemon bearer token (#100). The browser upgrade and the code exchange require a matching `Origin`. Browser HTTP calls with a session token require it too, except GET and HEAD, which browsers send without `Origin` outside CORS (Fetch standard); a present `Origin` must always match. A missing `Origin` is not proof of same-origin, so the session token stays the control and session GET/HEAD routes must not change state.

### Addendum (2026-11-09): enum evolution (§2)

- **Owner decision:** adding a value to an enum is an additive, non-breaking change under §2. Receivers map an unknown value to that enum's documented fallback instead of rejecting the message. Discriminators (`AgentEvent.t`, the `tacet/hello` `role`) are not covered: an unknown `AgentEvent.t` is ignored, as §2 already says for unknown event types. In `@tacet/core` this is `openEnum()`; each JSON Schema enum carries its fallback as `x-tacet-fallback` (#5 follow-up).

### Addendum (2026-11-09): sibling Worker MCP tokens (§6)

- **Owner decision (accepted interim risk, 2026-11-09):** each Worker's MCP config, with its per-worker token, is a 0600 file in `~/.tacet/run/mcp/` (outside the worktree and deleted on close by the adapter, #11; the Mini-conductor revokes the token through `WorkerTokens` when the Worker ends). Workers share one OS user, so until the worker sandbox (#53) denies `~/.tacet/run/mcp` (alongside `~/.tacet/run`), a Worker that can run shell commands can read a sibling Worker's token and act as that Worker toward the Mini-conductor.

### Addendum (2026-11-10, accepted, approved by the owner): `workspace.*` namespace (§1)

`workspace.*` (`workspace.created`, `workspace.removed`) joins the event namespaces of §1: the Mini-conductor's worktree registry, moved from per-worktree state files into the log (#126). It is local to the Mini-conductor: not in the upward stream of §4, never forwarded to the Conductor, and its payloads carry ids, never paths. Additive under §2.

### Addendum (2026-11-11, accepted, approved by the owner on 2026-11-11 in a comment on PR #264, https://github.com/jojo-stand36/Tacet/pull/264#issuecomment-6802110023): `maintenance.*` namespace (§1)

`maintenance.*` (`maintenance.problem`: `op`, an open enum of `reconcile`, `landed`, `gc`, `unpin` with fallback `other`; `message`; optional `workspaceId`; the envelope's `taskId` when the problem is about one task) joins the event namespaces of §1: failures of the Mini-conductor's unattended upkeep (the start-time worktree reconcile, the landed sweep, idle gc, deleting finished tasks' pin refs), recorded so the user sees them (#254). Like `workspace.*`, it is local to the Mini-conductor: not on the §4 upward allowlist, so never forwarded (`isForwardable`, #256; listed in `LOCAL_EVENT_NAMESPACES`). It has no path fields; in `message`, the repo, state, worktree and home directories are replaced, secrets are redacted, and the length is bounded. Additive under §2.

### Addendum (2026-11-11, accepted, approved by the owner on 2026-11-11 in a comment on PR #264, https://github.com/jojo-stand36/Tacet/pull/264#issuecomment-6802110023): local event namespaces (§1)

- **Standing rule:** a new event namespace that is not on the §4 upward allowlist (local to the Mini-conductor, never forwarded) is additive under §2 and needs only a line in ARCHITECTURE §3, not another addendum here. Anything added to the upward stream still needs the owner's approval. `workspace.*` and `maintenance.*` are the first two such namespaces.

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

### Addendum (2026-11-10): the standalone control port (#201)

Status of this addendum: **accepted** on 2026-11-10, approved by the owner, together with the `ws` runtime dependency.

A standalone Mini-conductor serves the §4 methods on its own port to the CLI (§4, "Topology"). Building it (#201) needs two decisions beyond the text above.

1. **A status extension.** `tacet status` shows a task's sub-tasks, active Workers, usage and open escalations. An A2A `Task` carries none of them, since sub-tasks stay internal in v0 (§4, task mapping). `GetTask` and `ListTasks` add them in `Task.metadata["urn:tacet:a2a-ext:status:v1"]`, a new Tacet extension with its schema in `@tacet/core` and the generated `schema/v1/status-ext.json`, alongside the task, escalation and decision extensions. This adds a file to the §7 list. It is additive under §2 and needs no protocol bump. A Tacet-only method (`tacet/status`) was the alternative; it would keep A2A tasks bare but give the CLI and a future Conductor two ways to read a task.
2. **A2A shapes defined in Tacet, checked against the reference SDK.** §7 says A2A types are imported from `@a2a-js/sdk`. Version 1.3.0's TypeScript types are its in-memory protobuf objects: numeric enums, `{$case, value}` oneofs, empty strings for absent fields. They are not the JSON on the wire (`"TASK_STATE_WORKING"`, `{"text": …}`), so typing the wire with them would be wrong, and converting would load the SDK at runtime. Instead, `@tacet/core` has zod schemas for the A2A 1.0 JSON subset Tacet speaks. A contract test round-trips every shape through the SDK's own JSON codecs (`fromJSON`, then `toJSON`) and requires it unchanged. The SDK stays a devDependency (pinned 1.3.0), and a guard test fails if shipped code imports it.

Also recorded:
- **WebSocket library.** The port uses the `ws` package (pinned 8.22.1, no dependencies). Node 24 has a WebSocket client but no server. It is configured with `noServer` (Host, Origin and bearer checks run on the HTTP upgrade before a socket exists), no compression and 1 MiB frames.
- **What the CLI may do.** A standalone Mini-conductor's port serves `cli` hellos only: a `ui` hello is refused until browser sessions are served there, and a `mini` hello is refused because Mini-conductors dial the Conductor, not each other. `SendMessage` without `taskId` answers `-32004`: new tasks still start with `tacet run`.
- **Paging.** `ListTasks` pages with an opaque `pageToken` (an offset today).
- **Answering.** `tacet answer <id> <text>` is the CLI verb for an answer to a live run. *Accepted 2026-11-11, approved by the owner on PR #305 ([comment 6803381213](https://github.com/jojo-stand36/Tacet/pull/305#issuecomment-6803381213)) (#269):* it asks at its terminal for the escalation's one-time code, which only the terminal of the `tacet run` that asked shows.

### Addendum (2026-11-10): live terminal attach, `/pty/<sessionId>` (#201)

Status of this addendum: **accepted** on 2026-11-11, approved by the owner on PR #267 ([comment 6802114697](https://github.com/jojo-stand36/Tacet/pull/267#issuecomment-6802114697): "Approved: /pty ADR-003 addendum"). The owner also decided that the attach client strips OSC 52 (clipboard writes) from the Worker's terminal bytes; window titles stay allowed. That filter is #302 (next addendum). §5 names the path and its binary frames; §3.6 says the first frame after any upgrade is `tacet/hello`. This fixes how the path works on a standalone Mini-conductor's port:

1. **What `<sessionId>` names.** The Worker session id, the one in `worker.started` (AG-UI `runId`), not the `sessionId` a hello returns. It is a plain token (`[A-Za-z0-9._-]`, at most 128 characters); any other path is 404.
2. **Authenticated at the upgrade only, no hello.** The upgrade passes the same checks as `/`, in this order: Host and Origin, then the bearer token, then the path, so nobody without the token learns which sessions exist. No hello is said: no protocol message travels on the socket, and the protocol version is the runtime file's `protocolVersions`. This is the one exception to §3.6.
3. **Server to client, binary, read only.** Each frame is a chunk of the terminal's bytes. The stream starts with the screen so far (the scrollback), then follows the output. A viewer that fell behind gets `ESC c` (reset) and the scrollback again, in band, since the socket has no other channel. Any frame from the client closes the socket 1003: a typed key would bypass `send` and `respond`, and so the event log. Input to a Worker's terminal is not offered.
4. **Closing.** 1000 `session ended` when the session stops running there: the Mini-conductor ends the stream when it ends the session, whether or not the terminal itself has ended, and a viewer dropped for falling behind is drawn again, not ended. 1001 when the server closes, 1011 if the stream fails. 404 before the upgrade when there is no such running session or it has no terminal; 503 when the server's limit of open terminal sockets (8) is reached. A slot is freed when its connection closes, upgraded or not, and the stream is let go as soon as the viewer leaves, even while it waits for output.
5. **Backpressure.** The server pulls the next chunk only once the last one is handed to the socket, so a slow viewer slows its own stream, and the PTY adapter drops a viewer that falls about a million characters behind (it is drawn again) instead of the Mini-conductor buffering without limit.
6. **Browsers later.** A browser cannot send the `Authorization` header (no cookies, see the 2026-11-09 addendum), so the web UI will need a first text frame carrying its session token on this path. That is deferred; nothing here rules it out.

With a Conductor, the UI's `/pty` lives on the Conductor, which forwards bytes from the Mini-conductor through `tacet/attach` (§4); the standalone CLI connects to the Mini-conductor's own path directly.

### Addendum (2026-11-11): the attach output filter (#302)

Status of this addendum: **accepted** on 2026-11-11, approved by the owner on PR #312 ([comment 6805142575](https://github.com/jojo-stand36/Tacet/pull/312#issuecomment-6805142575): "Approved: #302 ADR-003 addendum (OSC 52 filter), including the deviations from \"all other bytes unchanged\" listed in the PR body."). The owner set its scope on #302: drop OSC 52, kitty's OSC 5522 and iTerm2's OSC 1337/50 copy keys, and keep OSC text, window titles included, to printable ASCII. The approval also covers what came out of the security reviews: dropping every DCS but `q` (tmux passthrough images among them), U+FFFD for bytes that are not UTF-8, dropping C1 controls, and dropping `ESC %` switches and GNU screen's string starts.

Terminals read malformed escape sequences differently. For example, xterm.js drops invalid UTF-8 bytes inside one, kitty reads at most five bytes of an OSC number, tmux and iTerm2 unwrap `ESC x` inside a DCS, and iTerm2 skips `ESC ]` inside an OSC. So `tacet attach` does not try to read the Worker's bytes each terminal's way. It passes on only well-formed text and sequences, which removes most of those differences:

- Text: bytes that are not UTF-8 become U+FFFD, and C1 controls are dropped.
- ESC and CSI sequences pass only when well formed and allowed. ESC sequences that start a string in GNU screen, and `ESC %` encoding switches other than `ESC % G`, are dropped.
- An OSC passes only with a plain number: digits, no leading zero, at most 5. Its text is printable ASCII only (the owner's decision on #302): other bytes, non-ASCII title characters among them, are dropped.

Within that, it drops:

- OSC 52, and numbers that wrap to it in 8 or 16 bits.
- kitty's OSC 5522.
- iTerm2's OSC 1337 (or 50) with a `Copy`, `CopyToClipboard` or `EndCopy` key.
- Every DCS but `q` (sixel, DECRQSS, XTGETTCAP). This covers tmux passthrough, which tmux and iTerm2 unwrap, and iTerm2's `p` hooks. It also drops images a Worker sends through tmux.
- SOS and PM.

iTerm2's other keys, inline images among them, and kitty's APC graphics pass. The facts are in capability matrix §5b. It assumes the user's terminal decodes UTF-8, and it keeps a Worker from switching it away (`ESC % @`). Attach sends `ESC \` when it ends, to close a string a Worker left open. ASCII-only text is what makes it safe under GNU screen, which keeps only the low byte of each title character and re-sends the title to the outer terminal. Known risks: GNU screen's behaviour was modelled from its source, never run. The filter has been tested against xterm.js and against models of kitty, tmux, iTerm2 and screen, never against those terminals themselves. Real-terminal testing, and restoring non-ASCII titles safely, are #311.

### Addendum (2026-11-11): the Conductor's registry connections (#23)

Status of this addendum: **accepted** on 2026-11-11, approved by the owner on PR #323 ([comment 6806865515](https://github.com/jojo-stand36/Tacet/pull/323#issuecomment-6806865515): "Approved: #23 ADR-003 addendum (the Conductor's registry connections): close code 4409 with the probe-then-refuse-or-replace rule, WebSocket ping/pong for liveness, and the local-namespace standing rule widened to the Conductor, naming registry.*.").

1. **One connection per repo, close code 4409.** When a `tacet/hello` with role `mini` names a `repoId` that already has a live connection, the Conductor pings the existing socket. If it answers within about 2 s, the newcomer is closed with **4409** ("repo already connected"); a refused Mini-conductor backs off and retries. If it does not answer, the old socket is ended and the newcomer is accepted. So a Mini-conductor that restarted is never shut out by its own stale socket, and two live ones never serve one repo. 4409 joins 4401 and 4406 (§3). The check runs once the hello is answered, so a refused Mini-conductor first gets a `HelloResult` and then, up to about 2 s later, the 4409 close; a hello result alone is not acceptance. A card whose `repoPath` is not a repo matching its `repoId` is closed the same way with 1008.
2. **Liveness is WebSocket ping/pong.** Heartbeats are transport ping and pong frames, not a JSON-RPC method: the Conductor pings each connection every 10 s and ends one that misses 2 pongs. A client may also close a socket that has been silent too long. No method is added, so §4 is unchanged.
3. **The local-namespace standing rule covers the Conductor.** The standing rule of 2026-11-11 (local event namespaces, §1) reads "local to the Mini-conductor or the Conductor, never forwarded". `registry.*` (`registry.repo_added`, `registry.repo_removed`, `registry.connected`, `registry.disconnected`) is the Conductor's first such namespace: its registry of Mini-conductors, kept in the Conductor's own event log. It carries repo paths, and it is never sent anywhere (`CONDUCTOR_LOCAL_EVENT_NAMESPACES`; not on the §4 allowlist, so `isForwardable` refuses it).

Registration itself is not protocol: a hello records a connection, and only the user registers a repo (`tacet up --add`).

### Addendum (2026-11-11): forwarding events to the Conductor (#24)

Status of this addendum: **proposed**, pending the owner's approval in their own comment on the PR that adds it. The owner decided the substance on #24 (relayed by the coordinator): narrow #24 to read and cancel down and events up, accept the impersonation risk below for now, forward only registered repos' events, and have `tacet up --remove` delete a repo's replica. This text is not accepted until that comment.

1. **What crosses the link in #24.** Down (Conductor → Mini-conductor): `ListTasks`, `GetTask` and `CancelTask` only, advertised by the Mini-conductor in its hello as `capabilities.serves`. Everything else is `-32601`, `SendMessage` included: creating a task or answering an escalation over the link waits until the link is authenticated (below). Up (Mini-conductor → Conductor): `tacet/event`, below. Nothing else.
2. **`tacet/event` params are `{logId, throughSeq, events}`.** `events` is a batch of event envelopes, at most 200 or 256 KiB. `logId` is a random id the Mini-conductor's event log gets when it is created (kept in the log's `meta` table), so a log that was recreated (state deleted, `events.state_dir` changed) is told apart from the one before. `throughSeq` is the log's own `seq` of the last envelope in the batch, or of the last one read, when the batch's tail was not forwardable. It stays a notification (§4): never answered.
3. **`tacet/event.resume {logId?, afterSeq?}` (Conductor → Mini-conductor, request) starts forwarding.** The Conductor calls it once it has accepted a connection (after its duplicate probe), for a registered repo only, with the `logId` and `seq` it has stored through. The Mini-conductor forwards nothing before it, and on it forwards from `afterSeq` onward when `logId` is its own, otherwise from the start. A second call on the same connection restarts from the new point. The Mini-conductor advertises it as `capabilities.events: ['resume']`; a Conductor that never calls it gets no events, which is safe. The cursor is the Mini-conductor's `seq`, never the envelopes' ULIDs: those are ordered by the writer's clock, and `seq` is `AUTOINCREMENT`, never reused after retention compacts transcript-grade events (forwarded types are never compacted).
4. **What is forwarded, and how it is taken.** The Mini-conductor sends only what `isForwardable` allows (§4's upward allowlist, unchanged), reading its own log as the outbox: one batch at a time, the next only once the socket's buffer is drained below 1 MiB, at most every 250 ms when there is little to send. Nothing is lost when the link drops: the next `tacet/event.resume` picks up from the Conductor's stored cursor. The Conductor takes forwarded events as untrusted input: each envelope is schema-checked, the allowlist is applied again (never trusting the sender's), an unknown or non-forwardable type is skipped quietly (§2: ignore what you do not know), and an envelope claiming `source.kind: conductor` or a `registry.*` type, or a batch over the limits, closes the connection with 1008. Provenance is the connection's repo, never the envelope's `repo` field.
5. **Where they live.** A replica per registered repo, `<state dir>/conductor/repos/<repoId>/events.db`: the forwarded envelopes as they are (the store is idempotent on the envelope id, so a resent batch changes nothing) and the cursor `{logId, seq}` in the same transaction. The Conductor's views of a repo's tasks fold that replica. `tacet up --remove` deletes the repo's replica; the Conductor stops forwarding for it by closing its connection (the Mini-conductor redials and is not resumed). Events of repos the user did not register are never forwarded or stored.
6. **Known risk (accepted by the owner, 2026-11-11, until the link is authenticated).** The link's token sits in `~/.tacet/run/conductor.json`, which Workers can read until the worker sandbox (#53) denies that path. So a reader can stand up a Conductor of its own, which Mini-conductors dial (it gains nothing new: read and cancel are already token-only on each control port, #269), or dial the real Conductor as a Mini-conductor of a registered repo while the real one is not connected (4409 protects only a live one; a repo id is the hash of a known path), and forward made-up task, escalation and cost events into that repo's replica. The decision inbox (#26) stays blocked until the link is authenticated, so a forwarded escalation never reaches the user as something to decide.

Additive under §2 (a new Tacet-only method, new params of an existing notification, capability flags); the upward allowlist of §4 is not widened.
