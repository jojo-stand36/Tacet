# Architecture (draft v0)

_This is a proposal to be ratified via ADRs in milestone M0. Wire protocols and local security follow [ADR-003](adr/003-wire-protocols.md) (accepted 2026-11-09). Language and runtime follow [ADR-002](adr/002-language-runtime.md) (accepted 2026-11-09): TypeScript on Node 24 or later, no Bun. The build-vs-extend choice is [ADR-001](adr/001-build-vs-extend.md) (accepted 2026-11-09, option C: standalone with interop)._

## 1. Roles

```
                         ┌──────────────────────────────┐
   You  ◄──────────────► │          CONDUCTOR           │  frontier model, high effort
 (web UI / TUI /         │  global daemon on localhost   │
  phone / Slack…)        │  • decision inbox             │
                         │  • cross-project workflows    │
                         │  • global config & profiles   │
                         │  • cost ledger, registry      │
                         └──────┬───────────┬───────────┘
                    JSON-RPC/WS │           │ (A2A-shaped tasks)
              ┌─────────────────▼──┐     ┌──▼─────────────────┐
              │  MINI-CONDUCTOR    │     │  MINI-CONDUCTOR    │  mid-tier model
              │  repo: api-service │     │  repo: research/   │
              │  • task queue      │     │  …                 │
              │  • worker pool     │     └────────────────────┘
              │  • escalation gate │
              │  • handoff manager │
              │  • MCP server      │
              └──┬───────┬──────┬──┘
     adapters    │       │      │
          ┌──────▼─┐ ┌───▼──┐ ┌─▼──────┐
          │ Claude │ │Codex │ │ Gemini │   cheap / low-effort workers
          │  Code  │ │      │ │  (ACP) │   each in its own git worktree
          └────────┘ └──────┘ └────────┘
```

The Conductor listens on one local port and mini-conductors dial in over JSON-RPC/WebSocket, so there is one port and no per-repo port discovery. A mini-conductor that runs standalone serves the same methods on its own port for the CLI and UI ([ADR-003 §4](adr/003-wire-protocols.md#4-conductor--mini-conductor-a2a-shapes-over-a-json-rpc-websocket)).

| Role | Lives | Owns | Talks to |
|---|---|---|---|
| **Conductor** | One per machine, `tacet up` | User attention, cross-repo plans, global policy, registry of mini-conductors, aggregated cost | User (UI/channels), mini-conductors |
| **Mini-conductor** | One per repo/workspace, installed via package, config in `.tacet/` | Task decomposition within the repo, worker lifecycle, worktrees, verification, escalation filtering, handoffs | Conductor (up), workers (down, via adapters + MCP) |
| **Worker** (sub-agent) | Short-lived agent sessions | One task or sub-task | Mini-conductor only (MCP tools + adapter events) |

A mini-conductor can run **without** a Conductor (standalone mode) — useful on its own, and makes adoption incremental.

## 2. Core loops

### 2.1 Task flow
1. User (or a workflow) gives the Conductor a goal; Conductor routes it to one or more mini-conductors as **tasks** (A2A-shaped: id, goal, acceptance criteria, budget, priority).
2. Mini-conductor plans → sub-tasks → picks adapter+model per its tier policy → spawns workers in worktrees.
3. Workers report via events and MCP tools; mini-conductor verifies (tests, lint, reviewer agent).
4. Results roll up as **summary packets**, never transcripts.

### 2.2 Escalation flow
- Workers call MCP `escalate({question, options?, urgency, contextRef?})`. The call does not block on a human: if the gate does not resolve it within a few seconds, it returns `pending`, and the answer arrives as the worker's next message ([ADR-003 §6](adr/003-wire-protocols.md#6-workers--mini-conductor-mcp-tool-surface)). Adapters can also surface a permission or approval request.
- Mini-conductor's **escalation gate** first tries to resolve it: repo policy, past decisions log, its own reasoning. Only unresolved items go up.
- Conductor dedupes/batches across repos and puts them in the **decision inbox**, ranked by urgency × blocked-workers.
- User answers once; the answer is recorded as a **decision** (reusable precedent) and flows back down.
- Escalation strictness is a per-user/per-repo dial (`autonomy: low | medium | high`).

### 2.3 Handoff flow
- Context usage tracked per session; at the `handoff` band the worker is asked for a typed **HandoffPacket** (see RESEARCH.md §5).
- Packet validated → stored in `.tacet/handoffs/<task>/<n>.json` → session closed → new session seeded with it (model may change per policy).
- The same packet type is used for mini→conductor summaries and for the Conductor's own self-handoff.

## 3. Key interfaces (sketch)

```ts
interface AgentAdapter {               // packages/core/src/adapter/types.ts (#10)
  id: string;                         // "claude-sdk", "codex-app-server", "acp", "pty"
  capabilities(): AdapterCapabilities; // streaming, liveInput, approvals, interrupt, resume, fork, usage, modelSwitch, injectContext
  start(opts: SessionOptions): Promise<SessionHandle>;   // resolves when ready; opts.resume continues or forks a vendor session
  send(h: SessionHandle, input: UserInput, opts?: { model?: string }): Promise<void>;
  interrupt(h: SessionHandle): Promise<{ stillQueued?: string[] }>;
  respond(h: SessionHandle, req: ApprovalId, decision: ApprovalDecision): Promise<void>;
  close(h: SessionHandle): Promise<void>;
  events(h: SessionHandle): AsyncIterable<AgentEvent>; // normalized
  status(h: SessionHandle): SessionState;
  injectContext?(h: SessionHandle, text: string): Promise<void>;
}

type AgentEvent =                     // zod source: packages/core/src/schema/agent-event.ts
  | { t: "message.delta"; text: string }
  | { t: "tool.call"; id: string; name: string; input: unknown }   // input redacted
  | { t: "tool.result"; id: string; ok: boolean; summary?: string }
  | { t: "approval.request"; id: string; summary: string; toolName?: string;
      options?: ("allow_once" | "allow_always" | "reject" | "cancel")[]; requestedGrant?: unknown }
  | { t: "usage"; inputTokens: number; outputTokens: number; contextUsed?: number; contextMax?: number;
      costUsd?: number; model?: string; source: "reported" | "estimated" }
  | { t: "status"; state: "running" | "idle" | "waiting_input" | "auth_required" | "cancelled" | "error" | "done";
      message?: string }
  | { t: "escalation"; question: string; options?: string[]; urgency: Urgency; context?: string; contextRef?: string };

// The answer to an approval.request. allow_always is session-scoped unless persist is true.
type ApprovalDecision = { kind: "allow_once" | "allow_always" | "reject" | "cancel"; persist?: boolean;
  message?: string; updatedInput?: unknown; grant?: unknown };
```

The shared schemas (`AgentEvent`, `Task`, `Escalation`, `Decision`, `HandoffPacket`, the event envelope and the A2A extension metadata) are zod 4 schemas in `@tacet/core`, exported as JSON Schema 2020-12 in `packages/core/schema/v1/` (#5, [ADR-003 §7](adr/003-wire-protocols.md#7-json-schema-stubs-acceptance-item-deferred-to-the-scaffold)). On `usage`, token and cost fields are per-call deltas (adapters convert cumulative vendor totals), `contextUsed`/`contextMax` are gauges, and context and cost are optional because not every vendor reports them ([capability matrix §7](adapters/capability-matrix.md)). `ApprovalDecision` (an adapter's answer to a tool-approval request) is distinct from `Decision` (a recorded answer to an escalation, reused as precedent). Receivers parse agent events with `parseAgentEvent`, which ignores unknown kinds. Enum fields read an unknown value as their documented fallback, for example `urgency` as `normal` and `kind` as `reject` ([ADR-003 enum addendum](adr/003-wire-protocols.md#addendum-2026-11-09-enum-evolution-2)).

Every adapter must pass the conformance bench in `@tacet/core/testing` (`runConformance`), run against recorded fixtures or a local mock, never live vendor calls in CI. Its probes compare declared capabilities with observed behaviour and report `drift` when they disagree; P0 probes (start, valid events, stream, usage, approval round-trip, interrupt, close) gate CI, and P1 probes (live input, resume, injected context, model switch) only report (#10, after Omnigent's harness bench, ADR-001).

All events go to an append-only **event log** (SQLite) → UI timelines, replay, audit, cost.

The log is `openEventStore()` in `@tacet/core/node` (#6). It stores each envelope verbatim, is idempotent on the envelope id, and blocks `UPDATE`/`DELETE` with triggers. State is rebuilt with pure projections (`tasksProjection` in `@tacet/core`). Retention deletes old transcript-grade events (`agent.message`, `agent.tool`, `agent.approval`, `agent.status`, `agent.escalation`) and keeps every summary-grade event, so task state replays exactly after compaction. Driver: `better-sqlite3`, chosen under [ADR-002](adr/002-language-runtime.md) decision 5 because `node:sqlite` is still a release candidate (Stability 1.2) in Node 24 and 26 as of 2026-11-09; callers use the `EventStore` interface, so moving to `node:sqlite` once it is Stable touches one file.

Every state change is wrapped in an **event envelope** before it is stored or forwarded: `{v, id (ULID), ts, source, repo?, taskId?, sessionId?, correlationId?, causationId?, type, data}`. `AgentEvent` above is the payload of the `agent.*` envelope types (for example `agent.message.delta` and `agent.usage`). The other namespaces are `task.*`, `escalation.*`, `decision.*`, `handoff.*`, `worker.*` and `budget.*`. Receivers ignore unknown fields and unknown event types. The full envelope is in [ADR-003 §1](adr/003-wire-protocols.md#1-one-transport-envelope-and-one-event-envelope).

## 4. Configuration layers

```
~/.tacet/config.yaml          # user profile: tiers, models, autonomy, channels, budgets
<repo>/.tacet/tacet.yaml     # repo policy (committed): agents allowed, verify cmds, escalation rules
<repo>/.tacet/local.yaml      # personal overrides (gitignored)
task-level overrides           # per task from UI/CLI
```

Example repo config:

```yaml
tiers:
  mini:    { adapter: claude-sdk, model: sonnet, effort: medium }
  worker:  { adapter: codex-app-server, model: gpt-codex-mini, effort: low }
  review:  { adapter: claude-sdk, model: opus, cross_vendor: true }
escalation:
  autonomy: medium
  always_ask: ["dependency upgrades", "schema migrations", "anything touching /infra"]
handoff:
  warn: 0.55
  handoff: 0.70
  hard: 0.85
verify:
  - pnpm test
  - pnpm lint
budget:
  per_task_usd: 2.00
  per_day_usd: 25.00
  api_key_per_month_usd: 200.00   # default monthly cap for API-key spend (owner decision, 2026-11-09)
auth:
  unattended: api_key      # default: API key for parallel or unattended Workers
  interactive: subscription
agents:                     # acp:<slug> agents and PTY presets
  goose: { kind: acp, command: [goose, acp], env: { GOOSE_API_KEY: { env: GOOSE_API_KEY } } }
policies:
  - { tool: Bash, match: "rm -rf *", decision: deny }
events:
  # state_dir: ~/.tacet/state   # DB at <state_dir>/<repo-hash>/events.db, outside the repo
  retention:
    transcript_days: 30     # summary events are kept forever
```

**Merge semantics** (#7, `@tacet/core` `mergeConfig`, loaded by `loadConfig` in `@tacet/core/node`):

- Precedence, lowest first: built-in defaults, user, repo, local, task. Objects merge key by key; a higher layer's scalar or array replaces the lower one.
- Exception: `policies` and `escalation.always_ask` are **unioned** across layers, so a repo or local file cannot silently drop a safety rule set elsewhere. Policy evaluation (#25) checks task, local, repo, then user rules, and a `deny` anywhere wins.
- Config is validated strictly: an unknown key or enum value is an error with file, line and column, and all errors are reported at once.
- Secrets never appear in config. Literal credentials (API keys, tokens, private keys) are rejected without echoing them; use `{ env: NAME }` or `{ keychain: service/account }`. A higher layer replaces a secret reference whole (`secrets.*`, `agents.*.env.*`), so switching from `env` to `keychain` never keeps both, and the merged result is validated against the schema again.
- `tacet config explain [--json]` prints every effective value with the layer and file that set it. The output is deterministic.

## 5. Packages (monorepo)

| Package | Purpose |
|---|---|
| `@tacet/core` | Types, zod 4 protocol and event schemas ([ADR-003 §7](adr/003-wire-protocols.md#7-json-schema-stubs-acceptance-item-deferred-to-the-scaffold)), HandoffPacket schema, config loader |
| `@tacet/conductor` | Global daemon: registry, inbox, workflows, API for UI |
| `@tacet/mini` | Per-repo daemon + MCP server; this is the "install into your repo" package |
| `@tacet/adapter-*` | `claude-sdk`, `codex-app-server`, `opencode`, `acp`, `pty` |
| `@tacet/web` | React UI: board, inbox, live terminals (xterm.js), cost |
| `@tacet/tui` | Ink-based terminal mode |
| `tacet` (cli) | `tacet up`, `tacet init`, `tacet status`, `tacet attach` |

### Interop

Tacet owns its core and interoperates at the protocol level ([ADR-001](adr/001-build-vs-extend.md), accepted 2026-11-09):

- **Inbound.** A Mini-conductor exposed as an ACP agent (#51, milestone M2) can be driven by Omnigent (`acp:<slug>`), Gas City (its `acp` session provider) and editors. Agents in those tools can call the Mini's MCP tools with a per-session token ([ADR-003 §6](adr/003-wire-protocols.md#6-workers--mini-conductor-mcp-tool-surface)).
- **Outbound.** Omnigent sessions or Gas City runs as Tacet Workers (`@tacet/adapter-omnigent`, `@tacet/adapter-gascity`) are added only if a user asks for them. They are not on the roadmap.
- Tacet does not fork, vendor or embed Omnigent, Gas Town or Gas City.

## 6. Security & auth principles
Local servers ([ADR-003 §3, §5, §6](adr/003-wire-protocols.md#3-auth-token-handshake-all-local-servers)):

The building blocks live in `@tacet/core/node` (`packages/core/src/node/auth/`, #77): `writeRuntimeFile`/`readRuntimeFile`, `listenLoopback`, `checkHostAndOrigin`, `HelloGate`, `OneTimeCodes`/`BrowserSessions`/`exchangeCode` (session token in the response body, never a cookie; `HelloGate` checks it for `role: "ui"` via `verifyBrowserSession`), `WorkerTokens`, and a `Secret` wrapper that prints `[redacted]` everywhere except `reveal()`. The daemons wire them into their HTTP and WebSocket servers.

- **Binding.** The Conductor and each mini-conductor bind `127.0.0.1` and `::1` on an OS-assigned port. Remote or LAN access is an explicit opt-in (`remote: true` plus TLS) and is out of scope for v0.
- **Token.** Each daemon generates a 256-bit token on start and rotates it on every start. The token is written, with the pid, port and protocol versions, to a runtime file in `~/.tacet/run/` that only the user can read (mode 0600 on POSIX). It is never inside a repo, and it is never logged or put in events.
- **Browsers** never get the daemon token, and no cookie is set ([ADR-003 §3.4 addendum](adr/003-wire-protocols.md#addendum-2026-11-09-browser-session-without-cookies-34)). `tacet open` opens `http://127.0.0.1:<port>/#code=<one-time-code>`. The page exchanges the code (single use, 60 s lifetime) at `POST /auth/session` for a browser session token, keeps it in memory only (never `localStorage` or a cookie), sends it in the `tacet/hello` frame on the WebSocket and as `Authorization: Bearer` on HTTP calls. An upgrade without a daemon bearer token may only hello as `ui` with a valid session token, so a local process cannot claim the `cli` or `mini` role, and a present `Origin` must always match. The upgrade and the code exchange require `Origin`; session-token HTTP calls may omit it only on GET and HEAD, where browsers do not send it outside CORS. A missing `Origin` is not proof of same-origin (cross-origin no-cors GETs omit it too): the session token is the control, so session GET/HEAD routes must not change state. Daemons use `authorizeSessionRequest`, which validates the token and takes the method from the request line.
- **Host and Origin.** Requests are rejected unless `Host` is `127.0.0.1`, `[::1]` or `localhost` with the server port (DNS-rebinding defence). A present `Origin` must match the served origin; when it is required is set per request kind (`RequestAuth`: `browser`, `session`, `bearer`).
- **Hello.** The first frame on any socket must be `tacet/hello`. Any other method before hello closes the socket.
- **Workers** get their own MCP token, bound to `{workerSessionId, taskId}` and revoked when the session closes. Tools take no `taskId` or `workerId` argument, and the token never appears in events ([ADR-003 §6](adr/003-wire-protocols.md#6-workers--mini-conductor-mcp-tool-surface)).

Vendor auth and billing:

- Never store, log, proxy or copy vendor OAuth or subscription tokens. Launch vendor CLIs and SDKs under the user's own login or API key.
- **Default auth routing** (owner decision, 2026-11-09): prefer the API key for parallel or unattended Workers, and use the user's subscription login for interactive or single sessions. The owner can override this in config. The same policy applies to Codex (#12): an API key for unattended or parallel Workers, and the user's own Codex login only for interactive use. Tacet never implements `chatgptAuthTokens`. Many parallel Workers on one subscription is an open risk; see [`docs/RESEARCH.md` §7](RESEARCH.md#7-auth-billing-and-terms-important-constraint).

Accepted residual risks (owner decision, 2026-11-09):

- **Workers can read `~/.tacet/run`.** Workers run as the same OS user, so file modes alone cannot keep the daemon tokens in `~/.tacet/run/*.json` from them. Until the worker sandbox (#53) denies that path, a worker that reads the file can act as the Mini-conductor or Conductor. The sandbox profile closes this.
- **The one-time code is visible in the process list.** `tacet open` passes the URL (code in the fragment) to the browser launcher, so `ps` shows it to processes of the same user. Accepted: the code is single use, expires after 60 s, and only same-user processes can see it.
- **Worker MCP config files** hold the worker's token. Adapters write them outside the worktree at mode 0600 and delete them when the session closes, so they cannot be committed (#11–#15).

Other:

- Worktree isolation by default; optional OS sandbox later.
- All approvals and decisions are logged and attributable.
