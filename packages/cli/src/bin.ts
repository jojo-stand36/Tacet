#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
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

process.exitCode = await main(process.argv.slice(2), {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
  // A Worker's terminal on a terminal only: piped, `attach` prints its events instead.
  ...(process.stdout.isTTY ? { raw: (b: Uint8Array) => process.stdout.write(b) } : {}),
  cwd: process.cwd(),
  signal: abort.signal,
  ...(prompt ? { prompt } : {}),
});
