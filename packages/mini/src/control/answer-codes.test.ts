import { describe, expect, it } from 'vitest';
import { AnswerCodes } from './answer-codes.js';

describe('AnswerCodes (#269)', () => {
  it('makes one 8-character code per escalation, and takes it typed loosely', () => {
    const codes = new AnswerCodes();
    const code = codes.issue('e1');
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(codes.issue('e1')).toBe(code);
    expect(codes.issue('e2')).not.toBe(code);
    expect(codes.check('e1', code)).toBeUndefined();
    const loose = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `;
    expect(codes.check('e1', loose)).toBeUndefined();
    // Crockford's look-alikes: O for 0, I or l for 1.
    const alike = code.replace(/0/g, 'O').replace(/1/g, 'l');
    expect(codes.check('e1', alike)).toBeUndefined();
  });

  it('refuses no code, a wrong one and one of another escalation', () => {
    const codes = new AnswerCodes();
    expect(codes.check('e1', 'ABCDEFGH')).toBe('none');
    const one = codes.issue('e1');
    const two = codes.issue('e2');
    expect(codes.check('e1', undefined)).toBe('wrong');
    expect(codes.check('e1', '')).toBe('wrong');
    expect(codes.check('e1', two)).toBe('wrong');
    expect(codes.check('e1', `${one}0`)).toBe('wrong');
    expect(codes.check('e1', 'x'.repeat(10_000))).toBe('withdrawn');
  });

  it('withdraws a code after five wrong tries, and the next one shown is new', () => {
    const codes = new AnswerCodes();
    const first = codes.issue('e1');
    for (let i = 0; i < 4; i++) expect(codes.check('e1', 'WRONG000')).toBe('wrong');
    expect(codes.check('e1', 'WRONG000')).toBe('withdrawn');
    // Even the right one, now.
    expect(codes.check('e1', first)).toBe('withdrawn');
    const second = codes.issue('e1');
    expect(second).not.toBe(first);
    expect(codes.check('e1', second)).toBeUndefined();
  });

  it('forgets an answered escalation', () => {
    const codes = new AnswerCodes();
    const code = codes.issue('e1');
    codes.drop('e1');
    expect(codes.check('e1', code)).toBe('none');
  });
});
