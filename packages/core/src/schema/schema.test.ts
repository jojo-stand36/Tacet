import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentEvent,
  allJsonSchemas,
  EventEnvelope,
  HandoffPacket,
  type JsonSchemaName,
  jsonSchemas,
  Task,
  toJsonSchema,
} from '../index.js';

const examplesDir = join(import.meta.dirname, '..', '..', 'examples', 'v1');
const readExample = (name: string): unknown =>
  JSON.parse(readFileSync(join(examplesDir, `${name}.json`), 'utf8'));
const names = Object.keys(jsonSchemas) as JsonSchemaName[];

describe('examples', () => {
  it('has exactly one example per exported schema', () => {
    const files = readdirSync(examplesDir).map((f) => f.replace(/\.json$/, ''));
    expect(files.sort()).toEqual([...names].sort());
  });

  it.each(names)('%s example parses and round-trips', (name) => {
    const { schema } = jsonSchemas[name];
    const parsed = schema.parse(readExample(name));
    expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

describe('forward compatibility (ADR-003 §2)', () => {
  it('ignores unknown fields instead of rejecting them', () => {
    const doc = { ...(readExample('task') as object), futureField: 1 };
    const parsed = Task.parse(doc);
    expect(parsed).not.toHaveProperty('futureField');
  });

  it('does not emit additionalProperties: false in JSON Schema', () => {
    for (const doc of Object.values(allJsonSchemas())) {
      expect(JSON.stringify(doc)).not.toContain('"additionalProperties":false');
    }
  });
});

describe('HandoffPacket', () => {
  const packet = readExample('handoff-packet') as Record<string, unknown>;

  it('rejects a packet without nextAction', () => {
    const { nextAction: _omit, ...rest } = packet;
    expect(HandoffPacket.safeParse(rest).success).toBe(false);
  });

  it('rejects a blank nextAction', () => {
    expect(HandoffPacket.safeParse({ ...packet, nextAction: '   ' }).success).toBe(false);
  });
});

describe('AgentEvent', () => {
  it('accepts usage without context or cost (not every vendor reports them)', () => {
    const e = AgentEvent.parse({
      t: 'usage',
      inputTokens: 1,
      outputTokens: 2,
      source: 'estimated',
    });
    expect(e.t).toBe('usage');
  });

  it('rejects an unknown event kind', () => {
    expect(AgentEvent.safeParse({ t: 'telepathy' }).success).toBe(false);
  });
});

describe('EventEnvelope', () => {
  const env = readExample('envelope') as Record<string, unknown>;

  it('rejects a type outside the known namespaces', () => {
    expect(EventEnvelope.safeParse({ ...env, type: 'secrets.dump' }).success).toBe(false);
  });

  it('rejects an id that is not a ULID', () => {
    expect(EventEnvelope.safeParse({ ...env, id: 'not-a-ulid' }).success).toBe(false);
  });

  it('carries an agent event as data', () => {
    const parsed = EventEnvelope.parse(env);
    expect(AgentEvent.parse(parsed.data).t).toBe('usage');
  });
});

describe('JSON Schema export', () => {
  it.each(names)('%s has a urn:tacet $id and draft 2020-12', (name) => {
    const doc = toJsonSchema(name);
    expect(doc.$id).toBe(`urn:tacet:schema:${name}:v1`);
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it.each(names)('committed schema/v1/%s.json matches the zod source', (name) => {
    const file = join(import.meta.dirname, '..', '..', 'schema', 'v1', `${name}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(toJsonSchema(name));
  });
});
