import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
      // The Workers' production setting (#206): file tools only, MCP tools loaded inline.
      fileToolsOnly: true,
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
      sdkOptions: { allowedTools: ['Bash'] },
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
    const workspaceId = (
      store.query({ taskId: sub, typePrefix: 'worker.started' })[0]?.envelope.data as
        | { workspaceId: string }
        | undefined
    )?.workspaceId;
    const checkout = (await ws.get(workspaceId ?? ''))?.path ?? '';
    const job = Number.parseInt(readFileSync(join(checkout, 'background.pid'), 'utf8'), 10);
    // A crash: nothing is closed. Claude Code and the job its Bash tool left behind live on, the
    // job outside Claude Code's process group.
    first.crashForTest();
    const before = [...markedProcesses(previous).values()].flat();
    expect(before).toContain(job);
    expect(before.length).toBeGreaterThan(1);
    expect(alive(job)).toBe(true);

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

  it("decides a real Worker's searches by the policy, walks no symlink out, and runs no Bash (#206)", {
    timeout: 180_000,
  }, async () => {
    await daemon?.stop();
    const home = join(root, 'home');
    const outside = join(root, 'outside-206');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'needle\n');
    /** Checkouts with a file to find and a committed-style symlink out of the checkout. */
    const seeded = new TempWorkspaces();
    const create = seeded.create.bind(seeded);
    seeded.create = async (id: string) => {
      const w = await create(id);
      writeFileSync(join(w.path, 'inside.txt'), 'needle\n');
      symlinkSync(outside, join(w.path, 'link'));
      return w;
    };
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
      fileToolsOnly: true,
    });
    daemon = new MiniConductor({
      store,
      config: { tiers: { worker: { adapter: 'claude-sdk', model: 'claude-sonnet-5-5' } } },
      adapters: { 'claude-sdk': { adapter: claude, authRoute: 'api_key' } },
      workspaces: seeded,
      planner: new SingleStepPlanner(),
      mcp: server,
      lockPath: join(root, 'mini.lock'),
      pollMs: 50,
    });
    await daemon.start();
    const run = async (goal: string) => {
      const id = daemon.submit({ goal, acceptanceCriteria: ['ok'] });
      await expect
        .poll(() => store.replay(tasksProjection).tasks[id]?.state, {
          timeout: 90_000,
          interval: 100,
        })
        .toMatch(/completed|failed/);
      return `${id}/1`;
    };
    const decisions = (sub: string) =>
      [
        ...store.query({ taskId: sub, typePrefix: 'agent.approval.decision' }),
        ...store.query({ taskId: sub, typePrefix: 'worker.approval' }),
      ].map((e) => e.envelope.data as { toolName?: string; decision: string });
    const toolResultText = () => api.requests.at(-1)?.raw ?? '';

    // In the checkout: asked through the hook, allowed by the policy, and it really searches.
    const grep = await run('GREP_TOOL . needle');
    expect(decisions(grep)).toEqual([
      expect.objectContaining({ toolName: 'Grep', decision: 'allowed' }),
    ]);
    expect(toolResultText()).toContain('inside.txt');
    // The symlink out of the checkout is not walked (#213 review F1).
    expect(toolResultText()).not.toContain('secret.txt');
    const glob = await run('GLOB_TOOL . **/*.txt');
    expect(decisions(glob)).toEqual([
      expect.objectContaining({ toolName: 'Glob', decision: 'allowed' }),
    ]);
    expect(toolResultText()).toContain('inside.txt');
    expect(toolResultText()).not.toContain('secret.txt');

    // Outside the checkout: refused by the policy, nothing found.
    const out = await run(`GREP_TOOL ${outside} needle`);
    expect(decisions(out)).toEqual([
      expect.objectContaining({ toolName: 'Grep', decision: 'refused' }),
    ]);
    expect(toolResultText()).not.toContain('secret.txt');

    // No shell at all: the model's Bash call fails without even an approval request.
    const bash = await run('RUN_TOOL');
    expect(decisions(bash)).toEqual([]);
    expect(store.query({ taskId: bash, typePrefix: 'agent.approval.request' })).toEqual([]);
    for (const id of seeded.created)
      expect(existsSync(join(seeded.root, id, 'tool-ran.txt'))).toBe(false);
    await daemon.stop();
    seeded.dispose();
  });
});
