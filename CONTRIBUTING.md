# Contributing to Tacet

Thanks for helping. Tacet is built by humans and AI coding agents (Claude Code and the GitHub Copilot cloud agent) working from the same rules.

## Before you start

- Read [`AGENTS.md`](AGENTS.md). It is the canonical rule set for every contributor, human or agent: conventions, hard rules and the definition of done.
- Pick an issue from the [roadmap](ROADMAP.md). GitHub issues are the source of truth for scope. New work you discover becomes a new issue, not scope creep.
- Hard-to-reverse design decisions need an ADR in [`docs/adr/`](docs/adr/) and a human approver.

## Development setup

Requirements: Node.js 24 or later (`.nvmrc`), pnpm 12 (pinned in `package.json` `packageManager`; use `corepack enable` on Node 24, or install pnpm directly on Node 25+, which no longer bundles Corepack), macOS or Linux. Windows is not a supported platform ([ADR-002](docs/adr/002-language-runtime.md)).

```bash
corepack enable   # Node 24; on Node 25+ install pnpm 12 instead
pnpm install
pnpm lint        # Biome: lint + format check
pnpm typecheck   # tsc -b over every package
pnpm test        # Vitest
```

All four must pass before a PR is ready. CI runs them on Ubuntu and macOS with Node 24 and Node 26.

## Pull requests

- Branch as `<agent-or-name>/<issue-number>-<slug>`, for example `claude/12-worktree-manager`.
- Use Conventional Commits and reference the issue: `feat(mini): worktree GC (#12)`.
- Fill in the PR template and link the issue with `Closes #N`.
- Justify every new runtime dependency in the PR description.
- Never commit secrets, `.env` files or API keys.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE). If you port code from another project, keep its license terms and add an entry to [`NOTICE`](NOTICE).
