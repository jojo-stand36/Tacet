# Spike #67: who publishes the PyPI `openai-codex-sdk` package?

Checked 2026-11-09. Follow-up from ADR-002.

## Answer

**`openai-codex-sdk` is not OpenAI's official package. Treat it as third-party, with an unverified publisher.** OpenAI's official Python SDK for Codex is **`openai-codex`**.

| | `openai-codex-sdk` | `openai-codex` |
|---|---|---|
| Latest version | 0.1.11 (uploaded 2026-01-19; all releases 0.1.x from 2026-01-18 to 2026-01-19) | 0.167.0 (tracks the Codex CLI version) |
| Declared author | "OpenAI" (free-text metadata; anyone can set this) | "OpenAI" |
| Project URLs | none | `github.com/openai/codex`, docs at `sdk/python/docs` |
| Upload provenance (PyPI Integrity API) | "No provenance available" for `openai_codex_sdk-0.1.11-py3-none-any.whl` | Trusted Publishing attestation: GitHub repo `openai/codex`, workflow `python-sdk-cli-release.yml` |
| In `openai/codex` source | no | yes: `sdk/python/pyproject.toml` has `name = "openai-codex"` (the repo also has `openai-codex-cli-bin`) |

The PyPI project HTML page returned a JavaScript challenge, so the maintainer list could not be read. The conclusion rests on the provenance and source evidence above.

## Sources (2026-11-09)

- https://pypi.org/pypi/openai-codex-sdk/json , https://pypi.org/integrity/openai-codex-sdk/0.1.11/openai_codex_sdk-0.1.11-py3-none-any.whl/provenance
- https://pypi.org/pypi/openai-codex/json , and the Integrity API provenance for its latest wheel
- `openai/codex` at tag `rust-v0.167.0`: `sdk/python/pyproject.toml`

## Consequence

No Tacet code may depend on `openai-codex-sdk`. If Python is ever reconsidered (ADR-002 decision 6 keeps it out of core), the candidate is `openai-codex`. Pin it and check its provenance. For ADR-001: OpenAI ships official SDKs for Codex in TypeScript and Python (`sdk/typescript`, `sdk/python`) alongside the app-server protocol.
