import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendOptions, SessionHandle } from '@tacet/core';
import { assertConformance, EventTap, formatResults, runConformance } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from './adapter.js';
import { type MockResponsesApi, startMockResponsesApi } from './testing/mock-responses-api.js';

/**
 * Runs the real `codex app-server` (pinned @openai/codex) against a local mock of the Responses
 * API: no credentials, no network. The API key is a placeholder the mock only checks is present.
 */
describe('CodexAppServerAdapter conformance (real codex, mock Responses API)', () => {
  let api: MockResponsesApi;
  let root: string;
  let home: string;
  let worktree: string;
  let adapter: CodexAppServerAdapter;

  beforeAll(async () => {
    api = await startMockResponsesApi();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-codex-')));
    worktree = join(root, 'worktree');
    home = join(root, 'home');
    mkdirSync(worktree);
    mkdirSync(home);
    adapter = new CodexAppServerAdapter({
      authRoute: 'api_key',
      apiBaseUrl: api.url,
      // `untrusted` makes Codex ask before running the mock's command, so approvals are exercised.
      approvalPolicy: 'untrusted',
      // No background plugin sync from GitHub: the test must not touch the network.
      config: { 'features.plugins': false },
      // Only what the binary needs; never the developer's own environment or credentials.
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        OPENAI_API_KEY: 'placeholder-not-a-real-key',
      },
    });
  });

  afterAll(async () => {
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function turn(h: SessionHandle, tap: EventTap, text: string, opts?: SendOptions) {
    const from = tap.events.length;
    await adapter.send(h, { text }, opts);
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

  it('passes the P0 probes', { timeout: 300_000 }, async () => {
    const results = await runConformance(adapter, {
      // Models from Codex's bundled catalog, so effort levels can be checked against model/list.
      // A Codex bump that changes the catalog can break these tests for that reason alone.
      session: { cwd: worktree, model: 'gpt-5.5' },
      replyPrompt: 'SAY hello',
      approvalPrompt: 'RUN_TOOL',
      slowPrompt: 'SLOW',
      echoPrompt: 'WHO',
      altModel: 'gpt-6-luna',
      // gpt-5.5 runs at `medium` by default, so `low` shows the change.
      altEffort: 'low',
      sentEffort: (p) => api.requests.findLast((r) => r.text === p)?.effort,
      timeoutMs: 60_000,
    });
    console.log(formatResults(results));
    assertConformance(results);
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
    expect(api.requests.every((r) => r.authorized)).toBe(true);
    expect(api.requests.some((r) => r.model === 'gpt-6-luna')).toBe(true);
  });

  it('sends effort per turn, and resume and fork keep the history', {
    timeout: 120_000,
  }, async () => {
    const h1 = await adapter.start({ cwd: worktree, model: 'gpt-5.5' });
    const tap1 = new EventTap(adapter.events(h1));
    expect(await turn(h1, tap1, 'SAY first', { effort: 'low' })).toBe('You said first.');
    expect(await turn(h1, tap1, 'SAY second', { effort: 'high' })).toBe('You said second.');
    expect(api.requests.findLast((r) => r.text === 'SAY first')?.effort).toBe('low');
    expect(api.requests.findLast((r) => r.text === 'SAY second')?.effort).toBe('high');
    await adapter.close(h1);
    const id = h1.vendorSessionId as string;

    const h2 = await adapter.start({ cwd: worktree, resume: { vendorSessionId: id } });
    expect(h2.vendorSessionId).toBe(id);
    // The resumed thread keeps `high`; a switch to a model whose levels cannot be confirmed is
    // refused rather than sent with it.
    await expect(
      adapter.send(h2, { text: 'SAY x' }, { model: 'gpt-mock-2' }),
    ).rejects.toMatchObject({ field: 'effort' });
    expect(await turn(h2, new EventTap(adapter.events(h2)), 'SAY third')).toBe('You said third.');
    await adapter.close(h2);

    const h3 = await adapter.start({ cwd: worktree, resume: { vendorSessionId: id, fork: true } });
    expect(h3.vendorSessionId).not.toBe(id);
    expect(await turn(h3, new EventTap(adapter.events(h3)), 'SAY fourth')).toBe('You said fourth.');
    await adapter.close(h3);
  });

  it('refuses effort levels and context windows it cannot honour', {
    timeout: 120_000,
  }, async () => {
    // Codex would lower `ultra` to the model's highest level and pass unlisted names through.
    await expect(
      adapter.start({ cwd: worktree, model: 'gpt-5.5', effort: 'ultra' }),
    ).rejects.toMatchObject({ name: 'ProfileRefusedError', field: 'effort' });
    await expect(
      adapter.start({ cwd: worktree, model: 'gpt-5.5', effort: 'none' }),
    ).rejects.toMatchObject({ field: 'effort' });
    // A model outside the catalog: its levels cannot be confirmed.
    await expect(
      adapter.start({ cwd: worktree, model: 'gpt-mock-1', effort: 'low' }),
    ).rejects.toMatchObject({ field: 'effort' });
    await expect(
      adapter.start({ cwd: worktree, model: 'gpt-5.5', contextWindow: 1_000_000 }),
    ).rejects.toMatchObject({ field: 'contextWindow' });

    // Launch effort reaches the API, and stays valid across a model switch.
    const h = await adapter.start({ cwd: worktree, model: 'gpt-5.5', effort: 'xhigh' });
    const tap = new EventTap(adapter.events(h));
    expect(await turn(h, tap, 'SAY xhigh')).toBe('You said xhigh.');
    expect(api.requests.findLast((r) => r.text === 'SAY xhigh')?.effort).toBe('xhigh');
    await expect(adapter.send(h, { text: 'SAY x' }, { effort: 'ultra' })).rejects.toMatchObject({
      field: 'effort',
    });
    // xhigh is in force; gpt-6-luna lists it, a model outside the catalog cannot be confirmed.
    await expect(adapter.send(h, { text: 'SAY x' }, { model: 'gpt-mock-2' })).rejects.toMatchObject(
      { field: 'effort' },
    );
    expect(await turn(h, tap, 'SAY luna', { model: 'gpt-6-luna' })).toBe('You said luna.');
    const luna = api.requests.findLast((r) => r.text === 'SAY luna');
    expect(luna).toMatchObject({ model: 'gpt-6-luna', effort: 'xhigh' });
    await adapter.close(h);
  });

  it('keeps the Worker MCP token off the command line and off disk', {
    timeout: 120_000,
  }, async () => {
    const marker = `worker-token-${Date.now()}`;
    const h = await adapter.start({
      cwd: worktree,
      model: 'gpt-mock-1',
      mcpServers: [
        {
          name: 'tacet',
          url: 'http://127.0.0.1:9/mcp',
          headers: { authorization: `Bearer ${marker}` },
        },
      ],
    });
    const tap = new EventTap(adapter.events(h));
    expect(await turn(h, tap, 'SAY up')).toBe('You said up.');
    if (process.platform === 'linux') {
      const cmdlines = readdirSync('/proc')
        .filter((d) => /^\d+$/.test(d))
        .map((pid) => {
          try {
            return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          } catch {
            return '';
          }
        });
      expect(cmdlines.some((c) => c.includes('app-server'))).toBe(true);
      expect(cmdlines.some((c) => c.includes(marker))).toBe(false);
    }
    await adapter.close(h);
    // Nothing Codex or Tacet wrote (CODEX_HOME, the worktree) contains the token.
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : [p];
      });
    const leaked = [...files(home), ...files(worktree)].filter((f) =>
      readFileSync(f).includes(marker),
    );
    expect(leaked).toEqual([]);
    expect(JSON.stringify(tap.events)).not.toContain(marker);
  });
});
