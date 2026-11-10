import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeHookSettings, PERMISSION_TIMEOUT_S } from './claude.js';
import { main, relay } from './hook-forward.js';

describe('hook-forward: the command hook relay (#164)', () => {
  let server: Server;
  let url: string;
  let dir: string;
  const seen: { path: string; auth: string; body: string }[] = [];
  /** The reply per path: status and body, after an optional delay. */
  const replies = new Map<string, { status: number; body: string; delayMs?: number }>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        seen.push({ path: req.url ?? '', auth: req.headers.authorization ?? '', body });
        const r = replies.get(req.url ?? '') ?? { status: 200, body: '{}' };
        setTimeout(() => res.writeHead(r.status).end(r.body), r.delayMs ?? 0);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/s1`;
    dir = mkdtempSync(join(tmpdir(), 'tacet-hook-forward-'));
    writeFileSync(join(dir, 'hook.json'), JSON.stringify({ url, token: 'tok-123' }), {
      mode: 0o600,
    });
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const stdin = (s: string) => Readable.from([Buffer.from(s)]);

  it('posts stdin to <url>/<event> with the token and prints the reply', async () => {
    const decision = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest"}}';
    replies.set('/hooks/s1/PermissionRequest', { status: 200, body: decision });
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string, cb?: () => void) => {
      out.push(String(chunk));
      cb?.();
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await main(
        [join(dir, 'hook.json'), 'PermissionRequest', '600'],
        stdin('{"tool_name":"Edit"}'),
      );
      expect(code).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(out.join('')).toBe(decision);
    expect(seen.at(-1)).toEqual({
      path: '/hooks/s1/PermissionRequest',
      auth: 'Bearer tok-123',
      body: '{"tool_name":"Edit"}',
    });
  });

  it('exits 1 on a non-2xx reply, a refused connection, a bad event or a timeout', async () => {
    replies.set('/hooks/s1/Stop', { status: 401, body: 'no' });
    expect(await main([join(dir, 'hook.json'), 'Stop', '30'], stdin('{}'))).toBe(1);
    expect(await main([join(dir, 'hook.json'), 'Stop;rm', '30'], stdin('{}'))).toBe(1);
    expect(await main([join(dir, 'hook.json')], stdin('{}'))).toBe(1);
    await expect(
      relay({ url: 'http://127.0.0.1:1/x', token: 't' }, 'Stop', Buffer.from('{}'), 2000),
    ).rejects.toThrow();
    replies.set('/hooks/s1/Slow', { status: 200, body: '{}', delayMs: 3000 });
    await expect(relay({ url, token: 't' }, 'Slow', Buffer.from('{}'), 500)).rejects.toThrow();
  });

  it('waits for a reply as long as asked, with no client-side cap of its own', async () => {
    // The old `fetch` capped every wait at undici's 300 s headers timeout; here the only limit is
    // the one passed (checked with a short reply delay; the 320 s case was checked by hand).
    replies.set('/hooks/s1/Late', { status: 200, body: '{"late":true}', delayMs: 1500 });
    await expect(relay({ url, token: 't' }, 'Late', Buffer.from('{}'), 5000)).resolves.toEqual({
      status: 200,
      body: '{"late":true}',
    });
  });

  it('runs as a script, through the file it is given, and exits with the relay result', async () => {
    replies.set('/hooks/s1/Notification', { status: 200, body: '{"ok":1}' });
    const script = join(import.meta.dirname, 'hook-forward.ts');
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = execFile(
        process.execPath,
        [script, join(dir, 'hook.json'), 'Notification', '30'],
        (err, out) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out }),
      );
      p.stdin?.end('{"n":1}');
    });
    expect(r).toEqual({ code: 0, out: '{"ok":1}' });
  });
});

describe('claudeHookSettings (#164)', () => {
  it('relays every event through a command hook, with no token in the settings', () => {
    const s = claudeHookSettings({ forward: "'/node' '/relay.js' '/run/s.hook.json'" }) as {
      hooks: Record<
        string,
        { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[]
      >;
    };
    expect(Object.keys(s.hooks).sort()).toEqual(
      [
        'Notification',
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'StopFailure',
        'UserPromptSubmit',
      ].sort(),
    );
    for (const [ev, [entry]] of Object.entries(s.hooks)) {
      const hook = entry?.hooks[0];
      expect(hook?.type, ev).toBe('command');
      expect(hook?.command, ev).toBe(
        `'/node' '/relay.js' '/run/s.hook.json' ${ev} ${hook?.timeout}`,
      );
    }
    expect(s.hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBe(PERMISSION_TIMEOUT_S);
    expect(s.hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(30);
    expect(s.hooks.PreToolUse?.[0]?.matcher).toBe('');
    expect(s.hooks.Stop?.[0]?.matcher).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/token|Bearer|http:/i);
  });
});
