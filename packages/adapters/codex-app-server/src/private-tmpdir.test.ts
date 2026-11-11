import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SessionHandle } from '@tacet/core';
import { repoStateDir } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from './adapter.js';
import { type MockResponsesApi, startMockResponsesApi } from './testing/mock-responses-api.js';

/**
 * A private TMPDIR per unattended Worker, with /tmp out of the sandbox's writable roots (#294),
 * against the real `codex app-server`: a repo, HOME and state dir all under /tmp are protected,
 * where without it the adapter has to refuse them (#293, #295). Off on macOS (the Xcode `git`
 * shim and the per-user temp dir are unchecked there), so this runs elsewhere only.
 */
describe.runIf(process.platform !== 'darwin')('Codex Worker private TMPDIR (#294)', () => {
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

    const mine = await run(a, h, tap, 'echo "TMP=$TMPDIR"; touch "$TMPDIR/y" && echo TMP-OK');
    expect(mine).toContain(`TMP=${workerTmp}`);
    expect(mine).toContain('TMP-OK');
    expect(existsSync(join(workerTmp, 'y'))).toBe(true);

    const slashTmp = join('/tmp', `tacet-294-outside-${process.pid}`);
    const outside = await run(a, h, tap, `touch ${slashTmp} && echo OUT-OK`);
    expect(outside).not.toContain('OUT-OK');
    expect(existsSync(slashTmp)).toBe(false);

    const ref = join(repo, '.git', 'refs', 'heads', 'evil');
    const shared = await run(a, h, tap, `git rev-parse HEAD > ${ref} && echo REF-OK`);
    expect(shared).not.toContain('REF-OK');
    expect(existsSync(ref)).toBe(false);

    const config = join(codexHome, 'config.toml');
    const before = readFileSync(config, 'utf8');
    const home = await run(a, h, tap, `echo '# planted' >> ${config} && echo HOME-OK`);
    expect(home).not.toContain('HOME-OK');
    expect(readFileSync(config, 'utf8')).toBe(before);

    await a.close(h);
    // Its temp files go with the session.
    expect(existsSync(workerTmp)).toBe(false);
  });
});
