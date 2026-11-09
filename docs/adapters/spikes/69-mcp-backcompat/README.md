# Spike #69: does `@modelcontextprotocol/server` v2 answer 2025-11-25 clients?

Checked 2026-11-09. Follow-up 4 of [ADR-003](../../../adr/003-wire-protocols.md). Feeds the compatibility requirement for the Mini-conductor MCP server (#18).

## Answer

**Yes, by default, on both stdio and HTTP.** `@modelcontextprotocol/server@2.4.0` decides the protocol "era" per connection (stdio) or per request (HTTP). The same server factory serves both eras: `modern` for 2026-07-28, `legacy` for 2025-era `initialize` traffic. No fallback package is needed.

| Entry point | Option | Default | Legacy (2025-era) behaviour |
|---|---|---|---|
| `serveStdio(factory, opts)` from `@modelcontextprotocol/server/stdio` | `legacy: 'serve' \| 'reject'` | `'serve'` | An `initialize` opening pins the connection to a legacy instance for its lifetime |
| `createMcpHandler(factory, opts)` from `@modelcontextprotocol/server` | `legacy: 'stateless' \| 'reject'` | `'stateless'` | Each legacy request gets a fresh instance over stateless streamable HTTP; GET and DELETE return `405` |

With `'reject'`, a legacy opening gets JSON-RPC error `-32022` "Unsupported protocol version" with `data.supported: ["2026-07-28"]`.

Source: the package's own type definitions (`dist/stdio.d.mts`, `dist/createMcpHandler-*.d.mts`, JSDoc on `ServeStdioOptions.legacy`, `CreateMcpHandlerOptions.legacy` and `McpRequestContext.era`) plus the tests below. The prose docs at `modelcontextprotocol.io` and `ts.sdk.modelcontextprotocol.io` were not read: `modelcontextprotocol.io` is blocked from this environment.

## Versions tested

| Package | Version | Role |
|---|---|---|
| `@modelcontextprotocol/server` | 2.4.0 (npm `latest`) | server under test |
| `@modelcontextprotocol/client` | 2.4.0 | v2 client, legacy default and modern opt-in |
| `@modelcontextprotocol/sdk` | 1.32.2 (npm `latest` of v1) | real 2025-11-25 client |
| Claude Code CLI | 2.1.319 | real host client (against the local mock API from [spike #64](../64-claude/README.md)) |
| zod / Node | 4.x / 22.23.4 | |

## Results

The harness is in `harness/`: one factory with an `escalate` tool, served over stdio (`stdio-server.mjs`) and HTTP (`http-server.mjs`). `clients.mjs` connects with each client, lists tools and calls `escalate`. The factory logs `ctx.era` for each instance it builds.

| Client | Transport | Server default | Server `legacy: 'reject'` |
|---|---|---|---|
| Raw JSON-RPC `initialize` with `protocolVersion: "2025-11-25"` | stdio | ok, answers `2025-11-25`, era `legacy` | `-32022` |
| SDK v1 1.32.2 | stdio | ok (legacy) | `-32022` |
| SDK v1 1.32.2 | HTTP | ok, negotiated `2025-11-25` | `-32022` |
| client v2 2.4.0, default options | stdio, HTTP | ok, negotiated `2025-11-25` | `-32022` |
| client v2 2.4.0, `versionNegotiation: {mode: 'auto'}` | stdio, HTTP | ok, negotiated `2026-07-28` | ok, `2026-07-28` |
| client v2 2.4.0, `versionNegotiation: {mode: {pin: '2026-07-28'}}` | stdio, HTTP | ok, `2026-07-28` | ok, `2026-07-28` |
| Claude Code 2.1.319 (`--mcp-config`, stdio and `type: http`) | stdio, HTTP | connected, era `modern` | connected, era `modern` |

Other findings:

- **The v2 client defaults to the legacy handshake.** `@modelcontextprotocol/client` 2.4.0 sends the 2025 `initialize` unless the caller opts into `versionNegotiation`. Any Tacet code that acts as an MCP client must set `mode: 'auto'` or pin `2026-07-28`.
- `@modelcontextprotocol/core` 2.4.0 still exports `LATEST_PROTOCOL_VERSION = "2025-11-25"` and `SUPPORTED_PROTOCOL_VERSIONS` back to `2024-10-07` for the legacy era. The modern revision list is separate. Do not read `LATEST_PROTOCOL_VERSION` as "newest spec".
- Legacy HTTP serving is stateless, so there are no server-to-client streams or sessions for 2025 clients. That is fine for Tacet, because `escalate` returns `pending` instead of blocking (ADR-003 section 6).
- **Support window: UNVERIFIED.** The SDK marks 2025-era vocabulary such as `RELATED_TASK_META_KEY` "deprecated ... kept importable for interoperability only". It states no removal date. The migration guide is on a host this environment cannot reach.

## Proposed requirement for #18 (owner decides)

1. The Mini-conductor MCP server **answers both** 2026-07-28 and 2025-era clients, using the SDK defaults (`serveStdio` with `legacy: 'serve'`, `createMcpHandler` with `legacy: 'stateless'`). This costs nothing extra: one factory, no second code path.
2. Tools must not depend on 2026-07-28-only features (`input_required` round trips, subscriptions) for core behaviour, because legacy clients cannot use them. `escalate` already returns `pending`.
3. Add a conformance test with three clients: SDK v1 (legacy), client v2 pinned to `2026-07-28`, and client v2 default. All three must list and call every tool.
4. Revisit when the SDK announces removal of legacy serving, or once every Worker host Tacet supports speaks 2026-07-28. Codex, Gemini CLI and OpenCode client revisions are still UNVERIFIED (spike #68). Until then, dropping legacy would risk locking those Workers out.
5. Any MCP client Tacet itself runs sets `versionNegotiation: { mode: 'auto' }`.
