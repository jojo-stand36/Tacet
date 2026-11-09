import { HelloParams, type HelloResult } from '../../schema/hello.js';

/** WebSocket close codes used by the handshake (ADR-003 §2, §3). */
export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_NO_COMMON_VERSION = 4406;
/** RFC 6455 policy violation: a first frame that is not a valid `tacet/hello`. */
export const CLOSE_POLICY_VIOLATION = 1008;

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

export type GateAction =
  | { kind: 'reply'; message: { jsonrpc: '2.0'; id: string | number; result: HelloResult } }
  | { kind: 'close'; code: number; reason: string; message?: JsonRpcError }
  | { kind: 'pass' };

export interface HelloGateOptions {
  /** Protocol majors this server supports. */
  versions: number[];
  serverInfo: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  /** Mint the session id returned in the hello result. */
  newSessionId: () => string;
  /** Called with the validated hello params once the handshake succeeds. */
  onHello?: (params: HelloParams, protocolVersion: number) => void;
}

/**
 * Per-socket handshake state machine (ADR-003 §3.6). Feed it every frame: text frames to
 * `handle()`, binary frames to `handleBinary()`. It answers the first frame and tells the caller
 * to close the socket unless that frame is a valid `tacet/hello` with a protocol version both
 * sides support. After a failure it stays closed: every later frame also gets a close action.
 * After success, later frames pass through.
 */
export class HelloGate {
  #state: 'waiting' | 'open' | 'failed' = 'waiting';
  readonly #opts: HelloGateOptions;

  constructor(opts: HelloGateOptions) {
    if (opts.versions.length === 0) throw new Error('HelloGate needs at least one version');
    this.#opts = opts;
  }

  get open(): boolean {
    return this.#state === 'open';
  }

  /** Binary frames are never valid before hello. */
  handleBinary(): GateAction {
    if (this.#state === 'open') return { kind: 'pass' };
    return this.#fail(null, -32600, 'first frame must be a tacet/hello text frame');
  }

  handle(frame: string): GateAction {
    if (this.#state === 'open') return { kind: 'pass' };
    if (this.#state === 'failed') return this.#fail(null, -32600, 'handshake failed');
    let msg: unknown;
    try {
      msg = JSON.parse(frame);
    } catch {
      return this.#fail(null, -32700, 'parse error');
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      return this.#fail(null, -32600, 'first request must be tacet/hello');
    }
    const { jsonrpc, id, method, params } = msg as Record<string, unknown>;
    const rpcId = typeof id === 'string' || typeof id === 'number' ? id : null;
    if (jsonrpc !== '2.0' || method !== 'tacet/hello' || rpcId === null) {
      return this.#fail(rpcId, -32600, 'first request must be tacet/hello');
    }
    const parsed = HelloParams.safeParse(params);
    if (!parsed.success) return this.#fail(rpcId, -32602, 'invalid tacet/hello params');

    const common = parsed.data.protocolVersions.filter((v) => this.#opts.versions.includes(v));
    if (common.length === 0) {
      this.#state = 'failed';
      return {
        kind: 'close',
        code: CLOSE_NO_COMMON_VERSION,
        reason: 'no common protocol version',
        message: {
          jsonrpc: '2.0',
          id: rpcId,
          error: {
            code: -32600,
            message: `supported protocol versions: ${this.#opts.versions.join(', ')}`,
          },
        },
      };
    }
    const protocolVersion = Math.max(...common);
    try {
      this.#opts.onHello?.(parsed.data, protocolVersion);
    } catch {
      return this.#fail(rpcId, -32603, 'hello rejected');
    }
    this.#state = 'open';
    return {
      kind: 'reply',
      message: {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          protocolVersion,
          serverInfo: this.#opts.serverInfo,
          capabilities: this.#opts.capabilities ?? {},
          sessionId: this.#opts.newSessionId(),
        },
      },
    };
  }

  #fail(id: string | number | null, code: number, message: string): GateAction {
    this.#state = 'failed';
    return {
      kind: 'close',
      code: CLOSE_POLICY_VIOLATION,
      reason: message,
      message: { jsonrpc: '2.0', id, error: { code, message } },
    };
  }
}
