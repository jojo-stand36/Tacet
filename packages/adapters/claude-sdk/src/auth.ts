import type { EnvAllow } from '@tacet/core';

/**
 * Auth routing for Claude Workers (owner policy, 2026-11-09; docs/RESEARCH.md §7):
 * - `api_key`: parallel or unattended Workers use the user's own API key (or cloud provider
 *   credentials) from the environment.
 * - `subscription`: interactive sessions use the user's own Claude login inside the unmodified
 *   Claude Code binary.
 * Tacet never reads, stores, proxies or copies credentials: it only decides which variables the
 * vendor process inherits from the user's environment.
 */
export type ClaudeAuthRoute = 'api_key' | 'subscription';

/** Variables that make Claude Code use an API key or a cloud provider instead of a login. */
const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
const CLOUD_PROVIDER_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

export class AuthRoutingError extends Error {
  override name = 'AuthRoutingError';
}

/**
 * Pick the route from config (`auth.interactive`) and the session kind. Parallel or unattended
 * sessions always use the API key (owner decision on #65); the config schema rejects anything
 * else for `auth.unattended`.
 */
export function chooseAuthRoute(
  session: { interactive: boolean },
  config: { unattended?: 'api_key'; interactive?: ClaudeAuthRoute } = {},
): ClaudeAuthRoute {
  return session.interactive ? (config.interactive ?? 'subscription') : 'api_key';
}

/**
 * The environment for the Claude Code process on `route`, derived from the user's environment.
 * `api_key` requires an API key or cloud provider setting to be present and fails otherwise,
 * so an unattended Worker never silently falls back to the subscription login. `subscription`
 * removes API-key variables so the binary uses the user's own login. It leaves cloud provider
 * settings (`CLAUDE_CODE_USE_BEDROCK` and similar) alone: a user who set one chose that provider
 * for their own sessions, so an interactive session follows it. Values are passed through
 * untouched and never logged.
 */
export function authEnv(
  route: ClaudeAuthRoute,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  if (route === 'api_key') {
    const hasKey = API_KEY_VARS.some((k) => out[k]);
    const hasCloud = CLOUD_PROVIDER_VARS.some((k) => out[k] && out[k] !== '0');
    if (!hasKey && !hasCloud) {
      throw new AuthRoutingError(
        'unattended Claude Workers need ANTHROPIC_API_KEY (or a cloud provider such as CLAUDE_CODE_USE_BEDROCK) in the environment',
      );
    }
    return out;
  }
  for (const k of API_KEY_VARS) delete out[k];
  return out;
}

/**
 * The variables a Claude Code Worker needs beyond the common base set (#147), verified on Claude
 * Code 2.1.319 (capability matrix §1, "Worker environment"): `ANTHROPIC_*` and `CLAUDE_*` cover
 * the key, base URL, model overrides, mTLS and config dir. A cloud provider route the user chose
 * adds its own credential chain: Bedrock `AWS_*`; Vertex `CLOUD_ML_*`, `VERTEX_*`, `GOOGLE_*`,
 * `GCLOUD_*`, `CLOUDSDK_*`; Foundry `AZURE_*` (the exact Azure set is unverified).
 */
export function claudeEnvAllow(base: Record<string, string | undefined>): EnvAllow {
  const on = (k: string) => base[k] !== undefined && base[k] !== '' && base[k] !== '0';
  const prefixes = ['ANTHROPIC_', 'CLAUDE_'];
  if (on('CLAUDE_CODE_USE_BEDROCK')) prefixes.push('AWS_');
  if (on('CLAUDE_CODE_USE_VERTEX')) {
    prefixes.push('CLOUD_ML_', 'VERTEX_', 'GOOGLE_', 'GCLOUD_', 'CLOUDSDK_');
  }
  if (on('CLAUDE_CODE_USE_FOUNDRY')) prefixes.push('AZURE_');
  return {
    prefixes,
    // The user's opt-outs and timeouts, documented in Claude Code's environment reference.
    names: [
      'DISABLE_TELEMETRY',
      'DISABLE_ERROR_REPORTING',
      'DISABLE_AUTOUPDATER',
      'DO_NOT_TRACK',
      'API_TIMEOUT_MS',
    ],
  };
}
