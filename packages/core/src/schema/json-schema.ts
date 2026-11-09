import { z } from 'zod';
import { type JsonSchemaName, jsonSchemas, SCHEMA_VERSION } from './index.js';

export type JsonSchemaDocument = Record<string, unknown>;

/**
 * JSON Schema 2020-12 for one Tacet schema. Generated in `input` mode, so objects do not set
 * `additionalProperties: false` (receivers ignore unknown fields, ADR-003 §2) and fields with
 * defaults are optional.
 */
export function toJsonSchema(name: JsonSchemaName): JsonSchemaDocument {
  const { schema, title } = jsonSchemas[name];
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as JsonSchemaDocument;
  return { $schema, $id: `urn:tacet:schema:${name}:v${SCHEMA_VERSION}`, title, ...rest };
}

/** Every exported schema, keyed by file name (without `.json`). */
export function allJsonSchemas(): Record<JsonSchemaName, JsonSchemaDocument> {
  const names = Object.keys(jsonSchemas) as JsonSchemaName[];
  return Object.fromEntries(names.map((n) => [n, toJsonSchema(n)])) as Record<
    JsonSchemaName,
    JsonSchemaDocument
  >;
}
