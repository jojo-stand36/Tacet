import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BLOCKED, filtered, redPng, renderCases } from './check-terminal-filter.mjs';

const script = fileURLToPath(new URL('./check-terminal-filter.mjs', import.meta.url));
// `pnpm check:scripts` builds the CLI before running this.
const built = fileURLToPath(new URL('../packages/cli/dist/osc-filter.js', import.meta.url));

/**
 * Clipboard writes or passthrough left in `bytes`, read the strictest way: any `ESC ]` (or C1 OSC
 * 9D) whose number starts 52 or 5522, any iTerm2 1337 or 50 with a copy key, any DCS but `q`.
 */
function leaks(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  const found = [];
  if (/\x9d/.test(s.replaceAll('\xef\xbf\xbd', ''))) found.push('C1 OSC byte');
  for (const m of s.matchAll(/\x1b\]([0-9]*)(;?[^\x07\x1b]*)/g)) {
    const n = m[1] ?? '';
    if (n.startsWith('52') || n.startsWith('5522') || /^0+52/.test(n)) found.push(`OSC ${n}`);
    if ((n === '1337' || n === '50') && /^;(copy|copytoclipboard|endcopy)\b/i.test(m[2] ?? '')) {
      found.push(`OSC ${n} copy key`);
    }
  }
  for (const m of s.matchAll(/\x1bP([\x20-\x3f]*)([\s\S])/g)) {
    if (m[2] !== 'q') found.push('DCS other than q');
  }
  return found;
}

test('the scanner sees what the cases try (it is not blind)', () => {
  assert.deepEqual(leaks(Buffer.from('\x1b]52;c;QQ==\x07')), ['OSC 52']);
  assert.deepEqual(leaks(Buffer.from('\x1b]1337;CopyToClipboard=\x07')), ['OSC 1337 copy key']);
  assert.deepEqual(leaks(Buffer.from('\x1bPtmux;x\x1b\\')), ['DCS other than q']);
  assert.deepEqual(leaks(Buffer.from('\x1bPq#0\x1b\\')), []);
});

test('every case is taken from the tests and is non-empty, with distinct ids', () => {
  assert.ok(BLOCKED.length >= 60, String(BLOCKED.length));
  assert.equal(new Set(BLOCKED.map((c) => c.id)).size, BLOCKED.length);
  for (const c of BLOCKED) assert.ok(c.input.length > 0 && c.from, c.id);
  // The images are real PNGs.
  assert.deepEqual([...redPng().subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('through the built filter, no blocked case leaves a clipboard write, and output renders as sent', async (t) => {
  assert.ok(existsSync(built), `build the CLI first (pnpm --filter tacet build): ${built}`);
  const { OscFilter } = await import(pathToFileURL(built).href);
  for (const c of BLOCKED) {
    assert.deepEqual(leaks(filtered(OscFilter, c.input)), [], `${c.id} (${c.from})`);
  }
  for (const r of renderCases()) {
    assert.equal(Buffer.compare(filtered(OscFilter, r.input), Buffer.from(r.input)), 0, r.id);
  }
  t.diagnostic(`${BLOCKED.length} blocked cases, ${renderCases().length} render cases`);
});

test('--dry-run touches neither clipboard nor terminal and reports the render cases', () => {
  const r = spawnSync(process.execPath, [script, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^- render-text: filter passed it unchanged: yes$/m);
  assert.match(r.stdout, /^- render-iterm2: filter passed it unchanged: yes$/m);
  assert.match(r.stdout, /^- blocked cases: \d+$/m);
  // Not a terminal here: the real run refuses rather than write escape sequences to a pipe.
  const live = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(live.status, 2);
  assert.match(live.stderr, /Run this in the terminal being checked/);
});

// A live run needs a terminal: `script` (util-linux) gives it one here; macOS's takes other flags.
const canPty =
  process.platform === 'linux' &&
  spawnSync('sh', ['-c', 'command -v script'], { stdio: 'ignore' }).status === 0;

test(
  'a live run checks every case, and puts back what the clipboard held',
  { skip: !canPty || !existsSync(built) ? 'needs util-linux script and the built CLI' : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'tacet-311-'));
    try {
      const clipboard = join(dir, 'clipboard');
      writeFileSync(clipboard, 'what the user had');
      // Enter to start, then, paced so each lands at its question, an answer for each.
      const asks = renderCases().filter((c) => c.ask).length;
      const feed = `sleep 1; printf '\\n'; sleep 1; for i in $(seq ${asks}); do printf 'y\\n'; sleep 0.7; done`;
      const r = spawnSync('sh', ['-c', `(${feed}) | script -qec "\\"$0\\" \\"$1\\"" /dev/null`, process.execPath, script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TACET_CHECK_FAKE_CLIPBOARD: clipboard,
          TACET_CHECK_WAIT_MS: '5',
          TMUX: '',
        },
        timeout: 60_000,
      });
      const out = r.stdout.replaceAll('\r', '');
      assert.match(out, /^- clipboard: a file \(test\)$/m, out.slice(-2000));
      // A file is no terminal clipboard: the control says so, and nothing changed it.
      assert.match(out, /^- control \(unfiltered OSC 52, marker only\): system clipboard: NOT written \(/m);
      assert.match(out, new RegExp(`^- blocked cases that changed the clipboard: 0 of ${BLOCKED.length}$`, 'm'));
      // The answers are paced, so a slow machine may miss one: only the filter and clipboard count.
      assert.match(
        out,
        /^- render-sixel: filter passed it unchanged: yes; seen: (yes|not answered); clipboard: unchanged$/m,
      );
      assert.equal(readFileSync(clipboard, 'utf8'), 'what the user had');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'Ctrl-C stops it at once, and puts back what the clipboard held',
  { skip: !canPty || !existsSync(built) ? 'needs util-linux script and the built CLI' : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'tacet-311-'));
    try {
      const clipboard = join(dir, 'clipboard');
      writeFileSync(clipboard, 'what the user had');
      // Enter, then Ctrl-C (a byte readline receives in raw mode) while the cases run.
      const feed = `sleep 1; printf '\\n'; sleep 1; printf '\\003'; sleep 2`;
      const t0 = Date.now();
      const r = spawnSync('sh', ['-c', `(${feed}) | script -qec "\\"$0\\" \\"$1\\"" /dev/null`, process.execPath, script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TACET_CHECK_FAKE_CLIPBOARD: clipboard,
          TACET_CHECK_WAIT_MS: '200',
          TMUX: '',
        },
        timeout: 60_000,
      });
      // 77 cases at 200 ms would take over 15 s: it stopped well before.
      assert.ok(Date.now() - t0 < 12_000, `took ${Date.now() - t0} ms: ${r.stdout.slice(-500)}`);
      assert.doesNotMatch(r.stdout, /Paste everything/);
      assert.equal(readFileSync(clipboard, 'utf8'), 'what the user had');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
