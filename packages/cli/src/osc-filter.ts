const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
/** UTF-8 lead byte of U+0080..U+00BF: the C1 controls OSC (U+009D) and ST (U+009C). */
const C2 = 0xc2;
const C1_OSC = 0x9d;
const C1_ST = 0x9c;
const RIGHT_BRACKET = 0x5d;
const BACKSLASH = 0x5c;
const MAX_DIGITS = 16;

type Mode =
  | 'text'
  | 'esc'
  | 'c2'
  | 'intro'
  | 'pass'
  | 'passEsc'
  | 'passC2'
  | 'drop'
  | 'dropEsc'
  | 'dropC2';

/**
 * Removes OSC sequences with a blocked number (by default 52, a clipboard write) from a stream of
 * terminal bytes, as they arrive, wherever chunks split them (#302). Everything else passes
 * through unchanged, other OSC sequences (window titles) included.
 *
 * An OSC starts with `ESC ]` or the C1 control U+009D (UTF-8 `C2 9D`, the 8-bit form as a UTF-8
 * terminal reads it; a lone `9D` byte is part of other UTF-8 text) and ends with BEL, `ESC \` or
 * U+009C; like a terminal, CAN, SUB or another ESC abort it, so a reset (`ESC c`) after an
 * unfinished sequence still gets through. Only the introducer and its number are held back
 * (at most 16 digits); a blocked sequence is dropped as it streams, never buffered, and after
 * `maxDrop` bytes with no terminator the rest passes as text, so an unterminated one cannot hide
 * the rest of the terminal.
 */
export class OscFilter {
  #mode: Mode = 'text';
  /** The introducer and number of the OSC being read. */
  #intro: number[] = [];
  #digits = '';
  #dropped = 0;

  constructor(
    private readonly blocked: (code: string) => boolean = (code) => code === '52',
    private readonly maxDrop = 1024 * 1024,
  ) {}

  /** The bytes of `chunk` that may reach the user's terminal. */
  push(chunk: Uint8Array): Uint8Array {
    // Never longer than the input plus what was held back (at most the introducer and digits).
    const out = new Uint8Array(chunk.length + this.#intro.length + 2);
    let n = 0;
    const emit = (b: number) => {
      out[n++] = b;
    };
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] as number;
      // A byte is looked at again after a held one turns out not to start a sequence.
      for (let again = true; again; ) {
        again = false;
        switch (this.#mode) {
          case 'text':
            if (b === ESC) this.#mode = 'esc';
            else if (b === C2) this.#mode = 'c2';
            else emit(b);
            break;
          case 'esc':
            if (b === RIGHT_BRACKET) this.#startOsc([ESC, RIGHT_BRACKET]);
            else {
              emit(ESC);
              this.#mode = 'text';
              again = true;
            }
            break;
          case 'c2':
            if (b === C1_OSC) this.#startOsc([C2, C1_OSC]);
            else {
              emit(C2);
              this.#mode = 'text';
              again = true;
            }
            break;
          case 'intro':
            if (b >= 0x30 && b <= 0x39 && this.#digits.length < MAX_DIGITS) {
              this.#digits += String.fromCharCode(b);
              this.#intro.push(b);
            } else if (this.blocked(this.#digits)) {
              this.#intro = [];
              this.#dropped = 0;
              this.#mode = 'drop';
              again = true;
            } else {
              for (const x of this.#intro) emit(x);
              this.#intro = [];
              this.#mode = 'pass';
              again = true;
            }
            break;
          case 'pass':
            if (b === ESC) this.#mode = 'passEsc';
            else if (b === C2) this.#mode = 'passC2';
            else {
              emit(b);
              if (b === BEL || b === CAN || b === SUB) this.#mode = 'text';
            }
            break;
          case 'passEsc':
            if (b === BACKSLASH) {
              emit(ESC);
              emit(b);
              this.#mode = 'text';
            } else {
              // A new sequence ends this one; the ESC starts it.
              this.#mode = 'esc';
              again = true;
            }
            break;
          case 'passC2':
            emit(C2);
            if (b === C1_ST) {
              emit(b);
              this.#mode = 'text';
            } else {
              this.#mode = 'pass';
              again = true;
            }
            break;
          case 'drop':
            if (b === BEL || b === CAN || b === SUB) this.#mode = 'text';
            else if (b === ESC) this.#mode = 'dropEsc';
            else if (b === C2) this.#mode = 'dropC2';
            else if (++this.#dropped > this.maxDrop) {
              this.#mode = 'text';
              again = true;
            }
            break;
          case 'dropEsc':
            if (b === BACKSLASH) this.#mode = 'text';
            else {
              this.#mode = 'esc';
              again = true;
            }
            break;
          case 'dropC2':
            if (b === C1_ST) this.#mode = 'text';
            else {
              this.#mode = 'drop';
              again = true;
            }
            break;
        }
      }
    }
    return out.subarray(0, n);
  }

  #startOsc(intro: number[]): void {
    this.#intro = intro;
    this.#digits = '';
    this.#mode = 'intro';
  }
}
