import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexAppServerAdapter,
  refuseGitInSandboxTemp,
  refuseInSandboxTemp,
  sandboxTempRoots,
} from './adapter.js';
import { codexFixtureDir } from './testing/fixture-dir.js';

/**
 * Without a private TMPDIR (macOS, #294), an unattended Codex Worker never runs on a repo, or
 * with a CODEX_HOME, under a sandbox-writable temp dir (#293, #295).
 */
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
      // The shared temp dirs, as on macOS (#294 lifts these refusals elsewhere).
      privateTmpdir: false,
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

  it('refuses a CODEX_HOME under a temp dir, before creating it (#295)', async () => {
    const tmp = codexFixtureDir('tacet-295-tmpdir-');
    const outside = codexFixtureDir('tacet-295-repo-');
    dirs.push(tmp, outside);
    const { repo, wt } = repoIn(outside);
    const state = join(tmp, 'state');
    const adapter = new CodexAppServerAdapter({
      // The shared temp dirs, as on macOS (#294 lifts these refusals elsewhere).
      privateTmpdir: false,
      repoRoot: repo,
      stateDir: state,
      codexPath: join(outside, 'no-codex-here'),
      baseEnv: {
        PATH: process.env.PATH,
        HOME: join(outside, 'home'),
        TMPDIR: tmp,
        OPENAI_API_KEY: 'placeholder-key',
      },
    });
    // The Worker could otherwise write its own config.toml, which the next Worker's app-server
    // loads outside the sandbox (seen live with a state dir under /tmp).
    await expect(adapter.start({ cwd: wt })).rejects.toThrow(`its CODEX_HOME ${state}/`);
    await expect(adapter.start({ cwd: wt })).rejects.toThrow('Set a state dir');
    expect(existsSync(state)).toBe(false);
    // Under /tmp, whatever $TMPDIR says.
    expect(() => refuseInSandboxTemp('its CODEX_HOME', '/tmp/x/y/codex', undefined, 'fix')).toThrow(
      `is under ${realpathSync.native('/tmp')}`,
    );
    expect(() =>
      refuseInSandboxTemp('its CODEX_HOME', join(outside, 'codex'), tmp, 'fix'),
    ).not.toThrow();
  });

  it('without a repoRoot, refuses a cwd inside a repo under a temp dir (#295)', async () => {
    const tmp = codexFixtureDir('tacet-295-enclosing-');
    const elsewhere = codexFixtureDir('tacet-295-elsewhere-');
    dirs.push(tmp, elsewhere);
    const { repo } = repoIn(tmp);
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    expect(() => refuseGitInSandboxTemp(sub, undefined, tmp)).toThrow(
      `its git dir ${join(repo, '.git')} is under ${tmp}`,
    );
    // Through start(), before anything is created.
    const state = codexFixtureDir('tacet-295-norepo-state-');
    dirs.push(state);
    const adapter = new CodexAppServerAdapter({
      // The shared temp dirs, as on macOS (#294 lifts these refusals elsewhere).
      privateTmpdir: false,
      stateDir: state,
      codexPath: join(elsewhere, 'no-codex-here'),
      baseEnv: {
        PATH: process.env.PATH,
        HOME: elsewhere,
        TMPDIR: tmp,
        OPENAI_API_KEY: 'k-placeholder',
      },
    });
    await expect(adapter.start({ cwd: sub })).rejects.toThrow(`is under ${tmp}`);
    expect(readdirSync(state)).toEqual([]);
    // A linked worktree outside the temp dir whose git dir points into it.
    const linked = join(elsewhere, 'wt');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', linked, '-b', 'tacet/linked'], {
      env: gitEnv,
      stdio: 'ignore',
    });
    expect(() => refuseGitInSandboxTemp(linked, undefined, tmp)).toThrow(`is under ${tmp}`);
    // A directory in no repo, outside the temp dirs: nothing to refuse.
    const plain = join(elsewhere, 'plain');
    mkdirSync(plain);
    expect(() => refuseGitInSandboxTemp(plain, undefined, tmp)).not.toThrow();
  });
});
