---
applyTo: "roadmap/**,ROADMAP.md"
---

# Roadmap files

- `roadmap/issues.json` is the source of truth. `ROADMAP.md` is generated: run `node scripts/gen-roadmap.mjs` after any change to `issues.json` and commit both.
- Never hand-edit `ROADMAP.md`.
- Every issue needs exactly one `type:*`, one `priority:*`, at least one `area:*` label, and a milestone that exists in `milestones`. New labels must be added to the `labels` array with a hex color.
- Issue bodies follow: summary paragraph, `### Tasks` checklist, `### Acceptance criteria`, closing line pointing to the docs.
- Adding issues is fine when you discover new work. Removing issues, renaming milestones or changing priorities needs a human request.
- To push new issues to GitHub: `scripts/create-issues.sh OWNER/REPO` (it skips titles that already exist).
