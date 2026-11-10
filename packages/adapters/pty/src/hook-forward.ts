/**
 * Forwards one hook event from stdin to the PTY adapter's hook endpoint, for events Claude Code
 * runs only as `command` hooks (`SessionStart`; capability matrix §1, PTY mode). Run as
 * `node hook-forward.js <file>`, where `<file>` is the session's 0600 file holding
 * `{ "url", "token" }`: the token never appears on a command line. Always exits 0 and quickly,
 * so a missing endpoint never holds the session up.
 */
import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) return;
  const { url, token } = JSON.parse(readFileSync(file, 'utf8')) as { url: string; token: string };
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(5000),
  });
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
