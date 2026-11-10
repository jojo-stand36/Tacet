import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Interactive Claude Code in a PTY (#15), verified on Claude Code 2.1.319 (the binary the pinned
 * `@anthropic-ai/claude-agent-sdk` 0.3.319 bundles) against a local mock of the Messages API;
 * capability matrix §1, "PTY mode / hooks (#15)".
 */
export const CLAUDE_PTY_VERIFIED_VERSION = '2.1.319';

/** Events delivered over HTTP. `SessionStart` supports only `command` hooks: see `forward`. */
const HTTP_EVENTS = [
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
 * The `--settings` file for one session: an `http` hook per event with the session's token as a
 * literal header (the file is 0600, outside the worktree), and a `command` hook that forwards
 * `SessionStart`. `--setting-sources ""` keeps the user's and the repo's own settings files, and
 * so their hooks, out of a Worker (see `claudeArgs`).
 */
export function claudeHookSettings(opts: {
  url: string;
  token: string;
  /** Shell command that forwards a `command` hook's stdin to the endpoint. */
  forward: string;
}): object {
  const hooks: Record<string, unknown[]> = {};
  for (const ev of HTTP_EVENTS) {
    hooks[ev] = [
      {
        ...(WITH_MATCHER.has(ev) ? { matcher: '' } : {}),
        hooks: [
          {
            type: 'http',
            url: `${opts.url}/${ev}`,
            headers: { Authorization: `Bearer ${opts.token}` },
            timeout: ev === 'PermissionRequest' ? PERMISSION_TIMEOUT_S : 30,
          },
        ],
      },
    ];
  }
  hooks.SessionStart = [{ hooks: [{ type: 'command', command: opts.forward, timeout: 10 }] }];
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
    // Only Tacet's settings: not the user's, not the repo's (as the SDK adapter's
    // `settingSources: []`). Their hooks, permissions and env would otherwise reach a Worker.
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
  if (opts.apiKey) approved.add(opts.apiKey.trim().slice(-20));
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

/** `PermissionRequest` answers (capability matrix §1). */
export const allowPermission = () => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
});
export const denyPermission = (message: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message },
  },
});
