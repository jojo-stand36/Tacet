---
name: pick-up-issue
description: Start or resume work on a Tacet GitHub issue. Loads the issue, its milestone, dependencies and the latest handoff, then produces a scoped plan. Use when assigned an issue, when asked to work on issue N, or when resuming someone else's unfinished work.
argument-hint: "[issue-number]"
---

# Pick up an issue

Goal: start work with the full picture and a plan that stays inside the issue's scope.

## 1. Load the issue

- Claude Code: `gh api repos/{owner}/{repo}/issues/N` and `gh api repos/{owner}/{repo}/issues/N/comments` (REST works in cloud sessions where GraphQL may not).
- Copilot cloud agent: the issue is already in your context; also read its comments.

Note the milestone, labels, tasks checklist and acceptance criteria.

## 2. Find the latest handoff

Search the issue comments, and any open PR linked to the issue, for the most recent comment that starts with `## Handoff`. If one exists, it overrides the original task list for "what to do next": start from its `next_action` and respect its `decisions`. If its state looks stale (files it mentions no longer match), say so before continuing.

## 3. Check readiness

Stop and comment on the issue instead of starting if any of these are true:
- Dependencies are not done. The milestone order is M0 → M6; ADR issues block the features they decide.
- Acceptance criteria are missing or untestable.
- It is labelled `needs-human` and the decision has not been recorded on the issue.
- You are Copilot, it needs a vendor/protocol fact that is not recorded in `docs/adapters/` or `docs/RESEARCH.md`, and you have no web access. Ask for `agent:claude`.

## 4. Read the relevant context

- Always: `AGENTS.md`, the relevant sections of `docs/ARCHITECTURE.md`, accepted ADRs in `docs/adr/`.
- Any `.github/instructions/*.instructions.md` whose `applyTo` matches files you will touch.

## 5. Plan

Write a short plan before editing:
- Branch name: `<agent>/<N>-<slug>` (Copilot's automatic branch name is fine).
- Files to create or change.
- Tests you will add.
- Anything out of scope you noticed. These become new issues via the `roadmap-sync` skill, not part of this change.

## 6. Work, then finish

- Implement in small commits using Conventional Commits that reference `#N`.
- Run the checks in `AGENTS.md` → Definition of done.
- Open the PR with the template and `Closes #N`.
- If you must stop before done, run the `session-handoff` skill and post the handoff on the issue or PR.
