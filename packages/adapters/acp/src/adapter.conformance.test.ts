import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionHandle } from '@tacet/core';
import { mcpAuthHeaders, Secret } from '@tacet/core/node';
import { assertConformance, EventTap, formatResults, runConformance } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpAdapter } from './adapter.js';
import { GEMINI_AGENT } from './agents.js';
import { type MockGeminiApi, startMockGeminiApi } from './testing/mock-gemini-api.js';

const require = createRequire(import.meta.url);
/** The pinned Gemini CLI's entry point, run with this Node. */
const GEMINI = join(
  dirname(require.resolve('@google/gemini-cli/package.json')),
  'bundle/gemini.js',
);

/**
 * Runs the real Gemini CLI (pinned @google/gemini-cli) over ACP against a local mock of the
 * Gemini API: no credentials, no network. The API key is a placeholder the mock never checks.
 */
describe('AcpAdapter conformance (real Gemini CLI over ACP, mock Gemini API)', () => {
  let api: MockGeminiApi;
  let root: string;
  let worktree: string;
  let adapter: AcpAdapter;

  beforeAll(async () => {
    api = await startMockGeminiApi();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-acp-')));
    worktree = join(root, 'worktree');
    mkdirSync(worktree);
    mkdirSync(join(root, 'home'));
    adapter = new AcpAdapter({
      agent: GEMINI_AGENT,
      executable: [process.execPath, GEMINI],
      killTimeoutMs: 2000,
      // Only what the CLI needs; never the developer's own environment or credentials.
      baseEnv: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        GEMINI_API_KEY: 'placeholder-not-a-real-key',
        GOOGLE_GEMINI_BASE_URL: api.url,
      },
    });
  });

  afterAll(async () => {
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function turn(h: SessionHandle, tap: EventTap, text: string) {
    const from = tap.events.length;
    await adapter.send(h, { text });
    const end = await tap.waitFor(
      (e) => e.t === 'status' && e.state !== 'running',
      60_000,
      from + 1,
    );
    return { end: end.event, events: tap.events.slice(from, end.index + 1) };
  }

  it('passes the P0 probes', { timeout: 300_000 }, async () => {
    const results = await runConformance(adapter, {
      session: { cwd: worktree },
      replyPrompt: 'SAY hello',
      approvalPrompt: 'RUN_TOOL',
      slowPrompt: 'SLOW',
      echoPrompt: 'WHO',
      minDeltas: 2,
      timeoutMs: 60_000,
    });
    console.log(formatResults(results));
    assertConformance(results);
  });

  it('selects the model at launch', { timeout: 120_000 }, async () => {
    const h = await adapter.start({ cwd: worktree, model: 'gemini-2.5-pro' });
    const tap = new EventTap(adapter.events(h));
    const { events } = await turn(h, tap, 'WHO');
    expect(events.map((e) => (e.t === 'message.delta' ? e.text : '')).join('')).toBe(
      'model=gemini-2.5-pro',
    );
    // No model config option: a switch mid-session is refused, not ignored.
    await expect(adapter.send(h, { text: 'WHO' }, { model: 'other' })).rejects.toThrow(
      /no model config option/,
    );
    await adapter.close(h);
  });

  it('runs an approved tool, and not a rejected one', { timeout: 120_000 }, async () => {
    for (const kind of ['allow_once', 'reject'] as const) {
      const cwd = join(root, `wt-${kind}`);
      mkdirSync(cwd);
      const h = await adapter.start({ cwd });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'RUN_TOOL' });
      const req = await tap.waitFor((e) => e.t === 'approval.request', 60_000);
      if (req.event.t !== 'approval.request') throw new Error('no approval request');
      expect(req.event.options).toEqual(['allow_once', 'allow_always', 'reject', 'cancel']);
      await adapter.respond(h, req.event.id, { kind, persist: false });
      const end = await tap.waitFor((e) => e.t === 'status' && e.state !== 'running', 60_000, 1);
      expect(end.event).toMatchObject({ state: 'idle' });
      const result = tap.events.find((e) => e.t === 'tool.result');
      expect(result).toMatchObject({ ok: kind === 'allow_once' });
      expect(existsSync(join(cwd, 'tool-ran.txt'))).toBe(kind === 'allow_once');
      await adapter.close(h);
    }
  });

  it('cancels a turn waiting on a permission: cancelled, not an error', {
    timeout: 120_000,
  }, async () => {
    const cwd = join(root, 'wt-cancel');
    mkdirSync(cwd);
    const h = await adapter.start({ cwd });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'RUN_TOOL' });
    const req = await tap.waitFor((e) => e.t === 'approval.request', 60_000);
    if (req.event.t !== 'approval.request') throw new Error('no approval request');
    await adapter.respond(h, req.event.id, { kind: 'cancel', persist: false });
    const end = await tap.waitFor((e) => e.t === 'status' && e.state !== 'running', 60_000, 1);
    expect(end.event).toMatchObject({ state: 'cancelled' });
    expect(existsSync(join(cwd, 'tool-ran.txt'))).toBe(false);
    // The session takes the next turn.
    const next = await turn(h, tap, 'SAY again');
    expect(next.end).toMatchObject({ state: 'idle' });
    await adapter.close(h);
  });

  it('reports context usage from usage_update', { timeout: 120_000 }, async () => {
    const h = await adapter.start({ cwd: worktree });
    const tap = new EventTap(adapter.events(h));
    const { events } = await turn(h, tap, 'SAY usage');
    expect(events.find((e) => e.t === 'usage' && e.contextMax !== undefined)).toMatchObject({
      contextUsed: 128,
      contextMax: 1048576,
      source: 'reported',
    });
    await adapter.close(h);
  });

  // A canary (#184): `GEMINI_AGENT` declares `mcp: false` because Gemini CLI in an untrusted
  // checkout never starts the MCP servers it is passed. Here the declaration is bypassed and the
  // server is the mock API itself: if Gemini ever contacts it, the declaration needs revisiting.
  it('never contacts the MCP server it is passed in an untrusted checkout, and keeps its token off the command line and off disk', {
    timeout: 120_000,
  }, async () => {
    const token = 'acp-conformance-token-5f1d0c7e9a2b4c6d';
    const cwd = join(root, 'wt-mcp');
    mkdirSync(cwd);
    const stderr: string[] = [];
    const withLog = new AcpAdapter({
      agent: { ...GEMINI_AGENT, capabilities: { ...GEMINI_AGENT.capabilities, mcp: true } },
      executable: [process.execPath, GEMINI],
      killTimeoutMs: 2000,
      stderr: (t) => stderr.push(t),
      baseEnv: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        GEMINI_API_KEY: 'placeholder-not-a-real-key',
        GOOGLE_GEMINI_BASE_URL: api.url,
      },
    });
    const h = await withLog.start({
      cwd,
      mcpServers: [
        {
          name: 'tacet',
          url: `${api.url}/mcp`,
          headers: mcpAuthHeaders(new Secret(token)),
        },
      ],
    });
    const tap = new EventTap(withLog.events(h));
    await withLog.send(h, { text: 'SAY mcp' });
    await tap.waitFor((e) => e.t === 'status' && e.state !== 'running', 60_000, 1);
    await withLog.close(h);
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        const st = statSync(p, { throwIfNoEntry: false });
        return st?.isDirectory() ? files(p) : st?.isFile() ? [p] : [];
      });
    for (const f of files(root)) expect(readFileSync(f, 'utf8'), f).not.toContain(token);
    expect(JSON.stringify(tap.events)).not.toContain(token);
    expect(stderr.join('')).not.toContain(token);
    expect(api.otherPaths.filter((p) => p.startsWith('/mcp'))).toEqual([]);

    // Control: the same turn in a checkout listed in the Worker home's `trustedFolders.json`
    // does contact the server, so the empty list above is the trust gate, not a slow start.
    const trusted = join(root, 'wt-mcp-trusted');
    mkdirSync(trusted);
    const control = new AcpAdapter({
      agent: {
        ...GEMINI_AGENT,
        capabilities: { ...GEMINI_AGENT.capabilities, mcp: true },
        home: {
          env: GEMINI_AGENT.home?.env ?? 'GEMINI_CLI_HOME',
          files: {
            ...GEMINI_AGENT.home?.files,
            '.gemini/trustedFolders.json': JSON.stringify({ [trusted]: 'TRUST_FOLDER' }),
          },
        },
      },
      executable: [process.execPath, GEMINI],
      killTimeoutMs: 2000,
      baseEnv: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        GEMINI_API_KEY: 'placeholder-not-a-real-key',
        GOOGLE_GEMINI_BASE_URL: api.url,
      },
    });
    const c = await control.start({
      cwd: trusted,
      mcpServers: [{ name: 'tacet', url: `${api.url}/mcp`, headers: {} }],
    });
    const ctap = new EventTap(control.events(c));
    await control.send(c, { text: 'SAY mcp' });
    await ctap.waitFor((e) => e.t === 'status' && e.state !== 'running', 60_000, 1);
    await control.close(c);
    expect(api.otherPaths.filter((p) => p.startsWith('/mcp')).length).toBeGreaterThan(0);
  });
});
