import { describe, expect, it } from 'vitest';
import { assertSafePrompt, promptCommandPrefix, UnsafePromptError } from './prompt.js';

describe('prompt command prefixes', () => {
  it.each([
    ['/login', '/'],
    ['!rm -rf .', '!'],
    ['  !x', '!'],
    ['​/status', '/'],
    ['\n\n/x', '/'],
    ['ㅤ/x', '/'],
    ['️/x', '/'],
    ['͏!x', '!'],
    ['⠀/x', '/'],
  ])('%j starts with a command', (text, prefix) => {
    expect(promptCommandPrefix(text)).toBe(prefix);
    expect(() => assertSafePrompt(text)).toThrow(UnsafePromptError);
  });
  it.each(['Sub-task: fix /etc/hosts handling', '# notes', 'see !important', ''])(
    '%j does not',
    (text) => {
      expect(promptCommandPrefix(text)).toBeUndefined();
      expect(assertSafePrompt(text)).toBe(text);
    },
  );
});
