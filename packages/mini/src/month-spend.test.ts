import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_PRICES, type EventEnvelope, newUlid } from '@tacet/core';
import { conductorStatePaths, openEventStore, repoStatePaths } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { monthSpendElsewhere } from './month-spend.js';

describe('monthSpendElsewhere (#35, owner decision (a))', () => {
  let root: string;
  let stateDir: string;
  const env = (type: string, data: unknown, ts: string, taskId?: string): EventEnvelope => ({
    v: 1,
    id: newUlid(Date.parse(ts)),
    ts,
    source: { kind: 'conductor', id: 'c' },
    type,
    data,
    ...(taskId ? { taskId } : {}),
  });
  const repo = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    return { path, ...repoStatePaths(path, stateDir) };
  };
  const register = (...repos: ReturnType<typeof repo>[]) => {
    const store = openEventStore(conductorStatePaths(stateDir).events);
    store.append(
      repos.map((r) =>
        env(
          'registry.repo_added',
          { repoId: r.repoId, repoPath: r.path },
          '2026-11-01T00:00:00.000Z',
        ),
      ),
    );
    store.close();
  };
  const spend = (r: ReturnType<typeof repo>, costUsd: number, ts: string) => {
    const store = openEventStore(r.events);
    store.append(
      env(
        'agent.usage',
        { t: 'usage', inputTokens: 1, outputTokens: 1, costUsd, source: 'reported' },
        ts,
        'T',
      ),
    );
    store.close();
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-month-')));
    stateDir = join(root, 'state');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('sums what the other registered repos spent in the month, and not this repo', () => {
    const me = repo('me');
    const a = repo('a');
    const b = repo('b');
    register(me, a, b);
    spend(me, 100, '2026-11-02T00:00:00.000Z');
    spend(a, 1.5, '2026-11-02T00:00:00.000Z');
    spend(a, 9, '2026-10-31T23:59:59.000Z');
    spend(b, 2.25, '2026-11-20T00:00:00.000Z');
    let t = 0;
    const read = monthSpendElsewhere({
      stateDir,
      repoId: me.repoId,
      pricing: BUILTIN_PRICES,
      now: () => t,
    });
    expect(read?.('2026-11')).toBe(3.75);
    expect(read?.('2026-10')).toBe(9);
    // Readings are reused for a while, then read again.
    t = 1000;
    spend(a, 1, '2026-11-03T00:00:00.000Z');
    expect(read?.('2026-10')).toBe(9);
    expect(read?.('2026-11')).toBe(4.75);
  });

  it('is undefined when this repo is not registered, or no Conductor ever ran', () => {
    const me = repo('me');
    expect(
      monthSpendElsewhere({ stateDir, repoId: me.repoId, pricing: BUILTIN_PRICES }),
    ).toBeUndefined();
    register(repo('other'));
    expect(
      monthSpendElsewhere({ stateDir, repoId: me.repoId, pricing: BUILTIN_PRICES }),
    ).toBeUndefined();
  });

  it('counts nothing for a registered repo with no log yet', () => {
    const me = repo('me');
    register(me, repo('fresh'));
    expect(
      monthSpendElsewhere({ stateDir, repoId: me.repoId, pricing: BUILTIN_PRICES })?.('2026-11'),
    ).toBe(0);
  });
});
