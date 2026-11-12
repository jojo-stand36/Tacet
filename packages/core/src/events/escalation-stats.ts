import type { EventEnvelope } from '../schema/envelope.js';

/** How a repo's escalations went (#25): what the gate kept from the user, and what reached them. */
export interface EscalationStats {
  /**
   * Escalations Workers raised with MCP `escalate`, the ones the gate may answer. Approval
   * requests are counted apart (`approvals`): the gate never answers those.
   */
  raised: number;
  /** Of those, answered without the user: by repo policy, by precedent, by the Mini-conductor. */
  resolvedLocally: { policy: number; precedent: number; mini: number };
  /** Of those, answered by the user. */
  answeredByUser: number;
  /** Of those, answered with no recognised source. */
  answeredUnknown: number;
  /** Of those, still waiting on an answer. */
  open: number;
  /**
   * The share of Worker escalations that went to the user: those not answered locally, over all
   * raised. Null when none were raised.
   */
  rate: number | null;
  /** Approval requests for a Worker's repo-wide proposal: always the user's. */
  approvals: number;
  /** Escalations the Mini-conductor raised itself (blocked Workers, conflicts): always the user's. */
  raisedByMini: number;
}

/** No escalations at all. */
export const NO_ESCALATIONS: EscalationStats = {
  raised: 0,
  resolvedLocally: { policy: 0, precedent: 0, mini: 0 },
  answeredByUser: 0,
  answeredUnknown: 0,
  open: 0,
  rate: null,
  approvals: 0,
  raisedByMini: 0,
};

/**
 * Count escalations from the log (#25's "measured escalation rate"): every `escalation.raised`
 * at or after `since` (an ISO time; all when absent), with how each was resolved. It reads only
 * summary-grade events, which retention keeps, so it gives the same answer after compaction.
 */
export function escalationStats(
  events: Iterable<EventEnvelope>,
  opts: { since?: string } = {},
): EscalationStats {
  const raised = new Map<string, { kind: 'worker' | 'approval' | 'mini' }>();
  const since = opts.since !== undefined ? Date.parse(opts.since) : undefined;
  const resolvedBy = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'escalation.raised') {
      const id = (e.data as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      if (since !== undefined && Date.parse(e.ts) < since) continue;
      const approval = (e.data as { category?: unknown }).category === 'decision';
      raised.set(id, {
        kind: e.source.kind !== 'worker' ? 'mini' : approval ? 'approval' : 'worker',
      });
    } else if (e.type === 'escalation.resolved') {
      const d = e.data as { escalationId?: unknown; source?: unknown };
      if (typeof d.escalationId !== 'string' || resolvedBy.has(d.escalationId)) continue;
      resolvedBy.set(d.escalationId, typeof d.source === 'string' ? d.source : '');
    }
  }
  const s: EscalationStats = structuredClone(NO_ESCALATIONS);
  for (const [id, r] of raised) {
    if (r.kind === 'mini') {
      s.raisedByMini += 1;
      continue;
    }
    if (r.kind === 'approval') {
      s.approvals += 1;
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
