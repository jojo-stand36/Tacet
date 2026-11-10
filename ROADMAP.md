# Roadmap

_Generated from `roadmap/issues.json` by `scripts/gen-roadmap.mjs`. Do not edit by hand. GitHub issues are created with `scripts/create-issues.sh`._

Routing: `copilot` = good for Copilot cloud agent, `claude` = Claude Code, `either` = both, `human` = needs a human decision. See `docs/HYBRID_WORKFLOW.md`.

## M0 · Foundations

Repo, decisions, schemas, spikes. Nothing runs agents yet.

- [ ] **Repo scaffold: pnpm monorepo, TS, lint, test, CI** — `chore` `P0` `copilot`
- [ ] **ADR-001: Build standalone vs extend Omnigent vs interop** — `adr` `P0` `claude + human`
- [ ] **ADR-002: Language/runtime (TypeScript on Node vs Bun vs Python)** — `adr` `P0` `claude + human`
- [ ] **ADR-003: Wire protocols (conductor↔mini, UI events, MCP surface)** — `adr` `P0` `claude + human`
- [ ] **Core schemas: Task, AgentEvent, Decision, Escalation, HandoffPacket** — `feature` `P0` `claude`
- [ ] **Event log: append-only SQLite store with replay** — `feature` `P0` `copilot`
- [ ] **Config system: layered YAML (user → repo → local → task)** — `feature` `P0` `copilot`
- [ ] **Spike: adapter capability matrix across Claude, Codex, OpenCode, Gemini, ACP** — `spike` `P0` `claude`
- [ ] **Spike: Codex approval decision enums and turn/interrupt payloads** — `spike` `P0` `claude`
- [ ] **Spike: read Codex app-server docs, auth and terms pages from primary sources** — `spike` `P0` `claude`
- [ ] **Spike: OpenCode event names, permission events and token and cost fields** — `spike` `P2` `claude`
- [ ] **Spike: verify ACP session semantics (cancel, stdio framing, fork, usage)** — `spike` `P1` `claude`
- [ ] **Spike: verify the Claude ACP adapter and codex-acp** — `spike` `P1` `claude`
- [ ] **Spike: Gemini CLI stats fields, headless approvals and ACP permission flow** — `spike` `P1` `claude`
- [ ] **Spike: Claude CLI stream-json input and permission-prompt contract, CLI vs SDK** — `spike` `P0` `claude`
- [ ] **Human decision: may many parallel Claude Workers run on one subscription?** — `docs` `P1` `claude + human`
- [ ] **Spike: confirm who publishes the PyPI openai-codex-sdk package** — `spike` `P2` `claude`
- [ ] **Spike: verify per-vendor MCP client facts (revisions, config injection, timeouts)** — `spike` `P1` `claude`
- [ ] **Spike: confirm @modelcontextprotocol/server answers 2025-11-25 initialize clients** — `spike` `P0` `claude`

## M1 · Mini-conductor MVP

One repo, one mini-conductor, real workers via adapters, worktrees, verification. Usable standalone.

- [ ] **Epic: Mini-conductor MVP (standalone, single repo)** — `epic` `P0` `human`
- [ ] **AgentAdapter interface + conformance test suite** — `feature` `P0` `claude`
- [ ] **Adapter: Claude Code (Agent SDK / stream-json)** — `feature` `P0` `claude`
- [ ] **Adapter: Codex app-server (JSON-RPC)** — `feature` `P0` `claude`
- [ ] **Adapter: generic ACP client** — `feature` `P1` `claude`
- [ ] **Adapter: OpenCode server (HTTP + SSE)** — `feature` `P2` `copilot`
- [ ] **Adapter: PTY + hooks fallback (any CLI)** — `feature` `P1` `claude`
- [ ] **Worktree manager** — `feature` `P0` `copilot`
- [ ] **Mini-conductor daemon: task queue, planner, worker pool** — `feature` `P0` `either`
- [ ] **Mini-conductor MCP server (escalate, report_progress, request_handoff, record_decision…)** — `feature` `P0` `either`
- [ ] **Verification pipeline: commands + reviewer agent** — `feature` `P1` `either`
- [ ] **`tacet init` installer for repos** — `feature` `P0` `copilot`
- [ ] **CLI: tacet run / status / attach / logs (standalone mode)** — `feature` `P1` `claude`
- [ ] **Chore: fail CI when capability matrix dates are stale for active surfaces** — `chore` `P2` `claude`
- [ ] **Local auth module: token file, tacet/hello, Host/Origin checks, one-time-code browser login, per-worker MCP tokens** — `feature` `P0` `claude`
- [ ] **Track ACP v2: prompt ack + state_update lifecycle** — `spike` `P2` `claude`
- [ ] **Browser session via hello frame instead of cookie (ADR-003 §3.4 addendum)** — `feature` `P0` `claude`
- [ ] **Standalone Claude Code handoff plugin (HandoffPacket + fresh session, no daemon)** — `feature` `P1` `claude`
- [ ] **Sweep stale Worker MCP config files at startup** — `feature` `P2` `either`
- [ ] **Scrub Worker tokens split across streamed message deltas** — `feature` `P2` `either`
- [ ] **Codex Worker isolation: own CODEX_HOME, worktree git dir writable, plugins off** — `feature` `P1` `claude`
- [ ] **Integrate unattended Codex Worker commits from the Mini-conductor** — `feature` `P1` `claude + human`
- [ ] **Submodules and nested repos for unattended Codex Workers** — `feature` `P2` `claude + human`
- [ ] **Rate-limit escalate and record_decision in the Mini-conductor MCP server** — `feature` `P2` `either`
- [ ] **Prune per-Worker progress state when a Worker token is revoked** — `chore` `P2` `either`
- [ ] **Worktree manager state into the event log** — `chore` `P2` `either`
- [ ] **Clean up orphaned Worker processes after a Mini-conductor crash** — `feature` `P1` `claude`
- [ ] **Verify that resumed Worker sessions pick up a new MCP URL and token** — `spike` `P1` `claude`
- [ ] **Resume in-flight handoffs after a Mini-conductor restart** — `feature` `P2` `either`
- [ ] **ACP: verify API-key-only auth for claude-agent-acp and codex-acp, then register them** — `feature` `P2` `claude`
- [ ] **ACP: offer fork when the agent advertises sessionCapabilities.fork** — `feature` `P2` `claude`
- [ ] **Adapters: launch Workers with an environment allowlist** — `feature` `P2` `either`
- [ ] **Mini-conductor: build Worker adapters from the effective config at startup** — `feature` `P1` `either`
- [ ] **Keep vendor keys out of Workers' tool subprocesses** — `feature` `P2` `claude`
- [ ] **PTY adapter: clean up per-session Claude config directories** — `feature` `P2` `either`
- [ ] **PTY presets: use resume_flag and process_name, or drop them** — `feature` `P2` `either`
- [ ] **Core: modelSwitch 'none' for adapters that cannot choose a model** — `feature` `P2` `claude + human`
- [ ] **Resolve keychain secret references in config** — `feature` `P2` `claude`
- [ ] **Verify live how Codex and Gemini CLI scope resume to a worktree** — `spike` `P2` `claude`
- [ ] **PTY adapters: don't leave a CLI's detached background processes running** — `feature` `P2` `claude`
- [ ] **Codex fork keeps the source thread's model** — `feature` `P2` `claude`
- [ ] **buildWorkerAdapters: pass repoRoot to the Codex adapter** — `feature` `P1` `claude`
- [ ] **codex-acp Workers trust the checkout: refuse, accept or patch** — `feature` `P1` `claude + human`
- [ ] **Gemini Workers cannot reach the Mini-conductor's MCP tools in an untrusted checkout** — `feature` `P1` `claude + human`
- [ ] **Unattended Worker tool policy before #25: let Workers change their own worktree** — `feature` `P1` `claude + human`
- [ ] **Standalone Mini-conductor control port: status and live attach over ADR-003 §4** — `feature` `P2` `claude`
- [ ] **tacet cancel <task> in standalone mode** — `feature` `P2` `either`

## M2 · Conductor & escalation

Global conductor, multi-repo registry, decision inbox, summary packets.

- [ ] **Epic: Conductor and escalation inbox** — `epic` `P0` `human`
- [ ] **Conductor daemon + mini-conductor registry** — `feature` `P0` `either`
- [ ] **Conductor↔mini protocol implementation** — `feature` `P0` `claude`
- [ ] **Escalation gate in mini-conductor** — `feature` `P0` `claude`
- [ ] **Decision inbox: dedupe, batch, rank, answer, propagate** — `feature` `P0` `either`
- [ ] **Summary packets (no transcripts upward)** — `feature` `P1` `either`
- [ ] **Cross-project goals: split one goal into tasks across repos** — `feature` `P1` `either`
- [ ] **Expose mini-conductor as an ACP agent (use from Zed/JetBrains/Neovim)** — `feature` `P2` `claude`
- [ ] **UI custom event schemas (tacet.usage, tacet.escalation, tacet.decision, tacet.budget)** — `feature` `P2` `either`

## M3 · Context handoff & cost tiering

Token-budget-driven fresh-session handoffs, model tiers, escalation ladder, cost ledger.

- [ ] **Epic: Context handoff and cost tiering** — `epic` `P0` `human`
- [ ] **Context usage tracking per session** — `feature` `P0` `either`
- [ ] **Automatic handoff: thresholds, packet generation, validation, reseed** — `feature` `P0` `claude`
- [ ] **Conductor & mini-conductor self-handoff** — `feature` `P1` `either`
- [ ] **Model tier policies and per-task overrides** — `feature` `P0` `either`
- [ ] **Escalation ladder: retry with stronger model before asking a human** — `feature` `P1` `either`
- [ ] **Cost ledger + budgets (per task/repo/day)** — `feature` `P1` `copilot`
- [ ] **Measure orchestration overhead** — `spike` `P1` `claude`
- [ ] **Merge queue: batch-then-bisect for parallel Worker branches** — `feature` `P2` `either`
- [ ] **Per-session model, effort and context-size selection** — `feature` `P1` `claude`

## M4 · Visual & terminal UI

Web app (board, inbox, live terminals, cost) and TUI mode.

- [ ] **Epic: Visual and terminal modes** — `epic` `P1` `human`
- [ ] **Web app shell: React + routing + live event stream** — `feature` `P1` `copilot`
- [ ] **UI: decision inbox** — `feature` `P0` `either`
- [ ] **UI: projects/tasks board and timelines** — `feature` `P1` `either`
- [ ] **UI: live terminals and diffs** — `feature` `P1` `either`
- [ ] **UI: settings and personalization** — `feature` `P2` `copilot`
- [ ] **TUI mode (Ink)** — `feature` `P1` `copilot`

## M5 · Channels & workflows

Notifications, chat channels, phone access, non-code workflows and templates.

- [ ] **Epic: Channels and non-code workflows** — `epic` `P2` `human`
- [ ] **Notification channels: OS, email, webhook** — `feature` `P1` `copilot`
- [ ] **Chat channels: Slack / Discord / Telegram (two-way)** — `feature` `P2` `either`
- [ ] **Remote/phone access (opt-in, Tailscale/tunnel guidance)** — `feature` `P2` `either`
- [ ] **Workflow templates (research, docs, triage, refactor)** — `feature` `P2` `either`
- [ ] **Scheduled and triggered tasks** — `feature` `P2` `copilot`

## M6 · Ecosystem & hardening

Plugins, A2A/ACP exposure, sandboxing, evals, docs, release.

- [ ] **Plugin system: adapters, channels, tools, workflows** — `feature` `P2` `either`
- [ ] **Expose conductor via A2A** — `feature` `P2` `claude`
- [ ] **OS sandboxing for workers (bubblewrap / seatbelt / containers)** — `feature` `P2` `either`
- [ ] **Evaluation harness: escalation quality, handoff fidelity, cost** — `feature` `P1` `either`
- [ ] **Threat model + security review** — `docs` `P1` `claude + human`
- [ ] **Docs site + quickstart + vendor auth/billing guide** — `docs` `P1` `either + human`
- [ ] **v0.1 release: packaging (npm, Homebrew), installers, changelog** — `chore` `P1` `copilot`
- [ ] **Re-check Bun when oven-sh/bun#25822 closes** — `spike` `P2` `claude`
