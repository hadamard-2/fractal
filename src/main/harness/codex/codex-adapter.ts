import path from 'node:path';
import type { CodexAppServer, CodexRequestMap } from '@/main/harness/codex/codex-app-server';
import { normalizeCodexNotification, normalizeCodexServerRequest, normalizeCodexThread } from '@/main/harness/codex/codex-normalizer';
import { reconcileNativeEvents, type NativeEvent } from '@/main/harness/reconciler';
import type { ConversationRef, ConversationRuntime, ConversationSummary, HarnessCapabilities, HarnessStatus } from '@/shared/conversation-contract';
import type { ConversationRun, HarnessAdapter, LoadedConversation, NativeEventSink, Unsubscribe } from '@/main/harness/types';

type CodexServer = Pick<CodexAppServer, 'request' | 'onNotification' | 'status'> & Partial<Pick<CodexAppServer, 'onServerRequest'>>;

const READ_ONLY_CAPABILITIES: HarnessCapabilities = {
  create: false, partialStreaming: true, approvals: false, questions: false, interrupt: false, steerWhileRunning: false, fork: false,
};

export class CodexAdapter implements HarnessAdapter {
  readonly provider = 'codex' as const;

  constructor(private readonly server: CodexServer) {}

  async probe(): Promise<HarnessStatus> {
    return { provider: 'codex', availability: this.server.status.availability, ...(this.server.status.message ? { message: this.server.status.message } : {}), capabilities: this.capabilities() };
  }

  capabilities(): HarnessCapabilities { return READ_ONLY_CAPABILITIES; }

  async listConversations(): Promise<ConversationSummary[]> {
    const summaries: ConversationSummary[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.server.request('thread/list', {
        archived: false, sortKey: 'updated_at', sortDirection: 'desc', limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      summaries.push(...response.data.map((thread) => summaryFromThread(thread, 'unknown')));
      cursor = response.nextCursor;
    } while (cursor);
    return summaries;
  }

  async loadConversation(ref: ConversationRef): Promise<LoadedConversation> {
    const thread = await this.readThread(ref);
    const events = normalizeCodexThread(thread);
    return { summary: summaryFromThread(thread, completenessFor(thread, events)), events: asAsyncIterable(events) };
  }

  async watchConversation(ref: ConversationRef, sink: NativeEventSink): Promise<Unsubscribe> {
    const thread = await this.readThread(ref);
    let known = normalizeCodexThread(thread);
    const receive = (incoming: NativeEvent[]): void => {
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
      receive(normalizeCodexNotification(notification));
    });
    const requests = this.server.onServerRequest?.((request) => {
      if (!hasThreadId(request) || request.params.threadId !== ref.nativeSessionId) return;
      receive(normalizeCodexServerRequest(request));
    });
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
    if (canonicalPath(thread.cwd) !== canonicalPath(ref.projectPath)) throw new Error('Requested Codex project does not match the discovered thread');
    return thread;
  }
}

function summaryFromThread(thread: Awaited<CodexRequestMap['thread/read']['result']>['thread'], captureCompleteness: ConversationSummary['captureCompleteness']): ConversationSummary {
  const title = thread.name?.trim() || thread.preview.trim() || firstUserText(thread) || 'Codex conversation';
  return {
    ref: { provider: 'codex', nativeSessionId: thread.id, projectPath: canonicalPath(thread.cwd) }, title,
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

function canonicalPath(value: string): string { return path.resolve(value); }

function hasThreadId(value: unknown): value is { params: { threadId: string } } {
  return typeof value === 'object' && value !== null && 'params' in value
    && typeof (value as { params?: { threadId?: unknown } }).params?.threadId === 'string';
}

function sameNativeObservation(left: NativeEvent, right: NativeEvent): boolean {
  return left.nativeType === right.nativeType && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

async function* asAsyncIterable(events: NativeEvent[]): AsyncGenerator<NativeEvent> { yield* events; }
