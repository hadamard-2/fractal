import { realpath } from 'node:fs/promises';
import type { CodexAppServer, CodexRequestMap } from '@/main/harness/codex/codex-app-server';
import { createCodexLiveNormalizationContext, normalizeCodexNotification, normalizeCodexServerRequest, normalizeCodexThread } from '@/main/harness/codex/codex-normalizer';
import { reconcileNativeEvents, type NativeEvent } from '@/main/harness/reconciler';
import { canonicalizeProjectPath, type Realpath } from '@/main/harness/project-path';
import type { ConversationRef, ConversationRuntime, ConversationSummary, HarnessCapabilities, HarnessStatus } from '@/shared/conversation-contract';
import type { ConversationRun, HarnessAdapter, LoadedConversation, NativeEventSink, Unsubscribe } from '@/main/harness/types';

type CodexServer = Pick<CodexAppServer, 'request' | 'onNotification' | 'status'> & Partial<Pick<CodexAppServer, 'onServerRequest'>>;

const READ_ONLY_CAPABILITIES: HarnessCapabilities = {
  create: false, partialStreaming: true, approvals: false, questions: false, interrupt: false, steerWhileRunning: false, fork: false,
};

export class CodexAdapter implements HarnessAdapter {
  readonly provider = 'codex' as const;

  constructor(private readonly server: CodexServer, private readonly dependencies: { realpath?: Realpath } = {}) {}

  async probe(): Promise<HarnessStatus> {
    return { provider: 'codex', availability: this.server.status.availability, ...(this.server.status.message ? { message: this.server.status.message } : {}), capabilities: this.capabilities() };
  }

  capabilities(): HarnessCapabilities { return READ_ONLY_CAPABILITIES; }

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
    const buffered: NativeEvent[] = [];
    let ready = false;
    const receive = (incoming: NativeEvent[]): void => {
      if (!ready) { buffered.push(...incoming); return; }
      const byKey = new Map(known.map((event) => [`${event.provider}:${event.nativeId}`, event]));
      const next = reconcileNativeEvents(known, incoming);
      for (const event of incoming) {
        const prior = byKey.get(`${event.provider}:${event.nativeId}`);
        if (!prior || !sameNativeObservation(prior, event)) sink(event);
      }
      known = next;
    };
    const notifications = this.server.onNotification((notification) => {
      if (!hasThreadId(notification) || notification.params.threadId !== ref.nativeSessionId) return;
      receive(normalizeCodexNotification(notification, live));
    });
    const requests = this.server.onServerRequest?.((request) => {
      if (!hasThreadId(request) || request.params.threadId !== ref.nativeSessionId) return;
      receive(normalizeCodexServerRequest(request));
    });
    try {
      const thread = await this.readThread(ref);
      known = normalizeCodexThread(thread);
      ready = true;
      for (const event of known) sink(event);
      const pending = buffered.splice(0);
      if (pending.length > 0) receive(pending);
    } catch (error) {
      notifications();
      requests?.();
      throw error;
    }
    return () => { notifications(); requests?.(); };
  }

  async createConversation(projectPath: string): Promise<ConversationRef> {
    void projectPath;
    throw new Error('Codex conversation creation is not available yet');
  }

  async continueConversation(ref: ConversationRef, prompt: { text: string }): Promise<ConversationRun> {
    void ref;
    void prompt;
    throw new Error('Codex conversation continuation is not available yet');
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
  for (const turn of thread.turns) {
    const item = turn.items.find((candidate) => candidate.type === 'userMessage');
    if (!item || item.type !== 'userMessage') continue;
    const text = item.content.filter((content) => content.type === 'text').map((content) => content.text).join('\n').trim();
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

function sameNativeObservation(left: NativeEvent, right: NativeEvent): boolean {
  return left.nativeType === right.nativeType && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

async function* asAsyncIterable(events: NativeEvent[]): AsyncGenerator<NativeEvent> { yield* events; }
