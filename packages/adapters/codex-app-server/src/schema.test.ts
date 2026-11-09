import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODEX_VERSION } from './adapter.js';

/**
 * Schema drift guard (#12): regenerates the app-server JSON Schema from the pinned Codex and checks
 * that every method, field and enum value this adapter relies on is still there. Bumping
 * `@openai/codex` without updating the adapter fails here first.
 */
describe(`codex app-server schema (pinned ${CODEX_VERSION})`, () => {
  let dir: string;
  const read = (path: string) => readFileSync(join(dir, path), 'utf8');
  const methods = (file: string): string[] =>
    (
      JSON.parse(read(file)) as { oneOf: { properties?: { method?: { enum?: string[] } } }[] }
    ).oneOf.flatMap((o) => o.properties?.method?.enum ?? []);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-codex-schema-'));
    const require = createRequire(import.meta.url);
    const pkg = dirname(require.resolve('@openai/codex/package.json'));
    expect(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version).toBe(CODEX_VERSION);
    execFileSync(
      process.execPath,
      [join(pkg, 'bin', 'codex.js'), 'app-server', 'generate-json-schema', '-o', dir],
      { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir } },
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('has the client requests the adapter sends', () => {
    expect(methods('ClientRequest.json')).toEqual(
      expect.arrayContaining([
        'initialize',
        'account/read',
        'thread/start',
        'thread/resume',
        'thread/fork',
        'turn/start',
        'turn/interrupt',
      ]),
    );
  });

  it('has the server requests and notifications the adapter handles', () => {
    expect(methods('ServerRequest.json')).toEqual(
      expect.arrayContaining([
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'mcpServer/elicitation/request',
        'account/chatgptAuthTokens/refresh',
      ]),
    );
    expect(methods('ServerNotification.json')).toEqual(
      expect.arrayContaining([
        'item/agentMessage/delta',
        'item/started',
        'item/completed',
        'thread/tokenUsage/updated',
        'turn/completed',
      ]),
    );
  });

  it('has the decision values and fields the mapping uses', () => {
    const command = read('CommandExecutionRequestApprovalResponse.json');
    for (const v of ['accept', 'acceptForSession', 'decline', 'cancel']) {
      expect(command).toContain(`"${v}"`);
    }
    expect(command).toContain('acceptWithExecpolicyAmendment');
    expect(read('FileChangeRequestApprovalResponse.json')).toContain('"acceptForSession"');
    const permissions = read('PermissionsRequestApprovalResponse.json');
    expect(permissions).toContain('"scope"');
    expect(permissions).toContain('"session"');
    const turnStart = read('v2/TurnStartParams.json');
    for (const f of ['"effort"', '"model"', '"input"', '"threadId"'])
      expect(turnStart).toContain(f);
    const threadStart = read('v2/ThreadStartParams.json');
    for (const f of ['"config"', '"approvalPolicy"', '"sandbox"', '"developerInstructions"']) {
      expect(threadStart).toContain(f);
    }
    // Resume and fork must accept the thread config too, or they would drop the MCP servers.
    for (const f of ['v2/ThreadResumeParams.json', 'v2/ThreadForkParams.json']) {
      expect(JSON.parse(read(f)).properties).toHaveProperty('config');
    }
    const usage = read('v2/ThreadTokenUsageUpdatedNotification.json');
    for (const f of ['"last"', '"modelContextWindow"', '"inputTokens"', '"outputTokens"']) {
      expect(usage).toContain(f);
    }
    expect(read('ServerNotification.json')).toContain('"interrupted"');
  });
});
