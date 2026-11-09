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
