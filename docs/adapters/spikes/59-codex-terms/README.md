# Spike #59: Codex app-server auth and terms from primary sources

Checked 2026-11-09. Gap 2 in [`capability-matrix.md`](../../capability-matrix.md).

## Outcome

**Partly verified.** The `chatgptAuthTokens` restriction is verified from the Codex 0.167.0 generated schema. The commercial and hosted-use language is still **UNVERIFIED**, because every page that states it is on `developers.openai.com` or `help.openai.com`, and neither resolves from this environment.

## Hosts tried

| Host | Result (2026-11-09) |
|---|---|
| `developers.openai.com` | DNS failure from the shell (`curl`) and from WebFetch (`getaddrinfo ENOTFOUND`) |
| `openai.com`, `help.openai.com`, `platform.openai.com`, `chatgpt.com` | no connection from the shell |
| `raw.githubusercontent.com`, `github.com` (git clone) | reachable; used for the facts below |

I did not change the environment's network settings. Adding `developers.openai.com` and `help.openai.com` to the allowlist would let a later run close this gap.

## Verified facts

| Fact | Source |
|---|---|
| The `chatgptAuthTokens` variant of `account/login/start` (the client supplies `accessToken` and a workspace id) is described in the schema as **"[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE"**. The server can also send `account/chatgptAuthTokens/refresh` requests to the client. | `codex app-server generate-json-schema` on `@openai/codex@0.167.0`: `v2/LoginAccountParams.json`, `ServerRequest.json` (see [spike #58](../58-codex/README.md)) |
| `account/login/start` also offers `apiKey`, `chatgpt` (browser flow, run by Codex itself), `chatgptDeviceCode`, and Bedrock variants marked `[UNSTABLE]`/experimental. | same schema, `v2/LoginAccountParams.json` |
| Codex's README recommends **Sign in with ChatGPT** to use Codex as part of a Plus, Pro, Business, Edu or Enterprise plan. API-key use needs "additional setup", documented on `developers.openai.com/codex/auth` (blocked). | https://raw.githubusercontent.com/openai/codex/rust-v0.167.0/README.md |
| The repo's `docs/authentication.md` only links out to `developers.openai.com/codex/auth`. | https://raw.githubusercontent.com/openai/codex/rust-v0.167.0/docs/authentication.md |
| The Codex CLI repo is Apache-2.0. | README.md (above) |

## UNVERIFIED (search snippets only, not citable)

A web search on 2026-11-09 returned these `developers.openai.com` pages, which could not be fetched:

- `/siwc/token-sharing-open-source`, `/siwc/token-sharing-open-source/codex-app-server`, `/siwc/token-sharing-open-source/preview-limitations`, `/codex/auth`, `/cookbook/topic/sign-in-with-chatgpt`.

According to the search summaries, the "Sign in with ChatGPT" plan-usage path is aimed at open-source and locally hosted apps. Paid or remotely hosted apps are pointed to an interest form, and commercial sign-in is described as a limited trial with selected partners. The Codex app-server page apparently shows a local stdio setup using the user's plan. None of this is confirmed from the page itself.

## What this means for Tacet

- **Design rule kept:** Tacet never implements `chatgptAuthTokens` and never handles ChatGPT tokens. The schema now confirms this route is for OpenAI internal use only. Codex owns login: either `chatgpt`/`chatgptDeviceCode` inside the Codex process, or the `codex login` the user already did, or `OPENAI_API_KEY` from the environment.
- **Probably fine, but UNVERIFIED:** a local-first, single-user Tacet launching the user's own `codex` under the user's own ChatGPT login looks like the "open-source, locally hosted" case. A hosted or paid Tacet would need OpenAI's approval. Treat it as **needs-human** until the pages are read, and do not ship any hosted mode that uses ChatGPT logins.

## Follow-up (needs-human)

- Owner: decide whether to allow `developers.openai.com` and `help.openai.com` in the environment so the terms can be read, or to read them yourself and record the result. Until then, the proposal is that the Codex adapter (#12) defaults to an API key for unattended or parallel Workers, the same rule as for Claude, and to the user's own Codex login only for interactive use.
