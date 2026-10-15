---
name: roadmap-sync
description: Add or update Tacet roadmap issues in roadmap/issues.json, regenerate ROADMAP.md, and push new issues to GitHub. Use when you discover work outside the current issue's scope, when a human asks to add or change roadmap items, or when ROADMAP.md is stale.
---

# Roadmap sync

Read `.github/instructions/roadmap.instructions.md` first.

## Add an issue

1. Append to `issues` in `roadmap/issues.json`:
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
4. Regenerate: `node scripts/gen-roadmap.mjs`.
5. Push to GitHub (Claude Code with gh access): `scripts/create-issues.sh OWNER/REPO --dry-run`, then without `--dry-run`. Existing titles are skipped, so it is safe to re-run.
6. Commit `roadmap/issues.json` and `ROADMAP.md` together.

## Change an issue

- Edit the entry in `issues.json` and the GitHub issue to match. The script does not update existing issues; use `gh api -X PATCH repos/{owner}/{repo}/issues/N`.
- Moving milestones, changing priority or deleting issues requires a human request. Say who asked in the commit message.

## Discovered work during another issue

Do not expand the current PR. Add the new issue as above, mention it in your PR's "Decisions and open questions", and continue with the original scope.
