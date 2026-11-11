const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const DEL = 0x7f;
/** UTF-8 lead byte of U+0080..U+00BF: the C1 controls OSC (U+009D) and ST (U+009C). */
const C2 = 0xc2;
const C1_OSC = 0x9d;
const C1_ST = 0x9c;
const RIGHT_BRACKET = 0x5d;
const BACKSLASH = 0x5c;
/** At most this many bytes of an OSC's introducer and number are held back; past it, dropped. */
const MAX_HELD = 64;
/** A number with more significant digits than this is dropped: no OSC uses one, and a terminal's
 * own parser may wrap it round to any value (4294967348 is 52 in 32 bits). */
const MAX_SIGNIFICANT = 5;
const SEMICOLON = 0x3b;
/**
 * Clipboard writes by number (#302): OSC 52 everywhere, and kitty's OSC 5522 (kitty source,
 * `kitty/vt-parser.c`, which sends both to `clipboard_control`).
 */
export const CLIPBOARD_OSC = new Set([52, 5522]);
/**
 * iTerm2's key=value OSCs, 1337 and the older 50 (iTerm2 source, `VT100XtermParser.m`), and the
 * keys among them that write the pasteboard (`VT100Terminal.m`): `Copy`, `CopyToClipboard` and
 * `EndCopy`. Matched case-insensitively, a stricter reading than iTerm2's exact match. Other keys,
 * inline images (`File=`) included, pass.
 */
const KEYED_OSC = new Set([50, 1337]);
const CLIPBOARD_KEYS = new Set(['copy', 'copytoclipboard', 'endcopy']);
const MAX_KEY = 'copytoclipboard'.length;

type Mode =
  | 'text'
  | 'esc'
  | 'c2'
  | 'intro'
  | 'introC2'
  | 'key'
  | 'keyEsc'
  | 'pass'
  | 'drop'
  | 'dropEsc'
  | 'dropC2';

/**
 * In the ESC state a terminal runs C0 controls and ignores DEL, still waiting for the rest of the
 * sequence (the DEC/VT parser that xterm, VTE and tmux follow); CAN, SUB and ESC end it.
 */
const escIgnores = (b: number) => (b < 0x20 && b !== CAN && b !== SUB && b !== ESC) || b === DEL;
/** Inside an OSC a terminal skips C0 controls (BEL ends it; CAN, SUB and ESC abort it). DEL is
 * taken as skipped too, the stricter reading. */
const oscIgnores = (b: number) => (escIgnores(b) && b !== BEL) || b === DEL;
/** How many UTF-8 continuation bytes the lead byte `b` starts; 0 for any other byte. */
const isLetter = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const utf8Need = (b: number) =>
  b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;

/**
 * Removes clipboard writes from a stream of terminal bytes, as they arrive, wherever chunks split
 * them (#302): OSC sequences with a blocked number (by default 52, and kitty's 5522), and
 * iTerm2's OSC 1337 (or 50) with a `Copy`, `CopyToClipboard` or `EndCopy` key. Everything else
 * passes through unchanged, other OSC sequences (window titles, iTerm2 inline images) included.
 *
 * It reads the stream as a terminal's parser does, so a sequence a terminal would take as OSC 52
 * is taken as one here:
 * - An OSC starts with `ESC ]` (with any C0 control or DEL between them), the C1 control U+009D
 *   (UTF-8 `C2 9D`), or a lone `9D` byte that is not part of a UTF-8 character (the 8-bit form).
 *   One starting inside another OSC starts afresh.
 * - Its number may have C0 controls or DEL among its digits and any number of leading zeros.
 *   A number of more than 5 significant digits, or an introducer and number longer than 64
 *   bytes, is dropped as if blocked.
 * - The key of an iTerm2 key=value OSC is read up to `=` or anything but a letter, in any case,
 *   skipping C0 controls, DEL, U+009D's byte and `ESC ]` (iTerm2 skips that pair inside an OSC).
 * - It ends with BEL, `ESC \` or U+009C; CAN, SUB or another ESC abort it, so a reset (`ESC c`)
 *   after an unfinished sequence still gets through.
 *
 * Only the introducer, number and key are held back; a blocked sequence is dropped as it streams,
 * never buffered, and after `maxDrop` bytes with no terminator the rest passes as text, so an
 * unterminated one cannot hide the rest of the terminal. When a blocked sequence starts inside an
 * OSC already passed on, a CAN is sent in its place to end that one in the user's terminal.
 */
export class OscFilter {
  #mode: Mode = 'text';
  /** The raw bytes of the introducer and number of the OSC being read. */
  #held: number[] = [];
  #value = 0;
  #significant = 0;
  /** The key read so far of an iTerm2 key=value OSC, in lower case. */
  #key = '';
  #dropped = 0;
  /** The user's terminal is inside an OSC passed on to it, not yet ended. */
  #inOsc = false;
  /** UTF-8 continuation bytes still expected. */
  #need = 0;
  #out = new Uint8Array(0);
  #n = 0;

  constructor(
    private readonly blocked: (code: number) => boolean = (code) => CLIPBOARD_OSC.has(code),
    private readonly maxDrop = 1024 * 1024,
  ) {}

  /** The bytes of `chunk` that may reach the user's terminal. */
  push(chunk: Uint8Array): Uint8Array {
    // Usually enough: each input byte is emitted at most once, plus what an earlier chunk held
    // back. `#emit` grows it otherwise.
    this.#out = new Uint8Array(chunk.length + MAX_HELD + 8);
    this.#n = 0;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] as number;
      // A byte is looked at again when the state it ends hands it on.
      while (this.#step(b));
    }
    return this.#out.subarray(0, this.#n);
  }

  /**
   * Ends the stream: drops whatever is held back (an unfinished introducer) and, if the user's
   * terminal is still inside an OSC passed on to it, returns a CAN to end it. Then starts afresh.
   */
  flush(): Uint8Array {
    const end = this.#inOsc ? Uint8Array.of(CAN) : new Uint8Array(0);
    this.#mode = 'text';
    this.#held = [];
    this.#inOsc = false;
    this.#need = 0;
    return end;
  }

  /** Handles one byte; true if the same byte must be handled again in the new state. */
  #step(b: number): boolean {
    switch (this.#mode) {
      case 'text':
        if (this.#continues(b)) this.#emit(b);
        else if (b === ESC) this.#mode = 'esc';
        else if (b === C2) this.#mode = 'c2';
        else if (b === C1_OSC) this.#startOsc([b]);
        else this.#emit(b);
        return false;
      case 'pass':
        if (this.#continues(b)) this.#emit(b);
        else if (b === ESC) this.#mode = 'esc';
        else if (b === C2) this.#mode = 'c2';
        else if (b === C1_OSC) this.#startOsc([b]);
        else {
          this.#emit(b);
          if (b === BEL || b === CAN || b === SUB || b === C1_ST) this.#toText();
        }
        return false;
      case 'esc':
        if (b === RIGHT_BRACKET) this.#startOsc([ESC, b]);
        else if (escIgnores(b)) this.#emit(b);
        else {
          this.#emit(ESC);
          this.#toText();
          return true;
        }
        return false;
      case 'c2':
        if (b === C1_OSC) this.#startOsc([C2, b]);
        else {
          this.#emit(C2);
          if (b === C1_ST) {
            this.#emit(b);
            this.#toText();
            return false;
          }
          this.#need = 1;
          this.#mode = this.#inOsc ? 'pass' : 'text';
          return true;
        }
        return false;
      case 'intro':
        if (this.#held.length >= MAX_HELD) {
          this.#decide(true);
          return true;
        }
        if (b >= 0x30 && b <= 0x39) {
          this.#held.push(b);
          if (this.#value > 0 || b !== 0x30) {
            this.#significant++;
            if (this.#significant <= MAX_SIGNIFICANT) this.#value = this.#value * 10 + (b - 0x30);
          }
        } else if (oscIgnores(b)) this.#held.push(b);
        else if (b === C1_OSC) this.#startOsc([b]);
        else if (b === C2) this.#mode = 'introC2';
        else if (
          b === SEMICOLON &&
          this.#significant <= MAX_SIGNIFICANT &&
          KEYED_OSC.has(this.#value) &&
          !this.blocked(this.#value)
        ) {
          // iTerm2's key=value: whether it is blocked depends on the key.
          this.#held.push(b);
          this.#key = '';
          this.#mode = 'key';
        } else {
          this.#decide(false);
          return true;
        }
        return false;
      case 'key':
        if (this.#held.length >= MAX_HELD) {
          this.#decide(true);
          return true;
        }
        if (isLetter(b)) {
          this.#held.push(b);
          this.#key += String.fromCharCode(b).toLowerCase();
          // Longer than any blocked key: it is not one.
          if (this.#key.length > MAX_KEY) this.#decide(false);
        } else if (oscIgnores(b) || b === C1_OSC) {
          // Skipped, as a terminal skips them (or might): they do not end the key.
          this.#held.push(b);
        } else if (b === ESC) this.#mode = 'keyEsc';
        else {
          // `=`, a terminator or anything else ends the key.
          this.#decide(false, CLIPBOARD_KEYS.has(this.#key));
          return true;
        }
        return false;
      case 'keyEsc':
        if (b === RIGHT_BRACKET) {
          // iTerm2 skips `ESC ]` inside an OSC: the key goes on.
          this.#held.push(ESC, b);
          this.#mode = 'key';
          return false;
        }
        // The ESC ends the key; it is handled as the first byte after it.
        if (this.#decide(false, CLIPBOARD_KEYS.has(this.#key))) {
          this.#dropped++;
          this.#mode = 'dropEsc';
        } else this.#mode = 'esc';
        return true;
      case 'introC2':
        if (b === C1_OSC) {
          this.#startOsc([C2, b]);
          return false;
        }
        // The C2 ends the number; it is handled as the first byte after it.
        if (this.#decide(false)) {
          this.#dropped++;
          this.#mode = 'dropC2';
        } else this.#mode = 'c2';
        return true;
      case 'drop':
        if (++this.#dropped > this.maxDrop) {
          this.#toText();
          return true;
        }
        if (this.#continues(b)) return false;
        if (b === BEL || b === CAN || b === SUB || b === C1_ST) this.#toText();
        else if (b === ESC) this.#mode = 'dropEsc';
        else if (b === C2) this.#mode = 'dropC2';
        else if (b === C1_OSC) this.#startOsc([b]);
        return false;
      case 'dropEsc':
        if (b === BACKSLASH) {
          this.#toText();
          return false;
        }
        // The ESC starts whatever comes next.
        this.#mode = 'esc';
        return true;
      case 'dropC2':
        if (b === C1_ST) {
          this.#toText();
          return false;
        }
        if (b === C1_OSC) {
          this.#startOsc([C2, b]);
          return false;
        }
        this.#mode = 'drop';
        this.#need = 1;
        return true;
    }
  }

  /** Whether `b` continues a UTF-8 character; otherwise notes what it starts. */
  #continues(b: number): boolean {
    if (b >= 0x80 && b <= 0xbf && this.#need > 0) {
      this.#need--;
      return true;
    }
    this.#need = utf8Need(b);
    return false;
  }

  #startOsc(held: number[]): void {
    this.#held = held;
    this.#value = 0;
    this.#significant = 0;
    this.#need = 0;
    this.#mode = 'intro';
  }

  /** The number (and any key) is read: pass the OSC on, or drop it (true). */
  #decide(tooLong: boolean, blockedKey = false): boolean {
    const held = this.#held;
    this.#held = [];
    this.#need = 0;
    if (tooLong || blockedKey || this.#significant > MAX_SIGNIFICANT || this.blocked(this.#value)) {
      // The user's terminal is still inside an OSC passed on before this one started: end it, or
      // it would run on into what follows the dropped one.
      if (this.#inOsc) this.#emit(CAN);
      this.#inOsc = false;
      this.#dropped = 0;
      this.#mode = 'drop';
      return true;
    }
    for (const x of held) this.#emit(x);
    this.#inOsc = true;
    this.#mode = 'pass';
    return false;
  }

  #toText(): void {
    this.#mode = 'text';
    this.#inOsc = false;
  }

  #emit(b: number): void {
    if (this.#n === this.#out.length) {
      const grown = new Uint8Array(this.#out.length * 2 + 16);
      grown.set(this.#out);
      this.#out = grown;
    }
    this.#out[this.#n++] = b;
  }
}
