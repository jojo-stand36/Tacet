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

## API-key-only use, verified live (#145, 2026-11-10)

Observed by hand on 2026-11-10 unless a test is named. Both adapters were run with a login of the user's own already in place: a `claudeAiOauth` entry in `~/.claude/.credentials.json`, and a ChatGPT login in `~/.codex/auth.json`. Each ran against a local mock of its vendor API that records which credential each request carried, without keeping the values. Versions were `@agentclientprotocol/claude-agent-acp` 0.101.0 (Agent SDK 0.3.318) and `@agentclientprotocol/codex-acp` 2.6.0 (Codex 0.166.0). 0.101.1 is newer than the repo's minimum release age, so it was not used.

To reproduce the observations, run each adapter without its spec's `home` and with a temporary `HOME` holding a fake login, as in the test below.

- **claude-agent-acp** with `--hide-claude-auth` and `ANTHROPIC_API_KEY`: every request carried the key (tested). It never used the stored login and never changed it. Pointed at the user's own config dir, it writes there anyway: `~/.claude.json`, a backup of it, transcripts and a plugin store. Tacet therefore gives it a config dir of its own (`CLAUDE_CONFIG_DIR`, under the repo's state dir).
- **codex-acp** `api-key` auth must not be used. It runs Codex's `account/login/start {type: apiKey}`, which **replaced the user's ChatGPT login in `~/.codex/auth.json` with the API key, written to disk**. With the user's `~/.codex` it also synced a plugin marketplace from GitHub into `~/.codex/.tmp/plugins`. Tacet instead gives it a `CODEX_HOME` of its own, whose `config.toml` selects a model provider with `env_key = "OPENAI_API_KEY"`, sets `[features] plugins = false`, and keeps both key variables from shell commands (`[shell_environment_policy] exclude`), as the native adapter does. It then never calls `authenticate`. With this config, sessions start, every request carried the key, no `auth.json` was written, and the whole fake `HOME` tree stayed byte-identical (tested).
- **Session modes.** Both adapters start sessions in a mode that runs tools without asking. claude-agent-acp starts in `auto` ("Claude handles permission decisions"); Tacet sets `default` ("Manual: always ask before making changes"), and then every tool call sent `session/request_permission`. codex-acp starts in `agent` ("Auto review"). Its other modes are `read-only`, `workspace-write` and `agent-full-access`. All but full access use Codex's `on-request` approval policy (shipped `AgentMode` presets), so Codex asks only when a command leaves the sandbox. In a `read-only` session, an edit the model did not mark for escalation sent no approval request. Tacet sets `workspace-write`, the native adapter's default. A command sent with `sandbox_permissions: "require_escalated"` then asked first. Both modes are offered both as `modes` and as a `mode` config option. The adapter sets the mode right after the session opens, and fails the start if the agent does not offer it or does not report the switch. Tested: P0 conformance, with the approval probe passing for both, and a control in which claude-agent-acp without its mode ran the tool unasked. The mode can change during a session: claude-agent-acp offers mode changes as `allow_always` options (Edit/Write: `acceptEdits`; ExitPlanMode: "Yes, and use auto mode"). So with a pinned mode the adapter answers "always" once. If the agent reports another mode (`current_mode_update`, or the `mode` entry of `config_option_update`), the adapter sets the pinned mode back, or ends the session if it can't (fake-agent tests).
- **Keys and tools:** a command codex-acp's Codex ran saw neither `OPENAI_API_KEY` nor `CODEX_API_KEY` (live test). claude-agent-acp's Bash tool still sees `ANTHROPIC_API_KEY` until the Claude subprocess scrub is decided (#150).

Tests: `packages/adapters/acp/src/vendor-acp.conformance.test.ts` (P0 conformance plus isolation, for each adapter).

## Implications

- If Tacet uses ACP for Claude or Codex, these adapters give resume, fork, permissions and live token usage. They do not give cost, so Tacet computes cost from tokens. The native routes ([#64 Agent SDK](../64-claude/README.md), [#58 app-server](../58-codex/README.md)) expose more: Claude's cost estimate and interrupt receipts, and Codex's `turn/steer` and full approval enums. **The native adapters stay first choice, and the ACP adapters are the fallback.**
- `codex-acp` pins `@openai/codex ^0.166.0`, one minor behind the 0.167.0 tested in #58. Record the resolved Codex version when using it.
- Both adapters pin their own copy of the vendor SDK or CLI. Tacet should not assume they match a separately installed `claude` or `codex`.
