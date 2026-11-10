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
        'thread/read',
        'turn/start',
        'turn/interrupt',
        'model/list',
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

  it('has the model/list fields and thread effort the effort check reads (#110)', () => {
    const params = JSON.parse(read('v2/ModelListParams.json')).properties;
    expect(params).toHaveProperty('includeHidden');
    expect(params).toHaveProperty('cursor');
    const list = JSON.parse(read('v2/ModelListResponse.json'));
    expect(list.properties).toHaveProperty('data');
    expect(list.properties).toHaveProperty('nextCursor');
    const model = list.definitions.Model.properties;
    for (const f of ['id', 'model', 'isDefault', 'supportedReasoningEfforts']) {
      expect(model).toHaveProperty(f);
    }
    expect(list.definitions.ReasoningEffortOption.properties).toHaveProperty('reasoningEffort');
    // A resumed thread reports the effort it keeps, so later model switches can be checked.
    for (const f of ['ThreadStartResponse', 'ThreadResumeResponse', 'ThreadForkResponse']) {
      const props = JSON.parse(read(`v2/${f}.json`)).properties;
      expect(props, f).toHaveProperty('model');
      expect(props, f).toHaveProperty('reasoningEffort');
    }
  });

  it('has the source-thread fields a fork reads and the fork params it sends (#175)', () => {
    expect(JSON.parse(read('v2/ThreadReadParams.json')).properties).toHaveProperty('threadId');
    const thread = JSON.parse(read('v2/ThreadReadResponse.json')).definitions.Thread.properties;
    expect(thread).toHaveProperty('model');
    expect(thread).toHaveProperty('reasoningEffort');
    expect(JSON.parse(read('v2/ThreadForkParams.json')).properties).toHaveProperty('model');
  });
});
