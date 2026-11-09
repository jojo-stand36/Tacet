import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@tacet/mini', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@tacet/mini');
  });
});
