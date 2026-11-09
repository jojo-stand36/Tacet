# Spike #62: the Claude and Codex ACP adapters

Checked 2026-11-09. Closes gap 5 in [`capability-matrix.md`](../../capability-matrix.md).

## Versions and sources

Both adapters moved from `zed-industries` to the `agentclientprotocol` GitHub org. The old npm names are deprecated: their npm `deprecated` field says to migrate.

| Adapter | Current package | Version tested | Wraps | Old names (deprecated) |
|---|---|---|---|---|
| Claude | `@agentclientprotocol/claude-agent-acp` ([repo](https://github.com/agentclientprotocol/claude-agent-acp)) | 0.101.1 (npm `latest`) | `@anthropic-ai/claude-agent-sdk` 0.3.319 (pinned exactly), `@agentclientprotocol/sdk` 2.5.0 | `@zed-industries/claude-code-acp` 0.16.2, `@zed-industries/claude-agent-acp` 0.23.1 |
| Codex | `@agentclientprotocol/codex-acp` ([repo](https://github.com/agentclientprotocol/codex-acp)) | 2.6.0 (npm `latest`) | `@openai/codex` `^0.166.0` (resolved 0.166.0); `CODEX_PATH` overrides the binary. Talks to Codex app-server via `vscode-jsonrpc` | `@zed-industries/codex-acp` 0.16.0 |

Method: `npm view` for metadata; installed both and captured a live ACP `initialize` (`fixtures/`, with the harness from [spike #61](../61-acp/README.md)); read each package README and searched the shipped `dist/` for emitted updates and auth methods. No model calls were made.

## Capabilities passed through (`initialize`, protocol version 1)

| | claude-agent-acp 0.101.1 | codex-acp 2.6.0 |
|---|---|---|
| `loadSession` | yes | yes |
| `sessionCapabilities` | `resume`, `fork` (unstable), `list`, `close`, `delete`, `additionalDirectories`, `systemPrompt` (override) | `resume`, `fork` (unstable), `list`, `close`, `delete`, `title`, `additionalDirectories`, `subagents`, `systemPrompt` |
| `mcpCapabilities` | http, sse | http only (`sse: false`, `acp: false`) |
| Permissions | `session/request_permission` (README: "Tool calls (with permission requests)") | `session/request_permission` (in shipped code) |
| `usage_update` | yes: `used` (last assistant total usage), `size` (context window); **no cost** | yes: `used`, `size`; **no cost** |
| Extras | `_meta.claudeCode.promptQueueing: true` | rate-limit tracking (`handleRateLimitsUpdated`) |

Usage and permission facts come from the shipped `dist/` code, not from live turns.

## Auth and subscription-login dependence

| Adapter | Auth methods | Subscription login? |
|---|---|---|
| claude-agent-acp | Terminal auth methods, offered only when the client advertises terminal auth: **"Claude Subscription"** (`claude-ai-login`, runs `--cli auth login --claudeai`) and "Anthropic Console" (`console-login`, `--cli auth login --console`). Remote/SSH sessions get a `claude /login` method instead. Plus gateway methods if the client opts in. `--hide-claude-auth` hides the subscription option. With no terminal-auth capability the list was empty (live). | **Yes, optionally.** The login runs inside the bundled Claude Code binary, so the adapter itself does not read the token. It also works with `ANTHROPIC_API_KEY`. |
| codex-acp | `api-key` (via `CODEX_API_KEY` or `OPENAI_API_KEY`) and `chat-gpt` (ChatGPT login; `NO_BROWSER=1` hides it); custom gateway if the client opts in (live + README) | **Yes, optionally.** ChatGPT login is handled by the Codex process. |

### Terms (needs-human)

- **Claude:** Anthropic's Agent SDK overview says third-party developers may not offer claude.ai login in products built on the Agent SDK unless previously approved. The legal page also says an end user may sign in to the unmodified Claude Code binary themselves (see matrix section 1). `claude-agent-acp` is an Agent SDK product that offers a "Claude Subscription" login. If Tacet launches it under a subscription login, that falls under the same unresolved question as #65 (many parallel Workers on one plan). **needs-human.** The safe default is API key only, launched with `--hide-claude-auth`.
- **Codex:** ChatGPT login through a third-party ACP client is the commercial/hosted-use question from #59, which is UNVERIFIED because `developers.openai.com` is blocked. **needs-human.** The safe default is API key only, with `NO_BROWSER=1` set so the ChatGPT method is hidden.

## Implications

- If Tacet uses ACP for Claude or Codex, these adapters give resume, fork, permissions and live token usage. They do not give cost, so Tacet computes cost from tokens. The native routes ([#64 Agent SDK](../64-claude/README.md), [#58 app-server](../58-codex/README.md)) expose more: Claude's cost estimate and interrupt receipts, and Codex's `turn/steer` and full approval enums. **The native adapters stay first choice, and the ACP adapters are the fallback.**
- `codex-acp` pins `@openai/codex ^0.166.0`, one minor behind the 0.167.0 tested in #58. Record the resolved Codex version when using it.
- Both adapters pin their own copy of the vendor SDK or CLI. Tacet should not assume they match a separately installed `claude` or `codex`.
