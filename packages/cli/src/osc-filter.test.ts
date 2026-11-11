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
    // A long run of digits is not held back without bound either: no OSC has such a number.
    expect(run(bytes(`a${E}]${'1'.repeat(40)};x\x07b`))).toBe('ab');
    expect(run(bytes(`a${E}]${'\x01'.repeat(100)}52;x\x07b`))).toBe('ab');
  });

  it('removes OSC 52 written as a terminal still reads it (review of #302)', () => {
    for (const seq of [
      // Leading zeros, and a number a 32-bit parser wraps round to 52.
      `${E}]052;c;AAAA\x07`,
      `${E}]${'0'.repeat(30)}52;c;AAAA\x07`,
      `${E}]4294967348;c;AAAA\x07`,
      // C0 controls or DEL between ESC and ], or among the digits.
      `${E}\x00]52;c;AAAA\x07`,
      `${E}\x7f\x7f]52;c;AAAA\x07`,
      `${E}]5\x002;c;AAAA\x07`,
      `${E}]5\x7f2;c;AAAA\x07`,
      // The 8-bit introducer as a lone byte, not part of a UTF-8 character.
      '\x9d52;c;AAAA\x9c',
    ]) {
      const input = bytes(`a${seq}b`);
      const got = run(input);
      // C0 controls a terminal runs in the ESC state may stay; the sequence itself goes.
      expect(
        got
          .split('')
          .filter((c) => c !== '\x00' && c !== '\x7f')
          .join(''),
        JSON.stringify(seq),
      ).toBe('ab');
      for (let i = 0; i <= input.length; i++) {
        expect(
          run(input, [i])
            .split('')
            .filter((c) => c !== '\x00' && c !== '\x7f')
            .join(''),
          JSON.stringify(seq),
        ).toBe('ab');
      }
    }
  });

  it('removes an OSC 52 started inside another OSC, and ends that one (review of #302)', () => {
    // U+009D inside a title restarts the OSC; the title is ended with CAN in its place.
    expect(run(bytes(`${E}]0;t\xc2\x9d52;c;AAAA\x07x`))).toBe(`${E}]0;t\x18x`);
    expect(run(bytes(`${E}]0;t${E}]52;c;AAAA\x07x`))).toBe(`${E}]0;t\x18x`);
    // Right after an introducer, before any digit.
    expect(run(bytes(`a${E}]\xc2\x9d52;c;AAAA\x07b`))).toBe('ab');
    // An empty OSC (U+009D) passed on, then OSC 52 inside it: removed, the empty one ended.
    expect(run(bytes(`a\xc2\x9d${E}]52;c;AAAA\x07b`))).toBe('a\xc2\x9d\x18b');
    // A title started inside another title passes, as the terminal would read it.
    const titles = bytes(`${E}]0;t${E}]2;u\x07x`);
    expect(run(titles)).toBe(dec(titles));
  });

  it("removes kitty's OSC 5522 and iTerm2's clipboard keys, but not iTerm2's other keys", () => {
    for (const seq of [
      `${E}]5522;type=write\x07`,
      `${E}]5522;type=wdata:mime=dGV4dA==;AAAA${E}\\`,
      `${E}]05522;type=write\x07`,
      `${E}]1337;Copy=:ZWNobw==\x07`,
      `${E}]1337;Copy=2;uid\x07`,
      `${E}]1337;CopyToClipboard=\x07`,
      `${E}]1337;EndCopy\x07`,
      `${E}]50;CopyToClipboard=rule\x07`,
      // Any case, with skipped bytes or iTerm2's skipped ESC ] inside the key.
      `${E}]1337;copy=:AAAA\x07`,
      `${E}]1337;Co\x01py=:AAAA\x07`,
      `${E}]1337;Co${E}]py=:AAAA\x07`,
      `${E}]1337;Co\x9dpy=:AAAA\x07`,
      '\xc2\x9d01337;\x7fEndCopy\xc2\x9c',
    ]) {
      const input = bytes(`a${seq}b`);
      for (let i = 0; i <= input.length; i++) {
        expect(run(input, [i]), JSON.stringify(seq)).toBe('ab');
      }
    }
    // iTerm2's other keys, inline images among them, and a key that only starts like one.
    const kept = bytes(
      `${E}]1337;File=inline=1:AAAA\x07${E}]1337;SetUserVar=a=Yg==\x07${E}]1337;CopyMode\x07${E}]1337;CurrentDir=/x\x07`,
    );
    expect(run(kept)).toBe(dec(kept));
    for (let i = 0; i <= kept.length; i++) expect(run(kept, [i])).toBe(dec(kept));
  });

  it('ends an OSC left open when the stream ends, and holds nothing back after flush', () => {
    const f = new OscFilter();
    expect(dec(f.push(bytes(`${E}]0;title`)))).toBe(`${E}]0;title`);
    expect(dec(f.flush())).toBe('\x18');
    expect(dec(f.push(bytes(`${E}]5`)))).toBe('');
    expect(dec(f.flush())).toBe('');
    expect(dec(f.push(bytes('2;c;AAAA\x07ok')))).toBe('2;c;AAAA\x07ok');
  });
});
