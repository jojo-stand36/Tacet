// Spike #245: does interactive Gemini CLI read files named in a pasted prompt into the request?
// node probe.mjs <repo> <gemini.js> <case> [gemini args]; one fresh Gemini session per case.
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [repo, gemini, kase, mode] = process.argv.slice(2);
const req = createRequire(`${repo}/packages/adapters/pty/package.json`);
const pty = req('node-pty');
const bodies = [];
const srv = createServer((rq, rs) => {
  let b = ''; rq.on('data', (c) => (b += c)); rq.on('end', () => {
    bodies.push({ url: rq.url, b });
    const chunk = { candidates: [{ content: { parts: [{ text: 'ok done' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
    if (rq.url.includes('stream')) { rs.writeHead(200, { 'content-type': 'text/event-stream' }); rs.end(`data: ${JSON.stringify(chunk)}\n\n`); }
    else if (rq.url.includes('countTokens')) { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{"totalTokens":1}'); }
    else { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(chunk)); }
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}`;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'gm-')));
const wt = join(root, 'wt'); mkdirSync(wt); const home = join(root, 'home'); mkdirSync(join(home, '.gemini'), { recursive: true });
writeFileSync(join(wt, 'note.txt'), 'INSIDE-AT-CONTENT\n');
const outside = join(root, 'outside-at.txt'); writeFileSync(outside, 'OUTSIDE-AT-CONTENT\n');
writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: false } }, ui: { theme: 'Default' }, general: { disableAutoUpdate: true }, privacy: { usageStatisticsEnabled: false } }));
const p = pty.spawn(process.execPath, [gemini, ...(mode ? mode.split(' ') : [])], { cwd: wt, cols: 160, rows: 40, env: { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', GEMINI_API_KEY: 'placeholder-not-a-real-key', GOOGLE_GEMINI_BASE_URL: url, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } });
let out = '';
p.onData((d) => { out += d; if (d.includes('\x1b[6n')) p.write('\x1b[1;1R'); if (d.includes('\x1b]11;?')) p.write('\x1b]11;rgb:0000/0000/0000\x1b\\'); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = '\x1b';
const plain = (t) => t.replace(new RegExp(`${esc}\\[\\d+;\\d+H`, 'g'), '\n').replace(new RegExp(`${esc}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g'), '').replace(new RegExp(`${esc}\\][^\\x07${esc}]*(\\x07|${esc}\\\\)`, 'g'), '').replace(/\n\s*\n/g, '\n');
await wait(9000);

const send = async (label, text) => {
  const mark = out.length; const n = bodies.length;
  p.write(`\x1b[200~${text}\x1b[201~`); await wait(1500); p.write('\r'); await wait(8000);
  console.log(`SCREEN ${label}`, plain(out.slice(mark)).replace(/[─ ]{20,}/g,' ').slice(-1200));
  for (const x of bodies.slice(n)) console.log(`REQ ${label} ${x.url.slice(0, 80)} outside=${x.b.includes('OUTSIDE-AT-CONTENT')} quoted=${x.b.includes('QUOTED-CONTENT')} inside=${x.b.includes('INSIDE-AT-CONTENT')} len=${x.b.length}`);
};
const E = (t) => t.replaceAll('@', '\\@');
writeFileSync(join(wt, 'my file.txt'), 'QUOTED-CONTENT\n');
// `raw:` cases are typed as given (the hazard); the others as PtyCliAdapter types them for a
// Gemini preset (escapeAt): every `@` as `\@`, and ` .` at the end.
const T = (t) => `. ${E(t)} .`;
// Two links whose names end in ` .` and ` `, to a file outside the checkout (#245 review): an
// unclosed quote or a trailing backslash would join a lone ` .` suffix onto `./lnk`.
symlinkSync(outside, join(wt, 'lnk .'));
symlinkSync(outside, join(wt, 'lnk '));
const CASES = {
  'raw:at': `say probe see @${outside} and @note.txt please`,
  'raw:bare-in': './note.txt',
  'raw:bare-out': '../outside-at.txt',
  'raw:quoted': "'./my file.txt'",
  at: T(`say probe see @${outside} and @note.txt please`),
  'at-line': T(`say line\n@${outside}\nend`),
  'at-trailing': T(`say trail @${outside}`),
  'pre-escaped': T(`say a \\@${outside} b \\\\@note.txt`),
  'bare-in': T('./note.txt'),
  'bare-out': T('../outside-at.txt'),
  'bare-two': T('./note.txt ../outside-at.txt'),
  quoted: T("'./my file.txt'"),
  'suffix-only:open-quote': `${E("'./lnk")} .`,
  'suffix-only:backslash': `${E('./lnk\\')} .`,
  'open-quote': T("'./lnk"),
  backslash: T('./lnk\\'),
};
await send(kase, CASES[kase]);
if (out.includes('outside your workspace')) console.log('DIALOG shown');
for (const x of bodies) { const m = x.b.match(/"text":"(say [^"]*)"/g); if (m) console.log('SENT', m.join(' | ').slice(0, 300)); }
p.kill(); srv.close(); process.exit(0);
