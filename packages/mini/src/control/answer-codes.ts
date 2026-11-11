import { randomInt, timingSafeEqual } from 'node:crypto';

/** Crockford's base32: no I, L, O or U, so a code read off a terminal is typed back right. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 8;
/** Wrong codes an escalation takes before its code is withdrawn. */
const MAX_TRIES = 5;

/** Why an answer code was not accepted. */
export type AnswerCodeRefusal = 'none' | 'wrong' | 'withdrawn';

/**
 * One-time codes that let an answer to an Escalation over the control port through (#269, owner
 * decision 2026-11-11): each is random (40 bits), held only in this process's memory, shown
 * only on the terminal of the `tacet run` that serves the port, and never written to the event
 * log, a file or a Worker's environment. Code a Worker wrote may hold the control token (it is
 * in a file the user can read, and so can such code), but not the code: a process cannot read
 * another's terminal. A code is used once; after five wrong tries it is withdrawn, and the next
 * one the terminal shows is new. The long-term fix is sandboxing Worker-written code (#53).
 */
export class AnswerCodes {
  readonly #codes = new Map<string, { code: string; tries: number }>();
  readonly #withdrawn = new Set<string>();

  /** The escalation's code, made the first time it is asked for (or again once withdrawn). */
  issue(escalationId: string): string {
    const known = this.#codes.get(escalationId);
    if (known) return known.code;
    let code = '';
    for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    this.#codes.set(escalationId, { code, tries: 0 });
    this.#withdrawn.delete(escalationId);
    return code;
  }

  /**
   * Check `given` for the escalation without using it up; `undefined` when it is right. Case,
   * spaces and dashes do not matter.
   */
  check(escalationId: string, given: string | undefined): AnswerCodeRefusal | undefined {
    const known = this.#codes.get(escalationId);
    if (!known) return this.#withdrawn.has(escalationId) ? 'withdrawn' : 'none';
    const typed = (given ?? '').toUpperCase().replace(/[\s-]/g, '');
    const a = Buffer.from(typed.padEnd(LENGTH, '\0').slice(0, 64));
    const b = Buffer.from(known.code.padEnd(LENGTH, '\0'));
    const right = a.length === b.length && timingSafeEqual(a, b) && typed.length === LENGTH;
    if (right) return undefined;
    known.tries += 1;
    if (known.tries >= MAX_TRIES) {
      this.#codes.delete(escalationId);
      this.#withdrawn.add(escalationId);
      return 'withdrawn';
    }
    return 'wrong';
  }

  /** Forget the escalation's code: it was answered, or is no longer open. */
  drop(escalationId: string): void {
    this.#codes.delete(escalationId);
    this.#withdrawn.delete(escalationId);
  }
}
