import { describe, expect, it } from 'vitest';
import { type HookBody, HookServer } from './hook-server.js';

/** The hook endpoint with two live sessions (#259): identity comes from the token only. */
describe('HookServer', () => {
  it("never hands one session's hook to another, whatever the path or body say", async () => {
    const server = new HookServer();
    const got: Record<'a' | 'b', HookBody[]> = { a: [], b: [] };
    const a = await server.register((body, reply) => {
      got.a.push(body);
      reply({});
    });
    const b = await server.register((body, reply) => {
      got.b.push(body);
      reply({});
    });
    try {
      const post = (token: string, path: string, body: object) =>
        fetch(`${a.url}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      // B's token, on a path and with a body that name A: it reaches B's handler only.
      expect((await post(b.token.reveal(), '/Stop', { session: 'a', n: 1 })).status).toBe(200);
      // A's token reaches A only.
      expect((await post(a.token.reveal(), '/Stop', { n: 2 })).status).toBe(200);
      // No token, a wrong one, or a revoked one reaches nobody.
      expect((await post('', '/Stop', { n: 3 })).status).toBe(401);
      expect((await post('not-a-token', '/Stop', { n: 4 })).status).toBe(401);
      await server.unregister(b.key);
      expect((await post(b.token.reveal(), '/Stop', { n: 5 })).status).toBe(401);
      expect(got).toEqual({ a: [{ n: 2 }], b: [{ session: 'a', n: 1 }] });
    } finally {
      await server.unregister(a.key);
    }
  });
});
