// Test only (#23): a Conductor in a process of its own, for the recovery tests.
// argv: <stateDir> <runDir>. Prints `ready <port>` once it serves.
import { startConductor } from '../conductor.js';

const [stateDir, runDir] = process.argv.slice(2);
if (!stateDir || !runDir) throw new Error('usage: conductor-child <stateDir> <runDir>');
const c = await startConductor({ stateDir, runDir, pingIntervalMs: 200 });
process.stdout.write(`ready ${c.port}\n`);
process.on('SIGTERM', () => {
  void c.close().then(() => process.exit(0));
});
