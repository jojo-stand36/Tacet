import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  checkHostAndOrigin,
  type LoopbackListener,
  listenLoopback,
  parseBearer,
  randomToken,
  type Secret,
  tokenKey,
} from '@tacet/core/node';

/** Largest hook body accepted. Claude Code's events are small; a transcript is passed by path. */
const MAX_BODY = 1024 * 1024;

/** One hook event, as the vendor POSTed it. Parsed by the preset, never trusted for identity. */
export type HookBody = Record<string, unknown>;

/**
 * What a session does with its hook events. `reply` answers the vendor's request: an object is
 * sent as JSON, `undefined` as an empty `{}` (no decision). It may be called later, for a
 * permission that waits on a decision; `onAbort` fires if the vendor gives up first.
 */
export type HookHandler = (
  body: HookBody,
  reply: (out?: object) => void,
  onAbort: (fn: () => void) => void,
) => void;

/**
 * The PTY adapter's loopback endpoint for vendor hooks (#15): one per adapter, shared by its
 * sessions, each of which has its own bearer token. Identity comes from the token only (as for
 * Worker MCP tokens, ADR-003 §6); the path and the body's session id are not trusted. Bound to
 * 127.0.0.1 and ::1 (ADR-003 §3.1); a request with an `Origin` is refused, since no browser may
 * call it.
 */
export class HookServer {
  readonly #handlers = new Map<string, HookHandler>();
  #listener: LoopbackListener | undefined;
  #starting: Promise<LoopbackListener> | undefined;

  /** Register a session; returns its token and the URL its hooks POST to. */
  async register(handler: HookHandler): Promise<{ token: Secret; url: string; key: string }> {
    const listener = await this.#listen();
    const token = randomToken();
    const key = tokenKey(token.reveal());
    this.#handlers.set(key, handler);
    return { token, url: `http://127.0.0.1:${listener.port}/hooks`, key };
  }

  /** Forget a session; closes the server after the last one. */
  async unregister(key: string): Promise<void> {
    this.#handlers.delete(key);
    if (this.#handlers.size === 0 && this.#listener) {
      const l = this.#listener;
      this.#listener = undefined;
      this.#starting = undefined;
      await l.close();
    }
  }

  async #listen(): Promise<LoopbackListener> {
    if (this.#listener) return this.#listener;
    this.#starting ??= listenLoopback(() =>
      createServer((req, res) => {
        this.#handle(req, res);
      }),
    ).then((l) => {
      this.#listener = l;
      return l;
    });
    return this.#starting;
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const deny = (code: number) => {
      res.writeHead(code).end();
      req.resume();
    };
    const port = this.#listener?.port ?? 0;
    if (req.method !== 'POST' || !req.url?.startsWith('/hooks')) {
      deny(404);
      return;
    }
    if (req.headers.origin !== undefined) {
      deny(403);
      return;
    }
    if (!checkHostAndOrigin(req.headers, port, 'bearer').ok) {
      deny(403);
      return;
    }
    const token = parseBearer(req.headers.authorization);
    const handler = token === undefined ? undefined : this.#handlers.get(tokenKey(token));
    if (!handler) {
      deny(401);
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) {
        deny(413);
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        deny(400);
        return;
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        deny(400);
        return;
      }
      let done = false;
      const aborts: (() => void)[] = [];
      res.on('close', () => {
        if (!done) for (const fn of aborts) fn();
      });
      handler(
        body as HookBody,
        (out) => {
          if (done || res.writableEnded) return;
          done = true;
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? {}));
        },
        (fn) => aborts.push(fn),
      );
    });
  }
}
