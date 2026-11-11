import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { processGroupAlive } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter } from './adapter.js';
import { StderrTail, spawnInOwnSession } from './spawn.js';

const posix = process.platform !== 'win32';
const SPAWN_TS = join(import.meta.dirname, 'spawn.ts');

/** The part of node-pty this test uses (its types live with the PTY adapter). */
interface NodePty {
  spawn(
    file: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
  ): { onData(cb: (d: string) => void): void; onExit(cb: () => void): void; kill(): void };
}

/** node-pty from the PTY adapter's dependencies, if it is installed (it needs a C++ toolchain). */
function loadNodePty(): NodePty | undefined {
  try {
    const req = createRequire(join(import.meta.dirname, '../../pty/package.json'));
    return req('node-pty') as NodePty;
  } catch {
    return undefined;
  }
}
/**
 * node-pty's gate, as `ptyGate()` in `@tacet/adapter-pty/testing` decides it (#189): in CI it must
 * load, so a skipped suite cannot pass for a tested one; locally, without it, the PTY test skips
 * and says so on stderr. Not imported: the PTY adapter depends on this package.
 */
const nodePty = posix ? loadNodePty() : undefined;
if (posix && !nodePty) {
  if (process.env.CI)
    throw new Error('node-pty is not available, and CI runs the PTY tests (#189)');
  process.stderr.write('Skipping the PTY test in spawn.test.ts: node-pty is not available here\n');
}

function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) resolve();
      else if (Date.now() > deadline) reject(new Error('timed out'));
      else setTimeout(tick, 25);
    };
    tick();
  });
}

describe.skipIf(!posix)('Claude Code in a session of its own (#308)', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-308-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('leads its own process group, whose rest gets SIGTERM when it exits', async () => {
    const out = join(root, 'out');
    // Leaves a grandchild behind, as a tool Claude Code started could.
    const child = spawnInOwnSession({
      command: 'sh',
      args: ['-c', `sleep 60 & echo "$$ $(ps -o pgid= -p $$) $!" > ${JSON.stringify(out)}; read _`],
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    });
    await waitFor(
      () => existsSync(out) && readFileSync(out, 'utf8').trim().split(/\s+/).length === 3,
    );
    const [pid, pgid, sleeper] = readFileSync(out, 'utf8').trim().split(/\s+/).map(Number);
    expect(pid).toBe(child.pid);
    expect(pgid).toBe(pid);
    const own = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString());
    expect(pgid).not.toBe(own);
    // stdin is a pipe: ending it ends the shell, and the group's sleeper goes with it.
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
    // Running members only: a zombie the container's init has yet to reap does not count.
    await waitFor(() => !processGroupAlive(pgid as number));
    expect(sleeper).toBeGreaterThan(0);
  });

  it.skipIf(!nodePty)(
    'has no controlling terminal, though the process starting it has one',
    async () => {
      // A process on a terminal (as `tacet run` is) starts two children with piped stdio: one as
      // the SDK would by default, one with spawnInOwnSession. Each tries to open its controlling
      // terminal, /dev/tty, which fails with none.
      // spawn.ts is loaded by Node's own type stripping: it must stay free of workspace imports
      // and of TypeScript that cannot simply be erased.
      const script = join(root, 'host.mjs');
      // A subshell: a failed redirection on `:` would end the shell itself (dash).
      const probe = '( : </dev/tty ) 2>/dev/null && echo tty || echo none';
      writeFileSync(
        script,
        [
          "import { spawn } from 'node:child_process';",
          `import { spawnInOwnSession } from ${JSON.stringify(pathToFileURL(SPAWN_TS).href)};`,
          'const run = (c, name) => new Promise((r) => {',
          "  let s = ''; c.stdout.on('data', (d) => { s += d; });",
          "  c.on('close', () => { process.stdout.write(name + '=' + s.trim() + '\\n'); r(); });",
          '  c.stdin.end();',
          '});',
          `const args = ['-c', ${JSON.stringify(probe)}];`,
          "await run(spawn('sh', args, { stdio: ['pipe', 'pipe', 'ignore'] }), 'sdk-default');",
          "await run(spawnInOwnSession({ command: 'sh', args, env: process.env, signal: new AbortController().signal }), 'own-session');",
        ].join('\n'),
      );
      const pty = nodePty as NodePty;
      const term = pty.spawn(process.execPath, [script], {
        cwd: root,
        env: process.env as Record<string, string>,
      });
      let text = '';
      term.onData((d) => {
        text += d;
      });
      // Ends the host if it hangs, so no terminal outlives the test.
      const stop = setTimeout(() => term.kill(), 10_000);
      await new Promise<void>((resolve) => term.onExit(() => resolve()));
      clearTimeout(stop);
      expect(text).toContain('sdk-default=tty');
      expect(text).toContain('own-session=none');
    },
  );

  it("starts the Agent SDK's Claude Code through it, and ends its group on close", async () => {
    const out = join(root, 'claude.out');
    const fake = join(root, 'claude');
    // A stand-in for Claude Code: records its process and group ids and whether it has a
    // controlling terminal, then waits until the SDK closes its stdin.
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        `tty=$( (: </dev/tty) 2>/dev/null && echo tty || echo none)`,
        `echo "$$ $(ps -o pgid= -p $$) $tty" > ${JSON.stringify(out)}`,
        'cat >/dev/null',
      ].join('\n'),
    );
    chmodSync(fake, 0o755);
    mkdirSync(join(root, 'wt'));
    const adapter = new ClaudeSdkAdapter({
      subprocessScrub: false,
      baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-placeholder' },
      mcpConfigDir: join(root, 'mcp'),
      stateDir: join(root, 'state'),
      hostTokenFile: join(root, 'no-host-token'),
      killTimeoutMs: 2000,
      sdkOptions: { pathToClaudeCodeExecutable: fake },
    });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    await waitFor(
      () => existsSync(out) && readFileSync(out, 'utf8').trim().split(/\s+/).length === 3,
    );
    const [pid, pgid, tty] = readFileSync(out, 'utf8').trim().split(/\s+/);
    expect(pgid).toBe(pid);
    // Also true where the tests have no terminal at all (CI); the PTY test above is the proof.
    expect(tty).toBe('none');
    await adapter.close(h);
    expect(processGroupAlive(Number(pgid))).toBe(false);
  }, 30_000);

  it('keeps the end of stderr, which the SDK cannot read from a custom spawner', async () => {
    const tail = new StderrTail(16);
    const child = spawnInOwnSession(
      {
        command: 'sh',
        args: ['-c', 'echo "a long first line" >&2; echo "bad key: x" >&2'],
        env: { PATH: process.env.PATH },
        signal: new AbortController().signal,
      },
      tail,
    );
    child.stdin.end();
    await new Promise((r) => child.once('close', r));
    expect(tail.text).toBe('line\nbad key: x');
  });

  it('SIGTERMs, then SIGKILLs, what is left of the group when a session closes', async () => {
    const out = join(root, 'claude.out');
    const fake = join(root, 'claude');
    // A stand-in for Claude Code that leaves a child ignoring SIGTERM, as a hung tool could.
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'sh -c "trap \'\' TERM; sleep 60" &',
        `echo "$$" > ${JSON.stringify(out)}`,
        'cat >/dev/null',
      ].join('\n'),
    );
    chmodSync(fake, 0o755);
    mkdirSync(join(root, 'wt'));
    const adapter = new ClaudeSdkAdapter({
      subprocessScrub: false,
      baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-placeholder' },
      mcpConfigDir: join(root, 'mcp'),
      stateDir: join(root, 'state'),
      hostTokenFile: join(root, 'no-host-token'),
      killTimeoutMs: 200,
      sdkOptions: { pathToClaudeCodeExecutable: fake },
    });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').trim() !== '');
    const pgid = Number(readFileSync(out, 'utf8').trim());
    const t0 = Date.now();
    await adapter.close(h);
    // The SDK's ~2 s grace, our 200 ms wait, 1 s after SIGTERM, then SIGKILL.
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(processGroupAlive(pgid)).toBe(false);
  }, 30_000);
});
