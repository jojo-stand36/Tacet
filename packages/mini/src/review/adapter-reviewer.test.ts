import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterCapabilities, TacetConfig, Task, TierConfig } from '@tacet/core';
import { WORKER_MARKER_VAR } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Script, ScriptedAdapter } from '../daemon/testing.js';
import { reviewDiff } from '../git/diff.js';
import { AdapterReviewer, parseReview, reviewFeedback } from './adapter-reviewer.js';
import { reviewConfigProblem } from './config.js';

const TASK: Task = {
  id: 'T1/1',
  goal: 'Add a greeting',
  acceptanceCriteria: ['greet() returns hello'],
  priority: 'p1',
  createdAt: new Date(0).toISOString(),
} as Task;

const APPROVE = JSON.stringify({ verdict: 'approve', findings: [] });
const CHANGES = JSON.stringify({
  verdict: 'request_changes',
  findings: [
    { severity: 'minor', message: 'naming' },
    { severity: 'blocker', file: 'greet.js', line: 1, message: 'returns goodbye' },
  ],
});

describe('parseReview', () => {
  it('reads a verdict, with or without a code fence', () => {
    expect(parseReview(APPROVE)).toEqual({ verdict: 'approve', findings: [] });
    expect(parseReview(`\`\`\`json\n${CHANGES}\n\`\`\``).findings).toHaveLength(2);
  });

  it('refuses prose, a verdict at odds with its findings, and unknown severities', () => {
    expect(() => parseReview('Looks good to me!')).toThrow(/not JSON/);
    expect(() =>
      parseReview(
        JSON.stringify({
          verdict: 'request_changes',
          findings: [{ severity: 'minor', message: 'x' }],
        }),
      ),
    ).toThrow(/needs at least one blocker or major/);
    expect(() =>
      parseReview(
        JSON.stringify({ verdict: 'approve', findings: [{ severity: 'major', message: 'x' }] }),
      ),
    ).toThrow(/approve cannot carry/);
    expect(() =>
      parseReview(
        JSON.stringify({ verdict: 'approve', findings: [{ severity: 'nit', message: 'x' }] }),
      ),
    ).toThrow(/severity/);
  });
});

describe('reviewFeedback', () => {
  it('puts blocking findings first, redacts them and bounds them', () => {
    const fb = reviewFeedback([
      { severity: 'minor', message: 'small' },
      { severity: 'major', file: 'a.ts', line: 3, message: 'leaks sk-ant-abcdefghijklmnop' },
    ]);
    expect(fb).toMatch(/^Review failed:/);
    expect(fb).toContain('(reviewer findings, untrusted)');
    expect(fb.indexOf('[major] a.ts:3')).toBeLessThan(fb.indexOf('[minor]'));
    expect(fb).not.toContain('sk-ant-abcdefghijklmnop');
    const long = reviewFeedback(
      Array.from({ length: 50 }, () => ({ severity: 'major' as const, message: 'x'.repeat(1999) })),
    );
    expect(long.length).toBeLessThan(9 * 1024);
    expect(long).toMatch(/\(more findings cut\)$/);
  });
});

describe('reviewDiff and AdapterReviewer', () => {
  let repo: string;
  let base: string;
  let commit: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tacet-review-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
    writeFileSync(join(repo, 'greet.js'), 'export const greet = () => "hi";\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'work');
    writeFileSync(join(repo, 'greet.js'), 'export const greet = () => "hello";\n');
    // A key a Worker committed is never sent to the reviewer's vendor.
    writeFileSync(join(repo, 'key.txt'), 'sk-ant-abcdefghijklmnopqrst\n');
    git('add', '.');
    git('commit', '-qm', 'work');
    commit = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('diffs base..commit, or from where the commit left HEAD, and cuts a long patch', async () => {
    const d = await reviewDiff(commit, base, { repoRoot: repo });
    expect(d.patch).toContain('+export const greet = () => "hello";');
    expect(d.stat).toMatch(/greet\.js/);
    expect(d.truncated).toBe(false);
    expect((await reviewDiff(commit, undefined, { repoRoot: repo })).base).toBe(base);
    const cut = await reviewDiff(commit, base, { repoRoot: repo, maxBytes: 40 });
    expect(cut.truncated).toBe(true);
    expect(cut.patch.length).toBeLessThanOrEqual(40);
    await expect(reviewDiff('HEAD', base, { repoRoot: repo })).rejects.toThrow(/full commit ids/);
  });

  it('never runs an external diff driver or textconv the repo config names', async () => {
    const ran = join(repo, 'driver-ran');
    git('config', 'diff.evil.command', `touch ${ran}`);
    git('config', 'diff.evil.textconv', `touch ${ran}; cat`);
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* diff=evil\n');
    await reviewDiff(commit, base, { repoRoot: repo });
    expect(() => execFileSync('test', ['-e', ran])).toThrow();
  });

  function reviewer(script: (input: string) => Script, over: Partial<{ timeoutMs: number }> = {}) {
    const adapter = new ScriptedAdapter('claude-sdk', script);
    const r = new AdapterReviewer({
      worker: { adapter, authRoute: 'api_key' },
      adapterId: 'claude-sdk',
      model: 'm',
      diff: { repoRoot: repo },
      ...over,
    });
    const ctx = { commit, base, cwd: repo, signal: new AbortController().signal, marker: 'mk-1' };
    return { adapter, run: () => r.review(TASK, ctx) };
  }

  it('approves from its own reply, in a session with no Tacet tools and the marker set', async () => {
    const { adapter, run } = reviewer(() => ({ do: 'reply', text: APPROVE }));
    const r = await run();
    expect(r).toMatchObject({ status: 'passed', adapter: 'claude-sdk', model: 'm', findings: [] });
    expect(r.usage).toBeDefined();
    const s = adapter.sessions[0];
    expect(s?.opts.mcpServers).toBeUndefined();
    expect(s?.opts.cwd).toBe(repo);
    expect(s?.opts.env?.[WORKER_MARKER_VAR]).toBe('mk-1');
    const prompt = s?.inputs[0] ?? '';
    expect(prompt).toContain('greet() returns hello');
    expect(prompt).toContain('"hello"');
    expect(prompt).not.toContain('sk-ant-abcdefghijklmnopqrst');
    expect(prompt).toMatch(/<<<DIFF-([0-9a-f]{16})[\s\S]*DIFF-\1>>>/);
    // Closed when done.
    expect(adapter.status(s?.handle ?? { id: '' })).toBe('done');
  });

  it('fails on blocking findings', async () => {
    const r = await reviewer(() => ({ do: 'reply', text: CHANGES })).run();
    expect(r.status).toBe('failed');
    expect(r.findings.map((f) => f.severity)).toEqual(['minor', 'blocker']);
  });

  it('refuses every approval, and retries an invalid reply once', async () => {
    let n = 0;
    const { adapter, run } = reviewer(() =>
      ++n === 1 ? { do: 'approval' } : { do: 'reply', text: APPROVE },
    );
    const r = await run();
    expect(r.status).toBe('passed');
    expect(adapter.approvalsAnswered.map((d) => d.kind)).toEqual(['reject']);
    expect(adapter.sessions[0]?.inputs[1]).toMatch(/^That reply was invalid/);
  });

  it('gives an error, never a pass, when it gets no valid verdict or times out', async () => {
    const invalid = await reviewer(() => ({ do: 'reply', text: 'LGTM' })).run();
    expect(invalid).toMatchObject({ status: 'error', notes: 'the reviewer gave no valid verdict' });
    const slow = await reviewer(() => ({ do: 'hold' }), { timeoutMs: 100 }).run();
    expect(slow).toMatchObject({ status: 'error', notes: 'the reviewer timed out' });
    const broken = await reviewer(() => ({ do: 'error', message: '/secret/path failed' })).run();
    expect(broken.status).toBe('error');
    expect(broken.notes).not.toContain('/secret/path');
  });

  it('passes an empty change without a session', async () => {
    const { adapter, run } = reviewer(() => ({ do: 'reply', text: CHANGES }));
    const r = new AdapterReviewer({
      worker: { adapter, authRoute: 'api_key' },
      adapterId: 'claude-sdk',
      diff: { repoRoot: repo },
    });
    void run;
    const out = await r.review(TASK, {
      commit: base,
      base,
      cwd: repo,
      signal: new AbortController().signal,
      marker: 'mk',
    });
    expect(out).toMatchObject({ status: 'passed', notes: 'no change to review' });
    expect(adapter.sessions).toHaveLength(0);
  });

  it('refuses an adapter whose tools cannot be refused', () => {
    const adapter = new ScriptedAdapter('pty:x', () => ({ do: 'reply', text: APPROVE }));
    adapter.capabilities = (): AdapterCapabilities => ({
      ...new ScriptedAdapter('y', () => ({ do: 'hold' })).capabilities(),
      approvals: 'none',
    });
    expect(
      () =>
        new AdapterReviewer({
          worker: { adapter, authRoute: 'api_key' },
          adapterId: 'pty:x',
          diff: { repoRoot: repo },
        }),
    ).toThrow(/cannot have its tools refused/);
  });
});

describe('reviewConfigProblem', () => {
  const cfg = (
    review: TierConfig | undefined,
    worker: TierConfig = { adapter: 'claude-sdk', model: 'm' },
  ): TacetConfig => ({
    review: { enabled: true },
    tiers: { worker, ...(review ? { review } : {}) },
  });

  it('is fine when review is off, or the reviewer runs another vendor', () => {
    expect(reviewConfigProblem({})).toBeUndefined();
    expect(
      reviewConfigProblem({
        review: { enabled: false },
        tiers: { worker: { adapter: 'claude-sdk' } },
      }),
    ).toBeUndefined();
    expect(reviewConfigProblem(cfg({ adapter: 'acp:gemini' }))).toBeUndefined();
    expect(reviewConfigProblem(cfg({ adapter: 'opencode', vendor: 'google' }))).toBeUndefined();
  });

  it.each([
    [undefined, /needs a tiers\.review/],
    [{ adapter: 'acp:claude-acp' }, /runs anthropic models like the Worker/],
    [{ adapter: 'opencode' }, /tiers\.review\.vendor: say whose models/],
    [{ adapter: 'codex-app-server', model: 'm' }, /cannot review yet/],
    [{ adapter: 'acp:codex-acp' }, /cannot review yet/],
    [{ adapter: 'pty:aider', vendor: 'google' }, /cannot have its tools refused/],
  ] as [TierConfig | undefined, RegExp][])('refuses %j', (review, problem) => {
    expect(reviewConfigProblem(cfg(review))).toMatch(problem);
  });

  it('needs the Worker vendor too, and lets cross_vendor: false review with the same vendor', () => {
    expect(
      reviewConfigProblem(cfg({ adapter: 'acp:gemini' }, { adapter: 'opencode', model: 'm' })),
    ).toMatch(/tiers\.worker\.vendor/);
    expect(
      reviewConfigProblem(cfg({ adapter: 'acp:claude-acp', cross_vendor: false })),
    ).toBeUndefined();
  });
});
