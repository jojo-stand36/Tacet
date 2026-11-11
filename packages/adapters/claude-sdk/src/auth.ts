import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { EnvAllow } from '@tacet/core';
import { checkHostClaudeToken } from '@tacet/core/node';

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
  hostToken: { warn?: (message: string) => void; file?: string } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  const hasCloud = CLOUD_PROVIDER_VARS.some((k) => out[k] && out[k] !== '0');
  if (route === 'api_key') {
    const hasKey = API_KEY_VARS.some((k) => out[k]);
    if (!hasKey && !hasCloud) {
      throw new AuthRoutingError(
        'unattended Claude Workers need ANTHROPIC_API_KEY (or a cloud provider such as CLAUDE_CODE_USE_BEDROCK) in the environment',
      );
    }
    // In a Claude Code cloud container the host's token is there too (#291): a warning.
    checkHostClaudeToken({ hasKey: true, ...hostToken });
    return out;
  }
  for (const k of API_KEY_VARS) delete out[k];
  // A login session with the host's token in reach would use it, not the user's own (#291).
  checkHostClaudeToken({ hasKey: hasCloud, ...hostToken });
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
  if (platform === 'linux') {
    const problem = sandboxProblem(env.PATH);
    if (problem) {
      throw new SubprocessScrubError(
        `Claude's sandbox can't run here: ${problem}. Claude Workers on Linux run their commands in it, so those never see the API key; it needs bubblewrap and socat (e.g. \`sudo apt-get install bubblewrap socat\`) and user namespaces (see docs/ARCHITECTURE.md §6, #150)`,
      );
    }
  }
  return { ...env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
}

/** Probe results by PATH: the probe runs bwrap once per process and PATH. */
const probed = new Map<string, string | undefined>();

/**
 * Why Claude Code's Linux sandbox cannot run, or `undefined` if it can. With the scrub on, Claude
 * Code 2.1.319 makes the sandbox mandatory: without `bwrap` it refuses to start, and without
 * `socat` it starts but refuses every Bash command ("Sandbox dependencies not available: socat
 * not installed", seen on CI, #150). Both must be on the Worker's PATH, and bwrap must be able to
 * make its namespaces (AppArmor or a sysctl can forbid that), checked by running it once.
 */
function sandboxProblem(path: string | undefined): string | undefined {
  const key = path ?? '';
  if (probed.has(key)) return probed.get(key);
  const bwrap = onPath('bwrap', path);
  let problem: string | undefined;
  if (!bwrap) problem = 'bubblewrap (bwrap) is not on PATH';
  else if (!onPath('socat', path)) problem = 'socat is not on PATH';
  else {
    try {
      execFileSync(
        bwrap,
        ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', 'true'],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 },
      );
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim().split('\n')[0];
      problem = `bubblewrap cannot create its sandbox (${stderr || (err as Error).message})`;
    }
  }
  probed.set(key, problem);
  return problem;
}

export class SubprocessScrubError extends Error {
  override name = 'SubprocessScrubError';
}

/** The executable `name` in an absolute PATH entry, or `undefined`. */
function onPath(name: string, path: string | undefined): string | undefined {
  // Absolute entries only: a relative one would resolve against Tacet's own directory.
  for (const dir of (path ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    try {
      const file = join(dir, name);
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}
