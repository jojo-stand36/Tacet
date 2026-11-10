import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Interactive Claude Code in a PTY (#15), verified on Claude Code 2.1.319 (the binary the pinned
 * `@anthropic-ai/claude-agent-sdk` 0.3.319 bundles) against a local mock of the Messages API;
 * capability matrix §1, "PTY mode / hooks (#15)".
 */
export const CLAUDE_PTY_VERIFIED_VERSION = '2.1.319';

/** Events Tacet's hooks report, each relayed by a `command` hook (`hook-forward`, #164). */
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
] as const;
const WITH_MATCHER = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
]);

/** Seconds a `PermissionRequest` waits for Tacet's decision before Claude Code shows its own dialog. */
export const PERMISSION_TIMEOUT_S = 600;

/**
 * The `--settings` file for one session: a `command` hook per event that relays it to Tacet's
 * hook endpoint (`forward <event> <timeout>`, which reads the URL and token from the session's
 * 0600 file, so neither the token nor anything else secret is in the settings or on a command
 * line). Command hooks, not `http` ones: under Claude Code's Linux sandbox (#150) an `http` hook
 * goes through the sandbox's proxy and fails, while a command hook runs outside it (#164, verified
 * live on 2.1.319). `--setting-sources ""` keeps the user's and the repo's own settings files, and
 * so their hooks, out of a Worker (see `claudeArgs`).
 */
export function claudeHookSettings(opts: {
  /** Shell command that relays a hook's stdin to the endpoint; the event and timeout are appended. */
  forward: string;
}): object {
  const hooks: Record<string, unknown[]> = {};
  for (const ev of EVENTS) {
    const timeout =
      ev === 'PermissionRequest' ? PERMISSION_TIMEOUT_S : ev === 'SessionStart' ? 10 : 30;
    hooks[ev] = [
      {
        ...(WITH_MATCHER.has(ev) ? { matcher: '' } : {}),
        hooks: [{ type: 'command', command: `${opts.forward} ${ev} ${timeout}`, timeout }],
      },
    ];
  }
  return { hooks };
}

/** Claude Code's launch arguments for a Worker session. */
export function claudeArgs(opts: {
  settingsPath: string;
  sessionId?: string;
  resume?: string;
  model?: string;
  mcpConfigPath?: string;
}): string[] {
  return [
    '--settings',
    opts.settingsPath,
    // Only Tacet's settings: not the user's, not the repo's, and no CLAUDE.md. A checkout's
    // hooks, permissions, env and instructions would otherwise reach a Worker. The SDK adapter's
    // default `settingSources: []` is the same flag: the SDK passes `--setting-sources ''` (#181).
    '--setting-sources',
    '',
    // Ask before tools run, so approvals reach Tacet: Claude Code otherwise starts in auto mode.
    '--permission-mode',
    'manual',
    '--strict-mcp-config',
    ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
    ...(opts.resume ? ['--resume', opts.resume] : ['--session-id', opts.sessionId ?? '']),
    ...(opts.model ? ['--model', opts.model] : []),
  ];
}

/**
 * Prepare a Worker's own Claude Code config directory (`CLAUDE_CONFIG_DIR`, mode 0700) so the
 * interactive binary starts without first-run dialogs nobody can answer: onboarding done, the
 * worktree trusted, and the API key from the environment approved (Claude Code stores the last
 * 20 characters of an approved key, as it does when a user approves one; never the key). The
 * user's own `~/.claude.json` is never touched. Trusting the worktree is what the Agent SDK does
 * for every session; with `--setting-sources ""` and `--strict-mcp-config` the repo's own hooks,
 * settings and MCP servers still do not load.
 */
export function prepareClaudeConfigDir(dir: string, opts: { cwd: string; apiKey?: string }): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`Claude config directory ${dir} is not a private directory`);
  }
  chmodSync(dir, 0o700);
  const path = join(dir, '.claude.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // New or unreadable: start over.
  }
  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
  projects[opts.cwd] = { ...projects[opts.cwd], hasTrustDialogAccepted: true };
  const responses = (config.customApiKeyResponses ?? {}) as {
    approved?: string[];
    rejected?: string[];
  };
  const approved = new Set(responses.approved ?? []);
  if (opts.apiKey) {
    const key = opts.apiKey.trim();
    // Claude Code keeps the last 20 characters; for a shorter key that would be all of it.
    if (key.length <= 20) {
      throw new Error('the API key is too short to approve without storing it whole');
    }
    approved.add(key.slice(-20));
  }
  config = {
    ...config,
    hasCompletedOnboarding: true,
    projects,
    customApiKeyResponses: { approved: [...approved], rejected: responses.rejected ?? [] },
  };
  const tmp = `${path}.tacet-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config), { mode: 0o600 });
  renameSync(tmp, path);
}

// ---- hook payloads (capability matrix §1, "PTY mode / hooks (#15): common input fields") ----

const Base = z.looseObject({ hook_event_name: z.string(), session_id: z.string().optional() });

export const ClaudeHook = z.discriminatedUnion('hook_event_name', [
  z.looseObject({ hook_event_name: z.literal('SessionStart'), session_id: z.string().optional() }),
  z.looseObject({
    hook_event_name: z.literal('UserPromptSubmit'),
    session_id: z.string().optional(),
  }),
  z.looseObject({
    hook_event_name: z.literal('PreToolUse'),
    session_id: z.string().optional(),
    tool_name: z.string(),
    tool_input: z.unknown(),
    tool_use_id: z.string(),
  }),
  z.looseObject({
    hook_event_name: z.enum(['PostToolUse', 'PostToolUseFailure']),
    session_id: z.string().optional(),
    tool_use_id: z.string(),
  }),
  z.looseObject({
    hook_event_name: z.literal('PermissionRequest'),
    session_id: z.string().optional(),
    tool_name: z.string(),
    tool_input: z.unknown(),
  }),
  z.looseObject({
    hook_event_name: z.literal('Notification'),
    session_id: z.string().optional(),
    notification_type: z.string().optional(),
  }),
  z.looseObject({
    hook_event_name: z.literal('Stop'),
    session_id: z.string().optional(),
    last_assistant_message: z.string().optional(),
    background_tasks: z.array(z.unknown()).optional(),
  }),
  z.looseObject({
    hook_event_name: z.literal('StopFailure'),
    session_id: z.string().optional(),
  }),
]);
export type ClaudeHook = z.infer<typeof ClaudeHook>;

/** A hook body as a known event, or `undefined` for anything else (ignored, never an error). */
export function parseClaudeHook(body: unknown): ClaudeHook | undefined {
  if (!Base.safeParse(body).success) return undefined;
  const r = ClaudeHook.safeParse(body);
  return r.success ? r.data : undefined;
}

/**
 * The `PreToolUse` answer for a tool call: every tool but Tacet's own MCP tools must ask, so the
 * decision reaches Tacet as a `PermissionRequest`, even for tools Claude Code would run without
 * asking (Read, Glob, ...). Matches the Mini-conductor's policy until the escalation gate (#25)
 * decides per tool. Tacet's tools follow Claude Code's own flow.
 */
export function preToolUseDecision(
  toolName: string,
  tacetPrefix = 'mcp__tacet__',
): object | undefined {
  if (toolName.startsWith(tacetPrefix)) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'Tacet decides every tool call',
    },
  };
}

/** `PermissionRequest` answers (capability matrix §1). */
export const allowPermission = () => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
});
/** `interrupt: true` also stops the turn (verified live, #15: no `Stop` follows). */
export const denyPermission = (message: string, interrupt = false) => ({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}) },
  },
});
