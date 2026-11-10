import { z } from 'zod';

/**
 * The subset of A2A 1.0 that Tacet speaks (ADR-003 §4), as its JSON wire shapes: the proto3 JSON
 * mapping of `a2a.proto`, with camelCase fields and enums as their names. Not imported from
 * `@a2a-js/sdk`: that package's TypeScript types are its in-memory protobuf objects (numeric
 * enums, `{$case, value}` oneofs), not the JSON on the wire. A contract test round-trips these
 * shapes through the SDK's own JSON codecs instead (#201; recorded in the ADR-003 addendum).
 *
 * Unknown fields are stripped, as ADR-003 §2 asks receivers to ignore them.
 */

/** `TaskState` as named on the wire. */
export const A2ATaskState = z.enum([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
]);
export type A2ATaskState = z.infer<typeof A2ATaskState>;

export const A2ARole = z.enum(['ROLE_USER', 'ROLE_AGENT']);
export type A2ARole = z.infer<typeof A2ARole>;

const Metadata = z.record(z.string(), z.unknown());

/** A part: text or structured data (the `content` oneof; files are not used by Tacet). */
export const A2APart = z.union([
  z.object({ text: z.string(), metadata: Metadata.optional(), mediaType: z.string().optional() }),
  z.object({ data: z.unknown(), metadata: Metadata.optional(), mediaType: z.string().optional() }),
]);
export type A2APart = z.infer<typeof A2APart>;

export const A2AMessage = z.object({
  messageId: z.string().min(1),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  role: A2ARole,
  parts: z.array(A2APart).min(1),
  metadata: Metadata.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});
export type A2AMessage = z.infer<typeof A2AMessage>;

export const A2ATaskStatus = z.object({
  state: A2ATaskState,
  message: A2AMessage.optional(),
  timestamp: z.string().optional(),
});

export const A2ATask = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1),
  status: A2ATaskStatus,
  history: z.array(A2AMessage).optional(),
  metadata: Metadata.optional(),
});
export type A2ATask = z.infer<typeof A2ATask>;

export const A2AGetTaskRequest = z.object({
  id: z.string().min(1),
  historyLength: z.number().int().min(0).optional(),
});
export type A2AGetTaskRequest = z.infer<typeof A2AGetTaskRequest>;

export const A2AListTasksRequest = z.object({
  contextId: z.string().optional(),
  status: A2ATaskState.optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  historyLength: z.number().int().min(0).optional(),
});
export type A2AListTasksRequest = z.infer<typeof A2AListTasksRequest>;

export const A2AListTasksResponse = z.object({
  tasks: z.array(A2ATask),
  /** Absent on the last page (proto3 JSON omits the empty default). */
  nextPageToken: z.string().min(1).optional(),
  pageSize: z.number().int(),
  totalSize: z.number().int(),
});
export type A2AListTasksResponse = z.infer<typeof A2AListTasksResponse>;

export const A2ACancelTaskRequest = z.object({
  id: z.string().min(1),
  metadata: Metadata.optional(),
});
export type A2ACancelTaskRequest = z.infer<typeof A2ACancelTaskRequest>;

export const A2ASendMessageRequest = z.object({
  message: A2AMessage,
  metadata: Metadata.optional(),
});
export type A2ASendMessageRequest = z.infer<typeof A2ASendMessageRequest>;

/** `SendMessageResponse`: the `payload` oneof, a task or a message. */
export const A2ASendMessageResponse = z.union([
  z.object({ task: A2ATask }),
  z.object({ message: A2AMessage }),
]);
export type A2ASendMessageResponse = z.infer<typeof A2ASendMessageResponse>;

/**
 * A2A error codes (A2A §8.2, ADR-003 §4): the ones Tacet answers with. JSON-RPC's own codes
 * (`-32600` invalid request, `-32601` method not found, `-32602` invalid params) apply as usual.
 */
export const A2A_ERRORS = {
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupportedOperation: -32004,
} as const;
