# Tacet on Windows via WSL2

Tacet runs on Windows inside a WSL2 Linux distro, as it runs on Linux. Node, git, the vendor CLIs, Tacet and your repos all live in the distro ([ADR-002 addendum](adr/002-language-runtime.md), #193). Native Windows is not supported yet (#194).

Facts here were read from Microsoft's and each tool's own documentation on 2026-11-10. Microsoft's pages were read from their source repository (`github.com/MicrosoftDocs/WSL`), which `learn.microsoft.com` renders. Items marked UNVERIFIED were not confirmed.

## 1. Install WSL2 and a distro

From PowerShell or Command Prompt on Windows 10 version 2004 (build 19041) or later, or Windows 11:

```powershell
wsl --install                      # installs Ubuntu, with WSL 2
wsl --list --verbose               # the VERSION column must say 2
wsl --set-default-version 2        # if it does not
```

`wsl --list --online` lists other distros, and `wsl --install -d <Distro>` picks one. Tacet is tested on Ubuntu. Source: [Install WSL](https://learn.microsoft.com/windows/wsl/install).

Use WSL **2**, not WSL 1. The Claude Code and Codex sandboxes need it:
- Claude Code's sandbox runs on WSL2, and fails on WSL1 with "Sandboxing requires WSL2" ([Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)).
- Codex's Linux sandbox says WSL1 "can't create the required user namespaces" ([codex-rs/linux-sandbox README](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md)).

## 2. Node 24, pnpm and git inside the distro

Microsoft recommends a version manager over the distro's `apt` Node, which is outdated ([Node.js on WSL](https://learn.microsoft.com/windows/dev-environment/javascript/nodejs-on-wsl)). Tacet needs Node 24 or later:

```bash
sudo apt-get update && sudo apt-get install -y curl git build-essential
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 24
corepack enable            # pnpm, as pinned in package.json
```

`build-essential` is for `node-pty`, which the PTY adapter builds from source.

Check that `which node` and `which git` point inside the distro, not to `/mnt/c/...`. WSL appends the Windows `PATH` by default (`appendWindowsPath`, [WSL config](https://learn.microsoft.com/windows/wsl/wsl-config)), so a Windows Node can shadow the distro's one. A Windows npm on that `PATH` can also stop nvm: on a GitHub-hosted runner, nvm found the Windows npm's global prefix and exited with code 3 (observed in this repo's `wsl2` CI job, run 42880615723). Remove the Windows entries from `PATH` (`appendWindowsPath = false` under `[interop]` in `/etc/wsl.conf`, then `wsl --shutdown`), or install Node another way. The CI job installs the official Node 24 tarball from nodejs.org and checks it against `SHASUMS256.txt`.

## 3. Keep repos in the distro's file system

Clone your repos under `~/` in the distro, **not** under `/mnt/c` or another Windows drive. Microsoft's advice is to keep files in the Linux file system when you work from a Linux command line ([Working across file systems](https://learn.microsoft.com/windows/wsl/filesystems)). On a Windows drive (DrvFs), several things change:

- **Speed.** Access across the two systems is much slower under WSL2 than inside the distro ([Comparing WSL versions](https://learn.microsoft.com/windows/wsl/compare-versions)). Workers do many small file operations.
- **Permissions.** Without the `metadata` mount option (off by default), Linux modes come from Windows permissions and are the same for user, group and other, and `chmod` only toggles read-only ([File permissions](https://learn.microsoft.com/windows/wsl/file-permissions)).
- **Case sensitivity.** Directories are case-insensitive by default (`case=off`). Per-directory case sensitivity needs the `case=dir` mount option and `fsutil.exe file setCaseSensitiveInfo` on the directory ([Case sensitivity](https://learn.microsoft.com/windows/wsl/case-sensitivity)).
- **Symlinks.** They are stored as NTFS reparse points. Whether creating one needs a Windows privilege is UNVERIFIED.
- **Line endings.** If Windows-side git also works on the checkout, set consistent line endings with `.gitattributes` ([Git on WSL](https://learn.microsoft.com/windows/wsl/tutorials/wsl-git)).
- **File watching.** Whether Linux tools see changes made from Windows is not documented by Microsoft. An open WSL issue tracks it ([microsoft/WSL#4739](https://github.com/microsoft/WSL/issues/4739)).

Windows-side editors, indexers and git can change files while Tacet's Workers use the same checkout. Avoid that for repos Tacet works on.

`tacet run` warns, and carries on, when the repo or Tacet's state directory is on a Windows drive inside WSL. Under WSL means the kernel release names Microsoft or WSL ([microsoft/WSL#423](https://github.com/microsoft/WSL/issues/423)). A Windows drive means the mount holding the path (after symlinks) is DrvFs, or comes from a drive letter such as `C:\`, or is a `9p` or `virtiofs` mount of a drive letter under the automount root (`/mnt/` by default, `[automount] root` in `/etc/wsl.conf`). With no mount table to read, a drive letter under the automount root is enough. The fix it suggests is to clone the repo under `~/`.

The exact way WSL2 shows Windows drives in the mount table is not documented. The `wsl2` CI job (below) checks it on a real one.

## 4. Vendor CLIs and their sandboxes

Install the vendor CLIs inside the distro, as on Linux.

- **Claude Code.** Its sandbox needs `bubblewrap` and `socat`:

  ```bash
  sudo apt-get install -y bubblewrap socat
  ```

  On Ubuntu, AppArmor can stop bubblewrap from creating user namespaces. `sysctl kernel.apparmor_restrict_unprivileged_userns` prints `1` when it is restricted. The fixes are in [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing). Whether default Ubuntu on WSL2 restricts it is UNVERIFIED.
- **Codex.** Its Linux sandbox uses bubblewrap, from `PATH` or bundled, and works on WSL2 ([codex-rs/linux-sandbox README](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md)).
- **Gemini CLI.** It sandboxes with containers (Docker or Podman) and its sandbox page says nothing about WSL ([Gemini CLI sandbox](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md)).

Unattended Workers use API keys from the environment, as on Linux. Set them in the distro, for example in `~/.profile`, never in a repo.

## 5. CI

The `wsl2` workflow (`.github/workflows/wsl2.yml`) runs `pnpm install`, `lint`, `typecheck` and `test` inside Ubuntu 24.04 on WSL 2, in a clone under `~`, on a GitHub-hosted `windows-2025` runner. It uses [Vampire/setup-wsl](https://github.com/Vampire/setup-wsl). It also checks the Windows-drive detection against the real mount table.

It is **experimental and not a required check**. The windows-2025 image ships WSL 2 ([runner image README](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)), and users report it starting on GitHub-hosted runners ([actions/runner-images#11869](https://github.com/actions/runner-images/issues/11869)). GitHub's docs do not say it is supported, so it can break with the platform. It runs weekly, on demand, and on pull requests that change it or the WSL checks. The alternative, if it stops working, is a self-hosted Windows runner with nested virtualisation.
