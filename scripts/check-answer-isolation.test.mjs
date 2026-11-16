import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('./check-answer-isolation.mjs', import.meta.url).pathname;

test('check-answer-isolation prints the facts for its OS and changes nothing', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^- os: /m);
  assert.match(r.stdout, /^- node: v\d+/m);
  if (process.platform === 'linux') {
    assert.match(r.stdout, /^- kernel\.yama\.ptrace_scope: /m);
    assert.match(r.stdout, /^- dev\.tty\.legacy_tiocsti: /m);
    assert.match(r.stdout, /^- child reads parent memory \(dumpable\): (read|refused)/m);
    assert.match(r.stdout, /^- prctl\(PR_SET_DUMPABLE, 0\) via node:ffi: /m);
  }
  // The ExperimentalWarning node:ffi prints on load is dropped.
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
});
