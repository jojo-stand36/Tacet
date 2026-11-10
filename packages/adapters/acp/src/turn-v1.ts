import type {
  PermissionOption,
  PromptResponse,
  RequestPermissionOutcome,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import type { AgentEvent, ApprovalDecision, SessionState } from '@tacet/core';

/**
 * ACP v1 prompt turns, as pure mappings (#13). A v1 turn is one `session/prompt` request: the
 * agent streams `session/update` notifications, may ask `session/request_permission`, and ends the
 * turn with the request's response. ACP v2 ends a turn with a `state_update` notification instead
 * (spike #61); a v2 path replaces this module, not the adapter.
 */

/** Per-session memory the mappings need. */
export interface TurnState {
  /** Tool calls already reported finished, so a repeated update is not reported twice. */
  finished: Set<string>;
  /** Cumulative session cost last reported in USD, for deltas. */
  costUsd: number;
  /** The context gauges last reported (`usage_update`). */
  context?: { used: number; size: number };
}

export function newTurnState(): TurnState {
  return { finished: new Set(), costUsd: 0 };
}

/** The Tacet events for one `session/update`. Updates Tacet has no event for map to nothing. */
export function updateToEvents(u: SessionUpdate, st: TurnState): AgentEvent[] {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      return u.content.type === 'text' && u.content.text
        ? [{ t: 'message.delta', text: u.content.text }]
        : [];
    case 'tool_call': {
      const out: AgentEvent[] = [
        {
          t: 'tool.call',
          id: u.toolCallId,
          name: u.name ?? u.kind ?? 'tool',
          input: u.rawInput ?? { title: u.title },
        },
      ];
      return [...out, ...finished(u.toolCallId, u.status, st)];
    }
    case 'tool_call_update':
      return finished(u.toolCallId, u.status ?? undefined, st);
    case 'usage_update': {
      // `used` and `size` are gauges; a cost, where an agent reports one, is the session total.
      let costUsd: number | undefined;
      if (u.cost && u.cost.currency === 'USD' && u.cost.amount >= st.costUsd) {
        costUsd = u.cost.amount - st.costUsd;
        st.costUsd = u.cost.amount;
      }
      st.context = { used: Math.max(0, Math.round(u.used)), size: Math.max(0, Math.round(u.size)) };
      return [
        {
          t: 'usage',
          inputTokens: 0,
          outputTokens: 0,
          contextUsed: st.context.used,
          contextMax: st.context.size,
          ...(costUsd !== undefined ? { costUsd } : {}),
          source: 'reported',
        },
      ];
    }
    default:
      return [];
  }
}

function finished(
  id: string,
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | undefined,
  st: TurnState,
): AgentEvent[] {
  if ((status !== 'completed' && status !== 'failed') || st.finished.has(id)) return [];
  st.finished.add(id);
  return [{ t: 'tool.result', id, ok: status === 'completed' }];
}

/**
 * The turn's token counts, when the agent puts them on the prompt response. That field is a draft
 * RFD (`end-turn-token-usage`, spike #61), not stable v1: read only if present and well formed.
 */
export function turnUsage(r: PromptResponse, st: TurnState): AgentEvent | undefined {
  const u = (r as { usage?: unknown }).usage as
    | { inputTokens?: unknown; outputTokens?: unknown }
    | undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const input = n(u?.inputTokens);
  const output = n(u?.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  return {
    t: 'usage',
    inputTokens: input,
    outputTokens: output,
    // The gauges as last reported: still the context's size at the end of the turn.
    ...(st.context ? { contextUsed: st.context.used, contextMax: st.context.size } : {}),
    source: 'reported',
  };
}

/** Where a turn leaves the session. A cancelled turn is not an error (spike #61). */
export function stopState(reason: StopReason): { state: SessionState; message?: string } {
  if (reason === 'cancelled') return { state: 'cancelled' };
  if (reason === 'end_turn') return { state: 'idle' };
  return { state: 'idle', message: `turn ended: ${reason}` };
}

/**
 * The ACP answer to a permission request for a Tacet decision, by option kind (spike #63: Gemini
 * offers `proceed_always`, `proceed_once` and `cancel`, the last being its reject option).
 * `cancel` cancels the turn: the caller also sends `session/cancel`.
 */
export function permissionOutcome(
  options: readonly PermissionOption[],
  decision: ApprovalDecision,
): RequestPermissionOutcome {
  if (decision.kind === 'cancel') return { outcome: 'cancelled' };
  const kinds: Record<string, readonly string[]> = {
    allow_once: ['allow_once'],
    // Persisting a rule is the agent's business; ACP has no separate session-only kind.
    allow_always: ['allow_always', 'allow_once'],
    reject: ['reject_once', 'reject_always'],
  };
  for (const kind of kinds[decision.kind] ?? []) {
    const o = options.find((x) => x.kind === kind);
    if (o) return { outcome: 'selected', optionId: o.optionId };
  }
  // No option of that kind: refusing is the only safe answer.
  return { outcome: 'cancelled' };
}

/** The Tacet choices a permission request offers, from its option kinds. */
export function approvalChoices(
  options: readonly PermissionOption[],
): ('allow_once' | 'allow_always' | 'reject' | 'cancel')[] {
  const kinds = new Set(options.map((o) => o.kind));
  return [
    ...(kinds.has('allow_once') ? (['allow_once'] as const) : []),
    ...(kinds.has('allow_always') ? (['allow_always'] as const) : []),
    ...(kinds.has('reject_once') || kinds.has('reject_always') ? (['reject'] as const) : []),
    'cancel',
  ];
}
