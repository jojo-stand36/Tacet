import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@tacet/tui', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@tacet/tui');
  });
});
