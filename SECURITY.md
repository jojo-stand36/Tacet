# Security policy

## Supported versions

Tacet is pre-release (milestone M0). Only the default branch receives security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them privately with GitHub's [private vulnerability reporting](../../security/advisories/new) for this repository. Include steps to reproduce, the affected version or commit, and the impact you expect.

We aim to acknowledge reports within a few days and will keep you informed while a fix is prepared.

## Scope notes

Tacet launches third-party agent CLIs and SDKs under the user's own credentials. By design it never stores, logs, proxies or copies vendor OAuth or subscription tokens, and its local servers bind to `127.0.0.1` with a token by default (see [`AGENTS.md`](AGENTS.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)). A report that Tacet breaks one of these rules is in scope.
