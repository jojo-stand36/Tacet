import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter, refuseGitInSandboxTemp, sandboxTempRoots } from './adapter.js';
import { codexFixtureDir } from './testing/fixture-dir.js';

/** An unattended Codex Worker never runs on a repo under a sandbox-writable temp dir (#293). */
describe('repos under the sandbox temp dirs (#293)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const gitEnv = {
    PATH: process.env.PATH ?? '',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Tacet Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Tacet Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  /** A repo with one commit and a linked worktree, under `parent`. */
  function repoIn(parent: string) {
    const repo = join(parent, 'repo');
    const wt = join(parent, 'worktrees', 'task-1');
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { env: gitEnv, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', wt, '-b', 'tacet/task-1');
    return { repo, wt };
  }

  it('refuses a repo under /tmp, naming the git dir and the fix', () => {
    const parent = realpathSync(mkdtempSync('/tmp/tacet-293-'));
    dirs.push(parent);
    const { repo, wt } = repoIn(parent);
    // Resolved: /private/tmp on macOS.
    const tmp = realpathSync.native('/tmp');
    expect(() => refuseGitInSandboxTemp(wt, repo, undefined)).toThrow(
      `its git dir ${join(repo, '.git')} is under ${tmp}`,
    );
    expect(() => refuseGitInSandboxTemp(wt, repo, undefined)).toThrow(
      'Move the repository outside /tmp and $TMPDIR.',
    );
    // The main checkout itself, with no linked worktree, too.
    expect(() => refuseGitInSandboxTemp(repo, repo, undefined)).toThrow(`is under ${tmp}`);
  });

  it("refuses a repo under the Worker's $TMPDIR, and runs one outside it", () => {
    const tmp = codexFixtureDir('tacet-293-tmpdir-');
    dirs.push(tmp);
    const { repo, wt } = repoIn(tmp);
    expect(() => refuseGitInSandboxTemp(wt, repo, tmp)).toThrow(`is under ${tmp}`);
    // The same repo, with $TMPDIR elsewhere: nothing to refuse. (A real Worker start on a repo
    // outside the temp dirs is `isolation.test.ts`, whose fixture is placed the same way.)
    expect(() => refuseGitInSandboxTemp(wt, repo, undefined)).not.toThrow();
  });

  it('a $TMPDIR of / makes every repo refused', () => {
    const tmp = codexFixtureDir('tacet-293-root-');
    dirs.push(tmp);
    const { repo, wt } = repoIn(tmp);
    expect(() => refuseGitInSandboxTemp(wt, repo, '/')).toThrow('is under /,');
  });

  it('resolves the temp roots, and ignores a relative $TMPDIR', () => {
    expect(sandboxTempRoots(undefined)).toEqual([realpathSync.native('/tmp')]);
    expect(sandboxTempRoots('relative/tmp')).toEqual([realpathSync.native('/tmp')]);
  });

  it('refuses at start, before Codex runs or any state is written', async () => {
    const parent = realpathSync(mkdtempSync('/tmp/tacet-293-start-'));
    const state = codexFixtureDir('tacet-293-state-');
    dirs.push(parent, state);
    const { repo, wt } = repoIn(parent);
    const adapter = new CodexAppServerAdapter({
      repoRoot: repo,
      stateDir: state,
      // Never run: the refusal comes first.
      codexPath: join(parent, 'no-codex-here'),
      baseEnv: {
        PATH: process.env.PATH,
        HOME: join(parent, 'home'),
        OPENAI_API_KEY: 'placeholder-key',
      },
    });
    await expect(adapter.start({ cwd: wt })).rejects.toThrow(
      /refusing to start an unattended Codex Worker/,
    );
    expect(readdirSync(state)).toEqual([]);
    expect(existsSync(join(parent, 'home'))).toBe(false);
  });
});
