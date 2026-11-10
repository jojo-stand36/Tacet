import { describe, expect, it } from 'vitest';
import { assertSafePrompt, promptCommandPrefix, UnsafePromptError } from './prompt.js';

describe('prompt command prefixes', () => {
  it.each([
    ['/login', '/'],
    ['!rm -rf .', '!'],
    ['  !x', '!'],
    ['\u200b/status', '/'],
    ['\n\n/x', '/'],
    ['\u3164/x', '/'],
    ['\ufe0f/x', '/'],
    ['\u034f!x', '!'],
    ['\u2800/x', '/'],
    ['\x01/x', '/'],
    ['\x1b!x', '!'],
    ['\u0085/x', '/'],
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
