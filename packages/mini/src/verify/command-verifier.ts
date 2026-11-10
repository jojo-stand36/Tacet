import { spawn } from 'node:child_process';
import {
  redactSecrets,
  type TacetConfig,
  type Task,
  type VerifyCommandResult,
  workerEnv,
  workerEnvPolicy,
} from '@tacet/core';
import {
  endMarkedProcesses,
  SAFE_GIT_ARGS,
  WORKER_MARKER_VAR,
  type WorkerWorktree,
  workerWorktree,
} from '@tacet/core/node';
import {
  type Verifier,
  type VerifyContext,
  type VerifyResult,
  type Workspace,
  WorktreeRefusedError,
} from '../daemon/ports.js';

export interface CommandVerifierOptions {
  /** The repo the Worker checkouts are linked worktrees of. */
  repoRoot: string;
  /** The `verify` commands of the effective config, never re-read from the Worker's checkout. */
  commands: readonly string[];
  /**
   * The environment the commands get: the Worker allowlist (`workerEnv`), so no vendor keys.
   * `CI=true` and the context's marker are added.
   */
  env: Record<string, string>;
  /** Milliseconds one command may run. Default 600000. */
  timeoutMs?: number;
  /** Milliseconds between SIGTERM and SIGKILL. Default 5000. */
  killGraceMs?: number;
  /** For git in the checkout: PATH and HOME are taken from here. Default `process.env`. */
  gitEnv?: Record<string, string | undefined>;
}

/** Output kept in memory per command; what is passed on is cut from its end. */
const TAIL_BYTES = 64 * 1024;
/** Output sent back to the Worker with a failure: about 2k tokens. */
const FEEDBACK_BYTES = 8 * 1024;
/** Output in `Verification.notes`, which goes up to the Conductor. */
const NOTES_BYTES = 2 * 1024;

const tail = (text: string, bytes: number): string => {
  const b = Buffer.from(text, 'utf8');
  return b.length <= bytes ? text : `[...]${b.subarray(b.length - bytes).toString('utf8')}`;
};

/**
 * Runs the repo's `verify` commands on a Worker's finished sub-task (#19), as Worker code: in the
 * Worker's own checkout, with the Worker environment and no vendor keys, never in the main
 * checkout or with the shared `.git` as its directory.
 *
 * - The checkout must be a linked worktree of the repo (`workerWorktree`), and clean at the
 *   integrated commit, before and after the commands: no tracked changes, no untracked files that
 *   are not ignored. So a pass means the integrated commit passed; ignored files (installed
 *   dependencies, build caches) are kept. A dirty checkout is a failure the Worker can fix.
 * - Each command runs as `/bin/sh -c <command>` in its own process group, stdin closed, with
 *   `CI=true` and the context's process marker. One that runs over the timeout, or an abort,
 *   ends the group (SIGTERM, then SIGKILL); after every command, whatever still carries the
 *   marker is ended (#127), so a server a test started does not outlive it.
 * - Output stays in memory: a redacted tail goes back to the Worker with a failure, a shorter one
 *   into `notes`. It is never written to an event.
 * - Commands run in order and stop at the first failure. An abort leaves the rest `not_run`.
 */
export class CommandVerifier implements Verifier {
  readonly #o: CommandVerifierOptions;

  constructor(opts: CommandVerifierOptions) {
    this.#o = opts;
  }

  async verify(_subtask: Task, workspace: Workspace, ctx: VerifyContext): Promise<VerifyResult> {
    const commands = [...this.#o.commands];
    if (commands.length === 0) return { status: 'passed', commands, results: [] };
    let wt: WorkerWorktree | undefined;
    try {
      wt = workerWorktree(workspace.path, this.#o.repoRoot);
    } catch (err) {
      throw new WorktreeRefusedError((err as Error).message);
    }
    if (!wt) {
      throw new WorktreeRefusedError(
        `refusing to verify in ${workspace.id}: it is not a linked worktree of the repo`,
      );
    }
    const dirty = await this.#dirty(workspace.path, wt, ctx.commit);
    if (dirty) {
      return {
        status: 'failed',
        commands,
        results: [],
        notes: `Not verified: ${dirty}.`,
        feedback: `Verification did not run: ${dirty}. Only committed work is integrated and verified: commit it (or add build output to .gitignore), then end your turn.`,
      };
    }
    const results: VerifyCommandResult[] = [];
    for (const command of commands) {
      if (ctx.signal.aborted) break;
      const { result, output } = await this.#run(command, workspace.path, ctx);
      results.push(result);
      ctx.onCommand?.(result);
      if (result.status === 'aborted') break;
      if (result.status !== 'passed') {
        const how =
          result.status === 'timed_out'
            ? `ran longer than ${Math.max(1, Math.round((this.#o.timeoutMs ?? 600_000) / 1000))} s and was stopped`
            : `exited with ${result.exitCode !== undefined ? `code ${result.exitCode}` : `signal ${result.signal ?? 'unknown'}`}`;
        const shown = redactSecrets(output);
        const named = redactSecrets(command);
        return {
          status: 'failed',
          commands,
          results,
          notes: `\`${named}\` ${how}. End of its output (command output, untrusted):\n${tail(shown, NOTES_BYTES)}`,
          feedback: `Verification failed: \`${named}\` ${how}.\nEnd of its output:\n\`\`\`\n${tail(shown, FEEDBACK_BYTES)}\n\`\`\`\nFix the cause, commit your changes, and end your turn.`,
        };
      }
    }
    if (ctx.signal.aborted || results.length < commands.length) {
      return { status: 'not_run', commands, results, notes: 'Verification was stopped.' };
    }
    const after = await this.#dirty(workspace.path, wt, ctx.commit);
    if (after) {
      return {
        status: 'failed',
        commands,
        results,
        notes: `The commands passed, but then ${after}.`,
        feedback: `The verify commands passed, but then ${after}: they changed the checkout (e.g. a formatter rewrote files), so the committed work is not what passed. Commit the result, then end your turn.`,
      };
    }
    return { status: 'passed', commands, results };
  }

  /** Why the checkout is not exactly the integrated commit, or undefined when it is. */
  async #dirty(cwd: string, wt: WorkerWorktree, commit?: string): Promise<string | undefined> {
    // Only PATH and HOME, and the worktree's git dirs as checked (no Worker object store: the
    // integrated commit is in the shared one, and a worktree without its own store is refused
    // with it).
    const base = this.#o.gitEnv ?? process.env;
    const env: Record<string, string> = {
      ...(base.PATH !== undefined ? { PATH: base.PATH } : {}),
      ...(base.HOME !== undefined ? { HOME: base.HOME } : {}),
      GIT_DIR: wt.gitDir,
      GIT_COMMON_DIR: wt.commonDir,
      GIT_WORK_TREE: cwd,
    };
    const git = (args: string[]) =>
      runCapture(
        'git',
        [
          ...SAFE_GIT_ARGS,
          // A nested repo's own config (a clean filter) would run for a recursive status.
          '-c',
          'submodule.recurse=false',
          '-c',
          'core.untrackedCache=false',
          '--no-optional-locks',
          ...args,
        ],
        { cwd, env },
      );
    const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
    if (head.code !== 0) return 'the checkout has no commit checked out';
    if (commit !== undefined && head.out.trim() !== commit) {
      return `the checkout is at ${head.out.trim().slice(0, 12)}, not the integrated commit ${commit.slice(0, 12)}`;
    }
    const status = await git([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=all',
    ]);
    if (status.code !== 0) return 'git could not read the checkout';
    const lines = status.out.split('\n').filter(Boolean);
    // Entries the index marks to be skipped are invisible to status: a Worker could hide changes.
    const listed = await git(['ls-files', '-v']);
    if (listed.code !== 0) return 'git could not read the checkout';
    const hidden = listed.out.split('\n').filter((l) => /^([a-z]|S) /.test(l)).length;
    if (hidden > 0) return `the checkout marks ${hidden} file(s) assume-unchanged or skip-worktree`;
    if (lines.length === 0) return undefined;
    const untracked = lines.filter((l) => l.startsWith('??')).length;
    const changed = lines.length - untracked;
    const parts = [
      changed > 0 ? `${changed} changed tracked file(s)` : '',
      untracked > 0 ? `${untracked} untracked file(s) that are not ignored` : '',
    ].filter(Boolean);
    return `the checkout has ${parts.join(' and ')}`;
  }

  async #run(
    command: string,
    cwd: string,
    ctx: VerifyContext,
  ): Promise<{ result: VerifyCommandResult; output: string }> {
    const started = Date.now();
    const env = { ...this.#o.env, CI: 'true', [WORKER_MARKER_VAR]: ctx.marker };
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = Buffer.alloc(0);
    const keep = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > TAIL_BYTES) buf = buf.subarray(buf.length - TAIL_BYTES);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let ended: 'timed_out' | 'aborted' | undefined;
    const group = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    // What the command started and left running (a dev server, a watcher, a daemon in a session
    // of its own) carries the marker: ended with the group whenever the command ends.
    const sweep = () => endMarkedProcesses([ctx.marker], { graceMs: 2000 }).catch(() => undefined);
    const stop = (why: 'timed_out' | 'aborted') => {
      if (ended) return;
      ended = why;
      group('SIGTERM');
      void sweep();
      killTimer = setTimeout(() => group('SIGKILL'), this.#o.killGraceMs ?? 5000);
    };
    const timer = setTimeout(() => stop('timed_out'), this.#o.timeoutMs ?? 600_000);
    const onAbort = () => stop('aborted');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    // The shell's own exit ends the command: a child it left holding stdout or stderr must not
    // keep the run waiting for the pipes to close.
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('error', () => resolve({ code: null, signal: null }));
        child.on('exit', (code, sig) => resolve({ code, signal: sig }));
      },
    );
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    ctx.signal.removeEventListener('abort', onAbort);
    group('SIGKILL');
    await sweep();
    // Its pipes close once nothing holds them; whatever still does is gone or ignored now.
    await new Promise<void>((resolve) => {
      if (child.stdout?.closed !== false && child.stderr?.closed !== false) return resolve();
      const t = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve();
      }, 2000);
      child.on('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const status = ended ?? (exit.code === 0 ? 'passed' : 'failed');
    const result: VerifyCommandResult = {
      command,
      status,
      ...(exit.code !== null ? { exitCode: exit.code } : {}),
      ...(exit.signal ? { signal: exit.signal } : {}),
      durationMs: Date.now() - started,
    };
    return { result, output: buf.toString('utf8') };
  }
}

/** Runs a command to completion, capturing stdout; for git in the checkout. */
function runCapture(
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(file, args, { ...opts, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout?.on('data', (d) => {
      out += d;
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('error', () => resolve({ code: null, out: '' }));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * The verifier the effective config asks for (#19): its `verify` commands, its
 * `workers.verify_timeout_s`, and the Worker environment allowlist (`workers.env.pass`, #147)
 * taken from `baseEnv`, the same snapshot Workers get theirs from. For the entry point.
 */
export function commandVerifierFromConfig(
  config: TacetConfig,
  opts: { repoRoot: string; baseEnv?: Record<string, string | undefined> },
): CommandVerifier {
  const baseEnv = opts.baseEnv ?? process.env;
  return new CommandVerifier({
    repoRoot: opts.repoRoot,
    commands: config.verify ?? [],
    env: workerEnv(baseEnv, {}, workerEnvPolicy(config)).env,
    timeoutMs: (config.workers?.verify_timeout_s ?? 600) * 1000,
    gitEnv: baseEnv,
  });
}
