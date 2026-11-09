# Spike #60: OpenCode event names, permission events, token and cost fields

Checked 2026-11-09. Closes gap 3 in [`capability-matrix.md`](../../capability-matrix.md).

## Method

- `opencode-ai@1.19.5` from npm (`opencode --version` → `1.19.5`).
- Ran `OPENCODE_SERVER_PASSWORD=… opencode serve --hostname 127.0.0.1 --port 4097` with an isolated `HOME`, then fetched `GET /doc` with basic auth. The result is OpenAPI `3.1.0`, `info.version` `1.0.0`, 480 KB (sha256 prefix `eebb56042880e07c`). The spec is not committed. Regenerate it with the same commands for a newer pin.
- Without credentials `GET /doc` returned `401`, so the password applies to the spec as well.
- Opened `GET /event` live. The first SSE frame is `data: {"id":"evt_…","type":"server.connected","properties":{}}` (`fixtures/opencode-1.19.5-sse-connect.txt`).
- No model calls. Event payload shapes are from the spec, not observed.

## Two API surfaces

1.19.5 serves both the documented routes (`/session/...`, `/event`, `/permission/...`) and a newer `/api/...` surface: `/api/event`, `/api/session/{id}/prompt`, `/api/session/{id}/interrupt`, `/api/session/{id}/context`, `/api/session/{id}/permission/{requestID}/reply`, `/api/session/{id}/model` and others. The `/api/...` surface is not in the docs pages read for the matrix. **The adapter should target the documented routes and pin the version.**

## Events

The `Event` union in the spec has **89** types (full list: `fixtures/opencode-1.19.5-event-types.txt`). The ones the adapter needs:

| Purpose | Event `type` | Payload (`properties`) |
|---|---|---|
| Connect | `server.connected` | `{}` |
| Streaming text | `message.part.delta` | `sessionID`, `messageID`, `partID`, `field`, `delta` |
| Part and message state | `message.part.updated`, `message.updated`, `message.removed`, `message.part.removed` | the part or message |
| Turn done | `session.idle` | `sessionID` |
| Status | `session.status` | |
| Errors | `session.error` | `sessionID`, `error` (one of `ProviderAuthError`, `UnknownError`, `MessageOutputLengthError`, `MessageAbortedError`, `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError`, `APIError`) |
| Permission asked | `permission.asked` | `id`, `sessionID`, `permission`, `patterns[]`, `metadata`, `always[]`, `tool {messageID, callID}` |
| Permission answered | `permission.replied` | `sessionID`, `requestID`, `reply` (`once`, `always`, `reject`) |
| Questions | `question.asked`, `question.replied`, `question.rejected` | |
| Diff | `session.diff`, `file.edited` | |

There are also `session.next.*` events (step, text, reasoning, tool and compaction lifecycle) and `permission.v2.*` / `question.v2.*` events. They appear to belong to the newer `/api/...` surface. Do not build on them yet.

## Permission round trip

1. SSE `permission.asked` with `id` (the request id), `sessionID`, the permission name, `patterns`, and `tool.callID`.
2. Reply with `POST /permission/{requestID}/reply` `{reply: "once" | "always" | "reject", message?}`.
3. The legacy `POST /session/{id}/permissions/{permissionID}` `{response: "once" | "always" | "reject"}` still exists but is marked **deprecated** in the spec.
4. Confirmation arrives as SSE `permission.replied`.

Mapping to Tacet `Decision`: `allow_once` → `once`, `allow_always` → `always`, `reject` → `reject`, `cancel` → `reject` then `POST /session/{id}/abort`.

## Tokens, cost, context

| Where | Fields |
|---|---|
| `AssistantMessage` (on `message.updated`) | `cost` (number), `tokens {total, input, output, reasoning, cache {read, write}}`, `modelID`, `providerID`, `finish`, `error` |
| `StepFinishPart` (`type: "step-finish"`) | per-step `cost`, `tokens {…same…}`, `reason` |
| `Model.limit` (provider model info) | `context` (required), `input`, `output` |

Live context usage is therefore "tokens of the last assistant message" plus `Model.limit.context` for the max. Cost is reported by OpenCode itself; the unit is presumably USD, since its ACP mode labels the same total `currency: "USD"` ([spike #61](../61-acp/README.md)).

## Implications for the OpenCode adapter (#15)

- Subscribe to `GET /event` (basic auth). Map `message.part.delta` to text deltas, `session.idle` to turn end, `session.error` to error (with `MessageAbortedError` meaning cancelled), and `permission.asked` to an approval request.
- Answer approvals through `POST /permission/{requestID}/reply`, not the deprecated session route.
- Usage: read `tokens`/`cost` from `AssistantMessage` or `step-finish`, and `limit.context` from the model. Mark cost as "reported".
- The alternative is OpenCode's ACP mode (`opencode acp`), which emits `usage_update` with USD cost and the standard ACP permission flow (#61). This is a reasonable fallback if the HTTP surface churns, given that the `/api` surface is new.
