import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubprocessScrubError, withSubprocessScrub } from './auth.js';

describe('withSubprocessScrub (#150)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tacet-scrub-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A directory with stand-ins for the sandbox's tools; `bwrap` runs `bwrapScript`. */
  const bin = (name: string, tools: { bwrap?: string; socat?: boolean }) => {
    const dir = join(root, name);
    mkdirSync(dir);
    if (tools.bwrap !== undefined) {
      writeFileSync(join(dir, 'bwrap'), `#!/bin/sh\n${tools.bwrap}\n`, { mode: 0o755 });
    }
    if (tools.socat) writeFileSync(join(dir, 'socat'), '#!/bin/sh\n', { mode: 0o755 });
    return dir;
  };

  it('turns the scrub on where Claude Code’s sandbox can run', () => {
    const ok = bin('ok', { bwrap: 'exit 0', socat: true });
    const env = { PATH: `/usr/bin:${ok}`, ANTHROPIC_API_KEY: 'k' };
    // Linux checks the sandbox's tools on the Worker's own PATH (the system's may have them too,
    // so this PATH puts the stand-ins first).
    const first = { PATH: `${ok}:/usr/bin`, ANTHROPIC_API_KEY: 'k' };
    expect(withSubprocessScrub(first, 'linux')).toEqual({
      ...first,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    });
    // macOS needs nothing; an explicit opt-out in the user's environment does not win.
    expect(
      withSubprocessScrub({ ...env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' }, 'darwin'),
    ).toEqual({ ...env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
  });

  it('refuses on Linux, saying why, when the sandbox cannot run', () => {
    const cases: [string, string][] = [
      [bin('none', {}), 'bubblewrap (bwrap) is not on PATH'],
      [bin('nosocat', { bwrap: 'exit 0' }), 'socat is not on PATH'],
      [
        bin('denied', {
          bwrap: 'echo "bwrap: setting up uid map: Permission denied" >&2; exit 1',
          socat: true,
        }),
        'bubblewrap cannot create its sandbox (bwrap: setting up uid map: Permission denied)',
      ],
    ];
    for (const [dir, reason] of cases) {
      const run = () => withSubprocessScrub({ PATH: dir }, 'linux');
      expect(run).toThrow(SubprocessScrubError);
      expect(run).toThrow(`Claude's sandbox can't run here: ${reason}.`);
    }
    // A file that is not executable, or a relative PATH entry, does not count.
    const plain = join(root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'bwrap'), '', { mode: 0o644 });
    expect(() => withSubprocessScrub({ PATH: `${plain}:relative` }, 'linux')).toThrow(
      /not on PATH/,
    );
  });
});
