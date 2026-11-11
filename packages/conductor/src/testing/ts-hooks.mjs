// Test only (#23): lets a child `node` process run the workspace's TypeScript sources, as Vitest
// does, so the recovery tests can SIGKILL a real Conductor or Mini-conductor without a build.
// Imports name `.js` files (ESM, NodeNext); the sources are `.ts`.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});
