import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_ACP_AGENT } from './agents.js';
import { findSessionFiles, removeSessionFiles, sweepSessionFiles } from './session-files.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PATTERNS = CLAUDE_ACP_AGENT.sessionFiles as readonly string[];
const DAY = 24 * 60 * 60 * 1000;

let root: string;
let home: string;

function put(rel: string, content = 'x'): string {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** Every file under `dir`, relative to it. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** A Claude Code session's files, as the pinned binary lays them out. */
function session(id: string, project = '-repo-wt'): void {
  put(`projects/${project}/${id}.jsonl`, 'secret file contents');
  put(`projects/${project}/${id}/subagents/agent-1.jsonl`);
  put(`projects/${project}/${id}/tool-results/r.txt`);
  put(`file-history/${id}/f@v1`);
  put(`session-env/${id}/hook-0.sh`);
  put(`debug/${id}.txt`);
  put(`todos/${id}-agent-${id}.json`);
}

function age(path: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(path, t, t);
}

/** Age every entry under `dir` (and `dir` itself) by `days`. */
function ageAll(dir: string, days: number): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) ageAll(p, days);
    else age(p, days);
  }
  age(dir, days);
}

const shared = ['.claude.json', 'projects/-repo-wt/memory/MEMORY.md', 'plugins/store/p.json'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tacet-232-'));
  home = join(root, 'home');
  mkdirSync(home);
  for (const f of shared) put(f);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('session files (#232)', () => {
  it("removes one session's files and nothing else", () => {
    session(A);
    session(B);
    session(A, '-repo-other');
    expect(removeSessionFiles(home, PATTERNS, A)).toBe(8);
    expect(files(home).filter((f) => f.includes(A))).toEqual([]);
    expect(files(home)).toEqual(
      [
        ...shared,
        `projects/-repo-wt/${B}.jsonl`,
        `projects/-repo-wt/${B}/subagents/agent-1.jsonl`,
        `projects/-repo-wt/${B}/tool-results/r.txt`,
        `file-history/${B}/f@v1`,
        `session-env/${B}/hook-0.sh`,
        `debug/${B}.txt`,
        `todos/${B}-agent-${B}.json`,
      ].sort(),
    );
  });

  it('refuses an id that is not one path segment, before touching anything', () => {
    session(A);
    for (const bad of ['', '.', '..', '../x', 'a/b', '*', '{id}', `${A}*`]) {
      expect(() => removeSessionFiles(home, PATTERNS, bad), bad).toThrow(/not a session id/);
    }
    expect(files(home).filter((f) => f.includes(A))).toHaveLength(7);
  });

  it('never follows a symlink out of the home', () => {
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'proj'), { recursive: true });
    writeFileSync(join(outside, 'proj', `${A}.jsonl`), 'not ours');
    mkdirSync(join(outside, A));
    writeFileSync(join(outside, A, 'keep'), 'not ours');
    mkdirSync(join(home, 'projects'), { recursive: true });
    symlinkSync(join(outside, 'proj'), join(home, 'projects', 'linked'));
    mkdirSync(join(home, 'file-history'));
    symlinkSync(join(outside, A), join(home, 'file-history', A));
    removeSessionFiles(home, PATTERNS, A);
    expect(files(outside)).toEqual([`${A}/keep`, `proj/${A}.jsonl`]);
    // The link itself, named by the session, is removed; its target is not.
    expect(existsSync(join(home, 'file-history', A))).toBe(false);
  });

  it('removes nothing from a home without the session', () => {
    expect(removeSessionFiles(home, PATTERNS, A)).toBe(0);
    expect(removeSessionFiles(join(root, 'missing'), PATTERNS, A)).toBe(0);
    expect(files(home)).toEqual([...shared].sort());
  });

  it('sweeps sessions untouched for the retention, keeping recent, open and shared ones', () => {
    const C = '33333333-3333-4333-8333-333333333333';
    const D = '44444444-4444-4444-8444-444444444444';
    session(A);
    session(B);
    session(C);
    ageAll(home, 40);
    // B was written to yesterday, deep in its tree: it is still in use.
    age(put(`projects/-repo-wt/${B}/tool-results/new.txt`), 1);
    // D has no transcript: not a session, and `projects/*/{id}` matching `memory` must not count.
    put(`file-history/${D}/f@v1`);
    ageAll(join(home, 'file-history', D), 40);
    expect(sweepSessionFiles(home, PATTERNS, 30 * DAY, new Set([C]))).toBe(1);
    const left = files(home);
    expect(left.filter((f) => f.includes(A))).toEqual([]);
    expect(left.filter((f) => f.includes(B))).toHaveLength(8);
    expect(left.filter((f) => f.includes(C))).toHaveLength(7);
    expect(left).toContain(`file-history/${D}/f@v1`);
    for (const f of shared) expect(left).toContain(f);
  });

  it('finds every session by id when asked for none', () => {
    session(A);
    session(B, '-p');
    const found = findSessionFiles(home, PATTERNS);
    expect([...found.keys()].sort()).toEqual([A, B, 'memory'].sort());
    // `memory` is matched by the bare `{id}` pattern only, which is why a sweep needs a transcript.
    expect(found.get('memory')).toEqual([join(home, 'projects/-repo-wt/memory')]);
  });
});
