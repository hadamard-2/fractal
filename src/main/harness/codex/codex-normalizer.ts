import type { ServerNotification, ServerRequest } from '@/main/harness/codex/generated';
import type { Thread } from '@/main/harness/codex/generated/v2/Thread';
import type { ThreadItem } from '@/main/harness/codex/generated/v2/ThreadItem';
import type { Turn } from '@/main/harness/codex/generated/v2/Turn';
import type { NativeEvent, NativeEventPayload } from '@/main/harness/reconciler';

export function normalizeCodexThread(thread: Thread): NativeEvent[] {
  return thread.turns.flatMap((turn) => normalizeTurn(turn));
}

export function normalizeCodexNotification(notification: ServerNotification): NativeEvent[] {
  switch (notification.method) {
    case 'item/agentMessage/delta':
      return [event(notification.params.itemId, notification.method, 0, {
        kind: 'assistant-text', turnId: notification.params.turnId, blockId: notification.params.itemId,
        text: notification.params.delta, final: false,
      })];
    case 'item/started':
      return normalizeItem(notification.params.item, notification.params.turnId, notification.params.startedAtMs, false);
    case 'item/completed':
      return normalizeItem(notification.params.item, notification.params.turnId, notification.params.completedAtMs, true);
    case 'turn/started':
      return normalizeTurn(notification.params.turn);
    case 'turn/completed':
      return [event(`${notification.params.turn.id}:status`, notification.method, 0, {
        kind: 'turn-finished', turnId: notification.params.turn.id, status: turnStatus(notification.params.turn.status),
      })];
    case 'thread/status/changed':
      return [event(`${notification.params.threadId}:status`, notification.method, 0, {
        kind: 'system-notice', turnId: notification.params.threadId, tone: notification.params.status.type === 'systemError' ? 'error' : 'info',
        message: threadStatusMessage(notification.params.status.type, notification.params.status.type === 'active' ? notification.params.status.activeFlags : []),
      })];
    case 'item/commandExecution/outputDelta':
      return [event(`${notification.params.itemId}:status`, notification.method, 0, {
        kind: 'action-updated', turnId: notification.params.turnId, actionId: notification.params.itemId, status: 'running', output: notification.params.delta,
      })];
    case 'item/fileChange/patchUpdated':
      return notification.params.changes.map((change, index, changes) => {
        const actionId = changes.length === 1 ? notification.params.itemId : `${notification.params.itemId}:${index}`;
        return event(`${actionId}:status`, notification.method, 0, {
          kind: 'action-updated', turnId: notification.params.turnId, actionId, status: 'running', patch: change.diff,
        });
      });
    default:
      return [unsupported(notification.method, notification.method, 0)];
  }
}

export function normalizeCodexServerRequest(request: ServerRequest): NativeEvent[] {
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/permissions/requestApproval': {
      const requestId = 'approvalId' in request.params && request.params.approvalId
        ? request.params.approvalId
        : String(request.id);
      const operation = request.method === 'item/commandExecution/requestApproval'
        ? 'Command execution'
        : request.method === 'item/fileChange/requestApproval' ? 'File change' : 'Permission change';
      return [event(`request:${String(request.id)}`, request.method, request.params.startedAtMs, {
        kind: 'request-opened', turnId: request.params.turnId,
        request: { id: requestId, kind: 'approval', provider: 'codex', title: `Approve ${operation.toLowerCase()}`, operation, status: 'open' },
      })];
    }
    default:
      return [unsupported(`request:${String(request.id)}`, request.method, 0)];
  }
}

function normalizeTurn(turn: Turn): NativeEvent[] {
  const events = turn.items.flatMap((item) => normalizeItem(item, turn.id, secondsToMilliseconds(turn.startedAt), true));
  if (turn.status !== 'inProgress') {
    events.push(event(`${turn.id}:status`, 'turn-status', secondsToMilliseconds(turn.completedAt) ?? secondsToMilliseconds(turn.startedAt), {
      kind: 'turn-finished', turnId: turn.id, status: turnStatus(turn.status),
    }));
  }
  return events;
}

function normalizeItem(item: ThreadItem, turnId: string, observedAt: number, final: boolean): NativeEvent[] {
  switch (item.type) {
    case 'userMessage': {
      const text = item.content.filter((content) => content.type === 'text').map((content) => content.text).join('\n');
      const unknown = item.content.flatMap((content, index) => content.type === 'text' ? [] : [unsupported(`${item.id}:content:${index}`, content.type, observedAt, turnId)]);
      return [event(item.id, item.type, observedAt, { kind: 'turn-started', turnId, userMessageId: item.id, text }), ...unknown];
    }
    case 'agentMessage':
      return [event(item.id, item.type, observedAt, { kind: 'assistant-text', turnId, blockId: item.id, text: item.text, final })];
    case 'reasoning':
      return item.summary.length > 0 ? [event(item.id, item.type, observedAt, {
        kind: 'assistant-text', turnId, blockId: item.id, text: item.summary.join('\n'), final,
      })] : [];
    case 'commandExecution':
      return actionEvents(item.id, item.type, turnId, observedAt, 'command', item.command, item.status, final, {
        ...(item.aggregatedOutput ? { output: item.aggregatedOutput } : {}),
        ...(item.exitCode !== null ? { exitCode: item.exitCode } : {}),
      });
    case 'fileChange':
      return item.changes.flatMap((change, index) => {
        const actionId = item.changes.length === 1 ? item.id : `${item.id}:${index}`;
        return actionEvents(actionId, item.type, turnId, observedAt, 'file-edit', change.path, item.status, final, { patch: change.diff });
      });
    case 'mcpToolCall':
      return actionEvents(item.id, item.type, turnId, observedAt, actionKindForTool(item.tool), `${item.server}/${item.tool}`, item.status, final);
    case 'webSearch':
      return actionEvents(item.id, item.type, turnId, observedAt, 'search', item.query, 'completed', true);
    case 'subAgentActivity':
      return actionEvents(item.id, item.type, turnId, observedAt, 'subagent', `Subagent ${item.kind}`, subagentStatus(item.kind), true);
    case 'collabAgentToolCall':
      return actionEvents(item.id, item.type, turnId, observedAt, 'subagent', `Collaboration ${item.tool}`, item.status, true);
    default:
      return [unsupported(item.id, item.type, observedAt, turnId)];
  }
}

function actionEvents(
  actionId: string, nativeType: string, turnId: string, observedAt: number,
  actionKind: Extract<NativeEventPayload, { kind: 'action-requested' }>['actionKind'], label: string,
  nativeStatus: string, final: boolean, update: Pick<Extract<NativeEventPayload, { kind: 'action-updated' }>, 'output' | 'exitCode' | 'patch'> = {},
): NativeEvent[] {
  const status = actionStatus(nativeStatus);
  const events: NativeEvent[] = [event(actionId, nativeType, observedAt, { kind: 'action-requested', turnId, actionId, actionKind, label })];
  if (final || status !== 'running') events.push(event(`${actionId}:status`, nativeType, observedAt, { kind: 'action-updated', turnId, actionId, status, ...update }));
  return events;
}

function actionKindForTool(tool: string): 'file-read' | 'search' | 'tool' {
  if (/read|file/i.test(tool)) return 'file-read';
  if (/search|find/i.test(tool)) return 'search';
  return 'tool';
}

function actionStatus(status: string): 'running' | 'completed' | 'failed' | 'denied' {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'declined') return 'denied';
  return 'running';
}

function subagentStatus(status: string): 'running' | 'interrupted' {
  return status === 'interrupted' ? 'interrupted' : 'running';
}

function turnStatus(status: string): 'completed' | 'interrupted' | 'failed' {
  return status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed';
}

function threadStatusMessage(type: string, flags: string[]): string {
  if (type === 'systemError') return 'Codex thread reported a system error';
  if (type === 'active' && flags.length > 0) return 'Codex thread is waiting for user input';
  return type === 'active' ? 'Codex thread is active' : 'Codex thread is idle';
}

function unsupported(nativeId: string, nativeType: string, observedAt: number, turnId?: string): NativeEvent {
  return event(nativeId, nativeType, observedAt, {
    kind: 'unsupported', ...(turnId ? { turnId } : {}),
    summary: `Unsupported Codex activity: ${nativeType}`, captureCompleteness: 'partial',
  });
}

function event(nativeId: string, nativeType: string, observedAt: number | undefined, payload: NativeEventPayload): NativeEvent {
  return { provider: 'codex', nativeId, nativeType, observedAt: observedAt ?? 0, payload };
}

function secondsToMilliseconds(value: number | null): number | undefined {
  return value === null ? undefined : value * 1000;
}
