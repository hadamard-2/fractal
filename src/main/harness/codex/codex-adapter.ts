import { realpath } from 'node:fs/promises';
import type { CodexAppServer, CodexRequestMap } from '@/main/harness/codex/codex-app-server';
import { createCodexLiveNormalizationContext, normalizeCodexNotification, normalizeCodexServerRequest, normalizeCodexThread } from '@/main/harness/codex/codex-normalizer';
import { reconcileNativeEvents, type NativeEvent } from '@/main/harness/reconciler';
import { canonicalizeProjectPath, type Realpath } from '@/main/harness/project-path';
import type { ConversationRef, ConversationRuntime, ConversationSummary, HarnessCapabilities, HarnessStatus, UserDecision } from '@/shared/conversation-contract';
import type { ConversationRun, HarnessAdapter, LoadedConversation, NativeEventSink, Unsubscribe } from '@/main/harness/types';

type CodexServer = Pick<CodexAppServer, 'request' | 'onNotification' | 'onServerRequest' | 'respond' | 'respondError' | 'status'> & Partial<Pick<CodexAppServer, 'onStatus'>>;
type BufferedObservation = { normalize: () => NativeEvent[]; delta?: { key: string; text: string } };

const CAPABILITIES: HarnessCapabilities = {
  create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false,
};

export class CodexAdapter implements HarnessAdapter {
  readonly provider = 'codex' as const;

  constructor(private readonly server: CodexServer, private readonly dependencies: { realpath?: Realpath } = {}) {}

  async probe(): Promise<HarnessStatus> {
    return { provider: 'codex', availability: this.server.status.availability, ...(this.server.status.message ? { message: this.server.status.message } : {}), capabilities: this.capabilities() };
  }

  capabilities(): HarnessCapabilities { return CAPABILITIES; }

  async listConversations(): Promise<ConversationSummary[]> {
    const summaries = new Map<string, ConversationSummary>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await this.server.request('thread/list', {
        archived: false, sortKey: 'updated_at', sortDirection: 'desc', limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const thread of response.data) {
        if (!summaries.has(thread.id)) summaries.set(thread.id, await this.summaryFromThread(thread, 'unknown'));
      }
      cursor = response.nextCursor;
      if (cursor && cursors.has(cursor)) break;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return Array.from(summaries.values());
  }

  async loadConversation(ref: ConversationRef): Promise<LoadedConversation> {
    const thread = await this.readThread(ref);
    const events = normalizeCodexThread(thread);
    return { summary: await this.summaryFromThread(thread, completenessFor(thread, events)), events: asAsyncIterable(events) };
  }

  async watchConversation(ref: ConversationRef, sink: NativeEventSink): Promise<Unsubscribe> {
    const live = createCodexLiveNormalizationContext();
    let known: NativeEvent[] = [];
    const buffered: BufferedObservation[] = [];
    let ready = false;
    const receive = (incoming: NativeEvent[]): void => {
      const byKey = new Map(known.map((event) => [`${event.provider}:${event.nativeId}`, event]));
      const accepted = incoming.filter((event) => !preferKnownFinal(byKey.get(`${event.provider}:${event.nativeId}`), event));
      const next = reconcileNativeEvents(known, accepted);
      for (const event of accepted) {
        const prior = byKey.get(`${event.provider}:${event.nativeId}`);
        if (!prior || !sameNativeObservation(prior, event)) sink(event);
      }
      known = next;
    };
    const notifications = this.server.onNotification((notification) => {
      if (!hasThreadId(notification) || notification.params.threadId !== ref.nativeSessionId) return;
      if (!ready) { buffered.push({ normalize: () => normalizeCodexNotification(notification, live), delta: bufferedDelta(notification) }); return; }
      receive(normalizeCodexNotification(notification, live));
    });
    const requests = this.server.onServerRequest?.((request) => {
      if (!hasThreadId(request) || request.params.threadId !== ref.nativeSessionId) return;
      if (!ready) { buffered.push({ normalize: () => normalizeCodexServerRequest(request) }); return; }
      receive(normalizeCodexServerRequest(request));
    });
    try {
      const thread = await this.readThread(ref);
      live.seed(thread);
      known = normalizeCodexThread(thread);
      const covered = coveredBufferedDeltas(known, buffered);
      ready = true;
      for (const event of known) sink(event);
      for (const pending of buffered.splice(0)) {
        if (!pending.delta || !covered.has(pending.delta.key)) receive(pending.normalize());
      }
    } catch (error) {
      notifications();
      requests?.();
      throw error;
    }
    return () => { notifications(); requests?.(); };
  }

  async createConversation(projectPath: string): Promise<ConversationRef> {
    const canonical = await this.canonicalPath(projectPath);
    const response = await this.server.request('thread/start', { cwd: canonical });
    const returnedPath = await this.canonicalPath(response.thread.cwd);
    if (returnedPath !== canonical) throw new Error('Created Codex project does not match the selected project');
    return { provider: 'codex', nativeSessionId: response.thread.id, projectPath: canonical };
  }

  async continueConversation(ref: ConversationRef, prompt: { text: string }): Promise<ConversationRun> {
    if (ref.provider !== 'codex') throw new Error('Conversation provider must be codex');
    const projectPath = await this.canonicalPath(ref.projectPath);
    const resumed = await this.server.request('thread/resume', { threadId: ref.nativeSessionId, cwd: projectPath });
    if (resumed.thread.id !== ref.nativeSessionId) throw new Error('Resumed Codex thread does not match the requested thread');
    if (await this.canonicalPath(resumed.thread.cwd) !== projectPath) throw new Error('Resumed Codex project does not match the requested project');
    const queue = new NativeEventQueue();
    const live = createCodexLiveNormalizationContext();
    const pending = new Map<string, { rpcId: string | number; request: Parameters<typeof normalizeCodexServerRequest>[0] }>();
    const bufferedTraffic: Array<
      | { kind: 'notification'; value: Parameters<typeof normalizeCodexNotification>[0] }
      | { kind: 'request'; value: Parameters<typeof normalizeCodexServerRequest>[0] }
    > = [];
    let turnId: string | undefined;
    let completeTurn!: () => void;
    const turnCompleted = new Promise<void>((resolve) => { completeTurn = resolve; });
    let interrupting: Promise<void> | undefined;
    let disposed = false;
    const receiveNotification = (notification: Parameters<typeof normalizeCodexNotification>[0]): void => {
      if (!turnId) { bufferedTraffic.push({ kind: 'notification', value: notification }); return; }
      if (!matchesNotificationRun(notification, ref.nativeSessionId, turnId)) return;
      for (const event of normalizeCodexNotification(notification, live)) queue.push(event);
      if (isValidRunCompletion(notification, ref.nativeSessionId, turnId)) { completeTurn(); queue.close(); }
    };
    const receiveRequest = (request: Parameters<typeof normalizeCodexServerRequest>[0]): void => {
      if (!turnId) { bufferedTraffic.push({ kind: 'request', value: request }); return; }
      if (!matchesRun(request, ref.nativeSessionId, turnId)) return;
      if (request.method !== 'item/commandExecution/requestApproval' && request.method !== 'item/fileChange/requestApproval' && request.method !== 'item/tool/requestUserInput') {
        this.server.respondError(request.id, -32601, 'Unsupported Codex request');
        return;
      }
      const events = normalizeCodexServerRequest(request);
      const opened = events.find((event) => event.payload.kind === 'request-opened');
      if (!opened || opened.payload.kind !== 'request-opened') {
        this.server.respondError(request.id, -32601, 'Unsupported Codex request');
        return;
      }
      if (pending.has(opened.payload.request.id)) {
        this.denyRequestSafely(request.id, request);
        return;
      }
      pending.set(opened.payload.request.id, { rpcId: request.id, request });
      events.forEach((event) => queue.push(event));
    };
    const notifications = this.server.onNotification(receiveNotification);
    const requests = this.server.onServerRequest(receiveRequest);
    let reconnectGeneration = 0;
    const statuses = this.server.onStatus?.((status) => {
      const generation = ++reconnectGeneration;
      if (status.availability === 'unavailable') {
        for (const [requestId, entry] of pending) {
          this.denyRequestSafely(entry.rpcId, entry.request);
          queue.push(requestResolution(turnId ?? 'pending-turn', requestId, { kind: 'deny', reason: 'Codex connection was lost' }));
        }
        pending.clear();
        if (status.message === 'Codex App Server reconnect failed after 3 attempts') {
          completeTurn();
          queue.fail(new Error(status.message));
          return;
        }
        queue.push(runNotice(turnId ?? 'pending-turn', 'Codex connection was lost; native state is being reconciled', 'warning'));
        return;
      }
      if (!turnId) return;
      void this.reconcileRunAfterReconnect(ref, turnId, queue, generation, () => reconnectGeneration, completeTurn).catch(() => {
        if (generation === reconnectGeneration) {
          queue.push(runNotice(turnId, 'Codex native state could not be reconciled', 'error'));
          queue.close();
        }
      });
    });
    const cleanup = (): void => { notifications(); requests(); statuses?.(); };
    queue.onClose(cleanup);
    try {
      const started = await this.server.request('turn/start', {
        threadId: ref.nativeSessionId,
        input: [{ type: 'text', text: prompt.text, text_elements: [] }],
      });
      turnId = started.turn.id;
      for (const traffic of bufferedTraffic.splice(0)) {
        if (traffic.kind === 'notification') receiveNotification(traffic.value);
        else receiveRequest(traffic.value);
      }
    } catch (error) {
      cleanup();
      throw error;
    }
    return {
      events: queue,
      interrupt: () => {
        if (!interrupting) interrupting = this.server.request('turn/interrupt', { threadId: ref.nativeSessionId, turnId }).then(() => turnCompleted);
        return interrupting;
      },
      resolveRequest: async (requestId, decision) => {
        const entry = pending.get(requestId);
        if (!entry) throw new Error('Codex request is no longer available');
        pending.delete(requestId);
        this.respondToRequest(entry.rpcId, entry.request, decision);
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        for (const entry of pending.values()) this.denyRequestSafely(entry.rpcId, entry.request);
        pending.clear();
        completeTurn();
        queue.close();
      },
    };
  }

  private async reconcileRunAfterReconnect(ref: ConversationRef, turnId: string, queue: NativeEventQueue, generation: number, currentGeneration: () => number, completeTurn: () => void): Promise<void> {
    const thread = await this.readThread(ref);
    if (generation !== currentGeneration()) return;
    normalizeCodexThread(thread).forEach((event) => queue.push(event));
    if (thread.status.type === 'idle') {
      queue.push(runNotice(turnId, 'Codex thread is idle', 'info'));
      completeTurn();
      queue.close();
    }
  }

  private respondToRequest(id: string | number, request: Parameters<typeof normalizeCodexServerRequest>[0], decision: UserDecision): void {
    if (request.method === 'item/tool/requestUserInput') {
      if (decision.kind !== 'answer') { this.server.respondError(id, -32602, 'A question answer is required'); return; }
      const answers = Object.fromEntries(Object.entries(decision.answers).map(([fieldId, answer]) => [fieldId, { answers: [answer] }]));
      this.server.respond(id, { answers });
      return;
    }
    if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
      if (decision.kind === 'allow-once') this.server.respond(id, { decision: 'accept' });
      else if (decision.kind === 'deny') this.server.respond(id, { decision: 'decline' });
      else this.server.respondError(id, -32602, 'Unsupported approval decision');
      return;
    }
    this.server.respondError(id, -32601, 'Unsupported Codex request');
  }

  private denyRequest(id: string | number, request: Parameters<typeof normalizeCodexServerRequest>[0]): void {
    if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') this.server.respond(id, { decision: 'decline' });
    else this.server.respondError(id, -32000, 'Fractal disconnected before the request was resolved');
  }

  private denyRequestSafely(id: string | number, request: Parameters<typeof normalizeCodexServerRequest>[0]): void {
    try { this.denyRequest(id, request); } catch { /* A disconnected transport is already fail closed. */ }
  }

  private async readThread(ref: ConversationRef) {
    if (ref.provider !== 'codex') throw new Error('Conversation provider must be codex');
    const response = await this.server.request('thread/read', { threadId: ref.nativeSessionId, includeTurns: true });
    const thread = response.thread;
    if (thread.id !== ref.nativeSessionId) throw new Error('Requested Codex thread does not match the discovered thread');
    if (await this.canonicalPath(thread.cwd) !== await this.canonicalPath(ref.projectPath)) throw new Error('Requested Codex project does not match the discovered thread');
    return thread;
  }

  private canonicalPath(value: string): Promise<string> {
    const resolve = this.dependencies.realpath ?? (async (input: string) => realpath(input).catch(() => input));
    return canonicalizeProjectPath(value, resolve);
  }

  private async summaryFromThread(thread: Awaited<CodexRequestMap['thread/read']['result']>['thread'], captureCompleteness: ConversationSummary['captureCompleteness']): Promise<ConversationSummary> {
    return summaryFromThread(thread, captureCompleteness, await this.canonicalPath(thread.cwd));
  }
}

function summaryFromThread(thread: Awaited<CodexRequestMap['thread/read']['result']>['thread'], captureCompleteness: ConversationSummary['captureCompleteness'], projectPath: string): ConversationSummary {
  const title = thread.name?.trim() || thread.preview.trim() || firstUserText(thread) || 'Codex conversation';
  return {
    ref: { provider: 'codex', nativeSessionId: thread.id, projectPath }, title,
    createdAt: thread.createdAt * 1000, updatedAt: thread.updatedAt * 1000,
    runtime: runtimeFor(thread.status), captureCompleteness,
  };
}

function completenessFor(thread: Awaited<CodexRequestMap['thread/read']['result']>['thread'], events: NativeEvent[]): ConversationSummary['captureCompleteness'] {
  if (events.some((event) => event.payload.kind === 'unsupported')) return 'partial';
  return thread.turns.every((turn) => turn.itemsView === 'full') ? 'complete' : 'unknown';
}

function firstUserText(thread: Awaited<CodexRequestMap['thread/read']['result']>['thread']): string | undefined {
  if (!Array.isArray(thread.turns)) return undefined;
  for (const turn of thread.turns) {
    if (!turn || !Array.isArray(turn.items)) continue;
    const item = turn.items.find((candidate) => isObject(candidate) && candidate.type === 'userMessage');
    if (!item || item.type !== 'userMessage' || !Array.isArray(item.content)) continue;
    const text = item.content.flatMap((content) => isObject(content) && content.type === 'text' && typeof content.text === 'string' ? [content.text] : []).join('\n').trim();
    if (text) return text;
  }
  return undefined;
}

function runtimeFor(status: Awaited<CodexRequestMap['thread/read']['result']>['thread']['status']): ConversationRuntime {
  if (status.type === 'idle') return 'idle';
  if (status.type === 'systemError') return 'failed';
  if (status.type === 'active') return status.activeFlags.length > 0 ? 'waiting-for-user' : 'active-externally';
  return 'unknown';
}

function hasThreadId(value: unknown): value is { params: { threadId: string } } {
  return typeof value === 'object' && value !== null && 'params' in value
    && typeof (value as { params?: { threadId?: unknown } }).params?.threadId === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }

function bufferedDelta(notification: unknown): BufferedObservation['delta'] {
  if (!isObject(notification) || !isObject(notification.params)) return undefined;
  const kind = notification.method === 'item/agentMessage/delta' ? 'assistant'
    : notification.method === 'item/commandExecution/outputDelta' ? 'command' : undefined;
  const { turnId, itemId, delta } = notification.params;
  if (!kind || typeof turnId !== 'string' || typeof itemId !== 'string' || typeof delta !== 'string') return undefined;
  return { key: JSON.stringify([turnId, itemId, kind]), text: delta };
}

function coveredBufferedDeltas(snapshot: NativeEvent[], buffered: BufferedObservation[]): Set<string> {
  const sequences = new Map<string, string>();
  for (const { delta } of buffered) {
    if (delta) sequences.set(delta.key, `${sequences.get(delta.key) ?? ''}${delta.text}`);
  }
  const covered = new Set<string>();
  for (const { payload } of snapshot) {
    let key: string;
    let text: string;
    if (payload.kind === 'assistant-text' && !payload.final) {
      key = JSON.stringify([payload.turnId, payload.blockId, 'assistant']);
      text = payload.text;
    } else if (payload.kind === 'action-updated' && payload.status === 'running' && typeof payload.output === 'string') {
      key = JSON.stringify([payload.turnId, payload.actionId, 'command']);
      text = payload.output;
    } else continue;
    const sequence = sequences.get(key);
    // Only an entire buffered sequence matching this active item's suffix is covered.
    if (sequence !== undefined && text.endsWith(sequence)) covered.add(key);
  }
  return covered;
}

function sameNativeObservation(left: NativeEvent, right: NativeEvent): boolean {
  return left.nativeType === right.nativeType && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

function preferKnownFinal(known: NativeEvent | undefined, incoming: NativeEvent): boolean {
  if (!known) return false;
  if (known.payload.kind === 'assistant-text' && known.payload.final && incoming.payload.kind === 'assistant-text' && !incoming.payload.final) return true;
  return known.payload.kind === 'action-updated' && incoming.payload.kind === 'action-updated'
    && ['completed', 'failed', 'denied', 'interrupted'].includes(known.payload.status)
    && incoming.payload.status === 'running';
}

async function* asAsyncIterable(events: NativeEvent[]): AsyncGenerator<NativeEvent> { yield* events; }

function matchesRun(value: unknown, threadId: string, turnId: string): value is { params: { threadId: string; turnId: string } } {
  return isObject(value) && isObject(value.params) && value.params.threadId === threadId && value.params.turnId === turnId;
}

function matchesNotificationRun(value: unknown, threadId: string, turnId: string): boolean {
  if (!isObject(value) || !isObject(value.params) || value.params.threadId !== threadId) return false;
  if (value.method === 'turn/completed' || value.method === 'turn/started') return isObject(value.params.turn) && value.params.turn.id === turnId;
  return value.params.turnId === turnId;
}

class NativeEventQueue implements AsyncIterable<NativeEvent> {
  private readonly values: NativeEvent[] = [];
  private readonly waiting: Array<{ resolve: (result: IteratorResult<NativeEvent>) => void; reject: (error: Error) => void }> = [];
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private failure: Error | undefined;
  push(value: NativeEvent): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waiting.splice(0).forEach(({ resolve }) => resolve({ done: true, value: undefined }));
    this.closeListeners.forEach((listener) => listener());
    this.closeListeners.clear();
  }
  fail(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.values.splice(0);
    this.waiting.splice(0).forEach(({ reject }) => reject(error));
    this.closeListeners.forEach((listener) => listener());
    this.closeListeners.clear();
  }
  onClose(listener: () => void): void { if (this.closed) listener(); else this.closeListeners.add(listener); }
  [Symbol.asyncIterator](): AsyncIterator<NativeEvent> {
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ done: false, value });
      if (this.failure) return Promise.reject(this.failure);
      return this.closed ? Promise.resolve({ done: true, value: undefined }) : new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
    } };
  }
}

function runNotice(turnId: string, message: string, tone: 'info' | 'warning' | 'error'): NativeEvent {
  return { provider: 'codex', nativeId: `${turnId}:reconnect:${message}`, nativeType: 'connection-status', observedAt: Date.now(), payload: { kind: 'system-notice', turnId, message, tone } };
}

function requestResolution(turnId: string, requestId: string, decision: UserDecision): NativeEvent {
  return { provider: 'codex', nativeId: `request:${requestId}:disconnect`, nativeType: 'connection-status', observedAt: Date.now(), payload: { kind: 'request-resolved', turnId, requestId, decision } };
}

function isValidRunCompletion(notification: unknown, threadId: string, turnId: string): boolean {
  if (!isObject(notification) || notification.method !== 'turn/completed' || !isObject(notification.params) || notification.params.threadId !== threadId || !isObject(notification.params.turn)) return false;
  const turn = notification.params.turn;
  return turn.id === turnId
    && (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed')
    && Array.isArray(turn.items)
    && (turn.itemsView === 'full' || turn.itemsView === 'summary')
    && (turn.error === null || isObject(turn.error))
    && validNullableNumber(turn.startedAt)
    && validNullableNumber(turn.completedAt)
    && validNullableNumber(turn.durationMs);
}

function validNullableNumber(value: unknown): boolean { return value === null || (typeof value === 'number' && Number.isFinite(value)); }
