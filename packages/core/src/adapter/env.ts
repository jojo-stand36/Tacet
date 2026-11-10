/**
 * The environment a Worker process starts with (#147). A Worker gets an allowlist of the user's
 * environment, not all of it, so a Worker of one vendor (or any `acp:<slug>` binary) does not
 * also receive other vendors' keys and unrelated secrets: a base set every process needs, a set
 * of toolchain locations builds and tests need, the adapter's own variables, and what the user
 * passes through in `workers.env.pass`.
 *
 * This limits accidental exposure (environment dumps in transcripts, test logs, third-party agent
 * binaries). It is not a boundary against a hostile Worker, which runs as the user and can read
 * the user's files (ARCHITECTURE.md §6).
 */

/** Variables any process expects: identity, locale, terminal, temp dirs, proxies and CAs. */
export const BASE_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  // Proxies, both spellings in use.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // Commit identity, for users who set it in the environment rather than in ~/.gitconfig.
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'DO_NOT_TRACK',
  // Trust stores for corporate proxies.
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
];
export const BASE_ENV_PREFIXES: readonly string[] = ['LC_'];

/** Where the user's toolchains live, so a Worker's builds and tests find them. No secrets. */
export const TOOLCHAIN_ENV_NAMES: readonly string[] = [
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'GOBIN',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'NVM_DIR',
  'NVM_BIN',
  'VOLTA_HOME',
  'FNM_DIR',
  'PNPM_HOME',
  'COREPACK_HOME',
  'PYENV_ROOT',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'RBENV_ROOT',
  'GEM_HOME',
  'GEM_PATH',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'DOTNET_ROOT',
  'HOMEBREW_PREFIX',
  'HOMEBREW_CELLAR',
  'HOMEBREW_REPOSITORY',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
];

/** Variables an adapter's vendor process needs, by exact name or by prefix. */
export interface EnvAllow {
  names?: readonly string[];
  prefixes?: readonly string[];
}

/**
 * How a Worker's environment is chosen. Filtered by default; `inherit: 'all'` is for interactive
 * sessions only, which run as the user's own tool with the user's own environment.
 */
export type WorkerEnvPolicy =
  | { inherit: 'all' }
  | {
      inherit?: 'allowlist';
      /** `workers.env.pass`: exact names, or prefixes ending in `*`. */
      pass?: readonly string[];
    };

/** An entry of `workers.env.pass`: a variable name, or a prefix ending in `*` (not `*` alone). */
export const ENV_PASS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

/**
 * Whether a variable name looks like it holds a secret. A prefix in `workers.env.pass` never
 * lets one of these through; only an exact name does.
 */
export function looksSecret(name: string): boolean {
  const n = name.toUpperCase();
  return (
    /(^|_)(KEY|KEYS|APIKEY|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASS|CREDENTIAL|CREDENTIALS|AUTH|DSN|COOKIE|PRIVATE|SESSION|SIGNATURE)(_|$)/.test(
      n,
    ) ||
    /(API_?KEY|ACCESS_?KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)/.test(n) ||
    n.startsWith('AWS_')
  );
}

/** Whether a `workers.env.pass` entry would pass a secret-looking variable by its exact name. */
export function passesSecret(pattern: string): boolean {
  return !pattern.endsWith('*') && looksSecret(pattern);
}

export interface WorkerEnv {
  env: Record<string, string>;
  /** Names (never values) of the variables left out, for diagnosing a failing build. */
  dropped: string[];
}

/**
 * The Worker's environment from `base` (the user's): the allowlist above, the adapter's own
 * `vendor` variables and the user's passthrough. Tacet's own per-session variables are added by
 * the caller afterwards, unfiltered.
 */
export function workerEnv(
  base: Record<string, string | undefined>,
  vendor: EnvAllow,
  policy: WorkerEnvPolicy = {},
): WorkerEnv {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  const all = policy.inherit === 'all';
  const pass = policy.inherit === 'all' ? [] : (policy.pass ?? []);
  const names = new Set([
    ...BASE_ENV_NAMES,
    ...TOOLCHAIN_ENV_NAMES,
    ...(vendor.names ?? []),
    ...pass.filter((p) => !p.endsWith('*')),
  ]);
  const prefixes = [...BASE_ENV_PREFIXES, ...(vendor.prefixes ?? [])];
  const passPrefixes = pass.filter((p) => p.endsWith('*')).map((p) => p.slice(0, -1));
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const keep =
      all ||
      names.has(k) ||
      prefixes.some((p) => k.startsWith(p)) ||
      (passPrefixes.some((p) => k.startsWith(p)) && !looksSecret(k));
    if (keep) env[k] = v;
    else dropped.push(k);
  }
  return { env, dropped: dropped.sort() };
}

/** The Worker environment policy an effective config asks for (`workers.env.pass`). */
export function workerEnvPolicy(config: {
  workers?: { env?: { pass?: readonly string[] } };
}): WorkerEnvPolicy {
  return { pass: [...(config.workers?.env?.pass ?? [])] };
}
