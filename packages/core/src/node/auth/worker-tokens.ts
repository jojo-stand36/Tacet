import { parseBearer, randomToken, type Secret, tokenKey } from './secret.js';

/** What a worker MCP token is bound to (ADR-003 §6). */
export interface WorkerBinding {
  workerSessionId: string;
  taskId: string;
}

/**
 * Per-worker MCP capability tokens. The Mini-conductor mints one when it spawns a worker, injects
 * it as `Authorization: Bearer …` into that session's MCP config, and revokes it when the session
 * closes. MCP tools take no task or worker argument: identity comes from `resolve()`. Only token
 * hashes are stored.
 */
export class WorkerTokens {
  readonly #byKey = new Map<string, WorkerBinding>();
  readonly #keyBySession = new Map<string, string>();

  /** Mint a token for a worker session. Minting again for the same session revokes the old one. */
  mint(binding: WorkerBinding): Secret {
    this.revoke(binding.workerSessionId);
    const token = randomToken(32);
    const key = tokenKey(token.reveal());
    this.#byKey.set(key, { ...binding });
    this.#keyBySession.set(binding.workerSessionId, key);
    return token;
  }

  /** The binding for a raw token, or `undefined` if it is unknown or revoked. */
  resolve(token: string | undefined | null): WorkerBinding | undefined {
    if (typeof token !== 'string' || token.length === 0) return undefined;
    const binding = this.#byKey.get(tokenKey(token));
    return binding ? { ...binding } : undefined;
  }

  /** Resolve from an `Authorization` header value. */
  resolveHeader(header: string | undefined | null): WorkerBinding | undefined {
    return this.resolve(parseBearer(header));
  }

  /**
   * Resolve a token and require that it belongs to `scope`. Use this wherever a request names a
   * task or session, so a worker cannot act on another one.
   */
  authorize(
    token: string | undefined | null,
    scope: Partial<WorkerBinding>,
  ): WorkerBinding | undefined {
    const binding = this.resolve(token);
    if (!binding) return undefined;
    if (scope.taskId !== undefined && scope.taskId !== binding.taskId) return undefined;
    if (scope.workerSessionId !== undefined && scope.workerSessionId !== binding.workerSessionId) {
      return undefined;
    }
    return binding;
  }

  /** Revoke the token of a worker session. Returns true if one was active. */
  revoke(workerSessionId: string): boolean {
    const key = this.#keyBySession.get(workerSessionId);
    if (key === undefined) return false;
    this.#keyBySession.delete(workerSessionId);
    this.#byKey.delete(key);
    return true;
  }

  revokeAll(): void {
    this.#byKey.clear();
    this.#keyBySession.clear();
  }

  get size(): number {
    return this.#byKey.size;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `WorkerTokens(${this.#byKey.size} active)`;
  }
}

/** The MCP server config headers for a worker session. */
export function mcpAuthHeaders(token: Secret): Record<string, string> {
  return { Authorization: `Bearer ${token.reveal()}` };
}
