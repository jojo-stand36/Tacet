import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOME_PLACEHOLDERS,
  placeholderSnapshot,
  removeSandboxPlaceholders,
  removeSandboxResidue,
  residueSnapshot,
  SANDBOX_ENV,
  SANDBOX_PLACEHOLDERS,
} from './placeholders.js';

describe('sandbox placeholders (#263)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'tacet-placeholders-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  /** What Claude Code's Linux sandbox leaves: an empty entry for every protected path missing. */
  const sandbox = () => {
    for (const p of [...SANDBOX_PLACEHOLDERS].reverse()) {
      // As observed on 2.1.319: these are empty directories, the rest empty files.
      const dir = [
        '.claude',
        '.claude/agents',
        '.claude/commands',
        'node_modules',
        'node_modules/.bin',
      ].includes(p);
      try {
        if (dir) mkdirSync(join(cwd, p), { recursive: true });
        else writeFileSync(join(cwd, p), '', { flag: 'wx' });
      } catch {
        // There already.
      }
    }
  };

  it('removes every placeholder the session added, leaving the checkout as it was', () => {
    writeFileSync(join(cwd, 'src.ts'), 'x');
    const before = placeholderSnapshot(cwd);
    sandbox();
    removeSandboxPlaceholders(cwd, before);
    expect(readdirSync(cwd)).toEqual(['src.ts']);
  });

  it('keeps what existed before, has content, or is a link, and new entries inside it', () => {
    writeFileSync(join(cwd, '.env'), '');
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'mine.md'), 'mine');
    mkdirSync(join(cwd, 'node_modules', 'x'), { recursive: true });
    const before = placeholderSnapshot(cwd);
    sandbox();
    // The Worker wrote these during the session.
    writeFileSync(join(cwd, 'package.json'), '{"name":"x"}');
    rmSync(join(cwd, 'yarn.lock'));
    symlinkSync('src.ts', join(cwd, 'yarn.lock'));
    mkdirSync(join(cwd, '.claude', 'agents', 'a'), { recursive: true });
    removeSandboxPlaceholders(cwd, before);
    expect(readdirSync(cwd).sort()).toEqual(
      ['.claude', '.env', 'node_modules', 'package.json', 'yarn.lock'].sort(),
    );
    // Inside a directory that existed: the sandbox's empty additions go, the Worker's stay.
    expect(readdirSync(join(cwd, '.claude')).sort()).toEqual(['agents', 'mine.md']);
    expect(readdirSync(join(cwd, 'node_modules'))).toEqual(['x']);
  });

  it('never follows a symlinked parent out of the checkout', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tacet-placeholders-out-'));
    try {
      mkdirSync(join(outside, 'agents'));
      const before = placeholderSnapshot(cwd);
      // The session made `.claude` a link to a directory elsewhere, holding an empty `agents/`.
      symlinkSync(outside, join(cwd, '.claude'));
      expect(removeSandboxPlaceholders(cwd, before)).toEqual([]);
      expect(readdirSync(outside)).toEqual(['agents']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("sandbox residue in the user's HOME (#263)", () => {
  let root: string;
  let cwd: string;
  let home: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tacet-residue-'));
    cwd = join(root, 'checkout');
    home = join(root, 'home');
    mkdirSync(cwd);
    mkdirSync(home);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const DIRS = new Set([
    '.npm',
    '.claude/ssh',
    '.claude',
    '.config/anthropic',
    '.config/gh',
    '.config/git',
    '.config/glab-cli',
    '.config/pip',
    '.config',
    '.pip',
  ]);
  /** What the sandbox leaves in HOME, as observed on 2.1.319: an empty entry for each missing. */
  const sandbox = () => {
    for (const p of [...HOME_PLACEHOLDERS].reverse()) {
      try {
        if (DIRS.has(p)) mkdirSync(join(home, p), { recursive: true });
        else writeFileSync(join(home, p), '', { flag: 'wx' });
      } catch {
        // There already.
      }
    }
  };

  it('leaves HOME as it was, and never touches what was there or has content', () => {
    // The user's own: a dotfile (even an empty one), a config dir with a file in it.
    writeFileSync(join(home, '.bashrc'), 'alias x=y\n');
    writeFileSync(join(home, '.netrc'), '');
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'x');
    const r = residueSnapshot(cwd, home, 'linux');
    sandbox();
    // Written during the session: kept, being someone's.
    writeFileSync(join(home, '.gitconfig'), '[user]\n');
    mkdirSync(join(home, '.npm', '_cacache'), { recursive: true });
    const removed = removeSandboxResidue(r);
    expect(removed).toContain(join('~', '.zshrc'));
    expect(removed).not.toContain(join('~', '.netrc'));
    expect(readdirSync(home).sort()).toEqual(
      ['.bashrc', '.config', '.gitconfig', '.netrc', '.npm'].sort(),
    );
    expect(readdirSync(join(home, '.config'))).toEqual(['gh']);
  });

  it('removes nothing behind a symlinked parent in HOME', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(join(elsewhere, 'git'), { recursive: true });
    const r = residueSnapshot(cwd, home, 'linux');
    symlinkSync(elsewhere, join(home, '.config'));
    removeSandboxResidue(r);
    expect(readdirSync(join(elsewhere))).toEqual(['git']);
  });

  it('leaves HOME alone outside Linux, or for a session without a HOME', () => {
    for (const r of [
      residueSnapshot(cwd, home, 'darwin'),
      residueSnapshot(cwd, undefined, 'linux'),
    ]) {
      sandbox();
      expect(removeSandboxResidue(r)).toEqual([]);
      expect(readdirSync(home)).toContain('.bashrc');
    }
  });

  it('turns the npm log off for the sessions it runs', () => {
    expect(SANDBOX_ENV).toEqual({ npm_config_logs_max: '0' });
  });
});
