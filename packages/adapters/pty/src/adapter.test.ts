import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileRefusedError } from '@tacet/core';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyAdapter } from './adapter.js';
import type { Pty, PtySpawnOptions } from './pty.js';

const KEY = 'sk-ant-placeholder-not-a-real-key-0123456789';

/**
 * A scripted stand-in for interactive Claude Code: it reads the hook settings it was launched
 * with and POSTs the hooks Claude Code would. Typed text plus Enter is a turn whose reply is the
 * text; `HANG` never ends; `NO_START` never reports ready; `CRASH` exits.
 */
class FakeClaude implements Pty {
  readonly pid = 2 ** 22 + Math.floor(Math.random() * 1000);
  typed = '';
  writes: string[] = [];
  readonly url: string;
  readonly token: string;
  readonly sessionId: string;
  #exit: ((e: { exitCode: number }) => void)[] = [];
  constructor(
    readonly args: string[],
    readonly opts: PtySpawnOptions,
  ) {
    const settings = JSON.parse(
      readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8'),
    );
    const stop = settings.hooks.Stop[0].hooks[0];
    this.url = String(stop.url).replace(/\/Stop$/, '');
    this.token = String(stop.headers.Authorization).replace('Bearer ', '');
    const i = args.indexOf('--session-id');
    this.sessionId =
      i >= 0 ? (args[i + 1] as string) : (args[args.indexOf('--resume') + 1] as string);
    // A hook after the endpoint closed (the session was closed) is simply lost, as in Claude Code.
    if (opts.env.FAKE_MODE !== 'NO_START') void this.hook('SessionStart', {}).catch(() => {});
  }
  async hook(
    event: string,
    extra: object,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${this.url}/${event}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ hook_event_name: event, session_id: this.sessionId, ...extra }),
    });
  }
  onData() {
    return { dispose() {} };
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.#exit.push(l);
    return { dispose() {} };
  }
  write(data: string) {
    this.writes.push(data);
    if (data !== '\r') {
      this.typed += data;
      return;
    }
    const text = this.typed;
    this.typed = '';
    void (async () => {
      await this.hook('UserPromptSubmit', { prompt: text });
      if (text === 'CRASH') return this.exit(3);
      if (text === 'HANG') return;
      await this.hook('Stop', { last_assistant_message: `reply: ${text}` });
    })().catch(() => {});
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

describe('PtyAdapter (fake claude)', () => {
  let root: string;
  let fakes: FakeClaude[];
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-pty-unit-')));
    mkdirSync(join(root, 'wt'));
    fakes = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (env: Record<string, string> = {}, extra: object = {}) =>
    new PtyAdapter({
      command: ['claude'],
      stateDir: join(root, 'state'),
      sessionFileDir: join(root, 'run'),
      startTimeoutMs: 1000,
      killTimeoutMs: 100,
      baseEnv: { PATH: '/bin', HOME: join(root, 'home'), ANTHROPIC_API_KEY: KEY, ...env },
      envPolicy: { pass: ['FAKE_*'] },
      spawn: (_file, args, opts) => {
        const f = new FakeClaude(args, opts);
        fakes.push(f);
        return f;
      },
      ...extra,
    });

  it('launches with Tacet-only settings, manual permissions and an isolated config dir', async () => {
    const dropped: string[][] = [];
    const adapter = make(
      { OPENAI_API_KEY: 'other-vendor' },
      { onEnvDropped: (n: string[]) => dropped.push(n) },
    );
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const f = fakes[0] as FakeClaude;
    expect(f.args).toEqual(
      expect.arrayContaining([
        '--setting-sources',
        '',
        '--permission-mode',
        'manual',
        '--strict-mcp-config',
      ]),
    );
    expect(f.args[f.args.indexOf('--session-id') + 1]).toBe(h.vendorSessionId);
    expect(f.opts.env.CLAUDE_CONFIG_DIR).toContain(join(root, 'state'));
    expect(f.opts.env.NO_PROXY).toContain('127.0.0.1');
    expect(f.opts.env.OPENAI_API_KEY).toBeUndefined();
    expect(dropped).toEqual([['OPENAI_API_KEY']]);
    const config = JSON.parse(
      readFileSync(join(f.opts.env.CLAUDE_CONFIG_DIR as string, '.claude.json'), 'utf8'),
    );
    expect(config).toMatchObject({
      hasCompletedOnboarding: true,
      projects: { [join(root, 'wt')]: { hasTrustDialogAccepted: true } },
      customApiKeyResponses: { approved: [KEY.slice(-20)] },
    });
    // Never the whole key.
    expect(JSON.stringify(config)).not.toContain(KEY);
    await adapter.close(h);
  });

  it('refuses unattended Workers without an API key, and profiles it cannot honour', async () => {
    const adapter = make({ ANTHROPIC_API_KEY: '' });
    await expect(adapter.start({ cwd: join(root, 'wt') })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    const ok = make();
    await expect(ok.start({ cwd: join(root, 'wt'), effort: 'high' })).rejects.toThrow(
      ProfileRefusedError,
    );
    await expect(
      ok.start({ cwd: join(root, 'wt'), resume: { vendorSessionId: 'nope', fork: true } }),
    ).rejects.toThrow(/fork/);
    await expect(
      ok.start({ cwd: join(root, 'wt'), resume: { vendorSessionId: 'nope' } }),
    ).rejects.toThrow(/no PTY session/);
    expect(fakes).toHaveLength(0);
  });

  it('accepts hooks only with the session token, never with an Origin', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const f = fakes[0] as FakeClaude;
    const post = (headers: Record<string, string>, body = '{"hook_event_name":"Stop"}') =>
      fetch(`${f.url}/Stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect(
      (await post({ authorization: `Bearer ${f.token}`, origin: 'http://127.0.0.1' })).status,
    ).toBe(403);
    expect(
      (await post({ authorization: `Bearer ${f.token}` }, 'x'.repeat(2 * 1024 * 1024))).status,
    ).toBe(413);
    expect((await post({ authorization: `Bearer ${f.token}` }, 'not json')).status).toBe(400);
    // A body naming another session does nothing to this one.
    const tap = new EventTap(adapter.events(h));
    await f.hook('UserPromptSubmit', { session_id: 'someone-else' });
    expect(adapter.status(h)).toBe('idle');
    expect(tap.events.filter((e) => e.t === 'status')).toHaveLength(1);
    await adapter.close(h);
  });

  it('queues input sent during a turn, and types several lines as one paste', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fakes[0] as FakeClaude;
    await adapter.send(h, { text: 'one' });
    await adapter.send(h, { text: 'two\nlines' });
    await tap.waitFor((e) => e.t === 'message.delta' && e.text.includes('two'), 5000);
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, tap.events.length - 1);
    expect(
      tap.events
        .filter((e) => e.t === 'message.delta')
        .map((e) => e.t === 'message.delta' && e.text),
    ).toEqual(['reply: one', 'reply: \x1b[200~two\nlines\x1b[201~']);
    expect(f.writes).toContain('\x1b[200~two\nlines\x1b[201~');
    await adapter.close(h);
  });

  it('reports a start that never becomes ready, and leaves no files', async () => {
    const adapter = make({ FAKE_MODE: 'NO_START' });
    await expect(adapter.start({ cwd: join(root, 'wt') })).rejects.toThrow(/did not report ready/);
    const left = existsSync(join(root, 'run'))
      ? readdirSync(join(root, 'run'), { recursive: true }).filter((f) =>
          String(f).endsWith('.json'),
        )
      : [];
    expect(left).toEqual([]);
  });

  it('reports a crash as an error, once, and cleans up', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'CRASH' });
    await tap.done;
    const states = tap.events.flatMap((e) => (e.t === 'status' ? [e.state] : []));
    expect(states).toEqual(['idle', 'running', 'error']);
    await expect(adapter.send(h, { text: 'again' })).rejects.toThrow(/has ended/);
    await adapter.close(h);
    expect(adapter.status(h)).toBe('done');
  });

  it('interrupts with Esc and reports the turn cancelled itself', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fakes[0] as FakeClaude;
    await adapter.send(h, { text: 'HANG' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'running', 5000);
    await adapter.interrupt(h);
    expect(f.writes.at(-1)).toBe('\x1b');
    expect(adapter.status(h)).toBe('cancelled');
    await adapter.close(h);
  });
});
