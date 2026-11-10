import { randomUUID } from 'node:crypto';
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
import { PtyAdapter, promptText } from './adapter.js';
import type { Pty, PtySpawnOptions } from './pty.js';

const KEY = 'sk-ant-placeholder-not-a-real-key-0123456789';
const unpaste = (data: string) => data.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');

/**
 * A scripted stand-in for interactive Claude Code: it reads the hook settings it was launched
 * with and POSTs the hooks Claude Code would, with a `prompt_id` per turn. A pasted prompt plus
 * Enter is a turn whose reply is the text. `HANG` never ends; `FAKE_MODE=NO_START` never reports
 * ready, `EXIT_EARLY` exits at once, `NO_ACK` ignores prompts; `CRASH` exits mid-turn.
 */
class FakeClaude implements Pty {
  readonly pid = 2 ** 22 + Math.floor(Math.random() * 1000);
  typed = '';
  writes: string[] = [];
  promptId: string | undefined;
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
    if (opts.env.FAKE_MODE === 'EXIT_EARLY') setTimeout(() => this.exit(1), 10);
    else if (opts.env.FAKE_MODE !== 'NO_START') void this.hook('SessionStart').catch(() => {});
  }
  hook(event: string, extra: object = {}, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.url}/${event}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: event,
        session_id: this.sessionId,
        prompt_id: this.promptId,
        ...extra,
      }),
      ...(signal ? { signal } : {}),
    });
  }
  async json(event: string, extra: object = {}): Promise<unknown> {
    return (await this.hook(event, extra)).json();
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
    // Esc is a key: it ends the turn, it is not typed.
    if (data === '\x1b') return;
    if (data !== '\r') {
      this.typed += unpaste(data);
      return;
    }
    const text = this.typed;
    this.typed = '';
    if (this.opts.env.FAKE_MODE === 'NO_ACK') return;
    void (async () => {
      this.promptId = randomUUID();
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

describe('promptText', () => {
  it('keeps text, newlines and tabs, and drops control characters', () => {
    expect(promptText('fix\tthe\nbug')).toBe('fix\tthe\nbug');
    expect(promptText('a\x1b[201~b\x03c\x04d\x7fe\r\nf')).toBe('a[201~bcde\nf');
  });
  it('refuses prompts Claude Code would run as a command', () => {
    for (const t of ['/login', '!rm -rf .', '  !x', '​/status', '\n\n/x', '', ' \n ']) {
      expect(() => promptText(t), JSON.stringify(t)).toThrow();
    }
    expect(promptText('# notes')).toBe('# notes');
    expect(promptText('see /etc/hosts')).toBe('see /etc/hosts');
  });
});

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
  const fake = () => fakes.at(-1) as FakeClaude;
  const states = (tap: EventTap) => tap.events.flatMap((e) => (e.t === 'status' ? [e.state] : []));
  const texts = (tap: EventTap) =>
    tap.events.flatMap((e) => (e.t === 'message.delta' ? [e.text] : []));

  it('launches with Tacet-only settings, manual permissions and an isolated config dir', async () => {
    const dropped: string[][] = [];
    const adapter = make(
      { OPENAI_API_KEY: 'other-vendor' },
      { onEnvDropped: (n: string[]) => dropped.push(n) },
    );
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const f = fake();
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

  it('refuses what it cannot do safely', async () => {
    const cwd = join(root, 'wt');
    await expect(make({ ANTHROPIC_API_KEY: '' }).start({ cwd })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
    // A key short enough that approving it would store all of it.
    await expect(make({ ANTHROPIC_API_KEY: 'short-key-0123' }).start({ cwd })).rejects.toThrow(
      /too short/,
    );
    const ok = make();
    await expect(ok.start({ cwd, effort: 'high' })).rejects.toThrow(ProfileRefusedError);
    const id = randomUUID();
    await expect(ok.start({ cwd, resume: { vendorSessionId: id, fork: true } })).rejects.toThrow(
      /fork/,
    );
    await expect(ok.start({ cwd, resume: { vendorSessionId: '../../x' } })).rejects.toThrow(/UUID/);
    await expect(ok.start({ cwd, resume: { vendorSessionId: id } })).rejects.toThrow(
      /no PTY session/,
    );
    expect(fakes).toHaveLength(0);
    const h = await ok.start({ cwd });
    await expect(ok.send(h, { text: '!rm -rf .' })).rejects.toThrow(/must not start/);
    await ok.close(h);
  });

  it('accepts hooks only with the session token, never with an Origin', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const f = fake();
    const post = (headers: Record<string, string>, body = '{"hook_event_name":"Stop"}') =>
      fetch(`${f.url}/Stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    const auth = { authorization: `Bearer ${f.token}` };
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post({ ...auth, origin: 'http://127.0.0.1' })).status).toBe(403);
    // Too large: refused (413), or the connection is cut while the body is still being sent.
    const big = await post(auth, 'x'.repeat(2 * 1024 * 1024)).catch(() => undefined);
    expect(big?.status ?? 413).toBe(413);
    expect((await post(auth, 'not json')).status).toBe(400);
    // A body naming another session does nothing to this one.
    const tap = new EventTap(adapter.events(h));
    await f.hook('UserPromptSubmit', { session_id: 'someone-else' });
    expect(adapter.status(h)).toBe('idle');
    expect(states(tap)).toEqual(['idle']);
    await adapter.close(h);
  });

  it('types every prompt as one paste, and queues input sent meanwhile', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'one' });
    await adapter.send(h, { text: 'two\nlines' });
    await tap.waitFor((e) => e.t === 'message.delta' && e.text.includes('two'), 5000);
    expect(texts(tap)).toEqual(['reply: one', 'reply: two\nlines']);
    expect(fake().writes).toContain('\x1b[200~one\x1b[201~');
    expect(fake().writes).toContain('\x1b[200~two\nlines\x1b[201~');
    await adapter.close(h);
  });

  it('sends each reply as one delta, scrubbed of the session secrets', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    // Ends with the start of the hook token: a streaming scrubber would hold that back and split.
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.promptId).toBeDefined();
    await f.hook('Stop', {
      last_assistant_message: `token ${f.token} then ${f.token.slice(0, 5)}`,
    });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    expect(texts(tap)).toEqual([`token [redacted] then ${f.token.slice(0, 5)}`]);
    await adapter.close(h);
  });

  it('drops hooks of an interrupted turn that arrive late', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.promptId).toBeDefined();
    const hung = f.promptId;
    await adapter.interrupt(h);
    expect(f.writes.at(-1)).toBe('\x1b');
    expect(adapter.status(h)).toBe('cancelled');
    // Input sent right after is queued until the first is typed, never interleaved.
    const first = adapter.send(h, { text: 'next' });
    await adapter.send(h, { text: 'after' });
    await first;
    await tap.waitFor((e) => e.t === 'message.delta' && e.text === 'reply: after', 5000);
    // The interrupted turn's Stop, arriving now, changes nothing.
    await f.hook('Stop', { prompt_id: hung, last_assistant_message: 'stale' });
    expect(texts(tap)).toEqual(['reply: next', 'reply: after']);
    expect(states(tap)).toEqual([
      'idle',
      'running',
      'cancelled',
      'running',
      'idle',
      'running',
      'idle',
    ]);
    await adapter.close(h);
  });

  it('reports a prompt the terminal never took as waiting', async () => {
    const adapter = make({ FAKE_MODE: 'NO_ACK' }, { ackTimeoutMs: 200 });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'hello' });
    const w = await tap.waitFor((e) => e.t === 'status' && e.state === 'waiting_input', 5000);
    expect(w.event).toMatchObject({ message: expect.stringContaining('not taken') });
    await adapter.close(h);
  });

  it('matches approvals to their tool call, and reports each result once', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.promptId).toBeDefined();
    const a = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    const b = { tool_name: 'Bash', tool_input: { command: 'rm x', description: 'remove' } };
    expect(await f.json('PreToolUse', { ...a, tool_use_id: 'tu-a' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask' },
    });
    await f.hook('PreToolUse', { ...b, tool_use_id: 'tu-b' });
    // A Tacet tool is left to Claude Code's own flow.
    const tacet = { tool_name: 'mcp__tacet__escalate', tool_input: {}, tool_use_id: 'tu-t' };
    expect(await f.json('PreToolUse', tacet)).toEqual({});
    // Same input with its keys in another order: still tool b.
    const perm = f.json('PermissionRequest', {
      tool_name: 'Bash',
      tool_input: { description: 'remove', command: 'rm x' },
    });
    const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
    if (req.event.t !== 'approval.request') throw new Error('no request');
    expect(adapter.status(h)).toBe('waiting_input');
    await adapter.respond(h, req.event.id, { kind: 'reject', persist: false });
    expect(await perm).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    await f.hook('PostToolUseFailure', { tool_use_id: 'tu-b' });
    await f.hook('PostToolUse', { tool_use_id: 'tu-a' });
    await expect
      .poll(() => tap.events.filter((e) => e.t === 'tool.result'))
      .toEqual([
        { t: 'tool.result', id: 'tu-b', ok: false },
        { t: 'tool.result', id: 'tu-a', ok: true },
      ]);
    await adapter.close(h);
  });

  it('cancels with a denial that interrupts; after a hook timeout, waits on the terminal', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.promptId).toBeDefined();
    const perm = f.json('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x' } });
    const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
    if (req.event.t !== 'approval.request') throw new Error('no request');
    await adapter.respond(h, req.event.id, { kind: 'cancel', persist: false });
    expect(await perm).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'deny', interrupt: true } },
    });
    expect(adapter.status(h)).toBe('cancelled');
    // No Esc: the denial itself stops the turn.
    expect(f.writes).not.toContain('\x1b');

    // A permission whose hook Claude Code stops waiting for: its own dialog is up.
    const before = f.promptId;
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.promptId).not.toBe(before);
    const abort = new AbortController();
    const held = f
      .hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'y' } }, abort.signal)
      .catch(() => undefined);
    const firstId = req.event.id;
    await tap.waitFor((e) => e.t === 'approval.request' && e.id !== firstId, 5000);
    abort.abort();
    await held;
    const w = await tap.waitFor(
      (e) => e.t === 'status' && e.state === 'waiting_input' && e.message !== undefined,
      5000,
    );
    expect(w.event).toMatchObject({ message: expect.stringContaining('terminal') });
    await adapter.close(h);
  });

  it('ends a failed turn idle with a message, and answers a pending approval on close', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.promptId).toBeDefined();
    await f.hook('StopFailure');
    const end = await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    expect(end.event).toMatchObject({ message: 'the turn failed' });
    const before = f.promptId;
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.promptId).not.toBe(before);
    const perm = f.json('PermissionRequest', { tool_name: 'Bash', tool_input: {} });
    await tap.waitFor((e) => e.t === 'approval.request', 5000);
    await adapter.close(h);
    expect(await perm).toEqual({});
    expect(adapter.status(h)).toBe('done');
  });

  it('reports a start that fails, and leaves no files', async () => {
    for (const mode of ['NO_START', 'EXIT_EARLY']) {
      await expect(make({ FAKE_MODE: mode }).start({ cwd: join(root, 'wt') })).rejects.toThrow(
        mode === 'NO_START' ? /did not report ready/ : /exited during start/,
      );
    }
    const left = existsSync(join(root, 'run'))
      ? readdirSync(join(root, 'run'), { recursive: true }).filter((f) =>
          String(f).endsWith('.json'),
        )
      : [];
    expect(left).toEqual([]);
  });

  it('reports a crash as an error, once', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'CRASH' });
    await tap.done;
    expect(states(tap)).toEqual(['idle', 'running', 'error']);
    await expect(adapter.send(h, { text: 'again' })).rejects.toThrow(/has ended/);
    await adapter.close(h);
    expect(adapter.status(h)).toBe('done');
  });
});
