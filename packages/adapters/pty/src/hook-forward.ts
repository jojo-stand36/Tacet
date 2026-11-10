/**
 * Relays one Claude Code hook event to the PTY adapter's hook endpoint (#164). Every Tacet hook
 * is a `command` hook running this: under Claude Code's Linux sandbox (`CLAUDE_CODE_SUBPROCESS_ENV
 * _SCRUB`, #150) `http` hooks go through the sandbox's network proxy and fail with an HTTP 500 Tacet
 * never sent, while command hooks run outside it (verified live on 2.1.319, #163).
 *
 * Run as `node hook-forward.js <file> <event> <timeout s>`, where `<file>` is the session's 0600
 * file holding `{ "url", "token" }` (the endpoint's base URL): the token never appears on a
 * command line. It posts the hook's stdin to `<url>/<event>` and prints the endpoint's reply,
 * which Claude Code reads as the hook's output, as it reads an `http` hook's response body. A
 * failure or a non-2xx reply exits 1, a non-blocking error, as an `http` hook's failure is.
 */
import { readFileSync } from 'node:fs';

async function main(): Promise<number> {
  const [file, event, timeout] = process.argv.slice(2);
  if (!file || !event || !/^[A-Za-z]+$/.test(event)) return 1;
  const { url, token } = JSON.parse(readFileSync(file, 'utf8')) as { url: string; token: string };
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const res = await fetch(`${url}/${event}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: Buffer.concat(chunks),
    // A little under Claude Code's own timeout for the hook, so this reports the failure.
    signal: AbortSignal.timeout(Math.max(1, Number(timeout) || 30) * 1000 - 500),
  });
  const body = await res.text();
  if (!res.ok) return 1;
  process.stdout.write(body);
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);
