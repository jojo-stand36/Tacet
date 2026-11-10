import { describe, expect, it, vi } from 'vitest';
import { PtyUnavailableError } from '../pty.js';
import { gatedTitle, ptyGate } from './pty-gate.js';

describe('ptyGate (#189)', () => {
  const missing = async () => {
    throw new PtyUnavailableError('the PTY adapter needs node-pty: no build');
  };

  it('runs the PTY suites when node-pty loads', async () => {
    expect(await ptyGate({}, async () => undefined)).toEqual({ ok: true });
    expect(await ptyGate({ CI: 'true' }, async () => undefined)).toEqual({ ok: true });
  });

  it('skips them locally, with the reason, when node-pty is missing', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let gate: Awaited<ReturnType<typeof ptyGate>>;
    try {
      gate = await ptyGate({}, missing);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Skipping the PTY suites/));
    } finally {
      // Never leave stderr muted for the rest of this worker's output.
      warn.mockRestore();
    }
    expect(gate).toEqual({ ok: false, reason: expect.stringMatching(/node-pty is not available/) });
    expect(gatedTitle('PTY suite', gate)).toMatch(/^PTY suite \(skipped locally: node-pty/);
  });

  it('fails in CI when node-pty is missing, and on any other error', async () => {
    await expect(ptyGate({ CI: 'true' }, missing)).rejects.toThrow(PtyUnavailableError);
    await expect(
      ptyGate({}, async () => {
        throw new Error('something else');
      }),
    ).rejects.toThrow('something else');
  });
});
