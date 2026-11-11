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

/**
 * kitty's reading of the same bytes (kitty source, `kitty/vt-parser.c`): an OSC runs from `ESC ]`
 * to BEL or `ESC \` (nothing else ends it), and its number is at most the first five bytes, as
 * far as they are digits. Counts the clipboard writes (52, 5522) it would run.
 */
function kittyClipboardWrites(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0x1b || bytes[i + 1] !== 0x5d) continue;
    let code = 0;
    let j = i + 2;
    while (
      j < bytes.length &&
      j < i + 7 &&
      (bytes[j] as number) >= 0x30 &&
      (bytes[j] as number) <= 0x39
    ) {
      code = code * 10 + ((bytes[j] as number) - 0x30);
      j++;
    }
    let end = j;
    while (
      end < bytes.length &&
      bytes[end] !== 0x07 &&
      !(bytes[end] === 0x1b && bytes[end + 1] === 0x5c)
    )
      end++;
    if (end < bytes.length && (code === 52 || code === 5522)) n++;
    i = end;
  }
  return n;
}

/** Whether a DCS other than `q` is in the bytes (tmux and iTerm2 unwrap tmux's; iTerm2 hooks `p`). */
function otherDcs(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0x1b || bytes[i + 1] !== 0x50) continue;
    let j = i + 2;
    while (j < bytes.length && (bytes[j] as number) >= 0x20 && (bytes[j] as number) <= 0x3f) j++;
    if (j < bytes.length && bytes[j] !== 0x71) return true;
  }
  return false;
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
  it('sees a clipboard write when unfiltered (the checks work)', async () => {
    expect(await clipboardWrites(hex('1b 5d 35 32 3b 63 3b 51 51 3d 3d 07'))).toBe(1);
    expect(await clipboardWrites(hex('1b 5d 35 80 32 3b 63 3b 51 51 3d 3d 07'))).toBe(1);
    expect(kittyClipboardWrites(hex('1b 5d 30 30 30 35 32 31 63 3b 51 07'))).toBe(1);
    expect(otherDcs(hex('1b 50 74 6d 75 78 3b 1b 5c'))).toBe(true);
    expect(otherDcs(hex('1b 50 71 23 30 1b 5c'))).toBe(false);
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
      // kitty's clipboard protocol, and numbers kitty reads from five bytes.
      '1b 5d 35 35 32 32 3b 74 79 70 65 3d 77 72 69 74 65 07',
      '1b 5d 30 30 30 35 32 31 63 3b 51 51 3d 3d 07',
      '1b 5d 35 32 01 30 63 3b 51 51 3d 3d 07',
      // An ESC held past the cap (third review); tmux passthrough with an escaped prefix.
      `1b ${'01 '.repeat(63)} 5d 35 32 3b 63 3b 51 51 3d 3d 07`,
      `1b ${'80 '.repeat(63)} 5d 35 32 3b 63 3b 51 51 3d 3d 07`,
      '1b 50 74 1b 6d 75 78 3b 1b 1b 5d 35 1b 32 3b 63 3b 51 51 3d 3d 07 1b 5c',
      '1b 50 1b 74 6d 75 78 3b 1b 1b 5d 35 32 3b 63 3b 51 51 3d 3d 07 1b 5c',
    ]) {
      const input = hex(h);
      for (let i = 0; i <= input.length; i++) {
        const out = filtered(input, [i]);
        expect(await clipboardWrites(out), `${h} split at ${i}`).toBe(0);
        expect(kittyClipboardWrites(out), `kitty: ${h} split at ${i}`).toBe(0);
        expect(otherDcs(out), `DCS: ${h} split at ${i}`).toBe(false);
      }
    }
  }, 30_000);

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
      const h = Buffer.from(input).toString('hex');
      expect(await clipboardWrites(out), h).toBe(0);
      expect(kittyClipboardWrites(out), `kitty: ${h}`).toBe(0);
      expect(otherDcs(out), `DCS: ${h}`).toBe(false);
    }
  }, 60_000);
});
