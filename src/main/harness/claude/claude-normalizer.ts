import type { BlockingRequest, UserDecision } from '@/shared/conversation-contract';
import type { NativeEvent, NativeEventPayload } from '@/main/harness/reconciler';

export interface ClaudeHistoryRecord {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  parent_tool_use_id?: unknown;
  isSidechain?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  message?: unknown;
  question?: unknown;
  permission?: unknown;
  answer?: unknown;
  decision?: unknown;
  subtype?: unknown;
  [field: string]: unknown;
}

export interface ClaudeNormalizationContext {
  recordTurn(record: ClaudeHistoryRecord): string | undefined;
}

class NormalizationContext implements ClaudeNormalizationContext {
  private readonly turnByNativeId = new Map<string, string>();

  recordTurn(record: ClaudeHistoryRecord): string | undefined {
    const uuid = stringValue(record.uuid);
    const parentUuid = stringValue(record.parentUuid);
    const type = stringValue(record.type);
    const message = objectValue(record.message);
    const role = stringValue(message?.role);
    const content = message?.content;
    const isToolResultCarrier = role === 'user' && hasToolResult(content);
    const ownTurn = type === 'user' && role === 'user' && !isToolResultCarrier ? uuid : undefined;
    const turnId = ownTurn ?? (parentUuid ? this.turnByNativeId.get(parentUuid) : undefined);

    if (uuid && turnId) this.turnByNativeId.set(uuid, turnId);
    const messageId = stringValue(message?.id);
    if (messageId && turnId) this.turnByNativeId.set(messageId, turnId);
    return turnId;
  }
}

const defaultContext = new NormalizationContext();

export function createClaudeNormalizationContext(): ClaudeNormalizationContext {
  return new NormalizationContext();
}

export function normalizeClaudeRecord(
  record: ClaudeHistoryRecord,
  ordinal: number,
  context: ClaudeNormalizationContext = defaultContext,
): NativeEvent[] {
  const nativeType = stringValue(record.type) ?? 'unknown';
  const uuid = stringValue(record.uuid) ?? `record:${ordinal}`;
  const observedAt = timestampValue(record.timestamp, ordinal);
  const turnId = context.recordTurn(record) ?? stringValue(record.parentUuid) ?? uuid;
  const message = objectValue(record.message);

  if (nativeType === 'user' && isUserMessage(message) && !hasToolResult(message.content)) {
    const text = textContent(message.content);
    return [event(uuid, nativeType, observedAt, {
      kind: 'turn-started',
      turnId,
      userMessageId: stringValue(message.id) ?? uuid,
      text,
      ...(Number.isFinite(observedAt) ? { createdAt: observedAt } : {}),
    })];
  }

  if ((nativeType === 'assistant' || nativeType === 'user') && message) {
    const content = arrayValue(message.content);
    if (content) return normalizeContent(record, content, turnId, uuid, nativeType, observedAt);
  }

  if (nativeType === 'question') {
    return normalizeQuestion(record, turnId, uuid, observedAt);
  }

  if (nativeType === 'permission' || nativeType === 'permission_request') {
    return normalizePermission(record, turnId, uuid, nativeType, observedAt);
  }

  if (nativeType === 'result') {
    const status = resultStatus(record.subtype);
    return [event(uuid, nativeType, observedAt, { kind: 'turn-finished', turnId, status })];
  }

  return [unsupported(uuid, nativeType, observedAt, record)];
}

function normalizeContent(
  record: ClaudeHistoryRecord,
  content: unknown[],
  turnId: string,
  uuid: string,
  nativeType: string,
  observedAt: number,
): NativeEvent[] {
  const events: NativeEvent[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = objectValue(content[index]);
    const blockType = stringValue(block?.type) ?? 'unknown-content';
    if (blockType === 'text') {
      const text = stringValue(block?.text);
      if (text !== undefined) {
        events.push(event(`${uuid}:text:${index}`, blockType, observedAt, {
          kind: 'assistant-text', turnId, blockId: `${uuid}:text:${index}`, text, final: true,
        }));
      } else {
        events.push(unsupported(`${uuid}:${blockType}:${index}`, blockType, observedAt, block ?? {} , turnId));
      }
      continue;
    }
    if (blockType === 'thinking') {
      const thinking = stringValue(block?.thinking);
      if (thinking !== undefined) {
        events.push(event(`${uuid}:thinking:${index}`, blockType, observedAt, {
          kind: 'assistant-text', turnId, blockId: `${uuid}:thinking:${index}`,
          text: `Provider-supplied thinking: ${thinking}`, final: true,
        }));
      } else {
        events.push(unsupported(`${uuid}:${blockType}:${index}`, blockType, observedAt, block ?? {}, turnId));
      }
      continue;
    }
    if (blockType === 'tool_use') {
      const toolId = stringValue(block?.id) ?? `${uuid}:tool:${index}`;
      const name = stringValue(block?.name) ?? 'Unknown Claude tool';
      const input = objectValue(block?.input);
      const actionKind = actionKindFor(name, record.isSidechain === true);
      const parentActionId = stringValue(record.parent_tool_use_id);
      events.push(event(toolId, blockType, observedAt, {
        kind: 'action-requested',
        turnId,
        actionId: toolId,
        actionKind,
        label: actionLabel(name, input),
        ...(parentActionId ? { parentActionId } : {}),
        ...(detailForAction(input) ? { detail: detailForAction(input) } : {}),
      }));
      continue;
    }
    if (blockType === 'tool_result') {
      const actionId = stringValue(block?.tool_use_id) ?? `${uuid}:unknown-tool:${index}`;
      events.push(event(`${uuid}:${actionId}:${index}`, blockType, observedAt, {
        kind: 'action-updated',
        turnId,
        actionId,
        status: block?.is_error === true ? 'failed' : 'completed',
        ...resultDetails(block),
      }));
      continue;
    }
    events.push(unsupported(`${uuid}:${blockType}:${index}`, blockType, observedAt, block ?? {}, turnId));
  }
  return events;
}

function normalizeQuestion(record: ClaudeHistoryRecord, turnId: string, uuid: string, observedAt: number): NativeEvent[] {
  const question = objectValue(record.question);
  const id = stringValue(question?.id);
  const prompt = stringValue(question?.prompt);
  const fieldId = stringValue(question?.fieldId);
  const allowFreeText = question?.allowFreeText;
  const choices = choicesValue(question?.choices);
  if (!id || !prompt || !fieldId || typeof allowFreeText !== 'boolean' || (question?.choices !== undefined && !choices)) {
    return [unsupported(uuid, 'question', observedAt, record, turnId)];
  }

  const request: BlockingRequest = {
    id,
    kind: 'question',
    provider: 'claude',
    prompt,
    fieldId,
    ...(choices ? { choices } : {}),
    allowFreeText,
    status: 'open',
  };
  const events = [event(uuid, 'question', observedAt, { kind: 'request-opened', turnId, request })];
  const answers = stringRecord(record.answer);
  if (answers) {
    events.push(event(`${uuid}:resolved`, 'question', observedAt, {
      kind: 'request-resolved', turnId, requestId: id, decision: { kind: 'answer', answers },
    }));
  }
  return events;
}

function normalizePermission(record: ClaudeHistoryRecord, turnId: string, uuid: string, nativeType: string, observedAt: number): NativeEvent[] {
  const permission = objectValue(record.permission);
  const id = stringValue(permission?.id);
  const title = stringValue(permission?.title);
  const operation = stringValue(permission?.operation);
  if (!id || !title || !operation) return [unsupported(uuid, nativeType, observedAt, record, turnId)];

  const request: BlockingRequest = {
    id,
    kind: 'approval',
    provider: 'claude',
    title,
    operation,
    ...(stringValue(permission?.rememberScope) ? { rememberScope: stringValue(permission?.rememberScope) } : {}),
    status: 'open',
  };
  const events = [event(uuid, nativeType, observedAt, { kind: 'request-opened', turnId, request })];
  const decision = permissionDecision(record.decision);
  if (decision) {
    events.push(event(`${uuid}:resolved`, nativeType, observedAt, {
      kind: 'request-resolved', turnId, requestId: id, decision,
    }));
  }
  return events;
}

function event(nativeId: string, nativeType: string, observedAt: number, payload: NativeEventPayload): NativeEvent {
  return { provider: 'claude', nativeId, nativeType, observedAt, payload };
}

export function unsupportedClaudeRecord(ordinal: number, nativeType = 'malformed-json'): NativeEvent {
  return event(`${nativeType}:${ordinal}`, nativeType, ordinal, {
    kind: 'unsupported',
    summary: `Unsupported Claude activity: ${nativeType}`,
    captureCompleteness: 'partial',
  });
}

function unsupported(nativeId: string, nativeType: string, observedAt: number, source: Record<string, unknown>, turnId?: string): NativeEvent {
  const fields = Object.keys(source).sort().join(', ');
  return event(nativeId, nativeType, observedAt, {
    kind: 'unsupported',
    ...(turnId ? { turnId } : {}),
    summary: `Unsupported Claude activity: ${nativeType}${fields ? ` (fields: ${fields})` : ''}`,
    captureCompleteness: 'partial',
  });
}

function isUserMessage(message: Record<string, unknown> | undefined): message is Record<string, unknown> & { content: unknown } {
  return stringValue(message?.role) === 'user' && message?.content !== undefined;
}

function hasToolResult(content: unknown): boolean {
  return arrayValue(content)?.some((block) => stringValue(objectValue(block)?.type) === 'tool_result') ?? false;
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return arrayValue(content)
    ?.map((block) => objectValue(block))
    .filter((block): block is Record<string, unknown> => block !== undefined && stringValue(block.type) === 'text')
    .map((block) => stringValue(block.text) ?? '')
    .join('') ?? '';
}

function actionKindFor(name: string, isSidechain: boolean): Extract<NativeEventPayload, { kind: 'action-requested' }>['actionKind'] {
  if (isSidechain || name === 'Task') return 'subagent';
  if (/^(Read|NotebookRead)$/i.test(name)) return 'file-read';
  if (/^(Edit|Write|NotebookEdit)$/i.test(name)) return 'file-edit';
  if (/^(Bash|Command)$/i.test(name)) return 'command';
  if (/^(Grep|Glob|Search)$/i.test(name)) return 'search';
  return 'tool';
}

function actionLabel(name: string, input: Record<string, unknown> | undefined): string {
  return stringValue(input?.description) ?? stringValue(input?.file_path) ?? stringValue(input?.path) ?? stringValue(input?.command) ?? name;
}

function detailForAction(input: Record<string, unknown> | undefined): string | undefined {
  return stringValue(input?.command) ?? stringValue(input?.query) ?? stringValue(input?.file_path) ?? stringValue(input?.path);
}

function resultDetails(block: Record<string, unknown> | undefined): Pick<Extract<NativeEventPayload, { kind: 'action-updated' }>, 'output'> {
  const content = block?.content;
  if (typeof content === 'string') return { output: content };
  return {};
}

function resultStatus(subtype: unknown): 'completed' | 'interrupted' | 'failed' {
  if (subtype === 'error') return 'failed';
  if (subtype === 'interrupted') return 'interrupted';
  return 'completed';
}

function permissionDecision(value: unknown): UserDecision | undefined {
  if (value === 'allow-once') return { kind: 'allow-once' };
  if (value === 'deny') return { kind: 'deny' };
  const record = objectValue(value);
  if (record?.kind === 'allow-and-remember' && typeof record.scope === 'string') return { kind: 'allow-and-remember', scope: record.scope };
  if (record?.kind === 'deny') return { kind: 'deny', ...(typeof record.reason === 'string' ? { reason: record.reason } : {}) };
  return undefined;
}

function choicesValue(value: unknown): Array<{ value: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices = value.map((choice) => objectValue(choice)).map((choice) => {
    const choiceValue = stringValue(choice?.value);
    const label = stringValue(choice?.label);
    return choiceValue && label ? { value: choiceValue, label } : undefined;
  });
  return choices.every((choice) => choice !== undefined) ? choices : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  return entries.every(([, entry]) => typeof entry === 'string') ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function timestampValue(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}
