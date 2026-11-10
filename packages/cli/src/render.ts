import type { EventEnvelope, TaskStatusEntry, TaskView } from '@tacet/core';

/**
 * Text from the event log made safe to print on a terminal: Worker output is untrusted, so C0
 * and C1 control characters (ESC among them: no colour, cursor, title, clipboard or hyperlink
 * sequences) and bidi overrides are replaced by `?`. Newline and tab are kept.
 */
export function terminalSafe(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '?');
}

/**
 * Pretty JSON safe to print on a terminal: `JSON.stringify` escapes C0 controls itself; C1
 * controls and bidi overrides are escaped here too (as `\\uXXXX`, so the data is unchanged).
 */
export function safeJson(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent).replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** At most `n` characters, on one line. */
export function oneLine(text: string, n = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 3)}...` : flat;
}

/** Summary-grade event types, shown by default; `agent.*` (the transcript) only on request. */
export function isSummaryEvent(type: string): boolean {
  return !type.startsWith('agent.') || type === 'agent.usage';
}

type Data = Record<string, unknown>;
const str = (d: Data, k: string): string | undefined =>
  typeof d[k] === 'string' ? (d[k] as string) : undefined;

/** One event as a line of text (or a few, for a Worker's message), already terminal-safe. */
export function formatEvent(e: EventEnvelope): string {
  const d = (typeof e.data === 'object' && e.data !== null ? e.data : {}) as Data;
  const time = e.ts.slice(11, 19);
  const where = e.taskId ?? '-';
  let what: string;
  switch (e.type) {
    case 'task.created':
      what = `created: ${oneLine(str(d, 'goal') ?? '')}`;
      break;
    case 'task.status':
      what = `${str(d, 'state') ?? '?'}${str(d, 'message') ? `: ${oneLine(str(d, 'message') ?? '')}` : ''}`;
      break;
    case 'task.planned': {
      const subtasks = Array.isArray(d.subtasks) ? d.subtasks.length : 0;
      what = `planned ${subtasks} sub-task(s)`;
      break;
    }
    case 'task.result':
      what = `result ${str(d, 'outcome') ?? '?'}:\n  ${(str(d, 'summary') ?? '').split('\n').join('\n  ')}`;
      break;
    case 'worker.started':
      what = `worker ${str(d, 'sessionId') ?? '?'} started (${[str(d, 'adapter'), str(d, 'model')].filter(Boolean).join(' ')})`;
      break;
    case 'worker.ended':
      what = `worker ${str(d, 'sessionId') ?? '?'} ended: ${str(d, 'reason') ?? '?'}${str(d, 'message') ? ` (${oneLine(str(d, 'message') ?? '')})` : ''}`;
      break;
    case 'escalation.raised':
      what = `escalation ${str(d, 'id') ?? '?'}: ${oneLine(str(d, 'question') ?? '', 400)}`;
      break;
    case 'escalation.resolved':
      what = `escalation ${str(d, 'escalationId') ?? '?'} answered${str(d, 'answer') ? `: ${oneLine(str(d, 'answer') ?? '')}` : ''}`;
      break;
    case 'agent.message.delta':
      what = `says:\n  ${(str(d, 'text') ?? '').trim().split('\n').join('\n  ')}`;
      break;
    case 'agent.tool.call':
      what = `tool ${str(d, 'name') ?? '?'} ${oneLine(JSON.stringify(d.input ?? null), 120)}`;
      break;
    case 'agent.tool.result':
      what = `tool result ${d.ok === false ? 'failed' : 'ok'}${str(d, 'summary') ? `: ${oneLine(str(d, 'summary') ?? '')}` : ''}`;
      break;
    case 'agent.approval.request':
      what = `asks approval: ${oneLine(str(d, 'summary') ?? '')}`;
      break;
    case 'agent.status':
      what = `status ${str(d, 'state') ?? '?'}${str(d, 'message') ? `: ${oneLine(str(d, 'message') ?? '')}` : ''}`;
      break;
    case 'maintenance.problem':
      what = `problem (${[str(d, 'op') ?? '?', str(d, 'workspaceId')].filter(Boolean).join(' ')}): ${oneLine(str(d, 'message') ?? '', 300)}`;
      break;
    case 'agent.usage':
      what = `usage in ${d.inputTokens ?? 0} out ${d.outputTokens ?? 0}${typeof d.costUsd === 'number' ? ` $${d.costUsd.toFixed(4)}` : ''}`;
      break;
    default:
      what = `${e.type} ${oneLine(JSON.stringify(d), 160)}`;
  }
  return terminalSafe(`${time} ${where} ${what}`);
}

/**
 * One task as `tacet status` prints it (#201): the same lines as `formatTask`, built from a status
 * entry so a live run and the log print alike. Only escalations still open are listed.
 */
export function formatStatusEntry(e: TaskStatusEntry): string {
  const lines = [`${e.id} ${e.state}: ${oneLine(e.goal)}`];
  for (const s of e.subtasks) {
    const workers = s.activeWorkers.length ? ` workers: ${s.activeWorkers.join(', ')}` : '';
    lines.push(`  ${s.id} ${s.state}: ${oneLine(s.goal, 100)}${workers}`);
  }
  for (const x of e.escalations) {
    lines.push(`  escalation ${x.id} (${x.taskId}): ${oneLine(x.question, 300)}`);
  }
  const total = [e, ...e.subtasks].reduce(
    (a, t) => ({
      inputTokens: a.inputTokens + t.usage.inputTokens,
      outputTokens: a.outputTokens + t.usage.outputTokens,
      costUsd: a.costUsd + t.usage.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  if (total.inputTokens || total.outputTokens || total.costUsd) {
    lines.push(
      `  usage: in ${total.inputTokens} out ${total.outputTokens} $${total.costUsd.toFixed(4)}`,
    );
  }
  if (e.target) {
    const where = e.target.branch ?? 'a detached HEAD';
    lines.push(`  targets ${where} (started at ${e.target.commit.slice(0, 12)})`);
  }
  return terminalSafe(lines.join('\n'));
}

/** A task and its sub-tasks as `tacet run` reports them. */
export function formatTask(view: TaskView, subs: TaskView[]): string {
  const lines = [`${view.task.id} ${view.state}: ${oneLine(view.task.goal)}`];
  for (const s of subs) {
    const workers = s.activeWorkers.length ? ` workers: ${s.activeWorkers.join(', ')}` : '';
    lines.push(`  ${s.task.id} ${s.state}: ${oneLine(s.task.goal, 100)}${workers}`);
  }
  for (const t of [view, ...subs]) {
    for (const [id, x] of Object.entries(t.escalations)) {
      if (x.status === 'pending')
        lines.push(`  escalation ${id} (${t.task.id}): ${oneLine(x.question, 300)}`);
    }
  }
  const total = [view, ...subs].reduce(
    (a, t) => ({
      inputTokens: a.inputTokens + t.usage.inputTokens,
      outputTokens: a.outputTokens + t.usage.outputTokens,
      costUsd: a.costUsd + t.usage.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  // Usage is recorded on the task that spent it: the planner's on the task, Workers' on sub-tasks.
  if (total.inputTokens || total.outputTokens || total.costUsd) {
    lines.push(
      `  usage: in ${total.inputTokens} out ${total.outputTokens} $${total.costUsd.toFixed(4)}`,
    );
  }
  return terminalSafe(lines.join('\n'));
}
