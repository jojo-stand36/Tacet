---
name: session-handoff
description: Write a structured handoff so another agent session (Claude Code or Copilot) can continue unfinished work without the old conversation. Use before stopping with work remaining, when context is getting long, or when the user asks to hand off, pause or switch agents.
---

# Session handoff

This repo dogfoods Tacet's own HandoffPacket (see `docs/ARCHITECTURE.md` §2.3). A handoff is typed state, not a story of what happened.

## When

- You are stopping and the issue is not done.
- Your context is getting long and quality is at risk: hand off to a fresh session rather than pushing on.
- Work is moving between Claude Code and Copilot.

## Steps

1. Run `git status` and `git log --oneline -10`. Commit and push work in progress (prefix `wip:` is fine) so the next session can see it.
2. Fill in the template below. Every field is required; write `none` if empty. `next_action` must be one concrete step someone can start immediately.
3. Post it:
   - Open PR exists → put it in the PR's "Handoff" section and also as a PR comment.
   - Otherwise → comment on the issue: `gh api repos/{owner}/{repo}/issues/N/comments -f body=@handoff.md` (Claude Code), or the issue comment UI/tooling (Copilot).
4. Do not paste transcripts, long logs or secrets.

## Template

```markdown
## Handoff — #<issue> — <YYYY-MM-DD> — from <Claude Code | Copilot | human>

**Goal:** <one sentence: what the issue is trying to achieve>
**Branch / PR:** <branch name> / <PR link or none>

**Acceptance criteria status**
- [x] <criterion done>
- [ ] <criterion remaining>

**State:** <2–4 sentences: what exists now and whether it builds/passes>

**Decisions made (and why)**
- <decision> — <reason>

**Files touched**
- `path/to/file` — <what changed>

**Commands run / verification**
- `<command>` → <result>

**Open questions** (tag `needs-human` if a person must answer)
- <question>

**Next action:** <the single next concrete step>
```

## Quality bar

Reject your own handoff and rewrite it if: `next_action` is vague ("continue work"), acceptance status is missing, or a decision has no reason.
