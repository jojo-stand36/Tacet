import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources, so tests never need a prior build
  // and never run against a stale dist/. Only Vitest uses this condition; tsc keeps resolving
  // to dist/ through project references.
  resolve: { conditions: ['@tacet/source'] },
  ssr: { resolve: { conditions: ['@tacet/source'] } },
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
