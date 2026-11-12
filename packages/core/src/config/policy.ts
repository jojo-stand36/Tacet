import type { PolicyRule } from './schema.js';

/**
 * Tool policies (#25, ADR-004 D): which `policies` rule decides a Worker's tool request. Pure: no
 * file system, no config loading. Until the worker sandbox (#53) a policy only narrows the
 * interim tool policy (#200); the caller applies the verdict.
 */

/** What a policy is asked about. */
export interface PolicyRequest {
  /** The tool's name as the Worker's adapter reports it, e.g. `Read`, `Bash`, `mcp__x__y`. */
  tool: string;
  /**
   * The tool's input as policies read it, defined per tool: for Claude Code's file tools, each
   * target path relative to the checkout, `/`-separated (`''` or `.` for the checkout itself).
   * Undefined for a tool without a defined input: then only rules without `match` apply.
   */
  paths?: readonly string[];
}

/** The deciding rule and its place in the merged `policies` list. */
export interface PolicyVerdict {
  decision: PolicyRule['decision'];
  rule: PolicyRule;
  /** Index in the rules given: stable for a run, so "one escalation per rule" can key on it. */
  index: number;
}

/** Tacet's own MCP tools: never subject to policies, so no rule can cut a Worker off from them. */
const OWN_TOOLS = 'mcp__tacet__';

const RANK: Record<PolicyRule['decision'], number> = { deny: 3, ask: 2, allow: 1 };

/**
 * The verdict of `rules` on `req`, or undefined when no rule matches (ADR-004 D). Order-free:
 * DENY beats ASK beats ALLOW, whatever the rules' order or layers; among rules of the same
 * decision, the first given is reported.
 *
 * A rule matches when its `tool` matches (exactly, or as a prefix when it ends in `*`; no `tool`
 * is any tool) and, if it has `match`, the request has a defined input and one of its paths
 * matches the glob: `*` within a path segment, `**` across segments (also none), `?` one
 * character; names are compared as a case-insensitive file system would, so `Secrets/x` cannot
 * slip past `secrets/**`.
 */
export function evaluatePolicies(
  rules: readonly PolicyRule[],
  req: PolicyRequest,
): PolicyVerdict | undefined {
  if (req.tool.startsWith(OWN_TOOLS)) return undefined;
  let best: PolicyVerdict | undefined;
  rules.forEach((rule, index) => {
    if (!toolMatches(rule.tool, req.tool)) return;
    if (rule.match !== undefined) {
      if (req.paths === undefined) return;
      const re = globRegExp(rule.match);
      if (!req.paths.some((p) => re.test(normalPath(p)))) return;
    }
    if (!best || RANK[rule.decision] > RANK[best.decision]) {
      best = { decision: rule.decision, rule, index };
    }
  });
  return best;
}

function toolMatches(pattern: string | undefined, tool: string): boolean {
  if (pattern === undefined) return true;
  return pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;
}

/** A name as a case-insensitive file system may compare it (NFKC, folded case). */
function fold(s: string): string {
  return s.normalize('NFKC').toUpperCase().toLowerCase();
}

/** A target path as globs see it: folded, `/`-separated, no `./` or empty segments. */
function normalPath(p: string): string {
  return fold(p)
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/');
}

/**
 * A policy glob as a regular expression over a normalised path. `**` is any number of whole
 * segments, none included: `a/**` matches `a` and everything under it, a `**` segment between
 * `a` and `b` also matches `a/b`, and a leading `**` segment matches at any depth.
 */
export function globRegExp(glob: string): RegExp {
  const segs = normalPath(glob).split('/');
  let re = '';
  segs.forEach((seg, i) => {
    const first = i === 0;
    if (seg === '**') {
      if (segs.length === 1) re += '.*';
      else if (first) re += '(?:.*/)?';
      else re += '(?:/.*)?';
      return;
    }
    // After a leading `**` its own pattern ends in `/`; elsewhere segments are joined by `/`.
    if (!first && !(i === 1 && segs[0] === '**')) re += '/';
    for (const c of seg) {
      if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  });
  return new RegExp(`^${re}$`, 'u');
}
