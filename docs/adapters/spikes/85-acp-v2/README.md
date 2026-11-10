# Spike #85: ACP v2 status and the adapter's v2 path

Checked 2026-11-10. Follows [spike #61](../61-acp/README.md) ("ACP v2 is coming").

## Sources

- `agentclientprotocol/agent-client-protocol` at `3961af9` (2026-11-10):
  - `schema/v2/Cargo.toml` (version `2.0.0-alpha.14`);
  - `schema/v2/CHANGELOG.md` (alpha.14 dated 2026-11-09, alpha.13 2026-11-02, alpha.12 2026-10-31);
  - `schema/v2/schema.json`;
  - `docs/protocol/v2/migration.mdx`.
- `schema/v1/Cargo.toml` is `1.30.0`.
- npm `@agentclientprotocol/sdk`: `latest` is 2.5.0 (2026-11-09). Tacet pins 2.4.0. It exports v2 only as `./experimental/v2`, and `AgentProtocolRouter` (v1 + v2 side by side) is marked `@experimental`.
- Live: `probe-initialize.mjs` in this directory sends one `initialize` to each installed agent. It runs them in an empty temporary home, sends no prompt and calls no model API.

## Status

**v2 is still a draft.**
- The schema is `2.0.0-alpha.14`, with a new alpha roughly every week.
- The migration guide says: "v2 as a whole is still labeled draft, so gate v2 support behind explicit version negotiation and feature flags until it stabilizes."
- The unstable v2 schema layers features on top of the stable v2 baseline. Negotiating `protocolVersion: 2` does not imply support for them.

## Which agents speak v2 (live, 2026-11-10)

| Agent | Offered 2 | Offered 1 |
|---|---|---|
| Gemini CLI 0.67.0 (`gemini --acp`) | answers `protocolVersion: 1` | 1 |
| claude-agent-acp 0.101.0 | answers **2**, with v2 `info` and capability groups `session`, `providers` | 1 |
| codex-acp 2.6.0 | answers **2**, with `auth`, `providers`, `session` | 1 |
| OpenCode | not installed here: UNVERIFIED | |

- claude-agent-acp and codex-acp validate a v2 `initialize` strictly. Without `info` they answer `-32602`.
- Tacet's adapter offers v1, so today all three answer v1 (verified, and the conformance runs pass on v1).

## What a v2 path changes for the adapter (#13)

From `migration.mdx`, against what `packages/adapters/acp` does today:

- **Turns.** The `session/prompt` response only acknowledges, and returns a `messageId`. Progress and the end of a turn come as `state_update` (`running`, `requires_action`, `idle` with `stopReason`, and `error` for a failure after acceptance). `#runTurns` would end a turn on the idle `state_update`, not on the response. Cancellation is confirmed by an idle `state_update` with `stopReason: "cancelled"`. End-turn usage moves to that update (unstable schema).
- **Updates are upserts by id.** `tool_call` is removed, and the first `tool_call_update` for an id creates the call. `updateToEvents` would emit `tool.call` on the first update it sees for an id.
- **Session modes are removed** (`modes`, `session/set_mode`, `current_mode_update`). Mode is a config option of category `mode`.
  - The option's id field is renamed `configId`.
  - `session/set_config_option` takes a required `type` (`"id"` or `"boolean"`) and answers the full `configOptions`.
  - Agent-made changes arrive as `config_option_update`.
  - The #145 `sessionMode` pin already prefers the config option and checks its answer. Under v2 it would add `type: "id"`, read `configId`, and drop the `session/set_mode` fallback.
- **`session/load` is removed.** Restore with `session/resume` and `replayFrom: { type: "start" }`. `loadSession` and the `sessionCapabilities` markers are gone: `session/list`, `session/resume` and `session/close` are required when `session` is advertised. The adapter's resume choice would read the v2 `capabilities.session` group.
- **The client file system and terminal are removed.** No change for Tacet: the adapter already offers neither.
- **Capabilities** move from `agentCapabilities`/`clientCapabilities` to `capabilities`. Boolean markers become objects. `initialize` carries `info` (required) instead of `clientInfo`.
- **JSON-RPC.** Request ids must be a string or an integer, never `null`, and there are no batches. The adapter's ids are already integers.

### Design

- An `AcpAdapter` option `protocol: 'v1' | 'v2'` (default `'v1'`), set per agent spec, for example `CLAUDE_ACP_AGENT.protocol`.
- With `'v2'` the adapter offers 2 and runs a separate turn module (`turn-v2.ts`, next to `turn-v1.ts`) behind the same `AgentAdapter` surface.
- If the agent answers 1, the adapter falls back to the v1 path for that connection. This is what the migration guide asks for.
- The conformance suite runs both paths against the same agents.
- No v2 code is written in this spike.

## Recommendation: no-go for now

Do not add v2 support to the ACP adapter yet:
- v2 is an alpha with a weekly release cadence.
- The SDK marks its v2 API `@experimental`.
- Gemini CLI, one of the three registered agents, speaks only v1.
- The two that speak v2 also speak v1, and the v1 path passes conformance with them. So v2 gains Tacet nothing today, and costs a second turn path that would chase alpha changes.

Revisit, and build the design above, when all of these hold:
- `schema/v2` publishes a non-alpha `2.0.0`;
- the SDK exports v2 outside `experimental`;
- a registered agent stops answering v1, or v2 brings something Tacet needs.

The capability-matrix freshness check (#66) makes the ACP surface come up for re-checking every 30 days, which covers the watching.
