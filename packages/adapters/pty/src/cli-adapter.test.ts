import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionHandle } from '@tacet/core';
import { assertConformance, EventTap, formatResults, runConformance } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PtyCliAdapter } from './cli-adapter.js';
import { loadPty } from './pty.js';

const FAKE = join(import.meta.dirname, 'testing', 'fake-cli.mjs');

/** A generic, line-based CLI in a real PTY (#15), configured like an `agents.<slug>` preset. */
describe('PtyCliAdapter (a line-based CLI in a real PTY)', () => {
  let root: string;
  let adapter: PtyCliAdapter;
  const make = (extra: object = {}) =>
    new PtyCliAdapter({
      slug: 'fake',
      preset: {
        command: [process.execPath, FAKE],
        env: { FAKE_SETTING: 'on' },
        readyPrompt: 'fake>',
      },
      quietMs: 300,
      killTimeoutMs: 1000,
      baseEnv: {
        PATH: process.env.PATH,
        HOME: root,
        OPENAI_API_KEY: 'sk-other-vendor',
      },
      ...extra,
    });

  beforeAll(async () => {
    await loadPty();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-pty-cli-')));
    adapter = make();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function turn(a: PtyCliAdapter, h: SessionHandle, tap: EventTap, text: string) {
    const from = tap.events.length;
    await a.send(h, { text });
    const end = await tap.waitFor(
      (e) => e.t === 'status' && e.state !== 'running',
      30_000,
      from + 1,
    );
    return { end: end.event, events: tap.events.slice(from, end.index + 1) };
  }

  it('passes the P0 probes', { timeout: 120_000 }, async () => {
    const results = await runConformance(adapter, {
      session: { cwd: root },
      replyPrompt: 'hello',
      approvalPrompt: 'unused: approvals=none',
      slowPrompt: 'SLOW',
      timeoutMs: 30_000,
    });
    console.log(formatResults(results));
    assertConformance(results);
  });

  it("ends a turn when the prompt comes back, with that turn's output as the reply", {
    timeout: 60_000,
  }, async () => {
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    const { end, events } = await turn(adapter, h, tap, 'first');
    expect(end).toMatchObject({ state: 'idle' });
    expect(events.filter((e) => e.t === 'message.delta')).toEqual([
      { t: 'message.delta', text: 'echo: first' },
    ]);
    // Input sent during a turn is the next turn; several lines go as one.
    await adapter.send(h, { text: 'SLOW' });
    await adapter.send(h, { text: 'two\nlines' });
    await tap.waitFor((e) => e.t === 'message.delta' && e.text.includes('two'), 30_000);
    expect(tap.events.filter((e) => e.t === 'message.delta').at(-1)).toEqual({
      t: 'message.delta',
      text: 'echo: two lines',
    });
    await adapter.close(h);
  });

  it('shows the terminal to a viewer, read-only', { timeout: 60_000 }, async () => {
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    const term = adapter.terminal(h);
    expect(term.scrollback()).toContain('fake>');
    const seen: string[] = [];
    const watching = (async () => {
      for await (const chunk of term.output()) seen.push(chunk);
    })();
    await turn(adapter, h, tap, 'watched');
    await adapter.close(h);
    await watching;
    expect(seen.join('')).toContain('echo: watched');
  });

  it('gives the CLI an allowlist of the environment plus its preset', {
    timeout: 60_000,
  }, async () => {
    const dropped: string[][] = [];
    const a = make({ onEnvDropped: (n: string[]) => dropped.push(n) });
    const h = await a.start({ cwd: root, env: { TACET_WORKER_MARKER: 'm-1' } });
    const tap = new EventTap(a.events(h));
    const { events } = await turn(a, h, tap, 'ENV');
    const text = events.find((e) => e.t === 'message.delta');
    const names = text?.t === 'message.delta' ? text.text.replace('names: ', '').split(',') : [];
    expect(names).toEqual(expect.arrayContaining(['FAKE_SETTING', 'PATH', 'TACET_WORKER_MARKER']));
    expect(names).not.toContain('OPENAI_API_KEY');
    expect(dropped).toEqual([['OPENAI_API_KEY']]);
    await a.close(h);
  });

  it('refuses what a generic CLI cannot do, and reports a crash once', {
    timeout: 60_000,
  }, async () => {
    await expect(
      adapter.start({ cwd: root, mcpServers: [{ name: 'tacet', url: 'http://127.0.0.1:1/mcp' }] }),
    ).rejects.toThrow(/MCP servers/);
    await expect(adapter.start({ cwd: root, model: 'x' })).rejects.toThrow(/model/);
    await expect(adapter.start({ cwd: root, resume: { vendorSessionId: 'x' } })).rejects.toThrow(
      /resume/,
    );
    const h = await adapter.start({ cwd: root });
    await expect(adapter.send(h, { text: '/quit' })).rejects.toThrow(/must not start/);
    const events: { t: string; state?: string }[] = [];
    const done = (async () => {
      for await (const e of adapter.events(h)) events.push(e as { t: string; state?: string });
    })();
    await adapter.send(h, { text: 'EXIT' });
    await done;
    expect(events.filter((e) => e.t === 'status').map((e) => e.state)).toEqual([
      'idle',
      'running',
      'error',
    ]);
    await adapter.close(h);
  });
});
