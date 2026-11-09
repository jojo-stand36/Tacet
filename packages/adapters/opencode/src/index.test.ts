import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@tacet/adapter-opencode', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@tacet/adapter-opencode');
  });
});
