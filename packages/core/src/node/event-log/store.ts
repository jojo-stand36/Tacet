import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { type Projection, project } from '../../events/projection.js';
import { EventEnvelope } from '../../schema/envelope.js';
import { defaultStateDir, repoStateDir } from '../state-dir.js';

/**
 * Append-only event log (ARCHITECTURE.md §3, ADR-003 §1). Driver: better-sqlite3, chosen under
 * ADR-002 decision 5 because `node:sqlite` is still "Stability: 1.2 - Release candidate" in the
 * Node 24 and Node 26 docs (checked 2026-11-09). Callers depend on `EventStore`, so swapping in
 * `node:sqlite` once it is Stable is a change to this file only.
 */
export interface EventStore {
  /**
   * Validate and append envelopes in one transaction. Re-appending an id that is already stored
   * is a no-op (the envelope id is the idempotency key). The raw input is stored as given, so
   * fields this version does not know survive a round trip.
   */
  append(events: unknown | unknown[]): AppendResult;
  /** Stored events in log order. */
  query(filter?: EventFilter): StoredEvent[];
  /** Fold matching events, in log order, into a fresh projection state. */
  replay<S>(projection: Projection<S>, filter?: EventFilter): S;
  /** Apply the retention policy. Returns how many events were deleted. */
  compact(policy: RetentionPolicy): number;
  count(): number;
  close(): void;
}

export interface AppendResult {
  appended: number;
  duplicates: number;
}

export interface EventFilter {
  taskId?: string;
  sessionId?: string;
  /** Matches `type` exactly or as a dotted prefix: `agent` matches `agent.usage`. */
  typePrefix?: string;
  /** Only events with a log sequence number greater than this. */
  afterSeq?: number;
  limit?: number;
}

export interface StoredEvent {
  seq: number;
  envelope: EventEnvelope;
  /** The envelope exactly as appended, including fields this version does not know. */
  raw: Record<string, unknown>;
}

/**
 * Retention: events older than `before` whose type starts with one of `dropTypes` are deleted.
 * The default keeps every summary-grade event (task, escalation, decision, handoff, worker,
 * workspace, budget and `agent.usage`) forever, and drops transcript-grade events (`agent.message`,
 * `agent.tool`, `agent.approval`, `agent.status`, `agent.escalation`) once they are old. Task
 * state replays exactly after compaction because the task projection only reads kept types, and
 * a restarted Mini-conductor rebuilds its Worker pool from the kept `worker.*` events.
 */
export interface RetentionPolicy {
  before: string;
  dropTypes?: string[];
}

export const DEFAULT_DROP_TYPES = [
  'agent.message',
  'agent.tool',
  'agent.approval',
  'agent.status',
  'agent.escalation',
] as const;

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  repo TEXT,
  task_id TEXT,
  session_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  envelope TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS events_type ON events (type, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'event log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  WHEN (SELECT value FROM meta WHERE key = 'compacting') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'event log is append-only; use compact()'); END;
`;

interface Row {
  seq: number;
  envelope: string;
}

/**
 * Default event DB for a repo: `<stateDir>/<repo-hash>/events.db`, outside the repo so it is never
 * committed (`stateDir` defaults to `~/.tacet/state`, config `events.state_dir`).
 */
export function defaultEventDbPath(repoPath: string, stateDir = defaultStateDir()): string {
  return join(repoStateDir(repoPath, stateDir), 'events.db');
}

export interface OpenEventStoreOptions {
  /**
   * Open an existing log for reading only, from a process other than its writer (`tacet status`,
   * `logs`, `attach`, #21): the log is never written, and `append` and `compact` throw. SQLite may
   * create its `-wal` and `-shm` files beside the log, in the log's own 0700 directory. Reads
   * while the writer appends are safe (WAL). Throws, creating nothing, when there is no log.
   */
  readonly?: boolean;
}

/**
 * Open (creating if needed) the event log at `path`. The containing directory is created with
 * mode 0700 and must be a real directory, not a symlink.
 */
export function openEventStore(path: string, opts: OpenEventStoreOptions = {}): EventStore {
  if (opts.readonly) return openReadonly(path);
  if (path !== ':memory:') {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory()) throw new Error(`event log directory ${dir} is not a directory`);
    chmodSync(dir, 0o700);
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(DDL);
  return storeOn(db, false);
}

function openReadonly(path: string): EventStore {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return storeOn(db, true);
  } catch (err) {
    db.close();
    throw err;
  }
}

function storeOn(db: Database.Database, readonly: boolean): EventStore {
  const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (version === undefined) {
    if (readonly) throw new Error('event log has no schema version');
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  } else if (Number(version.value) !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `event log schema version ${version.value} is not supported (expected ${SCHEMA_VERSION})`,
    );
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (id, ts, type, repo, task_id, session_id, correlation_id, causation_id, envelope)
     VALUES (@id, @ts, @type, @repo, @taskId, @sessionId, @correlationId, @causationId, @envelope)`,
  );
  const appendMany = db.transaction((items: unknown[]): AppendResult => {
    let appended = 0;
    for (const raw of items) {
      const env = EventEnvelope.parse(raw);
      const info = insert.run({
        id: env.id,
        ts: env.ts,
        type: env.type,
        repo: env.repo ?? null,
        taskId: env.taskId ?? null,
        sessionId: env.sessionId ?? null,
        correlationId: env.correlationId ?? null,
        causationId: env.causationId ?? null,
        envelope: JSON.stringify(raw),
      });
      appended += info.changes;
    }
    return { appended, duplicates: items.length - appended };
  });

  const toStored = (row: Row): StoredEvent => {
    const raw = JSON.parse(row.envelope) as Record<string, unknown>;
    return { seq: row.seq, envelope: EventEnvelope.parse(raw), raw };
  };

  const select = (filter: EventFilter = {}): Row[] => {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.taskId !== undefined) {
      where.push('task_id = @taskId');
      params.taskId = filter.taskId;
    }
    if (filter.sessionId !== undefined) {
      where.push('session_id = @sessionId');
      params.sessionId = filter.sessionId;
    }
    if (filter.typePrefix !== undefined) {
      where.push(`(type = @type OR substr(type, 1, length(@type) + 1) = @type || '.')`);
      params.type = filter.typePrefix;
    }
    if (filter.afterSeq !== undefined) {
      where.push('seq > @afterSeq');
      params.afterSeq = filter.afterSeq;
    }
    const sql = `SELECT seq, envelope FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq${
      filter.limit !== undefined ? ' LIMIT @limit' : ''
    }`;
    if (filter.limit !== undefined) params.limit = filter.limit;
    return db.prepare(sql).all(params) as Row[];
  };

  const compactTx = db.transaction((policy: RetentionPolicy): number => {
    const types = policy.dropTypes ?? [...DEFAULT_DROP_TYPES];
    if (types.length === 0) return 0;
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('compacting', '1')`).run();
    try {
      const matches = types.map(
        (_, i) => `(type = @t${i} OR substr(type, 1, length(@t${i}) + 1) = @t${i} || '.')`,
      );
      const params: Record<string, string> = { before: policy.before };
      types.forEach((t, i) => {
        params[`t${i}`] = t;
      });
      return db
        .prepare(`DELETE FROM events WHERE ts < @before AND (${matches.join(' OR ')})`)
        .run(params).changes;
    } finally {
      db.prepare(`DELETE FROM meta WHERE key = 'compacting'`).run();
    }
  });

  return {
    append: (events) => {
      if (readonly) throw new Error('event log opened read-only');
      return appendMany(Array.isArray(events) ? events : [events]);
    },
    query: (filter) => select(filter).map(toStored),
    replay: (projection, filter) =>
      project(
        projection,
        select(filter).map((r) => toStored(r).envelope),
      ),
    compact: (policy) => {
      if (readonly) throw new Error('event log opened read-only');
      return compactTx(policy);
    },
    count: () => (db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n,
    close: () => db.close(),
  };
}
