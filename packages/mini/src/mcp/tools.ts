import { HandoffPacket, Urgency } from '@tacet/core';
import { z } from 'zod';

/**
 * The Mini-conductor's MCP tool surface (ADR-003 §6), in the fixed order the server lists it.
 * Tools take no task or worker argument: identity comes from the caller's per-worker token.
 * Every tool works the same for 2026-07-28 and 2025-era clients (ADR-003 addendum for #18): none
 * blocks or relies on input_required round trips, subscriptions or sessions.
 */
export const TOOL_NAMES = [
  'read_task',
  'report_progress',
  'escalate',
  'get_decision',
  'request_handoff',
  'record_decision',
  'search_decisions',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const DecisionSummary = z.object({
  id: z.string(),
  topic: z.string(),
  decision: z.string(),
  rationale: z.string().optional(),
  scope: z.enum(['task', 'repo']),
  source: z.string(),
});
export type DecisionSummary = z.infer<typeof DecisionSummary>;

const Answer = {
  status: z.enum(['resolved', 'pending']),
  answer: z.string().optional(),
  source: z.enum(['policy', 'precedent', 'mini', 'user']).optional(),
};

export const ToolSchemas = {
  read_task: {
    description:
      'Read your task: goal, acceptance criteria, constraints, remaining budget, relevant decisions, and the handoff packet if this session continues earlier work. Call it at session start.',
    input: z.object({}),
    output: z.object({
      goal: z.string(),
      acceptanceCriteria: z.array(z.string()),
      constraints: z.array(z.string()),
      budgetRemaining: z.number().nullable().describe('USD left for this task, null if unlimited'),
      relevantDecisions: z.array(DecisionSummary),
      handoff: HandoffPacket.optional(),
    }),
    readOnly: true,
  },
  report_progress: {
    description:
      'Report progress without stopping. Keep it short; frequent calls from one worker are rate-limited.',
    input: z.object({
      summary: z.string().min(1).max(2000),
      step: z.string().max(200).optional(),
      percent: z.number().min(0).max(100).optional(),
      filesTouched: z.array(z.string().min(1)).max(200).optional(),
    }),
    output: z.object({ ack: z.literal(true) }),
    readOnly: false,
  },
  escalate: {
    description:
      'Ask a question you cannot settle yourself. Returns at once: either the answer, or status "pending". When pending, continue independent work, or end your turn if blocked; the answer will arrive as your next message. Check search_decisions first.',
    input: z.object({
      question: z.string().min(1).max(4000),
      options: z.array(z.string().min(1)).max(20).optional(),
      urgency: Urgency,
      context: z.string().max(8000).optional(),
      contextRef: z.string().min(1).max(1000).optional(),
    }),
    output: z.object({ escalationId: z.string(), ...Answer }),
    readOnly: false,
  },
  get_decision: {
    description: 'Check whether an escalation you raised has been answered.',
    input: z.object({ escalationId: z.string().min(1) }),
    output: z.object(Answer),
    readOnly: true,
  },
  request_handoff: {
    description:
      'Hand your work to a fresh session before your context degrades. The packet must include a non-blank nextAction; an invalid packet is returned with errors so you can fix it. When accepted, this session ends and a new one continues from the packet.',
    input: z.object({ reason: z.string().min(1).max(2000), packet: z.unknown() }),
    output: z.object({
      accepted: z.boolean(),
      handoffId: z.string().optional(),
      errors: z.array(z.string()).optional(),
    }),
    readOnly: false,
  },
  record_decision: {
    description:
      'Record a decision you made. Task-scope decisions are recorded at once; repo-scope decisions become precedent only when repo policy allows, otherwise they need approval.',
    input: z.object({
      topic: z.string().min(1).max(500),
      decision: z.string().min(1).max(4000),
      rationale: z.string().max(4000).optional(),
      scope: z.enum(['task', 'repo']),
    }),
    output: z.object({
      decisionId: z.string(),
      status: z.enum(['recorded', 'needs_approval']),
      escalationId: z.string().optional(),
    }),
    readOnly: false,
  },
  search_decisions: {
    description: 'Search earlier decisions (this task and repo-wide precedent) before escalating.',
    input: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    output: z.object({ decisions: z.array(DecisionSummary) }),
    readOnly: true,
  },
} as const satisfies Record<
  ToolName,
  { description: string; input: z.ZodType; output: z.ZodType; readOnly: boolean }
>;

export type ToolInput<T extends ToolName> = z.infer<(typeof ToolSchemas)[T]['input']>;
export type ToolOutput<T extends ToolName> = z.infer<(typeof ToolSchemas)[T]['output']>;
