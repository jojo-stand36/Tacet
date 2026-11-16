import { readFileSync } from 'node:fs';

/**
 * `prctl(2)` options, from `include/uapi/linux/prctl.h` (torvalds/linux master, read 2026-11-16):
 * `#define PR_GET_DUMPABLE 3`, `#define PR_SET_DUMPABLE 4`. The value 0 is `TASK_DUMPABLE_OFF`
 * (`include/linux/sched/coredump.h`: "no dump; ptrace needs CAP_SYS_PTRACE"; "The numeric values
 * are stable ABI").
 */
const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

/** What {@link makeNonDumpable} did. */
export type NonDumpable = { state: 'set' } | { state: 'unavailable'; reason: string };

/** The part of `node:ffi` used here (Node 26.1 and later, Stability 1, in builds with FFI). */
interface Ffi {
  dlopen(
    path: null,
    definitions: Record<string, { arguments: string[]; return: string }>,
  ): { functions: Record<string, (...args: number[]) => number> };
}

/**
 * Make this process non-dumpable (`prctl(PR_SET_DUMPABLE, 0)`, Linux), so a process of the same
 * user cannot open its `/proc/<pid>/mem` or ptrace it without CAP_SYS_PTRACE, whatever Yama's
 * `ptrace_scope` is, and no core dump of it is written (#316). `tacet run` holds the one-time
 * answer codes in its memory (#269), and the Workers it starts run as the same user.
 *
 * From kernel source (torvalds/linux master, read 2026-11-16): opening `/proc/<pid>/mem` checks
 * `mm_access(task, PTRACE_MODE_ATTACH | PTRACE_MODE_FSCREDS)` (`fs/proc/base.c`), which goes
 * through `__ptrace_may_access` and its `task_still_dumpable` check (`kernel/ptrace.c`); a core
 * dump is skipped when the state is `TASK_DUMPABLE_OFF` (`fs/coredump.c`, `coredump_skip`). It is
 * reset on every exec (`fs/exec.c`, `begin_new_exec`), so the Workers this process starts are not
 * affected, and on a change of effective or file-system ids (`kernel/cred.c`, `commit_creds`).
 *
 * Node has no `prctl`; this calls it through `node:ffi`, so it needs Node 26.1 or later in a build
 * with FFI, not turned off (`--no-experimental-ffi`) and allowed by the Permission Model
 * (`--allow-ffi`). Elsewhere it changes nothing and says why. Never throws.
 */
export function makeNonDumpable(): NonDumpable {
  if (process.platform !== 'linux') {
    return { state: 'unavailable', reason: `not Linux (${process.platform})` };
  }
  const ffi = loadFfi();
  if (!ffi) {
    return {
      state: 'unavailable',
      reason: `Node ${process.version} has no node:ffi (Node 26.1 or later has it, unless turned off)`,
    };
  }
  try {
    const { prctl } = ffi.dlopen(null, {
      prctl: { arguments: ['i32', 'u64', 'u64', 'u64', 'u64'], return: 'i32' },
    }).functions;
    if (!prctl) return { state: 'unavailable', reason: 'prctl was not found' };
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) {
      return { state: 'unavailable', reason: 'prctl(PR_SET_DUMPABLE, 0) failed' };
    }
    // Read back: the call's own result is not taken on trust.
    if (prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) !== 0) {
      return { state: 'unavailable', reason: 'the process is still dumpable after prctl' };
    }
    return { state: 'set' };
  } catch (err) {
    // The Permission Model without --allow-ffi throws ERR_ACCESS_DENIED here.
    return { state: 'unavailable', reason: `node:ffi refused: ${(err as Error).message}` };
  }
}

/**
 * `node:ffi`, or undefined where Node has none. Loading it prints an ExperimentalWarning, which
 * would only confuse a `tacet run` user, so that one warning is dropped; any other passes.
 */
function loadFfi(): Ffi | undefined {
  const emit = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const first = rest[0];
    const type = typeof first === 'string' ? first : (first as { type?: string } | undefined)?.type;
    const text = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && /\bFFI\b/.test(text)) return;
    // biome-ignore lint/suspicious/noExplicitAny: forwarding the original overloads unchanged
    return (emit as any).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:ffi') as Ffi | undefined;
  } catch {
    return undefined;
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * Yama's `ptrace_scope` (Linux): `undefined` when the kernel has no Yama. 0 lets any process of
 * the user ptrace another; 1 and up allow it only from an ancestor (or not at all).
 */
export function ptraceScope(
  read: () => string = () => readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8'),
): number | undefined {
  try {
    const n = Number.parseInt(read().trim(), 10);
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The warning `tacet run` prints when code a Worker runs could read its memory, and so the answer
 * codes (#316): on Linux, the process is still dumpable and Yama is missing or at scope 0.
 * `undefined` when there is nothing to warn about. Root and CAP_SYS_PTRACE are not covered: they
 * can read any process anyway.
 */
export function memoryReadWarning(
  result: NonDumpable,
  scope: number | undefined,
  platform: NodeJS.Platform = process.platform,
  nodeVersion: string = process.versions.node,
): string | undefined {
  if (platform !== 'linux' || result.state === 'set') return undefined;
  if (scope !== undefined && scope >= 1) return undefined;
  const yama = scope === undefined ? 'this kernel has no Yama' : 'Yama ptrace_scope is 0';
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  const fix =
    major > 26 || (major === 26 && minor >= 1)
      ? 'Let Tacet use node:ffi (no --no-experimental-ffi; --allow-ffi under the Permission Model)'
      : 'Run Tacet on Node 26.1 or later';
  return `warning: ${yama}, and this process could not make itself non-dumpable (${result.reason}). Programs a Worker runs could read the answer codes from its memory. ${fix}, or set kernel.yama.ptrace_scope to 1.`;
}
