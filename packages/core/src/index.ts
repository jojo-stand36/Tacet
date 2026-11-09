/**
 * @tacet/core: shared types and schemas. This entry is isomorphic (no `node:*` imports) so the
 * web UI can use it; Node-only helpers will live under a separate subpath.
 */
export const packageName = '@tacet/core' as const;

export type * from './adapter/types.js';
export * from './events/projection.js';
export * from './schema/index.js';
export { allJsonSchemas, type JsonSchemaDocument, toJsonSchema } from './schema/json-schema.js';
