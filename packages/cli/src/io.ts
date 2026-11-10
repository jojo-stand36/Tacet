import type { WslProbe } from '@tacet/core/node';
import type { StandaloneOptions } from '@tacet/mini/standalone';

/** What the `tacet` command reads from and writes to; replaced in tests. */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
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
  /** Tests only: what the WSL checks read (#193). Default: this machine's. */
  wslProbe?: WslProbe;
}
