import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * node-pty, loaded only when a PTY session starts: it is an optional native dependency
 * (ADR-002 decision 4), so Tacet works without it as long as no PTY Worker is used.
 */

/** The part of node-pty's `IPty` the adapter uses. */
export interface Pty {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type SpawnPty = (file: string, args: string[], opts: PtySpawnOptions) => Pty;

export class PtyUnavailableError extends Error {
  override name = 'PtyUnavailableError';
}

let loaded: Promise<SpawnPty> | undefined;

/**
 * node-pty 1.1.0 ships its macOS prebuilds with a `spawn-helper` that is not executable
 * (`-rw-r--r--` in the published tarball), and spawns every PTY through it. Make it executable
 * once, as the owner of the install; fail clearly if that is not possible.
 */
function fixSpawnHelper(): void {
  if (process.platform !== 'darwin') return;
  const require = createRequire(import.meta.url);
  let root: string;
  try {
    root = dirname(require.resolve('node-pty/package.json'));
  } catch {
    return;
  }
  for (const dir of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release']) {
    const helper = join(root, dir, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      try {
        chmodSync(helper, 0o755);
      } catch (err) {
        throw new PtyUnavailableError(
          `node-pty's ${helper} is not executable and cannot be made so: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/** node-pty's `spawn`, or `PtyUnavailableError` if node-pty is not installed or failed to build. */
export function loadPty(): Promise<SpawnPty> {
  loaded ??= import('node-pty').then(
    (m) => {
      try {
        fixSpawnHelper();
      } catch (err) {
        // Not cached: once the user fixes the install, the next session loads it.
        loaded = undefined;
        throw err;
      }
      // CommonJS module: the namespace or its default export carries `spawn`.
      const mod = (m as { spawn?: unknown; default?: { spawn?: unknown } }).spawn
        ? m
        : (m as { default: unknown }).default;
      const spawn = (mod as { spawn: (...a: unknown[]) => Pty }).spawn;
      return (file, args, opts) =>
        spawn(file, args, {
          name: opts.env.TERM ?? 'xterm-256color',
          cols: opts.cols,
          rows: opts.rows,
          cwd: opts.cwd,
          env: opts.env,
        });
    },
    (err: unknown) => {
      loaded = undefined;
      throw new PtyUnavailableError(
        `the PTY adapter needs the optional dependency node-pty, which is not available: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );
  return loaded;
}
