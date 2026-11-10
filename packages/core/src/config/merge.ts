import { passesSecret } from '../adapter/env.js';
import { DEFAULT_CONFIG, TacetConfig, validateEffective } from './schema.js';

/** Config layers, lowest precedence first (ARCHITECTURE.md §4). */
export const LAYER_ORDER = ['default', 'user', 'repo', 'local', 'task'] as const;
export type LayerName = (typeof LAYER_ORDER)[number];

export interface ConfigLayer {
  name: LayerName;
  /** Where the layer came from, e.g. a file path; for messages and `explain`. */
  origin: string;
  data: TacetConfig;
}

/**
 * Arrays that are combined across layers instead of replaced, so a higher layer cannot drop a
 * safety rule set lower down. Every other array is replaced by the higher layer.
 */
export const UNION_PATHS: ReadonlySet<string> = new Set([
  'policies',
  'escalation.always_ask',
  // A local file adds to the repo's Worker passthrough instead of dropping it (#147).
  'workers.env.pass',
]);

/**
 * Objects that a higher layer replaces whole instead of merging key by key: secret references
 * (`{ env }` or `{ keychain }`). Merging them would keep the lower layer's credential source next
 * to the higher one's.
 */
export function isAtomicPath(segments: readonly string[]): boolean {
  // Decided by position, not by the dotted path: record keys (secret names, agent names, env
  // variable names) may themselves contain dots or be empty.
  return (
    (segments.length === 2 && segments[0] === 'secrets') ||
    (segments.length === 4 && segments[0] === 'agents' && segments[2] === 'env')
  );
}

export interface ExplainEntry {
  path: string;
  value: unknown;
  /** The layer(s) that set this value; several for unioned arrays. */
  sources: { layer: LayerName; origin: string }[];
}

export interface EffectiveConfig {
  config: TacetConfig;
  explain: ExplainEntry[];
  errors: string[];
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Merge layers into the effective config. Rules: objects merge key by key; scalars and arrays
 * from a higher layer replace lower ones, except the arrays in `UNION_PATHS`, which are
 * concatenated in layer order with duplicates removed. Layers are applied in `LAYER_ORDER`
 * regardless of argument order, so the result is deterministic.
 */
export function mergeConfig(
  layers: ConfigLayer[],
  defaults: TacetConfig = DEFAULT_CONFIG,
): EffectiveConfig {
  const all: ConfigLayer[] = [
    { name: 'default' as const, origin: 'built-in defaults', data: defaults } satisfies ConfigLayer,
    ...layers.filter((l) => l.name !== 'default'),
  ].sort((a, b) => LAYER_ORDER.indexOf(a.name) - LAYER_ORDER.indexOf(b.name));

  const sources = new Map<string, { layer: LayerName; origin: string }[]>();
  const merged: Plain = {};

  const apply = (
    target: Plain,
    value: Plain,
    layer: ConfigLayer,
    prefix: string,
    segments: readonly string[],
  ) => {
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const src = { layer: layer.name, origin: layer.origin };
      if (UNION_PATHS.has(path) && Array.isArray(v)) {
        const prev = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
        const seen = new Set(prev.map((x) => JSON.stringify(x)));
        const added = v.filter((x) => !seen.has(JSON.stringify(x)));
        target[key] = [...prev, ...added];
        if (added.length > 0 || !sources.has(path)) {
          sources.set(path, [...(sources.get(path) ?? []), src]);
        }
      } else if (isPlain(v) && !isAtomicPath([...segments, key])) {
        if (!isPlain(target[key])) {
          target[key] = {};
          for (const p of [...sources.keys()])
            if (p === path || p.startsWith(`${path}.`)) sources.delete(p);
        }
        apply(target[key] as Plain, v, layer, path, [...segments, key]);
      } else {
        target[key] = structuredClone(v);
        for (const p of [...sources.keys()]) if (p.startsWith(`${path}.`)) sources.delete(p);
        sources.set(path, [src]);
      }
    }
  };
  const layerErrors: string[] = [];
  for (const layer of all) {
    if (layer.name === 'task') {
      layerErrors.push(...taskRaisesWorkers(merged, layer), ...taskSetsTierBounds(layer));
    }
    layerErrors.push(...workerEnvErrors(layer));
    if (layer.name === 'task' && layer.data.verify !== undefined) {
      // A task could otherwise turn every check off (`[]`) or run shell outside any Worker (#19).
      layerErrors.push(
        `verify: the task layer (${layer.origin}) may not change the verify commands`,
      );
    }
    if (layer.name === 'task') {
      // Nor weaken it: choose the reviewer, waive cross-vendor review, or claim a vendor (#19).
      const tiers = layer.data.tiers ?? {};
      if (tiers.review !== undefined) {
        layerErrors.push(
          `tiers.review: the task layer (${layer.origin}) may not change the reviewer`,
        );
      }
      for (const [name, tier] of Object.entries(tiers)) {
        if (tier?.vendor !== undefined) {
          layerErrors.push(
            `tiers.${name}.vendor: the task layer (${layer.origin}) may not declare a vendor`,
          );
        }
      }
    }
    if (layer.name === 'task' && layer.data.review?.enabled === false) {
      // A task may ask for review, never skip one the repo or the user asked for (#19).
      layerErrors.push(`review.enabled: the task layer (${layer.origin}) may not turn review off`);
    }
    apply(merged, layer.data as Plain, layer, '', []);
  }

  const explain: ExplainEntry[] = [];
  const walk = (value: unknown, path: string, segments: readonly string[]) => {
    if (isPlain(value) && !UNION_PATHS.has(path) && !isAtomicPath(segments)) {
      const keys = Object.keys(value).sort();
      if (keys.length === 0 && path)
        explain.push({ path, value: {}, sources: sources.get(path) ?? [] });
      for (const k of keys) walk(value[k], path ? `${path}.${k}` : k, [...segments, k]);
    } else {
      explain.push({ path, value, sources: sources.get(path) ?? [] });
    }
  };
  walk(merged, '', []);

  const config = merged as TacetConfig;
  // Each layer was validated on its own; check the combination too, so a merge rule that
  // produces a shape no layer could have written is reported instead of used.
  const parsed = TacetConfig.safeParse(config);
  const shapeErrors = parsed.success
    ? []
    : parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return {
    config,
    explain,
    errors: [...layerErrors, ...shapeErrors, ...validateEffective(config)],
  };
}

/** Tier bounds (#110) are the user's and the repo's to set: a task may not set them, to widen or to narrow. */
function taskSetsTierBounds(layer: ConfigLayer): string[] {
  const errors: string[] = [];
  for (const [role, t] of Object.entries(layer.data.tiers ?? {})) {
    for (const key of ['models', 'max_effort', 'max_context_window'] as const) {
      if (t[key] !== undefined) {
        errors.push(`tiers.${role}.${key}: the task layer (${layer.origin}) may not set it`);
      }
    }
  }
  return errors;
}

/**
 * The Worker pool is repo-wide, so a task may only lower `workers.*`, never raise it (owner
 * decision on #125, 2026-11-09). A raise is an error. A `per_adapter` cap the layers below do not
 * set is compared with `workers.max`.
 */
function taskRaisesWorkers(merged: Plain, layer: ConfigLayer): string[] {
  const w = layer.data.workers;
  if (!w) return [];
  const below = (isPlain(merged.workers) ? merged.workers : {}) as NonNullable<
    TacetConfig['workers']
  >;
  const errors: string[] = [];
  const check = (path: string, value: number | undefined, limit: number | undefined) => {
    if (value !== undefined && limit !== undefined && value > limit) {
      errors.push(
        `workers.${path}: the task layer (${layer.origin}) may only lower it, not raise it to ${value} (currently ${limit})`,
      );
    }
  };
  for (const key of [
    'max',
    'stuck_after_s',
    'nudge_grace_s',
    'max_attempts',
    'verify_timeout_s',
    'verify_fix_attempts',
  ] as const) {
    check(key, w[key], below[key]);
  }
  for (const [id, cap] of Object.entries(w.per_adapter ?? {})) {
    check(`per_adapter.${id}`, cap, below.per_adapter?.[id] ?? below.max);
  }
  return errors;
}

/**
 * Who may widen a Worker's environment (#147): not the task layer at all, and not the committed
 * repo layer with a secret-looking name, which other people write. Prefixes are fine anywhere a
 * pass is allowed: they never let a secret-looking name through.
 */
function workerEnvErrors(layer: ConfigLayer): string[] {
  const pass = layer.data.workers?.env?.pass;
  if (!layer.data.workers?.env) return [];
  if (layer.name === 'task') {
    return [`workers.env: the task layer (${layer.origin}) may not change a Worker's environment`];
  }
  if (layer.name !== 'repo') return [];
  return (pass ?? [])
    .filter(passesSecret)
    .map(
      (p) =>
        `workers.env.pass: ${p} looks like a secret; the repo layer (${layer.origin}) may not pass it to Workers. Name it in your user or local config instead.`,
    );
}

/** Human-readable `tacet config explain` output: one line per value with its source. */
export function formatExplain(effective: EffectiveConfig): string {
  return effective.explain
    .map((e) => {
      const from = e.sources
        .map((s) => (s.layer === 'default' ? 'default' : `${s.layer} (${s.origin})`))
        .join(' + ');
      return `${e.path} = ${JSON.stringify(e.value)}    # ${from || 'unknown'}`;
    })
    .join('\n');
}
