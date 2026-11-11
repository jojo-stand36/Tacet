import type { EventEnvelope } from '../schema/envelope.js';

/** How a repo's escalations went (#25): what the gate kept from the user, and what reached them. */
export interface EscalationStats {
  /** Escalations Workers raised (MCP `escalate`, or a repo-wide proposal to approve). */
  raised: number;
  /** Of those, answered without the user: by repo policy, by precedent, by the Mini-conductor. */
  resolvedLocally: { policy: number; precedent: number; mini: number };
  /** Of those, answered by the user. */
  answeredByUser: number;
  /** Of those, answered with no recorded source (logs from before `source` was written). */
  answeredUnknown: number;
  /** Of those, still waiting on an answer. */
  open: number;
  /**
   * The share of Worker escalations that went to the user: those not answered locally, over all
   * raised. Undefined when none were raised.
   */
  rate: number | undefined;
  /** Escalations the Mini-conductor raised itself (blocked Workers, conflicts): always the user's. */
  raisedByMini: number;
}

/**
 * Count escalations from the log (#25's "measured escalation rate"): every `escalation.raised`
 * at or after `since` (an ISO time; all when absent), with how each was resolved. It reads only
 * summary-grade events, which retention keeps, so it gives the same answer after compaction.
 */
export function escalationStats(
  events: Iterable<EventEnvelope>,
  opts: { since?: string } = {},
): EscalationStats {
  const raised = new Map<string, { byWorker: boolean }>();
  const resolvedBy = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'escalation.raised') {
      const id = (e.data as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      if (opts.since !== undefined && e.ts < opts.since) continue;
      raised.set(id, { byWorker: e.source.kind === 'worker' });
    } else if (e.type === 'escalation.resolved') {
      const d = e.data as { escalationId?: unknown; source?: unknown };
      if (typeof d.escalationId !== 'string' || resolvedBy.has(d.escalationId)) continue;
      resolvedBy.set(d.escalationId, typeof d.source === 'string' ? d.source : '');
    }
  }
  const s: EscalationStats = {
    raised: 0,
    resolvedLocally: { policy: 0, precedent: 0, mini: 0 },
    answeredByUser: 0,
    answeredUnknown: 0,
    open: 0,
    rate: undefined,
    raisedByMini: 0,
  };
  for (const [id, r] of raised) {
    if (!r.byWorker) {
      s.raisedByMini += 1;
      continue;
    }
    s.raised += 1;
    const by = resolvedBy.get(id);
    if (by === undefined) s.open += 1;
    else if (by === 'policy' || by === 'precedent' || by === 'mini') s.resolvedLocally[by] += 1;
    else if (by === 'user') s.answeredByUser += 1;
    else s.answeredUnknown += 1;
  }
  const local = s.resolvedLocally.policy + s.resolvedLocally.precedent + s.resolvedLocally.mini;
  if (s.raised > 0) s.rate = (s.raised - local) / s.raised;
  return s;
}
