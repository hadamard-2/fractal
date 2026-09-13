import type { ServerNotification, ServerRequest } from '@/main/harness/codex/generated';
import type { Thread } from '@/main/harness/codex/generated/v2/Thread';
import type { ThreadItem } from '@/main/harness/codex/generated/v2/ThreadItem';
import type { NativeEvent, NativeEventPayload } from '@/main/harness/reconciler';

export function normalizeCodexThread(thread: Thread): NativeEvent[] {
  if (!isObject(thread) || !Array.isArray(thread.turns)) return [unsupported('thread:malformed', 'thread', 0)];
  return thread.turns.flatMap((turn, index) => normalizeTurn(turn, index));
}

export interface CodexLiveNormalizationContext {
  append(key: string, delta: string): string;
  replace(key: string, text: string): void;
  clearTurn(threadId: string, turnId: string): void;
  unknownId(method: string): string;
  seed(thread: Thread): void;
}

class LiveNormalizationContext implements CodexLiveNormalizationContext {
  private readonly text = new Map<string, string>();
  private unknown = 0;
  append(key: string, delta: string): string { const text = `${this.text.get(key) ?? ''}${delta}`; this.text.set(key, text); return text; }
  replace(key: string, text: string): void { this.text.set(key, text); }
  clearTurn(threadId: string, turnId: string): void { for (const key of this.text.keys()) if (key.startsWith(`${threadId}:${turnId}:`)) this.text.delete(key); }
  unknownId(method: string): string { return `notification:${method}:${this.unknown++}`; }
  seed(thread: Thread): void {
    if (!isObject(thread) || typeof thread.id !== 'string' || !Array.isArray(thread.turns)) return;
    for (const turn of thread.turns) {
      if (!isObject(turn) || typeof turn.id !== 'string' || !Array.isArray(turn.items)) continue;
      for (const item of turn.items) {
        if (!isObject(item) || typeof item.id !== 'string') continue;
        if (item.type === 'agentMessage' && typeof item.text === 'string') this.replace(textKey(thread.id, turn.id, item.id), item.text);
        if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') this.replace(textKey(thread.id, turn.id, item.id), item.aggregatedOutput);
      }
    }
  }
}

export function createCodexLiveNormalizationContext(): CodexLiveNormalizationContext { return new LiveNormalizationContext(); }

const defaultLiveContext = createCodexLiveNormalizationContext();

export function normalizeCodexNotification(notification: ServerNotification, context: CodexLiveNormalizationContext = defaultLiveContext): NativeEvent[] {
  if (!isObject(notification) || typeof notification.method !== 'string' || !isObject(notification.params)) return [unsupported(context.unknownId('malformed'), 'malformed-notification', 0)];
  switch (notification.method) {
    case 'item/agentMessage/delta':
      if (!hasStrings(notification.params, 'threadId', 'turnId', 'itemId', 'delta')) return [unsupported(notificationId(notification, context), notification.method, 0)];
      return [event(notification.params.itemId, notification.method, 0, {
        kind: 'assistant-text', turnId: notification.params.turnId, blockId: notification.params.itemId,
        text: context.append(textKey(notification.params.threadId, notification.params.turnId, notification.params.itemId), notification.params.delta), final: false,
      })];
    case 'item/started':
      if (!hasStrings(notification.params, 'threadId', 'turnId') || !Number.isFinite(notification.params.startedAtMs) || !isObject(notification.params.item)) return [unsupported(notificationId(notification, context), notification.method, 0)];
      return normalizeItem(notification.params.item, notification.params.turnId, notification.params.startedAtMs, false);
    case 'item/completed':
      if (!hasStrings(notification.params, 'threadId', 'turnId') || !Number.isFinite(notification.params.completedAtMs)) return [unsupported(notificationId(notification, context), notification.method, 0)];
      if (isObject(notification.params.item) && notification.params.item.type === 'agentMessage' && typeof notification.params.item.id === 'string' && typeof notification.params.item.text === 'string') context.replace(textKey(notification.params.threadId, notification.params.turnId, notification.params.item.id), notification.params.item.text);
      return normalizeItem(notification.params.item, notification.params.turnId, notification.params.completedAtMs, true);
    case 'turn/started':
      return normalizeTurn(notification.params.turn, 0);
    case 'turn/completed':
      if (!hasStrings(notification.params, 'threadId') || !isObject(notification.params.turn) || typeof notification.params.turn.id !== 'string' || typeof notification.params.turn.status !== 'string') return [unsupported(notificationId(notification, context), notification.method, 0)];
      context.clearTurn(notification.params.threadId, notification.params.turn.id);
      return [event(`${notification.params.turn.id}:status`, notification.method, 0, {
        kind: 'turn-finished', turnId: notification.params.turn.id, status: turnStatus(notification.params.turn.status),
      })];
    case 'thread/status/changed':
      if (!hasStrings(notification.params, 'threadId') || !isObject(notification.params.status) || typeof notification.params.status.type !== 'string') return [unsupported(notificationId(notification, context), notification.method, 0)];
      return [event(`${notification.params.threadId}:status`, notification.method, 0, {
        kind: 'system-notice', tone: notification.params.status.type === 'systemError' ? 'error' : 'info',
        message: threadStatusMessage(notification.params.status.type, notification.params.status.type === 'active' && Array.isArray(notification.params.status.activeFlags) ? notification.params.status.activeFlags : []),
      })];
    case 'item/commandExecution/outputDelta':
      if (!hasStrings(notification.params, 'threadId', 'turnId', 'itemId', 'delta')) return [unsupported(notificationId(notification, context), notification.method, 0)];
      return [event(`${notification.params.itemId}:status`, notification.method, 0, {
        kind: 'action-updated', turnId: notification.params.turnId, actionId: notification.params.itemId, status: 'running', output: context.append(textKey(notification.params.threadId, notification.params.turnId, notification.params.itemId), notification.params.delta),
      })];
    case 'item/fileChange/patchUpdated':
      if (!hasStrings(notification.params, 'threadId', 'turnId', 'itemId') || !Array.isArray(notification.params.changes) || !notification.params.changes.every(isFileChange)) return [unsupported(notificationId(notification, context), notification.method, 0)];
      return notification.params.changes.map((change) => {
        const actionId = fileActionId(notification.params.itemId, change.path);
        return event(`${actionId}:status`, notification.method, 0, {
          kind: 'action-updated', turnId: notification.params.turnId, actionId, status: 'running', patch: change.diff,
        });
      });
    default:
      return [unsupported(notificationId(notification, context), notification.method, 0, notificationTurnId(notification))];
  }
}

export function normalizeCodexServerRequest(request: ServerRequest): NativeEvent[] {
  if (!isObject(request) || !isObject(request.params) || (typeof request.id !== 'string' && typeof request.id !== 'number') || typeof request.method !== 'string') return [unsupported('request:malformed', 'malformed-request', 0)];
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/permissions/requestApproval': {
      if (!hasStrings(request.params, 'threadId', 'turnId', 'itemId') || !Number.isFinite(request.params.startedAtMs)) return [unsupported(`request:${String(request.id)}`, request.method, 0)];
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

function normalizeTurn(turn: unknown, ordinal: number): NativeEvent[] {
  if (!isObject(turn) || typeof turn.id !== 'string' || !Array.isArray(turn.items) || typeof turn.status !== 'string') return [unsupported(`turn:malformed:${ordinal}`, 'turn', 0)];
  const turnId = turn.id;
  const final = turn.status !== 'inProgress';
  const events = turn.items.flatMap((item, index) => normalizeItem(item, turnId, secondsToMilliseconds(numberOrNull(turn.startedAt)), final, index));
  if (turn.status === 'inProgress' && !events.some((event) => event.payload.kind === 'turn-started')) {
    events.unshift(unsupported(`${turnId}:missing-user`, 'missing-user-anchor', secondsToMilliseconds(numberOrNull(turn.startedAt)), turnId));
    events.unshift(event(`${turnId}:started`, 'turn-status', secondsToMilliseconds(numberOrNull(turn.startedAt)), { kind: 'turn-started', turnId, userMessageId: `${turnId}:missing-user`, text: '' }));
  }
  if (turn.status !== 'inProgress') {
    events.push(event(`${turn.id}:status`, 'turn-status', secondsToMilliseconds(numberOrNull(turn.completedAt)) ?? secondsToMilliseconds(numberOrNull(turn.startedAt)), {
      kind: 'turn-finished', turnId: turn.id, status: turnStatus(turn.status),
    }));
  }
  return events;
}

function normalizeItem(item: unknown, turnId: string, observedAt: number, final: boolean, ordinal = 0): NativeEvent[] {
  if (!isThreadItem(item)) return [unsupported(itemId(item, turnId, ordinal), itemType(item), observedAt, turnId)];
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
      return item.changes.flatMap((change) => {
        const actionId = fileActionId(item.id, change.path);
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

function actionStatus(status: string): 'running' | 'completed' | 'failed' | 'denied' | 'interrupted' {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'declined') return 'denied';
  if (status === 'interrupted') return 'interrupted';
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
  return type === 'active' ? 'Codex thread is active' : type === 'idle' ? 'Codex thread is idle' : 'Codex thread status is unknown';
}

function fileActionId(itemId: string, filePath: string): string { return `${itemId}:file:${filePath}`; }

function textKey(threadId: string, turnId: string, itemId: string): string { return `${threadId}:${turnId}:${itemId}`; }

function notificationId(notification: { method: string; params: object }, context: CodexLiveNormalizationContext): string {
  const params = notification.params as Record<string, unknown>;
  const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
  const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
  const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
  return turnId || itemId ? [threadId, turnId, itemId, notification.method].filter(Boolean).join(':') : context.unknownId(notification.method);
}

function notificationTurnId(notification: { params: object }): string | undefined {
  const turnId = (notification.params as Record<string, unknown>).turnId;
  return typeof turnId === 'string' ? turnId : undefined;
}

function hasStrings(value: object, ...keys: string[]): value is Record<string, string> {
  return keys.every((key) => typeof (value as Record<string, unknown>)[key] === 'string');
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }

function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

function itemId(value: unknown, turnId: string, ordinal: number): string {
  return isObject(value) && typeof value.id === 'string' ? value.id : `${turnId}:item:${ordinal}`;
}

function itemType(value: unknown): string { return isObject(value) && typeof value.type === 'string' ? value.type : 'malformed-item'; }

function isFileChange(value: unknown): value is { path: string; diff: string } {
  return isObject(value) && typeof value.path === 'string' && typeof value.diff === 'string';
}

function isThreadItem(value: unknown): value is ThreadItem {
  if (!isObject(value) || typeof value.type !== 'string' || typeof value.id !== 'string') return false;
  switch (value.type) {
    case 'userMessage': return Array.isArray(value.content) && value.content.every((content) => isObject(content) && typeof content.type === 'string' && (content.type !== 'text' || typeof content.text === 'string'));
    case 'agentMessage': return typeof value.text === 'string';
    case 'reasoning': return Array.isArray(value.summary) && value.summary.every((part) => typeof part === 'string') && Array.isArray(value.content) && value.content.every((part) => typeof part === 'string');
    case 'commandExecution': return typeof value.command === 'string' && typeof value.status === 'string' && Array.isArray(value.commandActions) && (value.aggregatedOutput === null || typeof value.aggregatedOutput === 'string') && (value.exitCode === null || typeof value.exitCode === 'number');
    case 'fileChange': return typeof value.status === 'string' && Array.isArray(value.changes) && value.changes.every(isFileChange);
    case 'mcpToolCall': return typeof value.server === 'string' && typeof value.tool === 'string' && typeof value.status === 'string';
    case 'webSearch': return typeof value.query === 'string';
    case 'subAgentActivity': return typeof value.kind === 'string' && typeof value.agentThreadId === 'string' && typeof value.agentPath === 'string';
    case 'collabAgentToolCall': return typeof value.tool === 'string' && typeof value.status === 'string';
    default: return true;
  }
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
