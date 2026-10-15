# Roadmap

_Generated from `roadmap/issues.json`. Create the GitHub milestones, labels and issues with `scripts/create-issues.sh`._

## M0 · Foundations

Repo, decisions, schemas, spikes. Nothing runs agents yet.

- [ ] **Repo scaffold: pnpm monorepo, TS, lint, test, CI** — `chore` `P0`
- [ ] **ADR-001: Build standalone vs extend Omnigent vs interop** — `adr` `P0`
- [ ] **ADR-002: Language/runtime (TypeScript on Node vs Bun vs Python)** — `adr` `P0`
- [ ] **ADR-003: Wire protocols (conductor↔mini, UI events, MCP surface)** — `adr` `P0`
- [ ] **Core schemas: Task, AgentEvent, Decision, Escalation, HandoffPacket** — `feature` `P0`
- [ ] **Event log: append-only SQLite store with replay** — `feature` `P0`
- [ ] **Config system: layered YAML (user → repo → local → task)** — `feature` `P0`
- [ ] **Spike: adapter capability matrix across Claude, Codex, OpenCode, Gemini, ACP** — `spike` `P0`

## M1 · Mini-conductor MVP

One repo, one mini-conductor, real workers via adapters, worktrees, verification. Usable standalone.

- [ ] **Epic: Mini-conductor MVP (standalone, single repo)** — `epic` `P0`
- [ ] **AgentAdapter interface + conformance test suite** — `feature` `P0`
- [ ] **Adapter: Claude Code (Agent SDK / stream-json)** — `feature` `P0`
- [ ] **Adapter: Codex app-server (JSON-RPC)** — `feature` `P0`
- [ ] **Adapter: generic ACP client** — `feature` `P1`
- [ ] **Adapter: OpenCode server (HTTP + SSE)** — `feature` `P2`
- [ ] **Adapter: PTY + hooks fallback (any CLI)** — `feature` `P1`
- [ ] **Worktree manager** — `feature` `P0`
- [ ] **Mini-conductor daemon: task queue, planner, worker pool** — `feature` `P0`
- [ ] **Mini-conductor MCP server (escalate, report_progress, request_handoff, record_decision…)** — `feature` `P0`
- [ ] **Verification pipeline: commands + reviewer agent** — `feature` `P1`
- [ ] **`tacet init` installer for repos** — `feature` `P0`
- [ ] **CLI: tacet run / status / attach / logs (standalone mode)** — `feature` `P1`

## M2 · Conductor & escalation

Global conductor, multi-repo registry, decision inbox, summary packets.

- [ ] **Epic: Conductor and escalation inbox** — `epic` `P0`
- [ ] **Conductor daemon + mini-conductor registry** — `feature` `P0`
- [ ] **Conductor↔mini protocol implementation** — `feature` `P0`
- [ ] **Escalation gate in mini-conductor** — `feature` `P0`
- [ ] **Decision inbox: dedupe, batch, rank, answer, propagate** — `feature` `P0`
- [ ] **Summary packets (no transcripts upward)** — `feature` `P1`
- [ ] **Cross-project goals: split one goal into tasks across repos** — `feature` `P1`

## M3 · Context handoff & cost tiering

Token-budget-driven fresh-session handoffs, model tiers, escalation ladder, cost ledger.

- [ ] **Epic: Context handoff and cost tiering** — `epic` `P0`
- [ ] **Context usage tracking per session** — `feature` `P0`
- [ ] **Automatic handoff: thresholds, packet generation, validation, reseed** — `feature` `P0`
- [ ] **Conductor & mini-conductor self-handoff** — `feature` `P1`
- [ ] **Model tier policies and per-task overrides** — `feature` `P0`
- [ ] **Escalation ladder: retry with stronger model before asking a human** — `feature` `P1`
- [ ] **Cost ledger + budgets (per task/repo/day)** — `feature` `P1`
- [ ] **Measure orchestration overhead** — `spike` `P1`

## M4 · Visual & terminal UI

Web app (board, inbox, live terminals, cost) and TUI mode.

- [ ] **Epic: Visual and terminal modes** — `epic` `P1`
- [ ] **Web app shell: React + routing + live event stream** — `feature` `P1`
- [ ] **UI: decision inbox** — `feature` `P0`
- [ ] **UI: projects/tasks board and timelines** — `feature` `P1`
- [ ] **UI: live terminals and diffs** — `feature` `P1`
- [ ] **UI: settings and personalization** — `feature` `P2`
- [ ] **TUI mode (Ink)** — `feature` `P1`

## M5 · Channels & workflows

Notifications, chat channels, phone access, non-code workflows and templates.

- [ ] **Epic: Channels and non-code workflows** — `epic` `P2`
- [ ] **Notification channels: OS, email, webhook** — `feature` `P1`
- [ ] **Chat channels: Slack / Discord / Telegram (two-way)** — `feature` `P2`
- [ ] **Remote/phone access (opt-in, Tailscale/tunnel guidance)** — `feature` `P2`
- [ ] **Workflow templates (research, docs, triage, refactor)** — `feature` `P2`
- [ ] **Scheduled and triggered tasks** — `feature` `P2`

## M6 · Ecosystem & hardening

Plugins, A2A/ACP exposure, sandboxing, evals, docs, release.

- [ ] **Plugin system: adapters, channels, tools, workflows** — `feature` `P2`
- [ ] **Expose mini-conductor as an ACP agent (use from Zed/JetBrains/Neovim)** — `feature` `P2`
- [ ] **Expose conductor via A2A** — `feature` `P2`
- [ ] **OS sandboxing for workers (bubblewrap / seatbelt / containers)** — `feature` `P2`
- [ ] **Evaluation harness: escalation quality, handoff fidelity, cost** — `feature` `P1`
- [ ] **Threat model + security review** — `docs` `P1`
- [ ] **Docs site + quickstart + vendor auth/billing guide** — `docs` `P1`
- [ ] **v0.1 release: packaging (npm, Homebrew), installers, changelog** — `chore` `P1`
