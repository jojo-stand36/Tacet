import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
// The reference implementation, as a test oracle only (#201): a devDependency, never imported
// by shipped code (see the guard below).
import * as sdk from '@a2a-js/sdk';
import { describe, expect, it } from 'vitest';
import { statusEntries, toA2ATask } from '../events/status.js';
import {
  A2ACancelTaskRequest,
  A2AGetTaskRequest,
  A2AListTasksRequest,
  A2AListTasksResponse,
  A2AMessage,
  A2ASendMessageRequest,
  A2ASendMessageResponse,
  A2ATask,
} from './a2a.js';
import { DECISION_EXT_URI } from './decision.js';
import { STATUS_EXT_URI, StatusExt } from './status-ext.js';

const example = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'examples', 'v1', 'status-ext.json'), 'utf8'),
) as StatusExt;
const entry = { id: '01JCX5Z9Q4W8E7R6T5Y4V3K2M1', ...example };
const task = toA2ATask(entry, 'standalone');

const answer = {
  messageId: 'msg-1',
  taskId: entry.id,
  role: 'ROLE_USER' as const,
  parts: [{ text: 'redis' }],
  extensions: [DECISION_EXT_URI],
  metadata: {
    [DECISION_EXT_URI]: {
      escalationId: '01JCX5Z9Q4W8E7R6T5Y4V3K2M2',
      choice: 'redis',
      scope: 'task',
    },
  },
};

/** JSON as it would cross the wire, then through the SDK's codec and back. */
function roundTrip(
  codec: { fromJSON(o: unknown): unknown; toJSON(m: never): unknown },
  json: unknown,
) {
  return JSON.parse(JSON.stringify(codec.toJSON(codec.fromJSON(json) as never)));
}

describe('A2A 1.0 wire shapes against @a2a-js/sdk 1.3.0 (#201)', () => {
  it('speaks the A2A version ADR-003 pins', () => {
    expect(sdk.A2A_PROTOCOL_VERSION).toBe('1.0');
  });

  const cases: [
    string,
    { parse(v: unknown): unknown },
    { fromJSON(o: unknown): unknown; toJSON(m: never): unknown },
    unknown,
  ][] = [
    ['Task', A2ATask, sdk.Task, task],
    ['Message (an answer)', A2AMessage, sdk.Message, answer],
    ['GetTaskRequest', A2AGetTaskRequest, sdk.GetTaskRequest, { id: entry.id, historyLength: 0 }],
    [
      'ListTasksRequest',
      A2AListTasksRequest,
      sdk.ListTasksRequest,
      { pageSize: 50, status: 'TASK_STATE_WORKING' },
    ],
    [
      'ListTasksResponse',
      A2AListTasksResponse,
      sdk.ListTasksResponse,
      { tasks: [task], pageSize: 50, totalSize: 1 },
    ],
    ['CancelTaskRequest', A2ACancelTaskRequest, sdk.CancelTaskRequest, { id: entry.id }],
    ['SendMessageRequest', A2ASendMessageRequest, sdk.SendMessageRequest, { message: answer }],
    ['SendMessageResponse', A2ASendMessageResponse, sdk.SendMessageResponse, { task }],
  ];

  for (const [name, schema, codec, json] of cases) {
    it(`${name}: valid for Tacet, and unchanged through the SDK's JSON codec`, () => {
      expect(schema.parse(json)).toEqual(json);
      expect(roundTrip(codec, json)).toEqual(json);
    });
  }

  it('maps every Tacet task state to an A2A state the SDK knows', () => {
    for (const state of [
      'submitted',
      'working',
      'input_required',
      'auth_required',
      'completed',
      'failed',
      'canceled',
      'rejected',
    ] as const) {
      const t = toA2ATask({ ...entry, state }, 'standalone');
      expect(roundTrip(sdk.Task, t)).toEqual(t);
    }
  });

  it('carries the status extension unchanged, and omits history when asked for none', () => {
    expect(StatusExt.parse(task.metadata?.[STATUS_EXT_URI])).toEqual(example);
    expect(toA2ATask(entry, 'standalone', 0).history).toBeUndefined();
    expect(statusEntries({ tasks: {}, skipped: [] }, () => undefined)).toEqual([]);
  });
});

describe('@a2a-js/sdk stays out of shipped code (#201)', () => {
  it('is imported by test files only', () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|mts|js|mjs)$/.test(e.name) && !/\.test\.(ts|js)$/.test(e.name)) {
          if (/['"]@a2a-js\/sdk/.test(readFileSync(p, 'utf8'))) offenders.push(relative(root, p));
        }
      }
    };
    walk(join(root, 'packages'));
    expect(offenders).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(root, 'packages', 'core', 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['@a2a-js/sdk']).toBeUndefined();
    expect(pkg.devDependencies?.['@a2a-js/sdk']).toBe('1.3.0');
  });
});
