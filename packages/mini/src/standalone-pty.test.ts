import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyCliAdapter } from '@tacet/adapter-pty';
import { gatedTitle, ptyGate } from '@tacet/adapter-pty/testing';
import type { SessionOptions } from '@tacet/core';
import { connectPty, readRuntimeFile } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Standalone, startStandalone } from './standalone.js';

// node-pty must load in CI; locally a machine that could not build it skips these (#189).
const gate = await ptyGate();

/**
 * A line-based CLI for a `pty:<slug>` Worker: at start it writes its argv and its whole
 * environment to the file named by its last argument, shows `dump> `, and once given a task
 * prints `working` lines until it is closed, so its session stays open while a test watches.
 */
const DUMP_CLI = `
const { writeFileSync } = require('node:fs');
const file = process.argv[process.argv.length - 1];
writeFileSync(file, JSON.stringify({ argv: process.argv, env: process.env }));
process.stdout.write('dump> ');
let n = 0;
process.stdin.on('data', () => {
  if (n > 0) return;
  setInterval(() => process.stdout.write('working ' + ++n + '\\r\\n'), 100);
});
`;

/**
 * A generic CLI in a real PTY. A `pty:<slug>` preset cannot take the Mini-conductor's MCP server
 * (only `pty:claude` can, and that needs Claude Code), so this one is started without it; the
 * process, its terminal and the environment the Mini-conductor gives it are the real ones. What a
 * Worker's MCP config carries is checked where the session options are (the control-port tests in
 * the CLI's standalone suite).
 */
class NoMcpPty extends PtyCliAdapter {
  // Says it takes the server it drops, so the Mini-conductor runs it at all (#184): a generic
  // CLI has neither MCP nor approval requests, and is refused as a Worker otherwise.
  override capabilities() {
    return { ...super.capabilities(), mcp: true };
  }
  override start(opts: SessionOptions) {
    const { mcpServers: _ignored, ...rest } = opts;
    return super.start(rest);
  }
}

/** The live terminal of a real PTY Worker over the control port (#201, ADR-003 §5). */
describe.skipIf(!gate.ok)(
  gatedTitle('standalone: a PTY Worker on the control port (#201)', gate),
  () => {
    let root: string;
    let repo: string;
    let env: Record<string, string>;
    let sa: Standalone | undefined;

    const git = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mini-pty-')));
      repo = join(root, 'repo');
      mkdirSync(join(root, 'home'));
      mkdirSync(join(repo, '.tacet'), { recursive: true });
      env = {
        PATH: process.env.PATH ?? '',
        HOME: join(root, 'home'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Tacet Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Tacet Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      };
      writeFileSync(join(root, 'dump-cli.cjs'), DUMP_CLI);
      git(['init', '-q', '-b', 'main']);
      writeFileSync(
        join(repo, '.tacet', 'tacet.yaml'),
        [
          'tiers:',
          '  worker: { adapter: "pty:dump" }',
          `events: { state_dir: ${JSON.stringify(join(root, 'state'))} }`,
          '',
        ].join('\n'),
      );
      git(['add', '.']);
      git(['commit', '-qm', 'init']);
    });
    afterEach(async () => {
      await sa?.close();
      sa = undefined;
      rmSync(root, { recursive: true, force: true });
    });

    it('shows the Worker its terminal live, and the control token reaches no Worker', {
      timeout: 60_000,
    }, async () => {
      sa = await startStandalone({
        repoRoot: repo,
        userDir: join(root, 'user'),
        home: join(root, 'home'),
        baseEnv: env,
        singleStep: true,
        adapters: {
          'pty:dump': {
            adapter: new NoMcpPty({
              slug: 'dump',
              preset: {
                command: [process.execPath, join(root, 'dump-cli.cjs'), join(root, 'dump.json')],
                readyPrompt: 'dump>',
              },
              baseEnv: env,
            }),
            authRoute: 'api_key',
          },
        },
      });
      const { port, token } = readRuntimeFile(sa.control.runtimeFile);
      const secret = token.reveal();
      const id = sa.mini.submit({ goal: 'watch me', acceptanceCriteria: ['ok'] });
      const session = await (async () => {
        for (let i = 0; i < 200; i++) {
          const started = sa?.store.query({ taskId: `${id}/1`, typePrefix: 'worker.started' });
          const s = (started?.at(-1)?.envelope.data as { sessionId?: string } | undefined)
            ?.sessionId;
          // Running here once its CLI is ready (the generator is lazy: this opens nothing).
          if (s && existsSync(join(root, 'dump.json')) && sa?.mini.terminalStream(s)) return s;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(
          `the Worker did not start: ${JSON.stringify(sa?.store.query({ typePrefix: 'worker.ended' }).map((e) => e.envelope.data))}`,
        );
      })();

      // The terminal, as `tacet attach` reads it: the screen so far, then what it prints.
      let seen = '';
      const pty = await connectPty({
        port,
        token,
        sessionId: session,
        onData: (b) => {
          seen += b.toString('utf8');
        },
      });
      for (let i = 0; i < 200 && !/working \d+[\s\S]*working \d+/.test(seen); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(seen).toContain('dump>');
      expect(seen).toMatch(/working \d+[\s\S]*working \d+/);
      // The viewer leaves (read only is the port's own test: a frame from it closes it 1003).
      pty.close();
      await pty.closed;

      // The Worker process got the control token nowhere: no argument, no variable, under
      // any name.
      const dump = JSON.parse(readFileSync(join(root, 'dump.json'), 'utf8')) as {
        argv: string[];
        env: Record<string, string>;
      };
      expect(dump.argv.length).toBeGreaterThan(1);
      expect(Object.keys(dump.env).length).toBeGreaterThan(0);
      // Where it turns up, by name only: a failure never prints the token itself.
      const holds = (v: unknown) => String(v).includes(secret);
      expect(dump.argv.flatMap((a, i) => (holds(a) ? [i] : []))).toEqual([]);
      expect(
        Object.entries(dump.env).flatMap(([k, v]) => (holds(k) || holds(v) ? [k] : [])),
      ).toEqual([]);
      // Nor this process's environment, which every child inherits from, nor the log.
      expect(Object.entries(process.env).flatMap(([k, v]) => (holds(v) ? [k] : []))).toEqual([]);
      expect(
        sa.store
          .query({})
          .filter((e) => holds(JSON.stringify(e.raw)))
          .map((e) => e.envelope.type),
      ).toEqual([]);
      expect(holds(seen)).toBe(false);
    });
  },
);
