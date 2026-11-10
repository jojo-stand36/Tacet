import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..', '..', '..', '..', '..');

/** Every non-test source file under `dir`, never entering `node_modules`, `dist` or `testing`. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', 'testing'].includes(e.name) && !e.name.startsWith('.')) {
        out.push(...sources(p));
      }
    } else if (
      e.isFile() &&
      /\.(ts|mts|js|mjs)$/.test(e.name) &&
      !/\.test\.|\.d\.ts$/.test(e.name)
    ) {
      out.push(relative(repo, p));
    }
  }
  return out;
}

describe('local ports (#259)', () => {
  it('opens a listener only where one has been audited', () => {
    // Worker commands reach every port on host loopback (no network isolation, #163, #259), so
    // each port's token is its only boundary. A new listener needs the same review: loopback only
    // (`listenLoopback`), Host and Origin checked, its token checked before anything is read or
    // done, a test refusing no token and a wrong one, and a line in ARCHITECTURE §6 ("Local ports").
    const listeners = sources(join(repo, 'packages')).filter((f) =>
      /\bcreateServer\s*\(|\.listen\s*\(/.test(readFileSync(join(repo, f), 'utf8')),
    );
    expect(listeners.sort()).toEqual(
      [
        // The loopback listener every port goes through: 127.0.0.1 and ::1, never a wildcard.
        'packages/core/src/node/auth/listen.ts',
        // The control port (#201): daemon bearer token on the upgrade, constant-time compare.
        'packages/core/src/node/rpc/ws-server.ts',
        // The Mini-conductor's MCP endpoint: a per-Worker token, scoped to its task.
        'packages/mini/src/mcp/server.ts',
        // The PTY adapter's hook endpoint: a per-session token, identity from the token only.
        'packages/adapters/pty/src/hook-server.ts',
      ].sort(),
    );
  });
});
