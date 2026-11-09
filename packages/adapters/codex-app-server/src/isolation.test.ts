import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionHandle } from '@tacet/core';
import { repoStateDir } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter, gitRepoRoot, workerGitEnv, workerWorktree } from './adapter.js';
import { type MockResponsesApi, startMockResponsesApi } from './testing/mock-responses-api.js';

/**
 * Codex Worker isolation (#116) against the real `codex app-server` and the mock Responses API:
 * the Worker's own CODEX_HOME, plugins off, and its worktree git dir writable in the sandbox.
 */
describe('Codex Worker isolation', () => {
  let api: MockResponsesApi;
  let root: string;
  let home: string;
  let repo: string;
  let worktree: string;
  // A git environment that never reads the developer's own config (signing, hooks, aliases).
  let gitEnv: Record<string, string>;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim();

  beforeAll(async () => {
    api = await startMockResponsesApi();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-codex-iso-')));
    home = join(root, 'home');
    repo = join(root, 'repo');
    worktree = join(root, 'worktrees', 'task-1');
    mkdirSync(home);
    gitEnv = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tacet Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Tacet Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'tacet/task-1');
  });

  afterAll(async () => {
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const adapter = (extra: ConstructorParameters<typeof CodexAppServerAdapter>[0] = {}) =>
    new CodexAppServerAdapter({
      authRoute: 'api_key',
      apiBaseUrl: api.url,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      // The test repo lives under the temp dir, which Codex makes writable by default; a real repo
      // under $HOME is not, so take the temp dirs out of the sandbox here.
      config: {
        'sandbox_workspace_write.exclude_tmpdir_env_var': true,
        'sandbox_workspace_write.exclude_slash_tmp': true,
      },
      baseEnv: { ...gitEnv, OPENAI_API_KEY: 'placeholder-not-a-real-key' },
      ...extra,
    });

  async function run(a: CodexAppServerAdapter, h: SessionHandle, cmd: string) {
    const tap = new EventTap(a.events(h));
    const from = api.requests.length;
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 30_000);
    const start = tap.events.length;
    await a.send(h, { text: `RUN_CMD ${cmd}` });
    const end = await tap.waitFor(
      (e) => e.t === 'status' && (e.state === 'idle' || e.state === 'error'),
      60_000,
      start + 1,
    );
    expect(end.event).toMatchObject({ state: 'idle' });
    const output = api.requests
      .slice(from)
      .map((r) => r.toolOutput ?? '')
      .join('\n');
    return { events: tap.events, output };
  }

  const files = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((f) => {
          const p = join(dir, f);
          return statSync(p).isDirectory() ? [p, ...files(p)] : [p];
        })
      : [];

  it('finds the repo and the linked worktree git dirs', () => {
    expect(gitRepoRoot(worktree, gitEnv)).toBe(repo);
    expect(gitRepoRoot(repo, gitEnv)).toBe(repo);
    expect(workerWorktree(worktree, gitEnv)).toEqual({
      gitDir: join(repo, '.git', 'worktrees', 'task-1'),
      commonDir: join(repo, '.git'),
    });
    // The main worktree and a non-repo are not Worker worktrees.
    expect(workerWorktree(repo, gitEnv)).toBeUndefined();
    expect(workerWorktree(home, gitEnv)).toBeUndefined();
  });

  it('unattended: commits without approval, never writes the shared .git, integrates by push', async () => {
    const shared = join(repo, '.git');
    const refsBefore = git(repo, 'for-each-ref');
    const objectsBefore = files(join(shared, 'objects'));
    const a = adapter();
    const h = await a.start({ cwd: worktree });
    // The Worker's worktree is checked out detached: HEAD is per-worktree, branches are shared.
    expect(() => git(worktree, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    const { events, output } = await run(
      a,
      h,
      [
        'echo hi > work.txt && git add work.txt && git commit -qm work && echo COMMITTED',
        'git update-ref refs/heads/main HEAD && echo REF_MOVED',
        'git branch other && echo BRANCHED',
        `touch ${shared}/objects/tacet-probe && echo OBJECTS_WRITABLE`,
        `touch ${shared}/tacet-probe && echo SHARED_WRITABLE`,
      ].join('; '),
    );
    await a.close(h);
    expect(output).toContain('COMMITTED');
    for (const leak of ['REF_MOVED', 'BRANCHED', 'OBJECTS_WRITABLE', 'SHARED_WRITABLE']) {
      expect(output).not.toContain(leak);
    }
    // No approval was needed to commit.
    expect(events.some((e) => e.t === 'approval.request')).toBe(false);
    // The shared .git is exactly as it was: no refs moved, no objects added or removed.
    expect(git(repo, 'for-each-ref')).toBe(refsBefore);
    expect(files(join(shared, 'objects'))).toEqual(objectsBefore);

    // The Mini-conductor integrates outside the sandbox with the Worker's git environment.
    const wt = workerWorktree(worktree, gitEnv);
    if (!wt) throw new Error('not a worktree');
    const env = { ...gitEnv, ...workerGitEnv(wt) };
    const sha = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      env,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', worktree, 'push', '-q', repo, 'HEAD:refs/heads/tacet/task-1'], {
      env,
      stdio: 'ignore',
    });
    expect(git(repo, 'rev-parse', 'tacet/task-1')).toBe(sha);
    expect(git(repo, 'log', '-1', '--format=%s', 'tacet/task-1')).toBe('work');
    expect(git(repo, 'rev-parse', 'main')).not.toBe(sha);

    const codexHome = join(repoStateDir(repo, join(home, '.tacet', 'state')), 'codex');
    expect(statSync(codexHome).mode & 0o777).toBe(0o700);
    // Thread state lands in Tacet's CODEX_HOME, never in the user's ~/.codex.
    expect(files(join(codexHome, 'sessions')).some((f) => f.endsWith('.jsonl'))).toBe(true);
    expect(existsSync(join(home, '.codex'))).toBe(false);
    // Plugins are off: no curated-plugins clone or snapshot.
    const all = files(codexHome);
    expect(all.filter((f) => /plugins-clone-|[/\\]\.tmp[/\\]plugins/.test(f))).toEqual([]);
  });

  it('unattended ignores a CODEX_HOME in the environment and refuses the subscription route', async () => {
    const userHome = join(home, 'user-codex');
    const a = adapter({
      baseEnv: { ...gitEnv, OPENAI_API_KEY: 'x'.repeat(12), CODEX_HOME: userHome },
    });
    const h = await a.start({ cwd: worktree });
    await a.close(h);
    expect(existsSync(userHome)).toBe(false);
    await expect(adapter({ authRoute: 'subscription' }).start({ cwd: worktree })).rejects.toThrow(
      /api_key/,
    );
  });

  it('interactive: keeps the user CODEX_HOME', async () => {
    const userHome = join(home, '.codex-interactive');
    const a = adapter({
      mode: 'interactive',
      baseEnv: { ...gitEnv, OPENAI_API_KEY: 'placeholder-not-a-real-key', CODEX_HOME: userHome },
    });
    const own = join(root, 'worktrees', 'own');
    git(repo, 'worktree', 'add', '-q', own, '-b', 'user/own');
    const h = await a.start({ cwd: own });
    const { output } = await run(a, h, 'echo "objects=$GIT_OBJECT_DIRECTORY"');
    await a.close(h);
    expect(files(join(userHome, 'sessions')).some((f) => f.endsWith('.jsonl'))).toBe(true);
    // The user's own session keeps its branch and git environment.
    expect(git(own, 'symbolic-ref', 'HEAD')).toBe('refs/heads/user/own');
    expect(output).toContain('objects=\n');
  });

  it('keys the state dir by an explicit repoRoot and stateDir', async () => {
    const stateDir = join(root, 'state');
    const a = adapter({ repoRoot: repo, stateDir });
    const h = await a.start({ cwd: worktree });
    await a.close(h);
    expect(existsSync(join(repoStateDir(repo, stateDir), 'codex'))).toBe(true);
  });
});
