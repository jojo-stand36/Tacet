/** Patterns of credentials that must never appear in a config file. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  // The auth scheme is case-insensitive (RFC 9110 §11.1), as is `parseBearer`.
  ['bearer token', /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export interface SecretFinding {
  path: string;
  kind: string;
}

/**
 * Find literal credentials in parsed config. Findings name the key path and the kind of secret,
 * never the value, so the error message itself cannot leak it.
 */
export function findSecrets(value: unknown, path = ''): SecretFinding[] {
  if (typeof value === 'string') {
    const hit = SECRET_PATTERNS.find(([, re]) => re.test(value));
    return hit ? [{ path: path || '(root)', kind: hit[0] }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, `${path}[${i}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => findSecrets(v, path ? `${path}.${k}` : k));
  }
  return [];
}

const GLOBAL_PATTERNS = SECRET_PATTERNS.map(([, re]) => new RegExp(re.source, `${re.flags}g`));

/**
 * Copy of `value` with every substring that looks like a credential replaced by `[redacted]`.
 * Adapters run tool inputs through this before emitting `tool.call` events (ADR-003 §1).
 * Pattern-based, so it catches well-known key formats only; it is a safety net, not a guarantee.
 */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    // A PEM block cannot be cut out by its header alone, so the whole string goes.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return '[redacted]' as T;
    return GLOBAL_PATTERNS.reduce((s, re) => s.replace(re, '[redacted]'), value as string) as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSecrets(v)])) as T;
  }
  return value;
}
