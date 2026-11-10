import { describe, expect, it } from 'vitest';
import { plainText, TerminalBuffer } from './terminal.js';

describe('TerminalBuffer', () => {
  it('keeps a bounded scrollback and streams output to each viewer', async () => {
    const t = new TerminalBuffer(80, 24);
    t.push('before ');
    const a = t.output()[Symbol.asyncIterator]();
    const b = t.output()[Symbol.asyncIterator]();
    t.push('one');
    t.push('two');
    expect(await a.next()).toEqual({ value: 'one', done: false });
    expect(await b.next()).toEqual({ value: 'one', done: false });
    t.end();
    // What a viewer had not read yet still arrives, then the stream ends.
    expect(await a.next()).toEqual({ value: 'two', done: false });
    expect(await a.next()).toEqual({ value: undefined, done: true });
    expect(t.scrollback()).toBe('before onetwo');
    t.push('x'.repeat(300 * 1024));
    expect(t.scrollback().length).toBeLessThan(300 * 1024);
  });

  it('ends a viewer that falls too far behind, and one that stops reading', async () => {
    const t = new TerminalBuffer(80, 24);
    const slow = t.output()[Symbol.asyncIterator]();
    t.push('x'.repeat(2 * 1024 * 1024));
    expect(await slow.next()).toEqual({ value: undefined, done: true });
    const quitter = t.output()[Symbol.asyncIterator]();
    await quitter.return?.();
    t.push('more');
    expect(await quitter.next()).toEqual({ value: undefined, done: true });
  });
});

describe('plainText', () => {
  it('drops escape sequences and keeps the text', () => {
    const esc = '\x1b';
    expect(
      plainText(
        `${esc}[?2004h${esc}[1;32mgreen${esc}[0m${esc}]0;title\x07 ok\r\nnext${esc}7${esc}(B`,
      ),
    ).toBe('green ok\nnext');
  });
});
