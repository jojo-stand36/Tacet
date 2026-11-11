import { CLOSE_CONFLICT } from '../auth/hello.js';
import { conductorRuntimePath, readRuntimeFile } from '../auth/runtime-file.js';
import { isProcessAlive } from '../process-lock.js';
import { connectRpc, type MiniCard, type RpcClient } from './ws-client.js';

/** What a Mini-conductor's link to the Conductor is doing, for logs and tests. */
export type ConductorLinkState =
  | { state: 'connected'; sessionId: string }
  /** It was connected and is not now; `code` is the WebSocket close code. */
  | { state: 'disconnected'; code: number }
  /** The Conductor already has a live Mini-conductor for this repo (4409). */
  | { state: 'refused'; code: number }
  /** A Conductor that runs could not be reached, or refused the hello. */
  | { state: 'failed'; message: string };

export interface DialConductorOptions {
  card: MiniCard;
  clientInfo: { name: string; version: string };
  /** Where `conductor.json` is. Default `~/.tacet/run`. */
  runDir?: string;
  /** First wait between attempts (ms), doubled up to `maxDelayMs`. Default 1000. */
  minDelayMs?: number;
  /** Default 30000. */
  maxDelayMs?: number;
  /**
   * Close a connection the Conductor has sent nothing on, not even a ping, for this long (ms).
   * Default 30000: three of the Conductor's 10 s pings.
   */
  silenceTimeoutMs?: number;
  /**
   * How long a connection must stay open before it counts as `connected` (ms): past the
   * Conductor's 2 s probe of a duplicate. Default 2500.
   */
  settleMs?: number;
  onState?: (s: ConductorLinkState) => void;
  /** For tests: 0 ≤ x < 1. Default `Math.random`. */
  random?: () => number;
}

export interface ConductorLink {
  /** The live connection, if there is one now. */
  current(): RpcClient | undefined;
  /** Stop dialing and close the connection. */
  close(): Promise<void>;
}

/**
 * A Mini-conductor's link to the Conductor (#23, ADR-003 §4: minis dial in). It reads
 * `conductor.json` before every attempt, so a Conductor that restarted (new port, new token) is
 * found, and skips a file whose pid is not running (a crashed Conductor's). Between attempts it
 * waits with exponential backoff and jitter; a refusal (4409: the repo already has a live
 * Mini-conductor) backs off the same way. No Conductor running is the normal standalone case and
 * is quiet: no state is reported for it. A hello answered is not acceptance: a 4409 or 1008 close
 * may follow it (ADR-003 addendum, #23), so `connected` is reported only once the connection has
 * outlived that.
 */
export function dialConductor(o: DialConductorOptions): ConductorLink {
  const min = o.minDelayMs ?? 1000;
  const max = o.maxDelayMs ?? 30_000;
  const random = o.random ?? Math.random;
  let stopped = false;
  let client: RpcClient | undefined;
  let wake: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
      timer.unref();
    }).finally(() => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      wake = undefined;
    });

  const loop = async () => {
    let delay = min;
    const backoff = async () => {
      // Full jitter on the upper half: minis that lost one Conductor do not all redial at once.
      await sleep(delay / 2 + (random() * delay) / 2);
      delay = Math.min(max, delay * 2);
    };
    while (!stopped) {
      let info: ReturnType<typeof readRuntimeFile>;
      try {
        info = readRuntimeFile(conductorRuntimePath(o.runDir));
      } catch {
        // No Conductor: standalone. Look again later, quietly.
        await backoff();
        continue;
      }
      if (!isProcessAlive(info.pid)) {
        await backoff();
        continue;
      }
      try {
        client = await connectRpc({
          port: info.port,
          token: info.token,
          clientInfo: o.clientInfo,
          role: 'mini',
          card: o.card,
          silenceTimeoutMs: o.silenceTimeoutMs ?? 30_000,
        });
      } catch (err) {
        if (!stopped) o.onState?.({ state: 'failed', message: (err as Error).message });
        await backoff();
        continue;
      }
      const c = client;
      if (stopped) {
        await c.close();
        break;
      }
      const reported = { yes: false };
      const settle = setTimeout(() => {
        reported.yes = true;
        delay = min;
        o.onState?.({ state: 'connected', sessionId: c.hello.sessionId });
      }, o.settleMs ?? 2500);
      settle.unref();
      const { code } = await c.closed;
      clearTimeout(settle);
      client = undefined;
      if (stopped) break;
      if (code === CLOSE_CONFLICT) o.onState?.({ state: 'refused', code });
      else if (reported.yes) o.onState?.({ state: 'disconnected', code });
      else o.onState?.({ state: 'failed', message: `closed at once (${code})` });
      await backoff();
    }
  };
  const done = loop();

  return {
    current: () => client,
    close: async () => {
      stopped = true;
      wake?.();
      await client?.close().catch(() => {});
      await done;
    },
  };
}
