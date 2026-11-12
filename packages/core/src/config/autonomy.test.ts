import { describe, expect, it } from 'vitest';
import { type ConfigLayer, gateTimeoutMs, lowerAutonomy, mergeConfig } from './merge.js';
import type { TacetConfig } from './schema.js';

const layer = (
  name: ConfigLayer['name'],
  autonomy?: 'low' | 'medium' | 'high',
  extra: TacetConfig['escalation'] = {},
): ConfigLayer => ({
  name,
  origin: `${name} file`,
  data: { escalation: { ...(autonomy ? { autonomy } : {}), ...extra } },
});

describe('escalation.autonomy across layers (#25, ADR-004 B)', () => {
  const merged = (...layers: ConfigLayer[]) => mergeConfig(layers);

  it('is medium unless the user sets it', () => {
    expect(merged().config.escalation?.autonomy).toBe('medium');
    expect(merged(layer('user', 'high')).config.escalation?.autonomy).toBe('high');
  });

  it('lets the repo layer lower it, and ignores a raise with a warning', () => {
    const lowered = merged(layer('user', 'high'), layer('repo', 'low'));
    expect(lowered.config.escalation?.autonomy).toBe('low');
    expect(lowered.warnings).toEqual([]);
    const raised = merged(layer('repo', 'high'));
    expect(raised.config.escalation?.autonomy).toBe('medium');
    expect(raised.errors).toEqual([]);
    expect(raised.warnings).toEqual([
      'escalation.autonomy: high in the repo layer (repo file) is above the default medium and is ignored; only you can raise it, in your user or local config',
    ]);
    // `explain` names the layer whose level applies.
    expect(raised.explain.find((e) => e.path === 'escalation.autonomy')?.sources).toEqual([
      { layer: 'default', origin: 'built-in defaults' },
    ]);
  });

  it('lets the repo layer lower the default, and names it in explain', () => {
    const r = merged(layer('repo', 'low'));
    expect(r.config.escalation?.autonomy).toBe('low');
    expect(r.explain.find((e) => e.path === 'escalation.autonomy')?.sources).toEqual([
      { layer: 'repo', origin: 'repo file' },
    ]);
    expect(merged(layer('user', 'low'), layer('repo', 'high')).warnings[0]).toContain(
      'above your own low',
    );
  });

  it("lets the user's own local layer set it either way", () => {
    expect(
      merged(layer('user', 'low'), layer('repo', 'low'), layer('local', 'high')).config.escalation
        ?.autonomy,
    ).toBe('high');
  });

  it('lets a task only lower it', () => {
    expect(merged(layer('task', 'low')).config.escalation?.autonomy).toBe('low');
    // Against what the local layer left, which the user may have raised.
    const afterLocal = merged(layer('user', 'low'), layer('local', 'high'), layer('task', 'high'));
    expect(afterLocal.errors).toEqual([]);
    expect(afterLocal.config.escalation?.autonomy).toBe('high');
    expect(merged(layer('user', 'low'), layer('task', 'high')).errors).toEqual([
      'escalation.autonomy: the task layer (task file) may only lower it, not raise it to high (currently low)',
    ]);
  });
});

describe('escalation.gate_timeout_s', () => {
  it('defaults by autonomy, and may not be set by a task', () => {
    expect(gateTimeoutMs({ escalation: { autonomy: 'low' } })).toBe(3000);
    expect(gateTimeoutMs({ escalation: { autonomy: 'medium' } })).toBe(30_000);
    expect(gateTimeoutMs({ escalation: { autonomy: 'high' } }, 'low')).toBe(3000);
    expect(gateTimeoutMs({ escalation: { gate_timeout_s: 12.5 } })).toBe(12_500);
    // At low the gate never reasons: always 3 s.
    expect(gateTimeoutMs({ escalation: { autonomy: 'low', gate_timeout_s: 200 } })).toBe(3000);
    expect(mergeConfig([layer('user', undefined, { gate_timeout_s: 0.5 })]).errors).not.toEqual([]);
    expect(mergeConfig([layer('task', undefined, { gate_timeout_s: 5 })]).errors).toEqual([
      'escalation.gate_timeout_s: the task layer (task file) may not set it',
    ]);
    expect(mergeConfig([layer('user', undefined, { gate_timeout_s: 600 })]).errors).not.toEqual([]);
  });

  it('lowerAutonomy picks the lower', () => {
    expect(lowerAutonomy('high', 'low')).toBe('low');
    expect(lowerAutonomy('medium', 'high')).toBe('medium');
  });
});
