import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { TacetConfig } from '@tacet/core';
import type { Io } from '../io.js';
import { safeJson, terminalSafe } from '../render.js';
import { repoRootFrom } from '../state.js';

// The symlink-safe file checks, `wx` writes, PATH detection and the uninstall backup layout are
// adapted from Copilot's draft for #20 (PR #113).

/**
 * Worker adapters `tacet init` can set up, with what each needs. `claude-sdk` and
 * `codex-app-server` ship with Tacet (their vendor binaries are npm dependencies) and choose a
 * model per session; ACP agents are launched from the user's PATH and their command fixes the
 * model. Key variables are the ones each adapter reads on the API-key route (capability matrix).
 */
export const WORKER_ADAPTERS = {
  'claude-sdk': {
    bundled: true,
    needsModel: true,
    keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  },
  'codex-app-server': {
    bundled: true,
    needsModel: true,
    keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  },
  'acp:gemini': { bundled: false, command: 'gemini', needsModel: false, keys: ['GEMINI_API_KEY'] },
  'acp:claude-acp': {
    bundled: false,
    command: 'claude-agent-acp',
    needsModel: false,
    keys: ['ANTHROPIC_API_KEY'],
  },
} as const satisfies Record<
  string,
  { bundled: boolean; command?: string; needsModel: boolean; keys: readonly string[] }
>;
export type WorkerAdapterId = keyof typeof WORKER_ADAPTERS;

/**
 * Agent CLIs looked for on PATH, for the report; each command name is the one the adapters and
 * the capability matrix use. Their logins are never read.
 */
const AGENT_CLIS = ['claude', 'codex', 'gemini', 'opencode', 'claude-agent-acp'] as const;

/** First line of every file `tacet init` writes; the hash is of the lines after it. */
const header = (hash: string) => `# Written by tacet init (sha256 ${hash}); edit freely.`;
const HEADER_LINE = /^# Written by tacet init \(sha256 ([0-9a-f]{16})\); edit freely\.$/;

export interface InitOptions {
  repo?: string;
  'user-dir'?: string;
  worker?: string;
  model?: string;
  json?: boolean;
}

export interface UninstallOptions {
  repo?: string;
  'user-dir'?: string;
  apply?: boolean;
  purge?: boolean;
  json?: boolean;
}

class InitError extends Error {
  override name = 'InitError';
}

/**
 * `tacet init` (#20): scaffold `.tacet/` in a git repo. It writes `.tacet/tacet.yaml` and
 * `.tacet/.gitignore` (which ignores `local.yaml`) only when they are absent, so a re-run changes
 * nothing; it never writes outside `.tacet/`, so the repo's own agent files (CLAUDE.md, AGENTS.md,
 * `.claude/`) and `.gitignore` are left as they are. It reports which Worker adapters can run
 * here and which key variables are set (names only; values and vendor logins are never read).
 */
export async function init(io: Io, o: InitOptions): Promise<number> {
  const env = io.env ?? process.env;
  const worker = (o.worker ?? 'claude-sdk') as WorkerAdapterId;
  const spec = WORKER_ADAPTERS[worker];
  if (spec === undefined) {
    io.err(
      `--worker: unknown adapter ${terminalSafe(String(o.worker))}; one of ${Object.keys(WORKER_ADAPTERS).join(', ')}`,
    );
    return 2;
  }
  let model = o.model?.trim();
  if (model === '') {
    io.err('--model needs a model name');
    return 2;
  }
  if (model !== undefined && !spec.needsModel) {
    io.err(`--model: ${worker} cannot choose a model (its command fixes it)`);
    return 2;
  }

  try {
    const root = repoFor(io, o);
    const tacetDir = join(root, '.tacet');
    const configPath = join(tacetDir, 'tacet.yaml');
    const dirExists = pathExists(tacetDir);
    if (dirExists) requireDirectory(tacetDir, '.tacet');
    const configExists = dirExists && pathExists(configPath);
    if (configExists) requireRegularFile(configPath, '.tacet/tacet.yaml');

    if (!configExists && model === undefined && spec.needsModel && io.prompt && !o.json) {
      const answer = await io.prompt(
        `Model for ${worker} Workers (as the vendor names it; Enter to set it later): `,
      );
      if (answer?.trim()) model = answer.trim();
    }
    // Validated before anything is created, so a bad model leaves nothing behind.
    const body = configExists ? undefined : configBody(worker, model, root);
    if (!dirExists) mkdirSync(tacetDir);
    const config = body === undefined ? 'kept' : writeOnce(configPath, body);
    const ignore = writeOnce(join(tacetDir, '.gitignore'), IGNORE_BODY);
    const flagsIgnored = config === 'kept' && (o.worker !== undefined || o.model !== undefined);

    const path = env.PATH ?? '';
    const adapters = Object.entries(WORKER_ADAPTERS).map(([id, a]) => ({
      id,
      available: a.bundled || ('command' in a && onPath(a.command, path)),
      keys: a.keys.map((name) => ({ name, set: Boolean(env[name]) })),
    }));
    const clis = AGENT_CLIS.map((command) => ({ command, onPath: onPath(command, path) }));
    const modelMissing = config === 'written' && spec.needsModel && model === undefined;
    const workerKeySet = spec.keys.some((k) => Boolean(env[k]));

    if (flagsIgnored) {
      io.err('note: --worker and --model are ignored: .tacet/tacet.yaml already exists (edit it)');
    }
    if (o.json) {
      io.out(
        safeJson({
          repo: root,
          files: { '.tacet/tacet.yaml': config, '.tacet/.gitignore': ignore },
          worker,
          modelMissing,
          adapters,
          clis,
        }),
      );
      return 0;
    }
    io.out(`${terminalSafe(root)}`);
    io.out(`  .tacet/tacet.yaml   ${config === 'written' ? 'written' : 'kept (already there)'}`);
    io.out(`  .tacet/.gitignore   ${ignore === 'written' ? 'written' : 'kept (already there)'}`);
    io.out('Worker adapters:');
    for (const a of adapters) {
      const keys = a.keys.map((k) => `${k.name} ${k.set ? 'set' : 'not set'}`).join(', ');
      io.out(`  ${a.id.padEnd(18)} ${a.available ? 'available' : 'not on PATH'}; ${keys}`);
    }
    io.out(
      `Agent CLIs on PATH: ${
        clis
          .filter((c) => c.onPath)
          .map((c) => c.command)
          .join(', ') || 'none'
      } (logins are not checked)`,
    );
    if (config === 'written') io.out(`Workers run on ${worker}.`);
    if (modelMissing) {
      io.err(`next: set tiers.worker.model in .tacet/tacet.yaml; ${worker} needs a model`);
    }
    if (!workerKeySet && config === 'written') {
      const cloud =
        worker === 'claude-sdk' ? ', or a cloud provider (Bedrock, Vertex, Foundry)' : '';
      io.err(`next: set ${spec.keys.join(' or ')}${cloud}: unattended Workers run on your API key`);
    }
    io.err('then: tacet run "<task>"');
    return 0;
  } catch (err) {
    return failed(io, err);
  }
}

/**
 * `tacet uninstall` (#20). A preview by default; `--apply` acts. Without `--purge` it removes only
 * the files `tacet init` wrote that are still unchanged, then `.tacet/` if that leaves it empty.
 * `--purge` removes the whole `.tacet/` after copying it to
 * `<user dir>/backups/<repo>-<hash>/uninstall-<time>/`. Run state outside the repo is not touched.
 */
export function uninstall(io: Io, o: UninstallOptions): number {
  let backup: string | undefined;
  try {
    const root = repoFor(io, o);
    const tacetDir = join(root, '.tacet');
    const removals: string[] = [];
    const kept: string[] = [];
    if (pathExists(tacetDir)) {
      requireDirectory(tacetDir, '.tacet');
      if (o.purge) {
        removals.push(tacetDir);
        const canonical = realpathSync(root);
        backup = join(
          userDirOf(io, o),
          'backups',
          `${basename(canonical)}-${sha256(canonical).slice(0, 12)}`,
          `uninstall-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
        );
      } else {
        for (const name of readdirSync(tacetDir).sort()) {
          const path = join(tacetDir, name);
          (isUnchangedInitFile(path) ? removals : kept).push(path);
        }
        if (kept.length === 0) removals.push(tacetDir);
      }
    }

    if (o.apply && removals.length > 0) {
      if (backup !== undefined) {
        mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
        mkdirSync(backup, { mode: 0o700 });
        try {
          cpSync(tacetDir, join(backup, '.tacet'), {
            recursive: true,
            errorOnExist: true,
            force: false,
            verbatimSymlinks: true,
          });
        } catch (err) {
          rmSync(backup, { recursive: true, force: true });
          backup = undefined;
          throw err;
        }
        rmSync(tacetDir, { recursive: true });
      } else {
        for (const path of removals) {
          if (path === tacetDir) rmdirSync(path);
          else rmSync(path);
        }
      }
    }

    if (o.json) {
      io.out(
        safeJson({
          repo: root,
          applied: Boolean(o.apply),
          removals,
          kept,
          ...(backup ? { backup } : {}),
        }),
      );
      return 0;
    }
    if (removals.length === 0) io.out('nothing to remove');
    for (const path of removals)
      io.out(`${o.apply ? 'removed' : 'would remove'} ${terminalSafe(path)}`);
    for (const path of kept)
      io.out(`kept ${terminalSafe(path)} (not written by tacet init, or changed)`);
    if (backup) io.out(`${o.apply ? 'backed up to' : 'would back up to'} ${terminalSafe(backup)}`);
    if (!o.apply && removals.length > 0) io.err('preview only: add --apply to remove');
    if (kept.length > 0 && !o.purge) io.err('--purge removes all of .tacet/ (after a backup)');
    return 0;
  } catch (err) {
    const code = failed(io, err);
    if (backup !== undefined && o.apply) io.err(`the backup is at ${terminalSafe(backup)}`);
    return code;
  }
}

/** Prints a failure without a stack trace; exit code 1. */
function failed(io: Io, err: unknown): number {
  io.err(terminalSafe(err instanceof Error ? err.message : String(err)));
  return 1;
}

function userDirOf(io: Io, o: { 'user-dir'?: string }): string {
  return resolve(o['user-dir'] ?? join(io.home ?? homedir(), '.tacet'));
}

/**
 * The git repo `.tacet/` belongs to. Refused when the repo's `.tacet/` would be Tacet's own user
 * directory (a home directory kept in git, say), which holds the user config, run state and
 * backups: init would write into it and a purge would delete it.
 */
function repoFor(io: Io, o: { repo?: string; 'user-dir'?: string }): string {
  const root = repoRootFrom(o.repo ?? io.cwd);
  if (!existsSync(join(root, '.git'))) {
    throw new InitError(`${root} is not in a git repository: Tacet works on a git repo`);
  }
  const tacetDir = canonical(join(root, '.tacet'));
  for (const user of new Set([userDirOf(io, {}), userDirOf(io, o)])) {
    const u = canonical(user);
    if (u === tacetDir || u.startsWith(`${tacetDir}${sep}`) || tacetDir.startsWith(`${u}${sep}`)) {
      throw new InitError(
        `${join(root, '.tacet')} is, or overlaps, Tacet's user directory ${user}: run this in a project repo, not in your home directory`,
      );
    }
  }
  return root;
}

/** `path` with symbolic links resolved, as far as it exists. */
function canonical(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const up = dirname(abs);
    return up === abs ? abs : join(canonical(up), basename(abs));
  }
}

const IGNORE_BODY =
  '# Personal settings (see docs/ARCHITECTURE.md §4); never commit them.\nlocal.yaml\n';

/** The repo layer `tacet init` writes; checked against the config schema before it is written. */
export function configBody(
  worker: WorkerAdapterId,
  model: string | undefined,
  root: string,
): string {
  const spec = WORKER_ADAPTERS[worker];
  const tier: Record<string, string> = {
    adapter: worker,
    ...(model !== undefined ? { model } : {}),
  };
  const parsed = TacetConfig.safeParse({ tiers: { worker: tier } });
  if (!parsed.success) throw new InitError(`invalid --model: ${parsed.error.issues[0]?.message}`);
  const verify = suggestedVerify(root);
  const lines = [
    '# Repo config for Tacet (docs/ARCHITECTURE.md §4). Personal overrides go in local.yaml.',
    'tiers:',
    '  worker:',
    `    adapter: ${worker}`,
  ];
  if (model !== undefined) lines.push(`    model: ${JSON.stringify(model)}`);
  else if (spec.needsModel)
    lines.push(`    # model: set the model ${worker} Workers run (required)`);
  lines.push(
    '  # A planner that splits tasks into sub-tasks; without it each task is one sub-task.',
    '  # mini:',
    `  #   adapter: ${worker}`,
    ...(spec.needsModel ? ['  #   model: <a model>'] : []),
    '',
    '# A reviewer on another vendor checks each sub-task once verify passes; off by default.',
    '# review:',
    '#   enabled: true',
    '# (with tiers.review: { adapter: <an adapter of another vendor>, model: <a model> })',
    '',
    '# Commands that check each finished sub-task in its checkout, with /bin/sh -c. A Worker',
    '# checkout is a fresh git worktree: install dependencies first if a command needs them.',
    '# verify:',
    ...(verify.length > 0 ? verify.map((c) => `#   - ${c}`) : ['#   - <command>']),
    '',
  );
  return lines.join('\n');
}

/** Suggested verify commands from package.json scripts; only suggested, never switched on. */
function suggestedVerify(root: string): string[] {
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    if (pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null) scripts = pkg.scripts;
  } catch {
    return [];
  }
  const pm = existsSync(join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : 'npm run';
  const names = ['lint', 'typecheck', 'test'].filter((n) => typeof scripts[n] === 'string');
  return names.map((n) => `${pm} ${n}`);
}

function withHeader(body: string): string {
  return `${header(sha256(body).slice(0, 16))}\n${body}`;
}

/** Writes `path` only when it does not exist. */
function writeOnce(path: string, body: string): 'written' | 'kept' {
  try {
    writeFileSync(path, withHeader(body), { flag: 'wx', mode: 0o644 });
    return 'written';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    requireRegularFile(path, basename(path));
    return 'kept';
  }
}

/** A regular file whose first line is init's header and whose body still matches its hash. */
function isUnchangedInitFile(path: string): boolean {
  const stat = lstatSync(path);
  if (!stat.isFile()) return false;
  const text = readFileSync(path, 'utf8');
  const nl = text.indexOf('\n');
  if (nl < 0) return false;
  const m = HEADER_LINE.exec(text.slice(0, nl));
  return m !== null && sha256(text.slice(nl + 1)).slice(0, 16) === m[1];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function requireDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new InitError(`${label} must be a directory, not a file or symbolic link: ${path}`);
  }
}

function requireRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new InitError(
      `${label} must be a regular file (not a directory or symbolic link): ${path}`,
    );
  }
}

function onPath(command: string, path: string): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        const p = join(dir, command);
        if (!statSync(p).isFile()) return false;
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}
