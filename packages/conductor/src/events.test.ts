import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EventResumeParams, newUlid, TACET_EVENT, TACET_EVENT_RESUME } from '@tacet/core';
import {
  type ClientContext,
  conductorRuntimePath,
  conductorStatePaths,
  connectRpc,
  openEventStore,
  type RpcClient,
  readRuntimeFile,
  repoStatePaths,
} from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Conductor, startConductor } from './conductor.js';
import { replicaDir } from './replicas.js';

/** Events up the link, as the Conductor takes them (#24). A stand-in Mini-conductor sends them. */
describe('the Conductor taking forwarded events', () => {
  let root: string;
  let stateDir: string;
  let runDir: string;
  let repo: string;
  let repoId: string;
  let conductor: Conductor;
  const clients: RpcClient[] = [];

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-events-')));
    stateDir = join(root, 'state');
    runDir = join(root, 'run');
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    repoId = repoStatePaths(repo).repoId;
    conductor = await startConductor({ stateDir, runDir, syncIntervalMs: 30 });
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await conductor.close();
    rmSync(root, { recursive: true, force: true });
  });

  const registry = (type: 'registry.repo_added' | 'registry.repo_removed') => {
    const s = openEventStore(conductorStatePaths(stateDir).events);
    s.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'conductor', id: 'cli' },
      repo: repoId,
      type,
      data: type === 'registry.repo_added' ? { repoId, repoPath: repo } : { repoId },
    });
    s.close();
  };
  const env = (type: string, taskId = 't1', more: Record<string, unknown> = {}) => ({
    v: 1,
    id: newUlid(),
    ts: new Date().toISOString(),
    source: { kind: 'mini', id: 'standalone' },
    repo: repoId,
    taskId,
    type,
    data:
      type === 'task.created'
        ? {
            id: taskId,
            goal: 'g',
            acceptanceCriteria: ['ok'],
            priority: 'p2',
            createdAt: new Date().toISOString(),
          }
        : {},
    ...more,
  });

  /** A stand-in Mini-conductor of the repo: records each resume and sends batches by hand. */
  const mini = async (logId = 'log-a', events = ['resume']) => {
    const resumes: EventResumeParams[] = [];
    let link: ClientContext | undefined;
    const c = await connectRpc({
      port: conductor.port,
      token: readRuntimeFile(conductorRuntimePath(runDir)).token,
      clientInfo: { name: 'fake-mini', version: '0' },
      role: 'mini',
      card: { repoId, repoPath: repo, adapters: [], miniVersion: '0' },
      capabilities: { serves: [], events },
      handlers: {
        [TACET_EVENT_RESUME]: (p, ctx) => {
          resumes.push(p as EventResumeParams);
          link = ctx;
          const q = p as EventResumeParams;
          return { logId, afterSeq: q.logId === logId ? (q.afterSeq ?? 0) : 0 };
        },
      },
    });
    clients.push(c);
    const send = (throughSeq: number, batch: unknown[], id = logId) =>
      c.notify(TACET_EVENT, { logId: id, throughSeq, events: batch });
    return { c, resumes, send, link: () => link };
  };

  it('resumes only a registered repo, and keeps its forwardable events in its replica', async () => {
    const m = await mini();
    await new Promise((r) => setTimeout(r, 100));
    // Connected, not registered: never asked, and what it sends anyway is not taken.
    expect(m.resumes).toEqual([]);
    await m.send(1, [env('task.created', 'unasked')]);
    await new Promise((r) => setTimeout(r, 100));
    registry('registry.repo_added');
    await vi.waitFor(() => expect(m.resumes).toEqual([{}]));
    await m.send(5, [
      env('task.created'),
      // Transcript-grade: never taken.
      env('agent.message.delta'),
      // A type this version does not know, in an allowlisted namespace: kept for a later one.
      env('task.from_the_future'),
    ]);
    await vi.waitFor(() =>
      expect(Object.keys(conductor.tasks(repoId)?.tasks ?? {})).toEqual(['t1']),
    );
    const replica = openEventStore(join(replicaDir(stateDir, repoId), 'events.db'), {
      readonly: true,
    });
    try {
      expect(replica.query({}).map((e) => e.envelope.type)).toEqual([
        'task.created',
        'task.from_the_future',
      ]);
      expect(replica.meta('x.cursor')).toBe(JSON.stringify({ logId: 'log-a', seq: 5 }));
    } finally {
      replica.close();
    }
  });

  it('resumes from where its replica stands after a reconnect', async () => {
    registry('registry.repo_added');
    const first = await mini();
    await vi.waitFor(() => expect(first.resumes).toHaveLength(1));
    await first.send(7, [env('task.created')]);
    await vi.waitFor(() => expect(conductor.tasks(repoId)?.tasks.t1).toBeDefined());
    await first.c.close();
    const again = await mini();
    await vi.waitFor(() => expect(again.resumes).toEqual([{ logId: 'log-a', afterSeq: 7 }]));
    // A batch from before the cursor changes nothing.
    await again.send(3, [env('task.created', 't-old')]);
    await new Promise((r) => setTimeout(r, 50));
    expect(conductor.tasks(repoId)?.tasks['t-old']).toBeUndefined();
  });

  it('begins the replica again for a log made again, so no task of the old one stays', async () => {
    registry('registry.repo_added');
    const first = await mini('log-a');
    await vi.waitFor(() => expect(first.resumes).toHaveLength(1));
    await first.send(4, [env('task.created', 'old-task')]);
    await vi.waitFor(() => expect(conductor.tasks(repoId)?.tasks['old-task']).toBeDefined());
    await first.c.close();
    const second = await mini('log-b');
    await vi.waitFor(() => expect(second.resumes).toHaveLength(1));
    await second.send(1, [env('task.created', 'new-task')]);
    await vi.waitFor(() =>
      expect(Object.keys(conductor.tasks(repoId)?.tasks ?? {})).toEqual(['new-task']),
    );
  });

  it('closes a Mini-conductor that forwards what it must not', async () => {
    registry('registry.repo_added');
    const cases: [string, (m: Awaited<ReturnType<typeof mini>>) => Promise<void>][] = [
      [
        'claims the Conductor',
        (m) => m.send(1, [env('task.created', 't', { source: { kind: 'conductor', id: 'x' } })]),
      ],
      ['a registry event', (m) => m.send(1, [env('registry.repo_added')])],
      ['another log', (m) => m.send(1, [env('task.created')], 'log-z')],
      ['not an envelope', (m) => m.send(1, [{ type: 'task.created' }])],
      [
        'too large',
        (m) => m.send(1, [env('task.created', 't', { data: { big: 'x'.repeat(300_000) } })]),
      ],
    ];
    for (const [what, act] of cases) {
      const m = await mini();
      await vi.waitFor(() => expect(m.resumes).toHaveLength(1));
      await act(m);
      expect((await m.c.closed).code, what).toBe(1008);
      clients.splice(clients.indexOf(m.c), 1);
    }
    expect(conductor.tasks(repoId)?.tasks ?? {}).toEqual({});
  });

  it('asks an older Mini-conductor for nothing', async () => {
    registry('registry.repo_added');
    const m = await mini('log-a', []);
    await new Promise((r) => setTimeout(r, 150));
    expect(m.resumes).toEqual([]);
  });

  it('on unregistering, closes the link and deletes the replica', async () => {
    registry('registry.repo_added');
    const m = await mini();
    await vi.waitFor(() => expect(m.resumes).toHaveLength(1));
    await m.send(2, [env('task.created')]);
    await vi.waitFor(() => expect(conductor.tasks(repoId)?.tasks.t1).toBeDefined());
    registry('registry.repo_removed');
    expect((await m.c.closed).code).toBe(1000);
    await vi.waitFor(() => expect(existsSync(replicaDir(stateDir, repoId))).toBe(false));
    expect(conductor.tasks(repoId)).toBeUndefined();
  });
});
