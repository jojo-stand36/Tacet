import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostClaudeTokenError } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthRoutingError, authEnv, chooseAuthRoute } from './auth.js';

// Fake values only: these tests never see real credentials.
const FAKE = 'fake-key-for-tests';

describe('chooseAuthRoute', () => {
  it('defaults to the API key unattended and the own login interactively', () => {
    expect(chooseAuthRoute({ interactive: false })).toBe('api_key');
    expect(chooseAuthRoute({ interactive: true })).toBe('subscription');
  });
  it('follows config', () => {
    expect(chooseAuthRoute({ interactive: true }, { interactive: 'api_key' })).toBe('api_key');
    // Unattended sessions always use the API key (#65), whatever is passed.
    const unchecked = { unattended: 'subscription' } as unknown as { unattended: 'api_key' };
    expect(chooseAuthRoute({ interactive: false }, unchecked)).toBe('api_key');
  });
});

describe('authEnv', () => {
  it('api_key passes the key through untouched', () => {
    const env = authEnv('api_key', { ANTHROPIC_API_KEY: FAKE, PATH: '/bin', UNSET: undefined });
    expect(env).toEqual({ ANTHROPIC_API_KEY: FAKE, PATH: '/bin' });
  });
  it('api_key accepts a cloud provider instead of a key', () => {
    expect(() => authEnv('api_key', { CLAUDE_CODE_USE_BEDROCK: '1' })).not.toThrow();
  });
  it('api_key refuses to fall back to the subscription login', () => {
    expect(() => authEnv('api_key', { PATH: '/bin' })).toThrow(AuthRoutingError);
    expect(() => authEnv('api_key', { CLAUDE_CODE_USE_VERTEX: '0' })).toThrow(AuthRoutingError);
  });
  it('the error never includes environment values', () => {
    expect(() => authEnv('api_key', { SOME_TOKEN: FAKE })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(FAKE) }),
    );
  });
  it('subscription removes API-key variables so the own login applies', () => {
    const env = authEnv(
      'subscription',
      { ANTHROPIC_API_KEY: FAKE, ANTHROPIC_AUTH_TOKEN: FAKE, PATH: '/bin' },
      { file: '/nonexistent/tacet-291/.oauth_token' },
    );
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe("Claude Code's host token at its fixed path (#291)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-291-'));
    file = join(dir, '.oauth_token');
    // A stand-in: Tacet only checks that it exists, never reads it.
    writeFileSync(file, '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a login session that could fall back to it', () => {
    expect(() => authEnv('subscription', { PATH: '/bin' }, { file })).toThrow(HostClaudeTokenError);
    expect(() => authEnv('subscription', { PATH: '/bin' }, { file })).toThrow(
      /Set ANTHROPIC_API_KEY/,
    );
  });

  it('warns once a key or cloud provider is set, and starts', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(authEnv('api_key', { ANTHROPIC_API_KEY: FAKE }, { file, warn })).toEqual({
      ANTHROPIC_API_KEY: FAKE,
    });
    expect(authEnv('subscription', { CLAUDE_CODE_USE_BEDROCK: '1' }, { file, warn })).toEqual({
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(file);
    // The key's value never appears.
    expect(warnings.join('')).not.toContain(FAKE);
  });

  it('does nothing where there is no such file', () => {
    const warnings: string[] = [];
    rmSync(file);
    authEnv('api_key', { ANTHROPIC_API_KEY: FAKE }, { file, warn: (m) => warnings.push(m) });
    expect(() => authEnv('subscription', { PATH: '/bin' }, { file })).not.toThrow();
    expect(warnings).toEqual([]);
  });
});
