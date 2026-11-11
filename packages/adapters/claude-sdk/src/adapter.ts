import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type ApprovalDecision,
  AsyncQueue,
  DeltaScrubber,
  type InterruptResult,
  mcpHeaderSecrets,
  ProfileRefusedError,
  type SendOptions,
  type SessionHandle,
  type SessionOptions,
  type SessionState,
  scrubbedEvents,
  type UserInput,
  type WorkerEnvPolicy,
  workerEnv,
} from '@tacet/core';
import { defaultStateDir, repoStateDir } from '@tacet/core/node';
import { authEnv, type ClaudeAuthRoute, claudeEnvAllow, withSubprocessScrub } from './auth.js';
import { isOwnDir, removeClaudeConfigDir, repoOf, sweepClaudeConfigDirs } from './config-dirs.js';
import { removeMcpConfig, sweepStaleMcpConfigs, writeMcpConfig } from './mcp-config.js';
import {
  removeSandboxResidue,
  residueSnapshot,
  SANDBOX_ENV,
  type SandboxResidue,
} from './placeholders.js';

/** Vendor session ids are UUIDs: they name each session's config directory. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTEXT_1M = 1_000_000;

/**
 * Capabilities verified against the Claude Agent SDK in spike #64
 * (docs/adapters/spikes/64-claude) and re-checked on SDK 0.3.319 by this package's conformance
 * test. Cost is `estimated` because `total_cost_usd` is a client-side estimate, not billing data.
 */
export const CLAUDE_SDK_CAPABILITIES: AdapterCapabilities = {
  streaming: true,
  liveInput: true,
  approvals: 'roundtrip',
  interrupt: 'receipt',
  resume: true,
  fork: 'native',
  usage: { live: true, context: true, cost: 'estimated' },
  modelSwitch: 'mid-session',
  injectContext: false,
  // Verified on SDK 0.3.319 against the mock API (#110): `applyFlagSettings({ effortLevel })`
  // changes the next request's `output_config.effort`.
  effortSwitch: 'per-turn',
  // The `context-1m-2025-08-07` beta; refused for models the SDK does not document it for.
  contextSizes: [CONTEXT_1M],
};

export interface ClaudeSdkAdapterOptions {
  /**
   * Which credentials the Worker uses (see `chooseAuthRoute`). Default `api_key`, the owner's
   * policy for parallel or unattended Workers.
   */
  authRoute?: ClaudeAuthRoute;
  /** The user's environment, which the Worker gets an allowlist of. Default `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Which of `baseEnv` the Worker gets (#147). Default: the allowlist (`workerEnv`), with no
   * passthrough. Interactive sessions may pass `{ inherit: 'all' }`.
   */
  envPolicy?: WorkerEnvPolicy;
  /** Told the names (never values) of the variables left out of each session's environment. */
  onEnvDropped?: (names: string[]) => void;
  /**
   * The repo the sessions belong to; keys their config directories (#237). Default: the repo of
   * the session's cwd (the main checkout, for a git worktree), else the cwd itself.
   */
  repoRoot?: string;
  /** Tacet's state directory, where the sessions' config directories live. Default `~/.tacet/state`. */
  stateDir?: string;
  /**
   * Days after its last write that a session's config directory (its transcript) is removed, if
   * no Mini-conductor discarded it before (#237). Swept when the adapter starts its first session
   * for a repo. Default 30, as `events.retention.transcript_days`.
   */
  retentionDays?: number;
  /** Directory for per-session MCP config files. Default `~/.tacet/run/mcp`. */
  mcpConfigDir?: string;
  /**
   * Told how many stale MCP config files (of Mini-conductors no longer running) were removed when
   * this adapter started its first session (#108). Only the count: never names or contents.
   */
  onSweep?: (removedFiles: number) => void;
  /**
   * SDK options passed through unchanged, e.g. `pathToClaudeCodeExecutable`.
   *
   * `settingSources` defaults to `[]` (#181): no user, project or local settings and no CLAUDE.md,
   * so a checkout a Worker wrote cannot add hooks, permissions, environment or instructions to a
   * later session. Passing it here is the explicit opt-in, e.g. `['project']` for an interactive
   * session in the user's own repo. Never opt in for a session in a Worker's checkout.
   * On the API-key route `user` means the session's own config dir (#237), which is empty, not
   * the user's `~/.claude`. MCP servers
   * come only from Tacet's config either way (`strictMcpConfig` is always on), never from the
   * user's or the project's settings or `.mcp.json`.
   */
  sdkOptions?: Pick<
    Options,
    'settingSources' | 'pathToClaudeCodeExecutable' | 'permissionMode' | 'allowedTools'
  >;
  /**
   * Whether the commands an API-key Worker runs get its credentials stripped (#150). Default
   * `true`; `false` is honoured only with `query` (a test that replaces the Claude Code binary).
   */
  subprocessScrub?: boolean;
  /**
   * Unattended Workers (#206): the session gets only Claude Code's file tools, with no shell at
   * all, and every read and search goes through `approval.request` like an edit does, so the
   * Mini-conductor's policy (#200) decides each one.
   *
   * - `tools` names exactly the file tools, so Bash, the web tools and the rest do not exist, and
   *   `Glob` and `Grep` are present (absent by default on macOS, Linux and WSL, where Claude Code
   *   searches with Bash instead). `disallowedTools` removes the shell tools from the model's
   *   context as well, in case `tools` ever stops being an allowlist.
   * - A `PreToolUse` hook asks Tacet about `Read`, `Glob` and `Grep`, which the SDK otherwise runs
   *   without calling `canUseTool` (reads inside the working directory need no permission). It
   *   fails closed (`onFailure: 'block'`).
   *
   * Verified 2026-11-10 against SDK 0.3.319 types and code.claude.com/docs (tools reference,
   * agent-sdk permissions); see docs/adapters/capability-matrix.md.
   */
  fileToolsOnly?: boolean;
  /** Replaces the SDK's `query()`; for tests. */
  query?: typeof sdkQuery;
}

/** The tools an unattended Worker gets (`fileToolsOnly`). */
export const FILE_TOOLS = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'] as const;
/** Shell tools removed outright for `fileToolsOnly`, whatever `tools` does. */
export const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor'] as const;
/** File tools the SDK runs without `canUseTool` inside the working directory. */
const SELF_APPROVED = ['Read', 'Glob', 'Grep'];

interface PendingApproval {
  resolve: (r: PermissionResult) => void;
  suggestions: PermissionUpdate[] | undefined;
}

interface Session {
  handle: SessionHandle;
  q: Query;
  inbox: AsyncQueue<SDKUserMessage>;
  events: AsyncQueue<AgentEvent>;
  state: SessionState;
  /** Texts of inputs sent but not yet answered by a `result`, by message uuid. */
  pending: Map<string, string>;
  approvals: Map<string, PendingApproval>;
  interrupting: boolean;
  closing: boolean;
  /** The process has exited or failed; only `close()`, `events()` and `status()` still work. */
  ended: boolean;
  /** Literal secrets of this session (MCP header values), scrubbed from every event. */
  secrets: string[];
  /** Under the scrub: the checkout and HOME, and which placeholder paths they had (#263). */
  placeholders: SandboxResidue | undefined;
  /** Scrubs message text across delta boundaries (#109); made on the first event. */
  deltas?: DeltaScrubber;
  model: string | undefined;
  /** Effort requested for this session (launch or the last `send`), if any. */
  effort: EffortLevel | undefined;
  /** Context window opted into at launch, if any. */
  contextWindow: number | undefined;
  /** `supportedModels()`, fetched once when effort first needs checking. */
  models: Promise<ModelInfo[]> | undefined;
  /**
   * Last cumulative `total_cost_usd`, to turn it into per-turn deltas. `undefined` when resuming
   * a session whose earlier total this adapter never saw: the first turn then sets the baseline
   * and reports no cost, because its total includes the whole earlier session.
   */
  costSoFar: number | undefined;
  /** The top-level model call in progress: prompt tokens and model from `message_start`. */
  call: { inputTokens: number; model: string | undefined } | undefined;
  /** Context window of `contextMaxModel`, from `getContextUsage`. */
  contextMax: number | undefined;
  contextMaxModel: string | undefined;
  /** Context size after the last model call (prompt plus output). */
  contextUsed: number | undefined;
  mcpConfigPath: string | undefined;
  loop: Promise<void>;
}

const CLIENT_APP = 'tacet/0.0.0';
const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Models the SDK documents the 1M beta for ("Sonnet 4/4.5 only"). The binary sends the beta
 * header for any model, so the adapter refuses the rest rather than let the request fail or
 * silently run with the default window.
 */
const CONTEXT_1M_MODELS = /^claude-sonnet-4(-5)?(-\d{8})?$/;
/** Vendor sessions whose cost baseline is remembered for resume; the oldest is dropped. */
const COST_TOTALS_MAX = 1000;

/**
 * Tacet adapter for Claude Code, driven through the Claude Agent SDK's streaming-input
 * `query()`. One `query()` (one Claude Code process) per session. Vendor messages are mapped to
 * `AgentEvent`s here and nothing SDK-specific leaves this module.
 *
 * Status: `running` from the first `send()` until the turn's `result`, then `idle` (or
 * `cancelled` / `error`). Input sent during a turn runs next, so `idle` can be followed at once
 * by `running`: consumers must not read `idle` alone as "the Worker is finished". An approval
 * the SDK aborts (e.g. the turn was interrupted) is dropped without an event; a later
 * `respond()` for it throws. After the process exits, the session reports `done` or `error` and
 * only `close()` remains useful.
 */
export class ClaudeSdkAdapter implements AgentAdapter {
  readonly id = 'claude-sdk';
  readonly #opts: ClaudeSdkAdapterOptions;
  readonly #sessions = new Map<string, Session>();
  /** Last cumulative cost seen per vendor session, so resume and fork report deltas. */
  readonly #costTotals = new Map<string, number>();
  #swept = false;
  /** Config roots already swept by this adapter (#237). */
  readonly #sweptRoots = new Set<string>();

  constructor(opts: ClaudeSdkAdapterOptions = {}) {
    this.#opts = opts;
  }

  capabilities(): AdapterCapabilities {
    return structuredClone(CLAUDE_SDK_CAPABILITIES);
  }

  async start(opts: SessionOptions): Promise<SessionHandle> {
    const effort = opts.effort === undefined ? undefined : effortLevel(opts.effort);
    if (opts.contextWindow !== undefined) {
      if (opts.contextWindow !== CONTEXT_1M) {
        throw new ProfileRefusedError(
          'contextWindow',
          `Claude supports only a ${CONTEXT_1M}-token window opt-in, not ${opts.contextWindow}`,
        );
      }
      check1m(opts.model);
    }
    const id = randomUUID();
    const base = this.#opts.baseEnv ?? process.env;
    const filtered = workerEnv(
      base,
      claudeEnvAllow({ ...base, ...opts.env }),
      this.#opts.envPolicy,
    );
    this.#opts.onEnvDropped?.(filtered.dropped);
    // The SDK's `env` replaces the child's environment (verified, 0.3.319): only this reaches it.
    const route = this.#opts.authRoute ?? 'api_key';
    const routed = authEnv(route, {
      ...filtered.env,
      ...opts.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    });
    // An API-key Worker's commands never see the key (#150); a login session has none to hide.
    const scrub =
      route === 'api_key' && !(this.#opts.subprocessScrub === false && this.#opts.query);
    const env = scrub ? { ...withSubprocessScrub(routed), ...SANDBOX_ENV } : routed;
    // The sandbox the scrub turns on leaves empty placeholders in the checkout and the HOME it
    // runs with; removed at close (#263).
    const placeholders = scrub ? residueSnapshot(opts.cwd, env.HOME ?? homedir()) : undefined;
    // Tacet owns the effort: this variable overrides the `effort` option and later
    // `applyFlagSettings` calls without any sign that it did.
    delete env.CLAUDE_CODE_EFFORT_LEVEL;

    // A fresh session gets its vendor id up front, so the handle can be resumed even if it
    // closes before the first turn. A fork gets a new id; a plain resume keeps the old one.
    let vendorSessionId: string;
    const sessionOpts: Partial<Options> = {};
    if (opts.resume) {
      sessionOpts.resume = opts.resume.vendorSessionId;
      if (opts.resume.fork) {
        vendorSessionId = randomUUID();
        sessionOpts.forkSession = true;
        sessionOpts.sessionId = vendorSessionId;
      } else {
        vendorSessionId = opts.resume.vendorSessionId;
      }
    } else {
      vendorSessionId = randomUUID();
      sessionOpts.sessionId = vendorSessionId;
    }

    // On the API-key route each session has a config dir of its own (#237), so its transcript is
    // never in the user's `~/.claude` and can be removed when it will never be resumed. The
    // subscription route keeps the user's own: their login lives there.
    let configDir: string | undefined;
    let madeConfigDir = false;
    const claimed = opts.resume?.vendorSessionId;
    if (this.#ownConfigDirs) {
      if (claimed !== undefined && !UUID.test(claimed)) {
        throw new Error('a Claude session to resume is named by its UUID');
      }
      const root = this.#configRoot(opts.cwd);
      this.#sweep(root, claimed);
      configDir = join(root, vendorSessionId);
      if (opts.resume && !opts.resume.fork) {
        if (!isOwnDir(configDir)) throw new Error(`no Claude session ${vendorSessionId} to resume`);
      } else {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        if (opts.resume) {
          const from = opts.resume.vendorSessionId;
          // Its transcript may be mid-write: a copy could cut a line or miss the last turn.
          if ([...this.#sessions.values()].some((x) => x.handle.vendorSessionId === from)) {
            throw new Error(`Claude session ${from} is open; fork it once it is closed`);
          }
          const source = join(root, from);
          if (!isOwnDir(source)) {
            throw new Error(`no Claude session ${opts.resume.vendorSessionId} to fork`);
          }
          // The fork resumes the source's transcript in a copy of its directory, so the source's
          // own stays as it is and each can be removed alone. Links are copied as links.
          // Set first: a copy that fails partway is removed too.
          madeConfigDir = true;
          try {
            cpSync(source, configDir, {
              recursive: true,
              errorOnExist: true,
              verbatimSymlinks: true,
            });
          } catch (err) {
            rmSync(configDir, { recursive: true, force: true });
            throw err;
          }
        } else {
          mkdirSync(configDir, { mode: 0o700 });
          madeConfigDir = true;
        }
      }
      env.CLAUDE_CONFIG_DIR = configDir;
    }
    // A session that never started leaves nothing to resume.
    const unmake = () => {
      if (madeConfigDir && configDir) rmSync(configDir, { recursive: true, force: true });
    };

    if (!this.#swept) {
      // Once per adapter, which lives as long as its Mini-conductor: files a crashed one left.
      this.#swept = true;
      // Cleanup never stands in the way of a session.
      try {
        const removed = sweepStaleMcpConfigs(this.#opts.mcpConfigDir);
        this.#opts.onSweep?.(removed);
      } catch {
        // Tried again by the next Mini-conductor that starts.
      }
    }
    let mcpConfigPath: string | undefined;
    try {
      mcpConfigPath = opts.mcpServers?.length
        ? writeMcpConfig(opts.mcpServers, {
            sessionId: id,
            worktree: opts.cwd,
            ...(this.#opts.mcpConfigDir !== undefined ? { dir: this.#opts.mcpConfigDir } : {}),
          })
        : undefined;
    } catch (err) {
      // Nothing started: the dir made above is removed with it.
      unmake();
      throw err;
    }

    const inbox = new AsyncQueue<SDKUserMessage>();
    const handle: SessionHandle = { id, vendorSessionId };
    // `s` is assigned below, before the SDK can call canUseTool.
    let s: Session | undefined;
    const canUseTool: CanUseTool = (toolName, input, ctx) =>
      s ? this.#askApproval(s, toolName, input, ctx) : Promise.resolve(deny('session not ready'));
    // `fileToolsOnly`: reads and searches asked about too, through the same approval round trip.
    const askHook: HookCallback = async (input, _id, { signal }) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const toolInput =
        typeof input.tool_input === 'object' && input.tool_input !== null
          ? (input.tool_input as Record<string, unknown>)
          : {};
      const r = s
        ? await this.#askApproval(s, input.tool_name, toolInput, {
            signal,
            suggestions: [],
            toolUseID: input.tool_use_id,
            requestId: `hook-${input.tool_use_id}`,
          })
        : deny('session not ready');
      if (r.behavior === 'allow') {
        // The whole decision, as `canUseTool` would take it: a rewritten input runs, never the
        // original one the decision was not about.
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            ...(r.updatedInput !== undefined ? { updatedInput: r.updatedInput } : {}),
          },
        };
      }
      return {
        // A cancel stops the turn, as `canUseTool`'s `interrupt` does.
        ...(r.interrupt ? { continue: false, stopReason: r.message } : {}),
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: r.message,
        },
      };
    };

    let q: Query;
    try {
      q = (this.#opts.query ?? sdkQuery)({
        prompt: inbox,
        options: {
          ...this.#opts.sdkOptions,
          // SDK isolation mode unless the caller opted in (#181); see `sdkOptions`.
          settingSources: this.#opts.sdkOptions?.settingSources ?? [],
          // Only Tacet's MCP config (the `--mcp-config` file below): never a checkout's `.mcp.json`
          // or a plugin's servers, whatever the setting sources (#181).
          strictMcpConfig: true,
          ...sessionOpts,
          cwd: opts.cwd,
          env,
          includePartialMessages: true,
          canUseTool,
          ...(this.#opts.fileToolsOnly
            ? {
                tools: [...FILE_TOOLS],
                disallowedTools: [...SHELL_TOOLS],
                // Never auto-approve: an `allowedTools` entry would skip `canUseTool`.
                allowedTools: [],
                // No `@path` expansion or slash commands in prompts: Worker-written text (a verify
                // command's output) reaches the next prompt, and an `@path` there would be read
                // in without asking (#214 review; SDK 0.3.319 `verbatimPrompts`).
                verbatimPrompts: true,
                permissionMode: 'default' as const,
                hooks: {
                  PreToolUse: [
                    {
                      matcher: SELF_APPROVED.join('|'),
                      hooks: [askHook],
                      timeout: 3600,
                      onFailure: 'block' as const,
                    },
                  ],
                },
              }
            : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(opts.contextWindow === CONTEXT_1M ? { betas: ['context-1m-2025-08-07'] } : {}),
          ...(opts.systemPrompt !== undefined
            ? {
                systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.systemPrompt },
              }
            : {}),
          // A file, not the `mcpServers` option: the SDK passes `mcpServers` as JSON on the
          // command line, where any local user can read the Worker token in the process list.
          ...(mcpConfigPath ? { extraArgs: { 'mcp-config': mcpConfigPath } } : {}),
        },
      });
    } catch (err) {
      if (mcpConfigPath) removeMcpConfig(mcpConfigPath);
      unmake();
      throw err;
    }

    s = {
      handle,
      q,
      inbox,
      events: new AsyncQueue(),
      state: 'idle',
      pending: new Map(),
      approvals: new Map(),
      interrupting: false,
      closing: false,
      ended: false,
      secrets: mcpHeaderSecrets(opts.mcpServers),
      placeholders,
      model: opts.model,
      effort,
      contextWindow: opts.contextWindow,
      models: undefined,
      costSoFar: opts.resume ? this.#costTotals.get(opts.resume.vendorSessionId) : 0,
      call: undefined,
      contextMax: undefined,
      contextMaxModel: undefined,
      contextUsed: undefined,
      mcpConfigPath,
      loop: Promise.resolve(),
    };
    this.#sessions.set(id, s);
    this.#setState(s, 'idle');
    s.loop = this.#read(s);
    if (effort !== undefined) {
      try {
        await this.#checkEffort(s, s.model, effort);
      } catch (err) {
        await this.close(handle);
        // Refused before its first turn: its handle is never returned, so nothing resumes it.
        unmake();
        throw err;
      }
    }
    return handle;
  }

  async send(h: SessionHandle, input: UserInput, opts?: SendOptions): Promise<void> {
    const s = this.#live(h);
    const effort = opts?.effort === undefined ? s.effort : effortLevel(opts.effort);
    const model = opts?.model || s.model;
    // The SDK silently drops (or lowers) an effort the model lacks, so check before switching.
    if (effort !== undefined && (effort !== s.effort || model !== s.model)) {
      await this.#checkEffort(s, model, effort);
    }
    // The 1M beta stays on the session's requests, so a new model must take it too.
    if (opts?.model && s.contextWindow === CONTEXT_1M) check1m(opts.model);
    // Effort first, so a failed model switch can be rolled back to the previous state.
    const effortChanged = effort !== undefined && effort !== s.effort;
    if (effortChanged) await s.q.applyFlagSettings({ effortLevel: effort });
    if (opts?.model) {
      try {
        await s.q.setModel(opts.model);
      } catch (err) {
        if (effortChanged) {
          await s.q.applyFlagSettings({ effortLevel: s.effort ?? null }).catch(() => {});
        }
        throw err;
      }
      s.model = opts.model;
    }
    if (effortChanged) s.effort = effort;
    const uuid = randomUUID();
    s.pending.set(uuid, input.text);
    s.inbox.push({
      type: 'user',
      message: { role: 'user', content: input.text },
      parent_tool_use_id: null,
      uuid,
    } as SDKUserMessage);
    if (s.state !== 'running') {
      s.interrupting = false;
      this.#setState(s, 'running');
    }
  }

  async interrupt(h: SessionHandle): Promise<InterruptResult> {
    const s = this.#live(h);
    if (s.state === 'running') s.interrupting = true;
    const receipt = await s.q.interrupt();
    // The turn may have ended before the interrupt landed; then no result will consume the flag.
    if (s.state !== 'running') s.interrupting = false;
    const stillQueued = (receipt?.still_queued ?? [])
      .map((uuid) => s.pending.get(uuid))
      .filter((t): t is string => t !== undefined);
    return { stillQueued };
  }

  async respond(h: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void> {
    const s = this.#live(h);
    const pending = s.approvals.get(requestId);
    if (!pending) throw new Error(`no pending approval ${requestId}`);
    s.approvals.delete(requestId);
    pending.resolve(toPermissionResult(decision, pending.suggestions));
    if (decision.kind === 'cancel') s.interrupting = true;
  }

  async close(h: SessionHandle): Promise<void> {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) return;
    s.closing = true;
    for (const p of s.approvals.values()) p.resolve(deny('session closed', true));
    s.approvals.clear();
    s.inbox.end();
    try {
      s.q.close();
      await s.loop;
    } finally {
      if (s.mcpConfigPath) removeMcpConfig(s.mcpConfigPath);
      if (s.placeholders) removeSandboxResidue(s.placeholders);
      this.#setState(s, 'done');
      s.events.end();
      this.#sessions.delete(h.id);
    }
  }

  /**
   * The closed session `vendorSessionId` will never be resumed (#153, #237): remove its config
   * directory under Tacet's state dir, its transcript included. Only on the API-key route, where
   * Tacet made that directory; never the user's own `~/.claude`. Refused while that session is
   * open.
   */
  async discard(vendorSessionId: string, cwd: string): Promise<void> {
    if (!this.#ownConfigDirs) return;
    if (!UUID.test(vendorSessionId)) throw new Error('a Claude session is named by its UUID');
    if (this.#liveIds().has(vendorSessionId)) {
      throw new Error(`Claude session ${vendorSessionId} is still open`);
    }
    removeClaudeConfigDir(this.#configRoot(cwd), vendorSessionId);
  }

  events(h: SessionHandle): AsyncIterable<AgentEvent> {
    return this.#session(h).events;
  }

  status(h: SessionHandle): SessionState {
    return this.#sessions.get(h.id)?.state ?? 'done';
  }

  /** Sessions on the API-key route get a config dir of their own (#237). */
  get #ownConfigDirs(): boolean {
    return (this.#opts.authRoute ?? 'api_key') === 'api_key';
  }

  /** `<repo state dir>/claude-sdk`: keyed by the user's HOME, never a session's environment. */
  #configRoot(cwd: string): string {
    const home = (this.#opts.baseEnv ?? process.env).HOME ?? homedir();
    return join(
      repoStateDir(
        this.#opts.repoRoot ?? repoOf(cwd),
        this.#opts.stateDir ?? defaultStateDir(home),
      ),
      'claude-sdk',
    );
  }

  /** Vendor ids of the sessions open in this adapter. */
  #liveIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.#sessions.values()) {
      if (s.handle.vendorSessionId !== undefined) ids.add(s.handle.vendorSessionId);
    }
    return ids;
  }

  /** Once per root: remove the config dirs untouched for the retention, never a live one. */
  #sweep(root: string, claimed: string | undefined): void {
    if (this.#sweptRoots.has(root)) return;
    this.#sweptRoots.add(root);
    try {
      const keep = this.#liveIds();
      if (claimed !== undefined) keep.add(claimed);
      sweepClaudeConfigDirs(root, (this.#opts.retentionDays ?? 30) * 24 * 60 * 60 * 1000, keep);
    } catch {
      // Tried again by the next adapter that starts; the directories are only kept longer.
    }
  }

  /** Refuse an effort level the model does not list, rather than let the SDK drop or lower it. */
  async #checkEffort(s: Session, model: string | undefined, effort: EffortLevel): Promise<void> {
    s.models ??= s.q.supportedModels();
    const models = await s.models;
    const name = model ?? 'default';
    const info =
      models.find((m) => m.value === name) ?? models.find((m) => m.resolvedModel === name);
    if (!info) {
      throw new ProfileRefusedError('effort', `cannot confirm effort support for ${name}`);
    }
    if (!info.supportsEffort || !info.supportedEffortLevels?.includes(effort)) {
      throw new ProfileRefusedError('effort', `${name} does not support effort ${effort}`);
    }
  }

  #session(h: SessionHandle): Session {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) throw new Error(`unknown or closed session ${h.id}`);
    return s;
  }

  /** A session whose process is still running. */
  #live(h: SessionHandle): Session {
    const s = this.#session(h);
    if (s.ended) throw new Error(`session ${h.id} has ended (${s.state})`);
    return s;
  }

  /**
   * Every event leaves through here: known key formats and this session's secrets are scrubbed.
   * Message text is scrubbed across delta boundaries too (#109): a tail that could still be the
   * start of a secret is held back, and goes out before the next event of any other kind.
   */
  #emit(s: Session, e: AgentEvent): void {
    s.deltas ??= new DeltaScrubber(s.secrets);
    for (const out of scrubbedEvents(s.deltas, s.secrets, e)) s.events.push(out);
  }

  #setState(s: Session, state: SessionState, message?: string): void {
    s.state = state;
    this.#emit(s, { t: 'status', state, ...(message !== undefined ? { message } : {}) });
  }

  #askApproval(
    s: Session,
    toolName: string,
    input: Record<string, unknown>,
    ctx: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (s.closing) return Promise.resolve(deny('session closed', true));
    const id = `approval-${randomUUID()}`;
    return new Promise<PermissionResult>((resolve) => {
      s.approvals.set(id, { resolve, suggestions: ctx.suggestions });
      ctx.signal.addEventListener(
        'abort',
        () => {
          if (s.approvals.delete(id)) resolve(deny('aborted', true));
        },
        { once: true },
      );
      this.#emit(s, {
        t: 'approval.request',
        id,
        summary: ctx.title ?? `Claude wants to use ${toolName}`,
        toolName,
        options: ['allow_once', 'allow_always', 'reject', 'cancel'],
        requestedGrant: { input, suggestions: ctx.suggestions ?? [] },
      });
    });
  }

  async #read(s: Session): Promise<void> {
    try {
      for await (const m of s.q) await this.#onMessage(s, m);
      if (!s.closing) this.#setState(s, 'done');
    } catch (err) {
      if (!s.closing) this.#setState(s, 'error', errorMessage(err));
    } finally {
      s.ended = true;
      for (const p of s.approvals.values()) p.resolve(deny('session ended', true));
      s.approvals.clear();
      if (!s.closing) {
        if (s.mcpConfigPath) removeMcpConfig(s.mcpConfigPath);
        s.events.end();
      }
    }
  }

  async #onMessage(s: Session, m: SDKMessage): Promise<void> {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          s.handle.vendorSessionId = m.session_id;
          s.model = m.model;
        }
        return;
      case 'stream_event': {
        // Top level only: subagent output and usage arrive through their tool results and the
        // turn's cost (`result.usage` also excludes subagents).
        if (m.parent_tool_use_id !== null) return;
        const ev = m.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.#emit(s, { t: 'message.delta', text: ev.delta.text });
        } else if (ev.type === 'message_start') {
          const u = ev.message.usage;
          s.call = {
            inputTokens:
              u.input_tokens +
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0),
            model: ev.message.model || s.model,
          };
        } else if (ev.type === 'message_delta' && s.call) {
          await this.#onCallEnd(s, s.call, ev.usage.output_tokens);
        }
        return;
      }
      case 'assistant':
        for (const b of m.message.content) {
          if (b.type === 'tool_use') {
            this.#emit(s, {
              t: 'tool.call',
              id: b.id,
              name: b.name,
              input: b.input,
            });
          }
        }
        return;
      case 'user': {
        const content = m.message.content;
        if (typeof content === 'string') return;
        for (const b of content) {
          if (b.type === 'tool_result') {
            this.#emit(s, { t: 'tool.result', id: b.tool_use_id, ok: b.is_error !== true });
          }
        }
        return;
      }
      case 'result':
        this.#onResult(s, m);
        return;
      default:
        return;
    }
  }

  /** One top-level model call finished: emit its tokens, model and the context gauge. */
  async #onCallEnd(
    s: Session,
    call: NonNullable<Session['call']>,
    outputTokens: number,
  ): Promise<void> {
    s.call = undefined;
    s.contextUsed = call.inputTokens + outputTokens;
    if (s.contextMax === undefined || s.contextMaxModel !== call.model) {
      // The window depends on the model; ask once per model. `summary` makes no API calls.
      const ctx = await s.q.getContextUsage({ detail: 'summary' }).catch(() => undefined);
      if (ctx) {
        s.contextMax = ctx.maxTokens;
        s.contextMaxModel = call.model;
      }
    }
    this.#emit(s, {
      t: 'usage',
      inputTokens: call.inputTokens,
      outputTokens,
      ...this.#contextFields(s),
      ...(call.model ? { model: call.model } : {}),
      source: 'reported',
    });
  }

  #contextFields(s: Session): { contextUsed?: number; contextMax?: number } {
    return s.contextUsed !== undefined && s.contextMax !== undefined
      ? { contextUsed: s.contextUsed, contextMax: s.contextMax }
      : {};
  }

  #onResult(s: Session, m: Extract<SDKMessage, { type: 'result' }>): void {
    const answered = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
    if (answered.length > 0) for (const u of answered) s.pending.delete(u);
    else {
      // Older CLIs do not say which input a result answers; assume the oldest.
      const first = s.pending.keys().next();
      if (!first.done) s.pending.delete(first.value);
    }

    // Round to nano-dollars so float subtraction noise does not reach the ledger.
    const cost =
      s.costSoFar === undefined
        ? undefined
        : Math.round(Math.max(0, m.total_cost_usd - s.costSoFar) * 1e9) / 1e9;
    s.costSoFar = Math.max(s.costSoFar ?? 0, m.total_cost_usd);
    if (s.handle.vendorSessionId) {
      // Re-insert so the map stays in recency order, and keep it bounded.
      this.#costTotals.delete(s.handle.vendorSessionId);
      this.#costTotals.set(s.handle.vendorSessionId, s.costSoFar);
      if (this.#costTotals.size > COST_TOTALS_MAX) {
        const oldest = this.#costTotals.keys().next();
        if (!oldest.done) this.#costTotals.delete(oldest.value);
      }
    }
    // Tokens were reported per model call; this event carries the turn's cost only, so the
    // ledger never counts tokens twice. No awaits here: the turn's end state is decided on the
    // same tick as its result, so a late interrupt() cannot relabel it.
    if (cost !== undefined) {
      this.#emit(s, {
        t: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: cost,
        ...this.#contextFields(s),
        ...(s.model ? { model: s.model } : {}),
        source: 'estimated',
      });
    }

    if (s.interrupting) {
      s.interrupting = false;
      this.#setState(s, 'cancelled');
    } else if (m.subtype === 'success' && !m.is_error) {
      this.#setState(s, 'idle');
    } else {
      this.#setState(s, 'error', m.subtype === 'success' ? 'turn failed' : m.subtype);
    }
    // Inputs sent during the turn run next.
    if (s.pending.size > 0) this.#setState(s, 'running');
  }
}

/** Refuse the 1M window for models the SDK does not document it for. */
function check1m(model: string | undefined): void {
  if (!model || !CONTEXT_1M_MODELS.test(model)) {
    throw new ProfileRefusedError(
      'contextWindow',
      `the 1M-token window is documented for Sonnet 4 and 4.5 only, not ${model ?? 'the default model'}`,
    );
  }
}

/** A Tacet effort name as the SDK's level, or a refusal for names Claude does not have. */
function effortLevel(effort: string): EffortLevel {
  if (!EFFORT_LEVELS.includes(effort)) {
    throw new ProfileRefusedError('effort', `Claude has no effort level ${effort}`);
  }
  return effort as EffortLevel;
}

function deny(message: string, interrupt = false): PermissionResult {
  return { behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}) };
}

/**
 * Map a Tacet decision to the SDK's permission result. `allow_always` applies the SDK's
 * suggested rules to this session only, unless `persist` asks for them to be kept as the SDK
 * suggested (which may write Claude Code settings files).
 */
export function toPermissionResult(
  d: ApprovalDecision,
  suggestions: PermissionUpdate[] | undefined,
): PermissionResult {
  const updatedInput =
    d.updatedInput !== undefined && typeof d.updatedInput === 'object' && d.updatedInput !== null
      ? { updatedInput: d.updatedInput as Record<string, unknown> }
      : {};
  switch (d.kind) {
    case 'allow_once':
      return { behavior: 'allow', ...updatedInput };
    case 'allow_always': {
      const rules = (suggestions ?? []).map((u) =>
        d.persist ? u : { ...u, destination: 'session' as const },
      );
      return {
        behavior: 'allow',
        ...updatedInput,
        ...(rules.length > 0 ? { updatedPermissions: rules } : {}),
      };
    }
    case 'cancel':
      return deny(d.message ?? 'cancelled by the user', true);
    default:
      return deny(d.message ?? 'rejected by the user');
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
