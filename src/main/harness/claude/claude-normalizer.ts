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
  recordTurn(record: ClaudeHistoryRecord, nativeId: string): string | undefined;
  streamMessageId?: string;
  streamText?: Map<number, string>;
}

class NormalizationContext implements ClaudeNormalizationContext {
  private readonly turnByNativeId = new Map<string, string>();
  streamMessageId?: string;
  streamText = new Map<number, string>();

  recordTurn(record: ClaudeHistoryRecord, nativeId: string): string | undefined {
    const uuid = nativeId;
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

export function normalizeClaudeStreamRecord(input: unknown, ordinal: number, context: ClaudeNormalizationContext, turnId: string): NativeEvent[] {
  const record = objectValue(input);
  if (record?.type !== 'stream_event') return normalizeClaudeRecord(input, ordinal, context);
  const streamEvent = objectValue(record.event);
  const type = stringValue(streamEvent?.type);
  if (type === 'message_start') {
    const id = stringValue(objectValue(streamEvent?.message)?.id);
    context.streamMessageId = id;
    context.streamText?.clear();
    return [];
  }
  if (type !== 'content_block_delta' || !context.streamMessageId || !Number.isSafeInteger(streamEvent?.index) || (streamEvent?.index as number) < 0) return [];
  const delta = objectValue(streamEvent.delta);
  if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') return [];
  const index = streamEvent.index as number;
  const text = `${context.streamText?.get(index) ?? ''}${delta.text}`;
  context.streamText?.set(index, text);
  const nativeId = `${context.streamMessageId}:text:${index}`;
  return [event(nativeId, 'text', ordinal, { kind: 'assistant-text', turnId, blockId: nativeId, text, final: false })];
}

export function normalizeClaudeRecord(
  input: unknown,
  ordinal: number,
  context: ClaudeNormalizationContext = defaultContext,
): NativeEvent[] {
  const record = objectValue(input);
  if (!record) return [unsupportedClaudeRecord(ordinal, 'invalid-record')];
  const nativeType = stringValue(record.type) ?? 'unknown';
  const message = objectValue(record.message);
  const uuid = stringValue(record.uuid) ?? stringValue(message?.id) ?? `record:${ordinal}`;
  const contentId = nativeType === 'assistant' ? stringValue(message?.id) ?? uuid : uuid;
  const observedAt = timestampValue(record.timestamp, ordinal);
  const turnId = context.recordTurn(record, uuid) ?? stringValue(record.parentUuid) ?? uuid;

  // After recordTurn: later records can name a bookkeeping record as their parent.
  if (isClaudeBookkeepingRecord(record)) return [];

  if (nativeType === 'user' && isUserMessage(message) && !hasToolResult(message.content)) {
    return normalizeUserContent(message, uuid, nativeType, turnId, observedAt);
  }

  if ((nativeType === 'assistant' || nativeType === 'user') && message) {
    const content = arrayValue(message.content);
    if (content) return normalizeContent(record, content, turnId, contentId, nativeType, observedAt);
  }

  if (nativeType === 'question') {
    return normalizeQuestion(record, turnId, uuid, observedAt);
  }

  if (nativeType === 'permission' || nativeType === 'permission_request') {
    return normalizePermission(record, turnId, uuid, nativeType, observedAt);
  }

  if (nativeType === 'result') {
    const status = resultStatus(record.subtype);
    return status
      ? [event(uuid, nativeType, observedAt, { kind: 'turn-finished', turnId, status })]
      : [unsupported(uuid, nativeType, observedAt, record, turnId)];
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
    if (nativeType === 'user' && (blockType === 'text' || blockType === 'thinking')) {
      events.push(unsupported(`${uuid}:${blockType}:${index}`, blockType, observedAt, block ?? {}, turnId));
      continue;
    }
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
      // Claude Code can persist only the block's signature, without the reasoning text;
      // such a block has nothing to show, and a placeholder would split the work packet.
      if (thinking === '') continue;
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
      events.push(...toolResultEvents(block, uuid, index, actionId, turnId, observedAt));
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

// Record types Claude Code writes to a transcript that carry no conversation content:
// session state, titles, cost, file-history checkpoints. Observed in real transcripts,
// not documented, so a new type still surfaces as unsupported until it is listed here.
const BOOKKEEPING_RECORD_TYPES = new Set([
  'agent-name', 'ai-title', 'artifact-autoreact-ledger', 'artifact-comment-monitor', 'atis-latch',
  'bridge-session', 'cost-state', 'custom-title', 'file-history-delta', 'file-history-snapshot',
  'frame-link', 'last-prompt', 'mode', 'permission-mode', 'pr-link', 'queue-operation', 'relocated',
  'worktree-state',
]);

// Context Claude Code injects for the model (reminders, tool and skill listings, environment).
// File, diagnostic, and queued-prompt attachments are left out: those can carry user content.
const BOOKKEEPING_ATTACHMENT_TYPES = new Set([
  'agent_listing_delta', 'auto_mode', 'auto_mode_exit', 'command_permissions', 'date', 'date_change',
  'deferred_tools_delta', 'deferred_tools_record', 'environment', 'hook_additional_context', 'hook_success',
  'instructions', 'mcp_instructions_delta', 'model', 'nested_memory', 'prompt_snapshot', 'remote_session_change',
  'session_context', 'silent_turn_reminder', 'skill_listing', 'task_reminder', 'thinking_drop', 'total_tokens_reminder',
]);

const BOOKKEEPING_SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'turn_duration']);

function isClaudeBookkeepingRecord(record: ClaudeHistoryRecord): boolean {
  const type = stringValue(record.type);
  if (type === undefined) return false;
  if (BOOKKEEPING_RECORD_TYPES.has(type)) return true;
  if (type === 'attachment') return BOOKKEEPING_ATTACHMENT_TYPES.has(stringValue(objectValue(record.attachment)?.type) ?? '');
  if (type === 'system') return BOOKKEEPING_SYSTEM_SUBTYPES.has(stringValue(record.subtype) ?? '');
  return false;
}

export function unsupportedClaudeRecord(ordinal: number, nativeType = 'malformed-json'): NativeEvent {
  return event(`${nativeType}:${ordinal}`, nativeType, ordinal, {
    kind: 'unsupported',
    summary: `Unsupported Claude activity: ${nativeType}`,
    captureCompleteness: 'partial',
  });
}

/** Classifies records with the same validation and content semantics as normalization. */
export function classifyClaudeRecord(record: unknown): 'recognized' | 'unsupported' {
  return normalizeClaudeRecord(record, 0, createClaudeNormalizationContext())
    .some((event) => event.payload.kind === 'unsupported')
    ? 'unsupported'
    : 'recognized';
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

function normalizeUserContent(
  message: Record<string, unknown> & { content: unknown },
  uuid: string,
  nativeType: string,
  turnId: string,
  observedAt: number,
): NativeEvent[] {
  const content = message.content;
  if (!Array.isArray(content)) {
    return [event(uuid, nativeType, observedAt, {
      kind: 'turn-started', turnId, userMessageId: stringValue(message.id) ?? uuid, text: typeof content === 'string' ? content : '',
      ...(Number.isFinite(observedAt) ? { createdAt: observedAt } : {}),
    })];
  }

  const text: string[] = [];
  const unsupportedEvents: NativeEvent[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const value = objectValue(content[index]);
    if (value?.type === 'text' && typeof value.text === 'string') {
      text.push(value.text);
      continue;
    }
    const blockType = stringValue(value?.type) ?? 'unknown-content';
    unsupportedEvents.push(unsupported(`${uuid}:${blockType}:${index}`, blockType, observedAt, value ?? {}, turnId));
  }
  // The atomic user anchor cannot express interleaving with unsupported blocks.
  return [event(uuid, nativeType, observedAt, {
    kind: 'turn-started', turnId, userMessageId: stringValue(message.id) ?? uuid, text: text.join('\n'),
    ...(Number.isFinite(observedAt) ? { createdAt: observedAt } : {}),
  }), ...unsupportedEvents];
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
  const text = arrayValue(content)
    ?.map((part) => objectValue(part))
    .filter((part): part is Record<string, unknown> => part !== undefined && stringValue(part.type) === 'text')
    .map((part) => stringValue(part.text) ?? '')
    .filter((part) => part !== '')
    .join('\n');
  if (text) return { output: text };
  return {};
}

function toolResultEvents(
  block: Record<string, unknown> | undefined,
  uuid: string,
  parentIndex: number,
  actionId: string,
  turnId: string,
  observedAt: number,
): NativeEvent[] {
  const content = arrayValue(block?.content);
  const baseId = `${uuid}:${actionId}:${parentIndex}`;
  if (!content) {
    return [event(baseId, 'tool_result', observedAt, {
      kind: 'action-updated', turnId, actionId, status: block?.is_error === true ? 'failed' : 'completed', ...resultDetails(block),
    })];
  }

  const validTextCount = content.filter((part) => {
    const value = objectValue(part);
    return value?.type === 'text' && typeof value.text === 'string';
  }).length;
  const result: NativeEvent[] = [];
  const text: string[] = [];
  let textCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    const value = objectValue(content[index]);
    if (value?.type === 'text' && typeof value.text === 'string') {
      text.push(value.text);
      textCount += 1;
      result.push(event(textCount === 1 ? baseId : `${baseId}:text:${index}`, 'tool_result', observedAt, {
        kind: 'action-updated',
        turnId,
        actionId,
        status: textCount === validTextCount ? (block?.is_error === true ? 'failed' : 'completed') : 'running',
        output: text.join('\n'),
      }));
    } else {
      const nativeType = stringValue(value?.type) ?? 'unknown-content';
      result.push(unsupported(`${uuid}:tool-result:${parentIndex}:${nativeType}:${index}`, nativeType, observedAt, value ?? {}, turnId));
    }
  }
  if (validTextCount === 0) {
    result.push(event(baseId, 'tool_result', observedAt, {
      kind: 'action-updated', turnId, actionId, status: block?.is_error === true ? 'failed' : 'completed',
    }));
  }
  return result;
}

function resultStatus(subtype: unknown): 'completed' | 'interrupted' | 'failed' | undefined {
  if (subtype === 'success') return 'completed';
  if (subtype === 'error') return 'failed';
  if (subtype === 'interrupted') return 'interrupted';
  return undefined;
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
