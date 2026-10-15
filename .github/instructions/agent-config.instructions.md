---
applyTo: "AGENTS.md,CLAUDE.md,.claude/**,.github/agents/**,.github/instructions/**,.github/copilot-instructions.md"
---

# Agent configuration files

- `AGENTS.md` is canonical. `CLAUDE.md` and `.github/copilot-instructions.md` hold only tool-specific notes and must not contradict it.
- Skills live only in `.claude/skills/<name>/SKILL.md` (both Claude Code and Copilot read this path). Do not duplicate them into `.github/skills/`.
- Skill frontmatter: `name` (lowercase-hyphenated, equal to the directory name) and `description` (what it does and when to use it) are required for Copilot compatibility. Keep `SKILL.md` under 500 lines; move long reference material to sibling files.
- Agents: edit `.claude/agents/*.md` only, then run `node scripts/sync-agents.mjs`. `.github/agents/*.agent.md` is generated.
- Agent frontmatter for the source files: `name`, `description`, `tools` (comma-separated Claude tool names), optional `model`. Keep the frontmatter simple `key: value` lines so the sync script can parse it.
- Changes to these files affect every future agent session. Keep them short, specific and testable; remove rules that no longer apply.
