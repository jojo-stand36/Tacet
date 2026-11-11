import { describe, expect, it } from 'vitest';
import {
  assertConformance,
  type ConformanceScenario,
  formatResults,
  MockAdapter,
  type MockAdapterOptions,
  type ProbeResult,
  runConformance,
} from './index.js';

const scenario: ConformanceScenario = {
  session: { cwd: '/tmp/worktree' },
  replyPrompt: 'SAY hello world',
  approvalPrompt: 'RUN_TOOL',
  slowPrompt: 'SLOW',
  echoPrompt: 'WHO',
  altModel: 'mock-large',
  timeoutMs: 2000,
};

const run = (opts?: MockAdapterOptions) => {
  const adapter = new MockAdapter(opts);
  return runConformance(adapter, {
    ...scenario,
    altEffort: 'high',
    sentEffort: () => adapter.lastEffort,
    contextWindow: { applied: () => adapter.lastContextWindow === 1_000_000 },
  });
};
const verdict = (results: ProbeResult[], id: string) => results.find((r) => r.id === id)?.verdict;

describe('conformance bench with the mock adapter', () => {
  it('the full-featured mock passes every probe', async () => {
    const results = await run();
    // Every probe but `mcp`, which needs an MCP server to check a declared client against.
    expect(
      results.map((r) => r.verdict),
      formatResults(results),
    ).toEqual(results.map((r) => (r.id === 'mcp' ? 'skip' : 'pass')));
    expect(() => assertConformance(results)).not.toThrow();
  });

  it('a mock with fewer capabilities passes, skipping what it does not declare', async () => {
    const capabilities: MockAdapterOptions['capabilities'] = {
      streaming: false,
      liveInput: false,
      approvals: 'predecided',
      interrupt: 'kill',
      resume: false,
      mcp: true,
      fork: 'emulated',
      usage: { live: true, context: false, cost: 'none' },
      modelSwitch: 'launch-only',
      injectContext: false,
      effortSwitch: undefined,
      contextSizes: [],
    };
    const results = await run({ capabilities });
    expect(() => assertConformance(results)).not.toThrow();
    for (const id of [
      'approval-roundtrip',
      'interrupt',
      'live-input',
      'resume',
      'inject-context',
      'model-switch',
      'effort',
    ]) {
      expect(verdict(results, id), id).toBe('skip');
    }
    expect(verdict(results, 'stream')).toBe('pass');
    expect(verdict(results, 'context-sizes')).toBe('pass'); // refuses what it does not list
  });

  it('checks effort at launch for a per-session adapter', async () => {
    const results = await run({ capabilities: { effortSwitch: 'per-session' } });
    expect(verdict(results, 'effort'), formatResults(results)).toBe('pass');
  });

  it('skips the effort probe when the vendor default already equals altEffort', async () => {
    const adapter = new MockAdapter();
    const results = await runConformance(adapter, {
      ...scenario,
      altEffort: 'high',
      // A vendor whose default is `high` would make a no-op adapter look honest.
      sentEffort: () => adapter.lastEffort ?? 'high',
    });
    expect(verdict(results, 'effort'), formatResults(results)).toBe('skip');
  });

  it('reports drift when a listed context window is accepted but not used', async () => {
    const adapter = new MockAdapter();
    const results = await runConformance(adapter, {
      ...scenario,
      contextWindow: { applied: () => false },
    });
    expect(verdict(results, 'context-sizes'), formatResults(results)).toBe('drift');
  });

  it('reports drift when a per-session adapter accepts a turn-level effort', async () => {
    class Lax extends MockAdapter {
      override capabilities() {
        return { ...super.capabilities(), effortSwitch: 'per-session' as const };
      }
    }
    const adapter = new Lax();
    const results = await runConformance(adapter, {
      ...scenario,
      altEffort: 'high',
      sentEffort: () => adapter.lastEffort,
    });
    expect(verdict(results, 'effort'), formatResults(results)).toBe('drift');
  });
});

describe('drift detection (declared vs observed)', () => {
  it.each([
    ['streaming', 'stream'],
    ['usage', 'usage'],
    ['approvals', 'approval-roundtrip'],
    ['interrupt', 'interrupt'],
  ] as const)(
    'reports drift when the adapter declares %s but does not deliver it',
    async (lie, probe) => {
      const results = await run({ lie: { [lie]: true } });
      expect(verdict(results, probe), formatResults(results)).toBe('drift');
      expect(() => assertConformance(results)).toThrow(new RegExp(`${probe}: drift`));
    },
  );

  it.each([
    ['effort', 'effort'],
    ['contextWindow', 'context-sizes'],
  ] as const)('reports P1 drift (not gating) when the adapter fakes %s', async (lie, probe) => {
    const results = await run({ lie: { [lie]: true } });
    expect(verdict(results, probe), formatResults(results)).toBe('drift');
    expect(() => assertConformance(results)).not.toThrow(); // P1 probes report, never gate
  });

  it('checks that an adapter declaring no MCP client refuses mcpServers (#184)', async () => {
    const honest = await run({ capabilities: { mcp: false } });
    expect(verdict(honest, 'mcp'), formatResults(honest)).toBe('pass');
    const liar = await run({ capabilities: { mcp: false }, lie: { mcp: true } });
    expect(verdict(liar, 'mcp'), formatResults(liar)).toBe('drift');
    expect(() => assertConformance(liar)).toThrow(/mcp: drift/);
    // Declaring it needs an MCP server to check against.
    expect(verdict(await run({}), 'mcp')).toBe('skip');
  });

  it('reports drift when an adapter streams but declares that it does not', async () => {
    // Declared non-streaming, but the bench sees several deltas: the declaration is wrong.
    class Overachiever extends MockAdapter {
      override capabilities() {
        return { ...super.capabilities(), streaming: false };
      }
    }
    const results = await runConformance(new Overachiever(), scenario);
    expect(verdict(results, 'stream')).toBe('drift');
  });

  it('only P0 probes gate', () => {
    const results: ProbeResult[] = [
      { id: 'a', priority: 'P1', verdict: 'drift', detail: '' },
      { id: 'b', priority: 'P0', verdict: 'skip', detail: '' },
    ];
    expect(() => assertConformance(results)).not.toThrow();
  });
});

describe('MockAdapter contract details', () => {
  it('rejects send() during a turn when liveInput is false, and model switch when launch-only', async () => {
    const a = new MockAdapter({ capabilities: { liveInput: false, modelSwitch: 'launch-only' } });
    const h = await a.start({ cwd: '/tmp' });
    await a.send(h, { text: 'SLOW' });
    await expect(a.send(h, { text: 'SAY x' })).rejects.toThrow(/busy/);
    await expect(a.send(h, { text: 'SAY x' }, { model: 'other' })).rejects.toThrow();
    await a.close(h);
    expect(a.status(h)).toBe('done');
  });

  it('reports still-queued input in the interrupt receipt', async () => {
    const a = new MockAdapter();
    const h = await a.start({ cwd: '/tmp' });
    await a.send(h, { text: 'SLOW' });
    await a.send(h, { text: 'SAY later' });
    await new Promise((r) => setTimeout(r, 10));
    expect(await a.interrupt(h)).toEqual({ stillQueued: ['SAY later'] });
    await a.close(h);
  });
});
