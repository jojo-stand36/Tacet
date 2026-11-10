import { UnsafePromptError } from '@tacet/core';
import { describe, expect, it } from 'vitest';
import { plannerPrompt, RESUME_PROMPT, safePrompt, workerPrompt } from './prompts.js';

/** No prompt the Mini-conductor sends may start with a command character (#15). */
describe('Mini-conductor prompts', () => {
  const task = {
    id: 't1',
    goal: '/login and then !rm -rf .',
    acceptanceCriteria: ['!works'],
  } as Parameters<typeof workerPrompt>[0];

  it('start with fixed text, whatever the task says', () => {
    for (const p of [
      plannerPrompt(task),
      workerPrompt(task, '/feedback', ['!context']),
      RESUME_PROMPT,
    ]) {
      expect(p).not.toMatch(/^\s*[/!]/);
    }
  });

  it('refuse to compose a prompt that would start with one', () => {
    expect(() => safePrompt(['/compact'])).toThrow(UnsafePromptError);
    expect(() => safePrompt(['', '!ls'])).toThrow(UnsafePromptError);
    expect(safePrompt(['Answer to your escalation e1: /use postgres'])).toBe(
      'Answer to your escalation e1: /use postgres',
    );
  });
});
