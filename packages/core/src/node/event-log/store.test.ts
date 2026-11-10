import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { project, type TasksState, tasksProjection } from '../../events/projection.js';
import { EventEnvelope } from '../../schema/envelope.js';
import { repoStateDir } from '../state-dir.js';
import { defaultEventDbPath, type EventStore, openEventStore } from './store.js';

const fixture: Record<string, unknown>[] = readFileSync(
  join(import.meta.dirname, 'fixtures', 'recorded-session.jsonl'),
  'utf8',
)
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const envelopes = fixture.map((e) => EventEnvelope.parse(e));
const idOf = (pred: (e: (typeof envelopes)[number]) => boolean) => {
  const found = [...envelopes].reverse().find(pred);
  if (!found) throw new Error('fixture event not found');
  return found.id;
};

const ESC = '01JCX6000000000000000000ZZ';
const DEC = '01JCX6000000000000000000ZY';
const HO = '01JCX6000000000000000000ZX';

/** The task state this recorded session must replay to, written out by hand. */
const expected: TasksState = {
  tasks: {
    'task-42': {
      task: {
        id: 'task-42',
        goal: 'Add rate limiting to the public API',
        acceptanceCriteria: ['429 after 100 requests per minute per key'],
        budget: { usd: 2 },
        priority: 'p1',
        createdAt: '2026-11-09T12:00:00.000Z',
      },
      state: 'completed',
      escalations: {
        [ESC]: { question: 'Redis or in-memory limiter?', status: 'resolved', decisionId: DEC },
      },
      decisions: [DEC],
      handoffs: [HO],
      activeWorkers: [],
      usage: { inputTokens: 5100, outputTokens: 320, costUsd: 0.0196 },
      lastEventId: idOf((e) => e.type === 'worker.ended' && e.taskId === 'task-42'),
    },
    'task-43': {
      task: {
        id: 'task-43',
        goal: 'Fix flaky login test',
        acceptanceCriteria: ['test passes 50 times in a row'],
        priority: 'p2',
        createdAt: '2026-11-09T12:00:00.000Z',
      },
      state: 'working',
      escalations: {},
      decisions: [],
      handoffs: [],
      activeWorkers: ['sess-9'],
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
      lastEventId: idOf((e) => e.type === 'task.status' && e.taskId === 'task-43'),
    },
  },
  skipped: [idOf((e) => e.type === 'escalation.resolved' && e.taskId === 'task-43')],
};

describe('event log', () => {
  let dir: string;
  let path: string;
  let store: EventStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-events-'));
    path = join(dir, 'events.db');
    store = openEventStore(path);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('replay of a recorded session reproduces task state exactly', () => {
    expect(store.append(fixture)).toEqual({ appended: 30, duplicates: 0 });
    expect(project(tasksProjection, envelopes)).toEqual(expected);
    expect(store.replay(tasksProjection)).toEqual(expected);
  });

  it('replays identically after reopening the database', () => {
    store.append(fixture);
    store.close();
    store = openEventStore(path);
    expect(store.count()).toBe(30);
    expect(store.replay(tasksProjection)).toEqual(expected);
  });

  it('opens read-only beside the writer: sees its appends, never writes (#21)', () => {
    store.append(fixture.slice(0, 10));
    const reader = openEventStore(path, { readonly: true });
    try {
      expect(reader.count()).toBe(10);
      store.append(fixture.slice(10));
      expect(reader.count()).toBe(30);
      expect(reader.replay(tasksProjection)).toEqual(expected);
      expect(reader.query({ afterSeq: 29 })).toHaveLength(1);
      expect(() => reader.append(fixture[0])).toThrow(/read-only/);
      expect(() => reader.compact({ before: '2100-01-01T00:00:00.000Z' })).toThrow(/read-only/);
    } finally {
      reader.close();
    }
  });

  it('reads a closed log read-only without changing it (#21)', () => {
    store.append(fixture);
    store.close();
    const reader = openEventStore(path, { readonly: true });
    try {
      expect(reader.replay(tasksProjection)).toEqual(expected);
    } finally {
      reader.close();
    }
    // Only SQLite's own sidecars may appear, beside the log.
    expect(readdirSync(dir).every((f) => /^events\.db(-wal|-shm)?$/.test(f))).toBe(true);
    store = openEventStore(path);
    expect(store.count()).toBe(30);
  });

  it('refuses to open a missing log read-only, and creates nothing (#21)', () => {
    const missing = join(dir, 'nope', 'events.db');
    expect(() => openEventStore(missing, { readonly: true })).toThrow();
    expect(() => statSync(join(dir, 'nope'))).toThrow();
  });

  it('replays identically when events arrive one at a time', () => {
    for (const e of fixture) store.append(e);
    expect(store.replay(tasksProjection)).toEqual(expected);
  });

  it('is idempotent on envelope id', () => {
    store.append(fixture);
    expect(store.append(fixture)).toEqual({ appended: 0, duplicates: 30 });
    expect(store.count()).toBe(30);
  });

  it('keeps fields this version does not know in the raw envelope', () => {
    store.append(fixture);
    const withExtra = store.query().find((e) => 'futureEnvelopeField' in e.raw);
    expect(withExtra?.raw.futureEnvelopeField).toBe('kept');
    expect(withExtra?.envelope).not.toHaveProperty('futureEnvelopeField');
  });

  it('filters by task, session, type prefix, sequence and limit', () => {
    store.append(fixture);
    expect(store.query({ taskId: 'task-43' }).map((e) => e.envelope.type)).toEqual([
      'task.created',
      'worker.started',
      'agent.usage',
      'task.status',
      'escalation.resolved',
    ]);
    expect(store.query({ sessionId: 'sess-2' })).toHaveLength(4);
    expect(store.query({ typePrefix: 'agent.usage' })).toHaveLength(4);
    expect(store.query({ typePrefix: 'agent' })).toHaveLength(12);
    expect(store.query({ typePrefix: 'agen' })).toHaveLength(0);
    const first = store.query({ limit: 2 });
    expect(first.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.query({ afterSeq: 28 }).map((e) => e.seq)).toEqual([29, 30]);
  });

  it('rejects an invalid envelope and appends nothing from that batch', () => {
    const bad = { ...fixture[0], id: 'not-a-ulid' };
    expect(() => store.append([fixture[1], bad])).toThrow();
    expect(store.count()).toBe(0);
  });

  it('is append-only: UPDATE and DELETE fail outside compact()', () => {
    store.append(fixture);
    const raw = new Database(path);
    try {
      expect(() => raw.prepare(`UPDATE events SET type = 'x' WHERE seq = 1`).run()).toThrow(
        /append-only/,
      );
      expect(() => raw.prepare('DELETE FROM events WHERE seq = 1').run()).toThrow(/append-only/);
    } finally {
      raw.close();
    }
    expect(store.count()).toBe(30);
  });

  it('retention drops old transcript events but task state replays exactly', () => {
    store.append(fixture);
    const deleted = store.compact({ before: '2026-11-09T13:00:00.000Z' });
    expect(deleted).toBe(8);
    expect(store.query({ typePrefix: 'agent.message' })).toHaveLength(0);
    expect(store.query({ typePrefix: 'agent.usage' })).toHaveLength(4);
    expect(store.replay(tasksProjection)).toEqual(expected);

    const raw = new Database(path);
    try {
      expect(() => raw.prepare('DELETE FROM events').run()).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  it('keeps the worktree registry (workspace.*) through retention (#126)', () => {
    store.append({
      v: 1,
      id: '01J00000000000000000000W01',
      ts: '2026-01-01T00:00:00.000Z',
      source: { kind: 'mini', id: 'mini' },
      type: 'workspace.created',
      data: { workspaceId: 'w-1', workerId: 's-1', baseCommit: 'a'.repeat(40) },
    });
    store.compact({ before: '2100-01-01T00:00:00.000Z' });
    expect(store.query({ typePrefix: 'workspace' })).toHaveLength(1);
  });

  it('refuses a database with a newer schema version', () => {
    store.close();
    const raw = new Database(path);
    raw.prepare(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`).run();
    raw.close();
    expect(() => openEventStore(path)).toThrow(/schema version 99/);
    store = openEventStore(join(dir, 'other.db'));
  });

  it('creates the DB directory with mode 0700, and defaults to a per-repo path outside the repo', () => {
    const nested = join(dir, 'state', 'abc', 'events.db');
    const s2 = openEventStore(nested);
    s2.close();
    expect(statSync(join(dir, 'state', 'abc')).mode & 0o777).toBe(0o700);
    const p = defaultEventDbPath('/src/api', join(dir, 'state'));
    expect(p).toBe(join(repoStateDir('/src/api', join(dir, 'state')), 'events.db'));
    expect(p).toBe(defaultEventDbPath('/src/api/', join(dir, 'state')));
    expect(p).not.toBe(defaultEventDbPath('/src/web', join(dir, 'state')));
    expect(p.startsWith(join(dir, 'state'))).toBe(true);
    expect(p.endsWith('events.db')).toBe(true);
  });
});
