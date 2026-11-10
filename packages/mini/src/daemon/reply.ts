/**
 * The longest model reply the Mini-conductor parses (#203): characters, not tokens. A planner or
 * reviewer reply is a short JSON document; anything longer is treated as an invalid reply.
 */
export const MAX_REPLY_CHARS = 256 * 1024;

/**
 * A model's JSON reply with a Markdown code fence around it removed (```` ``` ```` or
 * ```` ```json ````), in linear time (#203). The input is model text that can be steered by what
 * a Worker wrote, so no backtracking regex runs on it: the old `/\s*```$/` took seconds on a long
 * run of whitespace and blocked the Mini-conductor's event loop. Throws if the reply is longer
 * than `MAX_REPLY_CHARS`.
 */
export function unfence(text: string): string {
  if (text.length > MAX_REPLY_CHARS) {
    throw new Error(`the reply is longer than ${MAX_REPLY_CHARS} characters`);
  }
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.slice(3);
    if (s.slice(0, 4).toLowerCase() === 'json') s = s.slice(4);
    s = s.trimStart();
  }
  if (s.endsWith('```')) s = s.slice(0, -3).trimEnd();
  return s;
}
