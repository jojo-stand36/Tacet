---
name: build-adapter
description: Implement or extend a Tacet agent adapter (Claude Code, Codex app-server, ACP, OpenCode, PTY fallback) behind the AgentAdapter interface with conformance tests. Use for any work under packages/adapters or when adding support for a new agent CLI.
---

# Build an adapter

Read first: `.github/instructions/adapters.instructions.md`, `docs/ARCHITECTURE.md` §3, `docs/RESEARCH.md` §3, and `docs/adapters/capability-matrix.md`.

## Steps

1. **Verify the surface.** Use `verify-vendor-facts` for every method, flag and event you will rely on. Record the version you test against.
2. **Scaffold** `packages/adapters/<id>/` with `src/index.ts` exporting a class that implements `AgentAdapter` from `@tacet/core`. The id is short and kebab-case (`claude-sdk`, `codex-app-server`, `acp`, `opencode`, `pty`).
3. **Declare capabilities honestly** in `capabilities()`: streaming, approvals, interrupt, resume, fork, usage/context reporting, model switching.
4. **Map events.** Write one pure function `toAgentEvents(vendorMessage) → AgentEvent[]` and unit-test it against recorded fixtures in `test/fixtures/` (real captured output, secrets scrubbed).
5. **Lifecycle.** Spawn the vendor process with an explicit `cwd` (the worker's worktree) and an environment allowlist. On `close()`, or on a crash, kill the whole process tree and emit `status: error` or `status: done`.
6. **Approvals.** Translate the vendor's permission or approval mechanism into `approval.request` events, and `respond()` back. Never auto-approve inside the adapter; that is policy, and it belongs to the Mini-conductor.
7. **Usage.** Emit `usage` events with `contextUsed`/`contextMax` whenever the vendor reports them. Handoff depends on this.
8. **Conformance.** Run the shared suite from `@tacet/core` against a fake transport replaying fixtures. Live-vendor tests are opt-in (`TACET_LIVE_TESTS=1`) and never run in CI.
9. **Document** the adapter row in the capability matrix and any setup the user needs.

## Done when

- Conformance suite passes in CI on recorded fixtures.
- No vendor types are exported outside the package.
- Capability matrix updated with version, date and sources.
