import { parseArgs } from 'node:util';
import { formatExplain } from '@tacet/core';
import { ConfigError, loadConfig } from '@tacet/core/node';
import { initRepo, uninstallRepo } from './repo.js';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  path?: string;
  homeDir?: string;
}

const USAGE = `usage: tacet <command>

Commands:
  init [--repo DIR]                       Scaffold repo config and detect agent CLIs
  uninstall [--repo DIR] [--apply] [--purge] Preview or remove repo-local Tacet files
  config explain [--repo DIR] [--user-dir DIR] [--json]

Run "tacet config explain" to show the effective configuration and its sources.`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initCommand(args: string[], io: Io): number {
  try {
    const { values } = parseArgs({
      args,
      options: { repo: { type: 'string' } },
      strict: true,
    });
    const result = initRepo(values.repo ?? io.cwd, io.path ? { path: io.path } : {});
    io.out(
      result.configCreated ? 'Created .tacet/tacet.yaml.' : 'Kept existing .tacet/tacet.yaml.',
    );
    io.out(
      result.gitignoreUpdated
        ? 'Added .tacet/local.yaml to .gitignore.'
        : '.gitignore already ignores .tacet/local.yaml.',
    );
    const agents = result.agents.filter((agent) => agent.installed);
    io.out(
      agents.length > 0
        ? `Available agent CLIs:\n${agents
            .map((agent) => `  ${agent.command}: login status unknown`)
            .join('\n')}`
        : 'No supported agent CLIs found on PATH.',
    );
    io.out(
      'Login status is not verified; Tacet does not inspect vendor login stores or credentials.',
    );
    return 0;
  } catch (error) {
    io.err(errorMessage(error));
    return 1;
  }
}

function uninstallCommand(args: string[], io: Io): number {
  try {
    const { values } = parseArgs({
      args,
      options: {
        repo: { type: 'string' },
        apply: { type: 'boolean' },
        purge: { type: 'boolean' },
      },
      strict: true,
    });
    const result = uninstallRepo({
      repoRoot: values.repo ?? io.cwd,
      ...(values.apply ? { apply: true } : {}),
      ...(values.purge ? { purge: true } : {}),
      ...(io.homeDir ? { homeDir: io.homeDir } : {}),
    });
    if (result.removals.length === 0) {
      io.out('Nothing safe to remove. Customized config and user files are preserved.');
      return 0;
    }
    io.out(`${result.applied ? 'Removed' : 'Would remove'}:`);
    for (const path of result.removals) io.out(`  ${path}`);
    if (result.backupPath)
      io.out(`Backup ${result.applied ? 'created' : 'will be created'} at: ${result.backupPath}`);
    if (result.applied) io.out('.gitignore is unchanged; its ignore rule may be user-owned.');
    else io.out(`Preview only. Re-run with --apply${values.purge ? ' --purge' : ''} to proceed.`);
    return 0;
  } catch (error) {
    io.err(errorMessage(error));
    return 1;
  }
}

/** Entry point for the `tacet` command. Returns the process exit code. */
export function main(argv: string[], io: Io): number {
  const [group, command, ...rest] = argv;
  if (group === 'init') return initCommand(argv.slice(1), io);
  if (group === 'uninstall') return uninstallCommand(argv.slice(1), io);
  if (group !== 'config' || command !== 'explain') {
    io.err(USAGE);
    return group === undefined || group === '--help' || group === '-h' ? 0 : 2;
  }
  let values: { repo?: string; 'user-dir'?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'user-dir': { type: 'string' },
        json: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (err) {
    io.err(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  try {
    const effective = loadConfig({
      repoRoot: values.repo ?? io.cwd,
      ...(values['user-dir'] ? { userDir: values['user-dir'] } : {}),
    });
    io.out(values.json ? JSON.stringify(effective.explain, null, 2) : formatExplain(effective));
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}
