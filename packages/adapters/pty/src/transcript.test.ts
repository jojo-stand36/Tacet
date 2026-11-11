import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
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
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tacet-transcript-'));
  outside = mkdtempSync(join(tmpdir(), 'tacet-transcript-out-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function project(name = '-work-tree'): string {
  const dir = join(root, 'projects', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const reader = () => new TranscriptReader(() => findTranscript(root, ID));
const call = (inputTokens: number, outputTokens: number, model = 'claude-sonnet-4-5') => ({
  inputTokens,
  outputTokens,
  contextUsed: inputTokens + outputTokens,
  model,
});

describe('findTranscript', () => {
  it('finds the one <id>.jsonl in a project directory', () => {
    const file = join(project(), `${ID}.jsonl`);
    writeFileSync(file, '');
    writeFileSync(join(project(), 'other.jsonl'), '');
    expect(findTranscript(root, ID)?.path).toBe(file);
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
    const target = join(outside, `${ID}.jsonl`);
    writeFileSync(target, assistantLine('m1', { input: 1 }));
    symlinkSync(target, join(project(), `${ID}.jsonl`));
    expect(findTranscript(root, ID)).toBeUndefined();
    rmSync(join(root, 'projects'), { recursive: true });
    mkdirSync(join(root, 'projects'));
    symlinkSync(outside, join(root, 'projects', '-linked'));
    expect(findTranscript(root, ID)).toBeUndefined();
    rmSync(join(root, 'projects'), { recursive: true });
    symlinkSync(outside, join(root, 'projects'));
    expect(findTranscript(root, ID)).toBeUndefined();
  });

  it('refuses a hard link (it passes every path check)', () => {
    const target = join(outside, `${ID}.jsonl`);
    writeFileSync(target, assistantLine('leak', { input: 666 }));
    linkSync(target, join(project(), `${ID}.jsonl`));
    expect(findTranscript(root, ID)).toBeUndefined();
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
    const r = reader();
    expect(r.read()).toEqual([]);
    writeFileSync(
      file,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n` +
        assistantLine('m1', { input: 3, created: 100, read: 1000, output: 1 }) +
        // A second content block of the same call: its usage is final.
        assistantLine('m1', { input: 3, created: 100, read: 1000, output: 40 }),
    );
    expect(r.read()).toEqual([call(1103, 40)]);
    expect(r.read()).toEqual([]);
    // A line written in two parts is read once it ends.
    const next = assistantLine('m2', { input: 5, output: 6 });
    appendFileSync(file, next.slice(0, 20));
    expect(r.read()).toEqual([]);
    appendFileSync(file, next.slice(20));
    expect(r.read()).toEqual([call(5, 6)]);
  });

  it('reports what a call’s later line adds, when a read fell between its lines', () => {
    const file = join(project(), `${ID}.jsonl`);
    const r = reader();
    writeFileSync(file, assistantLine('m1', { input: 10, read: 90, output: 1 }));
    expect(r.read()).toEqual([call(100, 1)]);
    appendFileSync(file, assistantLine('m1', { input: 10, read: 90, output: 50 }));
    // A delta, with the context gauge after the whole call.
    expect(r.read()).toEqual([{ ...call(0, 49), contextUsed: 150 }]);
    // An earlier line seen again (a rewrite) adds nothing.
    appendFileSync(file, assistantLine('m1', { input: 10, read: 90, output: 1 }));
    expect(r.read()).toEqual([]);
  });

  it('leaves subagent calls out, as the claude-sdk adapter does', () => {
    writeFileSync(
      join(project(), `${ID}.jsonl`),
      assistantLine('s1', { input: 7, output: 2 }, { sidechain: true }) +
        assistantLine('m1', { input: 1, output: 1 }),
    );
    expect(reader().read()).toEqual([call(1, 1)]);
  });

  it('skips synthetic messages, broken lines and odd counts', () => {
    writeFileSync(
      join(project(), `${ID}.jsonl`),
      'not json "assistant"\n' +
        assistantLine('e1', { input: 0 }, { model: '<synthetic>' }) +
        `${JSON.stringify({ type: 'assistant', message: { id: 'n1', usage: { input_tokens: -4, output_tokens: 1.5, cache_read_input_tokens: 3 } } })}\n` +
        `${JSON.stringify({ type: 'assistant', message: { id: 'n2' } })}\n`,
    );
    expect(reader().read()).toEqual([
      { inputTokens: 3, outputTokens: 0, contextUsed: 3, model: undefined },
    ]);
  });

  it('drops an over-long line and reads on after it', () => {
    const file = join(project(), `${ID}.jsonl`);
    const r = reader();
    writeFileSync(file, `{"type":"assistant","x":"${'a'.repeat(5 * 1024 * 1024)}`);
    expect(r.read()).toEqual([]);
    appendFileSync(file, `"}\n${assistantLine('m1', { input: 2, output: 3 })}`);
    expect(r.read()).toEqual([call(2, 3)]);
  });

  it('skip() takes a resumed session’s history as reported, also once it first appears', () => {
    const file = join(project(), `${ID}.jsonl`);
    writeFileSync(file, assistantLine('old', { input: 50, output: 5 }));
    const r = reader();
    r.skip();
    appendFileSync(file, assistantLine('new', { input: 60, output: 6 }));
    expect(r.read()).toEqual([call(60, 6)]);

    // Not found at skip() (two project directories for a moment): applied when it is.
    rmSync(join(root, 'projects'), { recursive: true });
    const late = join(project('-a'), `${ID}.jsonl`);
    writeFileSync(late, assistantLine('old', { input: 50, output: 5 }));
    writeFileSync(join(project('-b'), `${ID}.jsonl`), '');
    const r2 = reader();
    r2.skip();
    rmSync(join(root, 'projects', '-b'), { recursive: true });
    expect(r2.read()).toEqual([]);
    appendFileSync(late, assistantLine('new', { input: 60, output: 6 }));
    expect(r2.read()).toEqual([call(60, 6)]);
  });

  it('reads a rewritten transcript again without counting calls twice', () => {
    const file = join(project(), `${ID}.jsonl`);
    const padding = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } })}\n`;
    writeFileSync(
      file,
      assistantLine('m1', { input: 1 }) + assistantLine('m2', { input: 2 }) + padding,
    );
    const r = reader();
    expect(r.read()).toHaveLength(2);
    // Shorter than before: read from the start; m2 was reported already.
    writeFileSync(file, assistantLine('m2', { input: 2 }) + assistantLine('m3', { input: 3 }));
    expect(r.read()).toEqual([call(3, 0)]);
  });

  describe('once found, reads only that same file (#255 review)', () => {
    let file: string;
    let r: TranscriptReader;
    beforeEach(() => {
      file = join(project('-wt'), `${ID}.jsonl`);
      writeFileSync(file, assistantLine('m1', { input: 1 }));
      r = reader();
      expect(r.read()).toEqual([call(1, 0)]);
      writeFileSync(join(outside, `${ID}.jsonl`), assistantLine('leak', { input: 666 }));
    });

    it('refuses the file swapped for a symlink', () => {
      rmSync(file);
      symlinkSync(join(outside, `${ID}.jsonl`), file);
      expect(r.read()).toEqual([]);
    });

    it('refuses its directory swapped for a symlink', () => {
      renameSync(join(root, 'projects', '-wt'), join(root, 'projects', '-old'));
      symlinkSync(outside, join(root, 'projects', '-wt'));
      expect(r.read()).toEqual([]);
    });

    it('refuses another regular file put in its place', () => {
      rmSync(file);
      writeFileSync(file, assistantLine('leak', { input: 666 }));
      expect(r.read()).toEqual([]);
    });

    it('refuses it once it gains a second link', () => {
      linkSync(file, join(outside, 'copy.jsonl'));
      appendFileSync(file, assistantLine('m2', { input: 2 }));
      expect(r.read()).toEqual([]);
    });

    it('never blocks on a FIFO put in its place', () => {
      rmSync(file);
      execFileSync('mkfifo', [file]);
      // Would hang here, with no writer, if the open blocked.
      expect(r.read()).toEqual([]);
    });
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
    // The override is for models Claude Code does not know: the scope the matrix records.
    const override = { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '300000' };
    expect(contextWindow('mock-model', undefined, override)).toBe(300_000);
    expect(contextWindow('claude-opus-5-5', undefined, override)).toBe(1_000_000);
    expect(
      contextWindow('mock-model', undefined, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: 'x' }),
    ).toBeUndefined();
  });
});
