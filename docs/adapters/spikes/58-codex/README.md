# Spike #58: Codex approval decision enums and `turn/interrupt` / `turn/steer` payloads

Checked 2026-11-09. Closes gap 1 in [`capability-matrix.md`](../../capability-matrix.md).

## Pinned version and method

- `@openai/codex@0.167.0` from npm (`codex --version` → `codex-cli 0.167.0`). This was npm `latest` on 2026-11-09.
- Ran `codex app-server generate-json-schema -o schema`, the same with `--experimental`, and `codex app-server generate-ts -o ts`. The stable schema has 322 files.
- `schema-0.167.0/` holds the generated TypeScript for every type cited below, copied unmodified. The ts-rs header says "do not edit". Regenerate with `codex app-server generate-ts` for a newer pin.
- The approval response types and `TurnInterruptParams` are identical in the stable and `--experimental` schemas. `TurnSteerParams` gains `additionalContext`, `responsesapiClientMetadata` and `responsesapiClientMetadataPatch` only under `--experimental`.
- I ran a live handshake (`harness/drive.mjs`, log in `harness/handshake-0.167.0.log`) with an isolated `CODEX_HOME` and a dummy key. It covered `initialize`, `thread/start`, then `turn/interrupt` and `turn/steer` with no active turn. No model call was made. I did not run a full turn that gets interrupted: that needs a model or a mock Responses API.

## Approval requests (server → client)

The method list comes from `ServerRequest.json`: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call`, `account/chatgptAuthTokens/refresh` and `attestation/generate`. The legacy `applyPatchApproval` and `execCommandApproval` are also still present.

### `item/commandExecution/requestApproval`

Params: `kind` (`"command" | "humanCommand" | "writeStdin"`; per the app-server README, `humanCommand` checkpoints accept only `accept`, `decline` and `cancel`), `threadId`, `turnId`, `itemId`, `startedAtMs`, `approvalId?`, `environmentId`, `reason?`, `command?`, `cwd?`, `commandActions?`, `proposedExecpolicyAmendment?`, network approval context and proposed network amendments.

Response: `{ decision: CommandExecutionApprovalDecision }`

| Decision | Meaning (from the schema descriptions) |
|---|---|
| `"accept"` | approve this command |
| `"acceptForSession"` | approve, and skip future prompts in the same session-scoped approval cache |
| `{ acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }` | approve, and add an execpolicy rule so matching commands run without prompting |
| `{ applyNetworkPolicyAmendment: { network_policy_amendment: { host, action } } }` | save a persistent allow or deny rule for a network host |
| `"decline"` | deny; the agent continues the turn |
| `"cancel"` | deny, and interrupt the turn immediately |

### `item/fileChange/requestApproval`

Params: `threadId`, `turnId`, `itemId`, `startedAtMs`, `reason?`, `grantRoot?` (marked UNSTABLE).

Response: `{ decision: "accept" | "acceptForSession" | "decline" | "cancel" }`, with the same meanings as above. `acceptForSession` covers future changes to the same files.

### `item/permissions/requestApproval`

This one is not a decision enum. Params: `threadId`, `turnId`, `itemId`, `environmentId`, `startedAtMs`, `cwd`, `reason`, `permissions` (the requested profile).

Response: `{ permissions: GrantedPermissionProfile, scope: "turn" | "session", strictAutoReview?: boolean }`. `GrantedPermissionProfile` is `{ network?, fileSystem? }`. The client returns the granted profile. Neither the schema nor the app-server README at `rust-v0.167.0` says how to deny. Returning an empty profile is the obvious reading but is **UNVERIFIED**; test it in a live turn before #12 relies on it.

### Others

- `mcpServer/elicitation/request` → `{ action: "accept" | "decline" | "cancel", content, _meta }`.
- `item/tool/requestUserInput` (EXPERIMENTAL) → `{ answers: { [questionId]: answer } }`.
- Legacy `execCommandApproval` / `applyPatchApproval` use `ReviewDecision`: `"approved"`, `{approved_execpolicy_amendment}`, `"approved_for_session"`, `"approved_mcp_policy_amendment"`, `{network_policy_amendment}`, `{denied: {rejection}}`, `"timed_out"`, `"abort"`. Tacet should not implement these; the v2 methods replace them.

## Mapping to Tacet `Decision`

Tacet's set is `allow_once | allow_always | reject | cancel` (matrix section 7).

| Tacet | Command execution | File change | Permissions | MCP elicitation |
|---|---|---|---|---|
| `allow_once` | `accept` | `accept` | requested profile, `scope: "turn"` | `accept` + content |
| `allow_always` | `acceptForSession` by default. `acceptWithExecpolicyAmendment` (with the proposed amendment) only if the Decision says to persist a rule | `acceptForSession` | requested profile, `scope: "session"` | n/a (treat as `allow_once`) |
| `reject` | `decline` | `decline` | empty profile (UNVERIFIED) | `decline` |
| `cancel` | `cancel` | `cancel` | empty profile (UNVERIFIED), then `turn/interrupt` | `cancel` |

Design notes:

- Codex's "always" is **session-scoped** (`acceptForSession`). The persistent variant is an execpolicy or network-policy amendment that writes rules. Tacet's `allow_always` should mean "this session" by default, and needs an explicit flag before Tacet writes persistent rules into the user's Codex config.
- Network amendments (`applyNetworkPolicyAmendment`) have no Tacet equivalent yet. Leave them out of v1 and let the user handle them in Codex.
- Permissions requests carry a grant payload, not a verdict. `Decision` therefore needs an optional "granted subset" field, or the adapter grants all or nothing.

## `turn/interrupt` and `turn/steer`

| Method | Params | Result | Live check (0.167.0) |
|---|---|---|---|
| `turn/interrupt` | `{ threadId: string, turnId: string }` (both required) | `{}` (`Record<string, never>`) | With no active turn: JSON-RPC error `-32600` "no active turn to interrupt" |
| `turn/steer` | `{ threadId, input: UserInput[], expectedTurnId: string, clientUserMessageId?: string \| null }` | `{ turnId: string }` | With no active turn: `-32600` "no active turn to steer" |

- `expectedTurnId` is a precondition: steering fails if it does not match the active turn. The adapter must track the active `turnId` from `turn/started`.
- The schema says the interrupted turn ends with `Turn.status` = `"interrupted"`. `TurnStatus` is `completed | interrupted | failed | inProgress`, delivered on `turn/completed`. This comes from the schema only; it was not observed in a live turn.
- There is no queued-message receipt, unlike Claude's `interrupt()`. `steer` is the Codex way to add input to a running turn.

## Other observations from the handshake

- The `initialize` result contains `userAgent` (includes the CLI version, e.g. `tacet-spike/0.167.0 (...)`), `codexHome`, `platformFamily` and `platformOs`. It has no protocol version field, so the adapter can parse the version from `userAgent` or run `codex --version`.
- Before `thread/start` returned, the server sent a `configWarning` notification (bubblewrap not on PATH; Codex fell back to its bundled copy) and a `remoteControl/status/changed` notification. The adapter must tolerate notifications it does not map.
