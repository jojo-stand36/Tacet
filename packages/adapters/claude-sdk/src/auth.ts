import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
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
 * Code 2.1.319 (capability matrix §1, "Worker environment"). `ANTHROPIC_*` and `CLAUDE_*` pass
 * only names that do not look secret (base URL, model overrides, config dir, cert paths); the
 * credentials pass by name. A cloud provider route the user chose adds its own credentials:
 * Bedrock the whole `AWS_*` chain; Vertex the Google project and credentials file; Foundry its
 * keys and the Azure identity variables found in the binary (the exact Azure set is
 * unverified: pass others with `workers.env.pass`). Never `GOOGLE_*` or `AZURE_*` as a whole,
 * which hold other products' keys (`GOOGLE_API_KEY`, `AZURE_OPENAI_API_KEY`).
 */
export function claudeEnvAllow(env: Record<string, string | undefined>): EnvAllow {
  // As `authEnv` reads them: set, and not `0`.
  const on = (k: string) => Boolean(env[k]) && env[k] !== '0';
  const names = [
    ...API_KEY_VARS,
    'CLAUDE_CODE_CLIENT_CERT',
    'CLAUDE_CODE_CLIENT_KEY',
    'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
    // The user's opt-outs and timeouts, from Claude Code's environment reference.
    'DISABLE_TELEMETRY',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_AUTOUPDATER',
    'DISABLE_UPDATES',
    'API_TIMEOUT_MS',
  ];
  const prefixes = ['ANTHROPIC_', 'CLAUDE_'];
  const credentialPrefixes: string[] = [];
  if (on('CLAUDE_CODE_USE_BEDROCK')) credentialPrefixes.push('AWS_');
  if (on('CLAUDE_CODE_USE_VERTEX')) {
    names.push('GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT');
    prefixes.push('CLOUD_ML_', 'VERTEX_', 'CLOUDSDK_');
  }
  if (on('CLAUDE_CODE_USE_FOUNDRY')) {
    names.push(
      'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
      'AZURE_CLIENT_ID',
      'AZURE_TENANT_ID',
      'AZURE_CLIENT_SECRET',
      'AZURE_FEDERATED_TOKEN_FILE',
      'AZURE_CONFIG_DIR',
    );
  }
  return { names, prefixes, credentialPrefixes };
}

/**
 * The commands a Claude Code Worker runs (its Bash tool, hooks, stdio MCP servers) must not see
 * its API key (#150). Claude Code strips credentials from them with
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which on Linux needs bubblewrap: verified live on
 * 2.1.319, without `bwrap` Claude Code refuses to start ("bubblewrap is required for subprocess
 * env scrubbing and isolation"). Owner decision (#150): fail closed, so a Linux user without
 * bubblewrap is told to install it rather than running Workers whose commands see the key.
 * Returns `env` with the scrub on; throws `SubprocessScrubError` when it cannot work.
 */
export function withSubprocessScrub(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (platform === 'linux' && !onPath('bwrap', env.PATH)) {
    throw new SubprocessScrubError(
      'Claude Workers on Linux need bubblewrap (bwrap) on PATH, so the commands they run never see the API key; install it, e.g. `sudo apt-get install bubblewrap`',
    );
  }
  return { ...env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
}

export class SubprocessScrubError extends Error {
  override name = 'SubprocessScrubError';
}

function onPath(name: string, path: string | undefined): boolean {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not here.
    }
  }
  return false;
}
