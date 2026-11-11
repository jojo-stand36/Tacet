import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@tacet/core/node';
import { buildWorkerAdapters } from '@tacet/mini/workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Io } from '../io.js';
import { main } from '../main.js';
import { repoRootFrom } from '../state.js';
import { WORKER_ADAPTERS } from './init.js';

let dir: string;
let repo: string;
let home: string;
let bin: string;

const tacet = async (argv: string[], extra: Partial<Io> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    cwd: repo,
    home,
    env: { PATH: bin },
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

/** Every file under `root` with its bytes, for byte-for-byte comparison. */
function snapshot(root: string, skip: string[] = []): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string, rel: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.includes(r)) continue;
      if (e.isDirectory()) walk(join(at, e.name), r);
      else files[r] = readFileSync(join(at, e.name)).toString('base64');
    }
  };
  walk(root, '');
  return files;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tacet-init-'));
  repo = join(dir, 'repo');
  home = join(dir, 'home');
  bin = join(dir, 'bin');
  for (const d of [repo, home, bin]) mkdirSync(d);
  execFileSync('git', ['init', '-q', repo]);
  // An existing repo already set up for coding agents.
  writeFileSync(join(repo, 'CLAUDE.md'), '@AGENTS.md\n\nClaude notes\r\n');
  writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n\nRules.\n');
  mkdirSync(join(repo, '.claude', 'skills', 'x'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), '{"permissions":{"allow":[]}}');
  writeFileSync(join(repo, '.claude', 'skills', 'x', 'SKILL.md'), '---\nname: x\n---\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ scripts: { test: 'vitest', lint: 'biome check' } }),
  );
});
/**
 * Gives the owner write access to every directory under `root`. A test that makes a directory
 * read-only leaves read-only copies too (a backup keeps modes), which `rmSync` cannot empty unless
 * the tests run as root.
 */
function makeWritable(root: string): void {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const at = join(root, e.name);
    chmodSync(at, 0o700);
    makeWritable(at);
  }
}

afterEach(() => {
  makeWritable(dir);
  rmSync(dir, { recursive: true, force: true });
});

describe('tacet init (#20)', () => {
  it('writes only .tacet/ and leaves the repo’s agent files and .gitignore byte-identical', async () => {
    const before = snapshot(repo, ['.git']);
    const r = await tacet(['init', '--model', 'some-model']);
    expect(r.code).toBe(0);
    const after = snapshot(repo, ['.git']);
    const added = Object.keys(after).filter((f) => !(f in before));
    expect(added.sort()).toEqual(['.tacet/.gitignore', '.tacet/tacet.yaml']);
    for (const [f, bytes] of Object.entries(before)) expect(after[f], f).toBe(bytes);
  });

  it('writes a config `tacet run` accepts, and git ignores local.yaml', async () => {
    expect((await tacet(['init', '--model', 'some-model'])).code).toBe(0);
    const { config } = loadConfig({ repoRoot: repo, userDir: join(home, '.tacet') });
    expect(config.tiers?.worker).toEqual({ adapter: 'claude-sdk', model: 'some-model' });
    expect(config.tiers?.mini).toBeUndefined();
    expect(config.review?.enabled).toBeFalsy();
    expect(config.verify).toEqual([]);
    expect(Object.keys(buildWorkerAdapters(config, { baseEnv: {} }))).toEqual(['claude-sdk']);

    writeFileSync(join(repo, '.tacet', 'local.yaml'), 'escalation:\n  autonomy: low\n');
    const ignored = execFileSync('git', [
      '-C',
      repo,
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    expect(ignored.toString()).toContain('.tacet/tacet.yaml');
    expect(ignored.toString()).not.toContain('local.yaml');
  });

  it('suggests verify commands from package.json without switching them on', async () => {
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '');
    await tacet(['init', '--model', 'm']);
    const yaml = readFileSync(join(repo, '.tacet', 'tacet.yaml'), 'utf8');
    expect(yaml).toContain('#   - pnpm lint\n#   - pnpm test');
    expect(yaml).not.toMatch(/^verify:/m);
  });

  it('is idempotent: a re-run keeps every file, even ones the user edited', async () => {
    await tacet(['init', '--model', 'm']);
    const path = join(repo, '.tacet', 'tacet.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}verify: [make check]\n`);
    const first = snapshot(repo);
    const r = await tacet(['init', '--worker', 'codex-app-server', '--model', 'other']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('.tacet/tacet.yaml   kept (already there)');
    expect(r.out).toContain('.tacet/.gitignore   kept (already there)');
    expect(snapshot(repo)).toEqual(first);
  });

  it('without a model and no terminal, leaves the model to set and says so', async () => {
    const r = await tacet(['init']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('next: set tiers.worker.model in .tacet/tacet.yaml');
    const { config } = loadConfig({ repoRoot: repo, userDir: join(home, '.tacet') });
    expect(() => buildWorkerAdapters(config, { baseEnv: {} })).toThrow(
      'tiers.worker.model: claude-sdk needs a model',
    );
  });

  it('asks for the model on a terminal', async () => {
    const asked: string[] = [];
    const prompt = async (q: string) => {
      asked.push(q);
      return q.startsWith('Model') ? '  picked-model ' : '';
    };
    expect((await tacet(['init'], { prompt })).code).toBe(0);
    expect(asked).toHaveLength(2);
    const { config } = loadConfig({ repoRoot: repo, userDir: join(home, '.tacet') });
    expect(config.tiers?.worker?.model).toBe('picked-model');
  });

  it('quotes a model id so YAML cannot reinterpret it', async () => {
    await tacet(['init', '--model', 'a: b # c']);
    const { config } = loadConfig({ repoRoot: repo, userDir: join(home, '.tacet') });
    expect(config.tiers?.worker?.model).toBe('a: b # c');
  });

  it('sets up an ACP Worker from PATH, with no model', async () => {
    writeFileSync(join(bin, 'gemini'), '#!/bin/sh\n');
    chmodSync(join(bin, 'gemini'), 0o755);
    const r = await tacet(['init', '--worker', 'acp:gemini'], {
      env: { PATH: bin, GEMINI_API_KEY: 'secret-value-123' },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/acp:gemini +available; GEMINI_API_KEY set/);
    expect(r.out).toMatch(/acp:claude-acp +not on PATH/);
    expect(r.out).toContain('Agent CLIs on PATH: gemini');
    expect(`${r.out}${r.err}`).not.toContain('secret-value-123');
    const { config } = loadConfig({ repoRoot: repo, userDir: join(home, '.tacet') });
    expect(config.tiers?.worker).toEqual({ adapter: 'acp:gemini' });
  });

  it('reports adapters and keys as JSON, names only', async () => {
    const r = await tacet(['init', '--model', 'm', '--json'], {
      env: { PATH: bin, OPENAI_API_KEY: 'sk-not-printed' },
    });
    const report = JSON.parse(r.out);
    expect(report.files).toEqual({
      '.tacet/tacet.yaml': 'written',
      '.tacet/.gitignore': 'written',
    });
    expect(report.adapters).toContainEqual({
      id: 'codex-app-server',
      available: true,
      keys: [
        { name: 'OPENAI_API_KEY', set: true },
        { name: 'CODEX_API_KEY', set: false },
      ],
    });
    expect(r.out).not.toContain('sk-not-printed');
  });

  it('refuses bad flags, a non-repo and symbolic links', async () => {
    expect((await tacet(['init', '--worker', 'nope'])).code).toBe(2);
    expect((await tacet(['init', '--worker', 'acp:gemini', '--model', 'x'])).code).toBe(2);
    expect((await tacet(['init', 'extra'])).code).toBe(2);
    expect(existsSync(join(repo, '.tacet'))).toBe(false);

    const plain = join(dir, 'plain');
    mkdirSync(plain);
    // Only meaningful where no directory above the temp dir looks like a repo.
    if (repoRootFrom(plain) === plain) {
      expect((await tacet(['init', '--repo', plain])).code).toBe(1);
      expect(existsSync(join(plain, '.tacet'))).toBe(false);
    }

    // A Claude Code sandbox skeleton (`.git` with config, hooks and info but no
    // HEAD) above a plain directory does not make it a repo (#326).
    const skel = join(dir, 'skel');
    mkdirSync(join(skel, '.git', 'info', '.claude-sandbox-noreplace'), { recursive: true });
    mkdirSync(join(skel, '.git', 'hooks'));
    writeFileSync(join(skel, '.git', 'config'), '');
    const under = join(skel, 'plain');
    mkdirSync(under);
    expect(repoRootFrom(under)).not.toBe(skel);
    if (repoRootFrom(under) === under) {
      expect((await tacet(['init', '--repo', under])).code).toBe(1);
      expect(existsSync(join(under, '.tacet'))).toBe(false);
      expect(existsSync(join(skel, '.tacet'))).toBe(false);
    }

    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(repo, '.tacet'));
    const r = await tacet(['init', '--model', 'm']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('.tacet must be a directory');
    expect(readdirSync(elsewhere)).toEqual([]);

    rmSync(join(repo, '.tacet'));
    mkdirSync(join(repo, '.tacet'));
    symlinkSync(join(elsewhere, 'x.yaml'), join(repo, '.tacet', 'tacet.yaml'));
    expect((await tacet(['init', '--model', 'm'])).code).toBe(1);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe('tacet init: merged worktree cleanup (#210)', () => {
  const cleanup = () =>
    loadConfig({ repoRoot: repo, userDir: join(home, '.tacet') }).config.worktrees?.remove_merged;
  const written = () => readFileSync(join(repo, '.tacet', 'tacet.yaml'), 'utf8');

  it('defaults to removing, and writes only a comment for the default', async () => {
    expect((await tacet(['init', '--model', 'm'])).code).toBe(0);
    expect(cleanup()).toBe(true);
    expect(written()).toContain('# worktrees:\n#   remove_merged: false');
    expect(written()).not.toMatch(/^worktrees:/m);
  });

  it('writes the opt-out with --keep-merged-worktrees, and loadConfig takes it', async () => {
    const r = await tacet(['init', '--model', 'm', '--keep-merged-worktrees', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).removeMerged).toBe(false);
    expect(written()).toMatch(/^worktrees:\n {2}remove_merged: false$/m);
    expect(cleanup()).toBe(false);
  });

  it('asks on a terminal, once more after an answer it cannot read', async () => {
    const answers = ['maybe', 'n'];
    const asked: string[] = [];
    const prompt = async (q: string) => {
      asked.push(q);
      return answers.shift() ?? '';
    };
    expect((await tacet(['init', '--model', 'm'], { prompt })).code).toBe(0);
    expect(asked).toEqual([
      'Remove worktrees automatically after their work is merged? [Y/n] ',
      'Remove worktrees automatically after their work is merged? [Y/n] ',
    ]);
    expect(cleanup()).toBe(false);
  });

  it('takes the default after two answers it cannot read, and never asks with the flag', async () => {
    let asked = 0;
    const prompt = async () => {
      asked += 1;
      return 'what';
    };
    expect((await tacet(['init', '--model', 'm'], { prompt })).code).toBe(0);
    expect(asked).toBe(2);
    expect(cleanup()).toBe(true);
  });

  it('does not ask when the flag is given', async () => {
    let asked = 0;
    const prompt = async () => {
      asked += 1;
      return 'y';
    };
    await tacet(['init', '--model', 'm', '--keep-merged-worktrees'], { prompt });
    expect(asked).toBe(0);
    expect(cleanup()).toBe(false);
  });
});

describe('tacet init: every adapter it offers (#20)', () => {
  for (const worker of Object.keys(WORKER_ADAPTERS)) {
    it(`writes a config tacet run can build Workers from: ${worker}`, async () => {
      const needsModel = WORKER_ADAPTERS[worker as keyof typeof WORKER_ADAPTERS].needsModel;
      const r = await tacet([
        'init',
        '--worker',
        worker,
        ...(needsModel ? ['--model', 'm'] : []),
        // With the cleanup setting active, so loadConfig is seen to accept it (#210).
        '--keep-merged-worktrees',
      ]);
      expect(r.code).toBe(0);
      const { config } = loadConfig({ repoRoot: repo, userDir: join(home, '.tacet') });
      expect(config.worktrees?.remove_merged).toBe(false);
      expect(Object.keys(buildWorkerAdapters(config, { baseEnv: {}, repoRoot: repo }))).toEqual([
        worker,
      ]);
    });
  }
});

describe('tacet init: input and failure paths (#20)', () => {
  it('refuses an empty or blank --model and writes nothing', async () => {
    for (const model of ['', '   ']) {
      const r = await tacet(['init', '--model', model]);
      expect(r.code).toBe(2);
    }
    expect(existsSync(join(repo, '.tacet'))).toBe(false);
  });

  it('trims --model', async () => {
    await tacet(['init', '--model', '  m1  ']);
    const { config } = loadConfig({ repoRoot: repo, userDir: join(home, '.tacet') });
    expect(config.tiers?.worker?.model).toBe('m1');
  });

  it('keeps a model with a newline intact', async () => {
    const r = await tacet(['init', '--model', 'a\nb']);
    // A newline is a valid string; the schema accepts it, and quoting keeps it intact.
    expect(r.code).toBe(0);
    const { config } = loadConfig({ repoRoot: repo, userDir: join(home, '.tacet') });
    expect(config.tiers?.worker?.model).toBe('a\nb');
  });

  it('reports .tacet as a regular file instead of crashing, and asks nothing', async () => {
    writeFileSync(join(repo, '.tacet'), 'x');
    let asked = 0;
    const r = await tacet(['init'], {
      prompt: async () => {
        asked += 1;
        return 'm';
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('.tacet must be a directory');
    expect(asked).toBe(0);
    expect(readFileSync(join(repo, '.tacet'), 'utf8')).toBe('x');
  });

  it('never prompts with --json', async () => {
    let asked = 0;
    const r = await tacet(['init', '--json'], {
      prompt: async () => {
        asked += 1;
        return 'm';
      },
    });
    expect(asked).toBe(0);
    expect(JSON.parse(r.out).modelMissing).toBe(true);
  });

  it('says so when --worker or --model would change an existing config', async () => {
    await tacet(['init', '--model', 'm']);
    const r = await tacet(['init', '--worker', 'codex-app-server', '--model', 'x']);
    expect(r.err).toContain('--worker, --model and --keep-merged-worktrees are ignored');
    expect((await tacet(['init', '--keep-merged-worktrees'])).err).toContain('are ignored');
    expect((await tacet(['init'])).err).not.toContain('ignored');
  });

  it('refuses a repo whose .tacet/ is the user directory (home kept in git)', async () => {
    execFileSync('git', ['init', '-q', home]);
    mkdirSync(join(home, '.tacet', 'state'), { recursive: true });
    writeFileSync(join(home, '.tacet', 'config.yaml'), 'escalation:\n  autonomy: low\n');
    const notes = join(home, 'notes');
    mkdirSync(notes);
    const before = snapshot(join(home, '.tacet'));
    for (const argv of [
      ['init', '--model', 'm'],
      ['uninstall', '--purge', '--apply'],
      ['uninstall', '--apply'],
    ]) {
      const r = await tacet(argv, { cwd: notes });
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).toContain("Tacet's user directory");
    }
    expect(snapshot(join(home, '.tacet'))).toEqual(before);
    expect(existsSync(join(home, '.tacet', 'backups'))).toBe(false);
  });
});

describe('tacet run before tacet init (#20)', () => {
  it('points to tacet init', async () => {
    const r = await tacet(['run', '--user-dir', join(home, '.tacet'), 'x']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('config has no tiers.worker');
    expect(r.err).toContain('run `tacet init` first');
  });
});

describe('tacet uninstall (#20)', () => {
  it('previews by default, then removes only what init wrote, unchanged', async () => {
    const before = snapshot(repo, ['.git']);
    await tacet(['init', '--model', 'm']);
    const preview = await tacet(['uninstall']);
    expect(preview.out).toContain(`would remove ${join(repo, '.tacet', 'tacet.yaml')}`);
    expect(preview.err).toContain('preview only');
    expect(existsSync(join(repo, '.tacet', 'tacet.yaml'))).toBe(true);

    expect((await tacet(['uninstall', '--apply'])).code).toBe(0);
    expect(snapshot(repo, ['.git'])).toEqual(before);
  });

  it('keeps edited and user files without --purge', async () => {
    await tacet(['init', '--model', 'm']);
    const yaml = join(repo, '.tacet', 'tacet.yaml');
    writeFileSync(yaml, `${readFileSync(yaml, 'utf8')}verify: [make]\n`);
    writeFileSync(join(repo, '.tacet', 'local.yaml'), '{}\n');
    const r = await tacet(['uninstall', '--apply']);
    expect(r.out).toContain(`removed ${join(repo, '.tacet', '.gitignore')}`);
    expect(r.out).toContain(`kept ${yaml}`);
    expect(readdirSync(join(repo, '.tacet')).sort()).toEqual(['local.yaml', 'tacet.yaml']);
  });

  it('keeps committed files, even unchanged, unless --purge (owner decision on #209)', async () => {
    await tacet(['init', '--model', 'm']);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
    git('add', '.tacet/tacet.yaml');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'tacet');
    const yaml = join(repo, '.tacet', 'tacet.yaml');
    const r = await tacet(['uninstall', '--apply']);
    expect(r.out).toContain(`kept ${yaml} (committed to git)`);
    expect(r.out).toContain(`removed ${join(repo, '.tacet', '.gitignore')}`);
    expect(readdirSync(join(repo, '.tacet'))).toEqual(['tacet.yaml']);

    const json = JSON.parse((await tacet(['uninstall', '--json'])).out);
    expect(json.committed).toEqual([yaml]);
    expect((await tacet(['uninstall', '--purge', '--apply'])).code).toBe(0);
    expect(existsSync(join(repo, '.tacet'))).toBe(false);
  });

  it('--purge backs .tacet/ up to ~/.tacet/backups, then removes it', async () => {
    await tacet(['init', '--model', 'm']);
    writeFileSync(join(repo, '.tacet', 'local.yaml'), 'mine\n');
    const saved = snapshot(join(repo, '.tacet'));
    const preview = await tacet(['uninstall', '--purge', '--json']);
    expect(JSON.parse(preview.out).applied).toBe(false);
    expect(existsSync(join(repo, '.tacet'))).toBe(true);

    const r = JSON.parse((await tacet(['uninstall', '--purge', '--apply', '--json'])).out);
    expect(existsSync(join(repo, '.tacet'))).toBe(false);
    expect(r.backup.startsWith(join(home, '.tacet', 'backups', 'repo-'))).toBe(true);
    expect(snapshot(join(r.backup, '.tacet'))).toEqual(saved);
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(repo, '.claude', 'settings.json'))).toBe(true);
  });

  it('backs up symbolic links as links, and refuses a symlinked .tacet', async () => {
    await tacet(['init', '--model', 'm']);
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'keep me');
    symlinkSync(outside, join(repo, '.tacet', 'link'));
    const r = JSON.parse((await tacet(['uninstall', '--purge', '--apply', '--json'])).out);
    // The link is backed up as a link, and its target is left alone.
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    expect(lstatSync(join(r.backup, '.tacet', 'link')).isSymbolicLink()).toBe(true);

    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'tacet.yaml'), 'x');
    symlinkSync(elsewhere, join(repo, '.tacet'));
    const refused = await tacet(['uninstall', '--purge', '--apply']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('.tacet must be a directory');
    expect(readdirSync(elsewhere)).toEqual(['tacet.yaml']);
  });

  it('leaves .tacet/ and claims no backup when the backup cannot be made', async () => {
    await tacet(['init', '--model', 'm']);
    mkdirSync(join(home, '.tacet'));
    writeFileSync(join(home, '.tacet', 'backups'), 'a file, not a directory');
    const before = snapshot(join(repo, '.tacet'));
    const r = await tacet(['uninstall', '--purge', '--apply']);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('the backup is at');
    expect(snapshot(join(repo, '.tacet'))).toEqual(before);
  });

  it('names the backup when removing .tacet/ fails after it', async () => {
    await tacet(['init', '--model', 'm']);
    const sub = join(repo, '.tacet', 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'f'), 'x');
    chmodSync(sub, 0o500);
    try {
      const r = await tacet(['uninstall', '--purge', '--apply']);
      // As root, removal succeeds anyway; the message is only checked where it fails.
      if (r.code === 1) {
        const at = /the backup is at (.+)$/m.exec(r.err)?.[1];
        expect(at && existsSync(join(at, '.tacet', 'sub', 'f'))).toBe(true);
      }
    } finally {
      // The backup keeps sub's mode too; afterEach makes both writable again.
      makeWritable(dir);
    }
  });

  it('refuses outside a git repo', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(join(plain, '.tacet'), { recursive: true });
    // Only meaningful where no directory above the temp dir looks like a repo.
    if (repoRootFrom(plain) !== plain) return;
    const r = await tacet(['uninstall', '--purge', '--apply', '--repo', plain]);
    expect(r.code).toBe(1);
    expect(existsSync(join(plain, '.tacet'))).toBe(true);
  });

  it('has nothing to do without .tacet/', async () => {
    const r = await tacet(['uninstall', '--apply']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('nothing to remove');
  });
});
