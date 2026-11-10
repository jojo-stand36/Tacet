import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideToolRequest } from './tool-policy.js';

describe('decideToolRequest: unattended Worker tool policy (#200)', () => {
  let root: string;
  let wt: string;
  let outside: string;
  const ask = (toolName: string, input: unknown, adapterId = 'claude-sdk') =>
    decideToolRequest({ adapterId, toolName, input }, wt);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-policy-')));
    wt = join(root, 'wt');
    outside = join(root, 'outside');
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(wt, 'src', 'a.ts'), 'x');
    writeFileSync(join(outside, 'secret'), 'x');
    // A linked worktree's `.git` is a file naming its git dir.
    writeFileSync(join(wt, '.git'), `gitdir: ${join(root, 'repo', '.git', 'worktrees', 'wt')}\n`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('allows file tools inside the worktree, by absolute or relative path, existing or new', () => {
    expect(ask('Read', { file_path: join(wt, 'src', 'a.ts') }).allow).toBe(true);
    expect(ask('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }).allow).toBe(
      true,
    );
    expect(ask('Write', { file_path: join(wt, 'new', 'deep', 'b.ts'), content: '' }).allow).toBe(
      true,
    );
    expect(ask('Write', { path: 'src/c.ts', content: '' }).allow).toBe(true);
    expect(ask('NotebookEdit', { notebook_path: 'n.ipynb', new_source: '' }).allow).toBe(true);
    expect(ask('Glob', { pattern: '**/*.ts' }).allow).toBe(true);
    expect(ask('Grep', { pattern: 'x', path: 'src', glob: '*.ts' }).allow).toBe(true);
    const r = ask('Edit', { file_path: join(wt, 'src', 'a.ts') });
    expect(r.reason).toBe('Edit inside the worktree (src/a.ts)');
  });

  it('refuses a path that leaves the worktree through ..', () => {
    expect(ask('Read', { file_path: '../outside/secret' })).toMatchObject({ allow: false });
    expect(ask('Write', { file_path: join(wt, 'src', '..', '..', 'outside', 'x') }).allow).toBe(
      false,
    );
    // Even one that would come back inside: `..` is never resolved.
    expect(ask('Edit', { file_path: 'src/../src/a.ts' }).reason).toMatch(/\(\.\.\)/);
    expect(ask('Glob', { pattern: '../**' }).allow).toBe(false);
    expect(ask('Grep', { pattern: 'x', glob: '../*' }).allow).toBe(false);
  });

  it('refuses absolute paths elsewhere, home paths and an absolute search pattern', () => {
    expect(ask('Read', { file_path: '/etc/passwd' })).toMatchObject({ allow: false });
    expect(ask('Read', { file_path: join(outside, 'secret') }).allow).toBe(false);
    expect(ask('Read', { file_path: `${wt}-sibling/x` }).allow).toBe(false);
    expect(ask('Read', { file_path: '~/.ssh/id_ed25519' }).allow).toBe(false);
    expect(ask('Grep', { pattern: 'x', path: '/' }).allow).toBe(false);
    expect(ask('Glob', { pattern: '/etc/*' }).allow).toBe(false);
    // The reason never echoes a path outside the worktree.
    expect(ask('Read', { file_path: join(outside, 'secret') }).reason).not.toContain(outside);
  });

  it('refuses a symlink out of the worktree, including one created during the session', () => {
    symlinkSync(outside, join(wt, 'link'));
    expect(ask('Read', { file_path: 'link/secret' }).allow).toBe(false);
    expect(ask('Write', { file_path: 'link/new.txt', content: '' }).allow).toBe(false);
    // Allowed a moment ago; the Worker then makes `src/x` a symlink out: decided afresh each time.
    expect(ask('Write', { file_path: 'src/x', content: '' }).allow).toBe(true);
    symlinkSync(join(outside, 'secret'), join(wt, 'src', 'x'));
    expect(ask('Write', { file_path: 'src/x', content: '' })).toMatchObject({ allow: false });
    // A dangling symlink would let a write create a file wherever it points.
    symlinkSync(join(outside, 'nothing-yet'), join(wt, 'dangling'));
    expect(ask('Write', { file_path: 'dangling', content: '' }).allow).toBe(false);
    // A symlink that stays inside is fine.
    symlinkSync(join(wt, 'src'), join(wt, 'alias'));
    expect(ask('Read', { file_path: 'alias/a.ts' }).allow).toBe(true);
  });

  it('refuses git internals: .git/hooks, .git/config, the .git file, in any case', () => {
    for (const p of ['.git/hooks/pre-commit', '.git/config', '.git', join(wt, '.GIT', 'config')]) {
      expect(ask('Write', { file_path: p, content: '' }).allow).toBe(false);
    }
    expect(ask('Read', { file_path: 'sub/.git/config' }).allow).toBe(false);
    expect(ask('Grep', { pattern: 'x', path: '.git' }).allow).toBe(false);
    expect(ask('Glob', { pattern: '.git/**' }).allow).toBe(false);
    // Through a symlink into a git dir.
    mkdirSync(join(wt, 'nested', '.git'), { recursive: true });
    symlinkSync(join(wt, 'nested', '.git'), join(wt, 'g'));
    expect(ask('Write', { file_path: 'g/config', content: '' }).allow).toBe(false);
  });

  it('refuses Bash, the web, other MCP servers and unknown tools', () => {
    for (const name of [
      'Bash',
      'PowerShell',
      'Monitor',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Task',
    ]) {
      expect(ask(name, { command: 'ls', url: 'https://example.com' }).allow).toBe(false);
    }
    expect(ask('mcp__other__write_file', { path: 'src/a.ts' }).allow).toBe(false);
    // Unknown, removed or misspelt tools, and a missing name, are refused.
    for (const name of ['MultiEdit', 'LS', 'read', 'FutureTool', '__proto__', 'constructor']) {
      expect(ask(name, { file_path: 'src/a.ts' }).allow).toBe(false);
    }
    expect(decideToolRequest({ adapterId: 'claude-sdk', input: {} }, wt).allow).toBe(false);
  });

  it('refuses malformed input and a file tool without a path', () => {
    expect(ask('Read', undefined).allow).toBe(false);
    expect(ask('Read', 'src/a.ts').allow).toBe(false);
    expect(ask('Read', {}).allow).toBe(false);
    expect(ask('Read', { file_path: 42 }).allow).toBe(false);
    expect(ask('Edit', { file_path: '' }).allow).toBe(false);
    // Every spelling present is checked: one inside does not excuse one outside.
    expect(ask('Write', { file_path: 'src/a.ts', path: '/etc/x' }).allow).toBe(false);
  });

  it('applies Claude Code tool names only to Claude adapters', () => {
    expect(ask('Read', { file_path: 'src/a.ts' }, 'acp:claude-acp').allow).toBe(true);
    expect(ask('Read', { file_path: 'src/a.ts' }, 'pty:claude').allow).toBe(true);
    for (const id of ['codex-app-server', 'acp:gemini', 'pty:aider', 'acp:custom']) {
      expect(ask('Read', { file_path: 'src/a.ts' }, id).allow).toBe(false);
    }
  });

  it('refuses everything once the checkout is gone', () => {
    rmSync(wt, { recursive: true, force: true });
    expect(ask('Read', { file_path: 'src/a.ts' }).reason).toMatch(/checkout is gone/);
  });
});
