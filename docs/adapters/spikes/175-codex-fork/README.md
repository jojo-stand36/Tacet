# Spike #175: what a Codex fork runs on

Checked on 2026-11-10 on Linux x64, with `@openai/codex` 0.167.0 (the adapter's pin) and Node 24. The run used a temporary `HOME`/`CODEX_HOME`, a placeholder API key and the package's local mock Responses API (`packages/adapters/codex-app-server/src/testing/mock-responses-api.ts`). No real login or key was used, and nothing went to the network.

## Why it matters

[Spike #110](../110-codex-effort/README.md) saw a `thread/fork` sent without a model come back on the catalog's default model. A Worker resumed as a fork would then change model without anyone choosing it.

## How to run

`spike-fork.test.ts` is a Vitest file. Copy it into `packages/adapters/codex-app-server/src/`, run `pnpm exec vitest run <name>` from the repo root, and read the file `SPIKE_OUT` names (default `spike.out`). Delete the copy afterwards.

It starts a thread on `gpt-5.5`, runs one turn at effort `low`, ends the process, then in a fresh app-server process reads the thread and forks it three ways, running one turn on each fork.

## Results

| Step | Response `model` / `reasoningEffort` | First request: model / effort |
|---|---|---|
| Source turn | | `gpt-5.5` / `low` |
| `thread/read` (fresh process) | `gpt-5.5` / `low` | |
| `thread/fork`, no model or effort | `gpt-6.1-sol` / `null` | `gpt-6.1-sol` / `low` |
| `thread/fork` with `model: gpt-5.5`, `config.model_reasoning_effort: low` | `gpt-5.5` / `low` | `gpt-5.5` / `low` |
| `thread/fork` with `model: gpt-6-luna`, `config.model_reasoning_effort: high` | `gpt-6-luna` / `high` | `gpt-6-luna` / `high` |
| `thread/resume`, no model | `gpt-5.5` / `low` | |

So a plain fork loses the source's model (it keeps the effort, though its response says `null`), and a fork honours a model and effort it is given. `thread/read` reports what the source ran on, also in a process that never loaded the thread.

## What the adapter does with this

Before a fork that has no model or no effort, it calls `thread/read` on the source thread and sends the source's model, and the source's effort when the fork keeps that model. An explicit model or effort wins. Every effort sent, inherited or not, is checked against `model/list` first (`ProfileRefusedError` otherwise).

## Not covered

- The real OpenAI API: only the mock was used.
- A source thread on a model outside the bundled catalog with an effort set: the inherited effort would then be refused, as an explicit one is (the adapter cannot confirm the level).
