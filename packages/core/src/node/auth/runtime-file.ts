import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ProtocolVersion } from '../../schema/hello.js';
import { randomToken, Secret, tokenKey } from './secret.js';

/** `~/.tacet/run`, outside every repo so the file cannot be committed (ADR-003 §3.2). */
export function defaultRunDir(): string {
  return join(homedir(), '.tacet', 'run');
}

export function conductorRuntimePath(runDir = defaultRunDir()): string {
  return join(runDir, 'conductor.json');
}

/** `~/.tacet/run/minis/<repo-hash>.json`, keyed by the absolute repo path. */
export function miniRuntimePath(repoPath: string, runDir = defaultRunDir()): string {
  return join(runDir, 'minis', `${tokenKey(resolve(repoPath)).slice(0, 16)}.json`);
}

const RuntimeFileJson = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
  protocolVersions: z.array(ProtocolVersion).min(1),
  startedAt: z.iso.datetime(),
});

export interface RuntimeInfo {
  pid: number;
  port: number;
  token: Secret;
  protocolVersions: number[];
  startedAt: string;
}

export interface WriteRuntimeFileOptions {
  path: string;
  port: number;
  protocolVersions: number[];
  pid?: number;
  now?: () => Date;
}

/**
 * Generate a new 256-bit token and write `{pid, port, token, protocolVersions, startedAt}` to
 * `path` with mode 0600, atomically (temp file + rename). Call on every daemon start, so the token
 * rotates. The containing directory is created (or tightened) to mode 0700.
 */
export function writeRuntimeFile(opts: WriteRuntimeFileOptions): RuntimeInfo {
  const token = randomToken(32);
  const info: RuntimeInfo = {
    pid: opts.pid ?? process.pid,
    port: opts.port,
    token,
    protocolVersions: [...opts.protocolVersions],
    startedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  const dir = dirname(opts.path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const body = `${JSON.stringify({ ...info, token: token.reveal() })}\n`;
  const tmp = `${opts.path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, opts.path);
  return info;
}

/**
 * Read a runtime file written by `writeRuntimeFile`. Refuses a file that group or others can read
 * or write, since the token inside would then be exposed.
 */
export function readRuntimeFile(path: string): RuntimeInfo {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`runtime file ${path} has mode ${mode.toString(8)}; expected 600`);
  }
  const parsed = RuntimeFileJson.parse(JSON.parse(readFileSync(path, 'utf8')));
  return { ...parsed, token: new Secret(parsed.token) };
}

/**
 * Delete the runtime file on shutdown, but only if it still holds our token, so a daemon that
 * restarted in the meantime keeps its file.
 */
export function removeRuntimeFile(path: string, ours: Secret): boolean {
  try {
    const current = readRuntimeFile(path);
    if (!ours.equals(current.token.reveal())) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  rmSync(path, { force: true });
  return true;
}
