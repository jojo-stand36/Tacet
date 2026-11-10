import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A session id that can stand in a path segment: no separator, no `.` or `..`, no glob character.
 * ACP agents name sessions by UUID; anything else is refused rather than matched.
 */
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;

export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) throw new Error(`not a session id: ${JSON.stringify(id)}`);
}

/**
 * One pattern segment as a regex: `{id}` is the session id (or, with no id given, any session
 * id, captured), `*` any run of characters; everything else literal.
 */
function segmentRegex(segment: string, id: string | undefined): RegExp {
  if (segment === '' || segment === '.' || segment === '..') {
    throw new Error(`bad session file pattern segment ${JSON.stringify(segment)}`);
  }
  let re = '';
  for (const part of segment.split(/(\{id\}|\*)/)) {
    if (part === '{id}') re += id === undefined ? '([0-9A-Za-z][0-9A-Za-z_-]{0,127})' : esc(id);
    else if (part === '*') re += '[^/]*';
    else re += esc(part);
  }
  return new RegExp(`^${re}$`);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ownedByMe = (uid: number) => !process.getuid || uid === process.getuid();

/**
 * The paths under `home` that `patterns` (`AcpAgentSpec.sessionFiles`) name, by session id: for
 * `id`, only that session's; without, every session's. Only real directories of the current user
 * are descended (never a symlink), so nothing outside `home` is ever matched.
 */
export function findSessionFiles(
  home: string,
  patterns: readonly string[],
  id?: string,
): Map<string, string[]> {
  if (id !== undefined) assertSessionId(id);
  const found = new Map<string, string[]>();
  for (const pattern of patterns) {
    const segments = pattern.split('/').map((s) => segmentRegex(s, id));
    const walk = (dir: string, i: number, sid: string | undefined) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      const re = segments[i] as RegExp;
      for (const name of names) {
        const m = re.exec(name);
        if (!m) continue;
        const path = join(dir, name);
        const matched = id ?? m[1] ?? sid;
        let st: ReturnType<typeof lstatSync>;
        try {
          st = lstatSync(path);
        } catch {
          continue;
        }
        if (!ownedByMe(st.uid)) continue;
        if (i === segments.length - 1) {
          if (matched === undefined) continue;
          found.set(matched, [...(found.get(matched) ?? []), path]);
        } else if (st.isDirectory()) {
          walk(path, i + 1, matched);
        }
      }
    };
    walk(home, 0, undefined);
  }
  return found;
}

/** Remove one session's files under `home` (#232). Returns how many paths were removed. */
export function removeSessionFiles(home: string, patterns: readonly string[], id: string): number {
  let removed = 0;
  for (const path of findSessionFiles(home, patterns, id).get(id) ?? []) {
    // A symlink is removed itself; a directory with its contents, symlinks not followed.
    rmSync(path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * Remove the files of sessions nothing has written to for `maxAgeMs` (#232): sessions kept for a
 * restart that never came, or left by a crash. A session is an id that has the first pattern's
 * file; its other files go with it. `keep` names sessions open or starting in this
 * process, never removed. Returns how many sessions were removed.
 */
export function sweepSessionFiles(
  home: string,
  patterns: readonly string[],
  maxAgeMs: number,
  keep: ReadonlySet<string>,
  now = Date.now(),
): number {
  let removed = 0;
  // Only ids with the first pattern's file (the transcript) are sessions: a bare `{id}` segment
  // also matches the agent's shared directories (Claude Code's `projects/<p>/memory`).
  const sessions = findSessionFiles(home, patterns.slice(0, 1));
  for (const [id, paths] of findSessionFiles(home, patterns)) {
    if (keep.has(id) || !sessions.has(id)) continue;
    // One session that cannot be read (or is removed meanwhile) never stops the others.
    try {
      if (now - Math.max(...paths.map((p) => newestMtime(p))) < maxAgeMs) continue;
      for (const p of paths) rmSync(p, { recursive: true, force: true });
      removed++;
    } catch {
      // Left for the next sweep.
    }
  }
  return removed;
}

/** The newest modification time in a tree (symlinks not followed), in ms; depth-capped. */
function newestMtime(path: string, depth = 0): number {
  const st = lstatSync(path);
  let newest = st.mtimeMs;
  if (!st.isDirectory() || depth > 6) return newest;
  for (const name of readdirSync(path)) {
    const t = newestMtime(join(path, name), depth + 1);
    if (t > newest) newest = t;
  }
  return newest;
}
