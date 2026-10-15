# Copilot instructions

`AGENTS.md` at the repo root is the canonical instruction set for this repository. Follow it. This file only adds Copilot-specific notes.

- Skills are in `.claude/skills/` (Copilot reads that location). Use them: `pick-up-issue` when assigned an issue, `session-handoff` before stopping with unfinished work, `code-review` when reviewing a PR.
- Custom agents are in `.github/agents/`. They are generated from `.claude/agents/`; edit the source file, then run `node scripts/sync-agents.mjs`. Never edit `.github/agents/*.agent.md` directly.
- Path-scoped rules are in `.github/instructions/` and apply automatically.
- The cloud agent has no web access. If a task needs vendor documentation that is not already recorded in `docs/adapters/` or `docs/RESEARCH.md`, stop and comment on the issue asking for the `protocol-researcher` agent in Claude Code (label `agent:claude`), rather than guessing.
- Work only on the assigned issue. If it lacks clear acceptance criteria, or its dependencies are not done, comment on the issue with what is missing and stop.
- Fill in every section of the pull request template, including the handoff section if anything is left.
