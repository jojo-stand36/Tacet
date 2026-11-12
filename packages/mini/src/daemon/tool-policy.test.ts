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
import { evaluatePolicies } from '@tacet/core';
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

  it('judges only names inside the checkout, not its parents, and follows links to odd names', () => {
    // A checkout under a Windows short name (WSL2 on /mnt/c) still works by absolute path.
    const odd = join(root, 'JOHNSM~1 proj.', 'wt');
    mkdirSync(join(odd, 'src'), { recursive: true });
    writeFileSync(join(odd, 'src', 'a.ts'), 'x');
    const r = decideToolRequest(
      { adapterId: 'claude-sdk', toolName: 'Read', input: { file_path: join(odd, 'src', 'a.ts') } },
      odd,
    );
    expect(r).toMatchObject({ allow: true });
    // A symlink to a name NTFS reads as protected config is refused like the name itself.
    mkdirSync(join(wt, 'CLAUDE~1'));
    symlinkSync(join(wt, 'CLAUDE~1'), join(wt, 'cfg'));
    expect(ask('Write', { file_path: 'cfg/settings.json', content: '' }).allow).toBe(false);
  });

  it("refuses writes to Tacet's own config, .tacet/, at any depth (#227)", () => {
    for (const p of [
      '.tacet/tacet.yaml',
      '.tacet/local.yaml',
      '.tacet',
      'pkg/.tacet/x.yaml',
      '.TACET/tacet.yaml',
    ]) {
      const r = ask('Write', { file_path: p, content: '' });
      expect({ p, allow: r.allow }).toEqual({ p, allow: false });
      expect(r.reason).toMatch(/escalate/);
    }
    expect(
      ask('Edit', { file_path: '.tacet/tacet.yaml', old_string: 'a', new_string: 'b' }).allow,
    ).toBe(false);
    expect(ask('NotebookEdit', { notebook_path: '.tacet/n.ipynb', new_source: '' }).allow).toBe(
      false,
    );
    // Folded names, and the file that keeps local.yaml out of git.
    for (const p of ['.ta\u200dcet/tacet.yaml', '\uff0etacet/tacet.yaml', '.tacet/.gitignore']) {
      expect({ p, allow: ask('Write', { file_path: p, content: '' }).allow }).toEqual({
        p,
        allow: false,
      });
    }
    // A committed `.tacet` symlink to elsewhere in the checkout is still Tacet's config.
    mkdirSync(join(wt, 'config', 'tacet'), { recursive: true });
    symlinkSync(join(wt, 'config', 'tacet'), join(wt, '.tacet'));
    expect(ask('Write', { file_path: '.tacet/tacet.yaml', content: '' }).allow).toBe(false);
    expect(ask('Write', { file_path: join(wt, '.tacet', 'tacet.yaml'), content: '' }).allow).toBe(
      false,
    );
    // So is the file it points at, written by its real path: Tacet reads it through the link.
    expect(ask('Write', { file_path: 'config/tacet/tacet.yaml', content: '' }).allow).toBe(false);
    expect(ask('Write', { file_path: 'config/other.yaml', content: '' }).allow).toBe(true);
    // Likewise a root `.mcp.json` that links to another file.
    writeFileSync(join(wt, 'servers.json'), '{}');
    symlinkSync(join(wt, 'servers.json'), join(wt, '.mcp.json'));
    expect(ask('Edit', { file_path: 'servers.json', old_string: '{', new_string: '[' }).allow).toBe(
      false,
    );
    // Reading it is fine, and similar names are not it.
    expect(ask('Read', { file_path: '.tacet/tacet.yaml' }).allow).toBe(true);
    expect(ask('Write', { file_path: 'docs/tacet.md', content: '' }).allow).toBe(true);
  });

  it('follows symlinks in protected config the way a committed link resolves (#227 review)', () => {
    const w = (p: string) => ask('Write', { file_path: p, content: '' });
    // A dangling `.tacet` link: a write would create the config it points at.
    symlinkSync('config/tacet', join(wt, '.tacet'));
    expect(w('config/tacet/tacet.yaml')).toMatchObject({ allow: false, reason: /escalate/ });
    expect(w('config/other.yaml').allow).toBe(true);
    // Once it resolves, still only what it points at is protected.
    mkdirSync(join(wt, 'config', 'tacet'), { recursive: true });
    expect(w('config/tacet/tacet.yaml').allow).toBe(false);
    expect(w('config/tacetx').allow).toBe(true);
    expect(w('config/other/x.yaml').allow).toBe(true);
    expect(w('src/a.ts').allow).toBe(true);
    // A link on a parent of a two-segment name, and a parent of a PROTECTED_IN file.
    mkdirSync(join(wt, 'ci', 'github', 'workflows'), { recursive: true });
    symlinkSync('ci/github', join(wt, '.github'));
    expect(w('ci/github/workflows/x.yml').allow).toBe(false);
    expect(w('ci/github/CODEOWNERS').allow).toBe(true);
    mkdirSync(join(wt, 'shared'));
    symlinkSync('shared', join(wt, '.vscode'));
    expect(w('shared/tasks.json').allow).toBe(false);
    expect(w('shared/extensions.json').allow).toBe(true);
    // Targets compare folded, as a case-insensitive file system resolves them.
    expect(w('CONFIG/tacet/tacet.yaml').allow).toBe(false);
  });

  it('protects what a symlink inside a protected directory points at (#227 review)', () => {
    mkdirSync(join(wt, '.tacet'));
    writeFileSync(join(wt, 'cfg.yaml'), '');
    symlinkSync('../cfg.yaml', join(wt, '.tacet', 'tacet.yaml'));
    expect(ask('Write', { file_path: 'cfg.yaml', content: '' }).allow).toBe(false);
    expect(ask('Write', { file_path: 'other.yaml', content: '' }).allow).toBe(true);
    // A dangling one inside protects the file it would create.
    symlinkSync('../later.yaml', join(wt, '.tacet', 'local.yaml'));
    expect(ask('Write', { file_path: 'later.yaml', content: '' }).allow).toBe(false);
    expect(ask('Write', { file_path: 'other.yaml', content: '' }).allow).toBe(true);
    // Links inside a linked directory are followed too.
    mkdirSync(join(wt, '.claude'));
    mkdirSync(join(wt, 'shared'));
    symlinkSync('../shared', join(wt, '.claude', 'agents'));
    writeFileSync(join(wt, 'x.md'), '');
    symlinkSync('../x.md', join(wt, 'shared', 'a.md'));
    expect(ask('Write', { file_path: 'x.md', content: '' }).allow).toBe(false);
    expect(ask('Write', { file_path: 'shared/new.md', content: '' }).allow).toBe(false);
    // Personal links out of the checkout, dangling in a fresh worktree, change nothing, and a
    // loop of directory links ends.
    symlinkSync('/nonexistent/abs/notes.md', join(wt, '.claude', 'CLAUDE.local.md'));
    symlinkSync('../.local/notes.md', join(wt, '.claude', 'notes.md'));
    symlinkSync('.', join(wt, '.claude', 'self'));
    expect(ask('Write', { file_path: 'src/a.ts', content: '' }).allow).toBe(true);
    expect(ask('Write', { file_path: '.local/notes.md', content: '' }).allow).toBe(false);
  });

  it('resolves `..` in a dangling link after its symlinks, as the kernel does (#227 review)', () => {
    const w = (p: string) => ask('Write', { file_path: p, content: '' }).allow;
    mkdirSync(join(wt, 'deep', 'dir'), { recursive: true });
    symlinkSync('deep/dir', join(wt, 'lnk'));
    mkdirSync(join(wt, '.tacet'));
    symlinkSync('../lnk/../cfg.yaml', join(wt, '.tacet', 'tacet.yaml'));
    expect(w('deep/cfg.yaml')).toBe(false);
    expect(w('cfg.yaml')).toBe(true);
    mkdirSync(join(wt, 'a', 'b'), { recursive: true });
    symlinkSync('a/b', join(wt, 'l2'));
    symlinkSync('l2/../t', join(wt, '.claude'));
    expect(w('a/t/settings.json')).toBe(false);
    expect(w('t/settings.json')).toBe(true);
  });

  it('fails closed on a symlink loop in protected config (#227 review)', () => {
    symlinkSync('b', join(wt, '.tacet'));
    symlinkSync('.tacet', join(wt, 'b'));
    expect(ask('Write', { file_path: 'src/a.ts', content: '' })).toMatchObject({
      allow: false,
      reason: /escalate/,
    });
  });

  it('fails closed on a protected name linked to the checkout root (#227 review)', () => {
    symlinkSync('.', join(wt, '.tacet'));
    expect(ask('Write', { file_path: 'tacet.yaml', content: '' }).allow).toBe(false);
    expect(ask('Write', { file_path: 'src/a.ts', content: '' }).allow).toBe(false);
    // Reads are not affected.
    expect(ask('Read', { file_path: 'tacet.yaml' }).allow).toBe(true);
  });

  it('protects every lefthook config name (lefthook docs, checked 2026-11-10)', () => {
    for (const p of [
      'lefthook.yaml',
      '.lefthook.yaml',
      'lefthook.toml',
      '.lefthook.json',
      'lefthook.jsonc',
      'lefthook-local.yml',
      '.lefthook-local.toml',
      '.config/lefthook.yml',
      '.config/lefthook.json',
    ]) {
      expect({ p, allow: ask('Write', { file_path: p, content: '' }).allow }).toEqual({
        p,
        allow: false,
      });
    }
    expect(ask('Write', { file_path: 'docs/lefthook.md', content: '' }).allow).toBe(true);
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

  describe('what policies see (#25, ADR-004 D)', () => {
    const verdict = (match: string, toolName: string, input: unknown) => {
      const d = ask(toolName, input);
      if (!d.allow) throw new Error(`refused: ${d.reason}`);
      return evaluatePolicies([{ match, decision: 'deny' }], {
        tool: toolName,
        paths: d.paths,
        ...(d.roots ? { roots: d.roots } : {}),
      })?.decision;
    };
    beforeEach(() => {
      mkdirSync(join(wt, 'secrets'));
      writeFileSync(join(wt, 'secrets', 'k'), 'key');
      // A link with an innocent name to a secret, and one with a secret name to a plain file.
      symlinkSync(join(wt, 'secrets', 'k'), join(wt, 'notes.txt'));
      symlinkSync(join(wt, 'src', 'a.ts'), join(wt, '.env'));
    });

    it('sees a target both as written and after symlinks', () => {
      expect(verdict('secrets/**', 'Read', { file_path: 'notes.txt' })).toBe('deny');
      expect(verdict('.env', 'Read', { file_path: '.env' })).toBe('deny');
      expect(verdict('secrets/**', 'Read', { file_path: join(wt, 'secrets', 'k') })).toBe('deny');
      expect(verdict('secrets/**', 'Read', { file_path: 'src/a.ts' })).toBeUndefined();
      // Spelled differently: `./` and another letter case.
      expect(verdict('secrets/**', 'Read', { file_path: './Secrets/k' })).toBe('deny');
    });

    it('covers searches that could read below a match', () => {
      expect(verdict('secrets/**', 'Grep', { pattern: 'key' })).toBe('deny');
      expect(verdict('secrets/**', 'Grep', { pattern: 'key', path: 'src' })).toBeUndefined();
      expect(verdict('secrets/**', 'Grep', { pattern: 'key', path: 'secrets/k' })).toBe('deny');
      expect(verdict('secrets/**', 'Glob', { pattern: 'secrets/*' })).toBe('deny');
      expect(verdict('secrets/**', 'Glob', { pattern: 'src/*.ts' })).toBeUndefined();
      expect(verdict('secrets/**', 'Glob', { pattern: '**/*.ts' })).toBe('deny');
      // Through a symlink in the pattern's literal directories, or in its path.
      symlinkSync(join(wt, 'secrets'), join(wt, 'link'));
      mkdirSync(join(wt, 'dir'));
      symlinkSync('../secrets', join(wt, 'dir', 'l2'));
      expect(verdict('secrets/**', 'Glob', { pattern: 'link/*' })).toBe('deny');
      expect(verdict('secrets/**', 'Glob', { pattern: 'dir/l2/*' })).toBe('deny');
      expect(verdict('secrets/**', 'Glob', { pattern: 'l2/*', path: 'dir' })).toBe('deny');
      expect(verdict('secrets/**', 'Glob', { pattern: '*', path: 'link' })).toBe('deny');
    });
  });

  it('refuses everything once the checkout is gone', () => {
    rmSync(wt, { recursive: true, force: true });
    expect(ask('Read', { file_path: 'src/a.ts' }).reason).toMatch(/checkout is gone/);
  });
});
