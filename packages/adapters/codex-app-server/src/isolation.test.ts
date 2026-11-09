import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionHandle } from '@tacet/core';
import { repoStateDir } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter, SAFE_GIT_ARGS, trustedGitEnv, workerWorktree } from './adapter.js';
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

  const adapter = (
    extra: ConstructorParameters<typeof CodexAppServerAdapter>[0] = {},
    withRepoRoot = true,
  ) =>
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
      ...(withRepoRoot ? { repoRoot: repo } : {}),
      ...extra,
    });

  async function run(a: CodexAppServerAdapter, h: SessionHandle, cmd: string) {
    const tap = new EventTap(a.events(h));
    const from = api.requests.length;
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 30_000);
    const start = tap.events.length;
    await a.send(h, { text: `RUN_CMD ${cmd}` });
    // Codex asks for an approval when the sandbox denies a command it wants to retry outside it.
    // Each is refused (never approved: that would run the command unsandboxed) and recorded, so
    // a denial fails the test with its summary instead of hanging the turn.
    const approvals: string[] = [];
    let at = start + 1;
    for (;;) {
      const next = await tap.waitFor(
        (e) =>
          e.t === 'approval.request' ||
          (e.t === 'status' && (e.state === 'idle' || e.state === 'error')),
        60_000,
        at,
      );
      at = next.index + 1;
      if (next.event.t !== 'approval.request') {
        expect(next.event).toMatchObject({ state: 'idle' });
        break;
      }
      approvals.push(next.event.summary);
      await a.respond(h, next.event.id, { kind: 'reject', persist: false });
    }
    const output = [
      ...api.requests.slice(from).map((r) => r.toolOutput ?? ''),
      ...approvals.map((x) => `APPROVAL REQUESTED: ${x}`),
    ].join('\n');
    return { events: tap.events, output };
  }

  const files = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((f) => {
          const p = join(dir, f);
          return statSync(p).isDirectory() ? [p, ...files(p)] : [p];
        })
      : [];

  /** A fresh worktree of `repo` on a new branch. */
  const addWorktree = (name: string) => {
    const dir = join(root, 'worktrees', name);
    git(repo, 'worktree', 'add', '-q', dir, '-b', `tacet/${name}`);
    return dir;
  };

  it('checks a linked worktree against the repo root', () => {
    expect(workerWorktree(worktree, repo)).toEqual({
      gitDir: join(repo, '.git', 'worktrees', 'task-1'),
      commonDir: join(repo, '.git'),
    });
    // The main worktree and a directory outside git are not Worker worktrees.
    expect(workerWorktree(repo, repo)).toBeUndefined();
    expect(workerWorktree(home, repo)).toBeUndefined();
    // A worktree of another repo is refused.
    const other = join(root, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    expect(() => workerWorktree(other, repo)).toThrow(/refusing worktree.*separate git repository/);
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
        'command -v git',
        'echo hi > work.txt && git add work.txt && git commit -qm work && echo COMMITTED',
        'git update-ref refs/heads/main HEAD && echo REF_MOVED',
        'git branch other && echo BRANCHED',
        `touch ${shared}/objects/tacet-probe && echo OBJECTS_WRITABLE`,
        `touch ${shared}/tacet-probe && echo SHARED_WRITABLE`,
      ].join('; '),
    );
    await a.close(h);
    expect(output, output).toContain('COMMITTED');
    for (const leak of ['REF_MOVED', 'BRANCHED', 'OBJECTS_WRITABLE', 'SHARED_WRITABLE']) {
      expect(output).not.toContain(leak);
    }
    // No approval was asked for. (Under `on-request` Codex does not ask on a sandbox denial, so
    // COMMITTED above is what proves the commit worked inside the sandbox.)
    expect(events.filter((e) => e.t === 'approval.request')).toEqual([]);
    // The shared .git is exactly as it was: no refs moved, no objects added or removed.
    expect(git(repo, 'for-each-ref')).toBe(refsBefore);
    expect(files(join(shared, 'objects'))).toEqual(objectsBefore);

    // The Mini-conductor integrates outside the sandbox with the Worker's git environment.
    // It checks the worktree again first: the Worker could have rewritten its git dir.
    const wt = workerWorktree(worktree, repo);
    if (!wt) throw new Error('not a worktree');
    const env = trustedGitEnv(worktree, wt, gitEnv);
    const sha = execFileSync('git', [...SAFE_GIT_ARGS, 'rev-parse', 'HEAD'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', [...SAFE_GIT_ARGS, 'push', '-q', repo, 'HEAD:refs/heads/tacet/task-1'], {
      cwd: worktree,
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
    const own = addWorktree('own');
    const h = await a.start({ cwd: own });
    const { output } = await run(a, h, 'echo "objects=$GIT_OBJECT_DIRECTORY"');
    await a.close(h);
    expect(files(join(userHome, 'sessions')).some((f) => f.endsWith('.jsonl'))).toBe(true);
    // The user's own session keeps its branch and git environment.
    expect(git(own, 'symbolic-ref', 'HEAD')).toBe('refs/heads/tacet/own');
    expect(output).toContain('objects=\n');
  });

  it('keys the state dir by the repo root and stateDir; outside git, by the cwd', async () => {
    const stateDir = join(root, 'state');
    const a = adapter({ stateDir });
    const h = await a.start({ cwd: worktree });
    await a.close(h);
    expect(existsSync(join(repoStateDir(repo, stateDir), 'codex'))).toBe(true);
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const b = adapter({ stateDir }, false);
    const h2 = await b.start({ cwd: plain });
    await b.close(h2);
    expect(existsSync(join(repoStateDir(plain, stateDir), 'codex'))).toBe(true);
    // A git checkout without a trusted repo root is refused.
    await expect(adapter({}, false).start({ cwd: worktree })).rejects.toThrow(/repoRoot/);
  });

  it('leaves the main worktree attached, and runs none of the repo hooks on start', async () => {
    const wt = addWorktree('hooks');
    const marker = join(root, 'hook-ran');
    const hooks = ['post-checkout', 'reference-transaction'].map((n) =>
      join(repo, '.git', 'hooks', n),
    );
    for (const hook of hooks) {
      writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(hook, 0o755);
    }
    const a = adapter();
    const h = await a.start({ cwd: wt });
    await a.close(h);
    const m = await a.start({ cwd: repo });
    await a.close(m);
    for (const hook of hooks) rmSync(hook);
    expect(existsSync(marker)).toBe(false);
    expect(() => git(wt, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  });

  it('refuses a worktree whose git metadata the Worker rewrote, before running git', async () => {
    const marker = join(root, 'escaped');
    const forge = (name: string, tamper: (wt: string, gitDir: string) => void) => {
      const wt = addWorktree(name);
      const gitDir = join(repo, '.git', 'worktrees', name);
      // What a Worker could write: a fake common dir in the worktree whose hooks touch a marker.
      const evil = join(wt, 'evil');
      mkdirSync(join(evil, 'hooks'), { recursive: true });
      writeFileSync(join(evil, 'config'), `[core]\n\thooksPath = ${join(evil, 'hooks')}\n`);
      for (const h of ['post-checkout', 'reference-transaction', 'pre-push']) {
        writeFileSync(join(evil, 'hooks', h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      }
      tamper(wt, gitDir);
      return wt;
    };
    const cases = [
      forge('t-commondir', (wt, gd) => writeFileSync(join(gd, 'commondir'), join(wt, 'evil'))),
      forge('t-gitfile', (wt) => writeFileSync(join(wt, '.git'), `gitdir: ${join(wt, 'evil')}\n`)),
      forge('t-backlink', (wt, gd) => writeFileSync(join(gd, 'gitdir'), join(wt, 'evil', '.git'))),
      forge('t-wtconfig', (_wt, gd) => writeFileSync(join(gd, 'config.worktree'), '')),
    ];
    for (const wt of cases) {
      await expect(adapter().start({ cwd: wt })).rejects.toThrow(/refusing worktree/);
      expect(() => workerWorktree(wt, repo)).toThrow(/refusing worktree/);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a worktree with no commit to start from', async () => {
    const wt = addWorktree('unborn');
    writeFileSync(join(repo, '.git', 'worktrees', 'unborn', 'HEAD'), 'ref: refs/heads/nothing\n');
    await expect(adapter().start({ cwd: wt })).rejects.toThrow(/no commit/);
  });

  it('keeps the git dir writable for a resumed thread', async () => {
    const wt = addWorktree('resume');
    const a = adapter();
    const h = await a.start({ cwd: wt });
    const first = await run(
      a,
      h,
      'echo one > a.txt && git add a.txt && git commit -qm one && echo FIRST',
    );
    expect(first.output, first.output).toContain('FIRST');
    await a.close(h);
    const id = h.vendorSessionId;
    if (!id) throw new Error('no thread id');
    const r = await a.start({ cwd: wt, resume: { vendorSessionId: id } });
    const { output } = await run(
      a,
      r,
      'echo two > b.txt && git add b.txt && git commit -qm two && echo SECOND',
    );
    await a.close(r);
    expect(output, output).toContain('SECOND');
  });

  it('ignores a commondir forged after the check, in git run outside the sandbox', async () => {
    const wt = addWorktree('race');
    // A Worker ran here (HEAD detached), and is still running when the Mini-conductor integrates.
    const a = adapter();
    await a.close(await a.start({ cwd: wt }));
    const gitDir = join(repo, '.git', 'worktrees', 'race');
    const checked = workerWorktree(wt, repo);
    if (!checked) throw new Error('not a worktree');
    // The Worker rewrites commondir between the check and the integration.
    const evil = join(wt, 'evil');
    const marker = join(root, 'race-escaped');
    // A complete fake common dir, so git would accept it if it read the forged commondir.
    for (const d of ['hooks', 'refs/heads']) mkdirSync(join(evil, d), { recursive: true });
    writeFileSync(join(evil, 'HEAD'), 'ref: refs/heads/main\n');
    symlinkSync(join(repo, '.git', 'objects'), join(evil, 'objects'));
    writeFileSync(join(evil, 'config'), `[core]\n\thooksPath = ${join(evil, 'hooks')}\n`);
    for (const h of ['pre-push', 'reference-transaction']) {
      writeFileSync(join(evil, 'hooks', h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    }
    writeFileSync(join(gitDir, 'commondir'), evil);
    // Without the explicit environment git would follow it and run the hook (control).
    expect(
      execFileSync('git', ['-C', wt, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
        env: gitEnv,
        encoding: 'utf8',
      }).trim(),
    ).toBe(evil);
    // Pushed to a separate bare repo: pushing into `repo` itself would also trip over other
    // tests' unintegrated worktrees (see ARCHITECTURE §6), which is not what this checks.
    const target = join(root, 'race-target.git');
    execFileSync('git', ['init', '-q', '--bare', target], { env: gitEnv });
    const env = trustedGitEnv(wt, checked, gitEnv);
    execFileSync('git', [...SAFE_GIT_ARGS, 'push', '-q', target, 'HEAD:refs/heads/out'], {
      cwd: wt,
      env,
      stdio: 'ignore',
    });
    expect(existsSync(marker)).toBe(false);
    expect(git(target, 'rev-parse', 'out')).toBe(git(repo, 'rev-parse', 'main'));
    // Even without SAFE_GIT_ARGS, the explicit GIT_COMMON_DIR keeps the forged hooks out.
    execFileSync('git', ['push', '-q', target, 'HEAD:refs/heads/out2'], {
      cwd: wt,
      env,
      stdio: 'ignore',
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a repo with extensions.worktreeConfig', async () => {
    const wt = addWorktree('wtcfg');
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    try {
      await expect(adapter().start({ cwd: wt })).rejects.toThrow(/worktreeConfig/);
    } finally {
      git(repo, 'config', '--unset', 'extensions.worktreeConfig');
    }
  });

  it('does not follow a logs/HEAD symlink when it detaches', async () => {
    const wt = addWorktree('reflog');
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    const logs = join(repo, '.git', 'worktrees', 'reflog', 'logs');
    mkdirSync(logs, { recursive: true });
    rmSync(join(logs, 'HEAD'), { force: true });
    symlinkSync(victim, join(logs, 'HEAD'));
    const a = adapter();
    const h = await a.start({ cwd: wt });
    await a.close(h);
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
    expect(() => git(wt, 'symbolic-ref', '-q', 'HEAD')).toThrow();
  });
});
