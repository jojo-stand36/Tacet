import { describe, expect, it } from 'vitest';
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
    expect(chooseAuthRoute({ interactive: false }, { unattended: 'subscription' })).toBe(
      'subscription',
    );
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
    const env = authEnv('subscription', {
      ANTHROPIC_API_KEY: FAKE,
      ANTHROPIC_AUTH_TOKEN: FAKE,
      PATH: '/bin',
    });
    expect(env).toEqual({ PATH: '/bin' });
  });
});
