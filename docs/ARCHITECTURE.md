# Architecture (draft v0)

_This is a proposal to be ratified via ADRs in milestone M0._

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
- Workers call MCP `escalate({question, options?, urgency, context_ref})`, or the adapter surfaces a permission/approval request.
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
```

## 5. Packages (monorepo)

| Package | Purpose |
|---|---|
| `@tacet/core` | Types, event schema, HandoffPacket schema, config loader |
| `@tacet/conductor` | Global daemon: registry, inbox, workflows, API for UI |
| `@tacet/mini` | Per-repo daemon + MCP server; this is the "install into your repo" package |
| `@tacet/adapter-*` | `claude-sdk`, `codex-app-server`, `opencode`, `acp`, `pty` |
| `@tacet/web` | React UI: board, inbox, live terminals (xterm.js), cost |
| `@tacet/tui` | Ink-based terminal mode |
| `tacet` (cli) | `tacet up`, `tacet init`, `tacet status`, `tacet attach` |

## 6. Security & auth principles
- Bind to 127.0.0.1 with a per-install token; LAN/remote access is explicit opt-in.
- Never store or proxy vendor OAuth tokens; launch vendor CLIs/SDKs under the user's own auth or API keys.
- Worktree isolation by default; optional OS sandbox later.
- All approvals and decisions are logged and attributable.
