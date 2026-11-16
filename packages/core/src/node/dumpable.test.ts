import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeNonDumpable, memoryReadWarning, ptraceScope } from './dumpable.js';

describe('memoryReadWarning (#316)', () => {
  const unavailable = { state: 'unavailable', reason: 'Node v24 has no node:ffi' } as const;

  it('warns on Linux when the process is dumpable and Yama is missing or at 0', () => {
    expect(memoryReadWarning(unavailable, undefined, 'linux')).toMatch(
      /^warning: this kernel has no Yama, .*\(Node v24 has no node:ffi\)\. .*answer codes/,
    );
    expect(memoryReadWarning(unavailable, 0, 'linux', '24.22.2')).toMatch(
      /Yama ptrace_scope is 0, .* Run Tacet on Node 26\.1 or later, or set kernel\.yama\.ptrace_scope to 1\.$/,
    );
    // On a Node that has node:ffi, the advice is to stop turning it off or denying it.
    expect(
      memoryReadWarning(
        { state: 'unavailable', reason: 'node:ffi refused: …' },
        0,
        'linux',
        '26.13.1',
      ),
    ).toMatch(
      /Let Tacet use node:ffi \(no --no-experimental-ffi; --allow-ffi under the Permission Model\)/,
    );
  });

  it('says nothing once non-dumpable, with Yama at 1 or more, or off Linux', () => {
    expect(memoryReadWarning({ state: 'set' }, undefined, 'linux')).toBeUndefined();
    expect(memoryReadWarning(unavailable, 1, 'linux')).toBeUndefined();
    expect(memoryReadWarning(unavailable, 3, 'linux')).toBeUndefined();
    expect(memoryReadWarning(unavailable, undefined, 'darwin')).toBeUndefined();
  });
});

describe('ptraceScope', () => {
  it('reads the scope, and undefined when the file is missing or unreadable', () => {
    expect(ptraceScope(() => '1\n')).toBe(1);
    expect(ptraceScope(() => 'x')).toBeUndefined();
    expect(
      ptraceScope(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    ).toBeUndefined();
  });
});

/** Why the live check cannot tell anything here, or undefined when it can. */
function liveSkipReason(): string | undefined {
  if (process.platform !== 'linux') return 'not Linux';
  if (!process.getBuiltinModule('node:ffi')) return `Node ${process.version} has no node:ffi`;
  // Root and CAP_SYS_PTRACE (bit 19) open any process's memory, dumpable or not (kernel/ptrace.c).
  if (process.geteuid?.() === 0) return 'running as root, which bypasses the check';
  const capEff = /^CapEff:\s*([0-9a-f]+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1];
  if (capEff && (BigInt(`0x${capEff}`) >> 19n) & 1n) return 'has CAP_SYS_PTRACE';
  // At scope 2 or 3 Yama refuses even an ancestor, so the control open below would fail.
  const scope = ptraceScope();
  if (scope !== undefined && scope >= 2) return `Yama ptrace_scope is ${scope}`;
  return undefined;
}

describe('makeNonDumpable, live (#316)', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
  });

  /** A Node child that calls makeNonDumpable (or not), reports, and waits. */
  const child = async (set: boolean) => {
    const helper = pathToFileURL(new URL('./dumpable.ts', import.meta.url).pathname).href;
    const code = `
      const { makeNonDumpable } = await import(${JSON.stringify(helper)});
      const r = ${set ? 'makeNonDumpable()' : "({ state: 'kept' })"};
      process.stdout.write(JSON.stringify(r) + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `;
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(c);
    let err = '';
    c.stderr?.on('data', (d) => {
      err += d;
    });
    const line = await new Promise<string>((resolve, reject) => {
      let out = '';
      c.stdout?.on('data', (d) => {
        out += d;
        const nl = out.indexOf('\n');
        if (nl >= 0) resolve(out.slice(0, nl));
      });
      c.on('exit', (code) => reject(new Error(`child exited ${code}: ${err}`)));
    });
    /** End the child and wait for its streams, so all it wrote to stderr is in. */
    const finish = async () => {
      const closed = new Promise<void>((resolve) => c.on('close', () => resolve()));
      c.stdin?.end();
      await closed;
      return err;
    };
    return { pid: c.pid ?? 0, result: JSON.parse(line) as { state: string }, finish };
  };

  const openMem = (pid: number): string => {
    try {
      closeSync(openSync(`/proc/${pid}/mem`, 'r'));
      return 'opened';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code ?? 'error';
    }
  };

  const skip = liveSkipReason();
  if (skip) process.stderr.write(`dumpable.test.ts: live check skipped: ${skip}\n`);

  it.skipIf(skip !== undefined)(
    "keeps a same-user process out of the child's memory once it is non-dumpable",
    { timeout: 20_000 },
    async () => {
      // Control: an ancestor may open a dumpable child's memory (Yama scope 0 or 1, or no Yama).
      const kept = await child(false);
      expect(openMem(kept.pid)).toBe('opened');
      const hardened = await child(true);
      expect(hardened.result).toEqual({ state: 'set' });
      expect(openMem(hardened.pid)).toMatch(/^(EACCES|EPERM)$/);
      // The ExperimentalWarning node:ffi prints on load stays off the user's terminal.
      expect(await hardened.finish()).not.toMatch(/ExperimentalWarning/);
      await kept.finish();
    },
  );

  // On CI the Ubuntu Node 26 job runs as a normal user: the check above must really run there.
  // A CI job run as root (a container job) would fail here on purpose: run it as a normal user.
  it.runIf(process.env.CI === 'true' && process.platform === 'linux')(
    'runs the live check on CI wherever Node has node:ffi',
    () => {
      if (!process.getBuiltinModule('node:ffi')) return;
      expect(skip).toBeUndefined();
    },
  );

  it('reports why it changed nothing where it cannot work', () => {
    if (process.platform === 'linux' && process.getBuiltinModule('node:ffi')) return;
    const r = makeNonDumpable();
    expect(r.state).toBe('unavailable');
    expect(r).toMatchObject({ reason: expect.stringMatching(/not Linux|has no node:ffi/) });
  });
});
