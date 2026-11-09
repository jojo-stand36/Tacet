# Architecture (draft v0)

_This is a proposal to be ratified via ADRs in milestone M0. Wire protocols and local security follow [ADR-003](adr/003-wire-protocols.md) (accepted 2026-11-09). Language and runtime follow [ADR-002](adr/002-language-runtime.md) (proposed; waits on ADR-001, issue #2)._

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
interface AgentAdapter {
  id: string;                         // "claude-sdk", "codex-app-server", "acp", "pty"
  capabilities(): AdapterCapabilities; // streaming, approvals, usage, resume, fork, interrupt…
  start(opts: SessionOptions): Promise<SessionHandle>;
  send(h: SessionHandle, input: UserInput): Promise<void>;
  interrupt(h: SessionHandle): Promise<void>;
  respond(h: SessionHandle, req: ApprovalId, decision: Decision): Promise<void>;
  close(h: SessionHandle): Promise<void>;
  events(h: SessionHandle): AsyncIterable<AgentEvent>; // normalized
}

type AgentEvent =
  | { t: "message.delta"; text: string }
  | { t: "tool.call"; name: string; input: unknown }
  | { t: "tool.result"; id: string; ok: boolean }
  | { t: "approval.request"; id: string; summary: string }
  | { t: "usage"; inputTokens: number; outputTokens: number; contextUsed: number; contextMax: number; costUsd?: number }
  | { t: "status"; state: "running" | "idle" | "waiting_input" | "error" | "done" }
  | { t: "escalation"; question: string; options?: string[]; urgency: Urgency };
```

All events go to an append-only **event log** (SQLite) → UI timelines, replay, audit, cost.

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
```

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

## 6. Security & auth principles
Local servers ([ADR-003 §3, §5, §6](adr/003-wire-protocols.md#3-auth-token-handshake-all-local-servers)):

- **Binding.** The Conductor and each mini-conductor bind `127.0.0.1` and `::1` on an OS-assigned port. Remote or LAN access is an explicit opt-in (`remote: true` plus TLS) and is out of scope for v0.
- **Token.** Each daemon generates a 256-bit token on start and rotates it on every start. The token is written, with the pid, port and protocol versions, to a runtime file in `~/.tacet/run/` that only the user can read (mode 0600 on POSIX). It is never inside a repo, and it is never logged or put in events.
- **Browsers** never get the token. `tacet open` opens `http://127.0.0.1:<port>/#code=<one-time-code>`. The page exchanges the code (single use, 60 s lifetime) at `POST /auth/session` for an `HttpOnly; SameSite=Strict` session cookie.
- **Host and Origin.** Requests are rejected unless `Host` is `127.0.0.1`, `[::1]` or `localhost` with the server port (DNS-rebinding defence). Browser requests must also match the served `Origin`.
- **Hello.** The first frame on any socket must be `tacet/hello`. Any other method before hello closes the socket.
- **Workers** get their own MCP token, bound to `{workerSessionId, taskId}` and revoked when the session closes. Tools take no `taskId` or `workerId` argument, and the token never appears in events ([ADR-003 §6](adr/003-wire-protocols.md#6-workers--mini-conductor-mcp-tool-surface)).

Vendor auth and billing:

- Never store, log, proxy or copy vendor OAuth or subscription tokens. Launch vendor CLIs and SDKs under the user's own login or API key.
- **Default auth routing** (owner decision, 2026-11-09): prefer the API key for parallel or unattended Workers, and use the user's subscription login for interactive or single sessions. The owner can override this in config. Many parallel Workers on one subscription is an open risk; see [`docs/RESEARCH.md` §7](RESEARCH.md#7-auth-billing-and-terms-important-constraint).

Other:

- Worktree isolation by default; optional OS sandbox later.
- All approvals and decisions are logged and attributable.
