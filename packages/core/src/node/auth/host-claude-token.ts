import { existsSync } from 'node:fs';

/**
 * Where Claude Code looks for an OAuth token when no `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` is
 * set: a fixed path, whatever `HOME` or `CLAUDE_CONFIG_DIR` say (#291). Seen in the pinned 2.1.319
 * binary's code strings ("CCR_OAUTH_TOKEN_FILE", "This token is injected by the CCR host");
 * documented nowhere (capability matrix, "Claude Code: host OAuth token at a well-known path").
 * It exists in Claude Code's own cloud containers, so a Claude Worker started there can find the
 * host's subscription token although Tacet gave it its own HOME and config dir. Tacet never opens
 * or reads it: only whether it exists is checked.
 */
export const CLAUDE_HOST_TOKEN_FILE = '/home/claude/.claude/remote/.oauth_token';

/**
 * The variable naming a file descriptor Claude Code reads the host's token from first, before the
 * fixed path (#291; same source as above). Never passed to a Worker.
 */
export const CLAUDE_HOST_TOKEN_FD_VAR = 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR';

let defaultFile = CLAUDE_HOST_TOKEN_FILE;

/**
 * For tests only (through `@tacet/core/testing`): the path checked when a caller gives none, so a
 * suite runs the same on a machine that has the real file as on one that does not.
 */
export function setDefaultHostClaudeTokenFile(file: string | undefined): void {
  defaultFile = file ?? CLAUDE_HOST_TOKEN_FILE;
}

export class HostClaudeTokenError extends Error {
  override name = 'HostClaudeTokenError';
}

/**
 * The owner's rule for a Claude Worker on a machine with the host token file (#291, 2026-11-11):
 * with no API key (or cloud provider) for it, refuse, since Claude Code would fall back to that
 * token, the host's subscription and not the user's own auth; with one, start, with a warning,
 * since the docs do not say the key keeps the token from being read. Off a cloud container the
 * file does not exist and nothing happens.
 */
export function checkHostClaudeToken(opts: {
  /** The Worker's environment carries an API key or cloud provider setting. */
  hasKey: boolean;
  warn?: (message: string) => void;
  /** For tests: the path checked. */
  file?: string;
}): void {
  const file = opts.file ?? defaultFile;
  if (!existsSync(file)) return;
  if (!opts.hasKey) {
    throw new HostClaudeTokenError(
      `refusing to start a Claude Worker: ${file} exists (Claude Code's host OAuth token in a ` +
        'Claude Code cloud container), and with no ANTHROPIC_API_KEY or cloud provider set the ' +
        "Worker could use it: the host's subscription, not your own auth (#291). Use the API-key " +
        'route (ANTHROPIC_API_KEY, with auth.interactive: api_key for an interactive session) or a ' +
        'cloud provider.',
    );
  }
  opts.warn?.(
    `${file} exists (Claude Code's host OAuth token in a Claude Code cloud container): ` +
      'Claude Workers here use your API key or cloud provider, but Claude Code may still read ' +
      'that token (#291)',
  );
}
