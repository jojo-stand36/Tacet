# Spike #160: reading `{ keychain: "service/account" }` secret references

Checked 2026-11-10. Implemented in `packages/core/src/node/config/keychain.ts` (`readKeychain`), and used by `resolveSecretRef`.

## How a reference is read

`service/account` is split at the first `/`: the service is the part before it, the account everything after. Neither may be empty or start with `-`, because both become arguments of the platform tool. The tool runs without a shell, with stdin closed and a 20 s timeout. Only the service and account are on its command line. The value comes back on stdout and is held as a `Secret`. Tacet never unlocks a keychain or answers a prompt.

| Platform | Command | Found | Missing | Locked |
|---|---|---|---|---|
| macOS | `security find-generic-password -s <service> -a <account> -w` | exit 0; the password, then `\n` (stripped). The password is printed as **hex** when any byte is not printable ASCII | exit 44 (`errSecItemNotFound`, -25300) | the search fails like a missing item (44); reading the password can fail with its own status, for example 51 (`errSecAuthFailed`, -25293) or 36 (`errSecInteractionNotAllowed`, -25308). A GUI unlock prompt can also hold the tool until the timeout |
| Linux | `secret-tool lookup service <service> account <account>` | exit 0; the value exactly as stored, nothing added | exit 1, no output | exit 1, no output (the unlock prompt needs a display), so the same as missing |

- **Linux without a session bus:** exit 1 with `Cannot autolaunch D-Bus without X11 $DISPLAY`. The error passes on that line.
- **Tool not installed:** `ENOENT`. The error says what to install: `libsecret-tools` (Debian, Ubuntu) and a Secret Service such as gnome-keyring. On macOS, `security` ships at `/usr/bin/security`.
- **Other platforms** are refused.
- **Store with:**
  - macOS: `security add-generic-password -s <service> -a <account> -w`; with no value after `-w`, it prompts for it.
  - Linux: `secret-tool store --label=<label> service <service> account <account>`, which reads the value from stdin.

  Keep values to printable ASCII, as API keys are: macOS reads anything else back as hex.

## Sources

- **macOS:** Apple's `security` source, `apple-oss-distributions/Security` at `db15acb`:
  - `SecurityTool/macOS/keychain_find.c`: `do_password_item_printing` writes the password, or hex if any byte fails `isprint`, then `\n`. `do_keychain_find_generic_password` returns `errSecItemNotFound` when the search finds nothing.
  - `SecurityTool/macOS/security.c`: `main` returns the command's status as the exit code, so a negative `OSStatus` exits with its low byte, which is why -25300 gives 44.
  - `SecurityTool/macOS/security.1`: the `-s`, `-a` and `-w` options.
  - `base/SecBase.h`: the status values.

  Not run on a Mac (none is available here), so the exit codes come from the source.
- **Linux:** run live on Ubuntu with libsecret-tools 0.21.4 and gnome-keyring 46.1, in a throwaway `dbus-run-session` with a temporary keyring and fake values. Both `secret-tool` directly and `readKeychain` from the built package were run, covering:
  - found;
  - missing;
  - locked (`secret-tool lock --collection=login`);
  - no session bus.

## What CI cannot test

CI has no keychain: no Secret Service or session bus on Ubuntu, and no unlocked login keychain on macOS. So the unit tests replace the tool (`KeychainOptions.run`) and cover:
- the command line;
- the macOS trailing newline;
- missing, locked, refused and timed-out reads;
- a missing tool;
- malformed references;
- that no value ever appears in an error.

The real tools were checked by hand as above: Linux live, macOS from the source. Re-check on macOS when a Mac is available: read a stored item with `readKeychain`, and observe exit 44 for a missing one.
