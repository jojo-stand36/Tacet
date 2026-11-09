import { packageName as coreName } from '@tacet/core';
import { describe, expect, it } from 'vitest';

describe('workspace resolution', () => {
  it('imports @tacet/core from source without a build', () => {
    expect(coreName).toBe('@tacet/core');
  });
});
