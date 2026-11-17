#!/usr/bin/env node
// Live check for #311: does `tacet attach`'s filter (`OscFilter`, packages/cli/src/osc-filter.ts)
// keep a real terminal's clipboard safe, and does legitimate output still render there? It sends
// the attach filter's test inputs (the repros in osc-filter.test.ts and osc-filter.xterm.test.ts),
// filtered as `tacet attach` filters them, to the terminal it runs in, and checks the clipboard
// after each. Paste the summary it prints at the end into issue #311.
//
// How to run (macOS or Linux), from the repo, once:
//
//   pnpm install && pnpm --filter tacet build
//
// then, inside each terminal to check (a new window each time, nothing important in the clipboard):
//
//   node scripts/check-terminal-filter.mjs
//
// Terminals to cover (#311): iTerm2; kitty; xterm (on macOS it needs an X server); tmux, run inside
// one of those after `tmux set -g allow-passthrough on \; set -g set-clipboard on`; GNU screen,
// started as `TERM=xterm-256color screen`; optionally WezTerm, Alacritty, foot or GNOME Terminal.
// For tmux and screen, say which terminal they ran in, and run it in that terminal alone too: inside
// a multiplexer an image or the control may not reach the outer terminal (tacet attach drops DCS
// passthrough), so a "no" there may be the multiplexer's, not the filter's.
//
// One case (a terminal reset, ESC c) clears the screen part way through; the summary is printed at
// the end. Ctrl-C stops it and puts the clipboard back. TACET_CHECK_WAIT_MS sets how long it waits
// after each case before reading the clipboard (default 400), for a slow tmux or X round trip.
//
// What it does, and does not do:
// - It first sends one unfiltered OSC 52 whose only content is a marker of its own (the control).
//   If the clipboard does not then hold that marker, this terminal does not let programs write the
//   clipboard, and "unchanged" below proves nothing: allow clipboard writes by programs in the
//   terminal's settings and run it again. The control is the only unfiltered clipboard write.
// - Before each case it puts a marker in the clipboard, and after it checks whether the marker is
//   still there. At the end it puts back the text the clipboard held when it started (text only:
//   an image or file in the clipboard is not put back) and deletes tmux paste buffers it saw appear.
// - For output a person must judge (a title, a link, images) it asks yes, no or skip.
// - It needs only Node and the system's clipboard commands (macOS: pbcopy, pbpaste; Linux:
//   wl-copy and wl-paste, xclip or xsel). It opens no network connection.
// - Not covered (#311 notes, out of scope here): iTerm2 `RequestUpload` and kitty's file transfer
//   (OSC 5113), which move data out of the machine rather than into the clipboard.
//
// `--dry-run` prints what the filter does to each case and touches neither the clipboard nor the
// terminal's state. `TACET_CHECK_FAKE_CLIPBOARD=<file>` uses a file as the clipboard. Both are for
// the script's own test (scripts/check-terminal-filter.test.mjs).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const filterPath = fileURLToPath(new URL('../packages/cli/dist/osc-filter.js', import.meta.url));

const E = '\x1b';
const ST = `${E}\\`;
const CLIP = `${E}]52;c;ZWNobyBwd25lZA==\x07`;
const TITLE = `${E}]0;my title\x07`;
const latin1 = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const utf8 = (s) => new TextEncoder().encode(s);
const hex = (h) => Uint8Array.from(Buffer.from(h.replace(/ /g, ''), 'hex'));

/**
 * The repros of the attach filter's tests that must never write the clipboard, as the tests feed
 * them (copied from osc-filter.test.ts and osc-filter.xterm.test.ts at #311; the tests are not
 * changed, and both say this list mirrors them: a repro added there belongs here too). `from`
 * names the test. Left out: inputs that are not clipboard repros (C0 and CSI handling, UTF-8 and C1
 * text, the kept ESC sequences), the length limit (a smaller filter than attach's), the split and
 * flush cases (attach feeds whole chunks; the tests check every split), and the xterm.js test's
 * unfiltered control and random fuzz.
 */
export const BLOCKED = [
  ...[
    CLIP,
    `${E}]52;c;ZWNobw==${ST}`,
    `${E}]52\x07`,
    `${E}]52;c;AA\x18`,
    '\xc2\x9d52;c;ZWNobw==\xc2\x9c',
  ].map((seq) => ({
    from: 'removes OSC 52 however it ends',
    input: latin1(`ab${TITLE}${seq}cd${E}[0m`),
  })),
  { from: 'removes OSC 52 however it ends', input: latin1(`a${E}]52;c;AAAA${E}cscreen`) },
  ...[
    `${E}]5522;type=write\x07`,
    `${E}]5522;type=wdata:mime=dGV4dA==;AAAA${ST}`,
    `${E}]1337;Copy=:ZWNobw==\x07`,
    `${E}]1337;Copy=2;uid\x07`,
    `${E}]1337;CopyToClipboard=\x07`,
    `${E}]1337;EndCopy\x07`,
    `${E}]1337;copy=:AAAA\x07`,
    `${E}]50;CopyToClipboard=rule\x07`,
    `${E}]65588;c;AAAA\x07`,
    `${E}]308;c;AAAA\x07`,
  ].map((seq) => ({
    from: "removes kitty's OSC 5522 and iTerm2's clipboard keys",
    input: latin1(`a${seq}b`),
  })),
  {
    from: "removes kitty's OSC 5522 and iTerm2's clipboard keys",
    input: latin1(`a${E}]1337;Co${E}]py=:AAAA\x07b`),
  },
  ...[
    '1b 5d 30 35 32 3b 63 3b 41 07',
    '1b 5d 30 30 30 35 32 31 63 3b 51 51 3d 3d 07',
    '1b 5d 35 32 01 30 63 3b 51 51 3d 3d 07',
    '1b 5d 35 35 32 32 30 31 3b 41 07',
    '1b 5d 35 01 32 3b 63 3b 41 07',
    '1b 5d 35 7f 32 3b 63 3b 41 07',
    '1b 5d 35 80 32 3b 63 3b 51 51 3d 3d 07',
    '1b 5d 9c 35 32 3b 63 3b 51 07',
    '1b 5d 31 33 33 37 3b ef bb bf 43 6f 70 79 3d 51 51 3d 3d 07',
    '1b 5d 31 33 33 37 3b 43 6f 01 70 79 3d 41 07',
  ].map((h) => ({
    from: 'drops an OSC whose number or key terminals could read differently',
    input: hex(`61 ${h} 62`),
  })),
  ...[
    '1b 01 5d 35 32 3b 63 3b 41 07',
    '1b 80 5d 35 32 3b 63 3b 41 07',
    '1b 9d 5d 35 32 3b 63 3b 41 07',
    '1b 7f 7f 5d 35 32 3b 63 3b 41 07',
    '9d 35 32 3b 63 3b 41 9c',
    `1b ${'01 '.repeat(63)} 5d 35 32 3b 63 3b 51 51 3d 3d 07`,
    `1b ${'80 '.repeat(63)} 5d 35 32 3b 63 3b 51 07`,
  ].map((h) => ({
    from: 'never passes an OSC introducer that is not well formed',
    input: hex(`61 ${h} 62`),
  })),
  ...[
    `${E}Ptmux;${E}${E}]5${E}2;c;QQ==\x07${ST}`,
    `${E}Pt${E}mux;${E}${E}]5${E}2;c;QQ==\x07${ST}`,
    `${E}P${E}tmux;${E}${E}]52;c;QQ==\x07${ST}`,
    `${E}P1;2$tmux;${E}${E}]52;c;QQ==\x07${ST}`,
    `${E}P${'\x01'.repeat(70)}tmux;${E}${E}]52;c;QQ==\x07${ST}`,
    `${E}P1000p%output %1 \\033]52;c;QQ==\\007\r\n${ST}`,
    `${E}P2000p${ST}`,
    `${E}Xsos${ST}${E}^pm${ST}`,
  ].map((seq) => ({
    from: 'drops every DCS but q, tmux passthrough however it is spelled',
    input: latin1(`a${seq}b`),
  })),
  {
    from: 'drops every DCS but q, tmux passthrough however it is spelled',
    input: latin1(`a${E}Ptmux;x\x18\x07${ST}b`),
  },
  ...[
    '1b 20 50 1b 5d 35 1b 5c 1b 20 50 32 3b 63 3b 5a 6d 39 76 07 1b 5c',
    '1b 23 5d 35 32 3b 63 3b 41 07',
    '1b 6b 74 69 74 6c 65 1b 5c',
    '1b 21 78 1b 5c',
    '1b 25 40 1b 5d 30 3b e1 9c 9d 35 32 3b 63 3b 5a 6d 39 76 07',
  ].map((h) => ({
    from: 'drops ESC sequences that start a string or switch the encoding in some terminal',
    input: hex(`61 ${h} 62`),
  })),
  ...[
    latin1(`${E}]0;t${E}]52;c;QQ==\x07after`),
    latin1(`${E}]0;t\xc2\x9d52;c;QQ==\x07after`),
    utf8(`${E}]0;caf\u00e9 \u0107\u011b\u015d52;c;Zm9v\x07x`),
    latin1(`${E}]0;t\x9c${E}]52;c;QQ==\x07after`),
  ].map((input) => ({
    from: 'ends a string at a byte that may not be in it, and reads that byte as text',
    input,
  })),
  ...[
    '1b 5d 35 32 3b 63 3b 51 51 3d 3d 07',
    '1b 5d 30 35 32 3b 63 3b 41 07',
    '1b 01 5d 35 32 3b 63 3b 41 07',
    '1b 5d 35 01 32 3b 63 3b 41 07',
    'c2 9d 35 32 3b 63 3b 41 07',
    '1b 5d 35 80 32 3b 63 3b 51 51 3d 3d 07',
    '1b 5d 35 ff 32 3b 63 3b 51 07',
    '1b 5d 9c 35 32 3b 63 3b 51 51 3d 3d 07',
    '1b 80 5d 35 32 3b 63 3b 51 07',
    '1b 9d 5d 35 32 3b 63 3b 51 07',
    'c2 9d c2 35 32 3b 63 3b 41 07',
    '1b 5d c3 30 35 32 e2 1b 5c',
    'c2 9c c2 9d 9c 35 32 1b 3b 63 3b 41 07',
    '1b c2 9d e2 35 32 c3 07',
    '1b 5d 32 30 1b 50 c2 9d 35 32 1b 50 50 0a 07',
    '1a 1b 50 c2 9d 9c 35 32 1b 5c',
    'c2 9d 32 7f 1a 1b 1b 5d 9d 5d 35 32 ff 07',
    '07 1b 5d 35 1b 5d 9d 32 1b 5b c3 30 07',
    '1b 5d 35 35 32 32 3b 74 79 70 65 3d 77 72 69 74 65 07',
    '1b 5d 30 30 30 35 32 31 63 3b 51 51 3d 3d 07',
    '1b 5d 35 32 01 30 63 3b 51 51 3d 3d 07',
    `1b ${'01 '.repeat(63)} 5d 35 32 3b 63 3b 51 51 3d 3d 07`,
    `1b ${'80 '.repeat(63)} 5d 35 32 3b 63 3b 51 51 3d 3d 07`,
    '1b 50 74 1b 6d 75 78 3b 1b 1b 5d 35 1b 32 3b 63 3b 51 51 3d 3d 07 1b 5c',
    '1b 50 1b 74 6d 75 78 3b 1b 1b 5d 35 32 3b 63 3b 51 51 3d 3d 07 1b 5c',
  ].map((h) => ({
    from: 'osc-filter.xterm.test.ts: every sequence the reviews and fuzzing found',
    input: hex(h),
  })),
].map((c, i) => ({ id: `blocked-${String(i + 1).padStart(2, '0')}`, ...c }));

/** A solid red PNG of `size` pixels square, made here so it needs no file. */
export function redPng(size = 16) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Legitimate output the filter must pass unchanged, and a question for what the terminal shows.
 * The first is the text osc-filter.test.ts passes byte for byte; the rest render visibly.
 */
export function renderCases() {
  const png = redPng().toString('base64');
  return [
    {
      id: 'render-text',
      // A subset of the text osc-filter.test.ts passes byte for byte, its link made a local file:
      // left out are a DECRQSS (the terminal's reply would reach this script's prompt), the
      // alternate screen and a reset (they hide the run), and iTerm2's CopyMode (interactive).
      what: 'a subset of the well-formed text and sequences osc-filter.test.ts passes byte for byte',
      input: utf8(
        [
          `${E}]2;win${ST}`,
          `${E}[1;31mred${E}[0m`,
          `${E}]8;;file:///tmp/a?b=1${ST}link${E}]8;;${ST}`,
          ' é 中 🎉\r\n',
        ].join(''),
      ),
      ask: undefined,
    },
    {
      id: 'render-title',
      what: 'a window title (OSC 0)',
      input: utf8(`${E}]0;tacet-311 title check\x07`),
      ask: 'Does the window or tab title now read "tacet-311 title check"?',
    },
    {
      id: 'render-osc8',
      what: 'a hyperlink (OSC 8) to a local file URL',
      input: utf8(`${E}]8;;file:///tmp/tacet-311${ST}tacet-311 link${E}]8;;${ST}\r\n`),
      ask: 'Is "tacet-311 link" just above shown as a link (underlined, or a link on hover)? Do not open it.',
    },
    {
      id: 'render-sixel',
      what: 'a sixel image (DCS q): a red block',
      input: utf8(`${E}Pq#0;2;100;0;0#0!20~-#0!20~${ST}\r\n`),
      ask: 'Is a small red block shown just above?',
    },
    {
      id: 'render-kitty',
      what: 'a kitty graphics image (APC G): a red square',
      input: utf8(`${E}_Gf=100,a=T;${png}${ST}\r\n`),
      ask: 'Is a small red square shown just above?',
    },
    {
      id: 'render-iterm2',
      what: "an iTerm2 inline image (OSC 1337 File=): a red square",
      input: utf8(
        `${E}]1337;File=inline=1;size=${redPng().length}:${png}\x07\r\n`,
      ),
      ask: 'Is a small red square shown just above?',
    },
  ];
}

/** The bytes `tacet attach` would pass on for `input`: one filter, then its flush. */
export function filtered(OscFilter, input) {
  const f = new OscFilter();
  return Buffer.concat([f.push(input), f.flush()]);
}

/** How to read and write the system clipboard here, or undefined. */
function clipboardBackend() {
  const has = (cmd) =>
    spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
  // A stuck selection owner times out.
  const read = (cmd, args, env = process.env) => () =>
    spawnSync(cmd, args, {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).stdout ?? '';
  // The writer may stay in the background owning the selection (xclip, xsel): never wait on its
  // output, only on its exit.
  const write = (cmd, args, env = process.env) => (text) =>
    spawnSync(cmd, args, { input: text, env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
  // For the script's own test only: a file stands in for the clipboard.
  const fake = process.env.TACET_CHECK_FAKE_CLIPBOARD;
  if (fake) {
    return {
      name: 'a file (test)',
      read: () => (existsSync(fake) ? readFileSync(fake, 'utf8') : ''),
      write: (text) => writeFileSync(fake, text),
    };
  }
  if (process.platform === 'darwin') {
    // pbcopy and pbpaste pick their text encoding from the locale; the same UTF-8 one for both
    // makes the text round-trip whatever locale the terminal set.
    const utf8Env = { ...process.env, LC_ALL: 'en_US.UTF-8' };
    return {
      name: 'pbpaste/pbcopy',
      read: read('pbpaste', [], utf8Env),
      write: write('pbcopy', [], utf8Env),
    };
  }
  if (process.env.WAYLAND_DISPLAY && has('wl-paste') && has('wl-copy')) {
    return {
      name: 'wl-paste/wl-copy',
      read: read('wl-paste', ['--no-newline']),
      write: write('wl-copy', []),
    };
  }
  if (process.env.DISPLAY && has('xclip')) {
    return {
      name: 'xclip',
      read: read('xclip', ['-selection', 'clipboard', '-o']),
      write: write('xclip', ['-selection', 'clipboard', '-i']),
    };
  }
  if (process.env.DISPLAY && has('xsel')) {
    return { name: 'xsel', read: read('xsel', ['-b', '-o']), write: write('xsel', ['-b', '-i']) };
  }
  return undefined;
}

/** tmux's paste buffers, when this runs inside tmux: OSC 52 with set-clipboard on adds one. */
const tmuxBuffers = () =>
  process.env.TMUX
    ? (spawnSync('tmux', ['list-buffers', '-F', '#{buffer_name}'], { encoding: 'utf8' }).stdout ?? '')
        .split('\n')
        .filter(Boolean)
    : [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (bytes) => writeSync(1, bytes);

async function main() {
  const dry = process.argv.includes('--dry-run');
  if (!existsSync(filterPath)) {
    console.error(
      `The attach filter is not built (${filterPath}). Run: pnpm install && pnpm --filter tacet build`,
    );
    process.exit(2);
  }
  const { OscFilter } = await import(pathToFileURL(filterPath).href);
  const blocked = BLOCKED.map((c) => ({ ...c, out: filtered(OscFilter, c.input) }));
  const render = renderCases().map((c) => ({ ...c, out: filtered(OscFilter, c.input) }));
  const lines = [];
  const say = (k, v) => lines.push(`- ${k}: ${v}`);
  say('date', new Date().toISOString().slice(0, 10));
  say('os', `${process.platform} ${process.arch}`);
  say('node', process.version);
  say(
    'terminal',
    [
      `TERM_PROGRAM=${process.env.TERM_PROGRAM ?? '-'}`,
      `TERM=${process.env.TERM ?? '-'}`,
      process.env.TMUX ? 'inside tmux' : undefined,
      process.env.STY ? 'inside GNU screen' : undefined,
    ]
      .filter(Boolean)
      .join(', '),
  );

  if (dry) {
    for (const c of render) {
      say(c.id, `filter passed it unchanged: ${Buffer.compare(c.out, Buffer.from(c.input)) === 0 ? 'yes' : 'no'}`);
    }
    say('blocked cases', String(blocked.length));
    console.log(lines.join('\n'));
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('Run this in the terminal being checked: its output must go to that terminal.');
    process.exit(2);
  }
  const clip = clipboardBackend();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let inputEnded = false;
  const ask = async (q) => {
    while (!inputEnded) {
      let a;
      try {
        a = (await rl.question(`${q} [y/n/s(kip)] `)).trim().toLowerCase();
      } catch {
        // Ctrl-D, or input closed: the rest goes unanswered, and the summary is still printed.
        inputEnded = true;
        break;
      }
      if (a === 'y' || a === 'n' || a === 's') return { y: 'yes', n: 'no', s: 'skipped' }[a];
    }
    return 'not answered';
  };
  const wait = Number(process.env.TACET_CHECK_WAIT_MS ?? 400);
  const original = clip?.read();
  const seenBuffers = new Set(tmuxBuffers());
  const added = new Set();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (clip && original !== undefined) clip.write(original);
    for (const b of added) spawnSync('tmux', ['delete-buffer', '-b', b], { stdio: 'ignore' });
  };
  // Ctrl-C (which readline, holding the terminal, receives as a key), a closed window (SIGHUP) or
  // a kill: the clipboard is put back before it stops.
  const stop = (code) => () => {
    restore();
    try {
      out(utf8(`\r\n${E}[0m`));
    } catch {
      // The terminal is gone.
    }
    process.exit(code);
  };
  rl.on('SIGINT', stop(130));
  for (const [sig, code] of [
    ['SIGINT', 130],
    ['SIGHUP', 129],
    ['SIGTERM', 143],
  ]) {
    process.on(sig, stop(code));
  }

  console.log('#311 terminal check: clipboard writes and rendering through tacet attach\'s filter.');
  console.log(
    clip
      ? `Clipboard read and written with ${clip.name}; what it holds now is put back at the end.`
      : 'No clipboard command found: only rendering is checked (macOS: pbpaste; Linux: wl-paste, xclip or xsel).',
  );
  try {
    await rl.question('Press Enter to start, or Ctrl-C to stop. ');
  } catch {
    rl.close();
    return;
  }
  say('clipboard', clip ? clip.name : 'none found: clipboard not checked');

  /** Whether the clipboard (or tmux's buffers) changed while `bytes` went to the terminal. */
  const changes = async (bytes) => {
    const marker = `tacet-311-marker-${randomBytes(6).toString('hex')}`;
    clip?.write(marker);
    const before = new Set(tmuxBuffers());
    out(bytes);
    out(utf8(`${E}[0m\r\n`));
    await sleep(wait);
    const now = clip?.read();
    const fresh = tmuxBuffers().filter((b) => !before.has(b));
    for (const b of fresh) if (!seenBuffers.has(b)) added.add(b);
    return { clipboard: clip ? now !== marker : undefined, now, tmux: fresh.length > 0 };
  };

  try {
    // The control: an unfiltered OSC 52 holding only a marker of this run.
    const control = `tacet-311-control-${randomBytes(6).toString('hex')}`;
    const c = await changes(
      utf8(`${E}]52;c;${Buffer.from(control).toString('base64')}\x07`),
    );
    const system = !clip ? 'not checked' : c.now === control ? 'written' : 'NOT written';
    const tmux = process.env.TMUX ? `; tmux buffer: ${c.tmux ? 'added' : 'none'}` : '';
    say(
      'control (unfiltered OSC 52, marker only)',
      `system clipboard: ${system}${tmux}${
        clip && c.now !== control && !c.tmux
          ? ' (programs cannot write the clipboard here, so the results below prove nothing: allow it in the terminal\'s settings if it has one, and run again)'
          : ''
      }`,
    );

    let changed = 0;
    for (const b of blocked) {
      const r = await changes(b.out);
      const bad = r.clipboard || r.tmux;
      if (bad) changed++;
      say(
        `${b.id} (${b.from})`,
        r.clipboard === undefined && !process.env.TMUX
          ? 'not checked'
          : bad
            ? `CHANGED${r.tmux ? ' (tmux buffer)' : ''}`
            : 'unchanged',
      );
    }
    say(
      'blocked cases that changed the clipboard',
      clip || process.env.TMUX ? `${changed} of ${blocked.length}` : 'not checked (no clipboard command)',
    );

    for (const r of render) {
      const same = Buffer.compare(r.out, Buffer.from(r.input)) === 0;
      out(utf8(`\r\n--- ${r.what}:\r\n`));
      const res = await changes(r.out);
      const seen = r.ask ? await ask(r.ask) : 'not asked';
      say(
        r.id,
        `filter passed it unchanged: ${same ? 'yes' : 'no'}; seen: ${seen}; clipboard: ${
          res.clipboard || res.tmux
            ? 'CHANGED'
            : clip || process.env.TMUX
              ? 'unchanged'
              : 'not checked'
        }`,
      );
    }
  } finally {
    restore();
    rl.close();
  }
  out(utf8(`${E}[0m\r\n`));
  console.log('\nPaste everything from here to the end into #311:\n');
  console.log(lines.join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
