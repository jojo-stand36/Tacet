/**
 * Thrown by `start()` or `send()` when the adapter cannot honour a requested profile field
 * (a model without effort support, a context window it cannot select), so nothing runs on
 * settings other than the ones asked for (#110).
 */
export class ProfileRefusedError extends Error {
  readonly field: 'model' | 'effort' | 'contextWindow';
  constructor(field: 'model' | 'effort' | 'contextWindow', message: string) {
    super(message);
    this.name = 'ProfileRefusedError';
    this.field = field;
  }
}
