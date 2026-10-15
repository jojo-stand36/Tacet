# Research: Hierarchical, harness-agnostic agent orchestration

_Initial research, October 2026. Project name: **Tacet**._

## 1. The idea in one paragraph

A locally-run engine (the **Conductor**) that orchestrates AI agent sessions regardless of vendor, model, IDE or CLI. Each project/repo installs a small package that runs a **Mini-conductor**: a middle manager that spins up cheap sub-agents, runs the routine work, keeps their context fresh with automatic handoffs, and only escalates real decisions and questions up to the Conductor, which is where the user lives (web UI or terminal). Everything is configurable per user, per repo and per tier.

## 2. Landscape

### 2.1 Flat parallel-session managers (crowded)

These run N agent CLIs side by side, usually one git worktree each, with a UI for diffs/review. The human is the only coordinator.

| Project | Shape | Notes |
|---|---|---|
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Kanban board → agent per card | Apache-2.0, ~28k stars, 10+ agents supported. The company behind it (bloop) announced it was shutting down in April 2026, so community-maintained. |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | tmux + worktrees TUI | AGPL-3.0, terminal-only. |
| [Superset](https://superset.sh) | Desktop workspace | Source-available (Elastic 2.0), exposes an MCP server for programmatic control. |
| [Orca](https://www.onorca.dev), [Parallel Code](https://github.com/johannesjo/parallel-code), [T3 Code](https://github.com/pingdotgg/t3code), Nimbalyst, Proliferate, Traycer, ntm, amux… | Desktop/TUI parallel runners | Many variants; see [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) and [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents). |
| [Zed 1.0](https://zed.dev/acp) | Editor with parallel ACP agents | Shipped April 2026 with parallel agents as the headline feature. |
| Codex desktop app | Vendor-native multi-agent manager | Single-vendor. |

**Takeaway:** do not compete on "run 10 agents in worktrees with a nice diff view." That is table stakes and should be borrowed (or even integrated with), not reinvented.

### 2.2 Hierarchical / supervisor orchestrators (closest prior art)

| Project | What it does that overlaps | Where it differs from tacet |
|---|---|---|
| [Omnigent](https://github.com/omnigent-ai/omnigent) (Apache-2.0, Python, ~10k stars, alpha) | "Meta-harness" over Claude Code, Codex, Cursor, OpenCode, Pi, Hermes, ACP agents. YAML-defined agents with sub-agents; policies (approval gates, spend caps) at server/agent/session level; web UI on localhost, phone access, team sharing; example "Polly" is a tech-lead orchestrator that delegates to sub-agents in worktrees and routes review to a different vendor. | Single supervisor per session, not a persistent per-repo middle tier. No first-class "escalation inbox" across many repos. Handoff/context policy isn't the core design. **Most important project to study — consider building on it or interoperating.** |
| [Gas Town](https://github.com/gastownhall/gastown) (Steve Yegge, Go, ~17k stars) | Explicit hierarchy: a persistent **Mayor** coordinator, **Rigs** (one per repo), ephemeral **Polecat** workers, a **Witness** that monitors workers, a **Refinery** merge queue. Work tracked as **Beads** (git/Dolt-backed issue ledger). | Very close to your mental model. Criticised as heavy and hard to adopt/uninstall; Claude-centric; opinionated vocabulary. Validates the concept; tacet should be lighter and harness-neutral. |
| Claude Code **Agent Teams** (experimental) | Team lead + teammate sessions, shared task list and per-agent mailbox, all as files under `~/.claude/teams/`. | Claude-only, single repo, no nested teams, notable token cost (reports of 3–15× a single session). Useful as a *backend* a mini-conductor could drive, not a competitor to the cross-repo layer. |
| Kilo's hosted Gas Town, Paperclip, CodeAgentSwarm, opengoat | Hosted/closed variants | Not local-first. |

### 2.3 The gap tacet can own

1. **Two-tier hierarchy across many repos/projects** — global Conductor + persistent per-repo Mini-conductors (most tools have one tier, Gas Town has it but is heavy and Claude-centric).
2. **Escalation as the product** — a single decision inbox: the user only sees questions, approvals and summaries, ranked by urgency. Everything else is absorbed by mini-conductors.
3. **Context budget as a managed resource** — automatic fresh-session handoff driven by measured context usage, with typed handoff packets, instead of lossy compaction.
4. **Cost tiering by role** — frontier model at the top, cheaper/lower-effort models at the bottom, with an escalation ladder when a cheap worker fails.
5. **Installable per-repo package** — repo-local config (`.tacet/`) checked into git, so a repo carries its own conductor rules, like `AGENTS.md` does for instructions.
6. **Beyond code** — research, docs and task workflows use the same machinery (a "repo" can be any workspace folder).

## 3. How to drive each agent (integration surfaces)

The hard engineering problem is controlling heterogeneous agents reliably. Four integration tiers, best first:

| Tier | Mechanism | Agents | Gives you |
|---|---|---|---|
| 1. Native structured API | **Codex app-server** (bidirectional JSON-RPC 2.0 over stdio/WebSocket; threads/turns/items; server-initiated approval requests; `generate-ts` schema export). **OpenCode `opencode serve`** (HTTP + OpenAPI 3.1 + SSE event stream, JS SDK). **Claude Agent SDK** / `claude -p --input-format stream-json --output-format stream-json` (multi-turn streaming input, `canUseTool` permission callback, resume/fork by session id). | Codex, OpenCode, Claude Code | Full fidelity: streaming, tool events, approvals, token usage, interrupt, resume/fork. |
| 2. **ACP** (Agent Client Protocol, Zed) | JSON-RPC over stdio; SDKs in TS, Python, Rust, Kotlin, Java. | Native: Gemini CLI, Goose, Devin, Grok Build, Cortex Code… Adapters: Claude (Zed's adapter), Codex (`codex-acp`). Also supported in JetBrains, Neovim, Emacs, Windows Terminal. | One adapter covers a long tail of agents. |
| 3. Hooks + PTY | Run the real interactive CLI in a PTY (node-pty/tmux) and observe it via hooks. Claude Code exposes ~30 hook events incl. `PermissionRequest`, `Notification`, `Stop`, `PreCompact`/`PostCompact`, `SessionStart` (source = startup/resume/clear/compact), `TaskCreated`/`TeammateIdle`; HTTP hooks can post straight to a local server. | Any CLI; best with Claude Code | Works with subscription-authenticated first-party CLIs; lower fidelity. |
| 4. Raw PTY scraping | Heuristics on terminal output. | Anything | Last resort; status only. |

**Recommendation:** define one internal `AgentAdapter` interface (start/send/interrupt/approve/usage/events/resume/fork/close) with tier-1 adapters for Claude, Codex and OpenCode, a generic ACP adapter, and a PTY+hooks adapter as the universal fallback.

## 4. Protocols for the layers between agents

| Boundary | Use | Why |
|---|---|---|
| Conductor ↔ UI | AG-UI-style typed event stream over WebSocket/SSE | AG-UI is an open event protocol for agent↔frontend (lifecycle, text, tool calls, state sync, human-in-the-loop). Adopting its event vocabulary gets interop with CopilotKit-style frontends for free. |
| Conductor ↔ Mini-conductor | Small JSON-RPC over local WebSocket (v0); map cleanly onto **A2A** tasks so it can be exposed as A2A later | A2A (Linux Foundation, v1.0 in 2026) is the cross-vendor agent-to-agent standard; IBM's older "ACP" (Agent *Communication* Protocol) merged into it. Full A2A is overkill for localhost v0 but the task model is right. |
| Agents ↔ tacet | **MCP server** exposed by each mini-conductor | Every agent already speaks MCP. Tools like `escalate(question, options, urgency)`, `report_progress`, `request_handoff`, `spawn_worker`, `read_task`, `record_decision` let *any* agent participate in the hierarchy without a custom adapter. This is the key trick. |
| Tacet ↔ editors | ACP (tacet as an ACP *agent*) | Lets Zed/JetBrains/Neovim users talk to their repo's mini-conductor as if it were one agent. Later milestone. |

Naming collision to note in docs: "ACP" = Zed's Agent **Client** Protocol (editor↔agent). IBM's Agent **Communication** Protocol is a different thing and is now folded into A2A.

## 5. Context handoff (token preservation)

Evidence points the same way: lossy auto-compaction degrades long sessions; **fresh session + structured handoff** works better.

- Sourcegraph Amp replaced compaction with a `/handoff` that seeds a new thread with a distilled document.
- OpenAI's Codex team reported that automatic compaction contributed to gradual quality decline in long sessions.
- Practitioners report best results ending sessions at ~50–75% of the window rather than at the ~95% where Claude Code's auto-compaction triggers.
- Community "handoff" extensions (pi-handoff, Claude Code skills/hooks) all converge on: disable auto-compact → warn at a threshold → agent writes `HANDOFF.md` → new session loads it via a SessionStart hook.

**Tacet design:**
- Mini-conductor tracks context usage per worker (Codex/OpenCode/ACP usage events, Claude `stream-json` usage, statusline/`PreCompact` hooks as fallback).
- Configurable bands, e.g. `warn: 0.55, handoff: 0.70, hard: 0.85`.
- At `handoff`, the worker is asked to emit a **typed handoff packet** (schema, not prose): `goal`, `acceptance_criteria`, `state_summary`, `decisions[]`, `files_touched[]`, `commands_run[]`, `open_questions[]`, `next_action`, `verification`, `parent_session`, `task_id`.
- Packet is validated (missing `next_action` → reject and regenerate), stored in `.tacet/handoffs/`, and a new session (same or different model per policy) is started seeded with it. The worktree/branch persists; only the conversation resets.
- Same mechanism powers *upward* summaries: mini-conductors send compact packets, never transcripts, to the Conductor. This keeps the Conductor's own context small.

## 6. Cost and model tiering

- Per-tier defaults: Conductor = frontier/high effort; Mini-conductor = mid tier; Workers = cheap/low effort. All overrideable per repo and per task type (e.g. "security review always uses frontier").
- **Escalation ladder**: worker fails verification N times → retry with next model tier → then escalate to mini-conductor → then to user.
- **Cross-vendor review** (as in Omnigent's Polly): the reviewer is from a different vendor than the author.
- Budget policies: per-task, per-repo, per-day caps with soft warnings; a cost ledger from usage events.

## 7. Auth, billing and terms (important constraint)

- Anthropic's terms say OAuth tokens from Claude Free/Pro/Max plans may not be used in other products, tools or services, **including the Agent SDK**; enforcement began January 2026, was clarified in February, and third-party tools were cut off from subscription limits on April 4, 2026. In May 2026 Anthropic added separate monthly **Agent SDK credits** to paid plans for programmatic and third-party use, and `claude -p`/Agent SDK usage moved to that credit pool from June 15, 2026.
- OpenAI has publicly endorsed using Codex subscriptions in third-party harnesses.
- **Design implication:** tacet never handles vendor OAuth tokens itself. It launches the vendor's own CLI/SDK under the user's own login or API key, supports API keys / gateways (OpenRouter, LiteLLM, local Ollama/vLLM) first-class, and documents per-vendor billing behaviour. Re-verify vendor terms before each release; this area moves fast.

## 8. Recommended technical direction

- **Language:** TypeScript on Node (or Bun) — the Claude Agent SDK, Codex SDK/app-server TS schemas, ACP SDK, OpenCode SDK, MCP SDK and AG-UI client all have first-class TS support. Python is the alternative (Omnigent chose it).
- **Shape:** pnpm monorepo: `core` (types, event schema), `conductor` (daemon), `mini` (per-repo daemon + MCP server, published as the installable package), `adapters/*`, `web` (React + xterm.js), `tui` (Ink), `cli`.
- **State:** append-only event log in SQLite per mini-conductor (event sourcing → replay, audit, UI timelines); Conductor keeps an aggregated index.
- **Isolation:** git worktree per worker by default; optional sandbox (bubblewrap/seatbelt/containers) later.
- **Local-first security:** bind to 127.0.0.1, per-install token, explicit opt-in for LAN/phone access.

## 9. Build-vs-extend decision (open)

Before writing much code, spend a spike deciding between:
- **A. Standalone** (recommended default): own the hierarchy, escalation and handoff layers; borrow ideas freely.
- **B. Build on Omnigent**: implement mini-conductor/escalation/handoff as Omnigent agents + policies. Faster start, but Python and someone else's core.
- **C. Interop**: standalone, but treat Omnigent / Gas Town / Vibe Kanban sessions as just another adapter.

## 10. Risks

- Agent CLIs change fast; adapters break. Mitigate with a capability matrix + contract tests per adapter (Omnigent runs a "harness test bench" for exactly this).
- Hierarchies burn tokens (Agent Teams reports multiples of single-session usage). Measure overhead per tier from day one.
- Escalation quality is the whole UX: too many questions and it's worse than one agent; too few and it goes off the rails. Needs evaluation harness and tunable thresholds.
- Vendor terms around subscriptions/automation.

## Sources

- Zed — Agent Client Protocol: https://zed.dev/acp · progress report: https://zed.dev/blog/acp-progress-report
- ACP overview: https://agentic-ai.readthedocs.io/en/latest/Standards/agent-client-protocol/
- ACP in Windows Terminal / Zed 1.0 parallel agents: https://codex.danielvaughan.com/2026/06/10/agent-client-protocol-microsoft-intelligent-terminal-codex-cli-multi-agent-ide-ecosystem/
- Codex app-server: https://developers.openai.com/codex/app-server · https://codex.danielvaughan.com/2026/06/03/codex-app-server-stdio-subprocess-embedding-custom-clients-json-rpc-protocol/
- Claude Agent SDK sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Headless agents overview: https://vanja.io/headless-agents/
- OpenCode server: https://opencode.ai/docs/server/
- Claude Code hook events: https://agentsroom.dev/blog/claude-code-hook-events-lifecycle
- Claude Code Agent Teams: https://www.morphllm.com/claude-code-agent-teams · https://www.testmuai.com/blog/claude-code-agent-teams/
- A2A: https://tyk.io/learning-center/a2a-protocol-architecture-and-technical-specification/ · https://zuplo.com/blog/agent-protocol-stack-mcp-a2a-acp-2026.md
- AG-UI: https://docs.ag-ui.com/concepts
- Omnigent: https://github.com/omnigent-ai/omnigent
- Gas Town: https://gastown.dev/docs/glossary · https://kilo.ai/docs/code-with-ai/gastown/mayor
- Parallel-agent tool survey: https://www.codeagentswarm.com/en/guides/best-tools-to-run-multiple-ai-coding-agents · https://github.com/andyrewlee/awesome-agent-orchestrators · https://github.com/bradAGI/awesome-cli-coding-agents
- Vibe Kanban: https://www.codeagentswarm.com/en/guides/vibe-kanban-vs-codeagentswarm
- Handoff vs compaction: https://hackernoon.com/sourcegraphs-amp-tries-a-new-fix-for-the-long-conversation-problem · https://learn.traeai.com/t/ai-engineering/phases/14-agent-engineering/40-multi-session-handoff.html · https://pi.dev/packages/@jackice/pi-handoff
- Anthropic subscription terms: https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546 · https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch · https://vincentvandeth.nl/blog/best-openclaw-alternative-cli-subprocess-oauth-ban
