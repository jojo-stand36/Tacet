# Spike #63: Gemini CLI stats fields, headless approvals, ACP permission flow, auth status

Checked 2026-11-09. Closes gap 6 in [`capability-matrix.md`](../../capability-matrix.md).

## Setup

- `@google/gemini-cli@0.67.0` from npm (`gemini --version` → `0.67.0`).
- No Google account or key was used. The CLI ran against `harness/mock-gemini.mjs`, a scripted mock of the Gemini `streamGenerateContent`/`generateContent` API, through the documented `GOOGLE_GEMINI_BASE_URL` variable (`docs/reference/configuration.md` in the package). Other settings: dummy `GEMINI_API_KEY`, isolated `HOME`, and `harness/settings.json` with `security.auth.selectedType: "gemini-api-key"`. Without `selectedType`, headless runs exit `41` "Invalid auth method selected".
- The mock answers `SAY <w>` with text, and answers `RUN_TOOL` with a `run_shell_command` call for `touch spike-file.txt`. Model output in the fixtures is synthetic; the CLI's framing and behaviour are real. The mock reports `modelVersion: "mock-model"`, which is why stats are keyed by that name.

## 1. `--output-format json` (`fixtures/gemini-0.67.0-headless-json.json`)

Top level: `session_id`, `response`, `stats`. `stats` has:

- `models.<modelVersion>.api`: `totalRequests`, `totalErrors`, `totalLatencyMs`, `errorsByType`
- `models.<modelVersion>.tokens`: `input`, `prompt`, `candidates`, `total`, `cached`, `thoughts`, `tool`
- `models.<modelVersion>.roles.<role>` (e.g. `main`): the same `api` and `tokens` fields per role
- `tools`: `totalCalls`, `totalSuccess`, `totalFail`, `totalDurationMs`, `totalDecisions {accept, reject, modify, auto_accept}`, `byName`
- `files`: `totalLinesAdded`, `totalLinesRemoved`

There is no cost field. Errors come back as `{session_id, error: {type, message, code}}` on stderr with the same exit code (`41` seen).

## 2. `--output-format stream-json` (`fixtures/gemini-0.67.0-stream-*.jsonl`)

Events (JSONL):

- `init`: `timestamp`, `session_id`, `model`
- `message`: `role` user or assistant; assistant chunks carry `delta: true`
- `tool_use`: `tool_name`, `tool_id`, `parameters`
- `tool_result`: `tool_id`, `status` success or error, `output`, `error {type, message}`
- `result`: `status`, `error`, `stats`

`result.stats` uses snake_case, unlike the `json` format: `total_tokens`, `input_tokens`, `output_tokens`, `cached`, `input`, `duration_ms`, `tool_calls`, and `models.<modelVersion>.{total_tokens, input_tokens, output_tokens, cached, input}`. Context window size is not reported.

## 3. Headless approval behaviour

There is **no approval round trip in headless mode.** I ran the same `run_shell_command` call under each `--approval-mode`:

| `--approval-mode` | Result | File created |
|---|---|---|
| `default` | `tool_result` `status: error`, `error.type: "tool_not_registered"` ("Tool \"run_shell_command\" not found") | no |
| `auto_edit` | same as default (shell is not an edit tool) | no |
| `plan` | same as default | no |
| `yolo` | `status: success` | yes |

The run still ends with `result.status: "success"` and exit 0. The model simply saw the tool as unavailable. This matches the policy-engine docs shipped in the package (`docs/reference/policy-engine.md`): `ask_user` is treated as `deny` in non-interactive mode, and globally denied tools are excluded from the model's tool list. Tacet must pre-decide approvals in headless mode, through `--approval-mode` or policy rules, or use ACP.

## 4. ACP permission flow (`gemini --experimental-acp`, `fixtures/gemini-0.67.0-acp-*.jsonl`)

For the same tool call, the agent sends `session/request_permission` with:

- `toolCall`: `toolCallId`, `title` (the command), `kind: "execute"`, `status: "pending"`
- `options`: `proceed_always` "Allow for this session" (`allow_always`), `proceed_once` "Allow" (`allow_once`), `cancel` "Reject" (`reject_once`)

There is no `reject_always`. The client's reply and what followed:

| Client reply | Outcome |
|---|---|
| `{outcome: "selected", optionId: "proceed_once"}` | tool ran (file created); `tool_call_update status: completed`; `stopReason: end_turn` |
| `{outcome: "selected", optionId: "cancel"}` | tool not run; `tool_call_update status: failed`; `stopReason: end_turn` |
| `session/cancel` + `{outcome: "cancelled"}` | tool not run; `tool_call_update status: failed`; `stopReason: "cancelled"` |

`usage_update` was observed live after each model response: `used: 128`, `size: 1048576`, no `cost`.

## 5. Auth status after the Antigravity move

- The README shipped in 0.67.0 says unpaid-tier and Google One users had Gemini CLI replaced by Antigravity CLI on 2026-06-18. It also says Gemini CLI is not optimised for the latest Gemini models. Source: `README.md` in the npm package and https://raw.githubusercontent.com/google-gemini/gemini-cli/main/README.md.
- The same package's `docs/resources/quota-and-pricing.md` still describes a free "Gemini Code Assist (Individual)" Google-login tier. That doc is stale relative to the README.
- The CLI still offers `oauth-personal` "Log in with Google" in its ACP `authMethods` (see [spike #68](../68-vendor-mcp/README.md)).
- **Whether a free personal Google login still works is UNVERIFIED.** Testing it needs a real Google account. The blog post linked from the README (`developers.googleblog.com`) does not resolve from this environment.
- Tacet default: Gemini Workers use `GEMINI_API_KEY` or Vertex. Google login is left to the user's own setup.

## Implications for the Gemini adapter (#14)

- Prefer **ACP** (`--experimental-acp`): it gives approvals, cancel, live `usage_update` and per-session MCP injection. Use headless `stream-json` only for pre-approved, unattended runs, with `--approval-mode yolo` or policy `allow` rules inside a sandbox.
- Detect blocked tools in headless runs from `tool_result.error.type == "tool_not_registered"`. Report them as policy denials, not as errors.
- Map the ACP options: `allow_once` → `proceed_once`, `allow_always` → `proceed_always`, `reject` → `cancel` (the option id is confusingly named `cancel`), and `cancel` → `session/cancel`.
