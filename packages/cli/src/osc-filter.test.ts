import { describe, expect, it } from 'vitest';
import { OscFilter } from './osc-filter.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const bytes = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));
const hex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/ /g, ''), 'hex'));
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
/** The output, checked to be the same at every single split and one byte at a time. */
function everySplit(input: Uint8Array): string {
  const whole = run(input);
  for (let i = 0; i <= input.length; i++) expect(run(input, [i]), `split at ${i}`).toBe(whole);
  expect(
    run(
      input,
      Array.from({ length: input.length }, (_, k) => k),
    ),
  ).toBe(whole);
  return whole;
}
/** Whether `s` holds a byte from 80 to 9F outside U+FFFD's own bytes. */
const hasC1Byte = (s: string) =>
  [...s.replaceAll('\xef\xbf\xbd', '')].some((c) => c >= '\x80' && c <= '\x9f');

const E = '\x1b';
const ST = `${E}\\`;
const CLIP = `${E}]52;c;ZWNobyBwd25lZA==\x07`;
const TITLE = `${E}]0;my title\x07`;

describe('OscFilter (#302)', () => {
  it('passes well-formed text and sequences byte for byte', () => {
    const text = [
      TITLE,
      `${E}]2;win${ST}`,
      `${E}[1;31mred${E}[0m ${E}[?1049h${E}[38;5;196m${E}[ q`,
      `${E}]8;;https://example.com/a?b=1${ST}link${E}]8;;${ST}`,
      `${E}]7;file://host/tmp${ST}${E}]133;A\x07`,
      ` é 中 🎉 \u00a0 \u201d\r\n\t\x07\b`,
      `${E}c${E}7${E}8${E}(B${E}=`,
      // Sixel, DECRQSS, kitty graphics, iTerm2 inline image and user variable.
      `${E}Pq#0;2;0;0;0#0~~${ST}${E}P$qm${ST}${E}_Gf=100;AAAA${ST}`,
      `${E}]1337;File=inline=1:AAAA\x07${E}]1337;SetUserVar=a=Yg==\x07${E}]1337;CurrentDir=/x\x07`,
      `${E}]1337;CopyMode\x07`,
    ].join('');
    const input = enc(text);
    expect(everySplit(input)).toBe(dec(input));
  });

  it('removes OSC 52 however it ends, with what surrounds it intact', () => {
    for (const seq of [
      CLIP,
      `${E}]52;c;ZWNobw==${ST}`,
      `${E}]52\x07`,
      `${E}]52;c;AA\x18`,
      '\xc2\x9d52;c;ZWNobw==\xc2\x9c',
    ]) {
      expect(everySplit(bytes(`ab${TITLE}${seq}cd${E}[0m`)), JSON.stringify(seq)).toBe(
        `ab${TITLE}cd${E}[0m`,
      );
    }
    // An ESC that is not ST starts the next sequence (here a reset, ESC c).
    expect(everySplit(bytes(`a${E}]52;c;AAAA${E}cscreen`))).toBe(`a${E}cscreen`);
  });

  it("removes kitty's OSC 5522 and iTerm2's clipboard keys, in any case", () => {
    for (const seq of [
      `${E}]5522;type=write\x07`,
      `${E}]5522;type=wdata:mime=dGV4dA==;AAAA${ST}`,
      `${E}]1337;Copy=:ZWNobw==\x07`,
      `${E}]1337;Copy=2;uid\x07`,
      `${E}]1337;CopyToClipboard=\x07`,
      `${E}]1337;EndCopy\x07`,
      `${E}]1337;copy=:AAAA\x07`,
      `${E}]50;CopyToClipboard=rule\x07`,
      // Numbers that wrap round to 52 in 16 or 8 bits.
      `${E}]65588;c;AAAA\x07`,
      `${E}]308;c;AAAA\x07`,
    ]) {
      expect(everySplit(bytes(`a${seq}b`)), JSON.stringify(seq)).toBe('ab');
    }
    // iTerm2 skips ESC ] inside an OSC; here it ends the key, and a bare `]` OSC is dropped.
    const out = everySplit(bytes(`a${E}]1337;Co${E}]py=:AAAA\x07b`));
    expect(out).toBe(`a${E}]1337;Co${ST}b`);
  });

  it('drops an OSC whose number or key terminals could read differently', () => {
    for (const h of [
      // Leading zeros; kitty reads at most five bytes (00052, or 52 then the rest).
      '1b 5d 30 35 32 3b 63 3b 41 07',
      '1b 5d 30 30 30 35 32 31 63 3b 51 51 3d 3d 07',
      '1b 5d 35 32 01 30 63 3b 51 51 3d 3d 07',
      '1b 5d 35 35 32 32 30 31 3b 41 07',
      // C0, DEL or bytes from 80 inside the number or right after the introducer.
      '1b 5d 35 01 32 3b 63 3b 41 07',
      '1b 5d 35 7f 32 3b 63 3b 41 07',
      '1b 5d 35 80 32 3b 63 3b 51 51 3d 3d 07',
      '1b 5d 9c 35 32 3b 63 3b 51 07',
      // Anything but printable ASCII before an iTerm2 key's `=` (a BOM here).
      '1b 5d 31 33 33 37 3b ef bb bf 43 6f 70 79 3d 51 51 3d 3d 07',
      '1b 5d 31 33 33 37 3b 43 6f 01 70 79 3d 41 07',
    ]) {
      expect(everySplit(hex(`61 ${h} 62`)), h).toBe('ab');
    }
  });

  it('never passes an OSC introducer that is not well formed', () => {
    for (const h of [
      // Bytes between ESC and ]: C0 runs on its own, the rest goes.
      '1b 01 5d 35 32 3b 63 3b 41 07',
      '1b 80 5d 35 32 3b 63 3b 41 07',
      '1b 9d 5d 35 32 3b 63 3b 41 07',
      '1b 7f 7f 5d 35 32 3b 63 3b 41 07',
      // A lone 9D, and a hold that would run past its cap.
      '9d 35 32 3b 63 3b 41 9c',
      `1b ${'01 '.repeat(63)} 5d 35 32 3b 63 3b 51 51 3d 3d 07`,
      `1b ${'80 '.repeat(63)} 5d 35 32 3b 63 3b 51 07`,
    ]) {
      const out = everySplit(hex(`61 ${h} 62`));
      // Whatever is left of it is text: no OSC introducer, no C1 byte.
      expect(out.includes(`${E}]`), h).toBe(false);
      expect(hasC1Byte(out), h).toBe(false);
    }
  });

  it('drops every DCS but q, tmux passthrough however it is spelled', () => {
    for (const seq of [
      `${E}Ptmux;${E}${E}]5${E}2;c;QQ==\x07${ST}`,
      `${E}Pt${E}mux;${E}${E}]5${E}2;c;QQ==\x07${ST}`,
      `${E}P${E}tmux;${E}${E}]52;c;QQ==\x07${ST}`,
      `${E}P1;2$tmux;${E}${E}]52;c;QQ==\x07${ST}`,
      `${E}P${'\x01'.repeat(70)}tmux;${E}${E}]52;c;QQ==\x07${ST}`,
      `${E}P1000p%output %1 \\033]52;c;QQ==\\007\r\n${ST}`,
      `${E}P2000p${ST}`,
      `${E}Xsos${ST}${E}^pm${ST}`,
    ]) {
      const out = everySplit(bytes(`a${seq}b`));
      expect(out.includes(`${E}P`), JSON.stringify(seq)).toBe(false);
      expect(out.includes(`${E}]52`), JSON.stringify(seq)).toBe(false);
    }
    // CAN ends what is dropped (it never reached tmux); what follows is text.
    expect(everySplit(bytes(`a${E}Ptmux;x\x18\x07${ST}b`))).toBe(`a\x07${ST}b`);
  });

  it('ends a string at a byte that may not be in it, and reads that byte as text', () => {
    // A C0 control, an ESC that is not ST, invalid UTF-8 or a C1 control inside a title.
    expect(everySplit(bytes(`${E}]0;t\nX`))).toBe(`${E}]0;t${ST}\nX`);
    expect(everySplit(bytes(`${E}]0;t${E}]52;c;QQ==\x07after`))).toBe(`${E}]0;t${ST}after`);
    expect(everySplit(bytes(`${E}]0;t\xc2\x9d52;c;QQ==\x07after`))).toBe(
      `${E}]0;t${ST}52;c;QQ==\x07after`,
    );
    expect(everySplit(bytes(`${E}]0;t\x9c${E}]52;c;QQ==\x07after`))).toBe(`${E}]0;t${ST}after`);
    expect(everySplit(bytes(`${E}]0;t${E}cX`))).toBe(`${E}]0;t${ST}${E}cX`);
    // DCS and APC text is printable ASCII only.
    expect(everySplit(bytes(`${E}Pq#0\xc3\xa9${ST}`))).toBe(`${E}Pq#0${ST}\xc3\xa9${ST}`);
  });

  it('runs C0 controls inside an ESC sequence or CSI before it, as terminals do', () => {
    expect(everySplit(bytes(`a${E}\r[31mb`))).toBe(`a\r${E}[31mb`);
    expect(everySplit(bytes(`a${E}[3\n1mb`))).toBe(`a\n${E}[31mb`);
    expect(everySplit(bytes(`a${E}\x01\x02c`))).toBe(`a\x01\x02${E}c`);
    // CAN and SUB end it; DEL inside it is ignored.
    expect(everySplit(bytes(`a${E}[3\x18mb`))).toBe('a\x18mb');
    expect(everySplit(bytes(`a${E}[3\x7f1m`))).toBe(`a${E}[31m`);
  });

  it('makes text UTF-8: U+FFFD for bytes that are not, C1 controls dropped', () => {
    const R = '\xef\xbf\xbd';
    expect(everySplit(hex('61 80 62 c3 28 ed a0 80 f8 63'))).toBe(`a${R}b${R}(${R}${R}${R}${R}c`);
    // NEL is dropped; C1 CSI with its parameters.
    expect(everySplit(hex('61 c2 85 c2 9b 33 31 6d 62'))).toBe('ab');
    const ok = enc('Ý ɝ ” 52;c;AAAA\x07');
    expect(everySplit(ok)).toBe(dec(ok));
  });

  it('drops an unterminated sequence only so far, and holds back little', () => {
    const f = new OscFilter(undefined, 100);
    expect(dec(f.push(bytes(`a${E}]52;c;`)))).toBe('a');
    // Dropped while it streams, not buffered; past the limit the rest passes as text.
    expect(dec(f.push(bytes('A'.repeat(90))))).toBe('');
    // `;c;` and 90 A's are 93 dropped bytes; 7 more B's reach the limit of 100.
    expect(dec(f.push(bytes(`${'B'.repeat(20)}tail`)))).toBe(`${'B'.repeat(13)}tail`);
    // A long CSI is ignored up to its final byte.
    expect(everySplit(bytes(`a${E}[${'1;'.repeat(300)}mb`))).toBe('ab');
  });

  it('ends a string left open when the stream ends, and holds nothing back after flush', () => {
    const f = new OscFilter();
    expect(dec(f.push(bytes(`${E}]0;title`)))).toBe(`${E}]0;title`);
    expect(dec(f.flush())).toBe(ST);
    expect(dec(f.push(bytes(`${E}]5`)))).toBe('');
    expect(dec(f.flush())).toBe('');
    expect(dec(f.push(bytes('2;c;AAAA\x07ok')))).toBe('2;c;AAAA\x07ok');
  });
});
