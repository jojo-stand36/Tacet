import type { z } from 'zod';
import { AgentEvent, ApprovalDecision } from './agent-event.js';
import { Decision, DecisionExt } from './decision.js';
import { EventEnvelope } from './envelope.js';
import { Escalation, EscalationExt } from './escalation.js';
import { HandoffPacket } from './handoff.js';
import { HelloParams, HelloResult } from './hello.js';
import { MaintenanceProblem } from './maintenance.js';
import { TaskPlan } from './plan.js';
import { SessionProfile } from './profile.js';
import { SummaryPacket } from './summary.js';
import { Task, TaskExt, TaskLanded, TaskTarget } from './task.js';
import {
  WorkerApproval,
  WorkerEnded,
  WorkerIntegrated,
  WorkerNudged,
  WorkerProfile,
  WorkerReview,
  WorkerStarted,
  WorkerThrottled,
  WorkerVendorSession,
  WorkerVerification,
} from './worker.js';
import { WorkspaceCreated, WorkspaceRemoved } from './workspace.js';

export * from './agent-event.js';
export * from './common.js';
export * from './decision.js';
export * from './envelope.js';
export * from './escalation.js';
export * from './handoff.js';
export * from './hello.js';
export * from './maintenance.js';
export * from './plan.js';
export * from './profile.js';
export * from './summary.js';
export * from './task.js';
export * from './worker.js';
export * from './workspace.js';

/** Schema major version; JSON Schemas live in `schema/v1/`. */
export const SCHEMA_VERSION = 1;

/**
 * Schemas exported as JSON Schema 2020-12 for non-TypeScript consumers. Each gets
 * `$id: urn:tacet:schema:<name>:v1` (ADR-003 §2).
 */
export const jsonSchemas = {
  envelope: { schema: EventEnvelope, title: 'Tacet event envelope' },
  'agent-event': { schema: AgentEvent, title: 'Tacet AgentEvent' },
  'approval-decision': { schema: ApprovalDecision, title: 'Tacet ApprovalDecision' },
  task: { schema: Task, title: 'Tacet Task' },
  'session-profile': { schema: SessionProfile, title: 'Tacet SessionProfile' },
  'task-ext': { schema: TaskExt, title: 'Tacet A2A task extension (urn:tacet:a2a-ext:task:v1)' },
  escalation: { schema: Escalation, title: 'Tacet Escalation' },
  'escalation-ext': {
    schema: EscalationExt,
    title: 'Tacet A2A escalation extension (urn:tacet:a2a-ext:escalation:v1)',
  },
  decision: { schema: Decision, title: 'Tacet Decision' },
  'decision-ext': {
    schema: DecisionExt,
    title: 'Tacet A2A decision extension (urn:tacet:a2a-ext:decision:v1)',
  },
  'handoff-packet': { schema: HandoffPacket, title: 'Tacet HandoffPacket' },
  'hello-params': { schema: HelloParams, title: 'Tacet tacet/hello request params' },
  'hello-result': { schema: HelloResult, title: 'Tacet tacet/hello result' },
  'task-plan': { schema: TaskPlan, title: 'Tacet task.planned payload' },
  'summary-packet': { schema: SummaryPacket, title: 'Tacet SummaryPacket (task.result)' },
  'task-landed': { schema: TaskLanded, title: 'Tacet task.landed payload' },
  'task-target': { schema: TaskTarget, title: 'Tacet task.target payload' },
  'worker-started': { schema: WorkerStarted, title: 'Tacet worker.started payload' },
  'worker-vendor-session': {
    schema: WorkerVendorSession,
    title: 'Tacet worker.vendor_session payload',
  },
  'worker-ended': { schema: WorkerEnded, title: 'Tacet worker.ended payload' },
  'worker-nudged': { schema: WorkerNudged, title: 'Tacet worker.nudged payload' },
  'worker-profile': { schema: WorkerProfile, title: 'Tacet worker.profile payload' },
  'worker-integrated': { schema: WorkerIntegrated, title: 'Tacet worker.integrated payload' },
  'worker-throttled': { schema: WorkerThrottled, title: 'Tacet worker.throttled payload' },
  'worker-approval': { schema: WorkerApproval, title: 'Tacet worker.approval payload' },
  'worker-verification': {
    schema: WorkerVerification,
    title: 'Tacet worker.verification payload',
  },
  'worker-review': { schema: WorkerReview, title: 'Tacet worker.review payload' },
  'workspace-created': { schema: WorkspaceCreated, title: 'Tacet workspace.created payload' },
  'workspace-removed': { schema: WorkspaceRemoved, title: 'Tacet workspace.removed payload' },
  'maintenance-problem': {
    schema: MaintenanceProblem,
    title: 'Tacet maintenance.problem payload',
  },
} satisfies Record<string, { schema: z.ZodType; title: string }>;

export type JsonSchemaName = keyof typeof jsonSchemas;

/**
 * Input types: what a producer may send. Fields with defaults are optional here, unlike the
 * parsed (output) types exported next to each schema.
 */
export type TaskInput = z.input<typeof Task>;
export type EscalationInput = z.input<typeof Escalation>;
export type DecisionInput = z.input<typeof Decision>;
export type HandoffPacketInput = z.input<typeof HandoffPacket>;
export type ApprovalDecisionInput = z.input<typeof ApprovalDecision>;
export type TaskPlanInput = z.input<typeof TaskPlan>;
export type SummaryPacketInput = z.input<typeof SummaryPacket>;
