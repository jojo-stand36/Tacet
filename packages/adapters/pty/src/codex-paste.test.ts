import { describe, expect, it } from 'vitest';
import { codexPasteText, codexReadsAsPath } from './cli-adapter.js';

/** What Codex CLI 0.167.0 reads a paste as (#249), and how Tacet pastes for it. */
describe('codexPasteText', () => {
  it('reads as one path what Codex would attach as an image', () => {
    // Each of these was attached as an image live, or is a form normalize_pasted_path accepts.
    for (const t of [
      '/tmp/out.png',
      '/tmp/out.png ',
      '\n/tmp/out.png\n',
      "'/tmp/out.png'",
      '"/tmp/my image.png"',
      '/tmp/my\\ image.png',
      'in.png',
      'file:///tmp/out.png',
      'C:\\Users\\x\\a.png',
      '# a heading\n/tmp/out.png',
      "'unclosed /tmp/out.png",
      '',
    ]) {
      expect(codexReadsAsPath(t), JSON.stringify(t)).toBe(true);
    }
    // Several words: sent as text, live (a path on a later line or inside a sentence).
    for (const t of [
      'look at /tmp/out.png please',
      'first line\n/tmp/out.png',
      'see @note.txt',
      'two words',
    ]) {
      expect(codexReadsAsPath(t), JSON.stringify(t)).toBe(false);
    }
  });

  it('ends every paste with a space, and makes a lone path more than one word', () => {
    // The space keeps a trailing @token from leaving the Mentions popup open; Codex trims it.
    expect(codexPasteText('SAY hi see @note.txt')).toBe('SAY hi see @note.txt ');
    expect(codexPasteText('line one\nsee @note.txt')).toBe('line one\nsee @note.txt ');
    const lone = codexPasteText('/tmp/out.png');
    expect(lone).toBe('(This message is text, not a file to attach.)\n/tmp/out.png ');
    expect(codexReadsAsPath(lone)).toBe(false);
    for (const t of ["'/tmp/out.png'", 'file:///tmp/out.png', '# h\n/tmp/out.png']) {
      expect(codexReadsAsPath(codexPasteText(t)), t).toBe(false);
    }
  });
});
