import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkAdapter } from '@tacet/adapter-claude-sdk';
import { type MockMessagesApi, startMockMessagesApi } from '@tacet/adapter-claude-sdk/testing';
import type { SessionHandle, SessionOptions } from '@tacet/core';
import { newUlid, tasksProjection } from '@tacet/core';
import {
  type EventStore,
  endMarkedProcesses,
  isProcessRunning,
  markedProcesses,
  openEventStore,
  WorkerTokens,
} from '@tacet/core/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventLogBackend } from '../mcp/backend.js';
import { MiniMcpServer } from '../mcp/server.js';
import { MiniConductor } from './daemon.js';
import { SingleStepPlanner } from './planner.js';
import { TempWorkspaces } from './testing.js';

/**
 * The daemon with real parts: a Claude Code Worker (Agent SDK, local mock of the Messages API)
 * calls the Mini-conductor's MCP `escalate` tool; the turn ends with the escalation open, so the
 * sub-task waits as `input_required`; once answered, the daemon delivers the answer as the
 * Worker's next message and the sub-task completes.
 */
describe('Mini-conductor with a real Claude Worker', () => {
  let api: MockMessagesApi;
  let root: string;
  let store: EventStore;
  let server: MiniMcpServer;
  let ws: TempWorkspaces;
  let daemon: MiniConductor;

  beforeAll(async () => {
    api = await startMockMessagesApi();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mini-e2e-')));
    mkdirSync(join(root, 'home'));
    store = openEventStore(':memory:');
    server = await MiniMcpServer.start({
      backend: new EventLogBackend({ store, gateTimeoutMs: 200 }),
      tokens: new WorkerTokens(),
    });
    ws = new TempWorkspaces();
  });

  /** Every Worker marker a test recorded, so a failed test leaves no Worker running. */
  const markerFiles: string[] = [];
  const leftovers: string[] = [];

  afterAll(async () => {
    await daemon?.stop();
    for (const f of markerFiles) {
      try {
        await endMarkedProcesses(JSON.parse(readFileSync(f, 'utf8')) as string[]);
      } catch {
        // No file: nothing was recorded.
      }
    }
    await endMarkedProcesses(leftovers);
    await server?.close();
    store?.close();
    await api?.close();
    ws?.dispose();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('escalates, waits for the answer, then completes', { timeout: 120_000 }, async () => {
    const home = join(root, 'home');
    const claude = new ClaudeSdkAdapter({
      authRoute: 'api_key',
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'placeholder-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      mcpConfigDir: join(root, 'run', 'mcp'),
      sdkOptions: { settingSources: [] },
    });
    daemon = new MiniConductor({
      store,
      config: { tiers: { worker: { adapter: 'claude-sdk', model: 'claude-sonnet-5-5' } } },
      adapters: { 'claude-sdk': { adapter: claude, authRoute: 'api_key' } },
      workspaces: ws,
      planner: new SingleStepPlanner(),
      mcp: server,
      lockPath: join(root, 'mini.lock'),
      pollMs: 50,
    });
    await daemon.start();
    const id = daemon.submit({
      goal: 'ESCALATE before choosing a database',
      acceptanceCriteria: ['ok'],
    });
    const sub = `${id}/1`;
    const state = () => store.replay(tasksProjection).tasks[sub]?.state;

    await expect.poll(state, { timeout: 60_000, interval: 100 }).toBe('input_required');
    const raised = store.query({ taskId: sub, typePrefix: 'escalation.raised' });
    expect(raised).toHaveLength(1);
    const escalation = raised[0]?.envelope;
    const escalationId = (escalation?.data as { id: string } | undefined)?.id;
    if (!escalationId) throw new Error('no escalation id');
    // Raised by the Worker itself, under the session the daemon started for this sub-task.
    const started = store.query({ taskId: sub, typePrefix: 'worker.started' })[0]?.envelope;
    expect(escalation?.sessionId).toBe(
      (started?.data as { sessionId: string } | undefined)?.sessionId,
    );

    // The user answers (as the Conductor or UI would record it).
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'conductor', id: 'test' },
      taskId: sub,
      type: 'escalation.resolved',
      data: { escalationId, answer: 'Use Postgres' },
    });
    await expect.poll(state, { timeout: 60_000, interval: 100 }).toBe('completed');
    await expect
      .poll(() => store.replay(tasksProjection).tasks[id]?.state, { timeout: 10_000 })
      .toBe('completed');
    expect(store.query({ taskId: sub, typePrefix: 'escalation.delivered' })).toHaveLength(1);
    // The answer reached the model as the Worker's next message.
    expect(api.requests.some((r) => r.text?.includes('Use Postgres'))).toBe(true);
    expect(daemon.errors.map(String)).toEqual([]);
  });

  it('ends the Worker a crashed Mini-conductor left running before resuming (#127)', {
    timeout: 120_000,
  }, async () => {
    // The first test's Mini-conductor shares the store: it must not pick this task up.
    await daemon?.stop();
    const home = join(root, 'home');
    const options = () => ({
      authRoute: 'api_key' as const,
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'placeholder-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      mcpConfigDir: join(root, 'run', 'mcp'),
      // The Mini-conductor refuses every approval but its own tools: Bash is allowed up front.
      sdkOptions: { settingSources: [], allowedTools: ['Bash'] },
    });
    // Running and not a zombie: this test process is the parent of the Claude Code it started,
    // and on macOS a killed child it has not reaped yet still answers kill(pid, 0) (#127 flake).
    const alive = isProcessRunning;
    /** What `ps` says about a process, for a failure message. */
    const psLine = (pid: number) => {
      try {
        return execFileSync('ps', ['-o', 'pid=,ppid=,stat=,command=', '-p', String(pid)], {
          encoding: 'utf8',
        }).trim();
      } catch {
        return `${pid}: no such process`;
      }
    };
    /** The previous run's Worker processes, as found when each new session started. */
    const leftAtStart: number[][] = [];
    let previous: string[] = [];
    class Probe extends ClaudeSdkAdapter {
      override async start(o: SessionOptions): Promise<SessionHandle> {
        leftAtStart.push([...markedProcesses(previous).values()].flat());
        return super.start(o);
      }
    }
    const lockPath = join(root, 'crash', 'mini.lock');
    markerFiles.push(`${lockPath}.workers`);
    const make = (adapter: ClaudeSdkAdapter) =>
      new MiniConductor({
        store,
        config: { tiers: { worker: { adapter: 'claude-sdk', model: 'claude-sonnet-5-5' } } },
        adapters: { 'claude-sdk': { adapter, authRoute: 'api_key' } },
        workspaces: ws,
        planner: new SingleStepPlanner(),
        mcp: server,
        lockPath,
        pollMs: 50,
      });
    // The first Mini-conductor's Worker starts a background job, escalates, and stays open
    // waiting for the answer.
    const first = make(new ClaudeSdkAdapter(options()));
    await first.start();
    const id = first.submit({
      goal: 'BACKGROUND_TOOL, then ESCALATE before choosing a queue',
      acceptanceCriteria: ['ok'],
    });
    const sub = `${id}/1`;
    const state = () => store.replay(tasksProjection).tasks[sub]?.state;
    await expect.poll(state, { timeout: 60_000, interval: 100 }).toBe('input_required');
    previous = JSON.parse(readFileSync(`${lockPath}.workers`, 'utf8')) as string[];
    leftovers.push(...previous);
    expect(previous).toHaveLength(1);
    // A crash: nothing is closed. Claude Code and the job its Bash tool left behind live on, the
    // job outside Claude Code's process group.
    first.crashForTest();
    const before = [...markedProcesses(previous).values()].flat();
    // The job is found among them by what it runs: the pid it wrote (`$$`) is its pid inside the
    // sandbox's PID namespace on Linux (#150), not the one the system knows it by.
    const job = before.find((pid) => / sleep 600$/.test(psLine(pid)));
    expect(job, before.map(psLine).join('\n')).toBeDefined();
    expect(before.length).toBeGreaterThan(1);
    expect(alive(job as number)).toBe(true);

    const escalationId = (
      store.query({ taskId: sub, typePrefix: 'escalation.raised' })[0]?.envelope.data as
        | { id: string }
        | undefined
    )?.id;
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'conductor', id: 'test' },
      taskId: sub,
      type: 'escalation.resolved',
      data: { escalationId, answer: 'Use a durable queue' },
    });
    daemon = make(new Probe(options()));
    await daemon.start();
    // Gone as soon as start() returns, before any Worker session starts.
    for (const pid of before) expect(alive(pid), psLine(pid)).toBe(false);
    await expect.poll(state, { timeout: 60_000, interval: 100 }).toBe('completed');
    expect(leftAtStart.length).toBeGreaterThan(0);
    expect(leftAtStart.flat()).toEqual([]);
    await daemon.stop();
    // Every session closed cleanly: nothing left to end next time.
    expect(JSON.parse(readFileSync(`${lockPath}.workers`, 'utf8'))).toEqual([]);
  });
});
