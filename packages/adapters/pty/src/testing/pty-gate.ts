import { loadPty, PtyUnavailableError } from '../pty.js';

export type PtyGate = { ok: true } | { ok: false; reason: string };

/**
 * Whether the tests that drive a real PTY can run (#189). In CI (`CI` set, as GitHub Actions
 * does) node-pty must load: a PTY suite that quietly skipped there would prove nothing, so the
 * failure is thrown. On a developer's machine where node-pty could not be built (no C++
 * toolchain for node-gyp), those suites skip with the reason instead of failing.
 */
export async function ptyGate(
  env: Record<string, string | undefined> = process.env,
  load: () => Promise<unknown> = loadPty,
): Promise<PtyGate> {
  try {
    await load();
    return { ok: true };
  } catch (err) {
    if (!(err instanceof PtyUnavailableError) || env.CI) throw err;
    const reason = `node-pty is not available here: ${err.message}`;
    // The default reporter prints neither skipped suites' titles nor console output of passing
    // files: write straight to stderr, where a developer sees it.
    process.stderr.write(`Skipping the PTY suites (CI would fail): ${reason}\n`);
    return { ok: false, reason };
  }
}

/** A suite title that says why it was skipped. */
export function gatedTitle(title: string, gate: PtyGate): string {
  return gate.ok ? title : `${title} (skipped locally: ${gate.reason})`;
}
