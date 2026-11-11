# Roadmap

_Generated from `roadmap/issues.json` by `scripts/gen-roadmap.mjs`. Do not edit by hand. GitHub issues are created with `scripts/create-issues.sh`._

Routing: `copilot` = good for Copilot cloud agent, `claude` = Claude Code, `either` = both, `human` = needs a human decision. See `docs/HYBRID_WORKFLOW.md`.

## M0 · Foundations

Repo, decisions, schemas, spikes. Nothing runs agents yet.

- [ ] **ADR-001: Build standalone vs extend Omnigent vs interop** — `adr` `P0` `claude + human`
- [ ] **ADR-002: Language/runtime (TypeScript on Node vs Bun vs Python)** — `adr` `P0` `claude + human`
- [ ] **ADR-003: Wire protocols (conductor↔mini, UI events, MCP surface)** — `adr` `P0` `claude + human`
- [ ] **Config system: layered YAML (user → repo → local → task)** — `feature` `P0` `copilot`
- [ ] **Core schemas: Task, AgentEvent, Decision, Escalation, HandoffPacket** — `feature` `P0` `claude`
- [ ] **Event log: append-only SQLite store with replay** — `feature` `P0` `copilot`
- [ ] **Human decision: may many parallel Claude Workers run on one subscription?** — `docs` `P1` `claude + human`
- [ ] **Repo scaffold: pnpm monorepo, TS, lint, test, CI** — `chore` `P0` `copilot`
- [ ] **Spike: Claude CLI stream-json input and permission-prompt contract, CLI vs SDK** — `spike` `P0` `claude`
- [ ] **Spike: Codex approval decision enums and turn/interrupt payloads** — `spike` `P0` `claude`
- [ ] **Spike: Gemini CLI stats fields, headless approvals and ACP permission flow** — `spike` `P1` `claude`
- [ ] **Spike: OpenCode event names, permission events and token and cost fields** — `spike` `P2` `claude`
- [ ] **Spike: adapter capability matrix across Claude, Codex, OpenCode, Gemini, ACP** — `spike` `P0` `claude`
- [ ] **Spike: confirm @modelcontextprotocol/server answers 2025-11-25 initialize clients** — `spike` `P0` `claude`
- [ ] **Spike: confirm who publishes the PyPI openai-codex-sdk package** — `spike` `P2` `claude`
- [ ] **Spike: read Codex app-server docs, auth and terms pages from primary sources** — `spike` `P0` `claude`
- [ ] **Spike: verify ACP session semantics (cancel, stdio framing, fork, usage)** — `spike` `P1` `claude`
- [ ] **Spike: verify per-vendor MCP client facts (revisions, config injection, timeouts)** — `spike` `P1` `claude`
- [ ] **Spike: verify the Claude ACP adapter and codex-acp** — `spike` `P1` `claude`
- [ ] **Stop roadmap/issues.json and ROADMAP.md merge conflicts between PRs** — `chore` `P1` `claude`

## M1 · Mini-conductor MVP

One repo, one mini-conductor, real workers via adapters, worktrees, verification. Usable standalone.

- [ ] **Epic: Mini-conductor MVP (standalone, single repo)** — `epic` `P0` `human`
- [ ] **A task reports "completed" when nothing was integrated and verify did not run** — `P1`
- [ ] **ACP adapter: close() after a self-exit must not poll the reaped process group again** — `chore` `P2` `claude`
- [ ] **ACP adapter: discard a Worker session's transcript once it will never be resumed** — `feature` `P2` `claude`
- [ ] **ACP: offer fork when the agent advertises sessionCapabilities.fork** — `feature` `P2` `claude`
- [ ] **ACP: verify API-key-only auth for claude-agent-acp and codex-acp, then register them** — `feature` `P2` `claude`
- [ ] **Adapter: Claude Code (Agent SDK / stream-json)** — `feature` `P0` `claude`
- [ ] **Adapter: Codex app-server (JSON-RPC)** — `feature` `P0` `claude`
- [ ] **Adapter: OpenCode server (HTTP + SSE)** — `feature` `P2` `copilot`
- [ ] **Adapter: PTY + hooks fallback (any CLI)** — `feature` `P1` `claude`
- [ ] **Adapter: generic ACP client** — `feature` `P1` `claude`
- [ ] **Adapters: launch Workers with an environment allowlist** — `feature` `P2` `either`
- [ ] **AgentAdapter interface + conformance test suite** — `feature` `P0` `claude`
- [ ] **Audit every local port Tacet opens: Worker commands reach all of host loopback, so tokens are the only boundary** — `feature` `P1` `claude`
- [ ] **Browser session via hello frame instead of cookie (ADR-003 §3.4 addendum)** — `feature` `P0` `claude`
- [ ] **CLI: tacet run / status / attach / logs (standalone mode)** — `feature` `P1` `claude`
- [ ] **Cap or rotate the background run's log (tacet run --detach)** — `chore` `P3` `either`
- [ ] **Chore: fail CI when capability matrix dates are stale for active surfaces** — `chore` `P2` `claude`
- [ ] **Claude SDK adapter: keep Worker transcripts out of the user's ~/.claude and discard them** — `feature` `P2` `claude`
- [ ] **Claude SDK sessions load the checkout's .claude settings and hooks: set settingSources: []** — `feature` `P0` `claude`
- [ ] **Claude Workers can find a host OAuth token at Claude Code's fixed well-known path** — `feature` `P1` `claude + human`
- [ ] **Claude Workers: turn Bash off at the source and enable Glob/Grep (closes the #200 gaps)** — `feature` `P1` `claude`
- [ ] **Claude's sandbox leaves a .git placeholder skeleton in /tmp (an ancestor or write-allowed dir), and Tacet then takes /tmp for a repo** — `feature` `P2` `claude`
- [ ] **Clean up orphaned Worker processes after a Mini-conductor crash** — `feature` `P1` `claude`
- [ ] **Codex Worker isolation does not hold for a repo under /tmp or $TMPDIR** — `P2` `claude`
- [ ] **Codex Worker isolation: own CODEX_HOME, worktree git dir writable, plugins off** — `feature` `P1` `claude`
- [ ] **Codex Workers on macOS: a private TMPDIR, and sweeping leftover Worker temp dirs** — `feature` `P3` `claude`
- [ ] **Codex Workers: CODEX_HOME, and a repo found without repoRoot, under a sandbox temp dir** — `P2` `claude`
- [ ] **Codex Workers: a private TMPDIR per Worker so a repo under /tmp can be isolated** — `feature` `P3` `claude`
- [ ] **Codex adapter: close() should wait for the whole process group** — `feature` `P2` `claude`
- [ ] **Codex adapter: report a self-exit only once the process group is gone** — `feature` `P2` `claude`
- [ ] **Codex fork keeps the source thread's model** — `feature` `P2` `claude`
- [ ] **Codex in a PTY: a prompt ending in @token is not submitted; check pasted image paths** — `feature` `P2` `claude`
- [ ] **Codex isolation test: commit probe times out at 10s on macOS when git's first run is slow** — `chore` `P3` `either`
- [ ] **Core: modelSwitch 'none' for adapters that cannot choose a model** — `feature` `P2` `claude + human`
- [ ] **Declare resume and fork for claude-acp and codex-acp after a live check** — `feature` `P2` `claude`
- [ ] **Delete a task's pinned-target ref once its result lands** — `feature` `P2` `claude`
- [ ] **Forward events by the ADR-003 §4 allowlist, not a local-namespace denylist** — `feature` `P1` `claude`
- [ ] **Gemini Workers cannot reach the Mini-conductor's MCP tools in an untrusted checkout** — `feature` `P1` `claude + human`
- [ ] **Hold a task's pinned target commit with a ref so git gc cannot prune it** — `feature` `P2` `claude`
- [ ] **Integrate unattended Codex Worker commits from the Mini-conductor** — `feature` `P1` `claude + human`
- [ ] **Keep vendor keys out of Workers' tool subprocesses** — `feature` `P2` `claude`
- [ ] **Linux Claude sandbox leaves empty placeholder files in the Worker checkout and the user's home** — `feature` `P1` `claude`
- [ ] **Local auth module: token file, tacet/hello, Host/Origin checks, one-time-code browser login, per-worker MCP tokens** — `feature` `P0` `claude`
- [ ] **Mini-conductor MCP server (escalate, report_progress, request_handoff, record_decision…)** — `feature` `P0` `either`
- [ ] **Mini-conductor daemon: task queue, planner, worker pool** — `feature` `P0` `either`
- [ ] **Mini-conductor: build Worker adapters from the effective config at startup** — `feature` `P1` `either`
- [ ] **PTY Workers: stop Claude Code cloning the official plugin marketplace at session start** — `feature` `P2` `claude`
- [ ] **PTY adapter credits an interrupted turn's reply to the next turn** — `feature` `P1` `claude`
- [ ] **PTY adapter: clean up per-session Claude config directories** — `feature` `P2` `either`
- [ ] **PTY adapters: don't leave a CLI's detached background processes running** — `feature` `P2` `claude`
- [ ] **PTY presets: use resume_flag and process_name, or drop them** — `feature` `P2` `either`
- [ ] **PTY tests time out under full-suite load, and fail locally without node-gyp** — `chore` `P1` `claude`
- [ ] **Pin a task's target branch so its sub-tasks never start from different branches** — `feature` `P2` `claude`
- [ ] **Prune per-Worker progress state when a Worker token is revoked** — `chore` `P2` `either`
- [ ] **PtyCliAdapter: @path expansion in Gemini, Codex and claude presets** — `feature` `P1` `claude`
- [ ] **Rate-limit escalate and record_decision in the Mini-conductor MCP server** — `feature` `P2` `either`
- [ ] **ReDoS: quadratic fence-stripping regex on reviewer and planner replies** — `feature` `P1` `claude`
- [ ] **Record Mini-conductor maintenance failures as events, and stop re-checking kept checkouts** — `feature` `P2` `claude`
- [ ] **Record crash-placeholder cleanup failures as maintenance problems** — `chore` `P3` `claude`
- [ ] **Remove worktrees automatically once their task's work is merged (setting)** — `feature` `P2` `claude`
- [ ] **Resolve keychain secret references in config** — `feature` `P2` `claude`
- [ ] **Resume in-flight handoffs after a Mini-conductor restart** — `feature` `P2` `either`
- [ ] **Scrub Worker tokens split across streamed message deltas** — `feature` `P2` `either`
- [ ] **Standalone Claude Code handoff plugin (HandoffPacket + fresh session, no daemon)** — `feature` `P1` `claude`
- [ ] **Standalone Mini-conductor control port: status and live attach over ADR-003 §4** — `feature` `P2` `claude`
- [ ] **Start the Claude SDK's Claude Code in a session of its own, and verify #269's terminal assumptions per OS** — `feature` `P2` `claude`
- [ ] **Submodules and nested repos for unattended Codex Workers** — `feature` `P2` `claude + human`
- [ ] **Sweep stale Worker MCP config files at startup** — `feature` `P2` `either`
- [ ] **Track ACP v2: prompt ack + state_update lifecycle** — `spike` `P2` `claude`
- [ ] **Unattended Worker tool policy before #25: let Workers change their own worktree** — `feature` `P1` `claude`
- [ ] **Verification pipeline: commands + reviewer agent** — `feature` `P1` `either`
- [ ] **Verify Claude Code transcript facts behind PTY usage: [1m] model id and subagent calls** — `spike` `P3` `claude`
- [ ] **Verify live how Codex and Gemini CLI scope resume to a worktree** — `spike` `P2` `claude`
- [ ] **Verify that resumed Worker sessions pick up a new MCP URL and token** — `spike` `P1` `claude`
- [ ] **Windows via WSL2: docs, a /mnt/* repo check, and CI inside WSL2** — `feature` `P1` `claude`
- [ ] **Worker job inside Claude's Linux sandbox sometimes not found by its marker after a crash (#127 test flake)** — `feature` `P2` `claude`
- [ ] **Worker tool policy: protect .tacet/ (Tacet's own config) from Worker writes** — `feature` `P1` `claude`
- [ ] **Worker-written code can read the control-port token and answer its own escalation** — `feature` `P1` `claude + human`
- [ ] **Worktree gc by activity, and cleanup of planner checkouts a crash left behind** — `feature` `P2` `claude`
- [ ] **Worktree manager** — `feature` `P0` `copilot`
- [ ] **Worktree manager state into the event log** — `chore` `P2` `either`
- [ ] **Worktree test "keeps no state files" times out at 5s on macOS, then fails cleanup with ENOTEMPTY** — `chore` `P3` `either`
- [ ] **`tacet init` installer for repos** — `feature` `P0` `copilot`
- [ ] **buildWorkerAdapters: pass repoRoot to the Codex adapter** — `feature` `P1` `claude`
- [ ] **claude-agent-acp Workers: route in-checkout reads through the Worker policy (#206 gap)** — `feature` `P2` `claude`
- [ ] **claude-sdk Workers have no commit path, so their work is never integrated** — `P1`
- [ ] **codex-acp Workers trust the checkout: refuse, accept or patch** — `feature` `P1` `claude + human`
- [ ] **pty:claude Workers: an @path in a prompt may read files unasked** — `feature` `P1` `claude`
- [ ] **pty:claude: an image path in a Worker prompt hangs the turn; check pasted-image attachments** — `feature` `P1` `claude`
- [ ] **pty:claude: evaluate permissions.blockReadsOutsideWorkingDirectories as defence in depth for pasted reads** — `chore` `P3` `claude`
- [ ] **tacet cancel <task> in standalone mode** — `feature` `P2` `either`
- [ ] **tacet uninstall --purge: also remove the repo's run state, through the worktree manager** — `feature` `P2` `claude`

## M2 · Conductor & escalation

Global conductor, multi-repo registry, decision inbox, summary packets.

- [ ] **Epic: Conductor and escalation inbox** — `epic` `P0` `human`
- [ ] **Conductor daemon + mini-conductor registry** — `feature` `P0` `either`
- [ ] **Conductor↔mini protocol implementation** — `feature` `P0` `claude`
- [ ] **Cross-project goals: split one goal into tasks across repos** — `feature` `P1` `either`
- [ ] **Decision inbox: dedupe, batch, rank, answer, propagate** — `feature` `P0` `either`
- [ ] **Escalation gate in mini-conductor** — `feature` `P0` `claude`
- [ ] **Expose mini-conductor as an ACP agent (use from Zed/JetBrains/Neovim)** — `feature` `P2` `claude`
- [ ] **Summary packets (no transcripts upward)** — `feature` `P1` `either`
- [ ] **UI custom event schemas (tacet.usage, tacet.escalation, tacet.decision, tacet.budget)** — `feature` `P2` `either`

## M3 · Context handoff & cost tiering

Token-budget-driven fresh-session handoffs, model tiers, escalation ladder, cost ledger.

- [ ] **Epic: Context handoff and cost tiering** — `epic` `P0` `human`
- [ ] **Automatic handoff: thresholds, packet generation, validation, reseed** — `feature` `P0` `claude`
- [ ] **Conductor & mini-conductor self-handoff** — `feature` `P1` `either`
- [ ] **Context usage tracking per session** — `feature` `P0` `either`
- [ ] **Cost ledger + budgets (per task/repo/day)** — `feature` `P1` `copilot`
- [ ] **Escalation ladder: retry with stronger model before asking a human** — `feature` `P1` `either`
- [ ] **Measure orchestration overhead** — `spike` `P1` `claude`
- [ ] **Merge queue: batch-then-bisect for parallel Worker branches** — `feature` `P2` `either`
- [ ] **Model tier policies and per-task overrides** — `feature` `P0` `either`
- [ ] **PTY Workers: context-pressure injection through a UserPromptSubmit hook** — `feature` `P2` `claude`
- [ ] **Per-session model, effort and context-size selection** — `feature` `P1` `claude`

## M4 · Visual & terminal UI

Web app (board, inbox, live terminals, cost) and TUI mode.

- [ ] **Epic: Visual and terminal modes** — `epic` `P1` `human`
- [ ] **TUI mode (Ink)** — `feature` `P1` `copilot`
- [ ] **UI: decision inbox** — `feature` `P0` `either`
- [ ] **UI: live terminals and diffs** — `feature` `P1` `either`
- [ ] **UI: projects/tasks board and timelines** — `feature` `P1` `either`
- [ ] **UI: settings and personalization** — `feature` `P2` `copilot`
- [ ] **Web app shell: React + routing + live event stream** — `feature` `P1` `copilot`

## M5 · Channels & workflows

Notifications, chat channels, phone access, non-code workflows and templates.

- [ ] **Epic: Channels and non-code workflows** — `epic` `P2` `human`
- [ ] **Chat channels: Slack / Discord / Telegram (two-way)** — `feature` `P2` `either`
- [ ] **Notification channels: OS, email, webhook** — `feature` `P1` `copilot`
- [ ] **Remote/phone access (opt-in, Tailscale/tunnel guidance)** — `feature` `P2` `either`
- [ ] **Scheduled and triggered tasks** — `feature` `P2` `copilot`
- [ ] **Workflow templates (research, docs, triage, refactor)** — `feature` `P2` `either`

## M6 · Ecosystem & hardening

Plugins, A2A/ACP exposure, sandboxing, evals, docs, release.

- [ ] **Native Windows support (after the ADR)** — `epic` `P2` `claude + human`
- [ ] **ADR: native Windows support** — `adr` `P2` `claude + human`
- [ ] **Docs site + quickstart + vendor auth/billing guide** — `docs` `P1` `either + human`
- [ ] **Evaluation harness: escalation quality, handoff fidelity, cost** — `feature` `P1` `either`
- [ ] **Expose conductor via A2A** — `feature` `P2` `claude`
- [ ] **OS sandboxing for workers (bubblewrap / seatbelt / containers)** — `feature` `P2` `either`
- [ ] **Plugin system: adapters, channels, tools, workflows** — `feature` `P2` `either`
- [ ] **Re-check Bun when oven-sh/bun#25822 closes** — `spike` `P2` `claude`
- [ ] **Threat model + security review** — `docs` `P1` `claude + human`
- [ ] **v0.1 release: packaging (npm, Homebrew), installers, changelog** — `chore` `P1` `copilot`
