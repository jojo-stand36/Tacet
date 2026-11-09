import { describe, expect, it } from 'vitest';
import { Ulid } from '../schema/common.js';
import { newUlid } from './ulid.js';

describe('newUlid', () => {
  it('produces valid, time-sortable, distinct ULIDs', () => {
    const a = newUlid(1_000);
    const b = newUlid(2_000);
    expect(Ulid.parse(a)).toBe(a);
    expect(a < b).toBe(true);
    expect(newUlid(5).slice(0, 10)).toBe('0000000005');
    const many = new Set(Array.from({ length: 1000 }, () => newUlid()));
    expect(many.size).toBe(1000);
    expect(() => newUlid(-1)).toThrow(RangeError);
  });
});
