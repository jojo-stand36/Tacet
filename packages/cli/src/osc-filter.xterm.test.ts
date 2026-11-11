import xterm from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { OscFilter } from './osc-filter.js';

/**
 * The filter against a real terminal parser (#302): xterm.js, the one behind VS Code's terminal,
 * which drops invalid UTF-8 bytes where other parsers stop. Whatever goes in, in whatever chunks,
 * the filtered bytes must never make it run an OSC 52 clipboard write.
 */
async function clipboardWrites(bytes: Uint8Array): Promise<number> {
  const term = new xterm.Terminal({ allowProposedApi: true, logLevel: 'off' });
  let n = 0;
  for (const code of [52, 5522]) {
    term.parser.registerOscHandler(code, () => {
      n++;
      return true;
    });
  }
  await new Promise<void>((r) => term.write(bytes, r));
  // Ends an OSC left open, so it runs if it would.
  await new Promise<void>((r) => term.write('\x07', r));
  term.dispose();
  return n;
}

function filtered(input: Uint8Array, cuts: number[]): Uint8Array {
  const f = new OscFilter();
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const c of [...cuts, input.length]) {
    parts.push(f.push(input.subarray(at, c)));
    at = c;
  }
  parts.push(f.flush());
  return Buffer.concat(parts);
}

const hex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/ /g, ''), 'hex'));

/** Deterministic, so a failure reproduces. */
function prng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

describe('OscFilter against xterm.js (#302)', () => {
  it('lets the parser see a clipboard write when unfiltered (the check works)', async () => {
    expect(await clipboardWrites(hex('1b 5d 35 32 3b 63 3b 51 51 3d 3d 07'))).toBe(1);
    expect(await clipboardWrites(hex('1b 5d 35 80 32 3b 63 3b 51 51 3d 3d 07'))).toBe(1);
  });

  it('removes every sequence the reviews and fuzzing found, at every split', async () => {
    for (const h of [
      '1b 5d 35 32 3b 63 3b 51 51 3d 3d 07',
      '1b 5d 30 35 32 3b 63 3b 41 07',
      '1b 01 5d 35 32 3b 63 3b 41 07',
      '1b 5d 35 01 32 3b 63 3b 41 07',
      'c2 9d 35 32 3b 63 3b 41 07',
      // An invalid byte inside the number, right after the introducer, or between ESC and ].
      '1b 5d 35 80 32 3b 63 3b 51 51 3d 3d 07',
      '1b 5d 35 ff 32 3b 63 3b 51 07',
      '1b 5d 9c 35 32 3b 63 3b 51 51 3d 3d 07',
      '1b 80 5d 35 32 3b 63 3b 51 07',
      '1b 9d 5d 35 32 3b 63 3b 51 07',
      // A broken lead byte after a valid C1 introducer; an OSC ended by ESC.
      'c2 9d c2 35 32 3b 63 3b 41 07',
      '1b 5d c3 30 35 32 e2 1b 5c',
      'c2 9c c2 9d 9c 35 32 1b 3b 63 3b 41 07',
      '1b c2 9d e2 35 32 c3 07',
      // U+009D inside a DCS header; a lone 9D after a dropped introducer; an OSC run on.
      '1b 5d 32 30 1b 50 c2 9d 35 32 1b 50 50 0a 07',
      '1a 1b 50 c2 9d 9c 35 32 1b 5c',
      'c2 9d 32 7f 1a 1b 1b 5d 9d 5d 35 32 ff 07',
      '07 1b 5d 35 1b 5d 9d 32 1b 5b c3 30 07',
      // kitty's clipboard protocol.
      '1b 5d 35 35 32 32 3b 74 79 70 65 3d 77 72 69 74 65 07',
    ]) {
      const input = hex(h);
      for (let i = 0; i <= input.length; i++) {
        expect(await clipboardWrites(filtered(input, [i])), `${h} split at ${i}`).toBe(0);
      }
    }
  });

  it('removes them from random byte soup, in random chunks', async () => {
    const tokens = [
      [0x1b],
      [0x5d],
      [0x1b, 0x5d],
      [0xc2, 0x9d],
      [0x35, 0x32],
      [0x35],
      [0x32],
      [0x30],
      [0x3b, 0x63, 0x3b, 0x41],
      [0x07],
      [0x1b, 0x5c],
      [0xc2, 0x9c],
      [0x18],
      [0x1a],
      [0x01],
      [0x0a],
      [0x7f],
      [0x00],
      [0x1b, 0x50],
      [0x1b, 0x5f],
      [0x1b, 0x5b],
      [0xe2, 0x80, 0x9d],
      [0xc3, 0x9d],
      [0x30, 0x3b, 0x74],
      [0x63],
      [0x5c],
      [0x80],
      [0x9c],
      [0x9d],
      [0xc2],
      [0xff],
      [0x74, 0x6d, 0x75, 0x78, 0x3b],
    ];
    const rnd = prng(302);
    for (let run = 0; run < 1500; run++) {
      const bytes: number[] = [];
      for (let k = 1 + rnd(14); k > 0; k--) bytes.push(...(tokens[rnd(tokens.length)] ?? []));
      const input = Uint8Array.from(bytes);
      const cuts: number[] = [];
      for (let at = rnd(input.length + 1); at < input.length; at += 1 + rnd(input.length)) {
        cuts.push(at);
      }
      const out = filtered(input, cuts);
      expect(await clipboardWrites(out), Buffer.from(input).toString('hex')).toBe(0);
    }
  }, 60_000);
});
