import type { EnvAllow } from '@tacet/core';

/**
 * Auth routing for Codex Workers (owner policy, 2026-11-09; docs/RESEARCH.md §7):
 * - `api_key`: parallel or unattended Workers use the user's own OpenAI API key from the
 *   environment. Codex reads it itself through a model provider whose `env_key` names the
 *   variable, so Tacet never handles the key and nothing secret is on the command line.
 * - `subscription`: interactive sessions use the user's own Codex login (`codex login`, made in
 *   Codex), through Codex's built-in `openai` provider.
 * Tacet never logs in on the user's behalf and never implements `chatgptAuthTokens`, which the
 * 0.167.0 schema marks "FOR OPENAI INTERNAL USE ONLY" (spike #59).
 *
 * Verified against the openai/codex source at rust-v0.167.0 and a live run (#12): in app-server
 * mode the built-in `openai` provider does not read `OPENAI_API_KEY` or `CODEX_API_KEY` from the
 * environment, while a provider with `env_key` sends `Authorization: Bearer $<env_key>`.
 */
export type CodexAuthRoute = 'api_key' | 'subscription';

/** Provider id Tacet adds for the API-key route. */
export const API_KEY_PROVIDER_ID = 'tacet-openai-api-key';
/** Codex's default Responses API base URL for API-key auth (model-provider-info, 0.167.0). */
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

const KEY_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const;
/**
 * Debug logging for the Rust binary. At trace level it may write protocol traffic (including the
 * thread config with MCP headers) to its logs; whether it does is unverified, so Workers never
 * inherit it.
 */
const STRIPPED_VARS = ['RUST_LOG', 'RUST_BACKTRACE'] as const;

export class AuthRoutingError extends Error {
  override name = 'AuthRoutingError';
}

/**
 * Pick the route from config (`auth.interactive`) and the session kind. Parallel or unattended
 * sessions always use the API key (owner decision on #65).
 */
export function chooseAuthRoute(
  session: { interactive: boolean },
  config: { unattended?: 'api_key'; interactive?: CodexAuthRoute } = {},
): CodexAuthRoute {
  return session.interactive ? (config.interactive ?? 'subscription') : 'api_key';
}

export interface CodexLaunch {
  /** Environment for `codex app-server`. Values are the user's own, passed through untouched. */
  env: Record<string, string>;
  /** `-c key=value` overrides for `codex app-server`. They hold variable names, never values. */
  args: string[];
}

/** TOML string literal for a `-c` override value. */
function toml(value: string): string {
  return JSON.stringify(value);
}

/**
 * Environment and launch arguments for `route`. `api_key` requires `OPENAI_API_KEY` (or
 * `CODEX_API_KEY`) and fails otherwise, so an unattended Worker never silently falls back to the
 * user's login. `subscription` removes the key variables so the user's own login applies.
 */
export function codexLaunch(
  route: CodexAuthRoute,
  env: Record<string, string | undefined>,
  opts: { baseUrl?: string } = {},
): CodexLaunch {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  for (const k of STRIPPED_VARS) delete out[k];
  if (route === 'subscription') {
    for (const k of KEY_VARS) delete out[k];
    return { env: out, args: [] };
  }
  const envKey = KEY_VARS.find((k) => out[k]);
  if (!envKey) {
    throw new AuthRoutingError(
      'unattended Codex Workers need OPENAI_API_KEY (or CODEX_API_KEY) in the environment',
    );
  }
  const p = `model_providers.${API_KEY_PROVIDER_ID}`;
  return {
    env: out,
    args: [
      '-c',
      `model_provider=${toml(API_KEY_PROVIDER_ID)}`,
      '-c',
      `${p}.name=${toml('OpenAI (API key, via Tacet)')}`,
      '-c',
      `${p}.base_url=${toml(opts.baseUrl ?? OPENAI_API_BASE_URL)}`,
      '-c',
      `${p}.env_key=${toml(envKey)}`,
      '-c',
      `${p}.wire_api=${toml('responses')}`,
    ],
  };
}

/**
 * The variables a Codex Worker needs beyond the common base set (#147), verified on Codex
 * 0.167.0 (capability matrix §2, "Worker environment"): `CODEX_*` (home, CA certificate, knobs)
 * and `OPENAI_*` (the key the provider's `env_key` names, organization, project). Codex does not
 * read `OPENAI_BASE_URL`.
 */
export const CODEX_ENV_ALLOW: EnvAllow = { prefixes: ['CODEX_', 'OPENAI_'] };
