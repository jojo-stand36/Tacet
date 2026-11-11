import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assistantLine, ID } from './testing/transcript-line.js';
import { contextWindow, findTranscript, TranscriptReader } from './transcript.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tacet-transcript-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function project(name = '-work-tree'): string {
  const dir = join(root, 'projects', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('findTranscript', () => {
  it('finds the one <id>.jsonl in a project directory', () => {
    const file = join(project(), `${ID}.jsonl`);
    writeFileSync(file, '');
    writeFileSync(join(project(), 'other.jsonl'), '');
    expect(findTranscript(root, ID)).toBe(file);
  });

  it('finds nothing before Claude Code writes it, or with no projects directory', () => {
    expect(findTranscript(root, ID)).toBeUndefined();
    project();
    expect(findTranscript(root, ID)).toBeUndefined();
  });

  it('refuses an ambiguous session (two project directories)', () => {
    writeFileSync(join(project('-a'), `${ID}.jsonl`), '');
    writeFileSync(join(project('-b'), `${ID}.jsonl`), '');
    expect(findTranscript(root, ID)).toBeUndefined();
  });

  it('follows no symlink: not the file, not its directory, not projects', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'tacet-transcript-out-'));
    try {
      const target = join(elsewhere, `${ID}.jsonl`);
      writeFileSync(target, assistantLine('m1', { input: 1 }));
      symlinkSync(target, join(project(), `${ID}.jsonl`));
      expect(findTranscript(root, ID)).toBeUndefined();
      rmSync(join(root, 'projects'), { recursive: true });
      mkdirSync(join(root, 'projects'));
      symlinkSync(elsewhere, join(root, 'projects', '-linked'));
      expect(findTranscript(root, ID)).toBeUndefined();
      rmSync(join(root, 'projects'), { recursive: true });
      symlinkSync(elsewhere, join(root, 'projects'));
      expect(findTranscript(root, ID)).toBeUndefined();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('takes only a session id, never a path', () => {
    writeFileSync(join(project(), 'x.jsonl'), '');
    expect(findTranscript(root, '../x')).toBeUndefined();
    expect(findTranscript(root, 'x')).toBeUndefined();
  });
});

describe('TranscriptReader', () => {
  it('reads each call once, with its last line’s usage, as the transcript grows', () => {
    const file = join(project(), `${ID}.jsonl`);
    const reader = new TranscriptReader(() => findTranscript(root, ID));
    expect(reader.read()).toEqual([]);
    writeFileSync(
      file,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n` +
        assistantLine('m1', { input: 3, created: 100, read: 1000, output: 1 }) +
        // A second content block of the same call: its usage is final.
        assistantLine('m1', { input: 3, created: 100, read: 1000, output: 40 }) +
        assistantLine(
          's1',
          { input: 7, output: 2 },
          { sidechain: true, model: 'claude-haiku-4-5' },
        ),
    );
    expect(reader.read()).toEqual([
      { inputTokens: 1103, outputTokens: 40, model: 'claude-sonnet-4-5', sidechain: false },
      { inputTokens: 7, outputTokens: 2, model: 'claude-haiku-4-5', sidechain: true },
    ]);
    expect(reader.read()).toEqual([]);
    // A line written in two parts is read once it ends; a known id is not read again.
    const next = assistantLine('m2', { input: 5, output: 6 });
    appendFileSync(file, assistantLine('m1', { input: 999 }) + next.slice(0, 20));
    expect(reader.read()).toEqual([]);
    appendFileSync(file, next.slice(20));
    expect(reader.read()).toEqual([
      { inputTokens: 5, outputTokens: 6, model: 'claude-sonnet-4-5', sidechain: false },
    ]);
  });

  it('skips synthetic messages, broken lines and odd counts', () => {
    const file = join(project(), `${ID}.jsonl`);
    writeFileSync(
      file,
      'not json "assistant"\n' +
        assistantLine('e1', { input: 0 }, { model: '<synthetic>' }) +
        `${JSON.stringify({ type: 'assistant', message: { id: 'n1', usage: { input_tokens: -4, output_tokens: 1.5 } } })}\n` +
        `${JSON.stringify({ type: 'assistant', message: { id: 'n2' } })}\n`,
    );
    expect(new TranscriptReader(() => findTranscript(root, ID)).read()).toEqual([
      { inputTokens: 0, outputTokens: 0, model: undefined, sidechain: false },
    ]);
  });

  it('skip() takes a resumed session’s history as reported', () => {
    const file = join(project(), `${ID}.jsonl`);
    writeFileSync(file, assistantLine('old', { input: 50, output: 5 }));
    const reader = new TranscriptReader(() => findTranscript(root, ID));
    reader.skip();
    appendFileSync(file, assistantLine('new', { input: 60, output: 6 }));
    expect(reader.read().map((c) => c.inputTokens)).toEqual([60]);
  });

  it('reads a rewritten transcript again without counting calls twice', () => {
    const file = join(project(), `${ID}.jsonl`);
    writeFileSync(file, assistantLine('m1', { input: 1 }) + assistantLine('m2', { input: 2 }));
    const reader = new TranscriptReader(() => findTranscript(root, ID));
    expect(reader.read()).toHaveLength(2);
    writeFileSync(file, assistantLine('m3', { input: 3 }));
    expect(reader.read().map((c) => c.inputTokens)).toEqual([3]);
  });
});

describe('contextWindow', () => {
  it('knows the verified windows, in the id forms Claude Code meets', () => {
    expect(contextWindow('claude-opus-5-5', undefined, {})).toBe(1_000_000);
    expect(contextWindow('claude-sonnet-4-5', undefined, {})).toBe(200_000);
    expect(contextWindow('claude-sonnet-4-5-20250929', undefined, {})).toBe(200_000);
    expect(contextWindow('claude-haiku-4-5@20251001', undefined, {})).toBe(200_000);
    expect(contextWindow('us.anthropic.claude-opus-4-8', undefined, {})).toBe(1_000_000);
    expect(contextWindow('anthropic.claude-sonnet-4-5-20250929-v1:0', undefined, {})).toBe(200_000);
    expect(contextWindow('claude-fable-5-2[1m]', undefined, {})).toBe(1_000_000);
  });

  it('gives 1M to Opus and Sonnet 4.6 only with [1m] at launch', () => {
    expect(contextWindow('claude-opus-4-6', undefined, {})).toBe(200_000);
    expect(contextWindow('claude-opus-4-6', 'claude-opus-4-6', {})).toBe(200_000);
    expect(contextWindow('claude-opus-4-6', 'claude-opus-4-6[1m]', {})).toBe(1_000_000);
    expect(contextWindow('claude-sonnet-4-6', 'sonnet[1M]', {})).toBe(1_000_000);
  });

  it('leaves an unknown model unknown, and follows the Worker’s environment', () => {
    expect(contextWindow('mock-model', undefined, {})).toBeUndefined();
    expect(contextWindow(undefined, undefined, {})).toBeUndefined();
    expect(
      contextWindow('claude-opus-5-5', undefined, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }),
    ).toBe(200_000);
    const override = { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '300000' };
    expect(contextWindow('mock-model', undefined, override)).toBe(300_000);
    expect(
      contextWindow('claude-opus-5-5', undefined, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: 'x' }),
    ).toBe(1_000_000);
  });
});
