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

  it('turns the scrub on, and on Linux needs bubblewrap on the Worker PATH', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\n', { mode: 0o755 });
    // A file that is not executable does not count.
    const other = join(root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'bwrap'), '', { mode: 0o644 });
    const env = { PATH: `${other}:${bin}`, ANTHROPIC_API_KEY: 'k' };
    expect(withSubprocessScrub(env, 'linux')).toEqual({
      ...env,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    });
    expect(() => withSubprocessScrub({ PATH: other }, 'linux')).toThrow(SubprocessScrubError);
    expect(() => withSubprocessScrub({}, 'linux')).toThrow(/install it/);
    // An explicit opt-out in the user's environment does not win.
    expect(withSubprocessScrub({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' }, 'darwin')).toEqual({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    });
  });
});
