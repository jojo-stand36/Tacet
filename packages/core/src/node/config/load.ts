import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import type { z } from 'zod';
import {
  type ConfigLayer,
  type EffectiveConfig,
  findSecrets,
  mergeConfig,
  TacetConfig,
} from '../../config/index.js';

/** Config file locations (ARCHITECTURE.md §4). `local.yaml` is personal and must be gitignored. */
export function configPaths(opts: { userDir?: string; repoRoot?: string }) {
  const userDir = opts.userDir ?? join(homedir(), '.tacet');
  return {
    user: join(userDir, 'config.yaml'),
    ...(opts.repoRoot
      ? {
          repo: join(opts.repoRoot, '.tacet', 'tacet.yaml'),
          local: join(opts.repoRoot, '.tacet', 'local.yaml'),
        }
      : {}),
  };
}

/** Every problem found while loading, so the user can fix them all in one pass. */
export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid Tacet config:\n  ${issues.join('\n  ')}`);
    this.issues = issues;
  }
}

export interface LoadConfigOptions {
  /** Defaults to `~/.tacet`. */
  userDir?: string;
  /** Repo root; omit outside a repo (user layer only). */
  repoRoot?: string;
  /** Task-level overrides from the UI or CLI: the highest layer. */
  task?: unknown;
}

function issueText(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') return `unknown key(s): ${issue.keys.join(', ')}`;
  return issue.message;
}

/** Parse and validate one layer. Returns the layer, or pushes `file:line:col: message` issues. */
function readLayer(
  name: ConfigLayer['name'],
  origin: string,
  text: string,
  issues: string[],
): ConfigLayer | undefined {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const where = (offset: number | undefined) => {
    if (offset === undefined) return origin;
    const { line, col } = lineCounter.linePos(offset);
    return `${origin}:${line}:${col}`;
  };
  if (doc.errors.length > 0) {
    for (const err of doc.errors)
      issues.push(`${where(err.pos[0])}: ${err.message.split('\n')[0]}`);
    return undefined;
  }
  const data: unknown = doc.toJS() ?? {};
  const secrets = findSecrets(data);
  for (const s of secrets) {
    const node = doc.getIn(
      s.path
        .split(/\.|\[|\]/)
        .filter(Boolean)
        .map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
      true,
    ) as { range?: [number, number, number] } | undefined;
    issues.push(
      `${where(node?.range?.[0])}: ${s.path} looks like a ${s.kind}; never put secrets in config, reference one instead, e.g. { env: "NAME" } or { keychain: "service/account" }`,
    );
  }
  if (secrets.length > 0) return undefined;
  const parsed = TacetConfig.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const node = doc.getIn(issue.path as (string | number)[], true) as
        | { range?: [number, number, number] }
        | undefined;
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      issues.push(`${where(node?.range?.[0])}: ${path}: ${issueText(issue)}`);
    }
    return undefined;
  }
  return { name, origin, data: parsed.data };
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Load and merge user, repo, local and task config. Missing files are skipped. Throws a
 * `ConfigError` listing every problem (YAML syntax, literal secrets, schema errors, cross-field
 * checks) with file, line and column.
 */
export function loadConfig(opts: LoadConfigOptions = {}): EffectiveConfig {
  const paths = configPaths(opts);
  const issues: string[] = [];
  const layers: ConfigLayer[] = [];
  for (const [name, path] of [
    ['user', paths.user],
    ['repo', paths.repo],
    ['local', paths.local],
  ] as const) {
    if (!path) continue;
    const text = readOptional(path);
    if (text === undefined) continue;
    const layer = readLayer(name, path, text, issues);
    if (layer) layers.push(layer);
  }
  if (opts.task !== undefined) {
    const layer = readLayer('task', 'task overrides', JSON.stringify(opts.task), issues);
    if (layer) layers.push(layer);
  }
  if (issues.length > 0) throw new ConfigError(issues);
  const effective = mergeConfig(layers);
  if (effective.errors.length > 0) throw new ConfigError(effective.errors);
  return effective;
}
