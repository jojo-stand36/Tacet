# ADR-002: Language and runtime (TypeScript on Node vs Bun vs Python)

- Status: proposed
- Date: 2026-11-09

Resolves issue #3. Depends on nothing; ADR-001 (build vs extend) may revisit it if it chooses option B (build on Omnigent, which is Python).

## Context

We need to pick the implementation language and JavaScript runtime before any package is scaffolded, because every M1 package (`@tacet/core`, `@tacet/mini`, the adapters, the web UI) inherits the choice and changing it later means a rewrite.

What the choice has to support (from `docs/ARCHITECTURE.md` §1, §3, §5 and `docs/RESEARCH.md` §3, §4, §8):

- Tier-1 adapters for Claude Code (Agent SDK), Codex (app-server) and OpenCode (`opencode serve`), a generic ACP adapter, and a PTY+hooks fallback adapter.
- An MCP server inside each mini-conductor, an A2A-shaped conductor↔mini channel and an AG-UI-style UI event stream (ADR-003).
- A React web UI with live terminals (xterm.js) and an Ink TUI.
- An append-only SQLite event log per mini-conductor.
- macOS and Linux (Ubuntu) only, local-first, installable into any repo. Windows is not a target.

### SDK support matrix

All facts were checked on 2026-11-09 against the vendor's own repo, docs or registry entry. Several documentation hosts (developers.openai.com, agentclientprotocol.com, opencode.ai, modelcontextprotocol.io, docs.ag-ui.com) were not reachable from the session that wrote this ADR, so those facts were taken from the same vendor's GitHub repo or package registry entry instead.

| Surface | TypeScript / Node | Python | Source (checked 2026-11-09) |
|---|---|---|---|
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.319, `engines.node >=18.14.0`. Spawns the bundled native Claude Code binary. Has an `executable: 'bun' \| 'deno' \| 'node'` option, and in-process MCP servers via `createSdkMcpServer()`. | `claude-agent-sdk` 0.2.179, Python >=3.10 | https://code.claude.com/docs/en/agent-sdk/overview ("programmable in Python and TypeScript"), https://code.claude.com/docs/en/agent-sdk/typescript, https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest, https://pypi.org/pypi/claude-agent-sdk/json |
| Codex app-server | `codex app-server generate-ts` ("[experimental] Generate TypeScript bindings for the app server protocol") and `generate-json-schema`. Transports: `--listen stdio://` (default), `unix://`, `ws://IP:PORT`. Official `@openai/codex-sdk` 0.167.0 (TS, `node >=18`). | No first-party Python SDK confirmed. `openai-codex-sdk` 0.1.11 exists on PyPI, but who publishes it is **UNVERIFIED**. A Python client could be generated from the JSON Schema. | https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs (`AppServerSubcommand`, `--listen`), https://registry.npmjs.org/@openai/codex-sdk/latest |
| ACP (Agent Client Protocol) | `@agentclientprotocol/sdk` 2.5.0 (official) | `agent-client-protocol` 1.0.0 (official python-sdk). Kotlin, Java and Rust also exist. Current stable ACP protocol version is `1`. | https://github.com/agentclientprotocol/agent-client-protocol/blob/main/README.md, https://registry.npmjs.org/@agentclientprotocol/sdk/latest |
| OpenCode | `@opencode-ai/sdk` 1.19.5, "type-safe JS client for opencode server", generated from the server's OpenAPI spec | `opencode-ai` 0.1.0a36 (alpha, described as "the official Python library for the opencode API") | https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/sdk.mdx, https://registry.npmjs.org/@opencode-ai/sdk, https://pypi.org/pypi/opencode-ai/json |
| MCP | TS SDK v2 (`@modelcontextprotocol/server` and `/client` 2.4.0, `node >=20`) implements spec 2026-07-28 and "runs on Node.js, Bun, and Deno". v1 `@modelcontextprotocol/sdk` 1.32.2 gets fixes for at least six months after 2026-07-27. | `mcp` 2.3.0, Python >=3.10 | https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md, https://registry.npmjs.org/@modelcontextprotocol/server |
| AG-UI | `@ag-ui/core` 1.0.4 ("TypeScript definitions & runtime schemas") and `@ag-ui/client` 1.0.4 | `ag-ui-protocol` 1.0.0 | https://registry.npmjs.org/@ag-ui/core/latest, https://pypi.org/pypi/ag-ui-protocol/json |
| A2A (for ADR-003) | `@a2a-js/sdk` 1.3.0, `node >=20` | `a2a-sdk` 1.3.0 | https://registry.npmjs.org/@a2a-js/sdk/latest, https://pypi.org/pypi/a2a-sdk/json |

Summary: every surface has an official TypeScript package. Python is covered for everything except a confirmed first-party Codex SDK, and several Python packages are behind or pre-1.0 (ACP 1.0.0 vs TS 2.5.0, OpenCode alpha). Two pieces have no Python equivalent: the web UI (React, xterm.js) is TypeScript regardless, and the Codex app-server's own codegen emits TypeScript.

### PTY support

- **node-pty** (Microsoft, used by VS Code): "supports Linux, macOS and Windows". Tacet targets macOS and Linux only, so the Windows (ConPTY) path is out of scope. Latest is 1.1.0 (2025-12-22), with 1.2.0 in beta. It is a native addon, so installs need a prebuilt binary or a C++ toolchain. Sources: https://github.com/microsoft/node-pty/blob/main/README.md, https://registry.npmjs.org/node-pty.
- Python has `ptyprocess`, which covers macOS and Linux. Source: https://pypi.org/pypi/ptyprocess/json.

### Node vs Bun

Bun 1.4.4 is the current release (https://registry.npmjs.org/bun/latest). From Bun's own compatibility page (https://github.com/oven-sh/bun/blob/main/docs/runtime/nodejs-compat.mdx, checked 2026-11-09):

- `node:tty` and `node:sqlite` are marked fully implemented. `node:child_process` is partial: it is missing some IPC features, and a child's stdout/stderr cannot be passed as another child's stdio.
- **node-pty on Bun is not reliable today.** Open issue oven-sh/bun#25822 ("node-pty: PTY spawns but onData callback never fires", last updated 2026-10-10). There have also been several recently closed crash and segfault reports: #28925, #29112, and #41414 (`tty.ReadStream` EAGAIN broke node-pty; closed 2026-09-20). Bun has its own `Bun.Terminal` PTY API (referenced in #43450), but it is Bun-only. The API details of `Bun.Terminal` are **UNVERIFIED** (bun.sh docs were not reachable).
- **better-sqlite3 on Bun** has a long history of crash and dlopen reports (#23243, #23757, #24956; the canonical tracker is #4290, whose current state is **UNVERIFIED** because the GitHub API was rate-limited). Bun's answer is `bun:sqlite`, a different API. better-sqlite3 13.0.3 requires `node >=22`.
- Bun's advantages (fast install, TS without a build step, single-file `bun build --compile`) are real. But the Claude Agent SDK docs note that `bun build --compile` cannot find its bundled binary without a workaround (`extractFromBunfs`).

Node LTS lines (https://github.com/nodejs/Release/blob/main/schedule.json): Node 24 has been LTS since 2025-10-28 (maintenance from 2026-10-20, end of life 2028-04-30). Node 26 has been LTS since 2026-10-28 (end of life 2029-04-30). `node:sqlite` is "Stability: 1.2 – Release candidate" (https://github.com/nodejs/node/blob/main/doc/api/sqlite.md).

### Drivers

| Driver | TS on Node | TS on Bun | Python |
|---|---|---|---|
| Harness-agnostic | Every vendor SDK is first-class | Same SDKs, but PTY fallback and native addons are shaky | Most SDKs exist; Codex is weaker; PTY via `ptyprocess` on POSIX |
| Local-first, secure | Mature `http`/`ws`, loopback binding is easy | Same | Same |
| Token/cost efficiency | Neutral | Neutral | Neutral |
| Contributor approachability | One language from daemon to UI; the most common stack in agent tooling | Smaller contributor base | Two languages (Python daemon + TS UI) |
| Speed to M1 | Fastest: no compatibility work | Risk of compatibility spikes on PTY and SQLite | Must bridge to the TS UI and write PTY glue |

## Decision

Proposed:

1. **Language: TypeScript**, `strict`, ESM, in a pnpm monorepo (as already planned in `AGENTS.md`).
2. **Runtime: Node.js LTS.** Minimum `node >=24`. CI runs on Node 24 and Node 26 on macOS and Ubuntu Linux. Windows is not a target platform. `engines` in every published package states the minimum.
3. **Bun is not a supported runtime for the daemons (`conductor`, `mini`) or the CLI in v0.** Contributors may use Bun locally as a script runner, but nothing may depend on Bun-only APIs (`Bun.*`, `bun:*`), and CI does not test on Bun.
4. **PTY:** `node-pty` behind the `pty` adapter, so the native addon is loaded only when the PTY fallback is used. Tier-1 and ACP adapters must work on a machine where `node-pty` failed to install (make it an optional dependency).
5. **SQLite:** this ADR does not pick the driver. The event-log issue chooses between `better-sqlite3` and `node:sqlite` behind a small storage interface in `@tacet/core`. The deciding question is whether `node:sqlite` reaches Stable before M1.
6. **Python is not used in core packages.** Python agents are still supported through their CLIs, ACP or MCP, which is all Tacet needs from them.

**Why:** every integration surface Tacet depends on ships an official TypeScript SDK, and the UI is TypeScript anyway, so one language covers the whole system. Node is the runtime that node-pty and the native SQLite drivers are built and tested against on both target operating systems (macOS and Linux). Bun's known PTY bugs would land exactly on our universal fallback adapter.

**What would change this:**
- Bun closes #25822, a spike shows node-pty (or a cross-platform PTY) and our SQLite driver working on Bun on macOS and Linux, and single-binary distribution becomes a priority. Then add Bun as a second tested runtime; do not switch.
- ADR-001 chooses to build on Omnigent (Python). Then revisit this ADR as a whole.
- A required vendor drops or deprecates its TypeScript SDK (no sign of that today).

## Owner input (2026-11-09)

The owner answered the open questions on 2026-11-09. The answers are recorded here and in the decision text above.

- **Runtime:** TypeScript on Node 24 minimum (decision 2). Bun is excluded (decision 3).
- **Platforms:** macOS and Linux (Ubuntu) only. Windows is removed from targets, the CI matrix and the ConPTY consequences.
- **Status:** this ADR stays `proposed`. Acceptance waits on ADR-001 (Omnigent build-vs-extend, issue #2), because ADR-001 may revisit this decision.
- **SQLite:** the driver choice is deferred to the event-log issue (#6), as recommended in decision 5.

## Consequences

- `AGENTS.md` "pending ADR-002" text and `docs/RESEARCH.md` §8 ("Node (or Bun)") become stale once this is accepted. Update both in the PR that accepts this ADR.
- The monorepo scaffold issue sets `engines.node: ">=24"`, adds `.nvmrc` / `.node-version` set to 24, and a CI matrix of {ubuntu, macos} × {24, 26}.
- `@tacet/adapter-pty` lists `node-pty` as an optional or peer dependency and degrades cleanly when it is missing. Its conformance tests run on macOS and Linux.
- Follow-up issues:
  - Record the SDK matrix above in `docs/adapters/capability-matrix.md` (owned by the adapter-docs work).
  - Event-log storage driver choice (`better-sqlite3` vs `node:sqlite`).
  - Confirm who publishes the PyPI `openai-codex-sdk` package (only relevant if Python is reconsidered).
  - Re-check Bun when #25822 closes (`agent:claude`, low priority).
- Distribution as a single executable is deferred. Node's single-executable-application support or a plain `npm i -g tacet` are the candidates, decided at release time.

## Alternatives considered

### A. TypeScript on Node (recommended)
See Decision. The cost of reversing it later is low for Bun (same language, same code) and high for Python (rewrite).

### B. TypeScript on Bun
- **Pros:** faster install and startup; TS runs without a build step; built-in SQLite and test runner; single-file executables.
- **Cons:** open node-pty bug and a history of native-addon crashes; `bun:sqlite` is a different API from the Node drivers; some `child_process` gaps (we spawn many agent CLIs); the Claude Agent SDK needs a workaround inside compiled Bun binaries.
- **Reversal cost:** low if we never use `Bun.*` APIs, which is why decision 3 forbids them.

### C. Python
- **Pros:** Omnigent (closest prior art) is Python; official Claude Agent SDK, MCP, ACP, A2A and AG-UI Python packages exist; strong in research and data workflows.
- **Cons:** the UI is TypeScript anyway, so we would maintain two languages and duplicate schemas; there is no confirmed first-party Codex Python SDK; ACP and OpenCode Python packages are behind or alpha; the per-repo package would need a Python environment in JS-heavy repos.
- **Reversal cost:** high.

### D. Polyglot (TypeScript UI + adapters, Python or Go daemon)
Rejected without a deep evaluation. Schema duplication across languages works against "shared types live in `@tacet/core`" (`AGENTS.md`), and it slows M1.
