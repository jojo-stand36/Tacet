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
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
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

/** Agent CLIs looked for on PATH, for the report. Their logins are never read. */
const AGENT_CLIS = ['claude', 'codex', 'gemini', 'opencode', 'goose', 'claude-agent-acp'] as const;

/** First line of every file `tacet init` writes; the hash is of the lines after it. */
const HEADER = '# Written by tacet init';

export interface InitOptions {
  repo?: string;
  worker?: string;
  model?: string;
  json?: boolean;
}

export interface UninstallOptions {
  repo?: string;
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
  if (o.model !== undefined && !spec.needsModel) {
    io.err(`--model: ${worker} cannot choose a model (its command fixes it)`);
    return 2;
  }

  const root = repoRootFrom(o.repo ?? io.cwd);
  if (!existsSync(join(root, '.git'))) {
    io.err(`${terminalSafe(root)} is not in a git repository: Tacet works on a git repo`);
    return 1;
  }

  let model = o.model;
  const configPath = join(root, '.tacet', 'tacet.yaml');
  if (model === undefined && spec.needsModel && !pathExists(configPath) && io.prompt) {
    const answer = await io.prompt(
      `Model for ${worker} Workers (as the vendor names it; Enter to set it later): `,
    );
    if (answer?.trim()) model = answer.trim();
  }

  try {
    const tacetDir = join(root, '.tacet');
    if (pathExists(tacetDir)) requireDirectory(tacetDir, '.tacet');
    else mkdirSync(tacetDir);
    const config = writeOnce(configPath, configBody(worker, model, root));
    const ignore = writeOnce(join(tacetDir, '.gitignore'), IGNORE_BODY);

    const path = env.PATH ?? '';
    const adapters = Object.entries(WORKER_ADAPTERS).map(([id, a]) => ({
      id,
      available: a.bundled || ('command' in a && onPath(a.command, path)),
      keys: a.keys.map((name) => ({ name, set: Boolean(env[name]) })),
    }));
    const clis = AGENT_CLIS.map((command) => ({ command, onPath: onPath(command, path) }));
    const modelMissing = config === 'written' && spec.needsModel && model === undefined;
    const workerKeySet = spec.keys.some((k) => Boolean(env[k]));

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
      io.err(`next: set ${spec.keys.join(' or ')}: unattended Workers run on your API key`);
    }
    io.err('then: tacet run "<task>"');
    return 0;
  } catch (err) {
    if (err instanceof InitError) {
      io.err(terminalSafe(err.message));
      return 1;
    }
    throw err;
  }
}

/**
 * `tacet uninstall` (#20). A preview by default; `--apply` acts. Without `--purge` it removes only
 * the files `tacet init` wrote that are still unchanged, then `.tacet/` if that leaves it empty.
 * `--purge` removes the whole `.tacet/` after copying it to
 * `~/.tacet/backups/<repo>-<hash>/uninstall-<time>/`. Run state outside the repo is not touched.
 */
export function uninstall(io: Io, o: UninstallOptions): number {
  const root = repoRootFrom(o.repo ?? io.cwd);
  const tacetDir = join(root, '.tacet');
  try {
    const removals: string[] = [];
    const kept: string[] = [];
    let backup: string | undefined;
    if (pathExists(tacetDir)) {
      requireDirectory(tacetDir, '.tacet');
      if (o.purge) {
        removals.push(tacetDir);
        backup = join(
          io.home ?? homedir(),
          '.tacet',
          'backups',
          `${basename(root)}-${sha256(root).slice(0, 12)}`,
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
        mkdirSync(join(backup, '..'), { recursive: true, mode: 0o700 });
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
    if (err instanceof InitError) {
      io.err(terminalSafe(err.message));
      return 1;
    }
    throw err;
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
  const tier: Record<string, string> = { adapter: worker, ...(model ? { model } : {}) };
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
  return `${HEADER} (sha256 ${sha256(body).slice(0, 16)}); edit freely.\n${body}`;
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
  const m = /^# Written by tacet init \(sha256 ([0-9a-f]{16})\); edit freely\.$/.exec(
    text.slice(0, nl),
  );
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
    throw new InitError(`${label} must be a regular file, not a symbolic link: ${path}`);
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
