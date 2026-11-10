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
import { fileURLToPath } from 'node:url';
import { type MockMessagesApi, startMockMessagesApi } from '@tacet/adapter-claude-sdk/testing';
import type { SessionHandle } from '@tacet/core';
import { mcpAuthHeaders, Secret } from '@tacet/core/node';
import { assertConformance, EventTap, formatResults, runConformance } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PtyAdapter } from './adapter.js';
import { loadPty } from './pty.js';

/** The Claude Code binary the pinned Agent SDK bundles for this platform. */
function claudeBinary(): string {
  const sdk = dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
  const req = createRequire(join(sdk, 'package.json'));
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  return join(dirname(req.resolve(`${pkg}/package.json`)), 'claude');
}

/**
 * Runs the real, interactive Claude Code binary in a PTY against a local mock of the Messages
 * API (#15): no credentials, no network. State comes from Claude Code's hooks.
 */
describe('PtyAdapter conformance (interactive Claude Code in a PTY, mock Messages API)', () => {
  let api: MockMessagesApi;
  let root: string;
  let adapter: PtyAdapter;
  let worktree: string;

  beforeAll(async () => {
    // node-pty must really load here: a PTY test that quietly skipped would prove nothing.
    await loadPty();
    api = await startMockMessagesApi();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-pty-')));
    worktree = join(root, 'worktree');
    mkdirSync(worktree);
    mkdirSync(join(root, 'home'));
    adapter = new PtyAdapter({
      command: [claudeBinary()],
      killTimeoutMs: 2000,
      stateDir: join(root, 'state'),
      sessionFileDir: join(root, 'run', 'mcp'),
      // Only what the binary needs; never the developer's own environment or credentials.
      baseEnv: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'sk-ant-placeholder-not-a-real-key-0123456789',
        DISABLE_AUTOUPDATER: '1',
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
      (e) => e.t === 'status' && e.state !== 'running' && e.state !== 'waiting_input',
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
      timeoutMs: 60_000,
    });
    console.log(formatResults(results));
    assertConformance(results);
  });

  it('reports running, waiting and idle from the hooks', { timeout: 120_000 }, async () => {
    const cwd = join(root, 'wt-status');
    mkdirSync(cwd);
    const h = await adapter.start({ cwd });
    const tap = new EventTap(adapter.events(h));
    expect(adapter.status(h)).toBe('idle');
    await adapter.send(h, { text: 'RUN_TOOL' });
    const req = await tap.waitFor((e) => e.t === 'approval.request', 60_000);
    expect(adapter.status(h)).toBe('waiting_input');
    if (req.event.t !== 'approval.request') throw new Error('no approval request');
    expect(req.event).toMatchObject({ toolName: 'Bash' });
    await adapter.respond(h, req.event.id, { kind: 'allow_once', persist: false });
    const end = await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, req.index);
    const states = tap.events
      .slice(0, end.index + 1)
      .flatMap((e) => (e.t === 'status' ? [e.state] : []));
    expect(states).toEqual(['idle', 'running', 'waiting_input', 'running', 'idle']);
    expect(tap.events.map((e) => e.t)).toEqual(
      expect.arrayContaining(['tool.call', 'tool.result', 'message.delta']),
    );
    expect(existsSync(join(cwd, 'tool-ran.txt'))).toBe(true);
    // The next turn starts from idle again.
    const next = await turn(h, tap, 'SAY again');
    expect(next.end).toMatchObject({ state: 'idle' });
    expect(next.events.find((e) => e.t === 'message.delta')).toMatchObject({
      text: expect.stringContaining('You said again'),
    });
    await adapter.close(h);
  });

  it('sends a prompt of several lines as one message', { timeout: 120_000 }, async () => {
    const h = await adapter.start({ cwd: worktree });
    const tap = new EventTap(adapter.events(h));
    const before = api.requests.length;
    const { end, events } = await turn(h, tap, 'SAY multi\nsecond line');
    expect(end).toMatchObject({ state: 'idle' });
    const sent = api.requests.slice(before).map((r) => r.text);
    expect(sent.some((t) => t.includes('SAY multi\nsecond line'))).toBe(true);
    // One turn, one reply.
    expect(events.filter((e) => e.t === 'status' && e.state === 'running')).toHaveLength(1);
    await adapter.close(h);
  });

  it('resumes a session by id', { timeout: 120_000 }, async () => {
    const h = await adapter.start({ cwd: worktree });
    const tap = new EventTap(adapter.events(h));
    await turn(h, tap, 'SAY first');
    await adapter.close(h);
    const vendor = h.vendorSessionId as string;
    const before = api.requests.length;
    const again = await adapter.start({ cwd: worktree, resume: { vendorSessionId: vendor } });
    expect(again.vendorSessionId).toBe(vendor);
    const tap2 = new EventTap(adapter.events(again));
    await turn(again, tap2, 'SAY second');
    // The resumed conversation carries the first turn.
    expect(api.requests.slice(before).some((r) => r.messages > 1)).toBe(true);
    await adapter.close(again);
  });

  it('keeps hook and MCP tokens in 0600 files outside the worktree, gone after close', {
    timeout: 120_000,
  }, async () => {
    const cwd = join(root, 'wt-files');
    mkdirSync(cwd);
    const token = 'worker-mcp-token-0123456789abcdef';
    const h = await adapter.start({
      cwd,
      mcpServers: [
        {
          name: 'tacet',
          url: 'http://127.0.0.1:9/mcp',
          headers: mcpAuthHeaders(new Secret(token)),
        },
      ],
    });
    const runDir = join(root, 'run', 'mcp');
    const files = readdirSync(runDir, { recursive: true, withFileTypes: true }).filter((d) =>
      d.isFile(),
    );
    expect(files.map((f) => f.name).sort()).toEqual(
      [`${h.id}.hook.json`, `${h.id}.json`, `${h.id}.settings.json`].sort(),
    );
    for (const f of files) expect(statSync(join(f.parentPath, f.name)).mode & 0o777).toBe(0o600);
    const tap = new EventTap(adapter.events(h));
    await turn(h, tap, 'SAY files');
    await adapter.close(h);
    expect(
      readdirSync(runDir, { recursive: true }).filter((f) => String(f).endsWith('.json')),
    ).toEqual([]);
    // Nothing in the worktree, and the token is in no event.
    expect(readdirSync(cwd)).toEqual([]);
    expect(JSON.stringify(tap.events)).not.toContain(token);
    for (const f of readdirSync(join(root, 'state'), { recursive: true, withFileTypes: true })) {
      if (f.isFile() && f.name === '.claude.json') {
        expect(readFileSync(join(f.parentPath, f.name), 'utf8')).not.toContain(token);
      }
    }
  });
});
