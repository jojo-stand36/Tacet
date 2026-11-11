import { describe, expect, it } from 'vitest';
import { codexPasteText, codexReadsAsPath } from './cli-adapter.js';

/** What Codex CLI 0.167.0 reads a paste as (#249), and how Tacet pastes for it. */
describe('codexPasteText', () => {
  it('reads as one path what Codex would attach as an image', () => {
    // Each of these was attached as an image live, or is a form normalize_pasted_path accepts
    // that ends in an extension the image crate decodes.
    for (const t of [
      '/tmp/out.png',
      '/tmp/out.png ',
      '\n/tmp/out.png\n',
      "'/tmp/out.png'",
      '"/tmp/my image.png"',
      '/tmp/my\\ image.png',
      '/tmp/out.p\\ng',
      'in.PNG',
      '../a.jpeg',
      'C:\\Users\\x\\a.webp',
      '# a heading\n/tmp/out.png',
      "'unclosed /tmp/out.png",
      // Any file: URL, even split by a newline or hiding its extension.
      'file:///tmp/out.png',
      'fi\nle:///tmp/out.png',
      'file:///tmp/out.%70ng',
    ]) {
      expect(codexReadsAsPath(t), JSON.stringify(t)).toBe(true);
    }
    // Several words, or one word that is no image: sent as text (live for the first two).
    for (const t of [
      'look at /tmp/out.png please',
      'first line\n/tmp/out.png',
      'see @note.txt',
      'continue',
      'y',
      'note.txt',
      '',
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
    // An answer to a CLI's own question is not changed.
    expect(codexPasteText('y')).toBe('y ');
    for (const t of ["'/tmp/out.png'", 'file:///tmp/out.png', '# h\n/tmp/out.png']) {
      expect(codexReadsAsPath(codexPasteText(t)), t).toBe(false);
    }
  });
});
