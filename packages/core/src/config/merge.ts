import { DEFAULT_CONFIG, type TacetConfig, validateEffective } from './schema.js';

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
export const UNION_PATHS: ReadonlySet<string> = new Set(['policies', 'escalation.always_ask']);

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

  const apply = (target: Plain, value: Plain, layer: ConfigLayer, prefix: string) => {
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
      } else if (isPlain(v)) {
        if (!isPlain(target[key])) {
          target[key] = {};
          for (const p of [...sources.keys()])
            if (p === path || p.startsWith(`${path}.`)) sources.delete(p);
        }
        apply(target[key] as Plain, v, layer, path);
      } else {
        target[key] = structuredClone(v);
        for (const p of [...sources.keys()]) if (p.startsWith(`${path}.`)) sources.delete(p);
        sources.set(path, [src]);
      }
    }
  };
  for (const layer of all) apply(merged, layer.data as Plain, layer, '');

  const explain: ExplainEntry[] = [];
  const walk = (value: unknown, path: string) => {
    if (isPlain(value) && !UNION_PATHS.has(path)) {
      const keys = Object.keys(value).sort();
      if (keys.length === 0 && path)
        explain.push({ path, value: {}, sources: sources.get(path) ?? [] });
      for (const k of keys) walk(value[k], path ? `${path}.${k}` : k);
    } else {
      explain.push({ path, value, sources: sources.get(path) ?? [] });
    }
  };
  walk(merged, '');

  const config = merged as TacetConfig;
  return { config, explain, errors: validateEffective(config) };
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
