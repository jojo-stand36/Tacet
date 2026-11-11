import {
  CONDUCTOR_LOCAL_EVENT_NAMESPACES,
  EVENT_BATCH_MAX,
  EVENT_BATCH_MAX_BYTES,
  EventResumeParams,
  type EventResumeResult,
  isForwardable,
  TACET_EVENT,
  TACET_EVENT_RESUME,
} from '@tacet/core';
import { type ClientContext, type EventStore, RpcError } from '@tacet/core/node';

export interface ForwardOptions {
  store: EventStore;
  /** Envelopes per batch, at most. Default `EVENT_BATCH_MAX` (200). */
  batchMax?: number;
  /** Bytes per batch, at most. Default `EVENT_BATCH_MAX_BYTES` (256 KiB). */
  batchMaxBytes?: number;
  /** How long to wait for new events once caught up, in ms. Default 250. */
  idleMs?: number;
  /** Bytes the socket may hold unsent before the next batch waits. Default 1 MiB. */
  highWaterBytes?: number;
  /** Told about what could not be forwarded, by message only. */
  onError?: (message: string) => void;
}

/**
 * An envelope the Conductor refuses with a close (1008): never sent, or one bad row in the log
 * would close the link at every resume. It claims to be the Conductor's, or is Conductor-local.
 */
function refused(e: { source: { kind: string }; type: string }): boolean {
  const ns = e.type.split('.', 1)[0] ?? '';
  return (
    e.source.kind === 'conductor' ||
    (CONDUCTOR_LOCAL_EVENT_NAMESPACES as readonly string[]).includes(ns)
  );
}

/** Bytes of a frame's text other than its envelopes: `{"jsonrpc":…,"params":{"logId":…}}`. */
const FRAME_OVERHEAD = 512;

/**
 * Events up the Conductor link (#24, ADR-003 addendum on forwarding events, proposed): the
 * Mini-conductor's own log is the outbox. Nothing is sent until the Conductor calls
 * `tacet/event.resume`, which it does only for a registered repo, once it has accepted the
 * connection; forwarding then starts after the Conductor's cursor (`afterSeq`, when the `logId`
 * is this log's) and runs until the connection goes. Only `isForwardable` types are sent (ADR-003
 * §4's allowlist), in log order, in batches of at most 200 envelopes or 256 KiB; the next batch
 * waits while the socket holds more than 1 MiB unsent. Nothing is lost when the link drops: the
 * next resume starts from what the Conductor stored.
 */
export function eventForwarding(o: ForwardOptions) {
  const live = new Map<string, { stop(): void }>();
  let closed = false;

  const forward = (ctx: ClientContext, start: number) => {
    let stopped = false;
    let wake: (() => void) | undefined;
    const stop = () => {
      stopped = true;
      wake?.();
    };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (stopped) return resolve();
        const t = setTimeout(resolve, ms);
        t.unref();
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    void ctx.closed.then(stop);
    const max = o.batchMax ?? EVENT_BATCH_MAX;
    const maxBytes = (o.batchMaxBytes ?? EVENT_BATCH_MAX_BYTES) - FRAME_OVERHEAD;
    const logId = o.store.logId();
    const run = async () => {
      // After the resume's answer is on the socket: a batch never goes before it.
      await new Promise((r) => setImmediate(r));
      let after = start;
      /** The `throughSeq` last sent: an empty batch is only worth sending when it moves this. */
      let sent = start;
      const page = max * 4;
      while (!stopped && !closed) {
        const events: Record<string, unknown>[] = [];
        let bytes = 0;
        let through = after;
        let full = false;
        let caughtUp = false;
        // Read on, page by page, until the batch is full or the log is read to its end: a long run
        // of events that never go up (transcripts) costs reads, never a stream of empty frames.
        while (!full && !caughtUp && !stopped) {
          const rows = o.store.query({ afterSeq: through, limit: page });
          caughtUp = rows.length < page;
          for (const row of rows) {
            if (!isForwardable(row.envelope.type) || refused(row.envelope)) {
              through = row.seq;
              continue;
            }
            const size = Buffer.byteLength(JSON.stringify(row.raw));
            if (size > maxBytes) {
              // Never sendable whole: skipped, said by its id and type only.
              o.onError?.(
                `event ${row.envelope.id} (${row.envelope.type}) is too large to forward`,
              );
              through = row.seq;
              continue;
            }
            if (events.length >= max || bytes + size > maxBytes) {
              full = true;
              break;
            }
            events.push(row.raw);
            bytes += size;
            through = row.seq;
          }
        }
        if (stopped) break;
        // Empty only once caught up, to move the Conductor's cursor past what never goes up.
        if (events.length > 0 || through > sent) {
          await ctx.notify(TACET_EVENT, { logId, throughSeq: through, events });
          sent = through;
        }
        after = through;
        // Backpressure: the next batch only once the socket has sent most of this one.
        while (!stopped && ctx.bufferedAmount() > (o.highWaterBytes ?? 1024 * 1024)) {
          await sleep(20);
        }
        if (!full) await sleep(o.idleMs ?? 250);
      }
    };
    void run().catch((err: unknown) => {
      // The connection went mid-send, or the log closed: the next resume picks up from the cursor.
      if (!stopped && !closed) o.onError?.(err instanceof Error ? err.message : String(err));
    });
    return { stop };
  };

  return {
    /** The methods the Conductor may call on the link for events. */
    handlers: {
      [TACET_EVENT_RESUME]: (p: unknown, ctx: ClientContext): EventResumeResult => {
        const parsed = EventResumeParams.safeParse(p ?? {});
        if (!parsed.success) throw new RpcError(-32602, 'invalid params');
        const logId = o.store.logId();
        // Another log's cursor, or one past what this log ever wrote (a forged or restored one):
        // from the start, so nothing is skipped.
        const ours =
          parsed.data.logId === logId && (parsed.data.afterSeq ?? 0) <= o.store.lastSeq();
        const afterSeq = ours ? (parsed.data.afterSeq ?? 0) : 0;
        // A second resume on the same connection restarts from the new point.
        live.get(ctx.sessionId)?.stop();
        const f = forward(ctx, afterSeq);
        live.set(ctx.sessionId, f);
        void ctx.closed.then(() => {
          if (live.get(ctx.sessionId) === f) live.delete(ctx.sessionId);
        });
        return { logId, afterSeq };
      },
    },
    /** Stop every forwarder, before the log closes. */
    stop() {
      closed = true;
      for (const f of live.values()) f.stop();
      live.clear();
    },
  };
}
