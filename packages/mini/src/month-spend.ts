import { existsSync } from 'node:fs';
import { costLedgerProjection, type PricingTable, project, registryProjection } from '@tacet/core';
import { conductorStatePaths, openEventStore, repoStatePaths } from '@tacet/core/node';

/** What {@link monthSpendElsewhere} reads, beside the clock. */
export interface MonthSpendOptions {
  /** The state directory this repo's Mini-conductor and the Conductor use. */
  stateDir: string;
  /** This repo's id: its own spend is counted live, by its Mini-conductor. */
  repoId: string;
  pricing: PricingTable;
  /** How long a reading is reused, in ms. Default 60000. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * For the machine-wide month cap (#35, owner decision (a)): what every other repo registered with
 * the Conductor spent in a month, read from their event logs (read-only) and priced the same way.
 * Undefined when this repo is not registered (or no Conductor ever ran): the cap then counts this
 * repo alone, and the run says so.
 *
 * A repo whose log is not where this state directory puts it (another `events.state_dir`) is not
 * counted. A log that cannot be read counts nothing, rather than stop every run on the machine.
 * Readings are reused for `ttlMs`, so the logs are not read on every check.
 */
export function monthSpendElsewhere(o: MonthSpendOptions): ((month: string) => number) | undefined {
  const conductor = conductorStatePaths(o.stateDir).events;
  if (!existsSync(conductor)) return undefined;
  const registry = readRegistry(conductor);
  if (!registry || !Object.hasOwn(registry, o.repoId)) return undefined;
  const ttl = o.ttlMs ?? 60_000;
  const now = o.now ?? Date.now;
  let cached: { month: string; at: number; usd: number } | undefined;
  return (month) => {
    if (cached && cached.month === month && now() - cached.at < ttl) return cached.usd;
    let usd = 0;
    // Registrations can change while this runs: read them again with each reading.
    for (const repo of Object.values(readRegistry(conductor) ?? {})) {
      if (repo.repoId === o.repoId) continue;
      const events = repoStatePaths(repo.repoPath, o.stateDir).events;
      if (!existsSync(events)) continue;
      try {
        const store = openEventStore(events, { readonly: true });
        try {
          usd += store.replay(costLedgerProjection(o.pricing)).months[month]?.usd ?? 0;
        } finally {
          store.close();
        }
      } catch {
        // Unreadable (being written for the first time, or damaged): counts nothing.
      }
    }
    cached = { month, at: now(), usd: Math.round(usd * 1e6) / 1e6 };
    return cached.usd;
  };
}

function readRegistry(path: string) {
  try {
    const store = openEventStore(path, { readonly: true });
    try {
      return project(
        registryProjection,
        store.query({ typePrefix: 'registry' }).map((e) => e.envelope),
      ).repos;
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
}
