import type { Server } from 'node:net';

export interface LoopbackListener {
  port: number;
  /** The servers actually listening: IPv4 always, IPv6 when the host supports it. */
  servers: Server[];
  close(): Promise<void>;
}

const listen = (server: Server, host: string, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port, exclusive: true });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });

const IPV6_UNAVAILABLE = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL']);

/**
 * Listen on 127.0.0.1 and ::1 with the same OS-assigned port (ADR-003 §3.1). Never binds a
 * wildcard address. `create` is called once per address and must return a fresh server, e.g.
 * `() => http.createServer(handler)`. If the IPv6 loopback is unavailable, only IPv4 is used,
 * which is why clients must dial `127.0.0.1`, never `localhost` (which may resolve to ::1).
 */
export async function listenLoopback(
  create: () => Server,
  opts: { attempts?: number } = {},
): Promise<LoopbackListener> {
  const attempts = opts.attempts ?? 5;
  for (let i = 0; i < attempts; i++) {
    const v4 = create();
    await listen(v4, '127.0.0.1', 0);
    const address = v4.address();
    if (address === null || typeof address === 'string') throw new Error('unexpected address');
    const port = address.port;
    const v6 = create();
    try {
      await listen(v6, '::1', port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EADDRINUSE') {
        await closeServer(v4);
        continue;
      }
      if (!IPV6_UNAVAILABLE.has(code)) {
        await closeServer(v4);
        throw err;
      }
      return { port, servers: [v4], close: () => closeServer(v4) };
    }
    const servers = [v4, v6];
    return { port, servers, close: async () => void (await Promise.all(servers.map(closeServer))) };
  }
  throw new Error(`could not bind 127.0.0.1 and ::1 to a common port after ${attempts} attempts`);
}
