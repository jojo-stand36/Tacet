/** PTY fallback adapter (#15): interactive CLIs in a pseudo-terminal, state from their hooks. */
export const packageName = '@tacet/adapter-pty' as const;

export { CLAUDE_PTY_CAPABILITIES, PtyAdapter, type PtyAdapterOptions } from './adapter.js';
export { CLAUDE_PTY_VERIFIED_VERSION } from './claude.js';
export {
  PTY_CLI_CAPABILITIES,
  PTY_LAST_SESSION,
  PtyCliAdapter,
  type PtyCliAdapterOptions,
  type PtyPreset,
} from './cli-adapter.js';
export { loadPty, PtyUnavailableError } from './pty.js';
export { TerminalBuffer } from './terminal.js';
