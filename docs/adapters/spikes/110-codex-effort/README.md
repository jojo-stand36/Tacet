# Spike #110 (slice 2): how Codex handles reasoning effort

Checked on 2026-11-10 on Linux x64, with `@openai/codex` 0.167.0 (the adapter's pin) and Node 22. Every run used a temporary `HOME`/`CODEX_HOME`, a placeholder API key and the package's local mock Responses API (`packages/adapters/codex-app-server/src/testing/mock-responses-api.ts`). No real login or key was used, and nothing went to the network.

## Why it matters

Tacet's `SessionProfile` gives a Worker an effort, and an adapter must refuse what it cannot honour rather than ignore it (#110). That needs to know what Codex does with a level the model does not offer, and where the per-model levels come from.

## How to run

The three files here are Vitest files. Copy one into `packages/adapters/codex-app-server/src/`, run `pnpm exec vitest run <name>` from the repo root, and read the file `SPIKE_OUT` names (default `spike.out`); the test config hides console output. Delete the copy afterwards.

- `spike-models.test.ts`: `model/list` with `includeHidden: true`, then `thread/start` with `config.model_reasoning_effort: 'bogus-level'`.
- `spike-effort.test.ts`: through `CodexAppServerAdapter` as it was before this slice (no effort check), starts sessions with launch or per-turn effort and reads the `reasoning.effort` the mock received.
- `spike-resume.test.ts`: the `reasoningEffort` field of the `thread/start`, `thread/resume` and `thread/fork` responses.

## Results

**`model/list` works offline.** It answers from a catalog bundled with the binary, with no request to the API: 12 entries with `includeHidden: true`, each with `defaultReasoningEffort` and `supportedReasoningEfforts`. For example `gpt-5.5` offers `low`, `medium`, `high` and `xhigh` (default `medium`), and `gpt-6-luna` offers `low` to `max`.

**Effort the model does not offer** (effort the mock received):

| Model | Effort asked for | Sent to the API |
|---|---|---|
| `gpt-5.5` | none | `medium` (the default) |
| `gpt-5.5` | `ultra` at launch or per turn | `xhigh`: silently lowered |
| `gpt-6-luna` | `ultra` per turn | `max`: silently lowered |
| `gpt-5.5` | `none`, `minimal` per turn | passed through as asked |
| `gpt-5.5` | `bogus` at launch | `bogus`: passed through |
| `gpt-mock-1` (not in the catalog) | none / `bogus` | nothing / `bogus` |

Every turn ended `idle`; Codex reported nothing. `thread/start` (with `gpt-5.1-codex-mini`, which is not in the catalog) also accepted `config.model_reasoning_effort: 'bogus-level'` without an error.

**Thread responses:** `reasoningEffort` is `null` on a fresh `thread/start` without an effort, and `"high"` when the thread config set one. `thread/resume` of a thread whose last turn ran with `low` reported `"low"`. A `thread/fork` of it, sent without a model, reported the catalog's default model (`gpt-6.1-sol`) and `null`.

## What the adapter does with this

- It reads `model/list` and refuses an effort the model does not list, or one for a model outside the catalog (`ProfileRefusedError`): at launch, on each turn, and on a model switch while an effort is in force.
- On resume it takes the thread's `reasoningEffort` as the effort in force, so a later model switch is checked too.
- It refuses every `contextWindow` (see the capability matrix, "Context size selection").

## Not covered

- What the real OpenAI API does with `none`, `minimal` or `bogus`: only the mock was used.
- Models from other `model_provider`s, which the bundled catalog does not describe.
