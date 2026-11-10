# Tacet

> Orchestrate every AI agent across every repo from one place — and only hear from them when it matters.

*Tacet* (TAH-set) is the musical marking that tells an instrument to stay silent. Tacet's agents work quietly in the background and only interrupt you for the decisions that need you.

**Status:** early development (M0). The monorepo is scaffolded; the packages are still placeholders. See the [roadmap](ROADMAP.md). Licensed under [Apache-2.0](LICENSE).

## The idea

Running one coding agent is easy. Running ten across five repos means you become the bottleneck: every question, approval and context reset lands on you.

Tacet adds a **hierarchy** so you only see what actually needs you:

- **Conductor** — runs locally (web UI or terminal). Your single inbox for decisions, plus cross-project goals, global settings and cost.
- **Mini-conductors** — installed per repo (`npx tacet init`). They plan work, spin up cheap sub-agents in isolated worktrees, verify results, answer what they can, and escalate only real decisions.
- **Workers** — Claude Code, Codex, Gemini CLI, OpenCode, Goose or any ACP/CLI agent, typically on cheaper, lower-effort models.

And it manages **context as a budget**: when a session gets heavy, Tacet has it write a structured handoff and continues in a fresh session, instead of letting quality decay through compaction.

## Why another orchestrator?

Most tools in this space run many agents *side by side* and leave you to coordinate them. Tacet's bets are:

1. Two-tier hierarchy across many repos, with escalation as the core UX
2. Harness-agnostic via native APIs, ACP, MCP and a PTY fallback
3. Automatic, typed context handoffs
4. Role-based model tiers and budgets
5. Repo-local config you commit, like `AGENTS.md`
6. Local-first, configurable to how you work

Details and prior art: [docs/RESEARCH.md](docs/RESEARCH.md). Proposed design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing (humans and agents)

Tacet is built by people working with Claude Code and the GitHub Copilot cloud agent. Start with [AGENTS.md](AGENTS.md), the canonical instructions for every agent and a good primer for humans too. Issues carry routing labels (`agent:copilot`, `agent:claude`, `agent:either`, `needs-human`). How the hybrid setup works: [docs/HYBRID_WORKFLOW.md](docs/HYBRID_WORKFLOW.md).

## Developer setup

Node.js 24 or later and pnpm (see `packageManager` in `package.json`); then `pnpm install` and `pnpm test`. The PTY adapter's native dependency `node-pty` is built by `node-gyp` where no prebuilt binary fits your platform, which needs a C++ toolchain (on Ubuntu, `build-essential` and Python 3; on macOS, the Xcode command line tools). Without it `pnpm install` still succeeds, and `pnpm test` skips the live PTY suites with the reason on stderr; CI, where `CI` is set, fails instead, so those suites always run there (#189).

## Bootstrapping this repo's issues

```bash
gh auth login
scripts/create-issues.sh OWNER/REPO --dry-run   # preview
scripts/create-issues.sh OWNER/REPO             # create labels, milestones, issues
```

## License

Apache-2.0, decided 2026-11-09 ([ADR-001](docs/adr/001-build-vs-extend.md)). The `LICENSE` and `NOTICE` files land with the scaffold issue (#1).
