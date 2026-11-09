# Spike #64: Claude CLI stream-json input, permission-prompt contract, CLI vs SDK

Checked 2026-11-09. Closes gap 7 in [`capability-matrix.md`](../../capability-matrix.md).

## Recommendation

**The Claude adapter (#11) uses the Agent SDK (`@anthropic-ai/claude-agent-sdk`), not raw `claude -p`.**

Reasons, from the tests below:

1. Multi-turn input, approvals and resume work on both surfaces. Interrupt, `setModel()`, `getContextUsage()` and `canUseTool` only exist through the SDK. On the CLI they travel over an internal `control_request` / `control_response` protocol on stdin/stdout that is documented only as SDK internals (the TS reference mentions the envelope, not a CLI contract). Driving it ourselves would mean reimplementing an undocumented protocol.
2. With the CLI alone, interrupt means a signal (SIGINT ends the turn, SIGTERM exits 143 with no result for the turn, per the headless docs). There is no queued-message receipt.
3. With the CLI alone, approvals need an MCP server exposing a prompt tool (`--permission-prompt-tool`). It works (contract below), but it adds a process and an MCP round trip per approval, and while a prompt tool is set Claude Code emits no `permission_denied` events.
4. The SDK is TypeScript, matching the proposed ADR-002 stack. It ships native binaries as optional dependencies for darwin and linux (x64, arm64, musl), which matches macOS + Ubuntu.
5. `pathToClaudeCodeExecutable` lets the adapter launch the user's own installed `claude` instead of the bundled binary. That keeps "launch the vendor's own binary under the user's own auth" true for subscription logins. Not exercised in this spike.

Keep the CLI path (`claude -p --input-format stream-json` + `--permission-prompt-tool`) as a documented fallback only, for example if the SDK ever lags a needed CLI feature.

## What was tested

| Item | Version |
|---|---|
| Claude Code CLI | `@anthropic-ai/claude-code@2.1.319` (`claude --version` → `2.1.319 (Claude Code)`) |
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.319` (platform binary `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.319`) |
| MCP SDK for the prompt-tool server | `@modelcontextprotocol/sdk@1.32.2` |
| Node | 22.23.4, Linux x64 |

No vendor API was called and no credentials were used. The CLI ran against `harness/mock-api.mjs`, a local scripted mock of the streaming Messages API (`ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, dummy `ANTHROPIC_API_KEY`, isolated `HOME` and `CLAUDE_CONFIG_DIR`). The mock answers `SAY <word>` with `You said <word>.`, `RUN_TOOL` with a `Bash` `tool_use` for `touch spike-file.txt`, and `SLOW` with a slowly streamed reply. Model output in the fixtures is therefore synthetic; the event framing and CLI behaviour are real.

To re-run: install the versions above in a scratch dir, copy `harness/`, start `node mock-api.mjs`, create `work/` next to `run.sh`, and use the commands below.

## Findings

### 1. `--input-format stream-json` (CLI)

Documented in the CLI reference (options `text`, `stream-json`; needs `-p`). Each stdin line is one user message:

```json
{"type":"user","message":{"role":"user","content":"SAY alpha"}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"SAY beta"}]}}
```

```bash
claude -p --bare --input-format stream-json --output-format stream-json --verbose --model <m> < input.jsonl
```

Observed (`fixtures/claude-2.1.319-multi.jsonl`):

- Both string and content-block `content` are accepted.
- Each user line runs as its own turn in the same session: `system/init` is re-emitted per turn, then `assistant`, then one `result` per turn. The second request to the API carried the first turn's history (4 messages).
- `total_cost_usd` on each `result` is cumulative for the process (0.0003 then 0.0006). Take the latest value; never sum.
- The process exits 0 when stdin closes and the last turn finishes.
- `system/init` carries `claude_code_version` and a `capabilities[]` list. On 2.1.319 it includes `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`, `interrupt_requeue_taken_v1`, `msg_lifecycle_v1` and others. The adapter should feature-detect from this list.
- Also observed: a `system/ui_invalidate` line before `init`. The adapter must ignore unknown `system` subtypes.

Message shape on stdin is not spelled out on the CLI reference page; it matches the SDK's `SDKUserMessage` and was verified by this run.

### 2. `--permission-prompt-tool` contract (CLI)

The CLI reference documents the flag (full `mcp__<server>__<tool>` name; waits up to `MCP_TIMEOUT` for the server; cannot approve MCP tools marked as requiring user interaction, v2.1.199+). It does not document the tool's input or output shape. Observed on 2.1.319 (`fixtures/claude-2.1.319-perm-*.jsonl`):

- **Input** to the prompt tool: `{"tool_name":"Bash","input":{...tool input...},"tool_use_id":"toolu_..."}`. The MCP request `_meta` also carries `claudecode/toolUseId`.
- **Output**: one text content block whose text is JSON:
  - allow: `{"behavior":"allow","updatedInput":{...}}`. `updatedInput` replaces the tool input (the test rewrote the command to `echo rewritten`, and that is what ran).
  - deny: `{"behavior":"deny","message":"..."}`. The model receives a `tool_result` with `is_error: true` and the message text; the call is listed in `result.permission_denials`.
- Read-only commands (`echo`) were auto-allowed and never reached the prompt tool; `touch` did.

### 3. Agent SDK (`fixtures/claude-2.1.319-sdk.jsonl`)

One `query()` with `prompt` as an async iterable of `SDKUserMessage`:

- `canUseTool(toolName, input, ctx)` received `Bash` with the original input and `ctx.suggestions` (an `addRules` suggestion for the exact command and an `addDirectories` suggestion). Returning `{behavior:"allow", updatedInput}` ran the rewritten command.
- `getContextUsage()` returned `totalTokens`, `maxTokens` (1,000,000 for the mocked model), `percentage` and categories.
- `setModel("claude-opus-5-5")` applied to the next API call. It is recorded in the transcript as a `/model` local command, so it appears as a `user` message in the stream.
- `interrupt()` during a streamed reply resolved to `{still_queued: []}`. The interrupted turn ended with `result` subtype `error_during_execution` (not `success`), after a synthetic `user` message `[Request interrupted by user]`. A message pushed just before the interrupt then ran as the next turn.
- `resume: <sessionId>` in a new `query()` continued the same session ID with full history.

### 4. Comparison

| Need | CLI `-p` stream-json | Agent SDK |
|---|---|---|
| Multi-turn input | yes (stdin JSONL) | yes (async iterable) |
| Approvals | MCP prompt tool, extra process | `canUseTool` callback, with suggestions |
| Interrupt | signal only | `interrupt()` with receipt |
| Mid-session model switch | no (prompt text `/model` only) | `setModel()` |
| Live context usage | no | `getContextUsage()` |
| Resume / fork | `--resume`, `--continue` | `resume`, `forkSession`, `continue` |
| Contract documented | flags yes; stdin and prompt-tool shapes by observation | typed and documented |

## Adapter implications

- Map an interrupted turn (`result.subtype == "error_during_execution"` after `interrupt()`) to a turn-cancelled event, not an error.
- Ignore unknown `system` subtypes; feature-detect from `system/init.capabilities`.
- `Decision` mapping for Claude: `allow_once` → `{behavior:"allow", updatedInput}`; `allow_always` → allow plus the returned `suggestions` as `updatedPermissions`; `reject` → `{behavior:"deny", message}`; `cancel` → deny with `interrupt: true` (SDK `PermissionResult` field; not exercised here).
