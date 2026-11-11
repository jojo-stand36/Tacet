const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const DEL = 0x7f;
const BACKSLASH = 0x5c;
const SEMICOLON = 0x3b;
const EQUALS = 0x3d;
/** U+FFFD, in place of bytes that are not UTF-8. */
const REPLACEMENT = [0xef, 0xbf, 0xbd];
/** String terminator: ends an OSC, DCS or APC in every terminal (kitty ignores CAN in one). */
const ST = [ESC, BACKSLASH];
/** An ESC or CSI sequence (or DCS header) longer than this is dropped. */
const MAX_SEQ = 256;
/** An OSC number has at most this many digits (kitty reads no more), with no leading zero. */
const MAX_DIGITS = 5;
/** An iTerm2 key longer than this cannot be a blocked one. */
const MAX_KEY = 'copytoclipboard'.length;

/**
 * Clipboard writes by number (#302): OSC 52 everywhere, and kitty's OSC 5522 (kitty source,
 * `kitty/vt-parser.c`, which sends both to `clipboard_control`).
 */
const CLIPBOARD_OSC = new Set([52, 5522]);
/**
 * iTerm2's key=value OSCs, 1337 and the older 50 (iTerm2 source, `VT100XtermParser.m`), and the
 * keys among them that write the pasteboard (`VT100Terminal.m`): `Copy`, `CopyToClipboard` and
 * `EndCopy`. Matched case-insensitively, a stricter reading than iTerm2's exact match. Other keys,
 * inline images (`File=`) included, pass.
 */
const KEYED_OSC = new Set([50, 1337]);
const CLIPBOARD_KEYS = new Set(['copy', 'copytoclipboard', 'endcopy']);
/**
 * DCS sequences passed on, by final byte: `q` (sixel graphics, DECRQSS, XTGETTCAP). Every other
 * DCS is dropped, among them tmux passthrough (`t`, `tmux;`), which tmux and iTerm2 unwrap and
 * read as terminal input, and iTerm2's `p` hooks (tmux -CC, its SSH conductor), which re-read
 * encoded output.
 */
const DCS_FINALS = new Set([0x71]);
/** The intermediates an ESC sequence may have: SP # % ( ) * + - . / */
const PERCENT = 0x25;
const ESC_INTERMEDIATES = new Set([0x20, 0x23, PERCENT, 0x28, 0x29, 0x2a, 0x2b, 0x2d, 0x2e, 0x2f]);
/** Final bytes that start a string (in GNU screen, also after intermediates): P X [ ] ^ _ k ! " */
const STRING_FINALS = new Set([0x50, 0x58, 0x5b, 0x5d, 0x5e, 0x5f, 0x6b, 0x21, 0x22]);
/** C1 controls that start a string: DCS, SOS, OSC, PM, APC. */
const C1_STRINGS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

/** The code point of a complete, valid UTF-8 character. */
function codePoint(bytes: number[]): number {
  const [a = 0, b = 0, c = 0, d = 0] = bytes;
  if (bytes.length === 2) return ((a & 0x1f) << 6) | (b & 0x3f);
  if (bytes.length === 3) return ((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f);
  return ((a & 0x07) << 18) | ((b & 0x3f) << 12) | ((c & 0x3f) << 6) | (d & 0x3f);
}

type Mode =
  | 'ground'
  | 'esc'
  | 'csi'
  | 'csiIgnore'
  | 'oscNumber'
  | 'oscKey'
  | 'oscBody'
  | 'dcsHeader'
  | 'stringBody'
  | 'drop'
  | 'dropEsc';

/**
 * Removes clipboard writes from a stream of terminal bytes, as they arrive, wherever chunks split
 * them (#302): OSC 52, kitty's OSC 5522, iTerm2's OSC 1337 (or 50) with a `Copy`,
 * `CopyToClipboard` or `EndCopy` key, and every DCS but `q` (tmux passthrough among them).
 *
 * Terminals read malformed sequences in different ways (xterm.js drops invalid UTF-8 bytes inside
 * one, kitty reads at most five bytes of an OSC number, tmux and iTerm2 unwrap `ESC x` inside a
 * DCS, iTerm2 skips `ESC ]` inside an OSC, 8-bit terminals take a lone 9D for an OSC), so it does
 * not try to read them each terminal's way. It passes on only well-formed text and sequences, and
 * drops or ends the rest:
 * - Text: printable characters and C0 controls pass. Bytes that are not UTF-8 become U+FFFD. C1
 *   controls (U+0080..U+009F) are dropped: one that starts a string with its string, C1 CSI up to
 *   its final byte.
 * - An ESC sequence passes when it is well formed with an allowed intermediate (SP # ( ) * + - .
 *   /); one that starts a string in GNU screen (a string introducer after intermediates, ESC k,
 *   ESC !, ESC ") or switches the encoding (ESC %, except ESC % G back to UTF-8) is dropped. A
 *   CSI passes when well formed; one longer than 256 bytes is dropped whole. C0 controls inside
 *   either are sent before it, as terminals run them in place; DEL inside one is dropped.
 * - An OSC passes when its number is plain digits (no leading zero, at most 5) followed by `;` or
 *   its end, and the number (or iTerm2 key) is not blocked. An iTerm2 key must be printable
 *   ASCII, or the OSC is dropped. Its text is printable ASCII only (owner's decision on #302):
 *   other bytes, non-ASCII characters among them, are skipped; CAN, SUB or an ESC that is not ST
 *   ends it there with `ESC \`.
 * - A DCS with final byte `q`, and an APC (kitty graphics), pass the same way (BEL ends them).
 *   Other DCS, SOS and PM are dropped.
 *
 * A dropped sequence is dropped as it streams, never buffered, up to BEL, `ESC \`, U+009C, CAN,
 * SUB or the next ESC, and after `maxDrop` bytes the rest passes as text, so an unterminated one
 * cannot hide the rest of the terminal (an ignored CSI swallows only its parameter bytes, never
 * text). Only sequences are held back: an ESC or CSI sequence or DCS header until it is complete,
 * an OSC's introducer, number and key until they are read, at most `MAX_SEQ` bytes.
 *
 * Known gaps (#311): it was tested against xterm.js and against models of kitty, tmux,
 * iTerm2 and GNU screen written from their source, never against those terminals themselves.
 */
export class OscFilter {
  #mode: Mode = 'ground';
  /** The bytes of the sequence being read, held until it is known to pass. */
  #seq: number[] = [];
  /** A CSI has had an intermediate byte. */
  #csiIntermediate = false;
  #value = 0;
  #digits = 0;
  /** The key read so far of an iTerm2 key=value OSC, in lower case. */
  #key = '';
  /** A string (OSC, DCS, APC) passed on is open in the user's terminal. */
  #open = false;
  /** An ESC inside an open string, held until the next byte says whether it ends it. */
  #stringEsc = false;
  /** The UTF-8 character being read, and the range its next byte must be in. */
  #utf8: number[] = [];
  #need = 0;
  #lo = 0x80;
  #hi = 0xbf;
  /** The last byte broke a UTF-8 character and is still to be looked at on its own. */
  #utf8Broke = false;
  #dropped = 0;
  /** The byte dropped before this one. */
  #dropPrev = 0;
  #out = new Uint8Array(0);
  #n = 0;

  /** `maxDrop`: how many bytes of a dropped sequence are dropped before the rest passes. */
  constructor(private readonly maxDrop = 1024 * 1024) {}

  /** The bytes of `chunk` that may reach the user's terminal. */
  push(chunk: Uint8Array): Uint8Array {
    // Usually enough (input bytes, what an earlier chunk held back, a few added); `#emit` grows it.
    this.#out = new Uint8Array(chunk.length + MAX_SEQ + 16);
    this.#n = 0;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] as number;
      // A byte is looked at again when the state it ends hands it on.
      while (this.#step(b));
    }
    return this.#out.subarray(0, this.#n);
  }

  /**
   * Ends the stream: drops whatever is held back (an unfinished sequence or character) and ends a
   * string left open in the user's terminal. Then starts afresh.
   */
  flush(): Uint8Array {
    this.#out = new Uint8Array(4);
    this.#n = 0;
    if (this.#open) this.#close();
    this.#mode = 'ground';
    this.#seq = [];
    this.#stringEsc = false;
    this.#utf8 = [];
    this.#need = 0;
    return this.#out.subarray(0, this.#n);
  }

  /** Handles one byte; true if the same byte must be handled again in the new state. */
  #step(b: number): boolean {
    switch (this.#mode) {
      case 'ground':
        if (this.#need > 0 || b >= 0x80) return this.#text(b);
        if (b === ESC) this.#toEsc();
        else this.#emit(b);
        return false;

      case 'esc':
        if (b < 0x20) return this.#control(b);
        if (b === DEL) return false;
        if (b >= 0x80) return this.#abort();
        if (this.#seq.length === 1) {
          if (b === 0x5b) {
            this.#seq.push(b);
            this.#csiIntermediate = false;
            this.#mode = 'csi';
            return false;
          }
          if (b === 0x5d) {
            this.#seq.push(b);
            this.#value = 0;
            this.#digits = 0;
            this.#mode = 'oscNumber';
            return false;
          }
          if (b === 0x50) {
            this.#seq.push(b);
            this.#mode = 'dcsHeader';
            return false;
          }
          if (b === 0x5f) {
            // APC (kitty graphics): its text is checked as it streams.
            this.#seq.push(b);
            this.#pass();
            this.#mode = 'stringBody';
            return false;
          }
          // SOS, PM, and GNU screen's strings (ESC k title, ESC ! and ESC ").
          if (b === 0x58 || b === 0x5e || b === 0x6b || b === 0x21 || b === 0x22) {
            return this.#drop(false);
          }
        }
        if (this.#seq.length >= MAX_SEQ) return this.#abort(false);
        if (b < 0x30) {
          // Intermediates: only those of charset designation, DEC line and screen attributes,
          // and ESC SP's announcers; `%` (encoding switch) is checked with its final byte.
          if (!ESC_INTERMEDIATES.has(b)) return this.#abort(false);
          this.#seq.push(b);
          return false;
        }
        // The final byte. After an intermediate, a string introducer still starts a string in
        // GNU screen; ESC % switches the encoding (iTerm2 to Latin-1, with 8-bit controls), and
        // only ESC % G, back to UTF-8, passes.
        if (this.#seq.length > 1) {
          if (STRING_FINALS.has(b)) return this.#abort(false);
          if (this.#seq.includes(PERCENT) && !(this.#seq.length === 2 && b === 0x47)) {
            return this.#abort(false);
          }
        }
        this.#seq.push(b);
        this.#emitSeq();
        this.#mode = 'ground';
        return false;

      case 'csi':
        if (b < 0x20) return this.#control(b);
        if (b === DEL) return false;
        if (b >= 0x80) return this.#abort();
        if (b >= 0x40) {
          this.#seq.push(b);
          this.#emitSeq();
          this.#mode = 'ground';
          return false;
        }
        if (this.#seq.length >= MAX_SEQ || (b >= 0x30 && this.#csiIntermediate)) {
          // Malformed or too long: terminals ignore it up to its final byte, and so does this.
          this.#seq = [];
          this.#mode = 'csiIgnore';
          return false;
        }
        if (b < 0x30) this.#csiIntermediate = true;
        this.#seq.push(b);
        return false;

      case 'csiIgnore':
        if (b < 0x20) return this.#control(b);
        if (b >= 0x80) return this.#abort();
        if (b >= 0x40 && b !== DEL) this.#mode = 'ground';
        return false;

      case 'oscNumber':
        if (b >= 0x30 && b <= 0x39) {
          // A leading zero, or a sixth digit, is read differently by different terminals.
          if ((this.#digits > 0 && this.#value === 0) || this.#digits === MAX_DIGITS) {
            return this.#drop();
          }
          this.#seq.push(b);
          this.#value = this.#value * 10 + (b - 0x30);
          this.#digits++;
          return false;
        }
        if (b !== SEMICOLON && b !== BEL && b !== ESC) return this.#drop();
        if (this.#digits === 0 || this.#blockedNumber()) return this.#drop();
        if (b === SEMICOLON && KEYED_OSC.has(this.#value)) {
          this.#seq.push(b);
          this.#key = '';
          this.#mode = 'oscKey';
          return false;
        }
        this.#pass();
        this.#mode = 'oscBody';
        return true;

      case 'oscKey':
        if (b >= 0x20 && b <= 0x7e && b !== EQUALS) {
          this.#seq.push(b);
          this.#key += String.fromCharCode(b).toLowerCase();
          if (this.#key.length > MAX_KEY) {
            // Longer than any blocked key: it is not one.
            this.#pass();
            this.#mode = 'oscBody';
          }
          return false;
        }
        // Only `=` or the OSC's end ends a key cleanly; anything else drops it.
        if (b !== EQUALS && b !== BEL && b !== ESC) return this.#drop();
        if (CLIPBOARD_KEYS.has(this.#key)) return this.#drop();
        this.#pass();
        this.#mode = 'oscBody';
        return true;

      case 'oscBody':
      case 'stringBody': {
        if (this.#stringEsc) {
          this.#stringEsc = false;
          this.#close();
          // ESC \ ended it; any other byte starts a new sequence with that ESC.
          if (b === BACKSLASH) return false;
          this.#toEsc();
          return true;
        }
        const osc = this.#mode === 'oscBody';
        if (b === ESC) {
          this.#stringEsc = true;
          return false;
        }
        if (osc && b === BEL) {
          this.#emit(b);
          this.#open = false;
          this.#mode = 'ground';
          return false;
        }
        if (b >= 0x20 && b < DEL) {
          this.#emit(b);
          return false;
        }
        // BEL ends a DCS or APC in kitty and not elsewhere: ended here for all.
        if (b === BEL) {
          this.#close();
          return false;
        }
        // Other C0 controls, DEL and bytes from 80: skipped. Terminals skip C0 inside a string;
        // text is ASCII only (owner's decision on #302), since GNU screen keeps only the low
        // byte of each title character and iTerm2 can take bytes from 80 as 8-bit controls.
        if (b !== CAN && b !== SUB) return false;
        // CAN and SUB end it (not in kitty or tmux): ended with ST for all, then sent as text.
        this.#close();
        return true;
      }

      case 'dcsHeader':
        if (b === ESC || b === CAN || b === SUB) return this.#control(b);
        if (b >= 0x40 && b <= 0x7e) {
          if (!DCS_FINALS.has(b)) return this.#drop(false);
          this.#seq.push(b);
          this.#pass();
          this.#mode = 'stringBody';
          return false;
        }
        // Parameters and intermediates; anything else (C0, DEL, bytes from 80) drops it.
        if (b < 0x20 || b >= DEL || this.#seq.length >= MAX_SEQ) return this.#drop(false);
        this.#seq.push(b);
        return false;

      case 'drop':
        if (++this.#dropped > this.maxDrop) {
          this.#mode = 'ground';
          return true;
        }
        // U+009C (C2 9C) ends it too.
        if (b === BEL || b === CAN || b === SUB || (b === 0x9c && this.#dropPrev === 0xc2)) {
          this.#mode = 'ground';
        } else if (b === ESC) this.#mode = 'dropEsc';
        this.#dropPrev = b;
        return false;

      case 'dropEsc':
        if (b === BACKSLASH) {
          this.#mode = 'ground';
          return false;
        }
        // The ESC starts whatever comes next.
        this.#toEsc();
        return true;
    }
  }

  /** A byte from 80 up, or one inside a UTF-8 character, in text. */
  #text(b: number): boolean {
    const ok = this.#utf8Byte(b, (bytes, cp) => {
      if (cp >= 0xa0) for (const x of bytes) this.#emit(x);
      // C1 controls are dropped, since some terminals run them; one that starts a string (DCS,
      // SOS, OSC, PM, APC) is dropped with its string, CSI up to its final byte.
      else if (C1_STRINGS.has(cp)) this.#drop(false);
      else if (cp === 0x9b) this.#mode = 'csiIgnore';
    });
    if (ok) return false;
    for (const x of REPLACEMENT) this.#emit(x);
    // A byte that broke a character is looked at again on its own; one that starts none is gone.
    return this.#utf8Broke;
  }

  /**
   * Reads one byte of a UTF-8 character; when it completes one, `done` gets its bytes and code
   * point. False when the bytes are not UTF-8; `#utf8Broke` then says whether `b` itself is still
   * to be looked at.
   */
  #utf8Byte(b: number, done: (bytes: number[], cp: number) => void): boolean {
    this.#utf8Broke = false;
    if (this.#need > 0) {
      if (b < this.#lo || b > this.#hi) {
        this.#utf8 = [];
        this.#need = 0;
        this.#utf8Broke = true;
        return false;
      }
      this.#utf8.push(b);
      this.#lo = 0x80;
      this.#hi = 0xbf;
      if (--this.#need > 0) return true;
      const bytes = this.#utf8;
      this.#utf8 = [];
      done(bytes, codePoint(bytes));
      return true;
    }
    // Lead bytes, with the range their next byte must be in (no overlong forms, no surrogates).
    if (b >= 0xc2 && b <= 0xdf) this.#lead(b, 1, 0x80, 0xbf);
    else if (b === 0xe0) this.#lead(b, 2, 0xa0, 0xbf);
    else if (b === 0xed) this.#lead(b, 2, 0x80, 0x9f);
    else if (b >= 0xe1 && b <= 0xef) this.#lead(b, 2, 0x80, 0xbf);
    else if (b === 0xf0) this.#lead(b, 3, 0x90, 0xbf);
    else if (b >= 0xf1 && b <= 0xf3) this.#lead(b, 3, 0x80, 0xbf);
    else if (b === 0xf4) this.#lead(b, 3, 0x80, 0x8f);
    else return false;
    return true;
  }

  #lead(b: number, need: number, lo: number, hi: number): void {
    this.#utf8 = [b];
    this.#need = need;
    this.#lo = lo;
    this.#hi = hi;
  }

  /** A C0 control inside an ESC sequence or CSI: runs in place, as terminals run it. */
  #control(b: number): boolean {
    if (b === ESC) {
      this.#toEsc();
      return false;
    }
    if (b === CAN || b === SUB) {
      // Ends the sequence, which was never passed on.
      this.#seq = [];
      this.#mode = 'ground';
    }
    this.#emit(b);
    return false;
  }

  /** The sequence is malformed: dropped, and (`again`) the byte read as text, or dropped too. */
  #abort(again = true): boolean {
    this.#seq = [];
    this.#mode = 'ground';
    return again;
  }

  /**
   * The sequence is dropped up to its end. `again`: the byte that showed it is looked at again in
   * drop mode (it may be its end); otherwise it is dropped with it.
   */
  #drop(again = true): boolean {
    this.#seq = [];
    this.#dropped = 0;
    this.#dropPrev = 0;
    this.#mode = 'drop';
    return again;
  }

  #toEsc(): void {
    this.#seq = [ESC];
    this.#mode = 'esc';
  }

  /** The held introducer passes: sent, and the string it starts is open. */
  #pass(): void {
    this.#emitSeq();
    this.#open = true;
  }

  /** Ends the open string in the user's terminal. */
  #close(): void {
    for (const x of ST) this.#emit(x);
    this.#open = false;
    this.#mode = 'ground';
  }

  #blockedNumber(): boolean {
    const v = this.#value;
    // Also as an 8- or 16-bit parser would wrap it round.
    return CLIPBOARD_OSC.has(v) || CLIPBOARD_OSC.has(v % 0x10000) || CLIPBOARD_OSC.has(v % 0x100);
  }

  #emitSeq(): void {
    for (const x of this.#seq) this.#emit(x);
    this.#seq = [];
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
