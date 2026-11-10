import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { redactSecrets } from '@tacet/core';

/**
 * Adapters whose approval requests name Claude Code's own tools with Claude Code's inputs: the
 * Claude Agent SDK, claude-agent-acp (it forwards Claude's tool `name` and its `rawInput`) and
 * Claude Code in a PTY (its hook's `tool_name` and `tool_input`). Tool names and path fields
 * checked 2026-11-10 against the SDK 0.3.319 types, code.claude.com/docs/en/tools-reference
 * and the claude-agent-acp 0.101.0 source (docs/adapters/capability-matrix.md).
 */
export const CLAUDE_TOOL_ADAPTERS: ReadonlySet<string> = new Set([
  'claude-sdk',
  'acp:claude-acp',
  'pty:claude',
]);

/**
 * Claude Code's file tools: the input keys each takes (SDK 0.3.319 `sdk-tools.d.ts`), which of
 * them name a path, and which are glob patterns. Newer Claude Code also takes `path` for Write and
 * `file_path` for Grep (claude-agent-acp source), so those are path keys too. Any other key is
 * refused, so a path alias added later cannot slip past unchecked. `MultiEdit` and `LS` no longer
 * exist and are refused like any unknown tool. Grep's `pattern` is a regex over contents: neither
 * a path nor a glob.
 */
interface FileTool {
  paths: readonly string[];
  globs: readonly string[];
  other: readonly string[];
  needsPath: boolean;
  /** Changes the target: refused on a file with other hard links. */
  writes: boolean;
}
const FILE_TOOLS: Record<string, FileTool> = {
  Read: {
    paths: ['file_path'],
    globs: [],
    other: ['offset', 'limit', 'pages', 'allow_large'],
    needsPath: true,
    writes: false,
  },
  Write: {
    paths: ['file_path', 'path'],
    globs: [],
    other: ['content'],
    needsPath: true,
    writes: true,
  },
  Edit: {
    paths: ['file_path'],
    globs: [],
    other: ['old_string', 'new_string', 'replace_all'],
    needsPath: true,
    writes: true,
  },
  NotebookEdit: {
    paths: ['notebook_path'],
    globs: [],
    other: ['cell_id', 'new_source', 'cell_type', 'edit_mode'],
    needsPath: true,
    writes: true,
  },
  // The search tools default to the working directory (the checkout) without a path.
  Glob: { paths: ['path'], globs: ['pattern'], other: [], needsPath: false, writes: false },
  Grep: {
    paths: ['path', 'file_path'],
    globs: ['glob'],
    other: [
      'pattern',
      'output_mode',
      '-B',
      '-A',
      '-C',
      'context',
      '-n',
      '-i',
      '-o',
      'type',
      'head_limit',
      'offset',
      'multiline',
    ],
    needsPath: false,
    writes: false,
  },
};

/** What adapters put where they scrubbed a secret: a path seen through it is not the real one. */
const REDACTED = '[redacted]';

export interface ToolRequest {
  /** The tier's adapter id (`tiers.worker.adapter`). */
  adapterId: string;
  toolName?: string | undefined;
  /** The tool's input as the adapter reported it (`approval.request` `requestedGrant.input`). */
  input?: unknown;
}

export type ToolDecision = { allow: true; reason: string } | { allow: false; reason: string };

/**
 * The interim policy for unattended Workers until #25 (owner decision on #200, 2026-11-10): allow
 * Claude Code's file tools (read, edit, write, and the search tools) only for targets that
 * resolve inside the Worker's own worktree; refuse everything else. Refused: Bash and any shell,
 * network and web tools, MCP servers (the Mini-conductor's own tools are allowed before this is
 * asked), unknown tools, adapters whose tool names are not Claude Code's, any path that leaves
 * the worktree through `..`, an absolute path elsewhere or a symlink (also one created during
 * the session: paths are resolved when the request is decided), and `.git` anywhere in the path.
 *
 * Reasons never contain a path outside the worktree: they are recorded in `worker.*` events.
 */
export function decideToolRequest(req: ToolRequest, worktree: string): ToolDecision {
  const name = req.toolName ?? '';
  if (!CLAUDE_TOOL_ADAPTERS.has(req.adapterId)) {
    return refuse(`${req.adapterId} Workers may not use tools outside their sandbox until #25`);
  }
  const spec = Object.hasOwn(FILE_TOOLS, name) ? FILE_TOOLS[name] : undefined;
  if (!spec)
    return refuse(`${name || 'this tool'} is not a file tool an unattended Worker may use`);
  const input = req.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return refuse(`${name}: no input to check`);
  }
  const fields = input as Record<string, unknown>;
  for (const k of Object.keys(fields)) {
    if (!spec.paths.includes(k) && !spec.globs.includes(k) && !spec.other.includes(k)) {
      return refuse(`${name}: unexpected input ${JSON.stringify(k).slice(0, 40)}`);
    }
  }
  // The adapters scrub secrets out of the input they report, and the tool runs on the original:
  // a decision on a scrubbed copy would be about a different input.
  if (mentions(fields, REDACTED)) return refuse(`${name}: part of the input was redacted`);

  let root: string;
  try {
    root = realpathSync.native(worktree);
  } catch {
    return refuse('the Worker checkout is gone');
  }
  const targets: string[] = [];
  for (const f of spec.paths) {
    const v = fields[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v === '') return refuse(`${name}: ${f} is not a path`);
    const at = inside(root, worktree, v, spec.writes);
    if (typeof at !== 'string') return refuse(`${name}: ${at.why}`);
    targets.push(at);
  }
  if (spec.needsPath && targets.length === 0) return refuse(`${name}: no path given`);
  for (const f of spec.globs) {
    const v = fields[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v === '') return refuse(`${name}: ${f} is not a pattern`);
    const why = badGlob(root, worktree, v);
    if (why) return refuse(`${name}: ${f} ${why}`);
  }
  const where = targets.length ? targets.map((t) => t || '.').join(', ') : 'the worktree';
  // Names reached through a symlink were never scrubbed: the reason goes into a summary event.
  return { allow: true, reason: redactSecrets(`${name} inside the worktree (${where})`) };
}

/**
 * Why a glob pattern is refused, or undefined. Brace expansion (`{..,src}`, `{/etc,x}`) is
 * refused outright, as is a wildcard in a dot-segment (`.gi[t]`, `.g?t`) that could match `.git`.
 * The literal segments before the first wildcard must lead inside the checkout like a path.
 */
function badGlob(root: string, given: string, v: string): string | undefined {
  if (v.includes('\\') || v.includes('\0')) return 'has a backslash or NUL';
  if (isAbsolute(v) || v.startsWith('~')) return 'names an absolute path';
  if (/[{}]/.test(v)) return 'uses brace expansion';
  const segs = v.split('/');
  if (segs.includes('..')) return 'leaves the worktree';
  if (segs.some((s) => isGitName(s) || (s.startsWith('.') && /[*?[\]]/.test(s)))) {
    return 'reaches git internals';
  }
  const literal: string[] = [];
  for (const s of segs) {
    if (/[*?[\]]/.test(s)) break;
    literal.push(s);
  }
  if (literal.length > 0) {
    const at = inside(root, given, literal.join('/'), false);
    if (typeof at !== 'string') return at.why.replace(/^the path/, 'its directory');
  }
  return undefined;
}

/** Whether `marker` appears in any string inside `v`. */
function mentions(v: unknown, marker: string): boolean {
  if (typeof v === 'string') return v.includes(marker);
  if (Array.isArray(v)) return v.some((x) => mentions(x, marker));
  if (typeof v === 'object' && v !== null) return Object.values(v).some((x) => mentions(x, marker));
  return false;
}

/**
 * Where `p` lands, relative to the worktree's real path, or why it is refused. `..` is refused
 * outright (resolving it lexically and following a symlink first differ). Each existing component
 * is checked with `lstat`; a symlink must resolve inside the worktree, so a dangling one is
 * refused too. Components that do not exist yet are new names the tool would create.
 */
function inside(root: string, given: string, p: string, writes: boolean): string | { why: string } {
  // A backslash is an ordinary name character on POSIX: refused rather than guessed at.
  if (p.includes('\\') || p.includes('\0')) return { why: 'the path has a backslash or NUL' };
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.includes('..')) return { why: 'the path leaves the worktree (..)' };
  let rel: string[];
  if (isAbsolute(p)) {
    const norm = segs.join(sep);
    const under = [root, given]
      .map((r) => relative(r, `${sep}${norm}`))
      .find((r) => r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)));
    if (under === undefined) return { why: 'the path is outside the worktree' };
    rel = under === '' ? [] : under.split(sep);
  } else if (p.startsWith('~')) {
    return { why: 'the path is outside the worktree' };
  } else {
    rel = segs;
  }
  if (rel.some(isGitName)) return { why: 'git internals are not open to Workers' };
  let cur = root;
  for (let i = 0; i < rel.length; i++) {
    const next = join(cur, rel[i] as string);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(next);
    } catch (err) {
      // Not there yet: the rest are names the tool would create, under `cur`. Any other error
      // (a name too long, no permission, a loop) is a path the policy cannot vouch for.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        return { why: 'the path cannot be checked' };
      return relative(root, join(cur, ...rel.slice(i)));
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync.native(next);
      } catch {
        return { why: 'the path goes through a symlink that leads nowhere' };
      }
      const r = relative(root, real);
      if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) {
        return { why: 'the path goes through a symlink out of the worktree' };
      }
      if (r.split(sep).some(isGitName)) return { why: 'git internals are not open to Workers' };
      cur = real;
    } else {
      cur = next;
      // A file with other hard links may be one outside the checkout too (pnpm links
      // node_modules to its store): writing it in place would change those as well.
      if (writes && i === rel.length - 1 && st.isFile() && st.nlink > 1) {
        return { why: 'the file has other hard links' };
      }
    }
  }
  return relative(root, cur);
}

/** `.git`, in any letter case (case-insensitive file systems). */
function isGitName(s: string): boolean {
  return s.toLowerCase() === '.git';
}

function refuse(reason: string): ToolDecision {
  return { allow: false, reason };
}
