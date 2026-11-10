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
    return { ok: false, reason: `node-pty is not available here: ${err.message}` };
  }
}

/** A suite title that says why it was skipped. */
export function gatedTitle(title: string, gate: PtyGate): string {
  return gate.ok ? title : `${title} (skipped locally: ${gate.reason})`;
}
