/**
 * Relays one Claude Code hook event to the PTY adapter's hook endpoint (#164). Every Tacet hook
 * is a `command` hook running this: under Claude Code's Linux sandbox (`CLAUDE_CODE_SUBPROCESS_
 * ENV_SCRUB`, #150) `http` hooks go through the sandbox's network proxy and fail with an HTTP 500
 * Tacet never sent, while command hooks run outside it (verified live on 2.1.319, #163).
 *
 * Run as `node hook-forward.js <file> <event> <timeout s>`, where `<file>` is the session's 0600
 * file holding `{ "url", "token" }` (the endpoint's base URL): the token never appears on a
 * command line. It posts the hook's stdin to `<url>/<event>` and prints the endpoint's reply,
 * which Claude Code reads as the hook's output, as it reads an `http` hook's response body. A
 * failure or a non-2xx reply exits 1, a non-blocking error, as an `http` hook's failure is.
 *
 * `node:http`, not `fetch`: undici's default 300 s headers timeout would cut a
 * `PermissionRequest`, which waits up to 600 s for Tacet's answer (#164 review).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

/** Posts `body` to `<url>/<event>` with the token; resolves with the reply, or rejects. */
export function relay(
  target: { url: string; token: string },
  event: string,
  body: Buffer,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${target.url}/${event}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.token}`,
          'content-type': 'application/json',
          'content-length': body.length,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** The relay's exit code for `argv` (file, event, timeout s) and the hook's stdin. */
export async function main(argv: string[], stdin: AsyncIterable<Buffer>): Promise<number> {
  const [file, event, timeout] = argv;
  if (!file || !event || !/^[A-Za-z]+$/.test(event)) return 1;
  const target = JSON.parse(readFileSync(file, 'utf8')) as { url: string; token: string };
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(c);
  // A little under Claude Code's own timeout for the hook, so this reports the failure.
  const ms = Math.max(1, Number(timeout) || 30) * 1000 - 500;
  const res = await relay(target, event, Buffer.concat(chunks), ms);
  if (res.status < 200 || res.status >= 300) return 1;
  // Set the exit code rather than exiting, so a large reply is never cut off in the pipe.
  await new Promise<void>((r) => process.stdout.write(res.body, () => r()));
  return 0;
}

// Run as a script, also through a symlinked path (pnpm's node_modules): a relay that silently
// did nothing would drop every hook.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2), process.stdin as AsyncIterable<Buffer>).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
