import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUlid } from '@tacet/core';
import {
  miniRuntimePath,
  openEventStore,
  readRuntimeFile,
  repoStatePaths,
  workerGitEnv,
  workerWorktree,
} from '@tacet/core/node';
import { type Script, ScriptedAdapter, ScriptedTerminalAdapter } from '@tacet/mini/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Io } from './io.js';
import { main } from './main.js';

/**
 * `tacet run / status / logs / attach` end to end (#21), with scripted Workers in real git
 * worktrees: everything but the vendor.
 */
describe('tacet standalone (#21)', () => {
  let root: string;
  let repo: string;
  let state: string;
  let env: Record<string, string>;

  const git = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
    execFileSync('git', ['-C', cwd, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    }).trim();

  /** The Worker: commits `work.txt` in its checkout, as a sandboxed Codex Worker would. */
  const commit = (cwd: string, text = 'work\n') => {
    const wt = workerWorktree(cwd, repo);
    if (!wt) throw new Error('not a worktree');
    writeFileSync(join(cwd, 'work.txt'), text);
    git(cwd, ['add', 'work.txt'], workerGitEnv(wt));
    git(cwd, ['commit', '-qm', 'work'], workerGitEnv(wt));
  };

  let script: (cwd: string, input: string) => Script | undefined;
  /** Every scripted adapter made, to check what the Workers were started with. */
  const made: ScriptedAdapter[] = [];
  const fake = () => {
    const a = new ScriptedAdapter(
      'claude-sdk',
      (input, s) => script(s.opts.cwd, input) ?? { do: 'reply', text: 'done' },
    );
    made.push(a);
    return a;
  };

  const tacet = async (argv: string[], more: Partial<Io> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      cwd: repo,
      env,
      home: join(root, 'home'),
      pollMs: 20,
      standalone: { adapters: { 'claude-sdk': { adapter: fake(), authRoute: 'api_key' } } },
      ...more,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const user = () => ['--user-dir', join(root, 'user')];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-cli-run-')));
    repo = join(root, 'repo');
    state = join(root, 'state');
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, 'user'));
    env = {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tacet Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Tacet Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    mkdirSync(join(repo, '.tacet'), { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(
      join(repo, '.tacet', 'tacet.yaml'),
      [
        'tiers:',
        '  worker: { adapter: claude-sdk, model: cheap }',
        `events: { state_dir: ${JSON.stringify(state)} }`,
        '',
      ].join('\n'),
    );
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'init']);
    script = (cwd) => {
      commit(cwd);
      return undefined;
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runs a task to a result branch, then status, logs and attach read it from the log', async () => {
    const r = await tacet(['run', ...user(), '--accept', 'work.txt exists', 'add work.txt']);
    expect(r.code).toBe(0);
    const id = /task (\S+) submitted/.exec(r.err)?.[1] as string;
    expect(id).toBeTruthy();
    expect(r.out).toContain(`${id} completed: add work.txt`);
    // The combined work is on the task's branch in the repo; main is untouched.
    const branches = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/tacet/']);
    expect(branches).toContain(id);
    expect(git(repo, ['show', `${branches.split('\n')[0]}:work.txt`])).toBe('work');
    expect(git(repo, ['ls-files'])).not.toContain('work.txt');
    // Nothing of Tacet's is in the repo: state and checkouts are under the state dir.
    expect(git(repo, ['status', '--porcelain'])).toBe('');

    const s = await tacet(['status', ...user(), '--json']);
    expect(s.code).toBe(0);
    const status = JSON.parse(s.out) as {
      running: number | null;
      tasks: { id: string; state: string; subtasks: { id: string; state: string }[] }[];
    };
    expect(status.running).toBeNull();
    expect(status.tasks).toMatchObject([
      { id, state: 'completed', subtasks: [{ id: `${id}/1`, state: 'completed' }] },
    ]);
    // The branch the task targets, pinned when it started (#219).
    const branch = git(repo, ['symbolic-ref', '--short', 'HEAD']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    expect((status.tasks[0] as { target?: unknown }).target).toEqual({ branch, commit: head });
    const text = (await tacet(['status', ...user()])).out;
    expect(text).toContain('Mini-conductor not running');
    expect(text).toContain(`targets ${branch} (started at ${head.slice(0, 12)})`);

    const l = await tacet(['logs', ...user(), id]);
    expect(l.code).toBe(0);
    expect(l.out).toContain('worker');
    expect(l.out).not.toContain('says:');
    expect((await tacet(['logs', ...user(), '--transcript', id])).out).toContain('says:');
    const lines = (await tacet(['logs', ...user(), '--json', id])).out.split('\n');
    expect(lines.map((x) => (JSON.parse(x) as { type: string }).type)).toContain('task.result');
    expect((await tacet(['logs', ...user(), 'nope'])).code).toBe(1);

    const a = await tacet(['attach', ...user(), `${id}/1`]);
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/worker \S+ started/);
    expect(a.out).toMatch(/worker \S+ ended/);
  });

  it('stops for an escalation without a terminal, and carries on with --resume --answer', async () => {
    const paths = repoStatePaths(repo, state);
    let escId: string | undefined;
    script = (cwd, input) => {
      // After a restart the answer comes inside the resume prompt.
      if (input.includes('Answer to your escalation')) {
        commit(cwd, `${input.split(': ').at(-1)}\n`);
        return undefined;
      }
      const id = raise(paths.events, 'Which database?');
      escId ??= id;
      return { do: 'reply', text: 'Escalated; waiting.' };
    };
    const r = await tacet(['run', ...user(), 'pick a database']);
    expect(r.code).toBe(3);
    expect(r.out).toContain(`escalation ${escId}`);
    expect(r.out).toContain('Which database?');
    expect((await tacet(['run', ...user(), '--resume', '--answer', 'bad'])).code).toBe(2);
    const first = /task (\S+) submitted/.exec(r.err)?.[1] as string;

    // Nothing is running now: following the stopped task or its session ends instead of waiting.
    expect((await tacet(['logs', ...user(), '--follow', first])).code).toBe(0);
    // The run recorded its session as ended (restart): attach shows it and returns.
    const att = await tacet(['attach', ...user(), `${first}/1`]);
    expect(att.code).toBe(0);
    expect(att.out).toMatch(/ended: restart/);

    // A new task does not leave the unfinished one running unseen: it is followed and asked too,
    // and --json makes the wait machine-readable.
    const second = await tacet(['run', ...user(), '--json', 'another task']);
    expect(second.code).toBe(3);
    expect(second.err).toContain(`also resuming ${first}`);
    const waiting = JSON.parse(second.out) as {
      tasks: { id: string; state: string }[];
      escalations: { id: string; taskId: string; question: string }[];
    };
    expect(waiting.tasks.map((x) => x.id)).toContain(first);
    expect(waiting.escalations).toContainEqual({
      id: escId,
      taskId: `${first}/1`,
      question: 'Which database?',
    });
    const other = waiting.escalations.find((x) => x.id !== escId)?.id as string;
    expect(other).toBeTruthy();

    const again = await tacet([
      'run',
      ...user(),
      '--resume',
      '--answer',
      `${escId}=Postgres`,
      '--answer',
      `${other}=SQLite`,
    ]);
    expect(again.code).toBe(0);
    const branch = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/tacet/'])
      .split('\n')
      .find((b) => b.includes(first)) as string;
    expect(git(repo, ['show', `${branch}:work.txt`])).toBe('Postgres');
    expect((await tacet(['run', ...user(), '--resume'])).err).toContain('nothing to resume');
  });

  it('asks an escalation on a terminal and delivers the answer', async () => {
    const paths = repoStatePaths(repo, state);
    let asked = 0;
    script = (cwd, input) => {
      // After a restart the answer comes inside the resume prompt.
      if (input.includes('Answer to your escalation')) {
        commit(cwd, `${input.split(': ').at(-1)}\n`);
        return undefined;
      }
      raise(paths.events, 'Which \x1b]52;c;cGF3bmVk\x07database?');
      return { do: 'reply', text: 'waiting' };
    };
    const questions: string[] = [];
    const r = await tacet(['run', ...user(), 'pick a database'], {
      prompt: async (q) => {
        questions.push(q);
        asked += 1;
        return 'SQLite';
      },
    });
    expect(r.code).toBe(0);
    expect(asked).toBe(1);
    // The Worker's question reaches the terminal without its escape sequence.
    expect(questions[0]).not.toContain('\x1b');
    expect(questions[0]).toContain('Which ?]52;c;cGF3bmVk?database?');
  });

  it('leaves a question for later on Enter, and stops with 130 on an interrupt at the prompt', async () => {
    const paths = repoStatePaths(repo, state);
    script = () => {
      raise(paths.events, 'Which database?');
      return { do: 'reply', text: 'waiting' };
    };
    const later = await tacet(['run', ...user(), 'pick a database'], { prompt: async () => '' });
    expect(later.code).toBe(3);
    const abort = new AbortController();
    const r = await tacet(['run', ...user(), '--resume'], {
      signal: abort.signal,
      prompt: async () => {
        abort.abort();
        return undefined;
      },
    });
    expect(r.code).toBe(130);
  });

  it('refuses a directory outside git before starting anything', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const r = await tacet(['run', ...user(), 'x'], { cwd: plain });
    expect(r.code).toBe(1);
    expect(r.err).toContain('not in a git repository');
  });

  it('warns, and still runs, when the repo is on a Windows drive inside WSL (#193)', async () => {
    const onC = (p: string) =>
      p.startsWith(repo) ? `/mnt/c/Users/me/repo${p.slice(repo.length)}` : p;
    const wsl = {
      osrelease: '5.15.167.4-microsoft-standard-WSL2',
      mountinfo: '90 29 0:52 / /mnt/c rw - 9p C:\\134 rw,aname=drvfs',
      realpath: onC,
    };
    const r = await tacet(['run', ...user(), 'add work.txt'], { wslProbe: wsl });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/warning: the repo is on C: \(a Windows drive\) inside WSL/);
    // The state directory is in the distro's own file system: no warning for it.
    expect(r.err).not.toMatch(/state directory is on/);
    // Inside WSL, but in the distro's own file system: nothing to say.
    const inDistro = await tacet(['run', ...user(), 'again'], {
      wslProbe: { ...wsl, realpath: (p: string) => p },
    });
    expect(inDistro.code).toBe(0);
    expect(inDistro.err).not.toMatch(/warning: the/);
  });

  it('refuses to run beside another live Mini-conductor for the repo', async () => {
    const paths = repoStatePaths(repo, state);
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    try {
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.lock, `${other.pid}\n`);
      const r = await tacet(['run', ...user(), 'anything']);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`another Mini-conductor (pid ${other.pid})`);
      const s = JSON.parse((await tacet(['status', ...user(), '--json'])).out) as {
        running: number | null;
      };
      expect(s.running).toBe(other.pid);
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('stops on an interrupt, records the open session for --resume, and frees the lock', async () => {
    const abort = new AbortController();
    let turns = 0;
    script = (cwd, input) => {
      turns += 1;
      if (turns === 1) {
        abort.abort();
        return { do: 'hold' };
      }
      if (input) commit(cwd);
      return undefined;
    };
    const r = await tacet(['run', ...user(), 'add work.txt'], { signal: abort.signal });
    expect(r.code).toBe(130);
    expect(r.err).toContain('tacet run --resume');
    const paths = repoStatePaths(repo, state);
    const store = openEventStore(paths.events, { readonly: true });
    try {
      const ended = store.query({ typePrefix: 'worker.ended' }).map((e) => e.envelope.data);
      expect(ended).toContainEqual(expect.objectContaining({ reason: 'restart' }));
    } finally {
      store.close();
    }
    const s = JSON.parse((await tacet(['status', ...user(), '--json'])).out) as {
      running: number | null;
    };
    expect(s.running).toBeNull();
  });

  it('cancels an interrupted task, which --resume then leaves alone (#202)', async () => {
    const abort = new AbortController();
    let turns = 0;
    script = () => {
      turns += 1;
      abort.abort();
      return { do: 'hold' };
    };
    const r = await tacet(['run', ...user(), 'add work.txt'], { signal: abort.signal });
    expect(r.code).toBe(130);
    expect(r.err).toContain('tacet cancel <task>');
    const id = /task (\S+) submitted/.exec(r.err)?.[1] as string;

    // Refused while a run is live.
    const paths = repoStatePaths(repo, state);
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    try {
      writeFileSync(paths.lock, `${other.pid}\n`);
      const live = await tacet(['cancel', ...user(), id]);
      expect(live.code).toBe(1);
      expect(live.err).toContain(`a run is live for this repo (pid ${other.pid})`);
    } finally {
      other.kill('SIGKILL');
      rmSync(paths.lock, { force: true });
    }

    const c = await tacet(['cancel', ...user(), '--json', id]);
    expect(c.code).toBe(0);
    expect(JSON.parse(c.out)).toEqual({ canceled: [`${id}/1`, id] });
    const s = JSON.parse((await tacet(['status', ...user(), '--json'])).out) as {
      tasks: { id: string; state: string; subtasks: { state: string }[] }[];
    };
    expect(s.tasks).toEqual([
      expect.objectContaining({
        id,
        state: 'canceled',
        subtasks: [expect.objectContaining({ state: 'canceled' })],
      }),
    ]);

    const resumed = await tacet(['run', ...user(), '--resume']);
    expect(resumed.code).toBe(0);
    expect(resumed.err).toContain('nothing to resume');
    expect(turns).toBe(1);

    const again = await tacet(['cancel', ...user(), id]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('has already ended (canceled)');
    expect((await tacet(['cancel', ...user(), `${id}/1`])).err).toContain(`cancel its task ${id}`);
    expect((await tacet(['cancel', ...user()])).code).toBe(2);
  });

  it('drops the open escalations of a canceled task from status (#202)', async () => {
    const paths = repoStatePaths(repo, state);
    script = () => {
      raise(paths.events, 'Which database?');
      return { do: 'reply', text: 'Escalated; waiting.' };
    };
    const r = await tacet(['run', ...user(), 'pick a database']);
    expect(r.code).toBe(3);
    const id = /task (\S+) submitted/.exec(r.err)?.[1] as string;
    const escalations = async () =>
      (
        JSON.parse((await tacet(['status', ...user(), '--json'])).out) as {
          tasks: { escalations: unknown[] }[];
        }
      ).tasks[0]?.escalations;
    expect(await escalations()).toHaveLength(1);
    expect((await tacet(['cancel', ...user(), id])).code).toBe(0);
    // Nobody waits on that answer now: the question is no longer listed.
    expect(await escalations()).toEqual([]);
  });

  describe("the live run's control port (#201)", () => {
    const runtimeFile = () => miniRuntimePath(repo, join(root, 'home', '.tacet', 'run'));
    type Status = {
      running: number | null;
      source: string;
      tasks: { id: string; state: string; escalations: { id: string; taskId: string }[] }[];
    };
    const status = async () =>
      JSON.parse((await tacet(['status', ...user(), '--json'])).out) as Status;

    it('answers status and takes an answer while the run waits, writing the log from the run only', async () => {
      const paths = repoStatePaths(repo, state);
      let escId = '';
      script = (cwd, input) => {
        if (input.includes('Answer to your escalation')) {
          commit(cwd, `${input.split(': ').at(-1)}\n`);
          return undefined;
        }
        escId = raise(paths.events, 'Which database?');
        return { do: 'reply', text: 'waiting' };
      };
      const seen: { live?: Status; human?: string; wrong?: number; answer?: number } = {};
      const r = await tacet(['run', ...user(), 'pick a database'], {
        prompt: async () => {
          seen.live = await status();
          seen.human = (await tacet(['status', ...user()])).out;
          seen.wrong = (await tacet(['answer', ...user(), '01JCX5Z9Q4W8E7R6T5Y4V3K2M9', 'x'])).code;
          seen.answer = (await tacet(['answer', ...user(), escId, 'Postgres'])).code;
          // Left on the terminal: it was answered over the port meanwhile.
          return '';
        },
      });
      expect(seen.live?.source).toBe('run');
      expect(seen.live?.running).toBe(process.pid);
      expect(seen.live?.tasks[0]?.escalations.map((x) => x.id)).toEqual([escId]);
      expect(seen.human).toContain(`escalation ${escId}`);
      expect(seen.human).not.toContain('read from the log');
      expect(seen.wrong).toBe(1);
      expect(seen.answer).toBe(0);
      // The run carried on with the answer given over the port, and finished.
      expect(r.code).toBe(0);
      const id = /task (\S+) submitted/.exec(r.err)?.[1] as string;
      const branch = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/tacet/'])
        .split('\n')
        .find((b) => b.includes(id)) as string;
      expect(git(repo, ['show', `${branch}:work.txt`])).toBe('Postgres');
      // Answered once, by the user, as the run recorded it.
      const store = openEventStore(paths.events);
      const resolved = store
        .query({ typePrefix: 'escalation.resolved' })
        .map((e) => e.envelope.data);
      store.close();
      expect(resolved).toEqual([expect.objectContaining({ escalationId: escId, source: 'user' })]);
      // The port is gone with the run: status reads the log again.
      expect(existsSync(runtimeFile())).toBe(false);
      expect(await status()).toMatchObject({ running: null, source: 'log' });
      expect((await tacet(['answer', ...user(), escId, 'again'])).code).toBe(1);
    });

    it('cancels a task in the live run', async () => {
      const paths = repoStatePaths(repo, state);
      script = () => {
        raise(paths.events, 'Which database?');
        return { do: 'reply', text: 'waiting' };
      };
      let canceled: { code: number; out: string } | undefined;
      let id = '';
      const r = await tacet(['run', ...user(), 'pick a database'], {
        prompt: async () => {
          id = (await status()).tasks[0]?.id as string;
          canceled = await tacet(['cancel', ...user(), id]);
          return '';
        },
      });
      expect(canceled?.code).toBe(0);
      expect(canceled?.out).toContain(`${id} canceled`);
      expect(canceled?.out).toContain(`${id}/1 canceled`);
      expect(r.code).not.toBe(3);
      expect((await status()).tasks[0]?.state).toBe('canceled');
    });

    it("keeps the port's token in its 0600 runtime file only, new for every run", async () => {
      const paths = repoStatePaths(repo, state);
      script = () => {
        raise(paths.events, 'Which database?');
        return { do: 'reply', text: 'waiting' };
      };
      const tokens: string[] = [];
      const outputs: string[] = [];
      const runOnce = async () => {
        const r = await tacet(['run', ...user(), 'pick a database'], {
          prompt: async () => {
            const file = runtimeFile();
            expect(statSync(file).mode & 0o777).toBe(0o600);
            expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
            expect(statSync(join(file, '..', '..')).mode & 0o777).toBe(0o700);
            tokens.push((JSON.parse(readFileSync(file, 'utf8')) as { token: string }).token);
            for (const argv of [
              ['status', '--json'],
              ['status'],
              ['logs', '--transcript', '--json'],
            ]) {
              const out = await tacet([
                ...argv.slice(0, 1),
                ...user(),
                ...argv.slice(1),
                ...(argv[0] === 'logs' ? [(await status()).tasks[0]?.id as string] : []),
              ]);
              outputs.push(out.out, out.err);
            }
            return '';
          },
        });
        outputs.push(r.out, r.err);
      };
      await runOnce();
      await tacet(['cancel', ...user(), (await status()).tasks[0]?.id as string]);
      await runOnce();
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).not.toBe(tokens[1]);
      expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // In no output, no event of the log, nothing a Worker was started with.
      const store = openEventStore(paths.events);
      const log = JSON.stringify(store.query({}).map((e) => e.envelope));
      store.close();
      const workers = JSON.stringify(made.flatMap((a) => a.sessions.map((x) => x.opts)));
      for (const token of tokens) {
        expect(outputs.join('\n')).not.toContain(token);
        expect(log).not.toContain(token);
        expect(workers).not.toContain(token);
      }
    });

    it('uses the port only when the runtime file names the run holding the lock', async () => {
      const paths = repoStatePaths(repo, state);
      script = () => {
        raise(paths.events, 'Which database?');
        return { do: 'reply', text: 'waiting' };
      };
      const sources: Record<string, string> = {};
      const notes: string[] = [];
      await tacet(['run', ...user(), 'pick a database'], {
        prompt: async () => {
          const file = runtimeFile();
          const real = readFileSync(file, 'utf8');
          sources.real = (await status()).source;
          // The live port and token, but another process's pid: not the lock holder.
          writeFileSync(file, JSON.stringify({ ...JSON.parse(real), pid: process.pid + 100_000 }), {
            mode: 0o600,
          });
          sources.otherPid = (await status()).source;
          // Readable by others: refused, with a note.
          writeFileSync(file, real, { mode: 0o600 });
          chmodSync(file, 0o644);
          const loose = await tacet(['status', ...user(), '--json']);
          sources.loose = (JSON.parse(loose.out) as Status).source;
          notes.push(loose.err);
          chmodSync(file, 0o600);
          sources.restored = (await status()).source;
          return '';
        },
      });
      expect(sources).toEqual({ real: 'run', otherPid: 'log', loose: 'log', restored: 'run' });
      expect(notes[0]).toContain('expected 600');
    });

    it('stops cleanly and leaves no file when the port cannot be set up', async () => {
      script = () => ({ do: 'reply', text: 'done' });
      // Where the run directory should be, a file: the runtime file cannot be written.
      mkdirSync(join(root, 'home', '.tacet'), { recursive: true });
      writeFileSync(join(root, 'home', '.tacet', 'run'), '');
      const r = await tacet(['run', ...user(), 'a task']);
      expect(r.code).toBe(1);
      // The Mini-conductor was stopped: its lock is free and a new run can start.
      expect(await status()).toMatchObject({ running: null });
      rmSync(join(root, 'home', '.tacet', 'run'));
      expect((await tacet(['run', ...user(), '--resume'])).code).not.toBe(1);
    });

    it('falls back to the log when the runtime file is stale or broken', async () => {
      const paths = repoStatePaths(repo, state);
      script = () => {
        raise(paths.events, 'Which database?');
        return { do: 'reply', text: 'waiting' };
      };
      expect((await tacet(['run', ...user(), 'pick a database'])).code).toBe(3);
      // A crashed run's file: its pid holds no lock.
      mkdirSync(join(runtimeFile(), '..'), { recursive: true, mode: 0o700 });
      writeFileSync(
        runtimeFile(),
        JSON.stringify({
          pid: 999999,
          port: 1,
          token: 'stale-token-0000000000000000000000000000000',
          protocolVersions: [1],
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      expect(await status()).toMatchObject({ running: null, source: 'log' });
      expect((await tacet(['answer', ...user(), 'x', 'y'])).code).toBe(1);
    });
  });

  it('says so when the repo has no Tacet state, and refuses usage errors', async () => {
    expect((await tacet(['status', ...user()])).out).toContain('no Tacet state');
    expect((await tacet(['logs', ...user(), 'x'])).code).toBe(1);
    expect((await tacet(['run', ...user()])).code).toBe(2);
    expect((await tacet(['run', ...user(), '--resume', 'task'])).code).toBe(2);
    expect((await tacet(['attach', ...user()])).code).toBe(2);
    expect((await tacet(['answer', ...user(), 'only-an-id'])).code).toBe(2);
    // A config that cannot run Workers is reported, and leaves no lock behind.
    writeFileSync(
      join(repo, '.tacet', 'tacet.yaml'),
      `events: { state_dir: ${JSON.stringify(state)} }\n`,
    );
    const bad = await tacet(['run', ...user(), 'x'], { standalone: {} });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('tiers.worker');
    expect(JSON.parse((await tacet(['status', ...user(), '--json'])).out).running).toBeNull();
  });

  it("attach shows a PTY Worker's terminal live from the run's port, until the session ends (#201)", async () => {
    const term = new ScriptedTerminalAdapter('claude-sdk', () => ({ do: 'hold' }));
    const adapters = { 'claude-sdk': { adapter: term, authRoute: 'api_key' as const } };
    const running = tacet(['run', ...user(), 'watch the terminal'], {
      standalone: { adapters },
    });
    const runtimeFile = miniRuntimePath(repo, join(root, 'home', '.tacet', 'run'));
    await vi.waitFor(
      () => {
        if (!term.sessions[0] || !existsSync(runtimeFile)) throw new Error('not running yet');
      },
      { timeout: 10_000 },
    );
    const handle = term.sessions[0]?.handle;
    if (!handle) throw new Error('no session');
    const screen = term.terminal(handle);
    screen.push('$ make test\r\n');
    const live = JSON.parse((await tacet(['status', ...user(), '--json'])).out) as {
      tasks: { id: string }[];
    };
    const id = live.tasks[0]?.id as string;

    const got: Uint8Array[] = [];
    const text = () => Buffer.concat(got).toString('utf8');
    const attaching = tacet(['attach', ...user(), `${id}/1`], { raw: (b) => got.push(b) });
    await vi.waitFor(() => expect(text()).toBe('$ make test\r\n'));
    screen.push('\x1b[32mok\x1b[0m 12 tests');
    // The terminal's own bytes, escape sequences and all.
    await vi.waitFor(() => expect(text()).toBe('$ make test\r\n\x1b[32mok\x1b[0m 12 tests'));

    const secret = readRuntimeFile(runtimeFile).token.reveal();

    // The session ends: so does attach, handing the user's terminal back as it was.
    expect((await tacet(['cancel', ...user(), id])).code).toBe(0);
    const a = await attaching;
    expect(a.code).toBe(0);
    expect(a.err).toContain('the Worker session ended');
    expect(a.out).toBe('');
    expect(text().startsWith('$ make test\r\n\x1b[32mok\x1b[0m 12 tests')).toBe(true);
    expect(
      text().endsWith(
        '\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l',
      ),
    ).toBe(true);
    // The port's token is in none of it.
    expect([a.out, a.err, text()].some((x) => x.includes(secret))).toBe(false);
    expect((await running).code).toBe(1);
  });

  it('attach follows a Worker without a terminal through the log, with no note, while a run is live (#201)', async () => {
    script = () => ({ do: 'hold' });
    const running = tacet(['run', ...user(), 'no terminal here']);
    const runtimeFile = miniRuntimePath(repo, join(root, 'home', '.tacet', 'run'));
    await vi.waitFor(
      () => {
        if (!made.at(-1)?.sessions[0] || !existsSync(runtimeFile)) throw new Error('not yet');
      },
      { timeout: 10_000 },
    );
    const id = (
      JSON.parse((await tacet(['status', ...user(), '--json'])).out) as { tasks: { id: string }[] }
    ).tasks[0]?.id as string;
    const got: Uint8Array[] = [];
    const stop = new AbortController();
    const attaching = tacet(['attach', ...user(), `${id}/1`], {
      raw: (b) => got.push(b),
      signal: stop.signal,
    });
    await new Promise((r) => setTimeout(r, 300));
    stop.abort();
    const a = await attaching;
    expect(a.code, a.err).toBe(0);
    expect(a.out).toMatch(/worker \S+ started/);
    expect(a.err).not.toContain('note:');
    expect(got).toEqual([]);
    const c = await tacet(['cancel', ...user(), id]);
    expect(c.code, c.err).toBe(0);
    await running;
  });
});

/** What the Mini-conductor's `escalate` tool records for the latest Worker. Returns its id. */
function raise(eventsPath: string, question: string): string {
  const store = openEventStore(eventsPath);
  try {
    const started = store.query({ typePrefix: 'worker.started' }).at(-1)?.envelope;
    if (!started) throw new Error('no Worker started');
    const { sessionId } = started.data as { sessionId: string };
    // Once per sub-task: a restarted session does not ask again.
    const earlier = store
      .query({ taskId: started.taskId as string, typePrefix: 'escalation.raised' })
      .at(-1)?.envelope.data as { id: string } | undefined;
    if (earlier) return earlier.id;
    const id = newUlid();
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'worker', id: sessionId },
      taskId: started.taskId,
      sessionId,
      type: 'escalation.raised',
      data: {
        id,
        taskId: started.taskId,
        question,
        urgency: 'normal',
        createdAt: new Date().toISOString(),
        status: 'pending',
      },
    });
    return id;
  } finally {
    store.close();
  }
}
