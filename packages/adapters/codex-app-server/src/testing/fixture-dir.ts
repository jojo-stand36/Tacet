import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxTempRoots } from '../adapter.js';

/**
 * A fresh directory for a test repo that an unattended Codex Worker runs in: outside every temp
 * dir Codex's sandbox leaves writable with `privateTmpdir: false` (`/tmp`, `$TMPDIR`), where the
 * adapter then refuses to start (#293) and the sandbox could not protect the shared `.git`. The package's own
 * gitignored `node_modules/.cache` first, then `~/.cache/tacet-tests` (for a checkout that is
 * itself under `/tmp`). The caller removes it.
 */
export function codexFixtureDir(prefix: string): string {
  const roots = [
    ...new Set([...sandboxTempRoots(process.env.TMPDIR), ...sandboxTempRoots(tmpdir())]),
  ];
  const candidates = [
    fileURLToPath(new URL('../../node_modules/.cache/', import.meta.url)),
    join(homedir(), '.cache', 'tacet-tests'),
  ];
  for (const c of candidates) {
    mkdirSync(c, { recursive: true });
    const real = realpathSync.native(c);
    if (roots.some((r) => real === r || real.startsWith(r + sep))) continue;
    return realpathSync.native(mkdtempSync(join(real, prefix)));
  }
  throw new Error(
    `no place for a Codex test repo outside the sandbox's temp dirs (${roots.join(', ')}): ` +
      `tried ${candidates.join(', ')}`,
  );
}
