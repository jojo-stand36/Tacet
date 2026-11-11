#!/usr/bin/env node
import { fstatSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { cappedLog } from './capped-log.js';
import { isDetachedChild } from './commands/detach.js';
import { main } from './main.js';

const abort = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // A second signal does not wait: the next start ends what was left running (#127).
    if (abort.signal.aborted) process.exit(sig === 'SIGINT' ? 130 : 143);
    abort.abort();
  });
}

const interactive = process.stdin.isTTY && process.stdout.isTTY;
const prompt = interactive
  ? async (question: string): Promise<string | undefined> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // A terminal readline takes Ctrl-C itself instead of the process getting SIGINT.
      rl.on('SIGINT', () => abort.abort());
      try {
        return await rl.question(question, { signal: abort.signal });
      } catch {
        return undefined;
      } finally {
        rl.close();
      }
    }
  : undefined;

// The background run of `tacet run --detach` (#201): its output is its log, kept under a cap
// (#273). Standard output and error are the same file there.
// Only a file: a terminal or a pipe cannot be cut.
// So is a `tacet mini` the Conductor started (#23), whose output is its log too.
const argv = process.argv.slice(2);
const log =
  (isDetachedChild(argv) || argv[0] === 'mini') && fstatSync(2).isFile() ? cappedLog(2) : undefined;

process.exitCode = await main(argv, {
  out: log ?? ((t) => process.stdout.write(`${t}\n`)),
  err: log ?? ((t) => process.stderr.write(`${t}\n`)),
  // A Worker's terminal on a terminal only: piped, `attach` prints its events instead.
  ...(process.stdout.isTTY ? { raw: (b: Uint8Array) => process.stdout.write(b) } : {}),
  cwd: process.cwd(),
  signal: abort.signal,
  ...(prompt ? { prompt } : {}),
});
