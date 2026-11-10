---
name: roadmap-sync
description: Add or update Tacet roadmap issues in roadmap/issues.json, regenerate ROADMAP.md, and push new issues to GitHub. Use when you discover work outside the current issue's scope, when a human asks to add or change roadmap items, or when ROADMAP.md is stale.
---

# Roadmap sync

Read `.github/instructions/roadmap.instructions.md` first.

## Add an issue

1. Add the entry anywhere in `issues` in `roadmap/issues.json` (appending is fine; step 4 sorts it):
   ```json
   {
     "title": "Imperative, specific title",
     "milestone": "M1 · Mini-conductor MVP",
     "labels": ["type:feature", "area:mini", "priority:p1", "agent:either"],
     "body": "Summary paragraph.\n\n### Tasks\n- [ ] ...\n\n### Acceptance criteria\n- ...\n\n_See docs/ARCHITECTURE.md and docs/RESEARCH.md for context._"
   }
   ```
2. Labels: exactly one `type:*`, one `priority:*`, one `agent:*` routing label (see `docs/HYBRID_WORKFLOW.md`), at least one `area:*`. Add `needs-human` if a decision is required.
3. Acceptance criteria must be testable. If you can't write them, the issue isn't ready: label it `agent:claude` + `needs-human`.
4. Regenerate: `node scripts/gen-roadmap.mjs`. It sorts `issues.json` into its canonical order (milestone, epics first, then title) and writes `ROADMAP.md`; `--check` fails if either is off.
5. Push to GitHub (Claude Code with gh access): `scripts/create-issues.sh OWNER/REPO --dry-run`, then without `--dry-run`. Existing titles are skipped, so it is safe to re-run.
6. Commit `roadmap/issues.json` and `ROADMAP.md` together.

## Change an issue

- Edit the entry in `issues.json` and the GitHub issue to match. The script does not update existing issues; use `gh api -X PATCH repos/{owner}/{repo}/issues/N`.
- Moving milestones, changing priority or deleting issues requires a human request. Say who asked in the commit message.

## Merge conflicts

Two branches that each add an entry merge cleanly unless their titles sort next to each other in the same milestone. If `roadmap/issues.json` or `ROADMAP.md` still conflicts when you merge main: take main's `issues.json` (`git checkout --theirs roadmap/issues.json` when merging main in; under a rebase the sides swap and main is `--ours`), re-apply this branch's additions and edits (`git diff main...HEAD -- roadmap/issues.json` lists them), run `node scripts/gen-roadmap.mjs`, then `git add roadmap/issues.json ROADMAP.md` and commit. Never resolve `ROADMAP.md` by hand.

## Discovered work during another issue

Do not expand the current PR. Add the new issue as above, mention it in your PR's "Decisions and open questions", and continue with the original scope.
