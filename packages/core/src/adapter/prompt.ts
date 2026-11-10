/**
 * Prompts a Worker receives as typed input (#15). Interactive CLIs read some leading characters
 * as commands, not as a message: in Claude Code a prompt starting with `!` runs a shell command
 * with no hook or approval at all, and one starting with `/` runs a slash command, also after
 * leading spaces or invisible characters (verified live on 2.1.319, capability matrix §1). So
 * no prompt Tacet sends may start with either, whichever adapter carries it.
 */

/** Characters an interactive agent CLI may run as a command when a prompt starts with them. */
export const COMMAND_PREFIXES: readonly string[] = ['/', '!'];

/**
 * The command character `text` starts with, after whatever a CLI may skip first (spaces, control,
 * format and combining characters, blank-looking letters), or `undefined`.
 */
export function promptCommandPrefix(text: string): string | undefined {
  const first = text
    .replace(/^[\s\p{Cc}\p{Cf}\p{Z}\p{M}\u115f\u1160\u3164\uffa0\u2800]+/u, '')
    .charAt(0);
  return COMMAND_PREFIXES.includes(first) ? first : undefined;
}

export class UnsafePromptError extends Error {
  override name = 'UnsafePromptError';
}

/** `text`, or `UnsafePromptError` if it starts with a command character. */
export function assertSafePrompt(text: string): string {
  const prefix = promptCommandPrefix(text);
  if (prefix !== undefined) {
    throw new UnsafePromptError(
      `a prompt must not start with "${prefix}": an interactive agent would run it as a command`,
    );
  }
  return text;
}
