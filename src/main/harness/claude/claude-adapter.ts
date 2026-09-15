import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { canonicalizeProjectPath, type Realpath } from '@/main/harness/project-path';
import { discoverClaudeConversations, readClaudeConversation, watchClaudeConversation } from './claude-history';
import { ClaudePermissionBridge } from './claude-permission-bridge';
import { runClaudeTurn, type ClaudeTurnRun, type RunClaudeTurnOptions } from './claude-runner';
import type { ConversationRun, HarnessAdapter, LoadedConversation, NativeEventSink, Unsubscribe } from '@/main/harness/types';
import type { NativeEvent } from '@/main/harness/reconciler';
import type { BlockingRequest, ConversationRef, ConversationRuntime, ConversationSummary, HarnessCapabilities, HarnessStatus, UserDecision } from '@/shared/conversation-contract';
import { parseConversationRef } from '@/shared/conversation-ipc';
import type { ClaudeOwnedProcessRegistry } from './claude-owned-process-registry';

const NO_CAPABILITIES: HarnessCapabilities = { create: false, partialStreaming: false, approvals: false, questions: false, interrupt: false, steerWhileRunning: false, fork: false };
interface BridgeHandle { configPath: string; toolName: string; dispose(): Promise<void> }
interface BridgeStartOptions { tempDir: string; onRequest(request: BlockingRequest, signal: AbortSignal): Promise<UserDecision>; approvals: boolean; questions: boolean }
interface ClaudeAdapterDependencies {
  realpath?: Realpath;
  probe?: () => Promise<HarnessStatus>;
  runtime?: (ref: ConversationRef) => Promise<ConversationRuntime>;
  startBridge?: (options: BridgeStartOptions) => Promise<BridgeHandle>;
  runTurn?: (options: RunClaudeTurnOptions) => ClaudeTurnRun;
  randomUUID?: () => string;
  tempDir?: string;
  executable?: string;
  rereadNative?: (ref: ConversationRef) => Promise<NativeEvent[]>;
  ownedProcesses?: ClaudeOwnedProcessRegistry;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly provider = 'claude' as const;
  private status?: HarnessStatus;
  private readonly drafts = new Map<string, ConversationRef>();
  private readonly validatedSessions = new Set<string>();

  constructor(private readonly rootDir: string, private readonly dependencies: ClaudeAdapterDependencies = {}) {}

  async probe(): Promise<HarnessStatus> {
    if (this.dependencies.probe) this.status = await this.dependencies.probe();
    else {
      try { await access(this.rootDir); this.status = { provider: 'claude', availability: 'available', capabilities: { ...NO_CAPABILITIES } }; }
      catch { this.status = { provider: 'claude', availability: 'unavailable', message: 'Claude conversation history is unavailable.', capabilities: { ...NO_CAPABILITIES } }; }
    }
    return structuredClone(this.status);
  }
  capabilities(): HarnessCapabilities { return { ...(this.status?.capabilities ?? NO_CAPABILITIES) }; }

  async listConversations(): Promise<ConversationSummary[]> {
    return Promise.all((await discoverClaudeConversations(this.rootDir)).map(async ({ summary }) => {
      const ref = { ...summary.ref, projectPath: await this.canonicalPath(summary.ref.projectPath) };
      return { ...summary, ref, runtime: await this.runtime(ref) };
    }));
  }
  async loadConversation(ref: ConversationRef): Promise<LoadedConversation> {
    const found = await this.find(ref); const read = readClaudeConversation(found.filePath);
    void read.completion.catch((): void => undefined);
    return { summary: { ...found.summary, runtime: await this.runtime(found.summary.ref) }, events: read.events };
  }
  async watchConversation(ref: ConversationRef, sink: NativeEventSink): Promise<Unsubscribe> { return watchClaudeConversation((await this.find(ref)).filePath, sink); }

  async createConversation(projectPath: string): Promise<ConversationRef> {
    const status = await this.ensureStatus();
    if (status.availability !== 'available' || !status.capabilities.create) throw new Error('Claude conversation creation is not available');
    const ref: ConversationRef = { provider: 'claude', nativeSessionId: (this.dependencies.randomUUID ?? nodeRandomUUID)(), projectPath: await this.canonicalPath(projectPath) };
    this.drafts.set(ref.nativeSessionId, ref); return structuredClone(ref);
  }

  async continueConversation(input: ConversationRef, prompt: { text: string }): Promise<ConversationRun> {
    const ref = parseConversationRef(input);
    if (ref.provider !== 'claude') throw new Error('Conversation provider must be claude');
    ref.projectPath = await this.canonicalPath(ref.projectPath);
    const draft = this.drafts.get(ref.nativeSessionId);
    const newSession = draft?.projectPath === ref.projectPath;
    const status = await this.ensureStatus();
    if (status.availability !== 'available') throw new Error('Claude conversation continuation is not available');
    if (!newSession && !this.validatedSessions.has(ref.nativeSessionId)) await this.find(ref);
    if (!newSession && await this.runtime(ref) !== 'idle') throw new Error('Conversation is not idle');

    const queue = new NativeEventQueue(); const pending = new Map<string, PendingDecision>();
    let currentTurnId = `run:${ref.nativeSessionId}`;
    const settle = (requestId: string, decision: UserDecision): void => {
      const entry = pending.get(requestId); if (!entry) throw new Error('Claude request is no longer available');
      pending.delete(requestId); entry.signalCleanup(); entry.resolve(structuredClone(decision)); queue.push(resolutionEvent(entry.turnId, requestId, decision));
    };
    const onRequest = (request: BlockingRequest, signal: AbortSignal): Promise<UserDecision> => {
      if (pending.has(request.id)) return Promise.resolve({ kind: 'deny', reason: 'Duplicate permission request' });
      const turnId = currentTurnId; queue.push(requestEvent(turnId, request));
      return new Promise<UserDecision>((resolve) => {
        const onAbort = (): void => { if (pending.has(request.id)) settle(request.id, { kind: 'deny', reason: typeof signal.reason === 'string' ? signal.reason : 'Permission bridge closed' }); };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.set(request.id, { turnId, resolve, signalCleanup: () => signal.removeEventListener('abort', onAbort) });
      });
    };
    let bridge: BridgeHandle | undefined;
    if (status.capabilities.approvals || status.capabilities.questions) {
      if (!this.dependencies.startBridge && !this.dependencies.tempDir) throw new Error('Claude permission bridge temp path is unavailable');
      bridge = await (this.dependencies.startBridge ?? ((options) => ClaudePermissionBridge.start(options)))({
        tempDir: this.dependencies.tempDir ?? '', onRequest,
        approvals: status.capabilities.approvals, questions: status.capabilities.questions,
      });
    }
    let bridgeDisposal: Promise<void> | undefined;
    const disposeBridge = (): Promise<void> => bridgeDisposal ??= bridge?.dispose() ?? Promise.resolve();
    const releaseOwned = this.dependencies.ownedProcesses?.claim(ref) ?? (() => undefined);
    let runner: ClaudeTurnRun;
    try {
      runner = (this.dependencies.runTurn ?? runClaudeTurn)({ ref, prompt, executable: this.dependencies.executable ?? 'claude', ...(bridge ? { permissionBridge: bridge } : {}), ...(newSession ? { newSession: true } : {}), rereadNative: async () => {
        const events = await (this.dependencies.rereadNative?.(ref) ?? this.rereadExact(ref));
        if (newSession) { this.drafts.delete(ref.nativeSessionId); this.validatedSessions.add(ref.nativeSessionId); }
        return events;
      } });
    } catch (error) {
      releaseOwned(); if (newSession && draft) this.drafts.set(ref.nativeSessionId, draft); await disposeBridge(); throw error;
    }
    let disposed = false;
    const pump = (async () => {
      let failure: unknown;
      try { for await (const event of runner.events) { if (event.payload.kind === 'turn-started') currentTurnId = event.payload.turnId; queue.push(event); } }
      catch (error) { failure = error; }
      finally {
        await disposeBridge();
        releaseOwned();
        if (failure) queue.fail(failure); else queue.close();
      }
    })();
    void pump.catch((): void => undefined);
    return {
      events: queue,
      interrupt: () => runner.interrupt(),
      resolveRequest: async (requestId, decision) => settle(requestId, decision),
      dispose: async () => {
        if (disposed) return; disposed = true;
        for (const id of [...pending.keys()]) settle(id, { kind: 'deny', reason: 'Conversation run ended' });
        await runner.interrupt().catch((): void => undefined);
        await disposeBridge();
        await pump;
      },
    };
  }

  private async ensureStatus(): Promise<HarnessStatus> { return this.status ?? this.probe(); }
  private runtime(ref: ConversationRef): Promise<ConversationRuntime> { return this.dependencies.runtime?.(ref) ?? Promise.resolve('unknown'); }
  private async rereadExact(ref: ConversationRef): Promise<NativeEvent[]> {
    const found = await this.find(ref);
    if (found.ref.nativeSessionId !== ref.nativeSessionId || found.ref.projectPath !== ref.projectPath) throw new Error('Claude created conversation does not match the requested identity');
    const read = readClaudeConversation(found.filePath); const events: NativeEvent[] = [];
    for await (const event of read.events) events.push(event); await read.completion; return events;
  }
  private async find(input: ConversationRef) {
    const ref = parseConversationRef(input); if (ref.provider !== 'claude') throw new Error('Conversation provider must be claude');
    const projectPath = await this.canonicalPath(ref.projectPath);
    for (const found of await discoverClaudeConversations(this.rootDir)) {
      if (found.ref.nativeSessionId !== ref.nativeSessionId || await this.canonicalPath(found.ref.projectPath) !== projectPath) continue;
      const canonicalRef = { ...ref, projectPath }; return { ...found, ref: canonicalRef, summary: { ...found.summary, ref: canonicalRef } };
    }
    throw new Error('Claude conversation is not currently available in this project');
  }
  private canonicalPath(value: string): Promise<string> { return canonicalizeProjectPath(value, this.dependencies.realpath ?? (async (input) => realpath(input).catch(() => input))); }
}

interface PendingDecision { turnId: string; resolve(decision: UserDecision): void; signalCleanup(): void }
type Subscriber = { values: NativeEvent[]; wake?: () => void };
class NativeEventQueue implements AsyncIterable<NativeEvent> {
  private readonly values: NativeEvent[] = []; private readonly subscribers = new Set<Subscriber>(); private closed = false; private failure?: unknown;
  push(event: NativeEvent): void { if (this.closed) return; this.values.push(event); for (const subscriber of this.subscribers) { subscriber.values.push(event); subscriber.wake?.(); subscriber.wake = undefined; } }
  close(): void { if (this.closed) return; this.closed = true; for (const subscriber of this.subscribers) subscriber.wake?.(); }
  fail(error: unknown): void { this.failure = error; this.close(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<NativeEvent> {
    const subscriber: Subscriber = { values: [...this.values] }; this.subscribers.add(subscriber);
    try { while (true) { const next = subscriber.values.shift(); if (next) { yield next; continue; } if (this.closed) { if (this.failure) throw this.failure; return; } await new Promise<void>((resolve) => { subscriber.wake = resolve; }); } }
    finally { this.subscribers.delete(subscriber); }
  }
}
function requestEvent(turnId: string, request: BlockingRequest): NativeEvent { return { provider: 'claude', nativeId: `${request.id}:opened`, nativeType: request.kind, observedAt: Date.now(), payload: { kind: 'request-opened', turnId, request } }; }
function resolutionEvent(turnId: string, requestId: string, decision: UserDecision): NativeEvent { return { provider: 'claude', nativeId: `${requestId}:resolved`, nativeType: 'permission-result', observedAt: Date.now(), payload: { kind: 'request-resolved', turnId, requestId, decision: structuredClone(decision) } }; }
