/** Patterns of credentials that must never appear in a config file. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
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
