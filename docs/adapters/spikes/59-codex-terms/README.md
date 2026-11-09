# Spike #59: Codex app-server auth and terms from primary sources

Checked 2026-11-09. Gap 2 in [`capability-matrix.md`](../../capability-matrix.md).

## Outcome

> Updated 2026-11-09: the commercial/hosted-use language is now verified. See "Re-verification" at the end.

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

## Re-verification (2026-11-09, after the owner allowed `developers.openai.com`)

Read directly (Markdown versions of the pages):

| Page | What it says (paraphrased) |
|---|---|
| https://developers.openai.com/siwc/token-sharing-open-source | ChatGPT plan usage is an optional capability within "Sign in with ChatGPT" (SIWC). An **open-source** app can ask permission to use the user's plan for eligible Responses API requests. The docs cover **open-source and locally hosted apps**; offering it in a **paid or remotely hosted** app requires completing OpenAI's interest form. The app registers its own OAuth client (dynamic registration bound to user and workspace), sends a stable per-host `ext_agent_host_id`, and stores the user's tokens itself. |
| https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server | To use Codex app-server with a user's plan, the app passes the SIWC OAuth **access token to the app-server child process** (`ACCESS_TOKEN` via `model_providers.<x>.env_key`), sets `clientInfo.name` to match its registration, and refreshes and restarts with new tokens itself. |
| https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations | Preview limits for SIWC plan usage (Responses API field and tool restrictions; app-server uses `store: false`, HTTP/SSE). |

Still not read: `https://developers.openai.com/codex/auth` now redirects (HTTP 308) to `learn.chatgpt.com/docs/auth`, and `learn.chatgpt.com` is refused by this environment's proxy. `help.openai.com` returns 403.

### Updated conclusions

- **Commercial / hosted use: verified.** ChatGPT plan usage by third-party apps is documented for open-source and locally hosted apps only. Paid or remotely hosted apps need OpenAI's approval (interest form).
- **The SIWC route conflicts with Tacet's hard rule.** It requires the third-party app to obtain, store, refresh and inject the user's ChatGPT OAuth tokens. Tacet must not do this (AGENTS.md hard rule; `chatgptAuthTokens` is also internal-only). **Tacet does not implement SIWC.**
- What remains for Tacet is the user's own `codex login` inside the unmodified Codex binary (interactive use only, per the owner's 2026-11-09 rule for #12) or an API key. Whether OpenAI's terms say anything about launching the user's own logged-in `codex` from a local orchestrator is on `/codex/auth` (blocked). It stays **UNVERIFIED**, and the owner's API-key default already covers it.
