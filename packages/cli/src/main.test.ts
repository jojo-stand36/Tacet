import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './main.js';

let root: string;
let homeDir: string;
const run = (argv: string[], pathValue?: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    cwd: root,
    ...(pathValue ? { path: pathValue } : {}),
    homeDir,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tacet-cli-'));
  homeDir = mkdtempSync(join(tmpdir(), 'tacet-home-'));
  mkdirSync(join(root, '.tacet'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('tacet config explain', () => {
  it('prints each effective value with its source', () => {
    writeFileSync(join(root, '.tacet', 'tacet.yaml'), 'verify: [pnpm test]\n');
    const r = run(['config', 'explain', '--user-dir', join(root, 'home')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `verify = ["pnpm test"]    # repo (${join(root, '.tacet', 'tacet.yaml')})`,
    );
    expect(r.out).toContain('budget.api_key_per_month_usd = 200    # default');
  });

  it('prints JSON with --json', () => {
    const r = run(['config', 'explain', '--user-dir', join(root, 'home'), '--json']);
    expect(JSON.parse(r.out)).toContainEqual({
      path: 'budget.api_key_per_month_usd',
      value: 200,
      sources: [{ layer: 'default', origin: 'built-in defaults' }],
    });
  });
});

describe('tacet init', () => {
  it('scaffolds config, ignores local config, and reports CLI presence without exposing credentials', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const r = run(['init'], bin);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, '.tacet', 'tacet.yaml'), 'utf8')).toContain('autonomy: medium');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.tacet/local.yaml\n');
    expect(r.out).toContain('claude: login status unknown');
    expect(r.out).toContain('Tacet does not inspect vendor login stores or credentials');
    expect(run(['config', 'explain', '--user-dir', homeDir]).code).toBe(0);
  });

  it('is idempotent and preserves customized config', () => {
    const first = run(['init']);
    const configPath = join(root, '.tacet', 'tacet.yaml');
    writeFileSync(configPath, 'verify: [pnpm test]\n');
    const second = run(['init']);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe('verify: [pnpm test]\n');
    expect(
      readFileSync(join(root, '.gitignore'), 'utf8').match(/\.tacet\/local\.yaml/g),
    ).toHaveLength(1);
  });
});

describe('tacet uninstall', () => {
  it('previews generated config by default and removes only it with --apply', () => {
    run(['init']);
    const configPath = join(root, '.tacet', 'tacet.yaml');
    const preview = run(['uninstall']);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain('Would remove:');
    expect(existsSync(configPath)).toBe(true);

    const applied = run(['uninstall', '--apply']);
    expect(applied.code).toBe(0);
    expect(existsSync(join(root, '.tacet'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.tacet/local.yaml');
  });

  it('purges only after creating an external backup and preserves customized config otherwise', () => {
    const configPath = join(root, '.tacet', 'tacet.yaml');
    writeFileSync(configPath, 'verify: [pnpm test]\n');
    writeFileSync(join(root, '.tacet', 'local.yaml'), 'verify: [pnpm test]\n');
    const preview = run(['uninstall']);
    expect(preview.out).toContain('Nothing safe to remove');
    expect(existsSync(configPath)).toBe(true);

    const purgePreview = run(['uninstall', '--purge']);
    expect(purgePreview.out).toContain('Would remove:');
    expect(purgePreview.out).toContain('Backup will be created at:');
    expect(existsSync(join(root, '.tacet', 'local.yaml'))).toBe(true);

    const applied = run(['uninstall', '--purge', '--apply']);
    const backupPath = applied.out.match(/Backup created at: (.+)/)?.[1];
    expect(applied.code).toBe(0);
    expect(backupPath).toBeTruthy();
    expect(existsSync(join(root, '.tacet'))).toBe(false);
    expect(readFileSync(join(backupPath as string, '.tacet', 'local.yaml'), 'utf8')).toBe(
      'verify: [pnpm test]\n',
    );
    expect(backupPath).not.toContain(root);
  });
});

describe('tacet config errors', () => {
  it('exits 1 with located errors for invalid config', () => {
    writeFileSync(join(root, '.tacet', 'tacet.yaml'), 'escalation:\n  autonomy: maybe\n');
    const r = run(['config', 'explain', '--user-dir', join(root, 'home')]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('tacet.yaml:2:13: escalation.autonomy:');
  });

  it('prints usage for unknown commands and options', () => {
    expect(run(['frobnicate']).code).toBe(2);
    expect(run(['config', 'explain', '--nope']).code).toBe(2);
    expect(run([]).code).toBe(0);
  });
});
