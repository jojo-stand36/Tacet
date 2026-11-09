# Adapter capability matrix

Verified facts about each agent surface Tacet can drive. Written for issue #8. Rules: see the `verify-vendor-facts` skill and `.github/instructions/adapters.instructions.md`.

- **Checked** date for every row is **2026-11-09** unless a row says otherwise.
- **Status**: `verified` = read in a primary source on the checked date. `UNVERIFIED` = not confirmed from a primary source; do not build on it. `PARTIAL` = some of it confirmed, remainder noted.
- Sources are paraphrased. Each row has its own link.
- No vendor CLI was installed in the research environment, so "version" means the version the docs or schema state, or the repo ref read. Adapter authors must re-pin against the version they install (Codex: `codex app-server generate-json-schema`; OpenCode: `GET /doc`).
- Network note: `developers.openai.com`, `openai.com`, `opencode.ai`, `geminicli.com` and `agentclientprotocol.com` did not resolve from the research environment. Codex, OpenCode and Gemini facts therefore come from the vendors' GitHub repos (source, schema, docs files), which are primary. Anything that exists only on the blocked sites is marked UNVERIFIED.

## 0. Version pins and reference points

| Surface | Reference read | Notes | Source |
|---|---|---|---|
| Claude Agent SDK (TS) | docs list SDK `0.3.282` as latest feature gate; SDK version tracks the bundled Claude Code (SDK 0.3.191 bundles Claude Code 2.1.191); `claude -p` doc mentions CLI up to `v2.1.302` | Package `@anthropic-ai/claude-agent-sdk`, bundles a native binary | https://code.claude.com/docs/en/agent-sdk/typescript |
| Codex app-server | `openai/codex` `main` as read 2026-11-09 (no release tag read) | Top-level `app-server` command is labelled `[experimental]` in the CLI source | https://raw.githubusercontent.com/openai/codex/main/codex-rs/cli/src/main.rs |
| OpenCode server | `sst/opencode` `dev` docs as read 2026-11-09; docs state bundled Claude plugins removed as of `1.3.0` | OpenAPI 3.1 at `/doc` | https://raw.githubusercontent.com/sst/opencode/dev/packages/web/src/content/docs/server.mdx |
| Gemini CLI | **Tested `@google/gemini-cli@0.67.0` (#63, 2026-11-09)** against a local mock API; earlier rows read `google-gemini/gemini-cli` `main` docs on 2026-11-09 | Individual free access moved to a separate "Antigravity CLI" on 2026-06-18 (see section 5) | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/README.md |
| ACP | Protocol version `1`; JSON Schema `schema/v1/schema.json` and `schema/v2` exist in the repo | Negotiated via `protocolVersion` in `initialize` | https://github.com/agentclientprotocol/agent-client-protocol |

## 1. Claude Code (Agent SDK and `claude -p`)

Two ways in: the Agent SDK (TS/Python, wraps the Claude Code binary) and the CLI `claude -p`. Both run the same agent loop.

| Capability | Fact | Status | Source |
|---|---|---|---|
| Surfaces / runtimes | TS package `@anthropic-ai/claude-agent-sdk` and a Python SDK. SDK `executable` option accepts `bun`, `deno` or `node` (auto-detected). `bun build --compile` needs `extractFromBunfs()` (v0.3.144+). Bundles a native Claude Code binary as an optional dependency; `pathToClaudeCodeExecutable` overrides it. | verified | https://code.claude.com/docs/en/agent-sdk/typescript , https://code.claude.com/docs/en/agent-sdk/overview |
| Streaming events | `query()` returns an async generator of `SDKMessage`. Option `includePartialMessages` adds partial-message (`stream_event`) messages. CLI: `--output-format stream-json --verbose --include-partial-messages` gives one JSON object per line; text deltas are `stream_event` with `event.delta.type == "text_delta"`. Subagent messages carry `parent_tool_use_id`. First event is `system/init` (model, tools, MCP servers, plugins, optional `capabilities[]` array for feature detection). `system/api_retry` is emitted before retries. Last line is a `result` message. | verified | https://code.claude.com/docs/en/headless , https://code.claude.com/docs/en/agent-sdk/typescript |
| Streaming input | SDK accepts `prompt: AsyncIterable<SDKUserMessage>` (multi-turn streaming input). `interrupt()`, `setModel()`, `setPermissionMode()` work in streaming input mode only. CLI flag `--input-format stream-json` is NOT mentioned on the pages read. | verified for SDK; CLI flag UNVERIFIED | https://code.claude.com/docs/en/agent-sdk/typescript |
| Tool approval hook | SDK `canUseTool(toolName, input, {signal, suggestions})` returns `{behavior:"allow", updatedInput}` or `{behavior:"deny", message}`. It fires only when the permission flow falls through to a prompt (not for allow rules or permission mode). Can stay pending indefinitely. `AskUserQuestion` also routes through it. `PreToolUse` hook can return `defer` so the process can exit and resume later. `PermissionRequest` hook exists. CLI: `--permission-prompt-tool` (MCP tool) and `--permission-prompts none` (v2.1.259+). In `-p` with no host, calls needing approval are denied. | verified | https://code.claude.com/docs/en/agent-sdk/user-input , https://code.claude.com/docs/en/headless |
| Permission modes | `permissionMode` incl. `default`, `acceptEdits`, `auto`, `dontAsk`, `plan`, `bypassPermissions` (needs `allowDangerouslySkipPermissions`). Since v2.1.302 `claude -p` starts in Manual mode if nothing sets a mode. | verified (names read on headless page and TS reference) | https://code.claude.com/docs/en/headless |
| Interrupt | SDK `Query.interrupt()` (streaming input only). On CLIs advertising `interrupt_receipt_v1` (v2.1.205+) it resolves to `{still_queued: string[], cancelled?: string[]}`; earlier CLIs resolve `undefined`. Resending a still-queued message that was not cancelled delivers it twice. CLI: SIGINT ends the turn; SIGTERM exits 143 and records no result for the in-flight turn. | verified | https://code.claude.com/docs/en/agent-sdk/typescript , https://code.claude.com/docs/en/headless |
| Resume / fork | `resume: <sessionId>`, `forkSession: true` (with resume, new session ID, original unchanged), `continue: true` (most recent in cwd). CLI `--continue`, `--resume <id or .jsonl path>`. Session ID is on `system/init` and every `result`. Transcripts at `~/.claude/projects/<encoded-cwd>/*.jsonl` (or `$CLAUDE_CONFIG_DIR`). Same machine only unless a `SessionStore` adapter is used. Sessions persist the conversation, not the filesystem. `persistSession: false` available (TS). | verified | https://code.claude.com/docs/en/agent-sdk/sessions |
| Token / context usage | Per-step usage on assistant messages (dedupe by message id; per-step `output_tokens` is a placeholder). `result` has cumulative `usage` (main loop only, excludes subagents), `total_cost_usd`, and `modelUsage` (per model, includes subagents). `Query.getContextUsage({detail:'summary'|'full'})` returns `totalTokens`, `maxTokens`, `percentage`, per-category tokens (`'full'` makes token-count API calls that are not billed; `detail` needs SDK 0.3.257+). Fallback is hook-based (`PreCompact`, statusline). | verified | https://code.claude.com/docs/en/agent-sdk/cost-tracking , https://code.claude.com/docs/en/agent-sdk/typescript |
| Model switching | `model` option at start; `Query.setModel(model?)` mid-session (streaming input only; applies from the next model call; `undefined`/`"default"` resets); `supportedModels()`; `fallbackModel` option. CLI: model set at launch, `/model <x>` accepted in `-p` as prompt text. | verified | https://code.claude.com/docs/en/agent-sdk/typescript , https://code.claude.com/docs/en/headless |
| Cost reporting | `total_cost_usd` and per-model `costUSD` on `result`; both are client-side estimates from a bundled price table and the docs say not to bill end users from them. Resumed sessions report the whole session total (since v2.1.277), so do not sum across resumes. `maxBudgetUsd` / `--max-budget-usd` cap. | verified | https://code.claude.com/docs/en/agent-sdk/cost-tracking |
| Auth modes | API key (`ANTHROPIC_API_KEY`, Console), Amazon Bedrock, Google Cloud Agent Platform (Vertex), Microsoft Foundry, or the user's own Claude login in the unmodified binary. `--bare` mode never reads OAuth credentials or the keychain and needs an API key / helper / cloud provider creds; `--bare` is recommended for scripted calls and "will become the default for `-p`". | verified | https://code.claude.com/docs/en/headless , https://code.claude.com/docs/en/agent-sdk/overview |

### Claude terms relevant to Tacet's hard rule

| Topic | Fact | Status | Source |
|---|---|---|---|
| OAuth / subscription tokens | OAuth is for Free/Pro/Max/Ultra/Team/Enterprise plans for ordinary use of Claude Code and native Anthropic apps. Developers building products on the Agent SDK should use API-key auth (Console or a cloud provider). Anthropic does not permit third parties to offer Claude.ai login or route requests through plan credentials on users' behalf, and developers may not collect, store or intermediate Claude.ai credentials or session tokens. | verified | https://code.claude.com/docs/en/legal-and-compliance |
| End user running the real binary | The same page says it does not prevent an end user signing in to the unmodified Claude Code binary with their own subscription, including where a platform hosts Claude Code. Conditions for embedding Claude Code: binary unmodified, no removal of its auth methods, no paying for / reselling / intermediating usage for end users; each end user authenticates themselves. | verified | https://code.claude.com/docs/en/legal-and-compliance |
| SDK overview note | Unless previously approved, Anthropic does not allow third-party developers to offer claude.ai login or its rate limits in products, including agents built on the Agent SDK; use API-key auth. | verified | https://code.claude.com/docs/en/agent-sdk/overview |
| Branding | Products using the SDK must not be named "Claude Code" or mimic it; "Claude Agent" or "Powered by Claude" are allowed. Tacet should label the adapter "Claude" or "Claude Agent". | verified | https://code.claude.com/docs/en/agent-sdk/overview |
| Subscription billing of `claude -p` / SDK | Help Center article (updated notes dated 2026-06-15 and 2026-10-07): when signed in with a Claude plan, `claude -p` and the Agent SDK still draw from the plan's usage limits. The June change that would have moved this to a separate credit pool is described as **paused**, with no resume date. Max/Ultra/Team plans have monthly API credits, but only usable by the SDK / `claude -p` through an API key from a linked Console organization. Pro and Enterprise not eligible per the search summary of a second help article (not fetched directly). Page shows only a relative "updated" time. | verified (article read) / second article UNVERIFIED | https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan , https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans |

**Conflict (resolved 2026-11-09):** `docs/RESEARCH.md` section 7 said `claude -p` / Agent SDK usage moved to a separate credit pool from 2026-06-15. The primary help article now says that change is paused and subscription-login usage still draws from plan limits. RESEARCH section 7 was stale on this point and was corrected on 2026-11-09.

**Design rule that follows:** Tacet never touches OAuth tokens. For Claude it launches the user's own `claude` (their login) or passes `ANTHROPIC_API_KEY` from the environment. Whether a Tacet-hosted multi-user service may run subscription logins is out of scope (Tacet is local-first, single user); the owner's setup (own subscription login plus an API key with a $200/month budget) and the default routing are recorded in `docs/RESEARCH.md` section 7. Default: API key for parallel or unattended Workers, subscription login for interactive or single sessions, unless the owner overrides. Whether the "ordinary, individual usage" language covers many parallel Workers on one plan is still UNVERIFIED and `needs-human` (see Gaps, item 9).

## 1b. MCP client facts (ADR-003 section 6)

Facts the mini-conductor's MCP server depends on. Source: the "Verified protocol facts" table in [ADR-003](../adr/003-wire-protocols.md), checked 2026-11-09 from the MCP and Claude Code docs. Re-check before MCP work in M1.

| Capability | Fact | Status | Source |
|---|---|---|---|
| MCP spec revision | Latest is `2026-07-28`. It is stateless: no `initialize` handshake and no `Mcp-Session-Id`. `server/discover` is mandatory, and each request carries its protocol version and capabilities in `_meta`. Tools keep `inputSchema`/`outputSchema`, `structuredContent`, `isError` and `annotations`. Roots, sampling and logging are deprecated. | verified (ADR-003 check) | https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx |
| Claude Code transports | stdio, HTTP, SSE (deprecated) and WebSocket. `.mcp.json` `headers` support `${VAR}` expansion. | verified (ADR-003 check) | https://code.claude.com/docs/en/mcp |
| Claude Code tool-call timeout | `MCP_TOOL_TIMEOUT` or per-server `timeout`; defaults to about 28 h. | verified (ADR-003 check) | https://code.claude.com/docs/en/mcp |
| Claude Code idle timeout | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` defaults to 5 min for HTTP and 30 min for stdio. This is why `escalate` returns `pending` instead of blocking (ADR-003 section 6). | verified (ADR-003 check) | https://code.claude.com/docs/en/mcp |
| Claude Code MCP protocol version | The v2 runtime negotiates `2026-07-28` with servers that support it. Otherwise it "connects as v1 does". | verified (ADR-003 check) | https://code.claude.com/docs/en/mcp |
| Claude Agent SDK in-process MCP | TS: `createSdkMcpServer()` and `tool()` with zod schemas and `annotations`. | verified (ADR-003 check) | https://code.claude.com/docs/en/agent-sdk/typescript |
| Codex, Gemini CLI, OpenCode MCP | Revisions spoken, per-session config injection (including headers) and idle or tool-call timeouts. | UNVERIFIED (roadmap spikes) | n/a |

## 2. Codex app-server (JSON-RPC)

Read from the `openai/codex` repo (source and generated schema), because `developers.openai.com` was unreachable.

| Capability | Fact | Status | Source |
|---|---|---|---|
| Transport | `codex app-server --listen <URL>`: `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`. `--stdio` is shorthand. The `app-server` command is marked `[experimental]` in the CLI help. | verified | https://raw.githubusercontent.com/openai/codex/main/codex-rs/cli/src/main.rs |
| Schema export | `codex app-server generate-ts -o DIR [--prettier BIN] [--experimental]` and `codex app-server generate-json-schema -o DIR [--experimental]`; both marked `[experimental]`. `--experimental` includes experimental methods/fields. | verified | same as above |
| Handshake | `initialize` request then `initialized` notification. `initialize.capabilities.experimentalApi` is required for experimental methods and notifications. | verified | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md , https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/common.rs |
| Streaming events | Notifications: `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`, `turn/diff/updated`, `turn/plan/updated`, `thread/status/changed`, `error`, `serverRequest/resolved`. Several others are marked experimental or deprecated (e.g. `item/fileChange/outputDelta` deprecated). | verified | common.rs (above) |
| Tool approval | Server-initiated JSON-RPC requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput` (experimental), `mcpServer/elicitation/request`, `item/tool/call` (dynamic tool executed by client). Deprecated: `applyPatchApproval`, `execCommandApproval`. For the "human command checkpoint" variant, valid replies are `accept`, `decline`, `cancel`. Full decision enum for ordinary approvals NOT read. `turn/start` can override `approvalPolicy` and `approvalsReviewer` (`user`, `auto_review`, `guardian_subagent`). `AskForApproval` values seen: `untrusted`, `on-request`, `never`, `granular`. | PARTIAL (decision enum UNVERIFIED) | common.rs , app-server README , `codex_app_server_protocol.v2.schemas.json` on `main` |
| Interrupt / steer | `turn/interrupt` and `turn/steer` request methods exist. Payload shape not read. | PARTIAL | common.rs |
| Resume / fork | `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, `thread/revert`, `thread/archive`, `thread/compact/start`. `thread/started` carries `forkedFromId` on forks. `thread/rollback` was removed. | verified | common.rs , app-server README |
| Token / context usage | Notification `thread/tokenUsage/updated` with `tokenUsage: {total, last, modelContextWindow?}`; each breakdown has `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningOutputTokens`, `totalTokens`, optional `cacheWriteInputTokens`. This gives both used and max context, so the context-band logic works. Also `account/rateLimits/read` and `account/rateLimits/updated`, `account/usage/read`. | verified | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/json/v2/ThreadTokenUsageUpdatedNotification.json |
| Model switching | `turn/start` params include `model`, `effort`, `summary`, `serviceTier`, `cwd`, `approvalPolicy`, `sandboxPolicy`, `outputSchema`; required: `threadId`, `input`. Model is therefore overridable per turn (and "and later turns" for policy fields). `model/list` lists models. | verified | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/json/v2/TurnStartParams.json |
| Cost reporting | No USD cost field found in the token usage notification. Cost would have to be computed by Tacet from tokens and a price table. | verified absence in the notification read; a cost field elsewhere is UNVERIFIED | ThreadTokenUsageUpdatedNotification.json |
| Auth modes | `account/login/start` variants: `apiKey`, `chatgpt` (browser flow), `chatgptDeviceCode`, `chatgptAuthTokens` (marked unstable, OpenAI internal use only), `amazonBedrock`, `amazonBedrockAccessKeys` (unstable). Server may request `account/chatgptAuthTokens/refresh` from the client. `AuthMode` values: `apikey`, `chatgpt`, `chatgptAuthTokens`, `headers`, `agentIdentity`, `personalAccessToken`, `bedrockApiKey`, `bedrockAccessKeys`. | verified | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/json/v2/LoginAccountParams.json |
| Terms | Search-result snippets of the OpenAI developer docs say app-server built-in ChatGPT auth is not permitted for commercial or hosted services, and an OpenAI page describes ChatGPT-plan use by open-source third-party clients. The pages could not be fetched. | **UNVERIFIED** | search only (developers.openai.com blocked) |

**Design rule that follows:** never implement `chatgptAuthTokens` (it would mean Tacet handing ChatGPT tokens to Codex, violating the hard rule). Let `codex` own login (`chatgpt`/`chatgptDeviceCode` happen inside the Codex process) or use an API key from the environment.

## 3. OpenCode server (HTTP + SSE)

| Capability | Fact | Status | Source |
|---|---|---|---|
| Run / transport | `opencode serve [--port --hostname --mdns --cors]`; default `127.0.0.1:4096`. HTTP basic auth via `OPENCODE_SERVER_PASSWORD` (username default `opencode`, override `OPENCODE_SERVER_USERNAME`). Tacet must set a password; unauthenticated by default is not acceptable under the 127.0.0.1-plus-token rule. | verified | https://raw.githubusercontent.com/sst/opencode/dev/packages/web/src/content/docs/server.mdx |
| API description | `GET /doc` serves OpenAPI 3.1. JS SDK `@opencode-ai/sdk` (`createOpencode`, `createOpencodeClient({baseUrl})`); structured output only in `@opencode-ai/sdk/v2`. | verified | server.mdx , https://raw.githubusercontent.com/sst/opencode/dev/packages/web/src/content/docs/sdk.mdx |
| Streaming events | `GET /event` (SSE; first event `server.connected`, then bus events) and `GET /global/event`. SDK `event.subscribe()` yields `{type, properties}`. Event type names and payloads NOT read. | PARTIAL (event names UNVERIFIED) | server.mdx , sdk.mdx |
| Tool approval | `POST /session/:id/permissions/:permissionID` with `response` (+ optional `remember`). Permission rule actions: `allow`, `ask`, `deny`; UI answers are `once`, `always`, `reject`. How the ask is announced over SSE and the exact `response` enum on the endpoint are NOT confirmed. | PARTIAL | server.mdx , https://raw.githubusercontent.com/sst/opencode/dev/packages/web/src/content/docs/permissions.mdx |
| Interrupt | `POST /session/:id/abort` returns a boolean. | verified | server.mdx |
| Prompting | `POST /session/:id/message` (waits for reply) and `POST /session/:id/prompt_async` (204). | verified | server.mdx |
| Resume / fork | Sessions persist server-side: `GET /session`, `GET /session/:id`, `POST /session/:id/fork` (optional `messageID`), `POST /session/:id/revert` / `unrevert`, `POST /session/:id/summarize`, `GET /session/status`. | verified | server.mdx |
| Token / context usage | Not stated in the docs pages read. Likely on message info in the OpenAPI spec, but I could not read the spec. | **UNVERIFIED** | n/a |
| Model switching | `model` object `{providerID, modelID}` on each prompt body; `/command` and `/shell` accept `model` too. So per-prompt switching. | verified | sdk.mdx , server.mdx |
| Cost reporting | Not stated in the docs pages read. | **UNVERIFIED** | n/a |
| Auth modes | Provider credentials set via `PUT /auth/:id`, `GET /provider/auth`, OAuth authorize/callback endpoints; `/connect` in the TUI. Supports Anthropic Console API key, OpenAI via ChatGPT Plus/Pro browser login or API key, GitHub Copilot device login. | verified | server.mdx , https://raw.githubusercontent.com/sst/opencode/dev/packages/web/src/content/docs/providers.mdx |
| Terms | OpenCode's own docs say plugins that use Claude Pro/Max models in OpenCode are explicitly prohibited by Anthropic, and the bundled plugins were removed as of 1.3.0. Tacet must not enable Claude subscription logins through OpenCode. | verified (as OpenCode's statement; consistent with the Anthropic terms above) | providers.mdx |

**Design rule that follows:** if Tacet launches OpenCode, the adapter must refuse to configure the Anthropic subscription route and should only pass through whatever provider auth the user has set up themselves. Tacet does not call `PUT /auth/:id` with anything it did not get from the user's environment.

## 4. Generic ACP (Agent Client Protocol)

Read from the `agentclientprotocol/agent-client-protocol` repo schema `schema/v1/schema.json` (protocol version 1). `agentclientprotocol.com` was unreachable, so prose docs (flow, semantics) were not read.

| Capability | Fact | Status | Source |
|---|---|---|---|
| Transport / SDKs | JSON-RPC over stdio. Official SDKs: TypeScript (`@agentclientprotocol/sdk`), Python, Rust, Kotlin, Java. Apache-2.0. | verified (SDK list) / stdio framing UNVERIFIED in this pass | https://github.com/agentclientprotocol/agent-client-protocol |
| Methods | Agent side: `initialize`, `authenticate`, `logout`, `session/new`, `session/load`, `session/list`, `session/delete`, `session/resume`, `session/close`, `session/set_mode`, `session/set_config_option`, `session/prompt`. Client side: `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/release`, `terminal/wait_for_exit`, `terminal/kill`, `elicitation/create`. Cancellation: `session/cancel` is referenced in the schema text and `$/cancel_request` exists; exact semantics not read. | verified (names) | https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json |
| Streaming events | Notification `session/update` with `sessionUpdate` kinds: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`, `notice`, `compaction_update`, `compaction_summary_chunk`. Stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`. | verified | schema.json (above) |
| Tool approval | Client-side method `session/request_permission`; option kinds `allow_once`, `allow_always`, `reject_once`, `reject_always`. | verified | schema.json |
| Interrupt | `session/cancel` (stop reason `cancelled`). | PARTIAL (name seen in schema text, flow not read) | schema.json |
| Resume / fork | `session/load`, `session/resume`, `session/list`, `session/close`, `session/delete`, gated by agent `sessionCapabilities` (`resume`, `list`, `close`, `delete`) and `loadSession`. **No fork method in schema v1.** Whether another stability tier (RFD/unstable) offers fork was not checked. | verified (no fork in v1 schema) | schema.json |
| Token / context usage | `usage_update` carries `used` (tokens in context), `size` (context window) and optional `cost {amount, currency}`. Agent-optional; there is no guarantee every agent sends it. | verified | schema.json |
| Model switching | Via `session/set_config_option` with option category `model` (and `model_config`). A dedicated `session/set_model` is not in the v1 schema. Agent must advertise such an option. | verified | schema.json |
| Cost reporting | Optional `cost` inside `usage_update`. | verified | schema.json |
| Auth modes | `authenticate` / `logout` methods with agent-advertised auth methods; actual credentials are the agent's business (each ACP agent uses its own login or key). | PARTIAL | schema.json |
| Per-agent notes | Gemini CLI speaks ACP with `--experimental-acp` (see section 5). The Claude and Codex ACP adapters named in `docs/RESEARCH.md` were not re-verified in this pass. | PARTIAL | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/cli-reference.md |

## 5. Gemini CLI

| Capability | Fact | Status | Source |
|---|---|---|---|
| Headless | `gemini -p "<prompt>"`; also auto-headless in a non-TTY. `--output-format` is `text` (default), `json`, or `stream-json`. | verified | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/headless.md , https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/cli-reference.md |
| Streaming events | `stream-json` is JSONL with event types `init` (session id, model), `message`, `tool_use`, `tool_result`, `error` (non-fatal), `result` (final outcome, aggregated stats and per-model token usage). | verified | headless.md |
| Token usage | Headless: only at the end. `json` `stats.models.<model>.tokens` = `input, prompt, candidates, total, cached, thoughts, tool` (+ `api`, `roles`, `tools`, `files`); `stream-json` `result.stats` = `total_tokens, input_tokens, output_tokens, cached, input, duration_ms, tool_calls, models.<model>.*`. No context size. Over ACP: live `usage_update` (`used`, `size`, no cost). | verified (0.67.0, #63) | [spike #63](spikes/63-gemini/README.md) |
| Tool approval | Headless: no round trip; `ask_user` = deny, and the tool is excluded (`tool_result.error.type: tool_not_registered`) under `default`, `auto_edit`, `plan`; only `yolo` (or policy `allow`) runs it. ACP: `session/request_permission` with options `proceed_always` (allow_always), `proceed_once` (allow_once), `cancel` (reject_once); no reject_always. | verified (0.67.0 live, #63) | [spike #63](spikes/63-gemini/README.md) , policy-engine.md |
| Interrupt | Headless: kill the process. Exit codes: `0` ok, `1` error, `42` input error, `53` turn limit. Over ACP: `session/cancel`. | verified (exit codes) | headless.md |
| Resume / fork | `--resume`/`-r` accepts `latest` or an index; `--list-sessions`; `--delete-session`. No fork flag found. | verified | cli-reference.md |
| Model switching | `--model`/`-m` at launch (default `auto`; aliases `pro`, `flash`, `flash-lite`). Mid-session switching not found. | verified (launch-time only) | cli-reference.md |
| Cost reporting | No USD cost in the documented output. | UNVERIFIED (absent in pages read) | headless.md |
| ACP | `--experimental-acp` starts ACP mode (marked experimental; there is no `--acp` flag on the page). | verified | cli-reference.md |
| Auth modes | Sign in with Google (OAuth; `GOOGLE_CLOUD_PROJECT` for paid Code Assist), Gemini API key (`GEMINI_API_KEY`), Vertex AI (`GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI=true`). | verified | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/README.md |
| Product change | README states free individual access and Google AI Pro/Ultra use moved to "Antigravity CLI" on 2026-06-18; Gemini CLI now targets Code Assist Standard/Enterprise and Code Assist for GitHub users. 0.67.0 README: unpaid tier and Google One users were replaced by Antigravity CLI; the bundled quota doc still lists a free Google-login tier (stale); ACP still offers `oauth-personal`. Whether free personal login works is UNVERIFIED (needs a Google account; blog host blocked). | verified (statement) / behaviour UNVERIFIED | README.md , [spike #63](spikes/63-gemini/README.md) |
| Terms | Accessing the services behind Gemini CLI (e.g. Code Assist) through third-party software, tools or services is stated to violate applicable terms and may lead to account suspension; OpenClaw with Gemini CLI OAuth is the cited example. Which ToS applies depends on auth type (Google ToS, Cloud ToS, Gemini API ToS, Vertex terms). | verified | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/resources/tos-privacy.md |

**Design rule that follows:** Tacet launches the real `gemini` binary (or API key / Vertex env). It must never extract the Gemini CLI OAuth credential file and call Google services directly.

## 6. Cross-surface comparison (summary)

Derived from the tables above. Blank-free: `?` means UNVERIFIED.

| Capability | Claude SDK | Codex app-server | OpenCode server | ACP (v1) | Gemini CLI |
|---|---|---|---|---|---|
| Structured stream | yes (`stream-json`, SDK msgs) | yes (JSON-RPC notifications) | yes (SSE, names ?) | yes (`session/update`) | yes (`stream-json`) |
| Mid-run approval round-trip | yes (`canUseTool`) | yes (server requests) | yes (POST permission) | yes (`session/request_permission`) | ACP only; headless none |
| Interrupt | `interrupt()` with receipt | `turn/interrupt` | `POST abort` | `session/cancel` | kill process |
| Resume | yes | yes | yes | if agent advertises | yes (`--resume`) |
| Fork | yes | yes | yes (at message) | no in v1 schema | no |
| Context used + max live | `getContextUsage()` | `tokenUsage` + `modelContextWindow` | ? | `usage_update` (optional) | final stats only |
| Cost USD | estimate on `result` | none found | ? | optional | none found |
| Switch model mid-session | `setModel()` | per `turn/start` | per prompt | config option (if offered) | launch only |
| Runtime needs | Node, Bun or Deno; Python SDK too | any (stdio JSON-RPC; TS types generated) | any (HTTP; JS SDK) | TS/Python SDKs | any (spawn + parse JSONL) |

## 7. Implications for `AgentAdapter` and `AgentEvent` (from this matrix)

Sketch in `docs/ARCHITECTURE.md` section 3. Not edited here; for the architect/ADR owner.

- `usage` event: `contextMax` is not always known and `costUsd` is usually an estimate or absent. Make `contextUsed`, `contextMax`, `costUsd` optional and add `source: "reported" | "estimated"`. `capabilities()` should say whether live context usage exists (Gemini: no).
- Interrupt is not uniform: Claude returns queued message IDs, others return nothing. `interrupt()` should return `{ stillQueued?: string[] }` or the Mini-conductor must track queued input itself.
- `approval.request` must carry a vendor-neutral option set. Claude gives allow/deny with optional `updatedInput` and permission-rule suggestions; ACP gives allow_once/allow_always/reject_once/reject_always; Codex gives accept/decline/cancel (plus more, UNVERIFIED). `Decision` needs `allow_once | allow_always | reject | cancel` plus an optional input patch.
- Fork is a real capability bit; Gemini and ACP v1 lack it. Emulation (start a new session with a HandoffPacket) is already the plan and should be the fallback.
- Model switching differs (per turn, per prompt, mid-session, launch only), so `SessionOptions.model` and `send(..., {model?})` both need to exist, and `capabilities()` must say which are honoured.
- A non-streaming-approval surface (Gemini headless) means approvals have to be pre-decided by `--approval-mode` or the PTY+hooks adapter must be used; capability `approvals: "none"`.
- Claude-specific: `result` fires per turn in streaming-input mode and `total_cost_usd` is cumulative for the call; the adapter must take the latest, not sum.

## Gaps and follow-up issues

Titles are proposals; no GitHub issues have been created. Label suggestions follow `AGENTS.md` (`agent:claude` for research).

Roadmap status (2026-11-09): items 1 to 7, 9, 10 and 11 are tracked in `roadmap/issues.json`, and the ADR-002 and ADR-003 UNVERIFIED items are added there too. Item 8 is done. GitHub issues are created by the owner.

1. **Verify Codex approval decision enums and `turn/interrupt` payload from the installed schema** - run `codex app-server generate-json-schema` on a pinned version and record decision values for command, file-change and permissions approvals.
2. **Pin and test a Codex version, and read the official app-server docs and auth/terms pages** - `developers.openai.com` was unreachable; confirm the commercial/hosted-use language and `chatgptAuthTokens` restriction from the primary page.
3. **Capture OpenCode event types, permission SSE event and token/cost fields from `GET /doc`** - run `opencode serve`, dump the OpenAPI spec and the SSE event union, record versions.
4. **Verify ACP prose semantics and unstable features** - read the ACP site for `session/cancel` flow, stdio framing, any fork/`session/set_model` RFDs, and which agents emit `usage_update`.
5. **Verify the Claude and Codex ACP adapters named in RESEARCH (Zed adapter, `codex-acp`)** - versions, which capabilities they pass through, whether they depend on subscription logins.
6. **Done 2026-11-09 (#63): Gemini 0.67.0 stats fields, headless approvals (none: ask = deny) and ACP permission flow verified with fixtures.** Free personal Google login status still UNVERIFIED. See [`spikes/63-gemini/`](spikes/63-gemini/README.md).
7. **Claude `claude -p --input-format stream-json` and `--permission-prompt-tool` contract** - page read did not document the CLI input format; confirm from the CLI reference and decide CLI vs SDK for the Claude adapter.
8. **Done 2026-11-09: `docs/RESEARCH.md` section 7 corrected on the Agent SDK credit change.** Original note - primary help article says the 2026-06-15 change is paused and subscription logins still draw plan limits; re-check before each release.
9. **Human decision (`needs-human`): is a Conductor running many parallel Claude Workers on one subscription within "ordinary, individual usage"?** - the legal page limits advertised limits to ordinary individual use; get a ruling. The owner set the default routing to API keys for parallel or unattended Workers on 2026-11-09, but the ruling is still open.
10. **Add the shared adapter conformance fixtures plan** - record real-session fixtures per surface (stream, approval, interrupt, usage) so CI never calls vendors live.
11. **Pin matrix versions in CI** - add a check that fails when a recorded "Checked" date is older than N days for surfaces under active development.
