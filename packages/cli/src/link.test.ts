import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Conductor, startConductor } from '@tacet/conductor';
import {
  conductorRuntimePath,
  type RpcConnection,
  randomToken,
  repoStatePaths,
  startRpcServer,
  writeRuntimeFile,
} from '@tacet/core/node';
import { type Standalone, startStandalone } from '@tacet/mini/standalone';
import { ScriptedAdapter } from '@tacet/mini/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Conductor calling a real standalone Mini-conductor over the link it dialed (#24, ADR-003
 * §4): reading and cancelling, and nothing else.
 */
describe('the Conductor link, Conductor to Mini-conductor', () => {
  let root: string;
  let repo: string;
  let conductor: Conductor;
  let sa: Standalone;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-link-')));
    repo = join(root, 'repo');
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tacet Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Tacet Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    mkdirSync(join(repo, '.tacet'), { recursive: true });
    mkdirSync(join(root, 'user'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
    writeFileSync(
      join(repo, '.tacet', 'tacet.yaml'),
      `tiers:\n  worker: { adapter: claude-sdk, model: cheap }\nevents: { state_dir: ${JSON.stringify(join(root, 'state'))} }\n`,
    );
    execFileSync('git', ['-C', repo, 'add', '.'], { env });
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'init'], { env });
    const runDir = join(root, 'run');
    conductor = await startConductor({ stateDir: join(root, 'conductor-state'), runDir });
    sa = await startStandalone({
      repoRoot: repo,
      userDir: join(root, 'user'),
      home: join(root, 'home'),
      runDir,
      singleStep: true,
      // A Worker that keeps working until it is cancelled.
      adapters: {
        'claude-sdk': {
          adapter: new ScriptedAdapter('claude-sdk', () => ({ do: 'hold' })),
          authRoute: 'api_key',
        },
      },
      conductor: { minDelayMs: 20, settleMs: 20 },
    });
  });
  afterEach(async () => {
    await sa.close();
    await conductor.close();
    rmSync(root, { recursive: true, force: true });
  });

  const link = async () => {
    const { repoId } = repoStatePaths(realpathSync(repo));
    await vi.waitFor(() => expect(conductor.mini(repoId)).toBeDefined(), { timeout: 5000 });
    return conductor.mini(repoId) as NonNullable<ReturnType<Conductor['mini']>>;
  };

  it('lists, reads and cancels the tasks of the repo, as the control port would', async () => {
    const id = sa.mini.submit({ goal: 'hold on', acceptanceCriteria: ['ok'] });
    const mini = await link();
    expect(mini.serves).toEqual(['ListTasks', 'GetTask', 'CancelTask']);
    await vi.waitFor(async () =>
      expect((await mini.getTask(id)).status.state).toBe('TASK_STATE_WORKING'),
    );
    const list = await mini.listTasks();
    expect(list.tasks.map((t) => t.id)).toEqual([id]);
    expect(list.totalSize).toBe(1);
    await expect(mini.getTask('no-such-task')).rejects.toMatchObject({ code: -32001 });
    const canceled = await mini.cancelTask(id);
    expect(canceled.status.state).toBe('TASK_STATE_CANCELED');
    await expect(mini.cancelTask(id)).rejects.toMatchObject({ code: -32002 });
  });

  it('serves nothing else: no new tasks or answers over the link', async () => {
    const id = sa.mini.submit({ goal: 'hold on', acceptanceCriteria: ['ok'] });
    // A raw Conductor in the real one's place (the next start): calls below MiniLink.
    await conductor.close();
    const conns: RpcConnection[] = [];
    const token = randomToken(32);
    const fake = await startRpcServer({
      token,
      handlers: {},
      serverInfo: { name: 'fake-conductor', version: '0' },
      roles: ['mini'],
      onConnection: (c) => conns.push(c),
    });
    try {
      writeRuntimeFile({
        path: conductorRuntimePath(join(root, 'run')),
        port: fake.port,
        protocolVersions: [1],
        token,
      });
      await vi.waitFor(() => expect(conns).toHaveLength(1), { timeout: 5000 });
      const conn = conns[0] as RpcConnection;
      for (const method of ['SendMessage', 'SubscribeToTask', 'tacet/attach', 'nope']) {
        await expect(
          conn.call(method, {
            message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'do something' }] },
          }),
        ).rejects.toMatchObject({ code: -32601 });
      }
      // Answering an escalation over the link is refused just the same.
      await expect(
        conn.call('SendMessage', {
          message: { messageId: 'm2', role: 'ROLE_USER', taskId: id, parts: [{ text: 'yes' }] },
        }),
      ).rejects.toMatchObject({ code: -32601 });
    } finally {
      await fake.close();
    }
  });
});
