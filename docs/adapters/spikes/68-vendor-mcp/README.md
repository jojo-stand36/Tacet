# Spike #68: per-vendor MCP client facts (revisions, config injection, timeouts)

Checked 2026-11-09. Follow-up from ADR-003 (UNVERIFIED list). Feeds adapter issues #12 to #15 and the Mini-conductor MCP server (#18).

## Headline

**All three vendors speak a 2025-era MCP revision by default.** The Mini-conductor MCP server must keep answering 2025-era `initialize` clients. That is the default behaviour of `@modelcontextprotocol/server` 2.4.0 ([spike #69](../69-mcp-backcompat/README.md)). Only Codex can speak 2026-07-28, and only behind an "under development" feature flag. Every vendor passed a per-session HTTP header (`X-Tacet-Token`) through to the server.

## Method

- Server: `harness/logsrv.mjs`, `@modelcontextprotocol/server` 2.4.0 via `createMcpHandler` with default (legacy-serving) options, on `127.0.0.1:8795`. It logs each request's user agent, `MCP-Protocol-Version` header, JSON-RPC method, `protocolVersion`, `clientInfo`, and whether `X-Tacet-Token` was present (the value is never logged). The factory logs the era it served. `harness/stdio-server.mjs` was used for the stdio checks.
- Clients ran with an isolated `HOME`/`CODEX_HOME` and dummy keys. No model calls: MCP servers connect at session or thread start.
  - Codex: `harness/codex-drive.mjs` drives `codex app-server` (`initialize`, `thread/start`, `mcpServerStatus/list`).
  - Gemini: `gemini mcp list`, and `harness/acp-drive.mjs` driving `gemini --experimental-acp` (`initialize`, `session/new` with `mcpServers`).
  - OpenCode: `opencode mcp list`.

| Client | Version (npm) |
|---|---|
| `@openai/codex` | 0.167.0 |
| `@google/gemini-cli` | 0.67.0 |
| `opencode-ai` | 1.19.5 |

## Results

### Codex 0.167.0

| Fact | Result | Source |
|---|---|---|
| Revision, default | `initialize` with `protocolVersion: "2025-06-18"` over HTTP and stdio; `clientInfo` `codex-mcp-client` / `0.167.0`; served by the legacy era | live |
| Revision, opt-in | `codex app-server --enable mcp_2026_07_28` sends `server/discover` with `2026-07-28` and the `MCP-Protocol-Version: 2026-07-28` header; served by the modern era. `codex features list` shows `mcp_2026_07_28` as **under development, default false**. Source: `McpProtocolMode` defaults to `Legacy`. | live; `codex-rs/rmcp-client/src/protocol_mode.rs`, `codex-rs/core/src/config/mod.rs` at `rust-v0.167.0` |
| Per-session config | (a) launch overrides: `codex app-server -c mcp_servers.<name>.url="..." -c mcp_servers.<name>.http_headers={"X-Tacet-Token"="..."}`; (b) **per thread**: `thread/start` `config: {mcp_servers: {<name>: {url, http_headers, tool_timeout_sec}}}`. Both connected with the header present. | live; `ThreadStartParams.config` in the 0.167.0 schema |
| Header options | `http_headers` (literal), `env_http_headers` (header → env var name), `bearer_token_env_var`, `http_headers_helper` (command) | `codex-rs/config/src/mcp_types.rs` (`RawMcpServerConfig`) |
| Timeouts | `startup_timeout_sec` (init + first tool list), default 30 s; `tool_timeout_sec`, default 300 s. No separate idle timeout found. | `codex-rs/codex-mcp/src/rmcp_client.rs` (`DEFAULT_STARTUP_TIMEOUT`, `DEFAULT_TOOL_TIMEOUT`), `mcp_types.rs` |
| Other behaviour | On an HTTP server without auth, Codex probes OAuth discovery URLs (`/.well-known/oauth-protected-resource...`, `/.well-known/oauth-authorization-server...`, `/.well-known/openid-configuration...`). Status reaches the client as `mcpServer/startupStatus/updated` (`starting` → `ready`). | live |

### Gemini CLI 0.67.0

| Fact | Result | Source |
|---|---|---|
| Revision | `initialize` with `protocolVersion: "2025-06-18"`, `clientInfo` `gemini-cli-mcp-client` / `0.67.0`, over HTTP and stdio; legacy era. (`gemini mcp list` uses a separate `mcp-test-client`.) | live |
| Per-session config | (a) **ACP**: `session/new` `mcpServers: [{type: "http", name, url, headers: [{name, value}]}]` connected with the header present; (b) `settings.json` `mcpServers.<name>` with `httpUrl` (streamable HTTP) or `url` (SSE), `headers` object, `timeout`, `trust`, `includeTools`/`excludeTools`. User or workspace scope (`.gemini/settings.json`). Headless `-p` has no MCP-config flag, only the `--allowed-mcp-server-names` filter. | live; package docs `bundle/docs/tools/mcp-server.md`, `bundle/docs/cli/cli-reference.md` (0.67.0) |
| Timeouts | Per-server `timeout` is the request timeout, default 600,000 ms (10 min). No idle timeout is documented. | `mcp-server.md` |
| Gotcha | With folder trust active, user-level MCP servers are suppressed in untrusted folders ("Disabled"). The docs say folder trust is off by default, but this run needed `security.folderTrust.enabled: false` before the server showed as connected. Tacet should inject servers through ACP `session/new` rather than rely on settings files. | live; `bundle/docs/cli/trusted-folders.md` |
| Env expansion | `$VAR`/`${VAR}` is documented for the `env` block. Whether `headers` values expand is not documented; UNVERIFIED. | `mcp-server.md` |

### OpenCode 1.19.5

| Fact | Result | Source |
|---|---|---|
| Revision | `initialize` with `protocolVersion: "2025-11-25"`, `clientInfo` `opencode` / `1.19.5`; legacy era | live |
| Per-session config | `OPENCODE_CONFIG_CONTENT` (inline JSON, a runtime override layer) with `mcp.<name>: {type: "remote", url, headers, enabled}` connected with the header present. `OPENCODE_CONFIG` (file path) is another layer. Headers support `{env:VAR}` substitution. | live; https://raw.githubusercontent.com/sst/opencode/v1.19.5/packages/web/src/content/docs/mcp-servers.mdx , `.../config.mdx` |
| Timeouts | `timeout` (ms) is for fetching tools, default 5000. Tool-call and idle timeouts are not documented: **UNKNOWN** (not in the docs at v1.19.5; source not read). | mcp-servers.mdx |

### ACP `session/new` headers

The ACP v1 schema defines `McpServerHttp` as `{name, url, headers: HttpHeader[]}` with `HttpHeader = {name, value}`. HTTP is only available when the agent advertises `mcpCapabilities.http`, and stdio is mandatory for every agent. Gemini 0.67.0 accepted an HTTP server with a header and forwarded it.

Source: https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json (`McpServer`, `McpServerHttp`, `HttpHeader`), plus the live Gemini run.

## Implications

- **#18:** answering 2025-era clients is required, not optional: Codex (default), Gemini and OpenCode all speak 2025-06-18 or 2025-11-25. Test against 2025-06-18 as well as 2025-11-25.
- **Escalation timeouts:** the shortest tool-call budget among the tested vendors is Codex's 300 s default. OpenCode's is unknown. `escalate` returning `pending` immediately (ADR-003 section 6) is still the right design. Adapters can raise Codex's limit with `tool_timeout_sec` per thread.
- **Injection per adapter:** Codex uses `thread/start.config.mcp_servers`; Gemini uses ACP `session/new.mcpServers`; OpenCode uses `OPENCODE_CONFIG_CONTENT` at `opencode serve` launch (per process, not per session); Claude uses `--mcp-config` / SDK `mcpServers`. The token goes in a header in every case.
- Codex probes OAuth discovery URLs on an unauthenticated HTTP server. The Tacet MCP endpoint should return a fast 404 for `/.well-known/*`.
