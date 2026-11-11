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
      'see\t/abs/a.png',
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
    expect(withoutImagePaths('nothing to change')).toBe('nothing to change');
  });

  it('keeps a trailing backslash or a focus report from undoing the suffix (#244 review)', () => {
    // A trailing backslash would escape the space before the dot: two of them.
    expect(withoutImagePaths('/abs/a.png /tmp/x\\')).toBe('/abs/a.png /tmp/x\\ . .');
    expect(withoutImagePaths('"/a/b.png" /c/d\\')).toBe('"/a/b.png" /c/d\\ . .');
    // Claude Code takes `[I` or `[O` off the end of a paste before its test.
    expect(withoutImagePaths('SAY see x.png[I')).toBe('SAY see x.png[I .');
    expect(withoutImagePaths('first\n/abs/out.png[O')).toBe('first\n/abs/out.png[O .');
    // Only at the very end of the paste: elsewhere `x.png[I` is no image name.
    expect(withoutImagePaths('x.png[I\nnext')).toBe('x.png[I\nnext');
    // A prompt ending in one is never left for Claude Code to take off.
    expect(withoutImagePaths('just text [O')).toBe('just text [O .');
  });
});
