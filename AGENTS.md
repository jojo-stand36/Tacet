# AGENTS.md

Canonical instructions for every AI agent working on this repo: Claude Code (local or cloud), GitHub Copilot cloud agent, Copilot CLI/IDE, Codex, Gemini and others. Vendor-specific files (`CLAUDE.md`, `.github/copilot-instructions.md`) only add tool-specific notes and must not contradict this file.

## What Tacet is

Tacet is a local-first orchestrator for AI coding agents. A global **Conductor** routes work to per-repo **Mini-conductors**, which run cheap **Worker** agents (Claude Code, Codex, Gemini CLI, any ACP/CLI agent) in git worktrees, absorb routine questions, hand off context to fresh sessions before it degrades, and escalate only real decisions to the user.

Read before non-trivial work:
- `docs/ARCHITECTURE.md`: roles, core loops, interfaces, config layers, package layout.
- `docs/RESEARCH.md`: prior art, vendor integration surfaces, protocols, constraints.
- `ROADMAP.md`: milestones M0–M6. GitHub issues are the source of truth for scope.
- `docs/adr/`: accepted decisions. An accepted ADR overrides the architecture draft.

## Current status

Planning stage (milestone **M0 · Foundations**). There is no application code yet. The planned stack is a TypeScript pnpm monorepo (`packages/core`, `conductor`, `mini`, `adapters/*`, `web`, `tui`, `cli`), pending ADR-002. Do not scaffold packages outside the issue that asks for it.

## Repo layout

```
AGENTS.md / CLAUDE.md         agent instructions (this file is canonical)
.claude/skills/<name>/SKILL.md  shared skills, read by Claude Code AND Copilot
.claude/agents/*.md           subagent definitions (source of truth)
.github/agents/*.agent.md     Copilot custom agents, GENERATED from .claude/agents
.github/instructions/         path-scoped rules (applyTo globs), followed by all agents
docs/                         research, architecture, ADRs, hybrid workflow
roadmap/issues.json           roadmap source of truth (milestones, labels, issues)
ROADMAP.md                    GENERATED from roadmap/issues.json
scripts/                      repo tooling (node, no dependencies)
```

## Commands

| Task | Command |
|---|---|
| Regenerate ROADMAP.md | `node scripts/gen-roadmap.mjs` |
| Regenerate Copilot agents | `node scripts/sync-agents.mjs` |
| Check generated files are current (CI runs this) | `node scripts/gen-roadmap.mjs --check && node scripts/sync-agents.mjs --check` |
| Create roadmap issues on GitHub | `scripts/create-issues.sh OWNER/REPO [--dry-run]` |

Once packages exist, `pnpm install`, `pnpm test`, `pnpm lint` and `pnpm typecheck` must all pass before a PR is ready.

## How to work an issue

1. Read the issue, its milestone and the docs above. Check that its dependencies are done; if not, stop and say so.
2. Branch: `<agent>/<issue-number>-<slug>`, for example `claude/12-worktree-manager`. Copilot's automatic `copilot/*` branches are fine.
3. Keep the change scoped to the issue. New work you discover becomes a new issue (see the `roadmap-sync` skill), not scope creep.
4. Write or update tests with the change. Update docs the change makes stale.
5. Open a PR using the template. Link the issue with `Closes #N`. Fill in the handoff section if anything is unfinished.
6. Design decisions that are hard to reverse need an ADR (`write-adr` skill) and a human approver.

## Definition of done

- Acceptance criteria in the issue are met and checked off.
- Tests cover the new behaviour; CI is green.
- Generated files are regenerated (`--check` passes).
- Docs, `ARCHITECTURE.md` or ADRs are updated if the design changed.
- No secrets, tokens or personal paths in the diff.

## Conventions

- **Language:** TypeScript, `strict` mode, ESM. No `any` without a comment saying why.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`). Reference the issue: `feat(mini): worktree GC (#12)`.
- **Naming:** use the project vocabulary exactly: Conductor, Mini-conductor, Worker, Adapter, Escalation, Decision, HandoffPacket, Task. Config lives in `.tacet/`; packages are `@tacet/*`.
- **Dependencies:** prefer the platform and the official vendor SDKs. Justify every new runtime dependency in the PR.
- **Shared types** live in `@tacet/core`. Never redefine a core schema elsewhere.
- **Events:** state changes go through the append-only event log, not ad-hoc mutable state.

## Hard rules

- Never store, log, proxy or copy vendor OAuth/subscription tokens. Tacet launches vendor CLIs and SDKs under the user's own auth or API keys (see `docs/RESEARCH.md` §7).
- Never commit secrets, `.env` files or API keys. Never print them in logs or test snapshots.
- Local servers bind to `127.0.0.1` with a token by default. Remote access is opt-in.
- Do not state vendor CLI flags, protocol methods or terms from memory. They change monthly. Verify against primary docs first (`verify-vendor-facts` skill) and record what you verified.
- Do not hand-edit generated files (`ROADMAP.md`, `.github/agents/*.agent.md`).
- Do not change `roadmap/issues.json` milestones or remove issues without a human asking for it.

## Hybrid development (Claude Code + Copilot)

This repo is built by both Claude Code and the Copilot cloud agent. Issue labels route work:

| Label | Meaning |
|---|---|
| `agent:copilot` | Well-scoped, clear acceptance criteria. Good to assign to Copilot cloud agent. |
| `agent:claude` | Design, research, cross-cutting or ambiguous work. Run in Claude Code. |
| `agent:either` | Either agent can take it. |
| `needs-human` | A human decision is required (ADRs, scope, vendor terms) before or during the work. |

When you stop mid-task, leave a handoff (`session-handoff` skill) as an issue or PR comment so the next agent, of either vendor, can continue. Full workflow: `docs/HYBRID_WORKFLOW.md`.

## Skills and agents

Skills (`.claude/skills/`, usable by both tools): `pick-up-issue`, `write-adr`, `roadmap-sync`, `verify-vendor-facts`, `build-adapter`, `session-handoff`, `code-review`.

Agents (`.claude/agents/`, mirrored to `.github/agents/`): `architect`, `adapter-engineer`, `protocol-researcher`, `test-engineer`, `reviewer`, `docs-keeper`.
