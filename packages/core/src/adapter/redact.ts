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
 * two `message.delta` events is missed by scrubbing each event alone. `push` returns the text
 * that is safe to emit now: everything seen so far with complete secrets replaced, minus the
 * shortest tail that could still be the start of a secret, which is held back (at most the
 * longest secret's length minus one). `flush` returns the held tail, for the end of the stream or
 * before an event that must not overtake the text. Text that cannot begin a secret is never held,
 * so ordinary streaming keeps its pace.
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
    const scrubbed = scrubLiterals(this.#held + text, this.#secrets);
    const hold = this.#holdLength(scrubbed);
    this.#held = scrubbed.slice(scrubbed.length - hold);
    return scrubbed.slice(0, scrubbed.length - hold);
  }

  flush(): string {
    const out = this.#held;
    this.#held = '';
    return out;
  }

  /** Length of the longest tail of `text` that some secret starts with. */
  #holdLength(text: string): number {
    for (let k = Math.min(this.#maxHold, text.length); k > 0; k--) {
      const tail = text.slice(text.length - k);
      if (this.#secrets.some((sec) => sec.startsWith(tail))) return k;
    }
    return 0;
  }
}
