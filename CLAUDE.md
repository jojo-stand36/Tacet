@AGENTS.md

## Claude Code notes

- `AGENTS.md` above is the canonical instruction set. Keep this file to Claude-specific additions only.
- When editing files covered by a path-scoped rule, read the matching file in `.github/instructions/` first (`adr`, `roadmap`, `adapters`, `docs`, `agent-config`). Copilot applies these automatically; Claude Code does not, so read them yourself.
- Skills live in `.claude/skills/` and can be run as slash commands, for example `/pick-up-issue 12` or `/session-handoff`.
- Subagents live in `.claude/agents/`. Use `architect` before structural changes, `reviewer` before opening a PR, and `protocol-researcher` whenever code depends on a vendor CLI or protocol detail.
- After editing anything in `.claude/agents/`, run `node scripts/sync-agents.mjs` so the Copilot copies stay in sync.
- The GitHub CLI may only have REST access in cloud sessions. Prefer `gh api repos/...` over `gh issue`/`gh pr` subcommands that rely on GraphQL.
