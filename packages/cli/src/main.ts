import { parseArgs } from 'node:util';
import { formatExplain } from '@tacet/core';
import { ConfigError, loadConfig, StateDirError } from '@tacet/core/node';
import { answer } from './commands/answer.js';
import { cancel } from './commands/cancel.js';
import { detach } from './commands/detach.js';
import { init, uninstall } from './commands/init.js';
import { attach, logs, status } from './commands/read.js';
import { run } from './commands/run.js';
import type { Io } from './io.js';

export type { Io };

const USAGE = `usage:
  tacet init [--worker ADAPTER] [--model MODEL] [--keep-merged-worktrees] [--json]
                                 set up .tacet/ in this repo (never overwrites a file); Worker
                                 checkouts are removed once their work is merged, unless kept
  tacet uninstall [--apply] [--purge [--force]] [--json]
                                 preview, then remove what init wrote (--purge: all of .tacet/,
                                 after a backup to ~/.tacet/backups, and the repo's run state:
                                 event log and Worker checkouts; --force: even checkouts holding
                                 unintegrated work; tacet/* branches are kept)
  tacet run [--accept TEXT]... [--single] [--json] "<task>"
                                 run a task in this repo until it is done (standalone)
  tacet run --resume [--answer ID=TEXT]...
                                 carry on with unfinished tasks, answering escalations
  tacet run --detach [...]       the same in the background, until its tasks are done; it waits
                                 for answers (tacet answer) instead of stopping, and logs to
                                 ~/.tacet/run/minis/<repo>.log
  tacet cancel <task> [--json]   cancel a task and its sub-tasks (in the live run, if any)
  tacet answer <escalation> <text> [--json]
                                 answer an open escalation in the live run
  tacet status [--json]          tasks, sub-tasks, open escalations; whether a run is live
  tacet logs <task> [--transcript] [--json] [--follow]
                                 a task's events (--transcript adds the Workers' own)
  tacet attach <session | task/n> [--json]
                                 follow one Worker session as it runs
  tacet config explain [--json]  the effective configuration and where each value comes from

Every command takes --repo DIR (default: the repo of the current directory) and --user-dir DIR.
run exits 0 when the task completed, 1 when it failed, 3 when it waits for an answer.`;

const COMMON = {
  repo: { type: 'string' },
  'user-dir': { type: 'string' },
  json: { type: 'boolean' },
} as const;

const OPTIONS = {
  init: {
    ...COMMON,
    worker: { type: 'string' },
    model: { type: 'string' },
    'keep-merged-worktrees': { type: 'boolean' },
  },
  uninstall: {
    ...COMMON,
    apply: { type: 'boolean' },
    purge: { type: 'boolean' },
    force: { type: 'boolean' },
  },
  run: {
    ...COMMON,
    accept: { type: 'string', multiple: true },
    single: { type: 'boolean' },
    resume: { type: 'boolean' },
    answer: { type: 'string', multiple: true },
    detach: { type: 'boolean' },
    // Internal: the background run `--detach` starts (#201). Not in the usage text.
    'detached-child': { type: 'boolean' },
  },
  cancel: COMMON,
  answer: COMMON,
  status: COMMON,
  logs: { ...COMMON, transcript: { type: 'boolean' }, follow: { type: 'boolean', short: 'f' } },
  attach: COMMON,
  config: COMMON,
} as const;

/** Entry point for the `tacet` command. Resolves to the process exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.err(USAGE);
    return 0;
  }
  if (!(command in OPTIONS)) {
    io.err(USAGE);
    return 2;
  }
  let values: Record<string, string | boolean | string[] | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: rest,
      options: OPTIONS[command as keyof typeof OPTIONS],
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as typeof values;
    positionals = parsed.positionals;
  } catch (err) {
    io.err(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const v = values as never;
  try {
    switch (command) {
      case 'init':
        if (positionals.length > 0) return usage(io);
        return await init(io, v);
      case 'uninstall':
        if (positionals.length > 0) return usage(io);
        return await uninstall(io, v);
      case 'run':
        if (positionals.length > 0 && values.resume) {
          io.err('give a task or --resume, not both');
          return 2;
        }
        if (values.detach) {
          if (positionals.length === 0 && !values.resume) {
            io.err('tacet run needs a task, or --resume');
            return 2;
          }
          return await detach(
            io,
            rest.filter((a) => a !== '--detach'),
            v,
          );
        }
        return await run(io, positionals.length > 0 ? positionals.join(' ') : undefined, v);
      case 'cancel':
        if (positionals.length !== 1) return usage(io);
        return await cancel(io, positionals[0] as string, v);
      case 'answer':
        if (positionals.length < 2) return usage(io);
        return await answer(io, positionals[0] as string, positionals.slice(1).join(' '), v);
      case 'status':
        if (positionals.length > 0) return usage(io);
        return await status(io, v);
      case 'logs':
        if (positionals.length !== 1) return usage(io);
        return await logs(io, positionals[0] as string, v);
      case 'attach':
        if (positionals.length !== 1) return usage(io);
        return await attach(io, positionals[0] as string, v);
      default:
        if (positionals.length !== 1 || positionals[0] !== 'explain') return usage(io);
        return explain(io, v);
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof StateDirError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}

function usage(io: Io): number {
  io.err(USAGE);
  return 2;
}

function explain(io: Io, values: { repo?: string; 'user-dir'?: string; json?: boolean }): number {
  const effective = loadConfig({
    repoRoot: values.repo ?? io.cwd,
    ...(values['user-dir'] ? { userDir: values['user-dir'] } : {}),
  });
  io.out(values.json ? JSON.stringify(effective.explain, null, 2) : formatExplain(effective));
  return 0;
}
