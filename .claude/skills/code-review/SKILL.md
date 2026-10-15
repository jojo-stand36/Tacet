---
name: code-review
description: Review a Tacet pull request against the project's architecture, conventions and hard rules, giving prioritized, actionable findings. Use when reviewing any PR, including PRs written by Claude Code or Copilot, or before marking your own PR ready.
---

# Code review

Review the diff against the linked issue, `AGENTS.md` and the accepted ADRs. Be specific: file, line, problem, suggested fix.

## Checklist

**Scope**
- Does the PR do what the issue's acceptance criteria require, and nothing unrelated?
- Is discovered work captured as new issues rather than added here?

**Architecture**
- Shared types come from `@tacet/core`, not redefined.
- State changes go through the event log.
- No vendor-specific types leak out of `packages/adapters/*`.
- Consistent with accepted ADRs; if it changes the design, an ADR or `ARCHITECTURE.md` update is included.

**Hard rules** (any violation blocks the PR)
- No vendor OAuth or subscription token handling.
- No secrets, `.env` contents or personal paths, including in tests and fixtures.
- Servers bind to `127.0.0.1` by default.
- Vendor facts are verified and cited, or marked `UNVERIFIED` with a follow-up issue.
- Generated files (`ROADMAP.md`, `.github/agents/*.agent.md`) were regenerated, not hand-edited.

**Quality**
- Tests cover new behaviour, including failure paths (process crash, timeout, malformed vendor output).
- No live vendor calls in CI.
- Child processes and PTYs are always cleaned up.
- Errors are surfaced as events, not swallowed.
- New dependencies are justified.

**Docs**
- User-facing behaviour is documented; the PR template is filled in, including verification.

## Output format

1. One-line verdict: approve, approve with nits, or request changes.
2. Findings grouped as **Blocking**, **Should fix**, **Nit**, most important first.
3. Anything a human must decide.
