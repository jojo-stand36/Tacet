import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

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
 * Claude Code's file tools, and the input fields that name their target. Newer Claude Code also
 * takes `path` for Write and `file_path` for Grep (claude-agent-acp source), so every spelling
 * present is checked. `MultiEdit` and `LS` no longer exist and are refused like any unknown tool.
 */
const FILE_TOOLS: Record<string, { fields: readonly string[]; needsPath: boolean }> = {
  Read: { fields: ['file_path', 'path'], needsPath: true },
  Write: { fields: ['file_path', 'path'], needsPath: true },
  Edit: { fields: ['file_path', 'path'], needsPath: true },
  NotebookEdit: { fields: ['notebook_path', 'file_path', 'path'], needsPath: true },
  // Search tools default to the working directory (the worktree) without a path.
  Glob: { fields: ['path', 'file_path'], needsPath: false },
  Grep: { fields: ['path', 'file_path'], needsPath: false },
};

/** Search-tool inputs that are patterns, not paths: checked for escapes, not resolved. */
const PATTERN_FIELDS = ['pattern', 'glob'] as const;

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

  let root: string;
  try {
    root = realpathSync.native(worktree);
  } catch {
    return refuse('the Worker checkout is gone');
  }
  const targets: string[] = [];
  for (const f of spec.fields) {
    const v = fields[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v === '') return refuse(`${name}: ${f} is not a path`);
    const at = inside(root, worktree, v);
    if (typeof at !== 'string') return refuse(`${name}: ${at.why}`);
    targets.push(at);
  }
  if (spec.needsPath && targets.length === 0) return refuse(`${name}: no path given`);
  for (const f of PATTERN_FIELDS) {
    const v = fields[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return refuse(`${name}: ${f} is not a pattern`);
    if (isAbsolute(v) || v.startsWith('~')) return refuse(`${name}: ${f} names an absolute path`);
    const segs = v.split(/[\\/]+/);
    if (segs.includes('..')) return refuse(`${name}: ${f} leaves the worktree`);
    if (segs.some(isGitName)) return refuse(`${name}: ${f} reaches git internals`);
  }
  const where = targets.length ? targets.map((t) => t || '.').join(', ') : 'the worktree';
  return { allow: true, reason: `${name} inside the worktree (${where})` };
}

/**
 * Where `p` lands, relative to the worktree's real path, or why it is refused. `..` is refused
 * outright (resolving it lexically and following a symlink first differ). Each existing component
 * is checked with `lstat`; a symlink must resolve inside the worktree, so a dangling one is
 * refused too. Components that do not exist yet are new names the tool would create.
 */
function inside(root: string, given: string, p: string): string | { why: string } {
  const segs = p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
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
    } catch {
      // Not there yet: the rest are names the tool would create, under `cur`.
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
