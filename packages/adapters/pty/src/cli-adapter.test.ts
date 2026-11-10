import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForkRefusedError, type SessionHandle } from '@tacet/core';
import { assertConformance, EventTap, formatResults, runConformance } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PTY_LAST_SESSION, PtyCliAdapter, stripEcho } from './cli-adapter.js';
import { loadPty, type Pty, type PtySpawnOptions } from './pty.js';
import { gatedTitle, ptyGate } from './testing/pty-gate.js';

// node-pty must load in CI; locally a machine that could not build it skips these (#189).
const gate = await ptyGate();

const FAKE = join(import.meta.dirname, 'testing', 'fake-cli.mjs');

/** A generic, line-based CLI in a real PTY (#15), configured like an `agents.<slug>` preset. */
describe.skipIf(!gate.ok)(
  gatedTitle('PtyCliAdapter (a line-based CLI in a real PTY)', gate),
  () => {
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
    const withEnv = (env: Record<string, string>, secrets?: string[]) =>
      make({
        preset: {
          command: [process.execPath, FAKE],
          env,
          readyPrompt: 'fake>',
          ...(secrets ? { secrets } : {}),
        },
      });

    beforeAll(async () => {
      await loadPty();
      root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-pty-cli-')));
      adapter = make();
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const reply = (events: { t: string; text?: string }[]) =>
      events.map((e) => (e.t === 'message.delta' ? e.text : '')).join('');

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
      expect(names).toEqual(
        expect.arrayContaining(['FAKE_SETTING', 'PATH', 'TACET_WORKER_MARKER']),
      );
      expect(names).not.toContain('OPENAI_API_KEY');
      expect(dropped).toEqual([['OPENAI_API_KEY']]);
      await a.close(h);
    });

    it('resumes the last session in the checkout through the preset resume arguments (#157)', {
      timeout: 60_000,
    }, async () => {
      expect(adapter.capabilities().resume).toBe(false);
      const cwd = realpathSync(mkdtempSync(join(root, 'wt-')));
      const resumable = make({
        preset: {
          command: [process.execPath, FAKE],
          readyPrompt: 'fake>',
          resumeArgs: ['--continue-last'],
        },
      });
      expect(resumable.capabilities().resume).toBe(true);
      const first = await resumable.start({ cwd });
      expect(first.vendorSessionId).toBe(PTY_LAST_SESSION);
      const tap1 = new EventTap(resumable.events(first));
      await turn(resumable, first, tap1, 'REMEMBER blue');
      await resumable.close(first);

      // A new session starts empty; a resumed one continues the last one in that checkout.
      const fresh = await resumable.start({ cwd });
      const tap2 = new EventTap(resumable.events(fresh));
      expect(reply((await turn(resumable, fresh, tap2, 'RECALL')).events)).toContain('(nothing)');
      await resumable.close(fresh);
      const resumed = await resumable.start({
        cwd,
        resume: { vendorSessionId: PTY_LAST_SESSION },
      });
      const tap3 = new EventTap(resumable.events(resumed));
      expect(reply((await turn(resumable, resumed, tap3, 'RECALL')).events)).toContain(
        'recalled: blue',
      );
      await expect(
        resumable.start({ cwd, resume: { vendorSessionId: PTY_LAST_SESSION, fork: true } }),
      ).rejects.toThrow(ForkRefusedError);
      await resumable.close(resumed);

      // Resumed with nothing saved (the marker is set before the CLI saves anything): this fake
      // CLI says so and starts empty; what a real CLI does then is its own (capability matrix).
      const empty = realpathSync(mkdtempSync(join(root, 'wt-')));
      const none = await resumable.start({
        cwd: empty,
        resume: { vendorSessionId: PTY_LAST_SESSION },
      });
      const tap4 = new EventTap(resumable.events(none));
      expect(reply((await turn(resumable, none, tap4, 'RECALL')).events)).toContain('(nothing)');
      await resumable.close(none);
    });

    it('types every @ as \\@ for a preset that asks for it (#245)', {
      timeout: 60_000,
    }, async () => {
      const escaping = make({
        preset: { command: [process.execPath, FAKE], readyPrompt: 'fake>', escapeAt: true },
      });
      const h = await escaping.start({ cwd: root });
      const tap = new EventTap(escaping.events(h));
      const { events } = await turn(escaping, h, tap, 'see @/etc/hosts and a@b.c');
      expect(reply(events)).toContain('echo: . see \\@/etc/hosts and a\\@b.c .');
      // Text that already has backslashes before an `@` cannot undo the escape: every `@` typed
      // still has a backslash right before it, which Gemini 0.67.0 reads as a literal at sign
      // however many come before it (verified live with one, two and three).
      const tricky = 'a \\@x b \\\\@y c \\ @z d @@w';
      const typed = reply((await turn(escaping, h, tap, tricky)).events);
      expect(typed).toContain(`echo: . ${tricky.replaceAll('@', '\\@')} .`);
      // A prompt made only of paths starts and ends with a segment that is never a file.
      expect(reply((await turn(escaping, h, tap, "'./a.txt")).events)).toContain(
        "echo: . './a.txt .",
      );
      expect(/(^|[^\\])@/.test(typed)).toBe(false);
      await escaping.close(h);
      // Without it, the text is typed as given.
      const h2 = await adapter.start({ cwd: root });
      const tap2 = new EventTap(adapter.events(h2));
      expect(reply((await turn(adapter, h2, tap2, 'see @x')).events)).toContain('echo: see @x');
      await adapter.close(h2);
    });

    it('refuses what a generic CLI cannot do, and reports a crash once', {
      timeout: 60_000,
    }, async () => {
      await expect(
        adapter.start({
          cwd: root,
          mcpServers: [{ name: 'tacet', url: 'http://127.0.0.1:1/mcp' }],
        }),
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

    it('after an interrupt, holds input until the CLI shows its prompt again', {
      timeout: 60_000,
    }, async () => {
      const a = withEnv({ FAKE_SLOW_CANCEL: '1' });
      const h = await a.start({ cwd: root });
      const tap = new EventTap(a.events(h));
      await a.send(h, { text: 'SLOW' });
      await tap.waitFor((e) => e.t === 'status' && e.state === 'running', 5000);
      await new Promise((r) => setTimeout(r, 700));
      await a.interrupt(h);
      expect(a.status(h)).toBe('cancelled');
      // Sent while the CLI is still busy cancelling: typed only once its prompt is back.
      await a.send(h, { text: 'after' });
      await tap.waitFor((e) => e.t === 'message.delta' && e.text.includes('after'), 30_000);
      const deltas = tap.events.flatMap((e) => (e.t === 'message.delta' ? [e.text] : []));
      expect(deltas).toEqual(['echo: after']);
      await a.close(h);
    });

    it("scrubs the preset's secret values from events", { timeout: 60_000 }, async () => {
      for (const [env, secrets] of [
        // Listed, and a shorter listed secret that starts it: the whole value goes.
        [{ FAKE_SECRET: 'plain-value-1234' }, ['plain', 'plain-value-1234']],
        // Not listed: the variable's name says it is one.
        [{ FAKE_SECRET: 'plain-value-1234' }, undefined],
      ] as const) {
        const a = withEnv({ ...env }, secrets ? [...secrets] : undefined);
        const h = await a.start({ cwd: root });
        const tap = new EventTap(a.events(h));
        const { events } = await turn(a, h, tap, 'PRINT_SECRET');
        expect(events.find((e) => e.t === 'message.delta')).toEqual({
          t: 'message.delta',
          text: 'value: [redacted]',
        });
        await a.close(h);
      }
    });
  },
);

/** A scripted terminal: what the CLI prints is up to the test. */
class ScriptedPty implements Pty {
  readonly pid = 2 ** 22 + Math.floor(Math.random() * 1000);
  writes: string[] = [];
  onWrite: (data: string) => void = () => {};
  #data: ((d: string) => void)[] = [];
  #exit: ((e: { exitCode: number }) => void)[] = [];
  constructor(readonly opts: PtySpawnOptions) {}
  print(d: string) {
    for (const l of this.#data) l(d);
  }
  onData(l: (d: string) => void) {
    this.#data.push(l);
    return { dispose() {} };
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.#exit.push(l);
    return { dispose() {} };
  }
  write(d: string) {
    this.writes.push(d);
    this.onWrite(d);
  }
  resize() {}
  kill() {
    this.exit(0);
  }
  exit(code: number) {
    for (const l of this.#exit) l({ exitCode: code });
    this.#exit = [];
  }
}

describe('PtyCliAdapter (scripted terminal)', () => {
  const root = realpathSync(tmpdir());
  function make(extra: object = {}, readyPrompt: string | null = '>') {
    let pty: ScriptedPty | undefined;
    const adapter = new PtyCliAdapter({
      slug: 'scripted',
      preset: { command: ['scripted'], ...(readyPrompt ? { readyPrompt } : {}) },
      quietMs: 50,
      killTimeoutMs: 100,
      baseEnv: {},
      spawn: (_f, _a, opts) => {
        pty = new ScriptedPty(opts);
        return pty;
      },
      ...extra,
    });
    return { adapter, pty: () => pty as ScriptedPty };
  }
  const later = (fn: () => void, ms = 10) => setTimeout(fn, ms);

  it('finds a coloured prompt split across chunks', async () => {
    const { adapter, pty } = make();
    const started = adapter.start({ cwd: root });
    later(() => {
      pty().print('\x1b[32m> \x1b[');
      pty().print('0m');
    });
    const h = await started;
    const tap = new EventTap(adapter.events(h));
    pty().onWrite = (d) =>
      later(() => {
        pty().print(`${d.replace(/\r$/, '')}\r\n`);
        pty().print('answer\r\n\x1b[32m> \x1b');
        pty().print('[0m');
      });
    await adapter.send(h, { text: 'question' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    expect(tap.events.filter((e) => e.t === 'message.delta')).toEqual([
      { t: 'message.delta', text: 'answer' },
    ]);
    await adapter.close(h);
  });

  it('ends a turn only when the whole last line is the prompt', async () => {
    const { adapter, pty } = make();
    const started = adapter.start({ cwd: root });
    later(() => pty().print('> '));
    const h = await started;
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    pty().print('a -> b\r\n<div>');
    await new Promise((r) => setTimeout(r, 200));
    expect(adapter.status(h)).toBe('running');
    pty().print('\r\n> ');
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    await adapter.close(h);
  });

  it('pastes several lines when the CLI turned on bracketed paste, and types tabs as spaces otherwise', async () => {
    const { adapter, pty } = make();
    const started = adapter.start({ cwd: root });
    later(() => pty().print('\x1b[?2004h> '));
    const h = await started;
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'a\nb' });
    expect(pty().writes.at(-1)).toBe('\x1b[200~a\nb\x1b[201~\r');
    pty().print('\x1b[?2004l\r\n> ');
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    await adapter.send(h, { text: 'x\ty\nz' });
    expect(pty().writes.at(-1)).toBe('x y z\r');
    await adapter.close(h);
  });

  it('ends a turn on quiet output when no prompt is set', async () => {
    const { adapter, pty } = make({}, null);
    const started = adapter.start({ cwd: root });
    later(() => pty().print('ready'));
    const h = await started;
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    pty().print('go\r\ndone');
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    expect(tap.events.filter((e) => e.t === 'message.delta')).toEqual([
      { t: 'message.delta', text: 'done' },
    ]);
    await adapter.close(h);
  });

  it('reports a turn with no prompt for a long time as waiting, and running again on output', async () => {
    const { adapter, pty } = make({ stallMs: 150 });
    const started = adapter.start({ cwd: root });
    later(() => pty().print('> '));
    const h = await started;
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    pty().print('Overwrite? [y/N] ');
    const w = await tap.waitFor((e) => e.t === 'status' && e.state === 'waiting_input', 5000);
    expect(w.event).toMatchObject({ message: expect.stringContaining('typed as the answer') });
    // The next input is the answer, typed at once although the turn has not ended.
    await adapter.send(h, { text: 'y' });
    expect(pty().writes.at(-1)).toBe('y\r');
    await tap.waitFor((e) => e.t === 'status' && e.state === 'running', 5000, w.index + 1);
    pty().print('y\r\ndone\r\n');
    pty().print('> ');
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, w.index + 1);
    await adapter.close(h);
  });

  it('reports a CLI that never shows its prompt after an interrupt, and what it did not type', async () => {
    const { adapter, pty } = make({ settleTimeoutMs: 200 });
    const started = adapter.start({ cwd: root });
    later(() => pty().print('> '));
    const h = await started;
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    await adapter.interrupt(h);
    expect(pty().writes.at(-1)).toBe('\x03');
    await adapter.send(h, { text: 'next' });
    const w = await tap.waitFor((e) => e.t === 'status' && e.state === 'waiting_input', 5000);
    expect(w.event).toMatchObject({ message: expect.stringMatching(/1 input\(s\).*not typed/) });
    expect(pty().writes.filter((d) => d.startsWith('next'))).toEqual([]);
    await adapter.close(h);
  });

  it('fails a start that times out or exits, and refuses effort and context size', async () => {
    const quiet = make({ startTimeoutMs: 200 });
    await expect(quiet.adapter.start({ cwd: root })).rejects.toThrow(/did not become ready/);
    const early = make();
    const started = early.adapter.start({ cwd: root });
    later(() => early.pty().exit(2));
    await expect(started).rejects.toThrow(/exited during start \(code 2\)/);
    const { adapter } = make();
    await expect(adapter.start({ cwd: root, effort: 'high' })).rejects.toThrow(/effort/);
    await expect(adapter.start({ cwd: root, contextWindow: 1000 })).rejects.toThrow(/context/);
  });
});

describe('stripEcho', () => {
  it('removes the echo, also when it is wrapped or follows a redraw', () => {
    expect(stripEcho('hello\nreply', 'hello')).toBe('\nreply');
    expect(stripEcho('> hel \nlo\nreply', 'hello')).toBe('\nreply');
    expect(stripEcho('reply only', 'hello')).toBe('reply only');
  });
});
