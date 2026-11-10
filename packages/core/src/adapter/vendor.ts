/**
 * The model vendors cross-vendor review tells apart (#19): a reviewer from a different vendor
 * than the author (Omnigent's Polly pattern, ADR-001).
 */
export const VENDORS = ['anthropic', 'openai', 'google'] as const;
export type Vendor = (typeof VENDORS)[number];

/** Built-in adapter ids and whose models they run. */
const BUILTIN: Readonly<Record<string, Vendor>> = {
  'claude-sdk': 'anthropic',
  'pty:claude': 'anthropic',
  'acp:claude-acp': 'anthropic',
  'codex-app-server': 'openai',
  'acp:codex-acp': 'openai',
  'acp:gemini': 'google',
};

/**
 * Whose models an adapter runs: the tier's declared `vendor`, else the built-in adapter's, else
 * `undefined` (OpenCode and custom `acp:`/`pty:` agents can run any vendor's models).
 */
export function vendorOf(
  adapterId: string,
  tier: { vendor?: Vendor | undefined } = {},
): Vendor | undefined {
  return tier.vendor ?? BUILTIN[adapterId];
}
