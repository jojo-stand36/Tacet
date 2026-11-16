import type { NonDumpable, WslProbe } from '@tacet/core/node';
import type { StandaloneOptions } from '@tacet/mini/standalone';
import type { SpawnDetached } from './commands/detach.js';

/** What the `tacet` command reads from and writes to; replaced in tests. */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  /**
   * Bytes to standard output as they are, for a Worker's live terminal (`tacet attach`, #201).
   * Absent, `attach` follows the log instead.
   */
  raw?: (bytes: Uint8Array) => void;
  cwd: string;
  /** The user's environment, for Workers. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** What `~` means. Default `os.homedir()`. */
  home?: string;
  /** Ask the user a question; absent when there is no terminal to ask on. */
  prompt?: (question: string) => Promise<string | undefined>;
  /** Aborted on SIGINT or SIGTERM. */
  signal?: AbortSignal;
  /** How often `logs --follow`, `attach` and `run` look at the log, in ms. Default 250. */
  pollMs?: number;
  /** Tests only: overrides for the standalone Mini-conductor. */
  standalone?: Partial<StandaloneOptions>;
  /** Tests only: how `tacet run --detach` starts its background run (#201). */
  spawnDetached?: SpawnDetached;
  /** Tests only: how long `tacet run --detach` waits for it to start, in ms. Default 60000. */
  detachStartTimeoutMs?: number;
  /** Tests only: what the WSL checks read (#193). Default: this machine's. */
  wslProbe?: WslProbe;
  /**
   * How a command that holds the one-time answer codes (`tacet run`, `tacet mini`) keeps its memory
   * from code a Worker runs (#316). The `tacet` binary passes the real one (`makeNonDumpable`);
   * absent (in-process tests, which must not change the test runner), nothing is changed or said.
   */
  memoryGuard?: MemoryGuard;
}

/** What {@link Io.memoryGuard} does and reads. */
export interface MemoryGuard {
  harden: () => NonDumpable;
  /** Yama's `ptrace_scope`, `undefined` without Yama. Default: this machine's. */
  scope?: () => number | undefined;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
}
