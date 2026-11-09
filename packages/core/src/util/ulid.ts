const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A new ULID (ADR-003 §1): 48-bit millisecond time, then 80 random bits, in Crockford base32.
 * Sortable by creation time across processes; not monotonic within one millisecond, which is
 * fine because event order comes from the log's sequence number. Isomorphic: uses Web Crypto.
 */
export function newUlid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > 2 ** 48 - 1) {
    throw new RangeError('ULID time must be a 48-bit millisecond timestamp');
  }
  let time = '';
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return time + rand;
}
