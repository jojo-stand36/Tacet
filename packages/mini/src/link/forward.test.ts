import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUlid, TACET_EVENT, TACET_EVENT_RESUME, type TacetEventParams } from '@tacet/core';
import { type ClientContext, type EventStore, openEventStore } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventForwarding } from './forward.js';

/** The Mini-conductor's side of events up (#24): its log is the outbox. */
describe('eventForwarding', () => {
  let dir: string;
  let store: EventStore;
  const stops: (() => void)[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-forward-'));
    store = openEventStore(join(dir, 'events.db'));
  });
  afterEach(() => {
    for (const s of stops.splice(0)) s();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (type: string, data: Record<string, unknown> = {}) => ({
    v: 1,
    id: newUlid(),
    ts: new Date().toISOString(),
    source: { kind: 'mini', id: 'standalone' },
    taskId: 't1',
    type,
    data,
  });
  /** A connection that records what is sent, with a socket buffer the test sets. */
  const link = () => {
    const sent: TacetEventParams[] = [];
    let buffered = 0;
    let close: (v: { code: number; reason: string }) => void = () => {};
    const ctx: ClientContext = {
      sessionId: 's1',
      notify: async (method, params) => {
        expect(method).toBe(TACET_EVENT);
        sent.push(params as TacetEventParams);
      },
      bufferedAmount: () => buffered,
      closed: new Promise((r) => {
        close = r;
      }),
    };
    return {
      ctx,
      sent,
      setBuffered: (n: number) => {
        buffered = n;
      },
      close: () => close({ code: 1000, reason: '' }),
    };
  };
  const start = (
    more: Parameters<typeof eventForwarding>[0] extends infer O ? Partial<O> : never = {},
  ) => {
    const f = eventForwarding({ store, idleMs: 10, ...more });
    stops.push(f.stop);
    return f;
  };
  const resume = (f: ReturnType<typeof eventForwarding>, ctx: ClientContext, p: unknown = {}) =>
    (f.handlers[TACET_EVENT_RESUME] as (p: unknown, c: ClientContext) => unknown)(p, ctx);
  const types = (sent: TacetEventParams[]) =>
    sent.flatMap((b) => b.events.map((e) => (e as { type: string }).type));

  it('sends nothing before the resume, then only forwardable events, in order', async () => {
    store.append([env('task.created'), env('agent.message.delta'), env('workspace.created')]);
    const f = start();
    const l = link();
    await new Promise((r) => setTimeout(r, 50));
    expect(l.sent).toEqual([]);
    expect(resume(f, l.ctx)).toEqual({ logId: store.logId(), afterSeq: 0 });
    store.append(env('task.status'));
    await vi.waitFor(() => expect(types(l.sent)).toEqual(['task.created', 'task.status']));
    // The cursor covers what was read, forwardable or not.
    expect(l.sent.at(-1)?.throughSeq).toBe(4);
    expect(l.sent.every((b) => b.logId === store.logId())).toBe(true);
  });

  it('resumes after the cursor of its own log, and from the start for any other', async () => {
    store.append([env('task.created'), env('task.status'), env('task.status')]);
    const f = start();
    const a = link();
    expect(resume(f, a.ctx, { logId: store.logId(), afterSeq: 2 })).toMatchObject({ afterSeq: 2 });
    await vi.waitFor(() => expect(types(a.sent)).toEqual(['task.status']));
    a.close();
    const b = link();
    expect(resume(f, b.ctx, { logId: 'another-log', afterSeq: 2 })).toMatchObject({ afterSeq: 0 });
    await vi.waitFor(() => expect(types(b.sent)).toHaveLength(3));
    b.close();
    // A cursor past anything this log wrote (forged, or a log restored from a backup).
    const c = link();
    expect(resume(f, c.ctx, { logId: store.logId(), afterSeq: 999 })).toMatchObject({
      afterSeq: 0,
    });
    await vi.waitFor(() => expect(types(c.sent)).toHaveLength(3));
  });

  it('keeps batches within their limits, and skips an envelope too large to send', async () => {
    store.append(Array.from({ length: 7 }, () => env('task.status', { n: 1 })));
    store.append(env('task.status', { big: 'x'.repeat(4000) }));
    store.append(env('task.status', { n: 2 }));
    const errors: string[] = [];
    const f = start({ batchMax: 3, batchMaxBytes: 2048, onError: (m) => errors.push(m) });
    const l = link();
    resume(f, l.ctx);
    await vi.waitFor(() => expect(types(l.sent)).toHaveLength(8));
    expect(Math.max(...l.sent.map((b) => b.events.length))).toBeLessThanOrEqual(3);
    expect(l.sent.at(-1)?.throughSeq).toBe(9);
    expect(errors).toEqual([expect.stringMatching(/too large to forward/)]);
  });

  it('holds the next batch while the socket is full', async () => {
    store.append(Array.from({ length: 6 }, () => env('task.status')));
    const f = start({ batchMax: 2, highWaterBytes: 100 });
    const l = link();
    l.setBuffered(1000);
    resume(f, l.ctx);
    await vi.waitFor(() => expect(l.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 80));
    expect(l.sent).toHaveLength(1);
    l.setBuffered(0);
    await vi.waitFor(() => expect(types(l.sent)).toHaveLength(6));
  });

  it('stops with the connection, and a second resume replaces the first', async () => {
    const f = start();
    const l = link();
    resume(f, l.ctx);
    l.close();
    await new Promise((r) => setTimeout(r, 30));
    store.append(env('task.created'));
    await new Promise((r) => setTimeout(r, 60));
    expect(l.sent).toEqual([]);
    const m = link();
    resume(f, m.ctx, {});
    resume(f, m.ctx, { logId: store.logId(), afterSeq: 1 });
    store.append(env('task.status'));
    await vi.waitFor(() => expect(types(m.sent)).toContain('task.status'));
    expect(types(m.sent).filter((t) => t === 'task.status')).toHaveLength(1);
  });
});
