import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@tacet/core', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@tacet/core');
  });
});
