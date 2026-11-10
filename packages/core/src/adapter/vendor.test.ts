import { describe, expect, it } from 'vitest';
import { vendorOf } from './vendor.js';

describe('vendorOf', () => {
  it.each([
    ['claude-sdk', 'anthropic'],
    ['pty:claude', 'anthropic'],
    ['acp:claude-acp', 'anthropic'],
    ['codex-app-server', 'openai'],
    ['acp:codex-acp', 'openai'],
    ['acp:gemini', 'google'],
    ['opencode', undefined],
    ['acp:my-agent', undefined],
    ['pty:aider', undefined],
  ])('%s → %s', (id, vendor) => {
    expect(vendorOf(id)).toBe(vendor);
  });

  it('takes the vendor a tier declares over the built-in one', () => {
    expect(vendorOf('opencode', { vendor: 'google' })).toBe('google');
    expect(vendorOf('claude-sdk', { vendor: 'openai' })).toBe('openai');
  });
});
