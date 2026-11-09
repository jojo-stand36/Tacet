import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileRefusedError, type SessionHandle } from '@tacet/core';
import { assertConformance, EventTap, formatResults, runConformance } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter } from './adapter.js';
import { type MockMessagesApi, startMockMessagesApi } from './testing/mock-messages-api.js';

/**
 * Runs the real Claude Code binary (bundled with the SDK) against a local mock of the Messages
 * API: no credentials, no network. The API key below is a placeholder the mock ignores.
 */
describe('ClaudeSdkAdapter conformance (real SDK, mock Messages API)', () => {
  let api: MockMessagesApi;
  let root: string;
  let adapter: ClaudeSdkAdapter;
  let worktree: string;

  beforeAll(async () => {
    api = await startMockMessagesApi();
    root = mkdtempSync(join(tmpdir(), 'tacet-claude-sdk-'));
    worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const home = join(root, 'home');
    mkdirSync(home);
    adapter = new ClaudeSdkAdapter({
      authRoute: 'api_key',
      // Only what the binary needs; never the developer's own environment or credentials.
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'placeholder-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      },
      mcpConfigDir: join(root, 'run', 'mcp'),
      sdkOptions: { settingSources: [] },
    });
  });

  afterAll(async () => {
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Run one turn to completion and return its reply text. */
  async function turn(h: SessionHandle, tap: EventTap, text: string): Promise<string> {
    const from = tap.events.length;
    await adapter.send(h, { text });
    const end = await tap.waitFor(
      (e) => e.t === 'status' && (e.state === 'idle' || e.state === 'error'),
      60_000,
      from + 1,
    );
    expect(end.event).toMatchObject({ state: 'idle' });
    return tap.events
      .slice(from, end.index)
      .map((e) => (e.t === 'message.delta' ? e.text : ''))
      .join('');
  }

  it('resume continues the conversation and fork branches it', { timeout: 120_000 }, async () => {
    const h1 = await adapter.start({ cwd: worktree, model: 'claude-sonnet-5-5' });
    expect(await turn(h1, new EventTap(adapter.events(h1)), 'SAY first')).toBe('You said first.');
    await adapter.close(h1);
    const id = h1.vendorSessionId as string;

    const h2 = await adapter.start({ cwd: worktree, resume: { vendorSessionId: id } });
    expect(await turn(h2, new EventTap(adapter.events(h2)), 'SAY second')).toBe('You said second.');
    expect(h2.vendorSessionId).toBe(id);
    // The resumed request carries the earlier turn: user, assistant, user.
    expect(api.requests.findLast((r) => r.text === 'SAY second')?.messages).toBeGreaterThanOrEqual(
      3,
    );
    await adapter.close(h2);

    const h3 = await adapter.start({ cwd: worktree, resume: { vendorSessionId: id, fork: true } });
    expect(await turn(h3, new EventTap(adapter.events(h3)), 'SAY third')).toBe('You said third.');
    expect(h3.vendorSessionId).not.toBe(id);
    expect(api.requests.findLast((r) => r.text === 'SAY third')?.messages).toBeGreaterThanOrEqual(
      5,
    );
    await adapter.close(h3);
  });

  it.runIf(process.platform === 'linux')(
    'keeps the Worker token out of every process command line',
    { timeout: 120_000 },
    async () => {
      const marker = `worker-token-${Date.now()}`;
      const h = await adapter.start({
        cwd: worktree,
        model: 'claude-sonnet-5-5',
        mcpServers: [
          { name: 'tacet', url: 'http://127.0.0.1:9/mcp', headers: { authorization: marker } },
        ],
      });
      // The binary is running once a turn has completed.
      expect(await turn(h, new EventTap(adapter.events(h)), 'SAY up')).toBe('You said up.');
      // Only this test's own process tree, so another Claude on the machine cannot satisfy it.
      const read = (path: string) => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return '';
        }
      };
      const parent = new Map<number, number>();
      for (const d of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
        // Field 4 of /proc/<pid>/stat, after the parenthesised command name.
        const ppid = Number(read(`/proc/${d}/stat`).split(') ')[1]?.split(' ')[1]);
        if (ppid) parent.set(Number(d), ppid);
      }
      const isDescendant = (pid: number): boolean => {
        for (let p = parent.get(pid); p !== undefined; p = parent.get(p)) {
          if (p === process.pid) return true;
        }
        return false;
      };
      const cmdlines = [...parent.keys()]
        .filter(isDescendant)
        .map((pid) => read(`/proc/${pid}/cmdline`));
      expect(cmdlines.some((c) => c.includes('--mcp-config'))).toBe(true);
      expect(cmdlines.some((c) => c.includes(marker))).toBe(false);
      await adapter.close(h);
    },
  );

  it('passes the P0 probes', { timeout: 300_000 }, async () => {
    const results = await runConformance(adapter, {
      session: {
        cwd: worktree,
        model: 'claude-sonnet-5-5',
        mcpServers: [
          { name: 'tacet', url: 'http://127.0.0.1:9/mcp', headers: { authorization: 'Bearer x' } },
        ],
      },
      replyPrompt: 'SAY hello',
      approvalPrompt: 'RUN_TOOL',
      slowPrompt: 'SLOW',
      echoPrompt: 'WHO',
      altModel: 'claude-opus-5-5',
      altEffort: 'high',
      sentEffort: () => api.requests.at(-1)?.effort,
      timeoutMs: 60_000,
    });
    console.log(formatResults(results));
    assertConformance(results);
    // P1 probes report only, but these are expected to pass on this SDK version.
    const p1 = Object.fromEntries(
      results.filter((r) => r.priority === 'P1').map((r) => [r.id, r.verdict]),
    );
    expect(p1).toMatchObject({
      'live-input': 'pass',
      resume: 'pass',
      'model-switch': 'pass',
      effort: 'pass',
      'context-sizes': 'pass',
    });
    // Every session removed its MCP config file on close, and none was written in the worktree.
    expect(readdirSync(join(root, 'run', 'mcp'))).toEqual([]);
    expect(existsSync(join(worktree, '.mcp.json'))).toBe(false);
    expect(api.requests.some((r) => r.model === 'claude-opus-5-5')).toBe(true);
  });

  it('sends launch effort and the 1M beta, and refuses what the model lacks', {
    timeout: 180_000,
  }, async () => {
    // Launch effort reaches the API as output_config.effort.
    const h = await adapter.start({ cwd: worktree, model: 'claude-sonnet-4-6', effort: 'low' });
    expect(await turn(h, new EventTap(adapter.events(h)), 'SAY low')).toBe('You said low.');
    expect(api.requests.findLast((r) => r.text.endsWith('SAY low'))?.effort).toBe('low');
    // claude-sonnet-4-6 lists no xhigh: refused, not silently lowered.
    await expect(adapter.send(h, { text: 'SAY x' }, { effort: 'xhigh' })).rejects.toThrow(
      ProfileRefusedError,
    );
    // A switch to a model without effort support would drop the session's effort: refused.
    await expect(
      adapter.send(h, { text: 'SAY x' }, { model: 'claude-sonnet-4-5' }),
    ).rejects.toThrow(ProfileRefusedError);
    await adapter.close(h);

    // claude-sonnet-4-5 has no effort support; the SDK would drop it silently.
    await expect(
      adapter.start({ cwd: worktree, model: 'claude-sonnet-4-5', effort: 'high' }),
    ).rejects.toMatchObject({ name: 'ProfileRefusedError', field: 'effort' });
    // Names Claude does not have are refused before any process starts.
    await expect(
      adapter.start({ cwd: worktree, model: 'claude-sonnet-4-6', effort: 'minimal' }),
    ).rejects.toMatchObject({ field: 'effort' });

    // The 1M window is an opt-in beta for Sonnet 4 and 4.5 only.
    const big = await adapter.start({
      cwd: worktree,
      model: 'claude-sonnet-4-5',
      contextWindow: 1_000_000,
    });
    expect(await turn(big, new EventTap(adapter.events(big)), 'SAY big')).toBe('You said big.');
    expect(api.requests.findLast((r) => r.text.endsWith('SAY big'))?.betas).toContain(
      'context-1m-2025-08-07',
    );
    await adapter.close(big);
    await expect(
      adapter.start({ cwd: worktree, model: 'claude-sonnet-5-5', contextWindow: 1_000_000 }),
    ).rejects.toMatchObject({ field: 'contextWindow' });
    await expect(
      adapter.start({ cwd: worktree, model: 'claude-sonnet-4-5', contextWindow: 2_000_000 }),
    ).rejects.toMatchObject({ field: 'contextWindow' });
    // No session was left behind by a refusal.
    expect(readdirSync(join(root, 'run', 'mcp'))).toEqual([]);
  });
});
