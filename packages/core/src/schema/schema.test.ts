import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  AgentEvent,
  ApprovalDecision,
  allJsonSchemas,
  Decision,
  DecisionExt,
  Escalation,
  EscalationExt,
  EventEnvelope,
  HandoffPacket,
  isForwardable,
  isKnownEventNamespace,
  type JsonSchemaName,
  jsonSchemas,
  parseAgentEvent,
  Task,
  TaskExt,
  toJsonSchema,
  Ulid,
} from '../index.js';

// ajv-formats ships CommonJS; depending on the loader the plugin is the module or its `.default`.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as (ajv: Ajv2020) => Ajv2020;

const root = join(import.meta.dirname, '..', '..');
const examplesDir = join(root, 'examples', 'v1');
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const example = (name: string): Record<string, unknown> =>
  readJson(join(examplesDir, `${name}.json`)) as Record<string, unknown>;
const names = Object.keys(jsonSchemas) as JsonSchemaName[];

describe('examples', () => {
  it('has exactly one example per exported schema', () => {
    const files = readdirSync(examplesDir).map((f) => f.replace(/\.json$/, ''));
    expect(files.sort()).toEqual([...names].sort());
  });

  it.each(names)('%s example parses and round-trips through zod', (name) => {
    const { schema } = jsonSchemas[name];
    const parsed = schema.parse(example(name));
    expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it.each(names)('%s example validates against the committed JSON Schema', (name) => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(readJson(join(root, 'schema', 'v1', `${name}.json`)) as object);
    expect(validate(example(name)), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('forward compatibility (ADR-003 §2)', () => {
  it('ignores unknown fields instead of rejecting them', () => {
    const parsed = Task.parse({ ...example('task'), futureField: 1 });
    expect(parsed).not.toHaveProperty('futureField');
  });

  it('does not emit additionalProperties: false in JSON Schema', () => {
    for (const doc of Object.values(allJsonSchemas())) {
      expect(JSON.stringify(doc)).not.toContain('"additionalProperties":false');
    }
  });

  it('accepts envelopes in namespaces this version does not know', () => {
    const env = EventEnvelope.parse({ ...example('envelope'), type: 'ui.panel.opened' });
    expect(isKnownEventNamespace(env.type)).toBe(false);
    expect(isKnownEventNamespace('agent.usage')).toBe(true);
  });

  it('parseAgentEvent ignores an unknown event kind and validates known ones', () => {
    expect(parseAgentEvent({ t: 'telepathy', x: 1 })).toBeUndefined();
    expect(parseAgentEvent(null)).toBeUndefined();
    expect(parseAgentEvent({ t: 'message.delta', text: 'hi' })?.t).toBe('message.delta');
    expect(() => parseAgentEvent({ t: 'usage', inputTokens: -1 })).toThrow();
  });
});

describe('defaults', () => {
  it('fills Task, Escalation, Decision, HandoffPacket and ApprovalDecision defaults', () => {
    const { priority: _p, ...task } = example('task');
    expect(Task.parse(task).priority).toBe('p2');

    const { status: _s, blockedWorkers: _b, reescalations: _r, ...esc } = example('escalation');
    const e = Escalation.parse(esc);
    expect([e.status, e.blockedWorkers, e.reescalations]).toEqual(['pending', 0, 0]);

    const { tags: _t, ...dec } = example('decision');
    expect(Decision.parse(dec).tags).toEqual([]);

    const {
      decisions: _d,
      filesTouched: _f,
      commandsRun: _c,
      openQuestions: _o,
      ...packet
    } = example('handoff-packet');
    const h = HandoffPacket.parse(packet);
    expect([h.decisions, h.filesTouched, h.commandsRun, h.openQuestions]).toEqual([[], [], [], []]);

    expect(ApprovalDecision.parse({ kind: 'allow_always' }).persist).toBe(false);
  });
});

describe('open enums (owner decision 2026-11-09, ADR-003 §2)', () => {
  it('reads unknown enum values as the documented fallback instead of rejecting', () => {
    expect(Task.parse({ ...example('task'), priority: 'urgent' }).priority).toBe('p2');
    expect(Escalation.parse({ ...example('escalation'), urgency: 'x' }).urgency).toBe('normal');
    expect(Decision.parse({ ...example('decision'), scope: 'global' }).scope).toBe('task');
    expect(Decision.parse({ ...example('decision'), source: 'oracle' }).source).toBe('mini');
    expect(ApprovalDecision.parse({ kind: 'maybe' }).kind).toBe('reject');
    expect(
      EventEnvelope.parse({ ...example('envelope'), source: { kind: 'robot', id: 'x' } }).source
        .kind,
    ).toBe('worker');
    expect(AgentEvent.parse({ t: 'status', state: 'hibernating' })).toEqual({
      t: 'status',
      state: 'running',
    });
  });

  it('keeps discriminators closed: an unknown AgentEvent kind is still rejected by the schema', () => {
    expect(AgentEvent.safeParse({ t: 'telepathy' }).success).toBe(false);
  });

  it('publishes each fallback as x-tacet-fallback, not as a JSON Schema default', () => {
    const urgency = (
      toJsonSchema('escalation').properties as Record<string, Record<string, unknown>>
    ).urgency;
    expect(urgency).toMatchObject({
      'x-tacet-fallback': 'normal',
      enum: ['low', 'normal', 'high', 'blocking'],
    });
    expect(urgency).not.toHaveProperty('default');
    const priority = (toJsonSchema('task').properties as Record<string, Record<string, unknown>>)
      .priority;
    expect(priority).toMatchObject({ default: 'p2', 'x-tacet-fallback': 'p2' });
  });
});

describe('rejections', () => {
  const cases: [string, { safeParse(v: unknown): { success: boolean } }, unknown][] = [
    ['Task without a goal', Task, { ...example('task'), goal: '' }],
    ['TaskExt with a negative budget', TaskExt, { ...example('task-ext'), budget: { usd: -1 } }],
    [
      'EscalationExt without blockedWorkers',
      EscalationExt,
      { escalationId: example('escalation-ext').escalationId, urgency: 'low' },
    ],
    ['DecisionExt without a choice', DecisionExt, { ...example('decision-ext'), choice: '' }],
    ['ApprovalDecision without a kind', ApprovalDecision, { persist: true }],
    [
      'Escalation without an urgency',
      Escalation,
      (({ urgency: _u, ...e }) => e)(example('escalation')),
    ],
    ['Status with a non-string state', AgentEvent, { t: 'status', state: 3 }],
    ['AgentEvent with an unknown kind', AgentEvent, { t: 'telepathy' }],
    [
      'EventEnvelope with a non-ULID id',
      EventEnvelope,
      { ...example('envelope'), id: 'not-a-ulid' },
    ],
    [
      'EventEnvelope with an undotted type',
      EventEnvelope,
      { ...example('envelope'), type: 'usage' },
    ],
  ];

  it.each(cases)('rejects %s', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('rejects a ULID whose first character overflows 48 bits', () => {
    expect(Ulid.safeParse('8ZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(false);
    expect(Ulid.safeParse('7ZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(true);
  });

  it('accepts usage without context or cost (not every vendor reports them)', () => {
    expect(
      AgentEvent.parse({ t: 'usage', inputTokens: 1, outputTokens: 2, source: 'estimated' }).t,
    ).toBe('usage');
  });
});

describe('HandoffPacket nextAction', () => {
  const packet = example('handoff-packet');

  it('is required', () => {
    const { nextAction: _omit, ...rest } = packet;
    expect(HandoffPacket.safeParse(rest).success).toBe(false);
  });

  it('rejects blank text, in zod and in the JSON Schema alike', () => {
    expect(HandoffPacket.safeParse({ ...packet, nextAction: '   ' }).success).toBe(false);
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(toJsonSchema('handoff-packet'));
    expect(validate({ ...packet, nextAction: '   ' })).toBe(false);
  });
});

describe('JSON Schema export', () => {
  it.each(names)('%s has a urn:tacet $id and draft 2020-12', (name) => {
    const doc = toJsonSchema(name);
    expect(doc.$id).toBe(`urn:tacet:schema:${name}:v1`);
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it.each(names)('committed schema/v1/%s.json matches the zod source', (name) => {
    expect(readJson(join(root, 'schema', 'v1', `${name}.json`))).toEqual(toJsonSchema(name));
  });
});

describe('local event namespaces (#126)', () => {
  it('keeps the worktree registry local, and forwards the rest', () => {
    expect(isForwardable('workspace.created')).toBe(false);
    expect(isForwardable('workspace.removed')).toBe(false);
    expect(isForwardable('maintenance.problem')).toBe(false);
    expect(isForwardable('worker.started')).toBe(true);
    expect(isForwardable('task.landed')).toBe(true);
    expect(isForwardable('workspacex.created')).toBe(true);
  });
});
