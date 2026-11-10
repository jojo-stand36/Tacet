# Spike #168: how Codex and Gemini CLI scope "resume the last session"

Checked live on 2026-11-10 with codex-cli 0.167.0 and Gemini CLI 0.67.0.

## Why it matters

A `pty:<slug>` preset's `resume_flag` (#157) continues the CLI's last session in the Worker's checkout. That is only safe if the CLI's resume picks among the sessions of its working directory. If it picks from a wider scope, such as the repo shared by sibling worktrees, one Worker could continue another Worker's session.

## Setup

- One git repo, with three sibling worktrees `wt1`, `wt2` and `wt3`. All runs use temporary homes (`CODEX_HOME`, `GEMINI_CLI_HOME` and `HOME`) and the repo's local mock APIs. No real login or key is used.
- Steps:
  1. Start a session in `wt1`.
  2. About a second later, start one in `wt2`, so it is the newest.
  3. Resume in `wt1`.
  4. Resume in `wt3`, which has no session of its own.
- A run is identified by which session file changed:
  - Codex: `$CODEX_HOME/sessions/**/rollout-*.jsonl`, whose first line records the `cwd`;
  - Gemini: `$GEMINI_CLI_HOME/.gemini/tmp/<project>/chats/*.jsonl`.

  For Codex, the request size the mock received confirms it: the resumed request carried 9 input items, a new one 7.

## Results

| CLI and command | Resume in `wt1` (older session; `wt2` newer) | Resume in `wt3` (no session) |
|---|---|---|
| `codex resume --last`, interactive, through `PtyCliAdapter` in a real PTY | continued **`wt1`'s** session | started a fresh session |
| `codex exec resume --last` | continued **`wt1`'s** session | started a fresh session, exit 0 |
| `gemini --resume latest -p` | continued **`wt1`'s** session | "No previous sessions found for this project.", then a fresh session, exit 0 |

- **Codex** filters `--last` by working directory (`--all` "disables cwd filtering").
- **Gemini** treats each worktree path as its own project. `~/.gemini/projects.json` mapped `wt1`, `wt2` and `wt3` to separate ids.
  - The interactive UI was not driven through the PTY: on first run it shows an API-key entry dialog, and this spike did not automate that.
  - Both modes use the same lookup. In the 0.67.0 bundle, `main()` calls `resolveSessionId(argv.resume, ...)`, which builds `new Storage(process.cwd())` before choosing interactive or `-p` mode. `Storage.getProjectRoot()` is that `targetDir`, and the project id comes from `ProjectRegistry.getShortId(projectRoot)`.

**Both are safe for `resume_flag`.** Preset values: `[resume, --last]` for Codex and `[--resume, latest]` for Gemini CLI.

Notes:
- The interactive Codex UI sends a title-generation request to the model on every turn, which is extra cost.
- An interactive Gemini preset must get past the API-key dialog. This is a preset setup question, not a resume one.

## Reproduce

Run from the repo root with Node 24, after `pnpm exec tsc -b packages/adapters/acp packages/adapters/codex-app-server packages/adapters/pty`:

```sh
node docs/adapters/spikes/168-resume-scope/codex-exec.mjs "$PWD" <path to the codex binary>
node docs/adapters/spikes/168-resume-scope/codex-tui.mjs  "$PWD" <path to the codex binary>
node docs/adapters/spikes/168-resume-scope/gemini.mjs     "$PWD" <path to gemini's bundle/gemini.js>
```

The binaries are the ones pnpm installs: `@openai/codex` 0.167.0 (`vendor/<target>/bin/codex`) and `@google/gemini-cli` 0.67.0 (its `bin` entry). Each script spawns the CLI asynchronously, because the mock API runs in the same process.
