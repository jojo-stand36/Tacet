# Hybrid workflow: Claude Code + Copilot cloud agent

Tacet is developed by two kinds of agent sessions working on the same issues:

- **Claude Code**, locally or in Claude Code cloud sessions. Strong for design, research with web access, cross-cutting changes and long interactive work.
- **GitHub Copilot cloud agent**, assigned to issues on GitHub. Runs in GitHub Actions, opens a PR on a `copilot/*` branch. Strong for well-scoped issues with clear acceptance criteria. It has no web access.

Both read the same instructions and skills, so either can pick up where the other stopped.

## What each tool reads

| File | Claude Code | Copilot cloud agent |
|---|---|---|
| `AGENTS.md` (canonical) | via `@AGENTS.md` import in `CLAUDE.md` | yes |
| `CLAUDE.md` | yes | yes |
| `.github/copilot-instructions.md` | no | yes |
| `.github/instructions/*.instructions.md` | read manually (CLAUDE.md says when) | yes, by `applyTo` glob |
| `.claude/skills/*/SKILL.md` | yes (also `/skill-name`) | yes |
| `.claude/agents/*.md` | yes | no |
| `.github/agents/*.agent.md` (generated) | no | yes |
| `.github/workflows/copilot-setup-steps.yml` | no | yes, runs before each session |
| `.claude/settings.json` + hooks | yes | no |

## Routing work

Every issue gets one routing label:

| Label | Use for | Typical issues |
|---|---|---|
| `agent:copilot` | Clear scope, testable acceptance, no open design questions, no web research needed | config loader, event log, CLI commands, UI screens, packaging |
| `agent:claude` | Design, ADR drafting, spikes, vendor research, cross-package refactors | ADRs, capability matrix, adapter protocol work |
| `agent:either` | Fine for both | most features once their ADRs are accepted |
| `needs-human` | Decision or approval needed | ADR acceptance, licensing, vendor terms, scope changes |

Rules of thumb:
- If an issue needs a vendor fact that isn't recorded in `docs/adapters/` yet, it is `agent:claude` until the fact is recorded.
- If Copilot gets stuck on an issue twice, relabel it `agent:claude` and leave a handoff.
- Epics are tracking issues; work happens in their child issues.

## Handing off between agents

When a session stops with work remaining, it runs the `session-handoff` skill and posts the result as a comment on the issue (or in the PR's handoff section). The packet has the same fields Tacet itself will use: goal, acceptance criteria, state, decisions, files touched, commands run, open questions, next action, verification.

The next session, of either vendor, starts with the `pick-up-issue` skill, which reads the latest handoff first.

## Review

- Every PR gets a review from the other vendor where practical: Claude-authored PRs get Copilot code review; Copilot-authored PRs get the Claude `reviewer` agent or a human.
- Both use the `code-review` skill so the checklist is the same.
- A human merges. Agents never merge their own PRs.

## Keeping the setup in sync

- Agents: edit `.claude/agents/`, run `node scripts/sync-agents.mjs`.
- Roadmap: edit `roadmap/issues.json`, run `node scripts/gen-roadmap.mjs`.
- CI (`agent-config-check`) fails if either generated output is stale or if a skill's frontmatter is invalid.
