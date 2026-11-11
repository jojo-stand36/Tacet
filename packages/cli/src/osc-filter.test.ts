import { describe, expect, it } from 'vitest';
import { OscFilter } from './osc-filter.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const bytes = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));
/** Run `input` through a fresh filter in the given chunks; the output, as latin1 text. */
function run(input: Uint8Array, cuts: number[] = []): string {
  const f = new OscFilter();
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const c of [...cuts, input.length]) {
    parts.push(f.push(input.subarray(at, c)));
    at = c;
  }
  return parts.map(dec).join('');
}

const E = '\x1b';
const CLIP = `${E}]52;c;ZWNobyBwd25lZA==\x07`;
const CLIP_ST = `${E}]52;c;ZWNobyBwd25lZA==${E}\\`;
/** U+009D and U+009C, the C1 OSC and ST, as UTF-8. */
const CLIP_C1 = '\xc2\x9d52;c;ZWNobw==\xc2\x9c';
const TITLE = `${E}]0;my title\x07`;

describe('OscFilter (#302)', () => {
  it('removes OSC 52 with BEL, ESC \\ or C1 ST, and nothing else', () => {
    expect(run(bytes(`a${CLIP}b`))).toBe('ab');
    expect(run(bytes(`a${CLIP_ST}b`))).toBe('ab');
    expect(run(bytes(`a${CLIP_C1}b`))).toBe('ab');
    // An empty OSC 52 and one ended at once.
    expect(run(bytes(`a${E}]52\x07b`))).toBe('ab');
  });

  it('leaves titles, other OSC, CSI and UTF-8 byte-identical', () => {
    const text = `${TITLE}${E}]2;win${E}\\${E}[1;31mred${E}[0m ${E}]8;;https://x${E}\\link${E}]8;;${E}\\ é 中 🎉 \xc2\xa0`;
    const input = enc(text);
    expect(run(input)).toBe(dec(input));
    // OSC 520 and 5 are not 52.
    const near = bytes(`${E}]520;x\x07${E}]5;y\x07`);
    expect(run(near)).toBe(dec(near));
  });

  it('removes OSC 52 split at every byte offset, keeping what surrounds it', () => {
    for (const seq of [CLIP, CLIP_ST, CLIP_C1]) {
      const input = bytes(`ab${TITLE}${seq}cd${E}[0m`);
      const want = `ab${TITLE}cd${E}[0m`;
      for (let i = 0; i <= input.length; i++) {
        for (let j = i; j <= input.length; j += 3) expect(run(input, [i, j])).toBe(want);
      }
      // One byte at a time.
      expect(
        run(
          input,
          Array.from({ length: input.length }, (_, k) => k),
        ),
      ).toBe(want);
    }
  });

  it('lets an abort, a reset or the scrollback replay end an unfinished OSC 52', () => {
    // CAN and SUB abort; a new ESC starts the next sequence (here a reset, ESC c).
    expect(run(bytes(`a${E}]52;c;AAAA\x18b`))).toBe('ab');
    expect(run(bytes(`a${E}]52;c;AAAA\x1ab`))).toBe('ab');
    expect(run(bytes(`a${E}]52;c;AAAA${E}cscreen`))).toBe(`a${E}cscreen`);
    // An unfinished title is passed as it is, and the reset after it too.
    expect(run(bytes(`${E}]0;t${E}cx`))).toBe(`${E}]0;t${E}cx`);
  });

  it('does not take a lone 9D byte, part of other UTF-8 text, for an OSC', () => {
    const input = enc('Ý ɝ 52;c;AAAA\x07');
    expect(run(input)).toBe(dec(input));
  });

  it('never holds back more than the introducer and drops an unterminated one only so far', () => {
    const f = new OscFilter(undefined, 100);
    expect(dec(f.push(bytes(`a${E}]52;c;`)))).toBe('a');
    // Dropped while it streams, not buffered; past the limit the rest passes as text.
    expect(dec(f.push(bytes('A'.repeat(90))))).toBe('');
    // `;c;` and 90 A's are 93 dropped bytes; 7 more B's reach the limit of 100.
    expect(dec(f.push(bytes(`${'B'.repeat(20)}tail`)))).toBe(`${'B'.repeat(13)}tail`);
    // A long run of digits is not held back without bound either.
    const digits = bytes(`${E}]${'1'.repeat(40)};x\x07`);
    expect(run(digits)).toBe(dec(digits));
  });
});
