# CLI: repository setup

## Initialize a repository

Run `tacet init [--repo DIR]` from a repository, or pass its path with `--repo`. It creates
`.tacet/tacet.yaml` with baseline policy only when the file is absent, and adds
`.tacet/local.yaml` to the repository's `.gitignore` once. Existing configuration is preserved.

`tacet init` checks `PATH` for `claude`, `codex`, `gemini`, `opencode` and `goose`. It does not
determine whether a CLI is logged in; authentication status is reported as unknown. Tacet does not
inspect vendor login stores or credentials. Vendor-safe login-status checks are not implemented.

This command scaffolds repository configuration only. It does not install or start a
Mini-conductor.

## Uninstall

`tacet uninstall [--repo DIR]` is preview-only. It lists the unchanged generated config it could
remove; customized config and other files are preserved. Add `--apply` to remove that generated
config and its directory only if the directory becomes empty. The `.gitignore` entry is retained
because it may be user-owned.

`tacet uninstall --purge` previews removal of the entire repo-local `.tacet/` directory. Add both
`--apply --purge` to proceed. Before deletion, Tacet copies `.tacet/` to a timestamped backup under
`~/.tacet/backups/`. If the backup cannot be created, the original directory is left in place.
