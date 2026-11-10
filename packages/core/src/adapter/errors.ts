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

/**
 * Thrown by `start()` when the adapter will not fork this session (#228): its `capabilities().fork`
 * is `none`, or a `native` fork the vendor did not offer for this session (an ACP agent that does
 * not advertise `session/fork`). Nothing is left running. A caller can tell it from a start that
 * failed, and fall back to seeding a new session from a HandoffPacket.
 */
export class ForkRefusedError extends Error {
  readonly adapterId: string;
  constructor(adapterId: string, message: string) {
    super(message);
    this.name = 'ForkRefusedError';
    this.adapterId = adapterId;
  }
}
