import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..', '..', '..', '..', '..');

/** Every non-test source file under `dir`, never entering `node_modules`, `dist` or dot dirs. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'dist'].includes(e.name) && !e.name.startsWith('.')) {
        out.push(...sources(p));
      }
    } else if (e.isFile() && /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) {
      if (!/\.test\.|\.d\.ts$/.test(e.name)) out.push(relative(repo, p));
    }
  }
  return out;
}

const files = [...sources(join(repo, 'packages')), ...sources(join(repo, 'scripts'))];
const matching = (re: RegExp) =>
  files.filter((f) => re.test(readFileSync(join(repo, f), 'utf8'))).sort();

/**
 * Anything that can open a port or socket: a server constructor or factory (`createServer`,
 * `createSecureServer`, `new http.Server`, `WebSocketServer`), `.listen(` however it is called,
 * a UDP socket, an import of a server-capable core module, or a spawned server.
 */
const LISTENS = new RegExp(
  [
    String.raw`\bcreate\w*Server\s*\(`,
    String.raw`\bnew\s+(\w+\.)?Server\s*\(`,
    String.raw`\bWebSocketServer\b`,
    String.raw`\bcreateSocket\s*\(`,
    String.raw`\.listen\s*\(`,
    String.raw`\[\s*['"]listen['"]\s*\]`,
    String.raw`(\bfrom\s*|\b(require|import)\s*\(\s*)['"](node:)?(net|http|https|http2|dgram)['"]`,
    String.raw`http\.server|--listen\b|\bnc\s+-l`,
  ].join('|'),
);

/** Calls of the audited port primitives: a new port built from them is a new port too. */
const PORT_CALLS =
  /\blistenLoopback\s*\(|\bstartRpcServer\s*\(|\bMiniMcpServer\.start\s*\(|\bnew\s+HookServer\s*\(/;

describe('local ports (#259)', () => {
  // Worker commands reach every port on host loopback (no network isolation, #163), so each
  // port's token is its only boundary. A new listener, or a new use of one of the port
  // primitives, needs the same review: loopback only (`listenLoopback`), Host and Origin checked,
  // its token checked before anything is read or done, tests refusing no token and a wrong one,
  // and a line in ARCHITECTURE §6 ("Local ports"). Then add it here.
  it('opens a listener only where one has been audited', () => {
    expect(matching(LISTENS)).toEqual(
      [
        // The loopback listener every port goes through: 127.0.0.1 and ::1, never a wildcard.
        'packages/core/src/node/auth/listen.ts',
        // The control port (#201): the daemon token on the upgrade, constant-time compare.
        'packages/core/src/node/rpc/ws-server.ts',
        // The Mini-conductor's MCP endpoint: a token per Worker session, scoped to its task.
        'packages/mini/src/mcp/server.ts',
        // The PTY hook endpoint: a token per session, identity from the token only.
        'packages/adapters/pty/src/hook-server.ts',
        // Not a listener: the hook relay is an HTTP client (#164).
        'packages/adapters/pty/src/hook-forward.ts',
        // Test only: local mocks of vendor APIs, no token, imported by tests alone.
        'packages/adapters/acp/src/testing/mock-gemini-api.ts',
        'packages/adapters/claude-sdk/src/testing/mock-messages-api.ts',
        'packages/adapters/codex-app-server/src/testing/mock-responses-api.ts',
      ].sort(),
    );
  });

  it('builds ports from the audited primitives only where audited', () => {
    expect(matching(PORT_CALLS)).toEqual(
      [
        'packages/core/src/node/auth/listen.ts',
        'packages/core/src/node/rpc/ws-server.ts',
        'packages/mini/src/mcp/server.ts',
        'packages/adapters/pty/src/hook-server.ts',
        // The PTY adapter's one hook server per process.
        'packages/adapters/pty/src/adapter.ts',
        // The control port (#201), on `startRpcServer`.
        'packages/mini/src/control/server.ts',
        // The standalone Mini-conductor: its MCP endpoint and control port.
        'packages/mini/src/standalone.ts',
      ].sort(),
    );
  });

  it('recognises the ways code opens a port (#259 review)', () => {
    for (const code of [
      'const wss = new WebSocketServer({ port: 0 });',
      'listenLoopback(() => new http.Server(handler));',
      'const s = http2.createSecureServer(opts);',
      "dgram.createSocket('udp4').bind(0);",
      "srv['listen'](0);",
      'server.listen({ port: 0 });',
      "spawn('python3', ['-m', 'http.server']);",
      "import { createServer } from 'node:net';",
      "const net = require('net');",
      "const { Server } = await import('node:https');",
    ]) {
      expect(LISTENS.test(code), code).toBe(true);
    }
    // An MCP transport named `http`, or a client request, is not a listener.
    for (const code of ["{ type: 'http', url }", 'await fetch(url);']) {
      expect(LISTENS.test(code), code).toBe(false);
    }
  });
});
