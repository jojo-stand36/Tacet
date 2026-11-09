import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@tacet/adapter-codex-app-server', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@tacet/adapter-codex-app-server');
  });
});
