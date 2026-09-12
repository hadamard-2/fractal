import type {
  AgentAction,
  BlockingRequest,
  CaptureCompleteness,
  ConversationRef,
  ConversationRuntime,
  ConversationStreamEvent,
  ConversationSummary,
  ConversationTurn,
  ProviderId,
  TurnBlock,
  UserDecision,
} from '@/shared/conversation-contract';

const MAX_TEXT_LENGTH = 1_000_000;
const MAX_DECISION_TEXT_LENGTH = 100_000;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 32_768;
const MAX_HISTORY_TURNS = 50;

const RUNTIMES: readonly ConversationRuntime[] = [
  'idle',
  'active-in-fractal',
  'waiting-for-user',
  'active-externally',
  'unknown',
  'failed',
];
const COMPLETENESS: readonly CaptureCompleteness[] = ['complete', 'partial', 'unknown'];
const PROVIDERS: readonly ProviderId[] = ['codex', 'claude'];

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length <= max;
}

function nonblankText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return text(value, max) && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function provider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

function runtime(value: unknown): value is ConversationRuntime {
  return typeof value === 'string' && (RUNTIMES as readonly string[]).includes(value);
}

function completeness(value: unknown): value is CaptureCompleteness {
  return typeof value === 'string' && (COMPLETENESS as readonly string[]).includes(value);
}

function absolutePath(value: unknown): value is string {
  return nonblankText(value, MAX_PATH_LENGTH) && (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value));
}

function invalidRef(): never {
  throw new Error('Invalid conversation reference');
}

function invalidDecision(): never {
  throw new Error('Invalid decision');
}

function invalidEvent(): never {
  throw new Error('Invalid conversation stream event');
}

export function parseConversationRef(value: unknown): ConversationRef {
  if (!plainObject(value) || !provider(value.provider) || !nonblankText(value.nativeSessionId, MAX_SESSION_ID_LENGTH) || !absolutePath(value.projectPath)) {
    invalidRef();
  }
  return {
    provider: value.provider,
    nativeSessionId: value.nativeSessionId,
    projectPath: value.projectPath,
  };
}

export function parseLoadId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('Invalid load id');
  }
  return value;
}

export function parsePromptInput(value: unknown): { text: string } {
  if (!plainObject(value) || typeof value.text !== 'string') invalidDecision();
  if (value.text.trim().length === 0) throw new Error('Prompt cannot be empty');
  if (value.text.length > MAX_TEXT_LENGTH) throw new Error('Prompt is too large');
  return { text: value.text as string };
}

function cloneUserDecision(value: unknown, error: () => never = invalidDecision): UserDecision {
  if (!plainObject(value) || typeof value.kind !== 'string') error();
  switch (value.kind) {
    case 'allow-once':
      return { kind: 'allow-once' };
    case 'allow-and-remember':
      if (!nonblankText(value.scope, MAX_DECISION_TEXT_LENGTH)) error();
      return { kind: 'allow-and-remember', scope: value.scope as string };
    case 'deny':
      if (value.reason !== undefined && !text(value.reason, MAX_DECISION_TEXT_LENGTH)) error();
      return value.reason === undefined ? { kind: 'deny' } : { kind: 'deny', reason: value.reason as string };
    case 'answer': {
      if (!plainObject(value.answers)) error();
      const answers: Record<string, string> = {};
      for (const [key, answer] of Object.entries(value.answers)) {
        if (!text(key, MAX_DECISION_TEXT_LENGTH) || !text(answer, MAX_DECISION_TEXT_LENGTH)) error();
        answers[key] = answer;
      }
      return { kind: 'answer', answers };
    }
    default:
      error();
  }
}

export function parseUserDecision(value: unknown): UserDecision {
  return cloneUserDecision(value);
}

function cloneAction(value: unknown): AgentAction {
  if (!plainObject(value) || !nonblankText(value.id) || !nonblankText(value.nativeId) || !provider(value.provider) || !text(value.status) || !completeness(value.captureCompleteness) || !['requested', 'awaiting-approval', 'running', 'completed', 'failed', 'denied', 'interrupted'].includes(value.status)) invalidEvent();
  const base = {
    id: value.id,
    nativeId: value.nativeId,
    provider: value.provider,
    status: value.status as AgentAction['status'],
    captureCompleteness: value.captureCompleteness,
    ...(value.startedAt === undefined ? {} : finiteNumber(value.startedAt) ? { startedAt: value.startedAt } : invalidEvent()),
    ...(value.completedAt === undefined ? {} : finiteNumber(value.completedAt) ? { completedAt: value.completedAt } : invalidEvent()),
  };
  switch (value.kind) {
    case 'file-read':
      if (!text(value.path)) invalidEvent();
      return { ...base, kind: 'file-read', path: value.path };
    case 'file-edit':
      if (!text(value.path) || (value.patch !== undefined && !text(value.patch))) invalidEvent();
      return { ...base, kind: 'file-edit', path: value.path, ...(value.patch === undefined ? {} : { patch: value.patch as string }) };
    case 'command':
      if (!text(value.command) || (value.cwd !== undefined && !text(value.cwd)) || (value.output !== undefined && !text(value.output)) || (value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode))) invalidEvent();
      return { ...base, kind: 'command', command: value.command, ...(value.cwd === undefined ? {} : { cwd: value.cwd as string }), ...(value.output === undefined ? {} : { output: value.output as string }), ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number }) };
    case 'search':
      if (!text(value.query) || (value.scope !== undefined && !text(value.scope)) || (value.resultSummary !== undefined && !text(value.resultSummary))) invalidEvent();
      return { ...base, kind: 'search', query: value.query, ...(value.scope === undefined ? {} : { scope: value.scope as string }), ...(value.resultSummary === undefined ? {} : { resultSummary: value.resultSummary as string }) };
    case 'tool':
      if (!text(value.name) || !text(value.inputSummary) || (value.outputSummary !== undefined && !text(value.outputSummary))) invalidEvent();
      return { ...base, kind: 'tool', name: value.name, inputSummary: value.inputSummary, ...(value.outputSummary === undefined ? {} : { outputSummary: value.outputSummary as string }) };
    case 'subagent':
      if (!text(value.label) || (value.parentNativeId !== undefined && !text(value.parentNativeId)) || !Array.isArray(value.actions)) invalidEvent();
      return { ...base, kind: 'subagent', label: value.label, ...(value.parentNativeId === undefined ? {} : { parentNativeId: value.parentNativeId as string }), actions: value.actions.map(cloneAction) };
    default:
      invalidEvent();
  }
}

function cloneBlockingRequest(value: unknown): BlockingRequest {
  if (!plainObject(value) || !nonblankText(value.id) || !provider(value.provider) || !['open', 'resolved'].includes(String(value.status))) invalidEvent();
  const decision = value.decision === undefined ? {} : { decision: cloneUserDecision(value.decision, invalidEvent) };
  if (value.kind === 'approval') {
    if (!text(value.title) || !text(value.operation) || (value.rememberScope !== undefined && !nonblankText(value.rememberScope, MAX_DECISION_TEXT_LENGTH))) invalidEvent();
    return { id: value.id, kind: 'approval', provider: value.provider, title: value.title as string, operation: value.operation as string, ...(value.rememberScope === undefined ? {} : { rememberScope: value.rememberScope as string }), status: value.status as 'open' | 'resolved', ...decision };
  }
  if (value.kind === 'question') {
    if (!text(value.prompt) || !nonblankText(value.fieldId) || typeof value.allowFreeText !== 'boolean' || (value.choices !== undefined && !Array.isArray(value.choices))) invalidEvent();
    const choices = (value.choices as unknown[] | undefined)?.map((choice) => {
      if (!plainObject(choice) || !nonblankText(choice.value) || !text(choice.label)) invalidEvent();
      return { value: choice.value, label: choice.label };
    });
    return { id: value.id, kind: 'question', provider: value.provider, prompt: value.prompt as string, fieldId: value.fieldId as string, ...(choices === undefined ? {} : { choices }), allowFreeText: value.allowFreeText as boolean, status: value.status as 'open' | 'resolved', ...decision };
  }
  invalidEvent();
}

function cloneTurnBlock(value: unknown): TurnBlock {
  if (!plainObject(value) || !nonblankText(value.id) || typeof value.kind !== 'string') invalidEvent();
  switch (value.kind) {
    case 'assistant-prose':
      if (!text(value.text) || !provider(value.provider)) invalidEvent();
      return { id: value.id, kind: 'assistant-prose', text: value.text, provider: value.provider };
    case 'work-packet':
      if (!['active', 'completed', 'failed'].includes(String(value.status)) || !Array.isArray(value.actions)) invalidEvent();
      if (value.startedAt !== undefined && !finiteNumber(value.startedAt)) invalidEvent();
      if (value.completedAt !== undefined && !finiteNumber(value.completedAt)) invalidEvent();
      return { id: value.id, kind: 'work-packet', status: value.status as 'active' | 'completed' | 'failed', actions: value.actions.map(cloneAction), ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt as number }), ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt as number }) };
    case 'approval': {
      const request = cloneBlockingRequest(value.request);
      if (request.kind !== 'approval') invalidEvent();
      return { id: value.id, kind: 'approval', request };
    }
    case 'question': {
      const request = cloneBlockingRequest(value.request);
      if (request.kind !== 'question') invalidEvent();
      return { id: value.id, kind: 'question', request };
    }
    case 'system-notice':
      if (!text(value.message) || !['info', 'warning', 'error'].includes(String(value.tone))) invalidEvent();
      return { id: value.id, kind: 'system-notice', message: value.message as string, tone: value.tone as 'info' | 'warning' | 'error' };
    case 'unsupported':
      if (!provider(value.provider) || !text(value.nativeType) || !text(value.summary) || !completeness(value.captureCompleteness)) invalidEvent();
      return { id: value.id, kind: 'unsupported', provider: value.provider, nativeType: value.nativeType, summary: value.summary, captureCompleteness: value.captureCompleteness };
    default:
      invalidEvent();
  }
}

function cloneTurn(value: unknown): ConversationTurn {
  if (!plainObject(value) || !nonblankText(value.id) || !text(value.nativeId) || !plainObject(value.userMessage) || !nonblankText(value.userMessage.id) || !text(value.userMessage.text) || !Array.isArray(value.blocks) || !['active', 'completed', 'interrupted', 'failed'].includes(String(value.status)) || !completeness(value.captureCompleteness)) invalidEvent();
  if (value.userMessage.createdAt !== undefined && !finiteNumber(value.userMessage.createdAt)) invalidEvent();
  return {
    id: value.id,
    nativeId: value.nativeId,
    userMessage: { id: value.userMessage.id as string, text: value.userMessage.text as string, ...(value.userMessage.createdAt === undefined ? {} : { createdAt: value.userMessage.createdAt as number }) },
    blocks: value.blocks.map(cloneTurnBlock),
    status: value.status as 'active' | 'completed' | 'interrupted' | 'failed',
    captureCompleteness: value.captureCompleteness,
  };
}

function cloneSummary(value: unknown): ConversationSummary {
  if (!plainObject(value) || !text(value.title) || !finiteNumber(value.updatedAt) || (value.createdAt !== undefined && !finiteNumber(value.createdAt)) || !runtime(value.runtime) || !completeness(value.captureCompleteness)) invalidEvent();
  return {
    ref: parseConversationRef(value.ref),
    title: value.title,
    updatedAt: value.updatedAt,
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt as number }),
    runtime: value.runtime,
    captureCompleteness: value.captureCompleteness,
  };
}

export function parseConversationStreamEvent(value: unknown): ConversationStreamEvent {
  try {
    if (!plainObject(value) || typeof value.type !== 'string' || !nonnegativeInteger(value.seq)) invalidEvent();
    const envelope = { loadId: parseLoadId(value.loadId), seq: value.seq, ref: parseConversationRef(value.ref) };
    switch (value.type) {
      case 'history.chunk':
        if (!nonnegativeInteger(value.chunkIndex) || !Array.isArray(value.turns) || value.turns.length > MAX_HISTORY_TURNS) invalidEvent();
        return { ...envelope, type: 'history.chunk', chunkIndex: value.chunkIndex, turns: value.turns.map(cloneTurn) };
      case 'history.complete':
        return { ...envelope, type: 'history.complete' };
      case 'turn.upserted':
        return { ...envelope, type: 'turn.upserted', turn: cloneTurn(value.turn) };
      case 'assistant.delta':
        if (!nonblankText(value.turnId) || !nonblankText(value.blockId) || !text(value.delta)) invalidEvent();
        return { ...envelope, type: 'assistant.delta', turnId: value.turnId, blockId: value.blockId, delta: value.delta };
      case 'action.upserted':
        if (!nonblankText(value.turnId) || !nonblankText(value.packetId)) invalidEvent();
        return { ...envelope, type: 'action.upserted', turnId: value.turnId, packetId: value.packetId, action: cloneAction(value.action) };
      case 'runtime.changed':
        if (!runtime(value.runtime)) invalidEvent();
        return { ...envelope, type: 'runtime.changed', runtime: value.runtime };
      case 'request.opened':
        return { ...envelope, type: 'request.opened', request: cloneBlockingRequest(value.request) };
      case 'request.resolved':
        if (!nonblankText(value.requestId)) invalidEvent();
        return { ...envelope, type: 'request.resolved', requestId: value.requestId, decision: cloneUserDecision(value.decision, invalidEvent) };
      case 'summary.updated':
        return { ...envelope, type: 'summary.updated', summary: cloneSummary(value.summary) };
      case 'load.failed':
        if (!text(value.message)) invalidEvent();
        return { ...envelope, type: 'load.failed', message: value.message };
      default:
        invalidEvent();
    }
  } catch {
    invalidEvent();
  }
}
