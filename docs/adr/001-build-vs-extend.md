# ADR-001: Build standalone vs extend Omnigent vs interop

- Status: proposed
- Date: 2026-11-09

Resolves issue #2. Decides `docs/RESEARCH.md` §9. ADR-002 (language and runtime) is held until this ADR is decided. ADR-003 (wire protocols) is treated here as accepted, as the owner instructed.

## Context

We need to decide whether Tacet owns its core (the Mini-conductor, the escalation gate and inbox, and handoffs), builds them as extensions of an existing orchestrator, or does both. The decision sets the language (ADR-002), the license posture, and the integration work for every M1 issue.

### How this ADR was researched

The owner asked for **desk research first, "to see what we can bring over"**. No tool in this ADR was installed or run. The issue #2 tasks "Run Omnigent locally…" and "Run Gas Town on a toy repo…" are **not done**. Consequences lists them as a follow-up spike.

Evidence comes from read-only shallow clones of each project's GitHub repo, read on 2026-11-09:

| Project | Repo and commit read | Latest commit |
|---|---|---|
| Omnigent | https://github.com/omnigent-ai/omnigent @ `6574c55` | 2026-11-09 |
| Gas Town | https://github.com/gastownhall/gastown @ `466aa41` (Go module path still `github.com/steveyegge/gastown`) | 2026-10-28 |
| Gas City (Gas Town's successor) | https://github.com/gastownhall/gascity @ `862ee37` | 2026-11-09 |
| Beads (Gas Town/City task store) | https://github.com/gastownhall/beads @ `3282b97` | 2026-11-09 |
| Vibe Kanban | https://github.com/BloopAI/vibe-kanban @ `ad41bda` | 2026-11-09 |
| Claude Code Agent Teams | https://code.claude.com/docs/en/agent-teams.md | n/a |

**Unreachable (UNVERIFIED):** the session's proxy blocked `omnigent.ai`, `gastown.dev`, `docs.gascity.com` and `formulae.brew.sh`, and the GitHub REST API for these repos. Star counts, open-issue counts and anything that only appears on those sites are therefore UNVERIFIED. The figures in RESEARCH.md §2.2 (Omnigent ~10k stars, Gas Town ~17k) were not re-checked. PyPI was reachable.

### Platform and protocol constraints (owner input)

- Targets are **macOS and Linux (Ubuntu) only**. There is no Windows target.
- ADR-002 proposes **TypeScript on Node 24, no Bun**. Building on Omnigent would mean Python.
- ADR-003's protocols are accepted: A2A-shaped JSON-RPC over a loopback WebSocket (Conductor↔Mini), an AG-UI subset (UI), and an MCP server for Workers. All local servers require a token, even on loopback (ADR-003 §3).

### Prior art: verified facts

#### Omnigent

| Fact | Source (checked 2026-11-09) |
|---|---|
| Describes itself as an "open-source **meta-harness**" over Claude Code, Codex, Cursor, OpenCode, Goose, Antigravity, Copilot, Devin, Kiro, Qwen, Kimi, Grok Build, Jcode, Hermes, Pi, OpenAI Agents and custom agents. Status badge says **alpha**. | `README.md` |
| License **Apache-2.0**, copyright **Databricks, Inc.** (`NOTICE`). Contributions need a DCO sign-off. The default installer also installs Databricks support and the Databricks CLI; `--no-databricks` opts out. | `LICENSE`, `NOTICE`, `DCO`, `README.md` §Install |
| Python `>=3.12` (`pyproject.toml`, version `0.22.0.dev0`). Classifier: "Development Status :: 3 - Alpha". Ships a large TS/React web app, plus Electron, iOS and Android shells. Roughly 596k lines of Python under `omnigent/` and 505k lines of TS/TSX under `web/` (line counts include tests). | `pyproject.toml`, `web/` |
| Activity: PyPI `omnigent` 0.21.0 was released 2026-11-05. There are 46 PyPI releases since 0.0.1rc1 on 2026-06-09. 50 commits landed between 2026-10-09 and 2026-11-09, and PR numbers in the changelog pass #11000. A bot (`omni-resolve-agent[bot]`) authors many fixes. The changelog has breaking harness changes in minor releases (for example, OpenCode 1.x support dropped in 0.21.0). | https://pypi.org/pypi/omnigent/json, `CHANGELOG.md` |
| Architecture: a **server** (Starlette/uvicorn, REST `/api/agents`, `/v1/sessions`, `/v1/conversations`), **hosts/runners** that execute harnesses, a **runtime** library, and **sessions** as the unit of work. An agent is a YAML file with an `executor.harness`, tools (Python functions, MCP servers) and sub-agents. Supervisor agents can spawn child sessions (`spawn: true` registers `sys_session_create`). | `omnigent/server/API.md`, `omnigent/runtime/README.md`, `docs/AGENT_YAML_SPEC.md`, `examples/polly/config.yaml` |
| **Policies:** ALLOW / DENY / ASK verdicts at three levels (session first, then agent spec, then server). Builtins include cost budgets with soft thresholds, tool-call caps and ask-on-shell. Inline CEL expressions are supported. Policies are Python handlers. | `docs/POLICIES.md`, `omnigent/policies/builtins/{cost,safety,cel,routing,risk_score}.py` |
| **Harness test bench:** an executable conformance suite. Probes run live turns and reconcile what a harness does with the capability flags it declares. A mismatch gives a `DRIFT` verdict. Probes: basic turn, streaming, tool calling, interrupt, policy allow/ask/deny, cost tracking, fork/replay, model override, reasoning, MCP. | `docs/harness-bench-design.md`, `tests/harness_bench/probes/` |
| **Extension points:** harness plugins via the Python entry-point group `omnigent.community.harness` (`HarnessContribution`); policy modules; MCP tools; `acp:<slug>` custom ACP agents; extensions and sandbox providers. We found no extension point that lets a plugin replace the session or supervisor model itself. | `designs/harness-plugin-interface.md`, `docs/extending/`, `docs/AGENT_YAML_SPEC.md` §Custom ACP agents |
| **ACP client, not ACP server:** `harness: acp:<slug>` runs any ACP server command, and passes Omnigent's MCP tools to it through per-session `mcpServers` unless `omnigent_mcp: false`. The OpenClaw gateway is integrated this way. We found no code that exposes Omnigent itself as an ACP agent, and no A2A support (`grep a2a` finds nothing). | `docs/AGENT_YAML_SPEC.md` L410–445, `docs/openclaw.md`, `omnigent/acp_cli_harnesses.py` |
| Agent YAML MCP tools accept a remote `url` with `headers` (for example `Authorization: Bearer ${TOKEN}`). | `docs/AGENT_YAML_SPEC.md` L825–840 |
| **Handoff and context:** Omnigent tracks each harness's own compaction boundary when importing sessions (Claude `isCompactSummary`, Codex `compacted` records). It has no budget-driven fresh-session handoff. "handoffs" in the agent spec means OpenAI-Agents-style agent handoffs. | `docs/session-compaction.md`, `docs/AGENT_YAML_SPEC.md` |
| **Security posture:** `omnigent server --host` defaults to `127.0.0.1`. On loopback, single-user mode has **no auth** (requests fall back to a reserved `"local"` user), and multi-user auth is opt-in (`OMNIGENT_AUTH_ENABLED=1`). Usage **telemetry is on by default**, with opt-out. | `omnigent/cli.py` (`--host` default), `omnigent/server/auth.py` L875–890, `README.md` §Telemetry, `editors/vscode/README.md` |
| Platforms: macOS and Linux fully supported. Native wrappers need `tmux`, and Linux needs `bubblewrap`. Windows is "degraded". | `README.md` §Prerequisites, §Windows |
| Auth: supports API keys, gateways, and Claude/ChatGPT subscriptions "via the official `claude` / `codex` CLIs" (it launches the vendor binary, which is consistent with Tacet's hard rule). | `README.md` §3 |

#### Gas Town and Gas City

| Fact | Source (checked 2026-11-09) |
|---|---|
| Gas Town: **MIT** (© 2025 Steve Yegge), Go 1.26, ~475k lines of Go. Roles: Mayor (town coordinator), Rigs (one per repo), Polecats (persistent identity, ephemeral sessions, worktrees), Witness (per-rig monitor), Deacon/Dogs (watchdogs), Refinery (merge queue), Crew. Work lives in Beads (Dolt-backed). | `LICENSE`, `go.mod`, `README.md`, `docs/glossary.md` |
| Gas Town activity is **slowing**. The last release is 1.2.1 (2026-06-06). Only 8 commits landed from 2026-10-09 to 2026-11-09, and the last was 2026-10-28. The docs say "**Gas Town is being succeeded by Gas City**". | `CHANGELOG.md`, `git log`, `docs/agent-provider-integration.md` §Gas City Provider Contract |
| Gas Town integrates agents mainly through **tmux** (`send-keys`, `capture-pane`), with four tiers: zero, JSON preset (`agents.json`), hooks, and deep. Presets exist for claude, gemini, codex, kiro, cursor, auggie, amp, opencode, copilot, pi and omp. | `docs/agent-provider-integration.md`, `README.md` §Runtime Configuration |
| **Escalation:** `gt escalate -s CRITICAL\|HIGH\|MEDIUM`. Each tier (Deacon → Mayor → Overseer) either resolves or forwards. Escalations are tracked as beads. Each severity has its own routes (bead, mail, email, SMS, Slack). Stale escalations re-escalate after `stale_threshold: 4h`, up to `max_reescalations: 2`. | `docs/design/escalation.md` |
| **Handoff:** `gt handoff` cycles a session for any role. The successor gets a handoff mail with `## Context / ## Status / ## Next` and the attached molecule id. `gt seance` lets an agent query a predecessor session. | `docs/design/mail-protocol.md` §HANDOFF, `internal/cmd/handoff.go`, `internal/cmd/seance.go` |
| **Merge queue:** the Refinery uses a Bors-style batch-then-bisect queue with verification gates. | `docs/design/architecture.md` §Merge Queue |
| **ACP exposure:** `gt mayor acp` runs the Mayor headless over stdio for IDEs. It is an ACP proxy that injects "propulsion" prompts (`internal/acp/proxy.go`, `propulsion.go`). The command help text calls the protocol "Agent Control Protocol", but the code speaks Agent Client Protocol JSON-RPC (`initialize`, `session/new`). | `internal/cmd/mayor.go` L93–112, `internal/acp/` |
| Gas City: **MIT** (© 2026 Gas City Contributors), "stewarded by Gas City, Inc.", Go 1.27, Bazel build, ~2.9M lines of Go including tests. Very active: 30 of the last 30 cloned commits are within the last month, and the latest release is 1.5.1 (2026-10-24). macOS and Linux via Homebrew. It needs tmux, jq, and `dolt` + `bd` unless the file-based beads provider is selected. | `LICENSE`, `README.md`, `CHANGELOG.md` |
| Gas City runtimes: `tmux`, `subprocess`, `acp`, Kubernetes, and `exec:<script>` through a versioned **Runtime Provider Protocol** (RPP v0). It has an HTTP **Supervisor API** (OpenAPI `0.1.0`, 137 paths, dashboard on `127.0.0.1:8372`), formulas, orders (scheduled or triggered), a context-pressure injector that tells an agent when to run `gc handoff` (`cmd/gc/context_inject.go`), and `internal/modelwindow` (model id → context window). | `internal/runtime/REQUIREMENTS.md`, `docs/reference/schema/openapi.json`, `docs/reference/config.md` §ACPSessionConfig, `docs/reference/cli.md` §gc handoff |
| Neither Gas Town nor Gas City speaks A2A; we found no A2A references in the docs. | repo grep |

#### Other prior art named in RESEARCH.md

| Project | Fact | Source (checked 2026-11-09) |
|---|---|---|
| Claude Code Agent Teams | Experimental and off by default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). "One team per session", "No nested teams", and token cost scales linearly with teammates. | https://code.claude.com/docs/en/agent-teams.md §Limitations, §Token usage |
| Vibe Kanban | Apache-2.0, Rust + TS. The README headline says "**Vibe Kanban is sunsetting**". It still gets commits (5 in the last month). Crates include `executors`, `worktree-manager`, `mcp` and `review`. | `README.md`, `LICENSE`, `crates/` |

### What we can bring over

"Borrow idea" means reimplement in TypeScript from the design. "Port code" means a close translation of their code, which needs attribution (Apache-2.0 requires keeping the license and NOTICE text; MIT requires keeping the copyright notice). "Interop" means talking to the running project over a protocol. Tacet's own license is still open (#1), and Apache-2.0 would make any Omnigent port simplest.

#### From Omnigent (Apache-2.0)

| Idea or component | Where in their repo | Borrow / port / interop | Tacet issue or package |
|---|---|---|---|
| Harness test bench: capability probes, declared-vs-observed `DRIFT` verdicts, P0 probes gate CI and P1 probes only report | `docs/harness-bench-design.md`, `tests/harness_bench/probes/*.py` | **Borrow the idea**, and use the probe list as our conformance checklist. Their probes are Python against their server, so porting them gains little. | #10 conformance suite (`@tacet/core` test kit), #8 capability matrix |
| Capability flags on the executor (`supports_streaming`, live message queue, tool-boundary interrupt…) | `omnigent/inner/executor.py` | Borrow the idea and extend `AdapterCapabilities` | #10, `@tacet/core` |
| Three-level policy model (session > agent > server) with ALLOW/DENY/ASK, where DENY short-circuits | `docs/POLICIES.md`, `omnigent/policies/` | Borrow the idea. Map it onto task > repo `.tacet/` > user config. ASK becomes an escalation. | #25 escalation gate, #7 config |
| Cost budget with soft `ask_thresholds_usd` and a hard cap | `omnigent/policies/builtins/cost.py` | Borrow the idea | #35 cost ledger + budgets |
| CEL for side-effect-free inline policy rules | `omnigent/policies/builtins/cel.py` | Borrow the idea later. A TS CEL implementation would be a new dependency to justify. | #25 (M2+), #50 |
| Polly's pattern: the tech lead writes no code, delegates to Workers in worktrees, and sends review to a different vendor | `examples/polly/config.yaml` | Borrow the prompt design | #17 mini planner, #19 verification (cross-vendor review) |
| Compaction-boundary detection (Claude `isCompactSummary`, Codex `compacted.replacement_history`) | `docs/session-compaction.md`, `omnigent/harnesses/claude_native/bridge.py` | Borrow the idea | #30 context usage tracking (signal that compaction happened anyway), #31 |
| Native tmux/PTY wrappers in an OS sandbox (`bwrap` on Linux, `seatbelt` on macOS) | `README.md` §Prerequisites, `omnigent/sandbox/` | Borrow the idea | #15 PTY adapter, #53 sandboxing |
| Harness plugin contract (`HarnessContribution`: ids, aliases, install/login hints, labels) | `designs/harness-plugin-interface.md` | Borrow the shape for adapter packages | #50 plugin system, `@tacet/adapter-*` |
| Generic `acp:<slug>` registry in user config | `docs/AGENT_YAML_SPEC.md` §Custom ACP agents | Borrow the idea | #13 ACP adapter, #7 config |
| Clean uninstall design (preview first, `--purge` with backup) | `docs/UNINSTALL_DESIGN.md`, `README.md` §Uninstalling | Borrow the idea. Gas Town is criticised for being hard to remove. | #20 `tacet init` (and a matching `tacet uninstall`) |
| Driving Tacet from Omnigent: register a Mini-conductor as `acp:tacet` | `docs/AGENT_YAML_SPEC.md` L410–445, `docs/openclaw.md` (same pattern) | **Interop** | #51 expose mini as ACP agent |
| Omnigent agents calling Tacet's MCP tools (`escalate`, `request_handoff`…) as an MCP `url` with a bearer header | `docs/AGENT_YAML_SPEC.md` L825–840 | **Interop** | #18 MCP server (token scoping per ADR-003 §6) |
| Tacet driving an Omnigent session as a Worker through its REST `/v1/sessions` | `omnigent/server/API.md` | **Interop**, later. Optional adapter. | New follow-up (P2), `@tacet/adapter-omnigent` |

#### From Gas Town and Gas City (MIT)

| Idea or component | Where in their repo | Borrow / port / interop | Tacet issue or package |
|---|---|---|---|
| Severity-routed escalation where each tier resolves or forwards; stale re-escalation (`4h`, max 2); per-severity notification routes | gastown `docs/design/escalation.md` | **Borrow the idea.** It matches our gate → inbox flow; add `stale_after` and `max_reescalations` to the escalation schema. | #25 escalation gate, #26 decision inbox, #45 notification channels, #5 core schemas |
| Escalation categories (`decision`, `help`, `blocked`, `failed`, `emergency`, `gate_timeout`, `lifecycle`) | same, §Category Routing | Borrow as an optional `category` field | #5 core schemas |
| Handoff mail (`Context / Status / Next` plus the attached work id) | gastown `docs/design/mail-protocol.md` §HANDOFF | Borrow as evidence for our typed HandoffPacket (`nextAction` stays required) | #31 automatic handoff |
| Context-pressure injection: compute usage from the transcript in a `UserPromptSubmit` hook and inject one line of guidance; model id → window table | gascity `cmd/gc/context_inject.go`, `internal/modelwindow/` | **Borrow the idea.** Porting `modelwindow` is possible (MIT) but small, so re-derive it from vendor docs. | #30 context usage, #31, #15 PTY+hooks fallback |
| `gt seance`: a new session asks a predecessor session a question | gastown `internal/cmd/seance.go` | Borrow the idea for when the HandoffPacket is not enough | #31, #32 self-handoff (M3+) |
| Witness / heartbeat stuck-worker detection with nudge-or-handoff recovery | gastown `docs/concepts/heartbeats.md`, README §Witness | Borrow the idea. Use one heartbeat store, not three (their docs record bugs from having three). | #17 worker pool health |
| Scheduler capacity governor (`max_polecats`) | gastown `docs/design/scheduler.md` | Borrow the idea | #17, #33 tier policies |
| Refinery batch-then-bisect merge queue with verification gates | gastown `docs/design/architecture.md` §Merge Queue | Borrow the idea later | New follow-up (M3+), relates to #19 |
| Agent presets as JSON (launch command, ready prompt, resume flag, process name) for tier-0/1 CLIs | gastown `docs/agent-provider-integration.md` §Tier 1 | **Borrow the schema.** It is exactly what the PTY adapter needs per CLI. | #15 PTY adapter, #7 config |
| Gas City `AgentProvider` interface (Start / IsReady / SendMessage / GetStatus / InjectContext / Resume / Fork / Exec / GetUsage) and runtime `REQUIREMENTS.md` scenario ledger | gastown `docs/agent-provider-integration.md`, gascity `internal/runtime/REQUIREMENTS.md`, `internal/runtime/fake_conformance_test.go` | Borrow as a cross-check of `AgentAdapter`. Add `isReady` and `injectContext` if they are missing. | #10 |
| Formulas (TOML workflow graphs) and orders (scheduled or triggered) | gascity `README.md`, `docs/` | Borrow the idea later | #48 workflow templates, #49 scheduled tasks |
| Mayor over ACP for IDEs (headless proxy) | gastown `internal/acp/proxy.go`, `internal/cmd/mayor.go` | Prior art for the same feature | #51 |
| Tacet as a Gas City worker: a Mini-conductor started by Gas City's `acp` session provider, or by `exec:` RPP | gascity `docs/reference/config.md` §ACPSessionConfig, `internal/runtime/REQUIREMENTS.md` | **Interop** (needs #51) | #51 |
| Tacet driving Gas City through the Supervisor API (sling a bead, read status) | gascity `docs/reference/schema/openapi.json` | **Interop**, later. Optional adapter. | New follow-up (P2), `@tacet/adapter-gascity` |
| Beads as the task store | gastown/beads | **Do not adopt.** It needs Dolt and a Go binary, and Tacet's store is the SQLite event log (#6). An import/export bridge is possible later. | (none) |

#### From the others

| Idea | Source | Use | Tacet issue |
|---|---|---|---|
| Agent Teams as a Worker backend: one Claude Worker can be a team lead | code.claude.com agent-teams doc | Interop through the Claude adapter, behind a capability flag; count its token multiplier | #11, #36 measure overhead |
| Vibe Kanban worktree manager and executor crates (Apache-2.0, Rust) | `crates/worktree-manager`, `crates/executors` | Borrow ideas only (different language, and the project is sunsetting) | #16 worktree manager |

### Costs of building on each project

| | Omnigent (option B) | Gas Town / Gas City (option B′) |
|---|---|---|
| Language | Python 3.12 core plus its own TS web app. Tacet would become Python + TS, ADR-002 would be reopened, and `@tacet/core` "shared types" would be duplicated across languages. | Go, a third language and toolchain (Gas City uses Bazel and CGO via Dolt/ICU). |
| Fit to Tacet's model | One supervisor per session, plus child sessions. There is no persistent per-repo middle tier, no cross-repo inbox and no budget-driven handoff. We would build all three inside someone else's session model, with no plugin seam for it: plugins cover harnesses, policies and tools, not orchestration. | Close to the two-tier model (Mayor/Town ≈ Conductor, Rig + Witness ≈ Mini-conductor), but the vocabulary is opinionated, tmux is central, and Dolt is the default store. |
| Lock-in / governance | Corporate-led (Databricks copyright, DCO), with Databricks integration in the default install. Upstream priorities are cloud sandboxes, teams and the Databricks platform. | Gas Town is being replaced by Gas City. Gas City is led by Gas City, Inc. Building on Gas Town means building on a predecessor. |
| Maintenance risk | Very high churn: 46 releases in 5 months, breaking harness changes in minors, alpha status. A fork would diverge fast. Tracking upstream means following a ~600k-line Python codebase. | Gas City also churns fast (2.9M lines of Go, a v0 API). Gas Town is near-frozen. |
| Hard rules | Loopback runs without auth by default, and telemetry is on by default. Both conflict with ADR-003 §3 and with local-first defaults. We would have to patch or configure around them and keep re-checking after each upgrade. | The dashboard is on loopback (auth posture UNVERIFIED). tmux `send-keys` is the default transport, which ranks below our tier-1 adapters. |
| Platforms | macOS/Linux fine (owner target). | macOS/Linux fine. |
| Reversal cost | High: a rewrite out of Python. | High: a rewrite out of Go. |

### Drivers

| Driver | A. Standalone, borrow ideas | B. Build on Omnigent | C. Standalone + interop (recommended) |
|---|---|---|---|
| Harness-agnostic | Our adapters (#11–#15) | Best on day one: about 18 harnesses | Our adapters, plus Omnigent and Gas City can drive Tacet over ACP, and their agents can call our MCP tools |
| Local-first, secure by default | Full control (ADR-003 §3) | Must override no-auth loopback and default telemetry | Full control. Interop endpoints use the same token rules. |
| Token and cost efficiency | Our design (summary packets, handoff bands) | Their session model; we would retrofit packets | Same as A |
| Contributor approachability | One TS codebase, small | Python + TS, plus a 1M-line upstream to understand | Same as A. Interop lives in optional packages. |
| Speed to M1 | Medium: adapters must be built | Fast for "run agents", slow for the parts that make Tacet different | Same as A for M1. Interop is M6 (#51) plus thin optional adapters. |

## Decision

Proposed: **Option C, standalone with interop.**

1. **Tacet owns its core in TypeScript:** the Mini-conductor, escalation gate, decision inbox, HandoffPacket and context bands, cost tiering and event log. We do not fork, vendor or embed Omnigent, Gas Town or Gas City.
2. **We borrow ideas, not code, by default.** The "What we can bring over" tables are the borrow list. Each row goes into the named issue's task list when that issue is picked up. A close port of any file needs its license header and attribution (and the NOTICE text for Apache-2.0), and the PR must say so.
3. **We interoperate through the protocols ADR-003 already fixes, plus ACP:**
   - **Inbound to Tacet:** a Mini-conductor exposed as an ACP agent (#51) can be driven by Omnigent (`acp:<slug>`), Gas City (the `acp` session provider) and editors. Agents in any of them can call the Mini's MCP tools with a per-session bearer token (ADR-003 §6).
   - **Outbound from Tacet:** Omnigent sessions and Gas City runs can become Tacet Workers through optional adapters (`@tacet/adapter-omnigent` over `/v1/sessions`, `@tacet/adapter-gascity` over the Supervisor API). These are P2, after M1, and only if a user asks.
   - A2A exposure (#52) stays on the roadmap for other agent platforms. Neither Omnigent nor Gas Town/City speaks A2A today, so it does not help interop with them.
4. **Promote #51 (ACP exposure) from "later" to the first interop deliverable after M1.** It is the cheapest way to make Tacet usable inside both ecosystems.

**Why:** Tacet's distinctive parts (a persistent per-repo middle tier, one cross-repo decision inbox, budget-driven fresh-session handoffs) are exactly what neither project provides. Building them inside Omnigent would mean Python, a fast-moving alpha codebase of about a million lines with no orchestration plugin seam, and security defaults we would have to override. Gas Town is being replaced, and Gas City brings Go, tmux and Dolt. Both projects already speak ACP and MCP, so we can coexist with them at protocol level without inheriting their cores.

**What would change this:**
- The owner's hands-on spike (follow-up 1) shows Omnigent can host a persistent per-repo supervisor and a cross-session inbox with little glue, **and** the owner accepts Python. Then reconsider B and reopen ADR-002.
- Omnigent ships a stable orchestration plugin API, or an ACP or A2A server endpoint for its sessions. That would make deeper interop, or building on it, cheaper.
- Gas City adds a harness-neutral, non-tmux, non-Dolt mode and a stable API. It would then become a stronger interop target, and possibly a backend for Worker scheduling.
- Measured cost of the M1 adapters is much higher than expected (for example, the Claude and Codex adapters take far longer than estimated). Then reconsider driving Workers through Omnigent as a backend.

## Consequences

- **ADR-002 can be accepted as written** (TypeScript on Node 24, no Bun, macOS and Linux only). This ADR adds no Python or Go to the core. Its "revisit if ADR-001 picks B" trigger does not fire, as long as the owner does not choose B after the spike.
- Follow-up work. Do not edit `roadmap/issues.json` without a human (`roadmap-sync` skill):
  1. **Spike (owner, time-boxed):** the outstanding issue #2 tasks. Run Omnigent and Gas City (not Gas Town, which is being superseded) on a toy repo. Confirm or refute this ADR's assumptions: no persistent per-repo supervisor, no cross-repo inbox, auth and telemetry defaults, and whether `acp:<slug>` passes our MCP server through. Findings go into this ADR before acceptance.
  2. Add the borrow rows to the task lists of #5, #10, #15, #17, #18, #19, #25, #26, #30, #31, #35 and #50.
  3. Re-prioritise #51 (expose Mini as an ACP agent) to directly after M1, with acceptance tests run from Omnigent (`acp:tacet`) and Gas City (`acp` provider).
  4. New, P2: `@tacet/adapter-omnigent` and `@tacet/adapter-gascity` (optional, on demand).
  5. New, M3+: merge queue (batch-then-bisect) after verification.
  6. `agent:claude`: verify the UNVERIFIED items (star counts and docs-site facts once reachable, Gas City dashboard auth, Omnigent ACP `mcpServers` header pass-through).
  7. #1 license choice: note that Apache-2.0 keeps Omnigent ports simplest. MIT is compatible with Gas Town/City ports either way.
- `docs/RESEARCH.md` §9 should point to this ADR, and §2.2 should note that Gas Town is succeeded by Gas City and Vibe Kanban is sunsetting. This PR does not edit those files, because another change is editing them in parallel. Update them in the PR that accepts this ADR.
- `docs/ARCHITECTURE.md` does not change shape. Once accepted, a short "Interop" note (ACP inbound, optional outbound adapters) belongs in §5 or §6.
- Risk: Omnigent overlaps Tacet heavily and moves fast. It may add per-repo supervisors or an inbox. Re-check its changelog at each Tacet milestone.

## Alternatives considered

### A. Standalone, borrow ideas only
Same core as C, with no interop commitments. **Pros:** smallest scope. **Cons:** it ignores a cheap path to users who already run Omnigent or Gas City, and #51/#52 stay vague. **Reversal cost:** low (C can be added later), so C costs little more and is preferred.

### B. Build on Omnigent
Implement the Mini-conductor as an Omnigent supervisor agent (Polly-like) with policies for the gate, and the inbox and handoff as server extensions. **Pros:** about 18 harnesses, a web UI, phone access, sandboxes and policies on day one; the closest prior art. **Cons:** Python core (ADR-002 reopened, schemas in two languages); no plugin seam for orchestration, so we would carry patches in a fast-moving alpha codebase or fork it; corporate-led roadmap with Databricks defaults; no auth on loopback and telemetry on by default, both against ADR-003 §3 and local-first defaults. **Reversal cost:** high.

### B′. Build on Gas Town or Gas City
**Pros:** the two-tier model is the closest conceptual match; escalation, handoff and merge queue already exist; MIT. **Cons:** Gas Town is being replaced; Gas City is Go + Bazel, tmux-first, Dolt-backed by default, Claude-first in its examples, with a v0 API; it would be a third language. **Reversal cost:** high.

### D. Build on Vibe Kanban or Claude Agent Teams
Rejected. Vibe Kanban is a flat parallel runner and is sunsetting. Agent Teams is Claude-only, experimental, one team per session and has no nesting. Agent Teams stays usable as a Worker backend through the Claude adapter.
