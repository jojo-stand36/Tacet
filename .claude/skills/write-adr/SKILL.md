---
name: write-adr
description: Draft an Architecture Decision Record in docs/adr for a Tacet design decision, comparing options with evidence. Use for ADR issues (ADR-001 build vs extend, ADR-002 runtime, ADR-003 protocols) or any hard-to-reverse choice such as protocols, storage, dependencies or licensing.
argument-hint: "[issue-number or topic]"
---

# Write an ADR

Read `.github/instructions/adr.instructions.md` first. It has the numbering and status rules.

## Steps

1. **Frame the decision.** One sentence: "We need to decide X because Y." Link the issue.
2. **Gather context.** Relevant sections of `docs/RESEARCH.md` and `docs/ARCHITECTURE.md`, earlier ADRs, and the issue's tasks. Vendor or protocol facts must be verified (`verify-vendor-facts` skill), with links.
3. **List 2–4 real options.** For each: how it works here, pros, cons, cost to reverse later.
4. **Evaluate against Tacet's drivers:**
   - harness-agnostic (works across Claude Code, Codex, Gemini, ACP agents)
   - local-first and secure by default
   - token and cost efficiency
   - contributor approachability (open source)
   - speed to the M1 mini-conductor MVP
5. **Recommend one option** with the reason in two or three sentences. Be explicit about what would make you change your mind.
6. **Write the file** from `docs/adr/000-template.md` as `docs/adr/NNN-kebab-title.md`, `Status: proposed`.
7. **Consequences:** follow-up issues it creates, docs that change. Update `docs/ARCHITECTURE.md` in the same PR if the design changes.
8. **Open a PR** labelled `needs-human`. A human accepts the ADR. Never mark your own ADR `accepted`.

## Spikes

If evidence is missing, do a time-boxed spike first: a throwaway prototype under `spikes/<adr-number>-<slug>/` (not shipped), and summarize its findings in the ADR's Context section.
