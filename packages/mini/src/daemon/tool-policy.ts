import { type Dirent, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
  // Grep's `glob` is not taken: Claude Code splits it on spaces and commas and passes each piece
  // after its own `!.git` exclude, so a piece like `*` would search git internals again.
  Grep: {
    paths: ['path', 'file_path'],
    globs: [],
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

/**
 * Agent, editor, hook and package-manager config a Worker may not write (owner decision on #200,
 * 2026-11-10). Tacet's own sessions never load them (no setting sources, a strict MCP config,
 * git hooks off), but the user's tools would, once the user opens or merges the branch: a hook,
 * an MCP server command or a task there runs code. Tacet's own `.tacet/` config is loaded by the
 * next `tacet run` on the merged branch (#227). Matched at any depth and in any letter case, on
 * the path as written and on the path after symlinks are resolved; a symlink in a protected name
 * at the checkout's root, or inside a protected directory there, protects its target too (a
 * committed `.tacet` symlink to `config/tacet` is still Tacet's config; `linkedConfig`). A task that needs one of these escalates. The list
 * cannot be complete (`package.json` scripts and a `Makefile` run code too, but are the work
 * itself); it covers the files that run without the user choosing to build or test.
 * Directories: anything inside them. Files: that name anywhere.
 */
const PROTECTED_DIRS: readonly string[][] = [
  ['.claude'],
  ['.cursor'],
  ['.gemini'],
  ['.codex'],
  ['.husky'],
  ['.github', 'workflows'],
  // Tacet's own config: `verify` commands, agent commands and tiers apply once merged (#227).
  ['.tacet'],
];
const PROTECTED_FILES: readonly string[] = [
  '.mcp.json',
  '.envrc',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  // Git hook managers: a linked worktree shares the repo's hooks.
  '.pre-commit-config.yaml',
  'lefthook.yml',
  '.lefthook.yml',
];
/** Editor files that can run commands: `.vscode/tasks.json` and its siblings. */
const PROTECTED_IN: readonly [string, string][] = [
  ['.vscode', 'tasks.json'],
  ['.vscode', 'launch.json'],
  ['.vscode', 'settings.json'],
  ['.vscode', 'mcp.json'],
];

/**
 * Whether writing `rel` (relative to the checkout, `/`-separated) would change protected config.
 * Also what Tacet refuses to commit for a Worker (#260).
 */
export function protectedConfig(rel: string): boolean {
  const segs = rel.split(sep).map(fold);
  const name = segs.at(-1) ?? '';
  if (PROTECTED_FILES.includes(name)) return true;
  // Every config name lefthook reads, in any of its formats, local overrides included
  // (github.com/evilmartians/lefthook docs/configuration.md "Config file name", checked
  // 2026-11-10); the `.config/` copies are matched by name like the rest.
  if (/^\.?lefthook(-local)?\.(yml|yaml|toml|json|jsonc)$/.test(name)) return true;
  for (let i = 0; i < segs.length; i++) {
    for (const dir of PROTECTED_DIRS) {
      if (dir.every((d, j) => segs[i + j] === d) && segs.length > i + dir.length - 1) {
        // The directory itself, or anything inside it.
        return true;
      }
    }
  }
  return PROTECTED_IN.some(([d, f]) => segs.length >= 2 && segs.at(-2) === d && name === f);
}

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
 *
 * Checked when the request is decided, not when the tool runs: safe only while a Worker cannot
 * create a symlink or hard link between the two (no Bash, no link-making tool; #206). Revisit
 * before any such tool is allowed.
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
  // Where protected config really is when a symlink is involved; null when that cannot be told.
  const linked = spec.writes ? linkedConfig(root) : [];
  if (linked === null) {
    return refuse(
      `${name}: agent, hook or tool config in this checkout is a symlink that cannot be resolved inside it; escalate`,
    );
  }
  const targets: string[] = [];
  /** Where each path key landed: a glob is resolved from its tool's `path` (#213 review). */
  const landed: Record<string, string> = {};
  for (const f of spec.paths) {
    const v = fields[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v === '') return refuse(`${name}: ${f} is not a path`);
    const at = inside(root, worktree, v, spec.writes);
    if (typeof at !== 'string') return refuse(`${name}: ${at.why}`);
    if (
      spec.writes &&
      (protectedConfig(at) || protectedConfig(lexical(root, worktree, v)) || within(at, linked))
    ) {
      return refuse(
        `${name}: agent, hook and tool config is not open to Workers; escalate if the task needs it`,
      );
    }
    targets.push(at);
    landed[f] = at;
  }
  if (spec.needsPath && targets.length === 0) return refuse(`${name}: no path given`);
  for (const f of spec.globs) {
    const v = fields[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v === '') return refuse(`${name}: ${f} is not a pattern`);
    const why = badGlob(root, worktree, v, landed.path ?? '');
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
function badGlob(root: string, given: string, v: string, base: string): string | undefined {
  if (v !== v.trim() || hasControl(v)) return 'has surrounding space or control characters';
  if (v.includes('\\')) return 'has a backslash';
  if (isAbsolute(v) || v.startsWith('~')) return 'names an absolute path';
  if (/[{}]/.test(v)) return 'uses brace expansion';
  if (/^[$%]/.test(v)) return 'starts with $ or %';
  const segs = v.split('/');
  if (segs.includes('..')) return 'leaves the worktree';
  if (segs.some((s) => s !== '' && s !== '.' && ntfsAlias(s))) {
    return 'has a name another file system may read differently';
  }
  // A wildcard segment that matches `.git` reaches it, except the bare `*` and `**` a search needs:
  // Glob only lists names, so those can show `.git` names, never contents (Read is refused there).
  if (segs.some((s) => isGitName(s) || (s !== '*' && s !== '**' && segmentMatches(s, '.git')))) {
    return 'reaches git internals';
  }
  const literal: string[] = [];
  for (const s of segs) {
    if (/[*?[\]]/.test(s)) break;
    literal.push(s);
  }
  if (literal.length > 0) {
    // From the tool's own `path` (already resolved inside the checkout), not the checkout root.
    const from = base === '' ? [] : base.split(sep);
    const at = inside(root, given, [...from, ...literal].join('/'), false);
    if (typeof at !== 'string') return at.why.replace(/^the path/, 'its directory');
  }
  return undefined;
}

/** Whether the glob segment `seg` (`*`, `?`, `[...]`; braces are refused before) matches `name`, ignoring case. */
function segmentMatches(rawSeg: string, name: string): boolean {
  const seg = fold(rawSeg);
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end < 0) return true; // An unclosed class: assume the worst.
      let body = seg.slice(i + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      re += `[${body.replace(/[\\\]]/g, '\\$&')}]`;
      i = end;
    } else re += c.replace(/[.+^$(){}|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`, 'i').test(name);
  } catch {
    return true;
  }
}

/** Entries a protected directory may hold before `linkedConfig` stops looking and fails closed. */
const LINK_WALK_LIMIT = 2000;

/**
 * Where protected config really is when a symlink is involved, as folded segments relative to the
 * real root (#227 review): a root-level protected name with a symlink at any of its components
 * (`.tacet -> config/tacet`, `.github -> ci/github`), and every symlink inside a protected
 * directory at the root, at any depth and through linked directories (`.tacet/tacet.yaml ->
 * ../cfg.yaml`). What is written at a target is still read as that config, and a dangling link's
 * target is protected before it exists. A target outside the checkout needs nothing: writes there
 * are refused anyway. Null, so every write is refused, when that cannot be told: a link that
 * cannot be followed (a loop), a link to the checkout root, or a walk over the entry limit.
 */
function linkedConfig(root: string): string[][] | null {
  const out: string[][] = [];
  /** Records `real` if it is inside the checkout; false when it is the root itself. */
  const add = (real: string): boolean => {
    const r = relative(root, real);
    if (r === '') return false;
    if (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)) out.push(r.split(sep).map(fold));
    return true;
  };
  const names = [
    ...PROTECTED_DIRS,
    ...PROTECTED_FILES.map((f) => [f]),
    ...PROTECTED_IN.map(([d, f]) => [d, f]),
  ];
  const stack: string[] = [];
  for (const segs of names) {
    const given = join(root, ...segs);
    const real = landing(given);
    if (real === null) return null;
    if (real !== given && !add(real)) return null;
    stack.push(real);
  }
  // Symlinks inside the protected directories, following linked directories inside the checkout.
  const visited = new Set<string>();
  let seen = 0;
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // Not there, a file, or not readable: nothing inside to follow.
    }
    for (const e of entries) {
      if (++seen > LINK_WALK_LIMIT) return null;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isSymbolicLink()) {
        const t = landing(p);
        if (t === null || !add(t)) return null;
        const r = relative(root, t);
        if (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)) stack.push(t);
      }
    }
  }
  return out;
}

/**
 * Where a write to `p` (absolute) would land after symlinks, even where the target does not
 * exist yet (a dangling link, a missing parent): the real path of the deepest existing prefix and
 * the rest lexically. Null when that cannot be told (a symlink loop, an unreadable link).
 */
function landing(p: string, depth = 0): string | null {
  if (depth > 40) return null;
  try {
    return realpathSync.native(p);
  } catch {
    // Missing, or a link that does not resolve: worked out below.
  }
  let link: boolean;
  try {
    link = lstatSync(p).isSymbolicLink();
  } catch {
    const parent = dirname(p);
    if (parent === p) return null;
    const at = landing(parent, depth + 1);
    return at === null ? null : join(at, basename(p));
  }
  if (!link) return null;
  let to: string;
  try {
    to = readlinkSync(p);
  } catch {
    return null;
  }
  const from = landing(dirname(p), depth + 1);
  if (from === null) return null;
  // One segment at a time, as the kernel does: `..` after a linked directory leaves its target.
  let cur = isAbsolute(to) ? sep : from;
  for (const seg of to.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      cur = dirname(cur); // `cur` is real, or missing below a real prefix: no link to leave.
      continue;
    }
    const next = landing(join(cur, seg), depth + 1);
    if (next === null) return null;
    cur = next;
  }
  return cur;
}

/** Whether `at` (relative to the real root) is one of `targets` or inside one, names folded. */
function within(at: string, targets: string[][]): boolean {
  const a = at.split(sep).map(fold);
  return targets.some((t) => t.length <= a.length && t.every((s, j) => a[j] === s));
}

/**
 * `p` relative to the checkout as written, before symlinks: `inside` has already refused `..`,
 * paths elsewhere and odd names, so this only joins its plain segments.
 */
function lexical(root: string, given: string, p: string): string {
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!isAbsolute(p)) return segs.join(sep);
  const abs = `${sep}${segs.join(sep)}`;
  for (const r of [root, given]) {
    const rel = relative(r, abs);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return rel;
  }
  return '';
}

/** Whether `s` has a C0 or C1 control character (NEL included) or DEL. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * A name NTFS (a WSL2 checkout under `/mnt/c`) or a URL-aware tool may read as another one, as
 * git's protectNTFS refuses: a trailing dot or space (`.git.` is `.git`), a colon (alternate data
 * streams, `.git::$INDEX_ALLOCATION`; also URL schemes such as `file:`), or an 8.3 short name
 * (`GIT~1`, `CLAUDE~1`, `MCP~1.JSO`).
 */
function ntfsAlias(seg: string): boolean {
  return /[. ]$/.test(seg) || seg.includes(':') || /~\d+(\.|$)/i.test(seg);
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
  // Claude Code trims a path before it expands `~` and resolves it: " /etc" is /etc to it.
  // Anything not already trimmed, or with a control character, is refused.
  if (p !== p.trim() || hasControl(p)) {
    return { why: 'the path has surrounding space or control characters' };
  }
  // A backslash is an ordinary name character on POSIX: refused rather than guessed at.
  if (p.includes('\\')) return { why: 'the path has a backslash' };
  // Expanded by nothing but a shell (Claude Code expands only `~`), refused all the same.
  if (/^[$%]/.test(p)) return { why: 'the path starts with $ or %' };
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
  // Only names inside the checkout: the checkout's own parents (a WSL2 `/mnt/c/Users/JOHNSM~1`)
  // are not the Worker's to choose (#213 review).
  if (rel.some(ntfsAlias)) {
    return { why: 'the path has a name another file system may read differently' };
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
      // A link to `CLAUDE~1` on DrvFs reaches `.claude` as surely as the name itself would.
      if (r !== '' && r.split(sep).some(ntfsAlias)) {
        return { why: 'the path has a name another file system may read differently' };
      }
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
  // The last component may be a symlink to a hard-linked file: what a write would change.
  if (writes) {
    try {
      const st = statSync(cur);
      if (st.isFile() && st.nlink > 1) return { why: 'the file has other hard links' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        return { why: 'the path cannot be checked' };
    }
  }
  return relative(root, cur);
}

/** `.git`, in any letter case (case-insensitive file systems). */
function isGitName(s: string): boolean {
  const f = fold(s);
  // `git~1` and the like: the NTFS short name a `.git` can be reached by (git's protectNTFS).
  return f === '.git' || /^git~\d+$/.test(f);
}

/**
 * A name as a case-insensitive file system may compare it: compatibility-normalised (NFKC maps
 * `ſ` to `s`), with the code points HFS+ ignores removed (zero-width joiners, bidi marks, BOM;
 * CVE-2014-9390), and case-folded by upper- then lower-casing (APFS and HFS+ fold case).
 */
export function fold(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .toUpperCase()
    .toLowerCase();
}

function refuse(reason: string): ToolDecision {
  return { allow: false, reason };
}
