import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONDUCTOR_LOCAL_EVENT_NAMESPACES,
  EVENT_BATCH_MAX_BYTES,
  EventEnvelope,
  isForwardable,
  TacetEventParams,
  type TasksState,
  tasksProjection,
} from '@tacet/core';
import { conductorStatePaths, type EventStore, openEventStore } from '@tacet/core/node';

/** Where a replica stands: the Mini-conductor log it copies and the `seq` it has through. */
export interface ReplicaCursor {
  logId: string;
  seq: number;
}

/** What taking a batch came to. A violation closes the connection (1008). */
export type TakeResult =
  | { ok: true; stored: number; skipped: number }
  | { ok: false; violation: string };

const CURSOR = 'x.cursor';
const REGISTRATION = 'x.registration';
const REPO_ID = /^[0-9a-f]{16}$/;

/**
 * The Conductor's replicas of its registered repos' forwarded events (#24, ADR-003 addendum on
 * forwarding events, proposed): one event log per repo, `<state dir>/conductor/repos/<repoId>/
 * events.db`, holding the envelopes as they came (the store is idempotent on the envelope id, so a
 * resent batch changes nothing) and the cursor in the same transaction. Provenance is the
 * replica, so the connection's repo, never an envelope's `repo` field.
 */
export function replicas(stateDir: string) {
  const root = join(conductorStatePaths(stateDir).dir, 'repos');
  const open = new Map<string, EventStore>();
  const dirOf = (repoId: string) => {
    // A path part: only the id Tacet derives from a repo path.
    if (!REPO_ID.test(repoId)) throw new Error(`not a repo id: ${repoId}`);
    return join(root, repoId);
  };
  const store = (repoId: string): EventStore => {
    let s = open.get(repoId);
    if (!s) {
      const dir = dirOf(repoId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      s = openEventStore(join(dir, 'events.db'));
      open.set(repoId, s);
    }
    return s;
  };

  return {
    cursor(repoId: string): ReplicaCursor | undefined {
      if (!existsSync(join(dirOf(repoId), 'events.db'))) return undefined;
      const raw = store(repoId).meta(CURSOR);
      if (!raw) return undefined;
      try {
        const c = JSON.parse(raw) as ReplicaCursor;
        return typeof c.logId === 'string' && Number.isInteger(c.seq) ? c : undefined;
      } catch {
        return undefined;
      }
    },

    /**
     * Take one `tacet/event` batch from the Mini-conductor of `repoId`, resumed on `logId`. The
     * batch is untrusted: each envelope is checked; one this version does not know, or that may
     * not come upward, is skipped (ADR-003 §2); one claiming to be the Conductor's own, or a
     * registry event, is a violation, as is a batch over the limits or of another log.
     */
    take(repoId: string, logId: string, params: unknown): TakeResult {
      if (Buffer.byteLength(JSON.stringify(params ?? null)) > EVENT_BATCH_MAX_BYTES) {
        return { ok: false, violation: 'event batch too large' };
      }
      const parsed = TacetEventParams.safeParse(params);
      if (!parsed.success) return { ok: false, violation: 'invalid event batch' };
      const batch = parsed.data;
      if (batch.logId !== logId) return { ok: false, violation: 'event batch of another log' };
      const keep: Record<string, unknown>[] = [];
      for (const raw of batch.events) {
        const env = EventEnvelope.safeParse(raw);
        // The envelope's shape is the protocol major's (§2): one that does not parse is a fault.
        if (!env.success) return { ok: false, violation: 'invalid event envelope' };
        const ns = env.data.type.split('.', 1)[0] ?? '';
        if (
          env.data.source.kind === 'conductor' ||
          (CONDUCTOR_LOCAL_EVENT_NAMESPACES as readonly string[]).includes(ns)
        ) {
          return { ok: false, violation: 'event batch claims the Conductor' };
        }
        // Allowlisted namespaces are kept whole, a type this version does not know included, so a
        // newer Mini-conductor's events survive until the Conductor is upgraded to read them.
        if (isForwardable(env.data.type)) keep.push(raw);
      }
      // Checked after every refusal above: a batch the cursor already covers changes nothing.
      const at = this.cursor(repoId);
      if (at && at.logId === logId && batch.throughSeq <= at.seq) {
        return { ok: true, stored: 0, skipped: batch.events.length };
      }
      const result = store(repoId).append(keep, {
        meta: { [CURSOR]: JSON.stringify({ logId, seq: batch.throughSeq }) },
      });
      return { ok: true, stored: result.appended, skipped: batch.events.length - keep.length };
    },

    /**
     * Mark the repo's replica as kept under `registration` (the `registry.repo_added` id), made if
     * need be. A replica kept under another registration is begun again first.
     */
    adopt(repoId: string, registration: string): void {
      if (this.registration(repoId) !== registration) {
        this.remove(repoId);
        store(repoId).append([], { meta: { [REGISTRATION]: registration } });
      }
    },

    /** The registration the repo's replica is kept under, if it has one. */
    registration(repoId: string): string | undefined {
      if (!open.has(repoId) && !existsSync(join(dirOf(repoId), 'events.db'))) return undefined;
      return store(repoId).meta(REGISTRATION);
    },

    /** The repo's tasks as its forwarded events have them. */
    tasks(repoId: string): TasksState | undefined {
      if (!REPO_ID.test(repoId)) return undefined;
      if (!open.has(repoId) && !existsSync(join(dirOf(repoId), 'events.db'))) return undefined;
      return store(repoId).replay(tasksProjection);
    },

    /** Repo ids with a replica on disk. */
    list(): string[] {
      if (!existsSync(root)) return [];
      return readdirSync(root).filter((d) => REPO_ID.test(d));
    },

    /** Delete a repo's replica (`tacet up --remove`). */
    remove(repoId: string): void {
      open.get(repoId)?.close();
      open.delete(repoId);
      rmSync(dirOf(repoId), { recursive: true, force: true });
    },

    close(): void {
      for (const s of open.values()) s.close();
      open.clear();
    },
  };
}

/** A repo's replica directory, for `tacet up --remove` while no Conductor runs. */
export function replicaDir(stateDir: string, repoId: string): string {
  if (!REPO_ID.test(repoId)) throw new Error(`not a repo id: ${repoId}`);
  return join(conductorStatePaths(stateDir).dir, 'repos', repoId);
}
