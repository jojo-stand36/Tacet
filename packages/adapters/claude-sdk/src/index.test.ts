import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@tacet/adapter-claude-sdk', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@tacet/adapter-claude-sdk');
  });
});
