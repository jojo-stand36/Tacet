---
name: verify-vendor-facts
description: Verify and record facts about vendor agent CLIs, SDKs and protocols (Claude Code, Codex app-server, Gemini CLI, OpenCode, ACP, A2A, MCP, AG-UI) and their auth or billing terms before code depends on them. Use before writing adapter code, ADRs or docs that cite a flag, method, event shape, version or policy.
---

# Verify vendor facts

The agent-tooling ecosystem changes monthly. Memory and old blog posts are not evidence.

## Rules

1. **Primary sources only** for the fact itself: official docs, the vendor's repo (README, schema, source), changelog or release notes. Blog posts can point you to a fact but cannot be the citation.
2. **Prefer machine-readable truth** when it exists:
   - Codex app-server: `codex app-server generate-json-schema` or `generate-ts` for the installed version.
   - OpenCode: the OpenAPI spec served at `/doc` by `opencode serve`.
   - ACP / MCP / A2A: the published JSON schema or SDK types.
   - Claude Code / Agent SDK: official docs at code.claude.com and the SDK's type definitions.
3. **Record what you verified** in `docs/adapters/capability-matrix.md` (create it if missing):

   | Vendor | Surface | Fact | Version tested | Source | Checked |
   |---|---|---|---|---|---|
   | Codex | app-server | server-initiated approval requests over JSON-RPC | 0.x.y | link | YYYY-MM-DD |

4. **Auth and terms are facts too.** Record the current rule for subscription vs API-key use per vendor, with link and date. Never design around using a vendor's OAuth tokens outside its own binary.
5. **If you can't verify it**, say so in the PR or ADR, mark the assumption `UNVERIFIED`, and open a follow-up issue labelled `agent:claude`.

## No web access (Copilot cloud agent)

Use only what is already recorded in `docs/adapters/` and `docs/RESEARCH.md`, or installed package type definitions in `node_modules`. If the needed fact is not there, stop and ask for the `protocol-researcher` agent in Claude Code.
