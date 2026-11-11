// Test only (#23): lets a child `node` process run the workspace's TypeScript sources, as Vitest
// does, so the recovery tests can SIGKILL a real Conductor or Mini-conductor without a build.
// Node strips the types itself; this only maps the `.js` names imports use (ESM, NodeNext) to the
// `.ts` sources. The child also needs `--conditions=@tacet/source`, so workspace packages resolve
// to their sources.
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
