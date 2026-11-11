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
import { join } from 'node:path';
import type { SessionHandle } from '@tacet/core';
import { repoStateDir } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter, removeWorkerTree } from './adapter.js';
import { codexFixtureDir } from './testing/fixture-dir.js';
import { type MockResponsesApi, startMockResponsesApi } from './testing/mock-responses-api.js';

/**
 * A private TMPDIR per unattended Worker, with /tmp out of the sandbox's writable roots (#294),
 * against the real `codex app-server`: a repo, HOME and state dir all under /tmp are protected,
 * where without it the adapter has to refuse them (#293, #295). On Linux and macOS: on macOS
 * CI the first `git` inside the sandbox (the Xcode shim) works with it, and
 * `getconf DARWIN_USER_TEMP_DIR` there names the private TMPDIR (#294).
 */
const DENIED = /Read-only file system|Permission denied|Operation not permitted/;

describe('Codex Worker private TMPDIR (#294)', () => {
  let api: MockResponsesApi;
  let root: string;
  let repo: string;
  let worktree: string;
  let state: string;
  let gitEnv: Record<string, string>;

  beforeAll(async () => {
    api = await startMockResponsesApi();
    // Deliberately under /tmp: repo, HOME and state dir.
    root = realpathSync(mkdtempSync('/tmp/tacet-294-'));
    repo = join(root, 'repo');
    worktree = join(root, 'worktrees', 'task-1');
    state = join(root, 'state');
    mkdirSync(join(root, 'home'));
    mkdirSync(repo);
    gitEnv = {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tacet Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Tacet Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { env: gitEnv, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', worktree, '-b', 'tacet/task-1');
  });

  afterAll(async () => {
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** One turn running `cmd` in the Worker's shell; approvals refused. Returns the tool output. */
  async function run(a: CodexAppServerAdapter, h: SessionHandle, tap: EventTap, cmd: string) {
    const from = api.requests.length;
    let at = tap.events.length;
    await a.send(h, { text: `RUN_CMD ${cmd}` });
    for (;;) {
      const next = await tap.waitFor(
        (e) =>
          e.t === 'approval.request' ||
          (e.t === 'status' && (e.state === 'idle' || e.state === 'error')),
        45_000,
        at + 1,
      );
      at = next.index;
      if (next.event.t !== 'approval.request') break;
      // Never run outside the sandbox.
      await a.respond(h, next.event.id, { kind: 'reject', persist: false });
    }
    return api.requests
      .slice(from)
      .map((r) => r.toolOutput ?? '')
      .join('\n');
  }

  it('writes only its own TMPDIR: not /tmp, the shared .git or CODEX_HOME, all under /tmp', {
    timeout: 180_000,
  }, async () => {
    const a = new CodexAppServerAdapter({
      authRoute: 'api_key',
      apiBaseUrl: api.url,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      baseEnv: { ...gitEnv, OPENAI_API_KEY: 'placeholder-not-a-real-key' },
      repoRoot: repo,
      stateDir: state,
    });
    // Not refused: nothing shared is left writable.
    const h = await a.start({ cwd: worktree });
    const tap = new EventTap(a.events(h));
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 30_000);
    const repoState = repoStateDir(repo, state);
    const codexHome = join(repoState, 'codex');
    const tmps = join(repoState, 'codex-tmp');
    const [own] = readdirSync(tmps);
    expect(own).toBeDefined();
    const workerTmp = join(tmps, own as string);

    // The first git inside the sandbox works: on macOS the Xcode shim writes its cache under
    // the per-user temp dir, which inside the sandbox is the private TMPDIR (#294).
    const first = await run(a, h, tap, 'git --version && git status --short && echo GIT-OK');
    expect(first, first).toContain('GIT-OK');
    const mine = await run(
      a,
      h,
      tap,
      'echo "TMP=$TMPDIR T=$TMP TE=$TEMP"; touch "$TMPDIR/y" && echo TMP-OK',
    );
    expect(mine).toContain(`TMP=${workerTmp} T=${workerTmp} TE=${workerTmp}`);
    expect(mine).toContain('TMP-OK');
    expect(existsSync(join(workerTmp, 'y'))).toBe(true);

    const slashTmp = join('/tmp', `tacet-294-outside-${process.pid}`);
    const outside = await run(a, h, tap, `touch ${slashTmp} && echo OUT-OK`);
    expect(outside).not.toContain('OUT-OK');
    // Refused by the sandbox, not merely not run.
    expect(outside).toMatch(DENIED);
    expect(existsSync(slashTmp)).toBe(false);

    const ref = join(repo, '.git', 'refs', 'heads', 'evil');
    const shared = await run(a, h, tap, `git rev-parse HEAD > ${ref} && echo REF-OK`);
    expect(shared).not.toContain('REF-OK');
    expect(shared).toMatch(DENIED);
    expect(existsSync(ref)).toBe(false);

    const config = join(codexHome, 'config.toml');
    const before = readFileSync(config, 'utf8');
    const home = await run(a, h, tap, `echo '# planted' >> ${config} && echo HOME-OK`);
    expect(home).not.toContain('HOME-OK');
    expect(home).toMatch(DENIED);
    expect(readFileSync(config, 'utf8')).toBe(before);

    // A directory the Worker locked (mode 000) does not stop the cleanup, or crash the host.
    const locked = await run(
      a,
      h,
      tap,
      'mkdir -p "$TMPDIR/a/b" && touch "$TMPDIR/a/b/f" && chmod 000 "$TMPDIR/a" && echo LOCK-OK',
    );
    expect(locked).toContain('LOCK-OK');
    await a.close(h);
    // Its temp files go with the session.
    expect(existsSync(workerTmp)).toBe(false);

    // Resumed: a fresh private TMPDIR, and /tmp still read-only.
    const again = await a.start({
      cwd: worktree,
      resume: { vendorSessionId: h.vendorSessionId as string },
    });
    const tap2 = new EventTap(a.events(again));
    await tap2.waitFor((e) => e.t === 'status' && e.state === 'idle', 30_000);
    const resumed = await run(a, again, tap2, `touch ${slashTmp} && echo OUT-OK`);
    expect(resumed).not.toContain('OUT-OK');
    expect(resumed).toMatch(DENIED);
    expect(existsSync(slashTmp)).toBe(false);
    await a.close(again);
    expect(readdirSync(tmps)).toEqual([]);
  });
});

describe('removeWorkerTree (#294)', () => {
  it('removes a tree with a locked directory, never following a symlink out of it', () => {
    const base = codexFixtureDir('tacet-294-rm-');
    try {
      const outside = join(base, 'outside');
      mkdirSync(join(outside, 'keep'), { recursive: true });
      chmodSync(outside, 0o755);
      const tree = join(base, 'tree');
      mkdirSync(join(tree, 'a', 'b'), { recursive: true });
      writeFileSync(join(tree, 'a', 'b', 'f'), 'x');
      symlinkSync(outside, join(tree, 'link'));
      chmodSync(join(tree, 'a'), 0o000);
      expect(() => removeWorkerTree(tree)).not.toThrow();
      expect(existsSync(tree)).toBe(false);
      expect(existsSync(join(outside, 'keep'))).toBe(true);
      expect(statSync(outside).mode & 0o777).toBe(0o755);
      // A tree that is not there is not an error either.
      expect(() => removeWorkerTree(tree)).not.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
