import type { AgentTerminal } from '@tacet/core';

/** Characters of output kept for a viewer that attaches later. */
const SCROLLBACK = 256 * 1024;
/** Output a viewer may fall behind by before its stream is ended (it can attach again). */
const MAX_BEHIND = 1024 * 1024;

interface Viewer {
  chunks: string[];
  size: number;
  wake: (() => void) | undefined;
  ended: boolean;
}

/**
 * A session's terminal output for `AgentAdapter.terminal` (#15): a bounded scrollback and live
 * streams, in memory only. It may show secrets the Worker printed, so it is never written to
 * disk or to the event log.
 */
export class TerminalBuffer implements AgentTerminal {
  #scrollback = '';
  readonly #viewers = new Set<Viewer>();
  #ended = false;

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {}

  push(data: string): void {
    if (this.#ended) return;
    // The cut may split an escape sequence at the start; a terminal redrawing it ignores that.
    this.#scrollback = (this.#scrollback + data).slice(-SCROLLBACK);
    for (const v of this.#viewers) {
      v.chunks.push(data);
      v.size += data.length;
      if (v.size > MAX_BEHIND) this.#drop(v);
      v.wake?.();
    }
  }

  /** The session ended: every stream completes once it has read what is left. */
  end(): void {
    this.#ended = true;
    for (const v of this.#viewers) {
      v.ended = true;
      v.wake?.();
    }
    this.#viewers.clear();
  }

  scrollback(): string {
    return this.#scrollback;
  }

  /**
   * A stream for one reader: `for await` reads it one chunk at a time (two `next()` calls at once
   * are not supported). It ends when the session ends, or early if this reader falls `MAX_BEHIND`
   * behind; `status()` tells the two apart.
   */
  output(): AsyncIterable<string> {
    const v: Viewer = { chunks: [], size: 0, wake: undefined, ended: this.#ended };
    if (!this.#ended) this.#viewers.add(v);
    const drop = () => this.#drop(v);
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<string>> => {
          while (v.chunks.length === 0 && !v.ended) {
            await new Promise<void>((r) => {
              v.wake = r;
            });
            v.wake = undefined;
          }
          const chunk = v.chunks.shift();
          if (chunk === undefined) return { value: undefined, done: true };
          v.size -= chunk.length;
          return { value: chunk, done: false };
        },
        return: async (): Promise<IteratorResult<string>> => {
          drop();
          return { value: undefined, done: true };
        },
      }),
    };
  }

  /** A viewer that fell too far behind, or stopped reading: its stream ends now. */
  #drop(v: Viewer): void {
    v.ended = true;
    v.chunks.length = 0;
    v.size = 0;
    this.#viewers.delete(v);
    v.wake?.();
  }
}

/** Terminal output as plain text: escape sequences removed, carriage returns as line breaks. */
export function plainText(data: string): string {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  return data
    .replace(new RegExp(`${esc}\\][^${bel}${esc}]*(?:${bel}|${esc}\\\\)`, 'g'), '')
    .replace(new RegExp(`${esc}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${esc}[()][0-9A-Za-z]`, 'g'), '')
    .replace(new RegExp(`${esc}[=>78DEHMc]`, 'g'), '')
    .replace(/\r\n?/g, '\n');
}
