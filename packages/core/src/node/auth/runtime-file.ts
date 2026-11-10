import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
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
  /**
   * The token, when the server already listens with it (it must exist before the port does).
   * Default: a new 256-bit one. Either way it is new for every start.
   */
  token?: Secret;
}

/** Error about a runtime file. Its message never includes file contents. */
export class RuntimeFileError extends Error {
  override name = 'RuntimeFileError';
}

const currentUid = (): number | undefined => process.getuid?.();

/**
 * Create the run directory if needed and make sure it is a real directory (not a symlink) owned
 * by the current user, with mode 0700.
 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new RuntimeFileError(`run directory ${dir} is not a directory`);
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new RuntimeFileError(`run directory ${dir} is owned by another user`);
  }
  chmodSync(dir, 0o700);
}

/**
 * Generate a new 256-bit token and write `{pid, port, token, protocolVersions, startedAt}` to
 * `path` with mode 0600, atomically (exclusive temp file + rename, so a symlink planted at either
 * path is never followed). Call on every daemon start, so the token rotates. The directory must
 * be a real directory owned by the current user; it is tightened to mode 0700.
 */
export function writeRuntimeFile(opts: WriteRuntimeFileOptions): RuntimeInfo {
  const token = opts.token ?? randomToken(32);
  const info: RuntimeInfo = {
    pid: opts.pid ?? process.pid,
    port: opts.port,
    token,
    protocolVersions: [...opts.protocolVersions],
    startedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  ensurePrivateDir(dirname(opts.path));
  const body = `${JSON.stringify({ ...info, token: token.reveal() })}\n`;
  const tmp = `${opts.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, opts.path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return info;
}

/**
 * Read a runtime file written by `writeRuntimeFile`. The file is opened without following
 * symlinks and checked through the open descriptor: it must be a regular file owned by the
 * current user that neither group nor others can access. Errors never contain file contents.
 */
export function readRuntimeFile(path: string): RuntimeInfo {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw err;
    throw new RuntimeFileError(`cannot open runtime file ${path} (${code ?? 'error'})`);
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new RuntimeFileError(`runtime file ${path} is not a regular file`);
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) {
      throw new RuntimeFileError(`runtime file ${path} is owned by another user`);
    }
    const mode = st.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new RuntimeFileError(`runtime file ${path} has mode ${mode.toString(8)}; expected 600`);
    }
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // JSON.parse messages quote the input, which would leak part of the token.
    throw new RuntimeFileError(`runtime file ${path} is not valid JSON`);
  }
  const parsed = RuntimeFileJson.safeParse(json);
  if (!parsed.success) throw new RuntimeFileError(`runtime file ${path} has an invalid shape`);
  return { ...parsed.data, token: new Secret(parsed.data.token) };
}

/**
 * Delete the runtime file on shutdown, but only if it still holds our token, so a daemon that
 * restarted in the meantime keeps its file. A restart between the read and the delete is a narrow
 * race; the restarted daemon rewrites its file on its next start.
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
