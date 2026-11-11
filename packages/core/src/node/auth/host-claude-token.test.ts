import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_HOST_TOKEN_FILE,
  checkHostClaudeToken,
  HostClaudeTokenError,
} from './host-claude-token.js';

describe('checkHostClaudeToken (#291)', () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tacet-host-token-'));
    file = join(root, '.oauth_token');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("checks Claude Code's fixed path by default", () => {
    expect(CLAUDE_HOST_TOKEN_FILE).toBe('/home/claude/.claude/remote/.oauth_token');
  });

  it('checks a path no machine has in tests unless one is given (vitest.setup.ts)', () => {
    // Even in a Claude Code cloud container, where the real file exists.
    expect(() => checkHostClaudeToken({ hasKey: false })).not.toThrow();
  });

  it('does nothing when the file does not exist', () => {
    const warnings: string[] = [];
    for (const hasKey of [true, false]) {
      checkHostClaudeToken({ hasKey, file, warn: (m) => warnings.push(m) });
    }
    expect(warnings).toEqual([]);
  });

  it('refuses with no key, and warns with one, never reading the file', () => {
    writeFileSync(file, 'secret-content');
    // Unreadable to anyone but root: only its existence is looked at.
    chmodSync(file, 0o000);
    expect(() => checkHostClaudeToken({ hasKey: false, file })).toThrow(HostClaudeTokenError);
    expect(() => checkHostClaudeToken({ hasKey: false, file })).toThrow(/ANTHROPIC_API_KEY/);
    const warnings: string[] = [];
    checkHostClaudeToken({ hasKey: true, file, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([expect.stringContaining(file)]);
    expect(warnings.join('')).not.toContain('secret-content');
    // With a key and nobody to tell, it starts quietly.
    expect(() => checkHostClaudeToken({ hasKey: true, file })).not.toThrow();
  });
});
