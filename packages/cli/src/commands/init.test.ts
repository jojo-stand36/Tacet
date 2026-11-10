import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
      return '  picked-model ';
    };
    expect((await tacet(['init'], { prompt })).code).toBe(0);
    expect(asked).toHaveLength(1);
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

  it('has nothing to do without .tacet/', async () => {
    const r = await tacet(['uninstall', '--apply']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('nothing to remove');
  });
});
