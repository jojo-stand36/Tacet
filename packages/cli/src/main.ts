import { parseArgs } from 'node:util';
import { formatExplain } from '@tacet/core';
import { ConfigError, loadConfig } from '@tacet/core/node';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
}

const USAGE = `usage: tacet config explain [--repo DIR] [--user-dir DIR] [--json]

Shows the effective configuration and the layer (default, user, repo, local) and file that set
each value.`;

/** Entry point for the `tacet` command. Returns the process exit code. */
export function main(argv: string[], io: Io): number {
  const [group, command, ...rest] = argv;
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
