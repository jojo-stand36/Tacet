/**
 * @tacet/core: shared types and schemas. This entry is isomorphic (no `node:*` imports) so the
 * web UI can use it; Node-only helpers will live under a separate subpath.
 */
export const packageName = '@tacet/core' as const;

export * from './adapter/env.js';
export * from './adapter/errors.js';
export * from './adapter/prompt.js';
export * from './adapter/redact.js';
export type * from './adapter/types.js';
export * from './adapter/vendor.js';
export * from './config/index.js';
export * from './events/escalation-stats.js';
export * from './events/projection.js';
export * from './events/status.js';
export * from './schema/index.js';
export { allJsonSchemas, type JsonSchemaDocument, toJsonSchema } from './schema/json-schema.js';
export * from './util/async-queue.js';
export * from './util/ulid.js';
