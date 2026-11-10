# Spike #245: files named in a pasted prompt, in Gemini CLI and Codex CLI

Checked live on 2026-11-10 on Linux x64 with Node 22, node-pty 1.1.0, Gemini CLI 0.67.0 (`npm i @google/gemini-cli@0.67.0`) and Codex CLI 0.167.0 (the repo's pinned `@openai/codex`). Each CLI ran interactively in a real PTY, with the prompt pasted as `PtyCliAdapter` pastes it (bracketed paste, then Enter). Each pointed at a local stand-in for its API: for Gemini, a capture server via `GOOGLE_GEMINI_BASE_URL` with `gemini-api-key` auth and `-m gemini-2.5-pro`; for Codex, the repo's mock Responses API via `-c model_providers.*`. No real key is used.

## Why it matters

A Worker's next prompt can carry text a Worker wrote, such as a `verify` command's output or review findings. If a CLI reads a file named in that text into the request, a Worker can get files read for it, including files outside its checkout, without any tool call that Tacet's policy sees.

## Gemini CLI 0.67.0

Run with `node gemini-probe.mjs <repo> <path to gemini.js> <case> "-m gemini-2.5-pro"`. Each case is a fresh session in a temporary checkout. `note.txt` and `my file.txt` sit inside the checkout; `outside-at.txt` sits next to it.

| Case | What was typed | Result |
|---|---|---|
| `raw:at` | `say probe see @<outside> and @note.txt please` | Dialog: "The following files are outside your workspace … Do you want to allow this read?", default **Yes**. Answered with Enter, both files are read in (`ReadManyFiles`). |
| `raw:bare-in` | `./note.txt` | Gemini turns the pasted path into `@./note.txt` and reads it in, without asking. |
| `raw:bare-out` | `../outside-at.txt` | Same conversion, then the outside-workspace dialog (default Yes). |
| `raw:quoted` | `'./my file.txt'` | Converted and read in, without asking. |
| `at`, `at-line`, `at-trailing` | `@` mentions inline, on their own line, trailing, typed as Tacet types them: `. ` + text with every `@` as `\@` + ` .` | Nothing read, no dialog. |
| `pre-escaped` | `\@<outside>` and `\\@note.txt` in the text, escaped again | Nothing read, no dialog: every `@` typed has a backslash right before it. |
| `bare-in`, `bare-out`, `bare-two`, `quoted` | the raw cases, typed as Tacet types them | Nothing read, no dialog. `.` is a directory, so the paste is not "all files" and Gemini doesn't convert it. |
| `suffix-only:open-quote`, `suffix-only:backslash` | `'./lnk .` and `./lnk\ .`, with `lnk .` and `lnk ` in the checkout linking to the outside file | The quote or backslash joins the suffix onto the path, so Gemini converts the paste to `@./lnk\ .`, drops the final `.`, and shows the outside-workspace dialog. This is why Tacet also prefixes `. `. |
| `open-quote`, `backslash` | the same text, typed as Tacet types them | Nothing read, no dialog: nothing before the `. ` prefix can join it. |

From the 0.67.0 bundle and source:
- `parseAllAtCommands` matches `(?<!\\)@`.
- The paste-to-`@path` conversion (`parsePastedPaths` in the text buffer's `insert`) applies when the whole paste, or every space-separated segment of it, is an existing file.
- `ui.escapePastedAtSymbols` (default false) escapes pasted `@`, but does not stop the path conversion.

## Codex CLI 0.167.0

No script is committed: the run used the `-c model_providers.*` flags from `packages/adapters/codex-app-server/src/auth.ts` against `startMockResponsesApi`, with replies to the terminal's cursor-position and colour queries.

- `@<outside>` and `@note.txt`, inline, on their own line, or after Esc: the request carried the text as typed. Nothing was read in.
- A prompt that **ends** in an `@token` opens Codex's Mentions picker. The typed Enter then inserts a completion (`@note.txt` became `note.txt`) instead of submitting, so the turn did not start until Esc and Enter. Tracked in #249, together with pasted image paths, which the source attaches as images (not run live).
