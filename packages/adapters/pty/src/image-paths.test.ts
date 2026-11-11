import { describe, expect, it } from 'vitest';
import { claudeReadsImagePath, withoutImagePaths } from './adapter.js';

/** Claude Code 2.1.319's pasted-image test, as `pty:claude` neutralises it (#244). */
describe('withoutImagePaths', () => {
  it('finds what Claude Code would take for an image file', () => {
    for (const line of [
      'SAY see in.png',
      'in.png',
      '../outside.PNG',
      '/abs/out.jpg',
      '"/abs/my out.jpeg"',
      "'/abs/out.gif'",
      'a.webp',
      '/abs/a.png /abs/b.txt',
      'my\\ shot.png',
      '/abs/a.p\\ng',
      'see /abs/a.png',
    ]) {
      expect(claudeReadsImagePath(line), line).toBe(true);
    }
    for (const line of [
      'SAY see in.png now',
      'note.txt',
      'a.png.txt',
      'SAY see /abs/a.png please',
      '',
      'png',
    ]) {
      expect(claudeReadsImagePath(line), line).toBe(false);
    }
  });

  it('ends each such line with " .", which nothing then reads, and leaves the rest', () => {
    const text = 'Do the task.\nSee in.png\n/abs/out.png\nThen stop.';
    const out = withoutImagePaths(text);
    expect(out).toBe('Do the task.\nSee in.png .\n/abs/out.png .\nThen stop.');
    for (const line of out.split('\n')) {
      // Every part of every line now ends in something other than an image extension.
      expect(
        line
          .split(/ (?=["']?(?:\/|[A-Za-z]:\\))/)
          .some((p) => /\.(png|jpe?g|gif|webp)$/i.test(p.trim())),
      ).toBe(false);
    }
    expect(withoutImagePaths('nothing to change')).toBe('nothing to change');
  });
});
