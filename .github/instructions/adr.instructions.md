---
applyTo: "docs/adr/**"
---

# Architecture Decision Records

- One decision per file: `docs/adr/NNN-kebab-title.md`, three-digit number, next free number. Never renumber.
- Start from `docs/adr/000-template.md`. Keep the sections: Status, Date, Context, Decision, Consequences, Alternatives considered.
- New ADRs are `Status: proposed`. Only a human changes status to `accepted`. Agents never accept their own ADR.
- Superseding: set the old ADR's status to `superseded by ADR-XXX`; do not delete or rewrite its decision text.
- Link the GitHub issue the ADR resolves, and cite sources (links) for any vendor or protocol facts.
- If the decision changes `docs/ARCHITECTURE.md`, update that file in the same PR.
