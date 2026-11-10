import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    expect(ask('Glob', { pattern: 'src/**/*.ts', path: 'src' }).allow).toBe(true);
    expect(ask('Grep', { pattern: 'x', path: 'src', type: 'ts', '-n': true }).allow).toBe(true);
    // Grep's pattern is a regex over contents, not a path.
    expect(ask('Grep', { pattern: '\\.git|\\.\\./', output_mode: 'content' }).allow).toBe(true);
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
    // Grep's glob is not taken at all (Claude Code splits it and it can override `!.git`).
    for (const glob of ['../*', '*.ts', 'src/*.ts,.git/**', 'a .git/**']) {
      expect(ask('Grep', { pattern: 'x', glob }).allow).toBe(false);
    }
    // Brace expansion is refused outright.
    expect(ask('Glob', { pattern: '{..,src}/*' }).allow).toBe(false);
    expect(ask('Glob', { pattern: '{/etc,src}/*' }).allow).toBe(false);
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
    // HFS+ ignores zero-width code points; NTFS resolves the short name GIT~1.
    for (const p of [
      '.g\u200cit',
      '.git\u200c/config',
      '.\ufeffgit/config',
      'GIT~1/config',
      'git~2',
    ]) {
      expect({ p, allow: ask('Write', { file_path: p, content: '' }).allow }).toEqual({
        p,
        allow: false,
      });
    }
    expect(ask('Glob', { pattern: '.g\u200cit/*' }).allow).toBe(false);
    expect(ask('Grep', { pattern: 'x', path: '.git' }).allow).toBe(false);
    expect(ask('Glob', { pattern: '.git/**' }).allow).toBe(false);
    for (const pattern of [
      '.gi[t]/hooks/*',
      'sub/.g?t/*',
      '?git/*',
      '*git/*',
      '[.]git/x',
      '*.GIT/x',
    ]) {
      expect({ pattern, allow: ask('Glob', { pattern }).allow }).toEqual({ pattern, allow: false });
    }
    // The bare wildcards a search needs stay: Glob lists names only, and reading .git is refused.
    expect(ask('Glob', { pattern: '**/*.ts' }).allow).toBe(true);
    expect(ask('Glob', { pattern: '*' }).allow).toBe(true);
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
    // A key the tool's verified input does not have is refused, not ignored.
    expect(ask('Read', { file_path: 'src/a.ts', filePath: '/etc/passwd' }).allow).toBe(false);
    expect(
      ask('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y', extra: 1 }).allow,
    ).toBe(false);
  });

  it('refuses input the adapter redacted: the tool runs on the original (#200 review)', () => {
    // `bearer ` + 20 path characters, or a private-key header, is scrubbed to [redacted].
    expect(ask('Write', { file_path: `${wt}/[redacted]`, content: '' }).allow).toBe(false);
    expect(ask('Write', { file_path: 'src/a.ts', content: 'key: [redacted]' }).allow).toBe(false);
    expect(ask('Read', { file_path: '[redacted]' }).reason).toMatch(/redacted/);
  });

  it('refuses surrounding whitespace and control characters: Claude Code trims before resolving', () => {
    for (const p of [
      ' /etc/passwd',
      '\n/etc/passwd',
      ' ~/.ssh',
      ' .claude/settings.json',
      'src/a.ts ',
      '\tsrc',
    ]) {
      expect({ p, allow: ask('Read', { file_path: p }).allow }).toEqual({ p, allow: false });
      expect({ p, allow: ask('Write', { file_path: p, content: '' }).allow }).toEqual({
        p,
        allow: false,
      });
      expect({ p, allow: ask('Grep', { pattern: '.', path: p }).allow }).toEqual({
        p,
        allow: false,
      });
      expect({ p, allow: ask('Glob', { pattern: 'x', path: p }).allow }).toEqual({
        p,
        allow: false,
      });
    }
    expect(ask('Glob', { pattern: ' /etc/*' }).allow).toBe(false);
    expect(ask('Glob', { pattern: 'src/*\n' }).allow).toBe(false);
    expect(ask('Read', { file_path: 'src/a\u0007.ts' }).allow).toBe(false);
    // The reason is built from the resolved path, never the given string.
    expect(ask('Read', { file_path: join(wt, 'src', 'a.ts') }).reason).toBe(
      'Read inside the worktree (src/a.ts)',
    );
  });

  it('refuses backslashes and NUL: ordinary name characters, never separators', () => {
    symlinkSync('/etc', join(wt, 'a\\b'));
    expect(ask('Read', { file_path: `${wt}/a\\b/passwd` }).allow).toBe(false);
    expect(ask('Read', { file_path: 'a\\b/passwd' }).allow).toBe(false);
    expect(ask('Read', { file_path: 'src\\..\\..\\outside' }).allow).toBe(false);
    expect(ask('Read', { file_path: 'src/\0/x' }).allow).toBe(false);
    expect(ask('Glob', { pattern: 'a\\b/*' }).allow).toBe(false);
  });

  it('fails closed on a path it cannot check, and on a write to a hard-linked file', () => {
    expect(ask('Write', { file_path: `src/${'x'.repeat(300)}/y`, content: '' }).allow).toBe(false);
    linkSync(join(outside, 'secret'), join(wt, 'src', 'linked'));
    expect(
      ask('Edit', { file_path: 'src/linked', old_string: 'x', new_string: 'y' }).reason,
    ).toMatch(/hard links/);
    // Reading it is fine: nothing changes.
    expect(ask('Read', { file_path: 'src/linked' }).allow).toBe(true);
    // Nor through a symlink to it.
    symlinkSync(join(wt, 'src', 'linked'), join(wt, 'lnk'));
    expect(ask('Write', { file_path: 'lnk', content: '' }).reason).toMatch(/hard links/);
  });

  it('refuses writes to agent, hook and tool config, at any depth and in any case (owner, #200)', () => {
    const writes = [
      '.claude/settings.json',
      'pkg/.claude/hooks.json',
      '.Claude',
      '.mcp.json',
      'sub/.MCP.json',
      '.husky/pre-commit',
      '.vscode/tasks.json',
      '.vscode/launch.json',
      '.envrc',
      '.cursor/rules/x.mdc',
      '.github/workflows/ci.yml',
      '.npmrc',
      '.yarnrc.yml',
      '.gemini/settings.json',
      '.codex/config.toml',
      '.pre-commit-config.yaml',
      'lefthook.yml',
      'sub/.lefthook.yml',
      '.vscode/mcp.json',
    ];
    for (const p of writes) {
      const r = ask('Write', { file_path: p, content: '' });
      expect({ p, allow: r.allow }).toEqual({ p, allow: false });
      expect(r.reason).toMatch(/escalate/);
    }
    expect(ask('Edit', { file_path: '.mcp.json', old_string: 'a', new_string: 'b' }).allow).toBe(
      false,
    );
    // Names a case-insensitive file system folds to one of them (#200 third review).
    for (const p of [
      '.github/workflow\u017f/ci.yml',
      '.mcp.j\u017fon',
      '.hu\u017fky/pre-commit',
      '.hus\u212ay/pre-commit',
      '.clau\u200dde/settings.json',
      '.\ufeffenvrc',
    ]) {
      expect({ p, allow: ask('Write', { file_path: p, content: '' }).allow }).toEqual({
        p,
        allow: false,
      });
    }
    // Through a symlink that resolves to one.
    mkdirSync(join(wt, '.husky'));
    symlinkSync(join(wt, '.husky'), join(wt, 'hooks'));
    expect(ask('Write', { file_path: 'hooks/pre-commit', content: '' }).allow).toBe(false);
    // Reading them is fine, and similar names are not config.
    expect(ask('Read', { file_path: '.claude/settings.json' }).allow).toBe(true);
    for (const p of [
      '.github/CODEOWNERS',
      'docs/claude.md',
      '.vscode/extensions.json',
      'src/envrc.ts',
    ]) {
      expect({ p, allow: ask('Write', { file_path: p, content: '' }).allow }).toEqual({
        p,
        allow: true,
      });
    }
  });

  it('resolves a glob from its own path, not the checkout root (#213 review B1)', () => {
    symlinkSync(join(root, 'outside'), join(wt, 'src', 'out'));
    expect(ask('Glob', { path: 'src', pattern: 'out/**' }).allow).toBe(false);
    expect(ask('Glob', { path: 'src', pattern: 'out/secret' }).allow).toBe(false);
    expect(ask('Glob', { pattern: 'src/out/**' }).allow).toBe(false);
    expect(ask('Glob', { path: 'src/out', pattern: '**' }).allow).toBe(false);
    // And the other way round: an outbound link at the root is no reason to refuse under src.
    symlinkSync(join(root, 'outside'), join(wt, 'out'));
    mkdirSync(join(wt, 'src', 'in'));
    expect(ask('Glob', { path: 'src', pattern: 'in/**' }).allow).toBe(true);
  });

  it('refuses names NTFS or a URL-aware tool may read as another (#213 review S1, N1)', () => {
    for (const p of [
      '.git.',
      '.git /config',
      '.git::$INDEX_ALLOCATION/config',
      '.mcp.json.',
      '.mcp.json::$DATA',
      '.claude./settings.json',
      'CLAUDE~1/settings.json',
      'MCP~1.JSO',
      'GITHUB~1/WORKFL~1/ci.yml',
      'file:///etc/passwd',
      '$HOME/.bashrc',
      '%USERPROFILE%/x',
    ]) {
      expect({ p, allow: ask('Write', { file_path: p, content: '' }).allow }).toEqual({
        p,
        allow: false,
      });
    }
    expect(ask('Glob', { pattern: 'GIT~1/*' }).allow).toBe(false);
    expect(ask('Glob', { pattern: '$HOME/*' }).allow).toBe(false);
    expect(ask('Read', { file_path: 'src/a\u0085b' }).allow).toBe(false);
    // Ordinary names with dots and tildes are fine.
    expect(ask('Write', { file_path: 'src/a.b.c.ts', content: '' }).allow).toBe(true);
    expect(ask('Write', { file_path: 'src/~notes.md', content: '' }).allow).toBe(true);
  });

  it('checks the literal directory of a glob like a path', () => {
    symlinkSync(outside, join(wt, 'out'));
    expect(ask('Glob', { pattern: 'out/**' }).allow).toBe(false);
    expect(ask('Glob', { pattern: 'src/**/*.ts' }).allow).toBe(true);
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
