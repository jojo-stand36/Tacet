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
   - The plan is one `task.planned` event (`TaskPlan`: sub-tasks with `dependsOn`), written in the same batch as one `task.created` per sub-task with `parentId`. Each `task.planned` is the full current plan: a replan lists every sub-task again, completed ones included. A sub-task's own `task.created` is authoritative for its goal and criteria. A sub-task kind a receiver does not know reads as `explore`, the read-only kind (owner decision, 2026-11-09). Dependencies live in the plan, not on `Task`, because `Task.parentId` is A2A `referenceTaskIds` and sub-tasks stay internal to the Mini-conductor ([ADR-003 §4](adr/003-wire-protocols.md#4-conductor--mini-conductor-a2a-shapes-over-a-json-rpc-websocket)).
   - A sub-task is scheduled once every sub-task it depends on is `completed`, within the `workers` capacity limits (§4).
3. Workers report via events and MCP tools; mini-conductor verifies (tests, lint, reviewer agent).
   - A Worker turn that ends idle with no pending escalation or approval is *finished*, not completed: it goes through verification first. One that ends with an escalation pending with the user is `input_required`. The parent task mirrors `input_required` (and `auth_required`) while a sub-task waits.
   - An escalation answer reaches the Worker that asked as its next message, sent only between turns and recorded as `escalation.delivered` once sent. An answer the gate gives in time comes back in the tool result itself and is recorded as delivered (`inline`). An answer that arrives while no session is open (after a restart or a failed run) goes into the first message of the next session.
   - The Worker pool is the Mini-conductor daemon in `@tacet/mini` (`MiniConductor`, #17). It runs one instance per repo (a lock file), Workers only on the API-key route, and allows a Worker's approval requests only for the exact names of its own MCP tools until policies exist (#25). `completed` keeps its A2A meaning, "done and verified", and its `task.result` has `verification.status: passed`.
   - A new checkout starts from the work of the sub-tasks it depends on, directly or through others (#134; a review that commits nothing passes its dependencies' work on): the commit of a single dependency, or a merge of several made in the main repo without a checkout (`git merge-tree --write-tree`, so git 2.38 or later, and `commit-tree`, authored by the Mini-conductor), recorded as `baseCommit` in `worker.started`. When their work conflicts, the user is asked first and nothing runs; once answered, the sub-task starts from the first dependency's work and its Worker is told to merge the rest, again on every retry along with the answer. A git error while combining is retried on later ticks, up to `max_attempts`. When a task completes, the work of all its sub-tasks is combined the same way into `tacet/<task>/result` (git cannot have `tacet/<task>` next to the sub-task branches `tacet/<task>/<n>`); if independent sub-tasks conflict there, nothing is combined and the task's result says so in its open questions.
   - Worker health (#17): each session has a heartbeat, fed by every adapter event and every `report_progress`. A Worker silent in the middle of a turn for `workers.stuck_after_s` gets `worker.nudged` (recorded only: the Claude and Codex adapters queue input sent during a turn as the next turn, so a hung Worker would never read a message); still silent `workers.nudge_grace_s` later, its session ends as `stuck` and a replacement session starts (`previousSessionId`), within `max_attempts`. A session between turns (waiting on an answer) is never judged stuck, nor one inside a tool call until the call has been open for `stuck_after_s + nudge_grace_s`. The heartbeat starts afresh when a turn starts and when a Mini-conductor restarts. A Worker that keeps reporting progress or calling tools without getting anywhere is not caught by this; that needs a separate limit.
4. Results roll up as **summary packets**, never transcripts: each verified (sub-)task gets a `task.result` (`SummaryPacket`), which goes up to the Conductor as an A2A Artifact with media type `application/vnd.tacet.summary+json`.

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
  capabilities(): AdapterCapabilities; // streaming, liveInput, approvals, interrupt, resume, fork, usage, modelSwitch, injectContext, effortSwitch?, contextSizes?
  start(opts: SessionOptions): Promise<SessionHandle>;   // resolves when ready; opts.resume continues or forks a vendor session; model, effort and contextWindow form the SessionProfile
  send(h: SessionHandle, input: UserInput, opts?: { model?: string; effort?: Effort }): Promise<void>;
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

Every adapter must pass the conformance bench in `@tacet/core/testing` (`runConformance`), run against recorded fixtures or a local mock, never live vendor calls in CI. Its probes compare declared capabilities with observed behaviour and report `drift` when they disagree; P0 probes (start, valid events, stream, usage, approval round-trip, interrupt, close) gate CI, and P1 probes (live input, resume, injected context, model switch, effort, context sizes) only report (#10, after Omnigent's harness bench, ADR-001). An adapter that cannot honour a profile field (an effort level the model lacks, an unlisted context window) throws `ProfileRefusedError` rather than ignore it (#110).

All events go to an append-only **event log** (SQLite) → UI timelines, replay, audit, cost.

The log is `openEventStore()` in `@tacet/core/node` (#6). It stores each envelope verbatim, is idempotent on the envelope id, and blocks `UPDATE`/`DELETE` with triggers. State is rebuilt with pure projections (`tasksProjection` in `@tacet/core`). Retention deletes old transcript-grade events (`agent.message`, `agent.tool`, `agent.approval`, `agent.status`, `agent.escalation`) and keeps every summary-grade event, so task state replays exactly after compaction. Driver: `better-sqlite3`, chosen under [ADR-002](adr/002-language-runtime.md) decision 5 because `node:sqlite` is still a release candidate (Stability 1.2) in Node 24 and 26 as of 2026-11-09; callers use the `EventStore` interface, so moving to `node:sqlite` once it is Stable touches one file.

Every state change is wrapped in an **event envelope** before it is stored or forwarded: `{v, id (ULID), ts, source, repo?, taskId?, sessionId?, correlationId?, causationId?, type, data}`. `AgentEvent` above is the payload of the `agent.*` envelope types (for example `agent.message.delta` and `agent.usage`). The other namespaces are `task.*`, `escalation.*`, `decision.*`, `handoff.*`, `worker.*` and `budget.*`. Worker lifecycle events are summary-grade and kept by retention: `worker.started` (`WorkerStarted`: adapter, model, `workspaceId`, `attempt`, `previousSessionId` for a replacement session, `baseCommit` when a new checkout starts from its dependencies' work, #134), `worker.vendor_session` (the vendor's session id, once known), `worker.nudged`, `worker.integrated` (the Worker's commit is in the repo under `refs/heads/tacet/<task>`, #119), `worker.throttled` (a Worker went over its limit on `escalate` or `record_decision`, by default 6 and 30 per 10 minutes; the calls over it get a tool error and create nothing, #121) and `worker.ended` (`reason`: `finished`, `failed`, `stuck`, `restart`, `canceled`, `handoff`; unknown reads as `failed`; `failed` and `stuck` count against `workers.max_attempts`, the others do not). A Mini-conductor writes `worker.started` before it starts the vendor session, so a crash in between still leaves a record, and rebuilds its Worker pool from these events on restart. They name workspaces by id, never by path, because they are forwarded to the Conductor. Receivers ignore unknown fields and unknown event types. The full envelope is in [ADR-003 §1](adr/003-wire-protocols.md#1-one-transport-envelope-and-one-event-envelope).

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
workers:                    # Worker pool (#17); defaults shown
  max: 4                    # running Workers per repo, all adapters (capacity governor)
  # per_adapter: { codex-app-server: 2 }
  stuck_after_s: 300        # silent this long: nudge
  nudge_grace_s: 900        # still silent this much later: replace the session
  max_attempts: 3           # failed or stuck runs (or an unknown end reason) before a sub-task fails; restarts, handoffs and cancels do not count (owner decision)
  # env: { pass: [MYAPP_*, NPM_TOKEN] }   # more of your environment for Workers (#147); see §6
events:
  # state_dir: ~/.tacet/state   # DB at <state_dir>/<repo-hash>/events.db, outside the repo
  retention:
    transcript_days: 30     # summary events are kept forever
```

**Merge semantics** (#7, `@tacet/core` `mergeConfig`, loaded by `loadConfig` in `@tacet/core/node`):

- Precedence, lowest first: built-in defaults, user, repo, local, task. Objects merge key by key; a higher layer's scalar or array replaces the lower one.
- The task layer may only **lower** `workers.*`, never raise it, because the Worker pool is repo-wide (owner decision, 2026-11-09): a raise is a config error. It may not set `workers.env` at all, and the committed repo layer may not name a secret-looking variable in `workers.env.pass` (#147, §6).
- Exception: `policies`, `escalation.always_ask` and `workers.env.pass` are **unioned** across layers, so a repo or local file cannot silently drop a safety rule or a toolchain variable set elsewhere. Policy evaluation (#25) checks task, local, repo, then user rules, and a `deny` anywhere wins.
- Config is validated strictly: an unknown key or enum value is an error with file, line and column, and all errors are reported at once.
- Secrets never appear in config. Literal credentials (API keys, tokens, private keys) are rejected without echoing them; use `{ env: NAME }` or `{ keychain: service/account }`. A higher layer replaces a secret reference whole (`secrets.*`, `agents.*.env.*`), so switching from `env` to `keychain` never keeps both, and the merged result is validated against the schema again.
- `tacet config explain [--json]` prints every effective value with the layer and file that set it. The output is deterministic.

## 5. Packages (monorepo)

| Package | Purpose |
|---|---|
| `@tacet/core` | Types, zod 4 protocol and event schemas ([ADR-003 §7](adr/003-wire-protocols.md#7-json-schema-stubs-acceptance-item-deferred-to-the-scaffold)), HandoffPacket schema, config loader |
| `@tacet/conductor` | Global daemon: registry, inbox, workflows, API for UI |
| `@tacet/mini` | Per-repo daemon + MCP server; this is the "install into your repo" package. The Worker MCP server (#18, `MiniMcpServer`) serves the ADR-003 §6 tools over Streamable HTTP at `http://127.0.0.1:<port>/mcp` to 2026-07-28 and 2025-era clients, takes identity only from the per-worker bearer token, and records every tool effect in the event log (`EventLogBackend`). `workerConfig()` mints the MCP config an adapter injects into a Worker session. |
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
- **Default auth routing** (owner decision, 2026-11-09): prefer the API key for parallel or unattended Workers, and use the user's subscription login for interactive or single sessions. Only the interactive route is configurable: `auth.unattended` accepts only `api_key` (owner decision on #65). The same policy applies to Codex (#12): an API key for unattended or parallel Workers, and the user's own Codex login only for interactive use. Tacet never implements `chatgptAuthTokens`. Tacet never runs parallel Workers on one subscription; see [`docs/RESEARCH.md` §7](RESEARCH.md#7-auth-billing-and-terms-important-constraint).

Accepted residual risks (owner decision, 2026-11-09):

- **Workers can read `~/.tacet/run`.** Workers run as the same OS user, so file modes alone cannot keep the daemon tokens in `~/.tacet/run/*.json` from them. Until the worker sandbox (#53) denies that path, a worker that reads the file can act as the Mini-conductor or Conductor. The sandbox profile closes this. The same holds for sibling Workers' MCP tokens in `~/.tacet/run/mcp/` (accepted interim risk, ADR-003 addendum): a Worker that reads one can act as that Worker until #53 denies the path; each file is deleted when its session closes, and the Mini-conductor revokes the token when the Worker ends.
- **The one-time code is visible in the process list.** `tacet open` passes the URL (code in the fragment) to the browser launcher, so `ps` shows it to processes of the same user. Accepted: the code is single use, expires after 60 s, and only same-user processes can see it.
- **Worker processes after a crash** (#127): every Worker session gets a random marker, `TACET_WORKER_MARKER=<uuid>`, in its vendor process's environment, which the processes it starts inherit (Claude Code's Bash tools included, even background ones in sessions of their own). The Mini-conductor writes the marker to a 0600 file next to its lock (`<lockPath>.workers`, never in events) before the session starts, and drops it once the adapter has closed the session. On start, before anything resumes, it ends every process of the user whose environment holds a recorded marker (Linux: `/proc/<pid>/environ`; macOS: `ps -E`): SIGTERM, then SIGKILL after 5 s. A process found by its marker is then followed by pid until it is gone (its start time checked before every signal), so a process is never taken for gone only because its environment can no longer be read. A reused pid cannot carry a marker it never saw, so pid reuse needs no further guard. Long-lived services a Worker started (a tmux server, a build daemon) carry its marker too and are ended after a crash, while a clean close leaves them alone. Not covered: a process that clears or overwrites its environment (`env -i`, setproctitle, as a Postgres a test suite starts does), a process whose environment the user cannot read (setuid, non-dumpable), and Codex's tool processes until Codex's environment handling for them is verified. Until the sandbox (#53) denies the state directory, a Worker that writes the file could get processes ended that carry markers of its choosing, which only Worker processes do.
- **Worker MCP config files** hold the worker's token. Adapters write them outside the worktree at mode 0600 and delete them when the session closes, so they cannot be committed (#11–#15). Each Mini-conductor process writes into its own `~/.tacet/run/mcp/<pid namespace>-<pid>-<hash of its start time>/` (`unknown` in place of the hash when it cannot read its own start time); the Claude adapter removes, at its first session, the directories of owners in its pid namespace that are no longer running (a reused pid has another start time; an owner whose start time cannot be read, or that wrote `unknown`, counts as running while its pid exists), and reports only how many files went (#108). Files written directly into the directory by earlier versions have no known owner and are left alone.

Other:

- Worktree isolation by default; optional OS sandbox later.
- **Codex Worker isolation** (owner decision, 2026-11-09; #116):
  - The Codex sandbox's writable roots gain the Worker's *own* worktree git directory (the one `git rev-parse --git-dir` names for that worktree), and no other, so `git commit` works without an escalation each time. A commit also writes objects and a branch ref to the repo's shared `.git`, so (owner decision, option B) the Worker commits on a **detached HEAD** (HEAD is per-worktree) into its **own object store**: the adapter sets `GIT_OBJECT_DIRECTORY=<worktree git dir>/objects` and `GIT_ALTERNATE_OBJECT_DIRECTORIES=<repo>/.git/objects`. The shared `.git` (refs, objects, config, hooks) stays read-only to the Worker. The Mini-conductor integrates the commits outside the sandbox (owner decision, 2026-11-09; #119): after every Worker turn (before verification, and before the sub-task waits on the user), it copies the Worker's loose objects into a snapshot it owns (regular files with object names only, never through a symlink or FIFO, size-capped; the Worker store's alternates and packs are never read), packs the objects reachable from the Worker's HEAD that no branch or tag has, checks them with `index-pack --strict` into a directory of its own (broken or forged objects are rejected and leave nothing behind), moves the checked pack into the shared store, and runs `update-ref refs/heads/tacet/<task>` (compare-and-swap), recording `worker.integrated` (`integrateWorktree` in `@tacet/mini`). Every git command runs asynchronously with a timeout. A turn without a commit of its own integrates nothing. On Linux the Worker's object store is walked through open directory descriptors (`/proc/self/fd`), so a directory swapped for a symlink mid-copy is never followed; macOS has no such path and only re-checks each directory's identity after opening, so a Worker that wins a swap-and-swap-back race could have well-formed objects from another repo the Mini-conductor can read copied in (accepted residual risk; `index-pack --strict` still rejects anything malformed). A checkout that fails the integrity checks below is not touched: the run ends (not counted as a failed attempt) and the user is asked; after the answer the sub-task runs again in a fresh checkout, and the refused one is kept for inspection.
    - **Everything in the Worker's worktree and its git dir is untrusted** once the Worker has run, and a running Worker can change it at any moment (background processes outlive turns). A rewritten `commondir`, `.git` pointer file or `config.worktree` would make git, run later *outside* the sandbox, load config and hooks the Worker wrote; a `logs/HEAD` symlink would make a ref update append to any file. So, before and during any git command outside the sandbox (the adapter's detach at start, the Mini-conductor's integration): the worktree is checked against the trusted repo root by reading its pointer files (`workerWorktree`, in `@tacet/core/node` and shared by the Codex adapter and the Mini-conductor); git runs with `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` set explicitly, so a later forged `commondir` is ignored, with only PATH and HOME besides (`trustedGitEnv`), and with hooks, fsmonitor, reflogs and the commit-graph off (`SAFE_GIT_ARGS`). The adapter writes the detached `HEAD` itself (temp file and rename) instead of running a checkout or `update-ref`. A repo with `extensions.worktreeConfig` (e.g. after `git sparse-checkout`) is refused: git would read `config.worktree` from the Worker-writable git dir.
    - Worker-side commands that write shared refs (`git checkout -b`, `git branch`, `git stash`) fail in the sandbox; whether that becomes an escalation depends on the approval policy. `git checkout <existing branch>` works (HEAD is per-worktree), but the next commit then fails on the shared ref.
    - Until a Worker's commits are integrated, the main repo's `git gc`, `git prune` and `git fsck` fail on that worktree's HEAD (`bad object worktrees/<wt>/HEAD`), and so does a `git push` *into* the repo (its connectivity check walks every worktree HEAD): one unintegrated Worker blocks pushing any other Worker's commits. Nothing is lost. That is why integration copies objects and runs `update-ref` from the main repo instead of pushing into it (#119).
    - The object-dir variables apply to every repo the Worker touches, so a submodule, a `git clone` or a nested repo inside the worktree does not work for unattended Codex Workers yet.
  - Unattended Codex Workers get their own `CODEX_HOME` at `~/.tacet/state/<repo>/codex`; interactive sessions keep the user's `~/.codex`. The user's `config.toml` customisations (including their MCP servers) therefore do not apply to unattended Workers.
  - Codex `features.plugins` is off for unattended Workers, so a Worker start never syncs plugins from GitHub.
- **Worker environment** (#147): a Worker starts with an allowlist of the user's environment, not all of it (`workerEnv` in `@tacet/core`): a base set (PATH, HOME, user, locale, terminal, temp dirs, proxies, CA bundles), toolchain locations (`JAVA_HOME`, `GOPATH`, `CARGO_HOME`, `NVM_DIR`, `VIRTUAL_ENV`, ...), the adapter's own vendor variables, and `workers.env.pass` (names, or prefixes ending in `*`). A prefix never passes a secret-looking name (`*_TOKEN`, `*_KEY`, `*_SECRET`, `AWS_*`, ...); such a variable passes only by its exact name, from the user or local layer, never the committed repo layer, and never from a task. Tacet's own per-session variables (`TACET_WORKER_MARKER`, the session's MCP settings) are added after filtering. Adapters report the names (never values) of dropped variables through a callback, not in events. Interactive sessions inherit the user's whole environment, by an explicit option. `SSH_AUTH_SOCK` and GPG agent variables are not in the base set, so unattended Workers do not sign commits or push over SSH with the user's agent unless the user passes them. The three defaults in this bullet (interactive exempt, repo layer may not pass secrets, no SSH or GPG agent) await the owner's confirmation.
  - **Accepted residual risk:** the allowlist limits accidental exposure (environment dumps in transcripts and test logs, third-party `acp:` agents). It is not a boundary against a hostile Worker: Workers run as the user with `HOME` set and can read `~/.aws/credentials`, `~/.npmrc` or shell profiles until the sandbox (#53), and a Worker hands its own vendor key to the tools it runs.
- All approvals and decisions are logged and attributable.
