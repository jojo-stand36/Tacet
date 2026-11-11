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
const DCS_P = 0x50;
/** What follows `t`, a tmux passthrough DCS's final byte (tmux source, `input.c`). */
const TMUX_REST = [0x6d, 0x75, 0x78, 0x3b]; // "mux;"
/**
 * At most this many bytes of an introducer, number and key are held back. Past it an OSC is
 * dropped; an ESC or DCS introducer is passed on.
 */
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
  | 'escC2'
  | 'dcsC2'
  | 'c2'
  | 'dcs'
  | 'dcsT'
  | 'tmux'
  | 'tmuxEsc'
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
const oscIgnores = (b: number) => escIgnores(b) && b !== BEL;
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;
const isLetter = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const isContinuation = (b: number) => b >= 0x80 && b <= 0xbf;
/** How many UTF-8 continuation bytes the lead byte `b` starts; 0 for any other byte. */
const utf8Need = (b: number) =>
  b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
/** Ends an OSC (or DCS) in every terminal (kitty ignores CAN inside one); a no-op outside one. */
const ST = [ESC, BACKSLASH];

/**
 * Removes clipboard writes from a stream of terminal bytes, as they arrive, wherever chunks split
 * them (#302): OSC sequences with a blocked number (by default 52, and kitty's 5522), iTerm2's
 * OSC 1337 (or 50) with a `Copy`, `CopyToClipboard` or `EndCopy` key, and tmux passthrough
 * (`ESC P tmux; ...`), whose unescaped body tmux would hand the outer terminal. Everything else
 * passes through unchanged and in order, other OSC sequences (window titles, iTerm2 inline
 * images) included.
 *
 * It assumes the user's terminal decodes UTF-8 (ADR-003). Where terminals' parsers differ, it
 * drops a sequence when any plausible reading gives a blocked one:
 * - An OSC starts with `ESC ]`, the C1 control U+009D (UTF-8 `C2 9D`), or a lone `9D` byte that
 *   is not part of a UTF-8 character (the 8-bit form), also right after an ESC. C0 controls, DEL
 *   and bytes from 80 up may come between ESC and `]` (xterm.js drops invalid UTF-8 bytes). One
 *   starting inside another OSC starts afresh.
 * - Its number skips C0 controls, DEL, bytes from 80 up and one `]` before it starts; leading
 *   zeros do not count. A number of more than 5 significant digits, one that wraps round to a
 *   blocked number in 8 or 16 bits, or an introducer and number longer than 64 bytes is dropped.
 * - The key of an iTerm2 key=value OSC is read up to `=` or anything but a letter, in any case,
 *   skipping C0 controls, DEL, U+009D's byte and `ESC ]` (iTerm2 skips that pair inside an OSC).
 * - It ends with BEL, `ESC \` or U+009C; CAN, SUB or another ESC abort it, so a reset (`ESC c`)
 *   after an unfinished sequence still gets through.
 * - A DCS whose final byte is `t` and whose data then starts `mux;` (tmux reads parameters,
 *   intermediates, C0 and bytes from 7F up before it) is dropped up to `ESC \`; inside it,
 *   `ESC` and the next byte are one escaped byte, as tmux reads them.
 *
 * Only introducers, numbers and keys are held back; a dropped sequence is dropped as it streams,
 * never buffered, and after `maxDrop` bytes with no terminator the rest passes as text, so an
 * unterminated one cannot hide the rest of the terminal. When a dropped sequence starts inside an
 * OSC already passed on, `ESC \` is sent in its place to end that one in the user's terminal.
 */
export class OscFilter {
  #mode: Mode = 'text';
  /** The raw bytes held back: an ESC and what follows it, or an OSC's introducer, number, key. */
  #held: number[] = [];
  #value = 0;
  #significant = 0;
  /** One `]` may still be skipped before the number (after `ESC 9D`, as xterm.js reads it). */
  #bracketOk = false;
  /** The key read so far of an iTerm2 key=value OSC, in lower case. */
  #key = '';
  /** How much of tmux's `mux;` has been read. */
  #tmux = 0;
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
    // back and an ST per dropped sequence. `#emit` grows it otherwise.
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
   * Ends the stream: drops whatever is held back (an unfinished introducer) and returns `ESC \`,
   * which ends an OSC or DCS the Worker left open in the user's terminal (or tmux) and does
   * nothing otherwise. Then starts afresh.
   */
  flush(): Uint8Array {
    this.#mode = 'text';
    this.#held = [];
    this.#inOsc = false;
    this.#need = 0;
    return Uint8Array.from(ST);
  }

  /** Handles one byte; true if the same byte must be handled again in the new state. */
  #step(b: number): boolean {
    switch (this.#mode) {
      case 'text':
      case 'pass':
        if (this.#continues(b)) this.#emit(b);
        else if (b === ESC) this.#toEsc();
        else if (b === C2) this.#mode = 'c2';
        else if (b === C1_OSC) this.#startOsc([b]);
        else {
          this.#emit(b);
          // A lone 9C ends an OSC only in an 8-bit terminal: the OSC is taken as still open.
          if (this.#mode === 'pass' && (b === BEL || b === CAN || b === SUB)) this.#toText();
        }
        return false;
      case 'esc':
        if (this.#held.length >= MAX_HELD) return this.#releaseEsc();
        if (b === RIGHT_BRACKET) this.#startOsc([...this.#held, b]);
        else if (b === C1_OSC) this.#startOsc([...this.#held, b]);
        else if (b === DCS_P) {
          this.#held.push(b);
          this.#mode = 'dcs';
        } else if (b === C2) {
          this.#held.push(b);
          this.#mode = 'escC2';
        } else if (escIgnores(b) || b >= 0x80) this.#held.push(b);
        else return this.#releaseEsc();
        return false;
      case 'escC2':
      case 'dcsC2':
        if (b === C1_OSC) {
          this.#startOsc([...this.#held, b]);
          return false;
        }
        this.#mode = this.#mode === 'escC2' ? 'esc' : 'dcs';
        if (isContinuation(b)) {
          this.#held.push(b);
          return false;
        }
        return true;
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
      case 'dcs':
        // tmux's dcs_enter, dcs_parameter and dcs_intermediate states, up to the final byte.
        if (this.#held.length >= MAX_HELD) return this.#releaseEsc();
        if (b === 0x74) {
          this.#held.push(b);
          this.#tmux = 0;
          this.#mode = 'dcsT';
        } else if (b === C1_OSC) this.#startOsc([...this.#held, b]);
        else if (b === C2) {
          // U+009D starts an OSC in any state (xterm.js); anything else here is skipped.
          this.#held.push(b);
          this.#mode = 'dcsC2';
        } else if (escIgnores(b) || (b >= 0x20 && b <= 0x3f) || b >= 0x80) this.#held.push(b);
        else return this.#releaseEsc();
        return false;
      case 'dcsT':
        if (b !== TMUX_REST[this.#tmux]) return this.#releaseEsc();
        this.#held.push(b);
        if (++this.#tmux === TMUX_REST.length) {
          this.#held = [];
          this.#endOpenOsc();
          this.#dropped = 0;
          this.#mode = 'tmux';
        }
        return false;
      case 'tmux':
      case 'tmuxEsc':
        if (++this.#dropped > this.maxDrop) {
          this.#toText();
          return true;
        }
        if (this.#mode === 'tmuxEsc') this.#mode = b === BACKSLASH ? 'text' : 'tmux';
        else if (b === ESC) this.#mode = 'tmuxEsc';
        return false;
      case 'intro':
        if (this.#held.length >= MAX_HELD) {
          this.#decide(true);
          return true;
        }
        if (isDigit(b)) {
          this.#held.push(b);
          this.#bracketOk = false;
          if (this.#value > 0 || b !== 0x30) {
            this.#significant++;
            if (this.#significant <= MAX_SIGNIFICANT) this.#value = this.#value * 10 + (b - 0x30);
          }
        } else if (b === RIGHT_BRACKET && this.#bracketOk) {
          this.#held.push(b);
          this.#bracketOk = false;
        } else if (b === C1_OSC) this.#startOsc([b]);
        else if (b === C2) this.#mode = 'introC2';
        else if (oscIgnores(b) || b >= 0x80) this.#held.push(b);
        else if (b === SEMICOLON && this.#keyed()) {
          // iTerm2's key=value: whether it is blocked depends on the key.
          this.#held.push(b);
          this.#key = '';
          this.#mode = 'key';
        } else {
          this.#decide(false);
          return true;
        }
        return false;
      case 'introC2':
        if (b === C1_OSC) {
          this.#startOsc([C2, b]);
          return false;
        }
        if (b === C1_ST) {
          // U+009C ends the OSC: decided on the number so far, then handled as an ST.
          if (this.#decide(false)) {
            this.#dropped++;
            this.#mode = 'dropC2';
          } else this.#mode = 'c2';
          return true;
        }
        // Another U+0080..U+00BF, or a broken character (dropped by xterm.js): skipped.
        this.#held.push(C2);
        this.#mode = 'intro';
        if (isContinuation(b)) {
          this.#held.push(b);
          return false;
        }
        return true;
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
        } else this.#toEsc();
        return true;
      case 'drop':
        if (++this.#dropped > this.maxDrop) {
          this.#toText();
          return true;
        }
        if (this.#continues(b)) return false;
        // A lone 9C ends it for an 8-bit terminal; nothing of it reached a UTF-8 one either way.
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
        this.#toEsc();
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
    if (isContinuation(b) && this.#need > 0) {
      this.#need--;
      return true;
    }
    this.#need = utf8Need(b);
    return false;
  }

  /** An ESC: held, with what follows it, until it is known what it starts. */
  #toEsc(): void {
    this.#held = [ESC];
    this.#mode = 'esc';
  }

  /** The held ESC starts nothing blocked: passed on as it came, then the byte is looked at. */
  #releaseEsc(): true {
    for (const x of this.#held) this.#emit(x);
    this.#held = [];
    this.#need = 0;
    // The ESC ended any OSC the terminal was in.
    this.#toText();
    return true;
  }

  #startOsc(held: number[]): void {
    // A new OSC ends one passed on before: say so at once. Otherwise, if this one's introducer is
    // later dropped or replaced (a lone 9D, which xterm.js drops), the user's terminal would run
    // the old one on into the bytes that follow, its number included.
    this.#endOpenOsc();
    this.#held = held;
    this.#value = 0;
    this.#significant = 0;
    // After a lone 9D, which xterm.js drops, a `]` may make `ESC ]` with an ESC already sent.
    const last = held.length - 1;
    this.#bracketOk = held[last] === C1_OSC && held[last - 1] !== C2;
    this.#need = 0;
    this.#mode = 'intro';
  }

  /** Whether the number read is one of iTerm2's key=value OSCs (and not blocked as a number). */
  #keyed(): boolean {
    return (
      this.#significant <= MAX_SIGNIFICANT && KEYED_OSC.has(this.#value) && !this.#blockedNumber()
    );
  }

  #blockedNumber(): boolean {
    const v = this.#value;
    return (
      this.#significant > MAX_SIGNIFICANT ||
      this.blocked(v) ||
      this.blocked(v % 0x10000) ||
      this.blocked(v % 0x100)
    );
  }

  /** The user's terminal may still be inside an OSC passed on to it: end it. */
  #endOpenOsc(): void {
    if (this.#inOsc) for (const x of ST) this.#emit(x);
    this.#inOsc = false;
  }

  /** The number (and any key) is read: pass the OSC on, or drop it (true). */
  #decide(tooLong: boolean, blockedKey = false): boolean {
    const held = this.#held;
    this.#held = [];
    this.#need = 0;
    if (tooLong || blockedKey || this.#blockedNumber()) {
      // Or the passed OSC would run on into what follows the dropped one.
      this.#endOpenOsc();
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
