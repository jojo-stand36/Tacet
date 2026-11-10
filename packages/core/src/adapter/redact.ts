import { redactSecrets } from '../config/secrets.js';
import type { AgentEvent } from '../schema/agent-event.js';
import type { McpServerConfig } from './types.js';

/**
 * Literal secrets of a session: its MCP header values, plus the bare token of an
 * `<scheme> <token>` value. Adapters scrub these from every event they emit (ADR-003 §1), on top
 * of the pattern-based `redactSecrets`, because Worker tokens have no recognisable prefix.
 * Longest first, so a full header value is replaced before the token inside it.
 */
export function mcpHeaderSecrets(servers: readonly McpServerConfig[] | undefined): string[] {
  const out = new Set<string>();
  for (const srv of servers ?? []) {
    for (const v of Object.values(srv.headers ?? {})) {
      if (v.length >= 8) out.add(v);
      const bare = /^\s*\S+\s+(\S{8,})\s*$/.exec(v)?.[1];
      if (bare) out.add(bare);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Copy of `value` with every occurrence of each literal secret replaced by `[redacted]`. */
export function scrubLiterals<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  if (typeof value === 'string') {
    return secrets.reduce((acc, sec) => acc.split(sec).join('[redacted]'), value as string) as T;
  }
  if (Array.isArray(value)) return value.map((v) => scrubLiterals(v, secrets)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrubLiterals(v, secrets)]),
    ) as T;
  }
  return value;
}

/**
 * Scrubs literal secrets from streamed text that arrives in pieces (#109): a secret split across
 * two `message.delta` events is missed by scrubbing each event alone. `push` returns the text that
 * is safe to emit now, scrubbed; `flush` returns the rest, for the end of the stream or before an
 * event that must not overtake the text.
 *
 * What is held back is decided on the raw text, before scrubbing: the longest tail that could
 * still be the start of a secret (at most the longest secret's length minus one), moved back to
 * the start of any complete secret that would otherwise be cut in two. So a shorter secret that
 * begins a longer one is not replaced before the longer one is known. Text that cannot begin a
 * secret is never held, so ordinary streaming keeps its pace; held text waits for the next push
 * or flush, however long that takes.
 */
export class DeltaScrubber {
  readonly #secrets: readonly string[];
  readonly #maxHold: number;
  #held = '';

  constructor(secrets: readonly string[]) {
    // Longest first, as `scrubLiterals` expects; empty strings would match everywhere.
    this.#secrets = [...new Set(secrets.filter((x) => x.length > 0))].sort(
      (a, b) => b.length - a.length,
    );
    this.#maxHold = Math.max(0, (this.#secrets[0]?.length ?? 0) - 1);
  }

  push(text: string): string {
    if (this.#secrets.length === 0) return text;
    const raw = this.#held + text;
    const cut = this.#cut(raw);
    this.#held = raw.slice(cut);
    return scrubLiterals(raw.slice(0, cut), this.#secrets);
  }

  flush(): string {
    const out = scrubLiterals(this.#held, this.#secrets);
    this.#held = '';
    return out;
  }

  /** Where `raw` may be cut: everything before it can be scrubbed and emitted now. */
  #cut(raw: string): number {
    let cut = raw.length;
    for (let k = Math.min(this.#maxHold, raw.length); k > 0; k--) {
      const tail = raw.slice(raw.length - k);
      if (this.#secrets.some((sec) => sec.startsWith(tail))) {
        cut = raw.length - k;
        break;
      }
    }
    // Never through a complete secret: move the cut back to its start.
    for (let moved = true; moved; ) {
      moved = false;
      for (const sec of this.#secrets) {
        for (let i = raw.indexOf(sec); i !== -1 && i < cut; i = raw.indexOf(sec, i + 1)) {
          if (i + sec.length > cut) {
            cut = i;
            moved = true;
          }
        }
      }
    }
    return cut;
  }
}

/**
 * The events to emit for `e` (#109): a `message.delta` goes through `deltas` (and may be held
 * back, giving nothing); any other event first lets out the held text as a delta, then goes out
 * itself. Everything is scrubbed of `secrets` and of known key formats.
 */
export function scrubbedEvents(
  deltas: DeltaScrubber,
  secrets: readonly string[],
  e: AgentEvent,
): AgentEvent[] {
  if (e.t === 'message.delta') {
    const text = deltas.push(e.text);
    return text ? [redactSecrets({ ...e, text })] : [];
  }
  const held = deltas.flush();
  return [
    ...(held ? [redactSecrets({ t: 'message.delta' as const, text: held })] : []),
    scrubLiterals(redactSecrets(e), secrets),
  ];
}
