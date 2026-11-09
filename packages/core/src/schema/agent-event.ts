import { z } from 'zod';
import { Id, openEnum, TokenCount, Urgency, Usd } from './common.js';

/** One choice offered with an approval request (vendor-neutral, mapped by each adapter). */
/** Unknown values fall back to `reject`, the safe answer. */
export const ApprovalOption = openEnum(
  ['allow_once', 'allow_always', 'reject', 'cancel'],
  'reject',
);
export type ApprovalOption = z.infer<typeof ApprovalOption>;

/** Streamed assistant text. */
export const MessageDelta = z.object({ t: z.literal('message.delta'), text: z.string() });

/** The agent started a tool call. `input` must already have secrets redacted (ADR-003 §1). */
export const ToolCall = z.object({
  t: z.literal('tool.call'),
  id: Id,
  name: z.string().min(1),
  input: z.unknown(),
});

/** A tool call finished. `id` matches the `tool.call`. */
export const ToolResult = z.object({
  t: z.literal('tool.result'),
  id: Id,
  ok: z.boolean(),
  summary: z.string().optional(),
});

/** The agent asks for permission before acting. Answered through `AgentAdapter.respond()`. */
export const ApprovalRequest = z.object({
  t: z.literal('approval.request'),
  id: Id,
  summary: z.string().min(1),
  toolName: z.string().min(1).optional(),
  options: z
    .array(ApprovalOption)
    .optional()
    .describe('Choices the vendor surface supports; absent means all four'),
  requestedGrant: z
    .unknown()
    .optional()
    .describe('For grant-style requests (e.g. Codex permissions): what the agent asked for'),
});

/**
 * The answer to an `approval.request`, passed to `AgentAdapter.respond()`. `allow_always` is
 * session-scoped unless `persist` is true; persisting writes vendor rules and needs explicit
 * intent (docs/adapters/spikes/58-codex). `cancel` also ends the turn. Distinct from `Decision`,
 * which is a recorded answer to an escalation.
 */
export const ApprovalDecision = z.object({
  kind: ApprovalOption,
  persist: z.boolean().default(false).describe('Only meaningful with allow_always'),
  message: z.string().optional().describe('Reason shown to the agent on reject or cancel'),
  updatedInput: z.unknown().optional().describe('Replacement tool input on allow, if supported'),
  grant: z
    .unknown()
    .optional()
    .describe('Granted subset for grant-style requests; omit to grant what was requested'),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/**
 * Token and cost usage for one model call. Token and cost fields are deltas for that call, so the
 * cost ledger sums them; adapters convert cumulative vendor totals (e.g. Claude's
 * `total_cost_usd`) into deltas. `contextUsed` and `contextMax` are gauges (current size).
 * Context and cost are optional because not every vendor reports them
 * (docs/adapters/capability-matrix.md §7). `source` says whether the vendor reported the numbers
 * or Tacet estimated them.
 */
export const Usage = z.object({
  t: z.literal('usage'),
  inputTokens: TokenCount.describe('Input tokens for this call (delta)'),
  outputTokens: TokenCount.describe('Output tokens for this call (delta)'),
  contextUsed: TokenCount.optional().describe('Tokens currently in context (gauge)'),
  contextMax: TokenCount.optional().describe('Context window size (gauge)'),
  costUsd: Usd.optional().describe('Cost of this call in US dollars (delta)'),
  model: z.string().min(1).optional(),
  source: openEnum(['reported', 'estimated'], 'estimated'),
});

/**
 * `auth_required`: the vendor CLI needs the user to log in (maps to A2A AUTH_REQUIRED).
 * Unknown values fall back to `running`.
 */
export const SessionState = openEnum(
  ['running', 'idle', 'waiting_input', 'auth_required', 'cancelled', 'error', 'done'],
  'running',
);
export type SessionState = z.infer<typeof SessionState>;

export const Status = z.object({
  t: z.literal('status'),
  state: SessionState,
  message: z.string().optional(),
});

/** The agent raised a question for the escalation gate. */
export const EscalationEvent = z.object({
  t: z.literal('escalation'),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  urgency: Urgency,
  context: z.string().optional(),
  contextRef: z.string().min(1).optional(),
});

/**
 * Normalized event emitted by every adapter (ARCHITECTURE.md §3). Stored as the `data` of an
 * `agent.<t>` event envelope.
 */
export const AgentEvent = z.discriminatedUnion('t', [
  MessageDelta,
  ToolCall,
  ToolResult,
  ApprovalRequest,
  Usage,
  Status,
  EscalationEvent,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent['t'];

const knownAgentEventTypes = new Set<string>(AgentEvent.options.map((o) => o.shape.t.value));

/**
 * Parse an agent event the way receivers must (ADR-003 §2): an event with an unknown `t` is
 * ignored (returns `undefined`); a known `t` with an invalid payload throws.
 */
export function parseAgentEvent(input: unknown): AgentEvent | undefined {
  const t = (input as { t?: unknown } | null)?.t;
  if (typeof t !== 'string' || !knownAgentEventTypes.has(t)) return undefined;
  return AgentEvent.parse(input);
}
