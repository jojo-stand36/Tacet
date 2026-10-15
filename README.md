# Tacet

> Orchestrate every AI agent across every repo from one place — and only hear from them when it matters.

*Tacet* (TAH-set) is the musical marking that tells an instrument to stay silent. Tacet's agents work quietly in the background and only interrupt you for the decisions that need you.

**Status:** research & planning. No code yet. See the [roadmap](ROADMAP.md).

## The idea

Running one coding agent is easy. Running ten across five repos means you become the bottleneck: every question, approval and context reset lands on you.

tacet adds a **hierarchy** so you only see what actually needs you:

- **Conductor** — runs locally (web UI or terminal). Your single inbox for decisions, plus cross-project goals, global settings and cost.
- **Mini-conductors** — installed per repo (`npx tacet init`). They plan work, spin up cheap sub-agents in isolated worktrees, verify results, answer what they can, and escalate only real decisions.
- **Workers** — Claude Code, Codex, Gemini CLI, OpenCode, Goose or any ACP/CLI agent, typically on cheaper, lower-effort models.

And it manages **context as a budget**: when a session gets heavy, tacet has it write a structured handoff and continues in a fresh session, instead of letting quality decay through compaction.

## Why another orchestrator?

Most tools in this space run many agents *side by side* and leave you to coordinate them. tacet's bets are:

1. Two-tier hierarchy across many repos, with escalation as the core UX
2. Harness-agnostic via native APIs, ACP, MCP and a PTY fallback
3. Automatic, typed context handoffs
4. Role-based model tiers and budgets
5. Repo-local config you commit, like `AGENTS.md`
6. Local-first, configurable to how you work

Details and prior art: [docs/RESEARCH.md](docs/RESEARCH.md). Proposed design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Bootstrapping this repo's issues

```bash
gh auth login
scripts/create-issues.sh OWNER/REPO --dry-run   # preview
scripts/create-issues.sh OWNER/REPO             # create labels, milestones, issues
```

## License

TBD in M0 (Apache-2.0 or MIT).
