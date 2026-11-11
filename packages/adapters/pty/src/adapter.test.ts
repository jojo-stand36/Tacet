import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForkRefusedError, ProfileRefusedError } from '@tacet/core';
import { repoStateDir } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyAdapter, promptText, samePrompt } from './adapter.js';
import type { Pty, PtySpawnOptions } from './pty.js';
import { assistantLine } from './testing/transcript-line.js';

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
  /**
   * The prompt whose `UserPromptSubmit` the adapter has answered. Claude Code waits for that hook
   * before the turn does anything else, so tests wait on this, not on `promptId`, before sending
   * the turn's next hooks: otherwise a late `UserPromptSubmit` can overtake them.
   */
  submitted: string | undefined;
  ctrlD = 0;
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
    // Every hook is a command that relays to Tacet (#164); its 0600 file holds the URL and token.
    const stop = settings.hooks.Stop[0].hooks[0];
    const file = /'([^']*\.hook\.json)'/.exec(String(stop.command))?.[1] as string;
    const { url, token } = JSON.parse(readFileSync(file, 'utf8')) as { url: string; token: string };
    this.url = url;
    this.token = token;
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
  onData(l: (data: string) => void) {
    // Turns on bracketed paste once it reads input, as the real interface does, in two chunks.
    if (this.opts.env.FAKE_MODE !== 'NO_INPUT') {
      setTimeout(() => {
        l('> \x1b[?20');
        l('04h');
      }, 5);
    }
    return { dispose() {} };
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.#exit.push(l);
    return { dispose() {} };
  }
  write(data: string) {
    this.writes.push(data);
    // Esc is a key: it ends the turn, it is not typed. Ctrl-D twice exits.
    if (data === '\x1b') return;
    if (data === '\x04') {
      this.ctrlD++;
      if (this.ctrlD === 2) setTimeout(() => this.exit(0), 5);
      return;
    }
    this.typed += unpaste(data.replace(/\r$/, ''));
    if (!data.endsWith('\r')) return;
    const text = this.typed;
    this.typed = '';
    if (this.opts.env.FAKE_MODE === 'NO_ACK') return;
    void (async () => {
      const id = randomUUID();
      this.promptId = id;
      await this.hook('UserPromptSubmit', { prompt: text });
      this.submitted = id;
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

describe('samePrompt (#190)', () => {
  it('matches the prompt Claude Code reports to what was typed', () => {
    expect(samePrompt('SAY one', 'SAY one')).toBe(true);
    // Observed on 2.1.319: a multi-line paste comes back wrapped, with tabs expanded.
    const wrapped =
      '\n\n<pasted_content id="361d">\nSAY two\n    indented\n\n  end  \n</pasted_content id="361d">\n';
    expect(samePrompt(wrapped, 'SAY two\n\tindented\n\n  end  ')).toBe(true);
    expect(samePrompt(wrapped, 'SAY three\n\tindented')).toBe(false);
    expect(samePrompt(undefined, 'x')).toBe(false);
    expect(samePrompt('SLOW', 'SAY after')).toBe(false);
  });
});

describe('promptText', () => {
  it('keeps text, newlines and tabs, and drops control characters', () => {
    expect(promptText('fix\tthe\nbug')).toBe('fix\tthe\nbug');
    expect(promptText('a\x1b[201~b\x03c\x04d\x7fe\r\nf')).toBe('a[201~bcde\nf');
  });
  it('refuses prompts Claude Code would run as a command', () => {
    for (const t of [
      '/login',
      '!rm -rf .',
      '  !x',
      '\u200b/status',
      '\n\n/x',
      '\u3164/x',
      '\ufe0f/x',
      '\u034f!x',
      '\u2800/x',
      '',
      ' \n ',
    ]) {
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

  /** The session directories under the test's state dir (any repo). */
  const configDirs = (): string[] => {
    const state = join(root, 'state');
    if (!existsSync(state)) return [];
    return readdirSync(state).flatMap((repo) => {
      const dir = join(state, repo, 'claude-pty');
      return existsSync(dir) ? readdirSync(dir) : [];
    });
  };
  const make = (env: Record<string, string> = {}, extra: object = {}) =>
    new PtyAdapter({
      command: ['claude'],
      // Claude Code is replaced: nothing runs commands, so no bubblewrap is needed (#150).
      subprocessScrub: false,
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
    // No `@path` mention is read into a prompt (#226).
    expect(f.opts.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS).toBe('1');
    // Set last: neither the base environment nor a session's own env can turn it off.
    const off = make(
      { CLAUDE_CODE_DISABLE_FILE_MENTIONS: '0' },
      { envPolicy: { pass: ['FAKE_*', 'CLAUDE_CODE_DISABLE_FILE_MENTIONS'] } },
    );
    await off.start({ cwd: join(root, 'wt'), env: { CLAUDE_CODE_DISABLE_FILE_MENTIONS: '0' } });
    expect(fake().opts.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS).toBe('1');
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

  it("strips the Worker's credentials from the commands it runs, or refuses (#150)", async () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(bin, 'socat'), '#!/bin/sh\n', { mode: 0o755 });
    const adapter = make({ PATH: bin }, { subprocessScrub: true });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    expect(fake().opts.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
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
    expect(configDirs()).toEqual([]);
    const ok = make();
    await expect(ok.start({ cwd, effort: 'high' })).rejects.toThrow(ProfileRefusedError);
    const id = randomUUID();
    await expect(ok.start({ cwd, resume: { vendorSessionId: id, fork: true } })).rejects.toThrow(
      ForkRefusedError,
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
    // Paste and Enter in one write.
    expect(fake().writes).toContain('\x1b[200~one\x1b[201~\r');
    expect(fake().writes).toContain('\x1b[200~two\nlines\x1b[201~\r');
    await adapter.close(h);
  });

  it('sends each reply as one delta, scrubbed of the session secrets', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    // Ends with the start of the hook token: a streaming scrubber would hold that back and split.
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.submitted).toBeDefined();
    await f.hook('Stop', {
      last_assistant_message: `token ${f.token} then ${f.token.slice(0, 5)}`,
    });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    expect(texts(tap)).toEqual([`token [redacted] then ${f.token.slice(0, 5)}`]);
    await adapter.close(h);
  });

  it('reports usage from its own transcript, never the one a hook names (#255)', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt'), model: 'claude-opus-4-6[1m]' });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    const configDir = f.opts.env.CLAUDE_CONFIG_DIR as string;
    // A file the Worker could write, named by a hook: never read.
    const decoy = join(root, 'decoy.jsonl');
    writeFileSync(
      decoy,
      assistantLine('d1', { input: 666, output: 666 }, { sessionId: f.sessionId }),
    );
    const usage = () => tap.events.filter((e) => e.t === 'usage');

    // No transcript yet: the turn ends with no usage, whatever the hook says.
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.submitted).toBeDefined();
    await f.hook('Stop', { transcript_path: decoy, last_assistant_message: 'one' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    expect(usage()).toEqual([]);

    const dir = join(configDir, 'projects', '-wt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${f.sessionId}.jsonl`),
      assistantLine(
        'm1',
        { input: 2, created: 300, read: 5000, output: 1 },
        { model: 'claude-opus-4-6', sessionId: f.sessionId },
      ) +
        assistantLine(
          'm1',
          { input: 2, created: 300, read: 5000, output: 80 },
          { model: 'claude-opus-4-6', sessionId: f.sessionId },
        ) +
        assistantLine(
          's1',
          { input: 9, output: 3 },
          { model: 'claude-haiku-4-5', sidechain: true, sessionId: f.sessionId },
        ),
    );
    const from = tap.events.length;
    f.submitted = undefined;
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.submitted).toBeDefined();
    await f.hook('Stop', { transcript_path: decoy, last_assistant_message: 'two' });
    const end = await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, from + 1);
    expect(usage()).toEqual([
      {
        t: 'usage',
        inputTokens: 5302,
        outputTokens: 80,
        contextUsed: 5382,
        // Opus 4.6 has 1M in Claude Code only when launched with [1m].
        contextMax: 1_000_000,
        model: 'claude-opus-4-6',
        source: 'reported',
      },
      // A subagent's call is counted; it is not the conversation's context.
      {
        t: 'usage',
        inputTokens: 9,
        outputTokens: 3,
        model: 'claude-haiku-4-5',
        source: 'reported',
      },
    ]);
    // Reported before the turn's end.
    expect(tap.events.findIndex((e) => e.t === 'usage')).toBeLessThan(end.index);
    await adapter.close(h);
  });

  it('drops hooks of an interrupted turn that arrive late', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.submitted).toBeDefined();
    const hung = f.submitted;
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

  /**
   * Claude Code 2.1.319, observed live (#190): a prompt submitted while a turn still runs (an Esc
   * that did not take) gets a `UserPromptSubmit` carrying the running turn's `prompt_id` and the
   * new prompt; that turn's `Stop` follows with its own reply; the queued prompt then runs under a
   * new `prompt_id` that no `UserPromptSubmit` announces, and its `Stop` carries that id.
   */
  async function midTurnSubmit(cancelBeforeAck: boolean) {
    const adapter = make({ FAKE_MODE: 'NO_ACK' }, { ackTimeoutMs: 60_000 });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    const p1 = randomUUID();
    const p2 = randomUUID();
    const typed = (t: string) => f.writes.includes(`\x1b[200~${t}\x1b[201~\r`);
    await adapter.send(h, { text: 'SLOW' });
    await expect.poll(() => typed('SLOW')).toBe(true);
    if (cancelBeforeAck) {
      // Esc before the turn's own UserPromptSubmit reached the adapter (a slow machine).
      await adapter.interrupt(h);
      await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SLOW' });
      expect(adapter.status(h)).toBe('cancelled');
    } else {
      await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SLOW' });
      await adapter.interrupt(h);
    }
    const from = tap.events.length;
    await adapter.send(h, { text: 'SAY after' });
    await expect.poll(() => typed('SAY after')).toBe(true);
    // The Esc did not take: the new prompt joined the running turn.
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SAY after' });
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'slow reply slow reply' });
    expect(texts(tap)).toEqual([]);
    expect(adapter.status(h)).toBe('running');
    // The queued prompt's own turn, under a prompt_id no UserPromptSubmit announced.
    await f.hook('Stop', { prompt_id: p2, last_assistant_message: 'You said after.' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, from);
    const next = tap.events.slice(from);
    expect(next.flatMap((e) => (e.t === 'message.delta' ? [e.text] : []))).toEqual([
      'You said after.',
    ]);
    expect(next.flatMap((e) => (e.t === 'status' ? [e.state] : []))).toEqual(['running', 'idle']);
    await adapter.close(h);
  }

  it("never credits a cancelled turn's reply to a prompt that joined it (#190)", async () => {
    await midTurnSubmit(false);
  });

  it('does the same when the cancel came before the turn was acknowledged (#190)', async () => {
    await midTurnSubmit(true);
  });

  it('keeps a cancelled turn cancelled when its UserPromptSubmit arrives late (#190)', async () => {
    const adapter = make({ FAKE_MODE: 'NO_ACK' }, { ackTimeoutMs: 60_000 });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    const p1 = randomUUID();
    await adapter.send(h, { text: 'SLOW' });
    await expect.poll(() => f.writes.some((w) => w.includes('SLOW'))).toBe(true);
    await adapter.interrupt(h);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SLOW' });
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'slow reply' });
    expect(adapter.status(h)).toBe('cancelled');
    expect(texts(tap)).toEqual([]);
    await adapter.close(h);
  });

  /** A session on the hook-less fake, where the test plays Claude Code's hooks itself (#190). */
  async function scripted() {
    const adapter = make({ FAKE_MODE: 'NO_ACK' }, { ackTimeoutMs: 60_000 });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    const typedCount = (t: string) =>
      f.writes.filter((w) => w === `\x1b[200~${t}\x1b[201~\r`).length;
    const deltas = (from: number) =>
      tap.events.slice(from).flatMap((e) => (e.t === 'message.delta' ? [e.text] : []));
    return { adapter, h, tap, f, typedCount, deltas };
  }

  it('ignores hooks of earlier turns while a joined prompt waits, even after a second cancel (#190)', async () => {
    const { adapter, h, tap, f, typedCount, deltas } = await scripted();
    const [p1, p2, p3] = [randomUUID(), randomUUID(), randomUUID()];
    await adapter.send(h, { text: 'SLOW' });
    await expect.poll(() => typedCount('SLOW')).toBe(1);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SLOW' });
    await adapter.interrupt(h);
    await adapter.send(h, { text: 'B' });
    await expect.poll(() => typedCount('B')).toBe(1);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'B' });
    // Cancelled again while B waits for its own turn; then C is typed.
    await adapter.interrupt(h);
    const from = tap.events.length;
    await adapter.send(h, { text: 'C' });
    await expect.poll(() => typedCount('C')).toBe(1);
    // Before C is acknowledged: the joined turn's end, and B's own turn, arrive late.
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'slow reply' });
    await f.hook('Stop', { prompt_id: p2, last_assistant_message: 'reply: B' });
    expect(deltas(from)).toEqual([]);
    // B's turn id is now known stale: C joining it is recognised as a join too.
    await f.hook('UserPromptSubmit', { prompt_id: p2, prompt: 'C' });
    await f.hook('Stop', { prompt_id: p2, last_assistant_message: 'reply: B again' });
    await f.hook('Stop', { prompt_id: p3, last_assistant_message: 'reply: C' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, from);
    expect(deltas(from)).toEqual(['reply: C']);
    await adapter.close(h);
  });

  it('joins after a cancel by denial too (#190)', async () => {
    const { adapter, h, tap, f, typedCount, deltas } = await scripted();
    const [p1, p2] = [randomUUID(), randomUUID()];
    await adapter.send(h, { text: 'TOOL' });
    await expect.poll(() => typedCount('TOOL')).toBe(1);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'TOOL' });
    const ls = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    await f.hook('PreToolUse', { ...ls, tool_use_id: 't1' });
    const pending = f.json('PermissionRequest', ls);
    const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
    if (req.event.t !== 'approval.request') throw new Error('no request');
    await adapter.respond(h, req.event.id, { kind: 'cancel', persist: false });
    await pending;
    const from = tap.events.length;
    await adapter.send(h, { text: 'SAY after' });
    await expect.poll(() => typedCount('SAY after')).toBe(1);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SAY after' });
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'tool reply' });
    await f.hook('Stop', { prompt_id: p2, last_assistant_message: 'You said after.' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, from);
    expect(deltas(from)).toEqual(['You said after.']);
    await adapter.close(h);
  });

  it("does not take a new id before the joined turn's Stop, nor a subagent's (#190)", async () => {
    const { adapter, h, tap, f, typedCount, deltas } = await scripted();
    const [p1, p2, stray, sub] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await adapter.send(h, { text: 'SLOW' });
    await expect.poll(() => typedCount('SLOW')).toBe(1);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SLOW' });
    await adapter.interrupt(h);
    const from = tap.events.length;
    await adapter.send(h, { text: 'SAY after' });
    await expect.poll(() => typedCount('SAY after')).toBe(1);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SAY after' });
    // An id that is not the joined turn's, before that turn's Stop: never adopted.
    await f.hook('Stop', { prompt_id: stray, last_assistant_message: 'stray' });
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'slow reply' });
    // A subagent's hook with a new id: not the prompt's turn either.
    await f.hook('Stop', { prompt_id: sub, agent_id: 'a1', last_assistant_message: 'subagent' });
    expect(deltas(from)).toEqual([]);
    expect(adapter.status(h)).toBe('running');
    await f.hook('Stop', { prompt_id: p2, last_assistant_message: 'You said after.' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, from);
    expect(deltas(from)).toEqual(['You said after.']);
    await adapter.close(h);
  });

  it('waits in the terminal when a joined prompt never gets its own turn (#190)', async () => {
    const adapter = make({ FAKE_MODE: 'NO_ACK' }, { ackTimeoutMs: 200 });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const f = fake();
    const p1 = randomUUID();
    await adapter.send(h, { text: 'SLOW' });
    await expect.poll(() => f.writes.length).toBeGreaterThan(0);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SLOW' });
    await adapter.interrupt(h);
    await adapter.send(h, { text: 'SAY after' });
    await expect.poll(() => f.writes.some((w) => w.includes('SAY after'))).toBe(true);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SAY after' });
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'slow reply' });
    await expect.poll(() => adapter.status(h)).toBe('waiting_input');
    await adapter.close(h);
  });

  it('does not report a joined prompt as not taken while the turn it joined still runs (#190)', async () => {
    const adapter = make({ FAKE_MODE: 'NO_ACK' }, { ackTimeoutMs: 200 });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    const [p1, p2] = [randomUUID(), randomUUID()];
    await adapter.send(h, { text: 'SLOW' });
    await expect.poll(() => f.writes.length).toBeGreaterThan(0);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SLOW' });
    await adapter.interrupt(h);
    const from = tap.events.length;
    await adapter.send(h, { text: 'SAY after' });
    await expect.poll(() => f.writes.some((w) => w.includes('SAY after'))).toBe(true);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'SAY after' });
    // The joined turn runs longer than the ack timeout before it ends.
    await new Promise((r) => setTimeout(r, 600));
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'slow reply' });
    await f.hook('Stop', { prompt_id: p2, last_assistant_message: 'You said after.' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, from);
    expect(tap.events.slice(from).flatMap((e) => (e.t === 'status' ? [e.state] : []))).toEqual([
      'running',
      'idle',
    ]);
    await adapter.close(h);
  });

  it("types a cancelled prompt's text again only after its late submit, and credits the new turn (#190)", async () => {
    const { adapter, h, tap, f, typedCount, deltas } = await scripted();
    const [p1, p2] = [randomUUID(), randomUUID()];
    await adapter.send(h, { text: 'continue' });
    await expect.poll(() => typedCount('continue')).toBe(1);
    // Cancelled before its submit arrived; the same text is sent again.
    await adapter.interrupt(h);
    const from = tap.events.length;
    const again = adapter.send(h, { text: 'continue' });
    await new Promise((r) => setTimeout(r, 800));
    // Still waiting for the cancelled one's submit: not typed a second time yet.
    expect(typedCount('continue')).toBe(1);
    await f.hook('UserPromptSubmit', { prompt_id: p1, prompt: 'continue' });
    await again;
    await expect.poll(() => typedCount('continue')).toBe(2);
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'cancelled reply' });
    await f.hook('UserPromptSubmit', { prompt_id: p2, prompt: 'continue' });
    await f.hook('Stop', { prompt_id: p2, last_assistant_message: 'new reply' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, from);
    expect(deltas(from)).toEqual(['new reply']);
    await adapter.close(h);
  });

  it('still tracks turns by id when UserPromptSubmit carries no prompt text (#190)', async () => {
    const { adapter, h, tap, f, typedCount, deltas } = await scripted();
    const [p1, p2] = [randomUUID(), randomUUID()];
    await adapter.send(h, { text: 'one' });
    await expect.poll(() => typedCount('one')).toBe(1);
    await f.hook('UserPromptSubmit', { prompt_id: p1 });
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'reply one' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    const from = tap.events.length;
    await adapter.send(h, { text: 'two' });
    await expect.poll(() => typedCount('two')).toBe(1);
    await f.hook('UserPromptSubmit', { prompt_id: p2 });
    await f.hook('Stop', { prompt_id: p1, last_assistant_message: 'late' });
    await f.hook('Stop', { prompt_id: p2, last_assistant_message: 'reply two' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, from);
    expect(deltas(from)).toEqual(['reply two']);
    await adapter.close(h);
  });

  it("drops a cancelled turn's hooks before the next turn is acknowledged too", async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.submitted).toBeDefined();
    const hung = f.submitted;
    // A tool of the cancelled turn is still open when Esc is sent.
    const ls = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    await f.hook('PreToolUse', { ...ls, tool_use_id: 'old' });
    await adapter.interrupt(h);
    const next = adapter.send(h, { text: 'HANG' });
    await adapter.send(h, { text: 'queued' });
    // In the wait after Esc, before the new prompt is even typed: the old turn's late hooks.
    await f.hook('Stop', { prompt_id: hung, last_assistant_message: 'stale' });
    const late = await f.json('PermissionRequest', { ...ls, prompt_id: hung });
    expect(late).toMatchObject({ hookSpecificOutput: { decision: { interrupt: true } } });
    await next;
    await expect.poll(() => f.submitted).not.toBe(hung);
    expect(texts(tap)).toEqual([]);
    // One prompt typed after the Esc; the queued one waits for that turn to end.
    const afterEsc = f.writes.slice(f.writes.indexOf('\x1b') + 1);
    expect(afterEsc).toEqual(['\x1b[200~HANG\x1b[201~\r']);
    // The old tool call ended with the cancel; a new one with the same input is its own.
    const results = () =>
      tap.events.flatMap((e) => (e.t === 'tool.result' ? [`${e.id}:${e.ok}`] : []));
    expect(results()).toEqual(['old:false']);
    await f.hook('PreToolUse', { ...ls, tool_use_id: 'new' });
    const perm = f.json('PermissionRequest', ls);
    const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
    if (req.event.t !== 'approval.request') throw new Error('no request');
    await adapter.respond(h, req.event.id, { kind: 'reject', persist: false });
    await perm;
    expect(results()).toEqual(['old:false', 'new:false']);
    await adapter.close(h);
  });

  it('does not submit a prompt interrupted while it waits to be typed', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const f = fake();
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.submitted).toBeDefined();
    await adapter.interrupt(h);
    // Typed only after the wait that follows an Esc: interrupted within it.
    const typing = adapter.send(h, { text: 'never' });
    await new Promise((r) => setTimeout(r, 30));
    await adapter.interrupt(h);
    await typing;
    expect(f.writes.filter((w) => w.includes('never'))).toEqual([]);
    expect(adapter.status(h)).toBe('cancelled');
    await adapter.close(h);
  });

  it('keeps waiting while another approval is still open', async () => {
    const adapter = make();
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    const f = fake();
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.submitted).toBeDefined();
    const p1 = f.json('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'a' } });
    const p2 = f.json('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'b' } });
    await expect.poll(() => tap.events.filter((e) => e.t === 'approval.request').length).toBe(2);
    const ids = tap.events.flatMap((e) => (e.t === 'approval.request' ? [e.id] : []));
    await adapter.respond(h, ids[0] as string, { kind: 'allow_once', persist: false });
    expect(adapter.status(h)).toBe('waiting_input');
    await adapter.respond(h, ids[1] as string, { kind: 'reject', persist: false });
    expect(adapter.status(h)).toBe('running');
    await Promise.all([p1, p2]);
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
    await expect.poll(() => f.submitted).toBeDefined();
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
    await expect.poll(() => f.submitted).toBeDefined();
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
    const before = f.submitted;
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.submitted).not.toBe(before);
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
    await expect.poll(() => f.submitted).toBeDefined();
    await f.hook('StopFailure');
    const end = await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    expect(end.event).toMatchObject({ message: 'the turn failed' });
    const before = f.submitted;
    await adapter.send(h, { text: 'HANG' });
    await expect.poll(() => f.submitted).not.toBe(before);
    const perm = f.json('PermissionRequest', { tool_name: 'Bash', tool_input: {} });
    await tap.waitFor((e) => e.t === 'approval.request', 5000);
    await adapter.close(h);
    expect(await perm).toEqual({});
    expect(adapter.status(h)).toBe('done');
  });

  it('reports a start that fails, and leaves no files', async () => {
    const expected: Record<string, RegExp> = {
      NO_START: /did not report ready/,
      EXIT_EARLY: /exited during start/,
      NO_INPUT: /never became ready for input/,
    };
    for (const [mode, error] of Object.entries(expected)) {
      await expect(
        make({ FAKE_MODE: mode }, { inputReadyTimeoutMs: 300 }).start({ cwd: join(root, 'wt') }),
      ).rejects.toThrow(error);
    }
    const left = existsSync(join(root, 'run'))
      ? readdirSync(join(root, 'run'), { recursive: true }).filter((f) =>
          String(f).endsWith('.json'),
        )
      : [];
    expect(left).toEqual([]);
    // Nor a Claude config directory (#153).
    expect(configDirs()).toEqual([]);
  });

  it('discards a closed session it will never resume, and never an open one', async () => {
    const adapter = make();
    const cwd = join(root, 'wt');
    const first = await adapter.start({ cwd });
    const vendor = first.vendorSessionId as string;
    await adapter.close(first);
    // Closed but not discarded: it resumes, in the same directory.
    const h = await adapter.start({ cwd, resume: { vendorSessionId: vendor } });
    expect(h.vendorSessionId).toBe(vendor);
    expect(configDirs()).toEqual([vendor]);
    await expect(adapter.discard(vendor, cwd)).rejects.toThrow(/still open/);
    await adapter.close(h);
    await adapter.discard(vendor, cwd);
    expect(configDirs()).toEqual([]);
    await expect(adapter.start({ cwd, resume: { vendorSessionId: vendor } })).rejects.toThrow(
      /no PTY session/,
    );
    await expect(adapter.discard('../escape', cwd)).rejects.toThrow(/UUID/);
  });

  it('sweeps session directories older than the retention when it first starts', async () => {
    const cwd = join(root, 'wt');
    const claudePty = join(repoStateDir(cwd, join(root, 'state')), 'claude-pty');
    const stale = randomUUID();
    const recent = randomUUID();
    for (const [id, days] of [
      [stale, 10],
      [recent, 1],
    ] as const) {
      mkdirSync(join(claudePty, id), { recursive: true });
      writeFileSync(join(claudePty, id, '.claude.json'), '{}');
      const t = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(join(claudePty, id, '.claude.json'), t, t);
      utimesSync(join(claudePty, id), t, t);
    }
    const adapter = make({}, { retentionDays: 7 });
    const h = await adapter.start({ cwd });
    expect(configDirs().sort()).toEqual([recent, h.vendorSessionId].sort());
    await adapter.close(h);
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
