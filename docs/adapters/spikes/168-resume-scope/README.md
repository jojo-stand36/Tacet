# Spike #168: how Codex and Gemini CLI scope "resume the last session"

Checked live on 2026-11-10 on Linux x64 (codex-cli 0.167.0 `x86_64-unknown-linux-musl`, Gemini CLI 0.67.0, Node 24, node-pty for the PTY run). macOS was not run: both CLIs key on the cwd path, and `/tmp` is a symlink there.

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
- **Gemini** treats each worktree path as its own project. `$GEMINI_CLI_HOME/.gemini/projects.json` mapped `wt1`, `wt2` and `wt3` to separate ids. Two worktrees with the same directory name in different repos still get separate ids (`claimNewSlug` appends `-1`, `-2` and so on).
  - The interactive UI was not driven through the PTY: on first run it shows an API-key entry dialog, and this spike did not automate that.
  - Both modes use the same lookup. In the 0.67.0 bundle, `main()` calls `resolveSessionId(argv.resume, ...)`, which builds `new Storage(process.cwd())` before choosing interactive or `-p` mode. `Storage.getProjectRoot()` is that `targetDir`, and the project id comes from `ProjectRegistry.getShortId(projectRoot)`.

**Both are safe for `resume_flag`.** Presets:
- Codex: `command: [codex, -c, features.daemon_auto_start=false]` with `resume_flag: [resume, --last]`.
- Gemini CLI: `resume_flag: [--resume, latest]`, once its API-key dialog is pre-answered.

Notes:
- **Interactive Codex starts a managed daemon that outlives the PTY session.** Each interactive run left `codex app-server --listen unix:// --analytics-default-enabled --managed-daemon` and its `daemon pid-update-loop` running, re-parented to PID 1, after `PtyCliAdapter.close`. They are started by the feature `daemon_auto_start` (`codex features list`: stable, on by default).
  - `-c features.daemon_auto_start=false`, or `[features] daemon_auto_start = false` in `config.toml`, stops it. Run that way, no daemon was left and resume behaved the same (`DAEMON=flag` and `DAEMON=off` in `codex-tui.mjs`).
  - `codex exec` started no daemon.
  - Whether the daemon sends telemetry during a mock run (`--analytics-default-enabled`) was not checked.
  - #171: the daemon keeps the session's `TACET_WORKER_MARKER`, so the Mini-conductor's crash sweep (#127) ends it (`codex-daemon-marker.mjs`: both daemon processes carried the marker; the sweep ended both). It is not swept at a clean close: it is shared by every Codex session with the same `CODEX_HOME`. `codex-shared-daemon.mjs` runs two concurrent interactive sessions A and B with one `CODEX_HOME`: B connects to the daemon A started (A's marker; B's own marker is on its `codex` only). After A closed and its marker was swept, B's next turn reached the mock API 0 times (B stayed `running`); in the control run (`NOSWEEP=1`) it reached it 2 times. Linux only; macOS was not run. Codex presets set `daemon_auto_start=false` instead.
  - Telemetry: `codex app-server --help` (0.167.0) says analytics are off by default for the app-server, and `--analytics-default-enabled`, which the managed daemon runs with, turns them on unless `config.toml` sets `[analytics] enabled = false`. No traffic was observed in the mock runs, which does not show there is none.
- The interactive Codex UI sent one title-generation request to the model per session started or resumed. Each run here had one turn, so whether it repeats per turn was not checked. Either way it is extra cost.
- An interactive Gemini preset must get past the API-key dialog. This is a preset setup question, not a resume one.

## Reproduce

Run from the repo root with Node 24, after `pnpm exec tsc -b packages/core packages/adapters/acp packages/adapters/codex-app-server packages/adapters/pty`. Pass **absolute** paths to the binaries: the adapter starts the CLI in a worktree, where a relative path does not resolve.

```sh
node docs/adapters/spikes/168-resume-scope/codex-exec.mjs "$PWD" <path to the codex binary>
node docs/adapters/spikes/168-resume-scope/codex-tui.mjs  "$PWD" <path to the codex binary>
node docs/adapters/spikes/168-resume-scope/gemini.mjs     "$PWD" <path to gemini's bundle/gemini.js>
node docs/adapters/spikes/168-resume-scope/codex-daemon-marker.mjs "$PWD" <path to the codex binary>
node docs/adapters/spikes/168-resume-scope/codex-shared-daemon.mjs "$PWD" <path to the codex binary>   # NOSWEEP=1 for the control
```

The binaries are the ones pnpm installs: `@openai/codex` 0.167.0 (`vendor/<target>/bin/codex`, found with `realpath "$(find node_modules/.pnpm -path '*codex@0.167*/bin/codex' -type f | head -1)"`) and `@google/gemini-cli` 0.67.0 (its `bin` entry, `bundle/gemini.js`). `codex-tui.mjs` reports and stops any daemon left running before it removes its temporary home. Each script spawns the CLI asynchronously, because the mock API runs in the same process.
