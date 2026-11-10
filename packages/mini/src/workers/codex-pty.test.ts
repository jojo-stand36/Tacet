import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexLaunch } from '@tacet/adapter-codex-app-server';
import {
  type MockResponsesApi,
  startMockResponsesApi,
} from '@tacet/adapter-codex-app-server/testing';
import { gatedTitle, ptyGate } from '@tacet/adapter-pty/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorkerAdapters } from './build.js';

// node-pty must load in CI; locally a machine that could not build it skips these (#189).
const gate = await ptyGate();

/** The repo's pinned Codex CLI, found as the Codex adapter finds it, from that package. */
const CODEX = join(
  dirname(
    createRequire(fileURLToPath(import.meta.resolve('@tacet/adapter-codex-app-server'))).resolve(
      '@openai/codex/package.json',
    ),
  ),
  'bin',
  'codex.js',
);
// A 1x1 PNG: an image Codex would attach if it read the paste as its path.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082',
  'hex',
);

/**
 * Interactive Codex CLI as a `pty:<slug>` Worker (#249), live: the pinned binary in a real PTY
 * against the local mock Responses API, built from a preset as the Mini-conductor builds it.
 */
describe.skipIf(!gate.ok)(gatedTitle('interactive Codex as a PTY preset (#249)', gate), () => {
  let root: string;
  let checkout: string;
  let api: MockResponsesApi;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-codex-pty-')));
    checkout = join(root, 'wt');
    mkdirSync(checkout);
    mkdirSync(join(root, 'home', '.codex'), { recursive: true });
    writeFileSync(join(checkout, 'note.txt'), 'note\n');
    // Outside the checkout.
    writeFileSync(join(root, 'out.png'), PNG);
    execFileSync('git', ['init', '-q'], { cwd: checkout });
    // Trusted already, as after the first run: no trust screen. Should this key ever stop matching,
    // Codex waits on that screen and the test times out rather than failing on an assertion.
    writeFileSync(
      join(root, 'home', '.codex', 'config.toml'),
      `[projects.${JSON.stringify(checkout)}]\ntrust_level = "trusted"\n`,
    );
    api = await startMockResponsesApi();
  });
  afterAll(async () => {
    await api?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('submits a prompt ending in @path unchanged, and attaches no image for a lone path', {
    timeout: 180_000,
  }, async () => {
    const key = 'sk-test-0000000000000000000000';
    const env = { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), TERM: 'xterm-256color' };
    const { args } = codexLaunch('api_key', { OPENAI_API_KEY: key }, { baseUrl: api.url });
    const built = buildWorkerAdapters(
      {
        tiers: { worker: { adapter: 'pty:codex' } },
        agents: {
          codex: {
            kind: 'pty',
            command: [
              process.execPath,
              CODEX,
              ...args,
              '-c',
              'features.daemon_auto_start=false',
              // No update check: nothing leaves this machine.
              '-c',
              'check_for_update_on_startup=false',
            ],
          },
        },
      },
      { baseEnv: env, ptyCli: { quietMs: 1500 } },
    );
    const adapter = built['pty:codex']?.adapter;
    if (!adapter) throw new Error('no pty:codex');
    const h = await adapter.start({ cwd: checkout, env: { OPENAI_API_KEY: key } });
    void (async () => {
      for await (const _ of adapter.events(h)) {
        // Drained: only the requests the model got are checked.
      }
    })();
    /** What the model was sent for `text` (not Codex's own title request). */
    const turn = async (text: string) => {
      const from = api.requests.length;
      await adapter.send(h, { text });
      for (let i = 0; i < 80; i++) {
        const sent = api.requests.slice(from).filter((r) => !r.text.startsWith('Generate a'));
        if (sent.length > 0 && adapter.status(h) === 'idle') return sent.map((r) => r.text);
        await new Promise((r) => setTimeout(r, 250));
      }
      return api.requests.slice(from).map((r) => r.text);
    };
    try {
      // Without the trailing space Tacet adds, this opened the Mentions popup and was never sent.
      expect(await turn('SAY hi see @note.txt')).toEqual(['SAY hi see @note.txt']);
      // A lone path outside the checkout, plain and quoted: sent as text, no image attached.
      for (const lone of ['../out.png', "'../out.png'"]) {
        const sent = await turn(lone);
        expect(sent).toEqual([`(This message is text, not a file to attach.)\n${lone}`]);
        expect(sent.join('')).not.toContain('<image');
      }
      // The composer is clear: the next prompt is sent as typed.
      expect(await turn('SAY after')).toEqual(['SAY after']);
    } finally {
      await adapter.close(h);
    }
  });
});
