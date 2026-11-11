import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { type MockMessagesApi, startMockMessagesApi } from '@tacet/adapter-claude-sdk/testing';
import type { SessionHandle } from '@tacet/core';
import { mcpAuthHeaders, Secret } from '@tacet/core/node';
import { assertConformance, EventTap, formatResults, runConformance } from '@tacet/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PtyAdapter, withoutImagePaths } from './adapter.js';
import { loadPty } from './pty.js';
import { gatedTitle, ptyGate } from './testing/pty-gate.js';

// node-pty must load in CI; locally a machine that could not build it skips these (#189).
const gate = await ptyGate();

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
/**
 * The scrub (#150) is on: on Linux the real sessions run under Claude Code's sandbox, so
 * bubblewrap and socat must be installed (as on CI); its hooks relay through command hooks (#164).
 */
describe.skipIf(!gate.ok)(
  gatedTitle('PtyAdapter conformance (interactive Claude Code in a PTY, mock Messages API)', gate),
  () => {
    let api: MockMessagesApi;
    let root: string;
    let adapter: PtyAdapter;
    let worktree: string;

    /** The terminal output of the sessions started, so a failing test shows what was on screen. */
    const screens: string[] = [];

    beforeAll(async () => {
      // node-pty loaded (the gate above): in CI a PTY test that quietly skipped would prove nothing.
      const spawn = await loadPty();
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
        spawn: (file, args, opts) => {
          const pty = spawn(file, args, opts);
          const i = screens.push('') - 1;
          pty.onData((d) => {
            screens[i] = ((screens[i] ?? '') + d).slice(-20_000);
          });
          return pty;
        },
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

    afterEach((ctx) => {
      if (ctx.task.result?.state !== 'fail') return;
      // Escape sequences built from char codes: control characters are not written in a regex.
      const esc = String.fromCharCode(27);
      const bel = String.fromCharCode(7);
      const csi = new RegExp(`${esc}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
      const osc = new RegExp(`${esc}\\][^${bel}]*${bel}`, 'g');
      const plain = (t: string) => t.replace(csi, '').replace(osc, '').slice(-1500);
      // The failing test's own sessions are the latest ones.
      for (const [i, t] of screens.entries()) {
        if (i >= screens.length - 3) console.log(`--- screen of session ${i}:\n${plain(t)}`);
      }
      // What reached the model: tells a prompt never sent from hooks that never came back.
      console.log(
        `--- last mock API requests:\n${api.requests
          .slice(-6)
          .map((r) =>
            JSON.stringify({
              text: r.text.slice(0, 80),
              tools: r.tools.length,
              out: r.toolOutput?.slice(0, 300),
            }),
          )
          .join('\n')}`,
      );
      if (process.env.TACET_PTY_SCREENS) {
        writeFileSync(process.env.TACET_PTY_SCREENS, JSON.stringify(screens));
      }
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
        // The adapter shows no text mid-turn: the mock's log says when the slow turn began.
        slowTurnStarted: () => api.requests.some((r) => r.text.endsWith('SLOW')),
        timeoutMs: 60_000,
      });
      console.log(formatResults(results));
      assertConformance(results);
    });

    it('clones no plugin marketplace into a Worker’s config dir (#288)', {
      timeout: 120_000,
    }, async () => {
      const h = await adapter.start({ cwd: worktree });
      const tap = new EventTap(adapter.events(h));
      const { end } = await turn(h, tap, 'SAY marketplace');
      expect(end).toEqual({ t: 'status', state: 'idle' });
      await adapter.close(h);
      // The session's own config dir, under the state dir: <repo hash>/claude-pty/<session id>.
      const state = join(root, 'state');
      const configDirs = readdirSync(state)
        .map((repo) => join(state, repo, 'claude-pty', h.vendorSessionId as string))
        .filter((d) => existsSync(d));
      expect(configDirs).toHaveLength(1);
      // Claude Code registers (git-clones) the official marketplace on a first interactive
      // launch, and every Worker's fresh config dir is one (seen live with 2.1.319).
      expect(existsSync(join(configDirs[0] as string, 'plugins', 'marketplaces'))).toBe(false);
      expect(existsSync(join(configDirs[0] as string, 'plugins', 'known_marketplaces.json'))).toBe(
        false,
      );
    });

    it('reads no @path mention into a Worker prompt (#226)', { timeout: 180_000 }, async () => {
      const cwd = join(root, 'wt-at');
      mkdirSync(cwd);
      writeFileSync(join(cwd, 'note.txt'), 'INSIDE-AT-CONTENT\n');
      const outside = join(root, 'outside-at.txt');
      writeFileSync(outside, 'OUTSIDE-AT-CONTENT\n');
      // A directory mention lists its entries (verified live without the variable).
      const dir = join(root, 'outside-at-dir');
      mkdirSync(dir);
      writeFileSync(join(dir, 'OUTSIDE-DIR-ENTRY.txt'), '');
      // Inline, at the start of a line, and inside a fence: each was read in before (verified live).
      for (const text of [
        `SAY inline see @${outside} and @note.txt`,
        `SAY line\n@${outside}`,
        `SAY dir @${dir}/`,
        `SAY fenced\n\`\`\`\nsee @${outside} and @note.txt\n\`\`\``,
      ]) {
        const h = await adapter.start({ cwd });
        const tap = new EventTap(adapter.events(h));
        const { end, events } = await turn(h, tap, text);
        expect(end).toEqual({ t: 'status', state: 'idle' });
        expect(events.some((e) => e.t === 'approval.request')).toBe(false);
        const raw = api.requests.at(-1)?.raw ?? '';
        // The typed text is kept as typed (Claude Code adds a note per mention telling the model
        // to read it with its tools, which the policy then decides), and nothing is read in.
        expect(api.requests.at(-1)?.text).toContain(
          text.includes('dir @') ? `@${dir}` : `@${outside}`,
        );
        expect(raw).not.toContain('OUTSIDE-DIR-ENTRY');
        expect(raw).not.toContain('OUTSIDE-AT-CONTENT');
        expect(raw).not.toContain('INSIDE-AT-CONTENT');
        await adapter.close(h);
      }
    });

    it('submits a prompt naming image files as text, and attaches none (#244)', {
      timeout: 300_000,
    }, async () => {
      const cwd = join(root, 'wt-img');
      mkdirSync(cwd);
      writeFileSync(join(cwd, 'in.png'), testPng());
      writeFileSync(join(cwd, 'note.txt'), 'note\n');
      const outside = join(root, 'outside-img.png');
      writeFileSync(outside, testPng());
      // Each of these left the paste unsubmitted (the Enter dropped), and the absolute ones on a
      // line of their own attached the file as an image, outside the checkout too (live, 2.1.319).
      for (const text of [
        'SAY see in.png',
        'SAY see ../outside-img.png',
        `SAY first\n${outside}`,
        `SAY first\n${join(cwd, 'in.png')}`,
        `SAY quoted\n"${outside}"`,
        'SAY see a.JPG and b.webp',
        // Several parts: an absolute image path and a path that is none.
        `SAY both\n${outside} ${join(cwd, 'note.txt')}`,
        // A trailing backslash, which would escape a lone space before the dot.
        `SAY both\n${outside} ${cwd}\\`,
      ]) {
        const h = await adapter.start({ cwd });
        const tap = new EventTap(adapter.events(h));
        // The prompt's own request: Claude Code also sends side requests (a title, suggestions).
        const promptRequest = (from: number, start: string) =>
          api.requests.slice(from).find((r) => r.text.startsWith(start));
        const before = api.requests.length;
        const { end } = await turn(h, tap, text);
        expect(end, text).toEqual({ t: 'status', state: 'idle' });
        const sent = promptRequest(before, 'SAY ');
        // Sent as text, with ` .` after the line that named an image, and no image in it.
        expect(sent?.text, text).toBe(withoutImagePaths(text));
        expect(withoutImagePaths(text)).not.toBe(text);
        // No request of the turn carries an image: the prompt's, or a side request's.
        for (const r of api.requests.slice(before)) {
          expect(r.raw, text).not.toContain('"type":"image"');
          expect(r.raw, text).not.toContain('iVBOR');
        }
        // The next prompt goes out on its own: nothing was left in the input box.
        const nextFrom = api.requests.length;
        const next = await turn(h, tap, 'SAY next');
        expect(next.end).toEqual({ t: 'status', state: 'idle' });
        const followed = promptRequest(nextFrom, 'SAY next');
        expect(followed?.text).toBe('SAY next');
        for (const r of api.requests.slice(nextFrom)) {
          expect(r.raw).not.toContain('"type":"image"');
        }
        await adapter.close(h);
      }
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
      const end = await tap.waitFor(
        (e) => e.t === 'status' && e.state === 'idle',
        60_000,
        req.index,
      );
      const states = tap.events
        .slice(0, end.index + 1)
        .flatMap((e) => (e.t === 'status' ? [e.state] : []));
      expect(states).toEqual(['idle', 'running', 'waiting_input', 'running', 'idle']);
      expect(tap.events.map((e) => e.t)).toEqual(
        expect.arrayContaining(['tool.call', 'tool.result', 'message.delta']),
      );
      expect(existsSync(join(cwd, 'tool-ran.txt'))).toBe(true);
      // A viewer sees the terminal: the prompt that was typed is on it.
      expect(adapter.terminal(h).scrollback()).toContain('RUN_TOOL');
      // The next turn starts from idle again.
      const next = await turn(h, tap, 'SAY again');
      expect(next.end).toMatchObject({ state: 'idle' });
      expect(next.events.find((e) => e.t === 'message.delta')).toMatchObject({
        text: expect.stringContaining('You said again'),
      });
      await adapter.close(h);
    });

    it('asks Tacet before every tool call, read-only ones included', {
      timeout: 120_000,
    }, async () => {
      const h = await adapter.start({ cwd: worktree });
      const tap = new EventTap(adapter.events(h));
      writeFileSync(join(worktree, 'note.txt'), 'hello');
      await adapter.send(h, { text: `READ_TOOL ${join(worktree, 'note.txt')}` });
      // Claude Code reads a file in its working directory without asking on its own; the adapter's
      // PreToolUse answer makes it ask.
      const req = await tap.waitFor((e) => e.t === 'approval.request', 60_000);
      expect(req.event).toMatchObject({ toolName: 'Read' });
      if (req.event.t !== 'approval.request') throw new Error('no approval request');
      await adapter.respond(h, req.event.id, { kind: 'reject', persist: false });
      const end = await tap.waitFor(
        (e) => e.t === 'status' && e.state === 'idle',
        60_000,
        req.index,
      );
      expect(
        tap.events.slice(req.index, end.index).find((e) => e.t === 'tool.result'),
      ).toMatchObject({
        ok: false,
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
      const mine = () =>
        readdirSync(runDir, { recursive: true, withFileTypes: true }).filter(
          (d) => d.isFile() && d.name.startsWith(h.id),
        );
      expect(
        mine()
          .map((f) => f.name)
          .sort(),
      ).toEqual([`${h.id}.hook.json`, `${h.id}.json`, `${h.id}.settings.json`].sort());
      for (const f of mine()) expect(statSync(join(f.parentPath, f.name)).mode & 0o777).toBe(0o600);
      const hookFile = mine().find((f) => f.name.endsWith('.hook.json'));
      const hookToken = String(
        JSON.parse(readFileSync(join(hookFile?.parentPath ?? '', hookFile?.name ?? ''), 'utf8'))
          .token,
      );
      // The settings name only the relay and that file: no token (#164).
      const settings = mine().find((f) => f.name.endsWith('.settings.json'));
      expect(
        readFileSync(join(settings?.parentPath ?? '', settings?.name ?? ''), 'utf8'),
      ).not.toContain(hookToken);
      expect(hookToken.length).toBeGreaterThan(20);
      const tap = new EventTap(adapter.events(h));
      await turn(h, tap, 'SAY files');
      await adapter.close(h);
      expect(mine()).toEqual([]);
      // Nothing in the worktree; neither token in any event or in any file Claude Code or Tacet
      // left behind (config, transcripts, logs).
      expect(readdirSync(cwd)).toEqual([]);
      for (const secret of [token, hookToken]) {
        expect(JSON.stringify(tap.events)).not.toContain(secret);
        for (const dir of [join(root, 'state'), join(root, 'home'), runDir]) {
          for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
            if (!f.isFile()) continue;
            expect(readFileSync(join(f.parentPath, f.name), 'utf8'), f.name).not.toContain(secret);
          }
        }
      }
    });

    it("keeps the repo's own settings, hooks and MCP servers out of a Worker", {
      timeout: 120_000,
    }, async () => {
      const cwd = join(root, 'wt-hostile');
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      // A repo that would allow every command, run a hook of its own and start an MCP server.
      writeFileSync(
        join(cwd, '.claude', 'settings.json'),
        JSON.stringify({
          permissions: { allow: ['Bash(*)', 'Bash', 'Read'] },
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'touch project-hook-ran.txt' }] }],
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'touch project-hook-ran.txt' }] },
            ],
          },
        }),
      );
      writeFileSync(
        join(cwd, '.claude', 'settings.local.json'),
        JSON.stringify({ permissions: { allow: ['Bash(*)'] } }),
      );
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            repo: { command: 'sh', args: ['-c', 'touch mcp-server-ran.txt; sleep 5'] },
          },
        }),
      );
      const h = await adapter.start({ cwd });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'RUN_TOOL' });
      // The repo's allow rule does not apply: Tacet is still asked.
      const req = await tap.waitFor((e) => e.t === 'approval.request', 60_000);
      if (req.event.t !== 'approval.request') throw new Error('no approval request');
      await adapter.respond(h, req.event.id, { kind: 'reject', persist: false });
      await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, req.index);
      await adapter.close(h);
      expect(existsSync(join(cwd, 'project-hook-ran.txt'))).toBe(false);
      expect(existsSync(join(cwd, 'mcp-server-ran.txt'))).toBe(false);
      expect(existsSync(join(cwd, 'tool-ran.txt'))).toBe(false);
    });

    it('ends a turn cleanly on interrupt and on cancel, and takes the next one', {
      timeout: 180_000,
    }, async () => {
      const cwd = join(root, 'wt-cancel');
      mkdirSync(cwd);
      const h = await adapter.start({ cwd });
      const tap = new EventTap(adapter.events(h));
      // Interrupt a running turn (Esc).
      const before = api.requests.length;
      await adapter.send(h, { text: 'SLOW' });
      await expect
        .poll(() => api.requests.slice(before).some((r) => r.text.endsWith('SLOW')), {
          timeout: 30_000,
        })
        .toBe(true);
      await adapter.interrupt(h);
      expect(adapter.status(h)).toBe('cancelled');
      let next = await turn(h, tap, 'SAY after');
      expect(next.end).toMatchObject({ state: 'idle' });
      expect(next.events.filter((e) => e.t === 'message.delta')).toEqual([
        { t: 'message.delta', text: 'You said after.' },
      ]);
      // Cancel while a permission waits (a denial that interrupts), and interrupt in that state.
      for (const how of ['cancel', 'interrupt'] as const) {
        const from = tap.events.length;
        await adapter.send(h, { text: 'RUN_TOOL' });
        const req = await tap.waitFor((e) => e.t === 'approval.request', 60_000, from);
        if (req.event.t !== 'approval.request') throw new Error('no approval request');
        if (how === 'cancel')
          await adapter.respond(h, req.event.id, { kind: 'cancel', persist: false });
        else await adapter.interrupt(h);
        expect(adapter.status(h)).toBe('cancelled');
        const sentBefore = api.requests.length;
        next = await turn(h, tap, `SAY after ${how}`);
        expect(next.end).toMatchObject({ state: 'idle' });
        // Its own reply (the mock answers the cancelled tool's result, sent along with the
        // prompt, with "Tool finished."), and the prompt reached the API.
        expect(next.events.filter((e) => e.t === 'message.delta')).toHaveLength(1);
        expect(
          api.requests.slice(sentBefore).some((r) => r.text.includes(`SAY after ${how}`)),
        ).toBe(true);
      }
      expect(existsSync(join(cwd, 'tool-ran.txt'))).toBe(false);
      await adapter.close(h);
    });

    it('reaches its hook endpoint past a proxy the user set', { timeout: 120_000 }, async () => {
      const proxied = new PtyAdapter({
        command: [claudeBinary()],
        killTimeoutMs: 2000,
        stateDir: join(root, 'state'),
        sessionFileDir: join(root, 'run', 'mcp'),
        baseEnv: {
          PATH: process.env.PATH,
          HOME: join(root, 'home'),
          ANTHROPIC_BASE_URL: api.url,
          ANTHROPIC_API_KEY: 'sk-ant-placeholder-not-a-real-key-0123456789',
          DISABLE_AUTOUPDATER: '1',
          // Nothing listens there: anything sent through it fails.
          HTTPS_PROXY: 'http://127.0.0.1:9',
          HTTP_PROXY: 'http://127.0.0.1:9',
        },
      });
      const h = await proxied.start({ cwd: worktree });
      const tap = new EventTap(proxied.events(h));
      await proxied.send(h, { text: 'SAY proxied' });
      const end = await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, 1);
      expect(end.event).toMatchObject({ state: 'idle' });
      await proxied.close(h);
    });
  },
);

/** A real 64x64 RGB PNG, as an image a Worker might name. */
function testPng(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (table[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const size = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size * 3; x++) rows[y * (size * 3 + 1) + 1 + x] = (x * 7 + y * 3) & 0xff;
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
