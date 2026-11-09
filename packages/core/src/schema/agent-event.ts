import { z } from 'zod';
import { Id, TokenCount, Urgency, Usd } from './common.js';

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
});

/**
 * Token and cost usage. Context and cost fields are optional because not every vendor reports
 * them (docs/adapters/capability-matrix.md §7). `source` says whether the vendor reported the
 * numbers or Tacet estimated them.
 */
export const Usage = z.object({
  t: z.literal('usage'),
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  contextUsed: TokenCount.optional(),
  contextMax: TokenCount.optional(),
  costUsd: Usd.optional(),
  model: z.string().min(1).optional(),
  source: z.enum(['reported', 'estimated']),
});

export const SessionState = z.enum([
  'running',
  'idle',
  'waiting_input',
  'cancelled',
  'error',
  'done',
]);
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
