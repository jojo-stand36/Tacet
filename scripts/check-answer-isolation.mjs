#!/usr/bin/env node
// Live checks for #316: can programs a Worker runs (same user, descendants of `tacet run`) read
// the one-time answer codes from `tacet run`'s memory or type into its terminal? Run it as your
// normal user (not root, not sudo) on each OS, and paste the output into
// docs/adapters/capability-matrix.md §5c:
//
//   node scripts/check-answer-isolation.mjs
//
// No dependencies; it changes nothing on the machine. Node 26.1 or later also checks
// `prctl(PR_SET_DUMPABLE, 0)` through node:ffi, which is what `tacet run` does.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform, release } from 'node:os';

const read = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    return `(unreadable: ${err.code ?? err.message})`;
  }
};
const sh = (cmd) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }).stdout.trim();
const lines = [];
const say = (key, value) => lines.push(`- ${key}: ${value}`);

/**
 * In a child process: open this process's /proc/<pid>/mem and read 16 bytes at its first mapping.
 * The kernel checks the open (fs/proc/base.c `mem_open` → `mm_access`, PTRACE_MODE_ATTACH).
 */
function childReadsParent() {
  const code = `
    const fs = require('node:fs');
    const pid = ${process.pid};
    try {
      const start = BigInt('0x' + fs.readFileSync('/proc/' + pid + '/maps', 'utf8').split('-')[0]);
      const fd = fs.openSync('/proc/' + pid + '/mem', 'r');
      const n = fs.readSync(fd, Buffer.alloc(16), 0, 16, start);
      console.log('read ' + n + ' bytes');
    } catch (e) { console.log('refused (' + (e.code ?? e.message) + ')'); }`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  return (r.stdout || r.stderr).trim();
}

/** `prctl(PR_SET_DUMPABLE, 0)` through node:ffi; a reason string when it cannot. */
function makeNonDumpable() {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  let ffi;
  try {
    ffi = process.getBuiltinModule?.('node:ffi');
  } finally {
    process.emitWarning = emit;
  }
  if (!ffi) return `no node:ffi in Node ${process.version}`;
  try {
    const { prctl } = ffi.dlopen(null, {
      prctl: { arguments: ['i32', 'u64', 'u64', 'u64', 'u64'], return: 'i32' },
    }).functions;
    prctl(4, 0, 0, 0, 0); // PR_SET_DUMPABLE, TASK_DUMPABLE_OFF
    return prctl(3, 0, 0, 0, 0) === 0 ? 'set' : 'still dumpable'; // PR_GET_DUMPABLE
  } catch (err) {
    return `refused: ${err.message}`;
  }
}

say('date', new Date().toISOString().slice(0, 10));
say('os', `${platform()} ${release()}`);
say('node', process.version);
say('euid', process.geteuid?.() ?? 'n/a');
if (process.geteuid?.() === 0) {
  say('note', 'running as root: memory checks always pass for root; run as your normal user');
}

if (platform() === 'linux') {
  say('distro', read('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]*)/m)?.[1] ?? 'unknown');
  say('wsl', /microsoft|wsl/i.test(read('/proc/sys/kernel/osrelease')) ? 'yes' : 'no');
  say('kernel.yama.ptrace_scope', read('/proc/sys/kernel/yama/ptrace_scope'));
  say('dev.tty.legacy_tiocsti', read('/proc/sys/dev/tty/legacy_tiocsti'));
  say('fs.suid_dumpable', read('/proc/sys/fs/suid_dumpable'));
  say('kernel.core_pattern', read('/proc/sys/kernel/core_pattern'));
  say('ulimit -c', sh('ulimit -c'));
  say('CapEff', read('/proc/self/status').match(/^CapEff:\s*(\S+)/m)?.[1] ?? 'unknown');
  say('child reads parent memory (dumpable)', childReadsParent());
  const set = makeNonDumpable();
  say('prctl(PR_SET_DUMPABLE, 0) via node:ffi', set);
  if (set === 'set') say('child reads parent memory (non-dumpable)', childReadsParent());
} else if (platform() === 'darwin') {
  say('macOS', sh('sw_vers -productVersion'));
  say(
    'child reads parent memory',
    'not checked by this script: needs task_for_pid without the debugger entitlement (unverified)',
  );
} else {
  say('note', 'only Linux (and WSL2) and macOS are checked');
}

console.log(lines.join('\n'));
