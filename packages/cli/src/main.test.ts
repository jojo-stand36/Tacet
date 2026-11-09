import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './main.js';

let root: string;
const run = (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (t) => out.push(t), err: (t) => err.push(t), cwd: root });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tacet-cli-'));
  mkdirSync(join(root, '.tacet'));
  mkdirSync(join(root, 'home'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

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
