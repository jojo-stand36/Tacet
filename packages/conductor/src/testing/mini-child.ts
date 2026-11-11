// Test only (#23): a process that holds a Mini-conductor's link to the Conductor, for the
// recovery tests. argv: <runDir> <repoPath>. Prints each link state as a JSON line.
import { realpathSync } from 'node:fs';
import { dialConductor, repoStatePaths } from '@tacet/core/node';

const [runDir, repo] = process.argv.slice(2);
if (!runDir || !repo) throw new Error('usage: mini-child <runDir> <repoPath>');
const repoPath = realpathSync(repo);
const link = dialConductor({
  card: { repoId: repoStatePaths(repoPath).repoId, repoPath, adapters: [], miniVersion: '0' },
  clientInfo: { name: 'test-mini-child', version: '0' },
  runDir,
  minDelayMs: 50,
  maxDelayMs: 200,
  settleMs: 100,
  onState: (s) => process.stdout.write(`${JSON.stringify(s)}\n`),
});
process.on('SIGTERM', () => {
  void link.close().then(() => process.exit(0));
});
// Keep running: the link's timers are unref'd.
setInterval(() => {}, 60_000);
