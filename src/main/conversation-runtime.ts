import type { BlockingRequest, ConversationRuntime, UserDecision } from '@/shared/conversation-contract';

type RequestResolver = (requestId: string, decision: UserDecision) => Promise<void>;
type PendingRequest = {
  conversationKey: string;
  runId: string;
  rendererId: string;
  request: BlockingRequest;
  resolve: RequestResolver;
  timer: ReturnType<typeof setTimeout>;
};

const transitions: Record<ConversationRuntime, ReadonlySet<ConversationRuntime>> = {
  unknown: new Set(['idle', 'active-externally', 'failed']),
  idle: new Set(['active-in-fractal', 'active-externally', 'unknown', 'failed']),
  'active-in-fractal': new Set(['waiting-for-user', 'idle', 'failed']),
  'waiting-for-user': new Set(['active-in-fractal', 'failed']),
  'active-externally': new Set(['idle', 'unknown', 'failed']),
  failed: new Set(),
};

export class ConversationRuntimeController {
  private current: ConversationRuntime = 'unknown';
  private runId?: string;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly onRequestClosed?: (requestId: string) => void;

  constructor(options: { requestTimeoutMs?: number; onRequestClosed?: (requestId: string) => void } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10 * 60 * 1_000;
    this.onRequestClosed = options.onRequestClosed;
  }

  get state(): ConversationRuntime { return this.current; }
  get ownedRunId(): string | undefined { return this.runId; }

  canContinue(state: ConversationRuntime = this.current): boolean { return state === 'idle'; }

  observe(next: ConversationRuntime): void { this.move(next); }

  claimOwnedRun(runId: string): void {
    if (!runId || this.runId || !this.canContinue()) throw new Error('Conversation is not idle');
    this.runId = runId;
    this.move('active-in-fractal');
  }

  openRequest(input: Omit<PendingRequest, 'timer'>): void {
    if (!this.runId || input.runId !== this.runId || (this.current !== 'active-in-fractal' && this.current !== 'waiting-for-user')) throw new Error('Conversation request does not belong to the active run');
    if (this.requests.has(input.request.id)) throw new Error('Conversation request is already owned');
    const timer = setTimeout(() => { void this.deny(input.request.id, 'Request timed out').catch((): void => undefined); }, this.requestTimeoutMs);
    this.requests.set(input.request.id, { ...input, request: structuredClone(input.request), timer });
    if (this.current === 'active-in-fractal') this.move('waiting-for-user');
  }

  acknowledgeRequest(requestId: string): void {
    const pending = this.requests.get(requestId);
    if (!pending) return;
    this.requests.delete(requestId); clearTimeout(pending.timer); this.afterRequest();
    this.onRequestClosed?.(requestId);
  }

  async resolveRequest(requestId: string, decision: UserDecision): Promise<void> {
    const pending = this.take(requestId);
    if (decision.kind === 'allow-and-remember' && (pending.request.kind !== 'approval' || decision.scope !== pending.request.rememberScope)) {
      try { await pending.resolve(requestId, { kind: 'deny', reason: 'Permission scope did not match' }); }
      catch { /* The locally authored mismatch remains the public failure. */ }
      finally { this.afterRequest(); this.onRequestClosed?.(requestId); }
      throw new Error('Remembered permission scope does not match');
    }
    try { await pending.resolve(requestId, structuredClone(decision)); }
    finally { this.afterRequest(); this.onRequestClosed?.(requestId); }
  }

  async releaseRenderer(rendererId: string, reason: string): Promise<void> {
    const ids = Array.from(this.requests.values()).filter((request) => request.rendererId === rendererId).map((request) => request.request.id);
    await Promise.all(ids.map((id) => this.deny(id, reason)));
  }

  async denyAll(reason: string): Promise<void> {
    await Promise.allSettled(Array.from(this.requests.keys(), (id) => this.deny(id, reason)));
  }

  async failOwnedRun(runId: string, reason: string): Promise<void> {
    this.assertRun(runId);
    await this.denyAll(reason);
    this.move('failed');
  }

  releaseOwnedRun(runId: string, proven: ConversationRuntime): void {
    this.assertRun(runId);
    if (proven !== 'idle') throw new Error('Conversation runtime is not proven idle');
    for (const request of this.requests.values()) clearTimeout(request.timer);
    this.requests.clear();
    this.current = 'idle';
    this.runId = undefined;
  }

  private async deny(requestId: string, reason: string): Promise<void> {
    const pending = this.requests.get(requestId);
    if (!pending) return;
    this.requests.delete(requestId); clearTimeout(pending.timer);
    try { await pending.resolve(requestId, { kind: 'deny', reason }); }
    finally { this.afterRequest(); this.onRequestClosed?.(requestId); }
  }

  private take(requestId: string): PendingRequest {
    const pending = this.requests.get(requestId);
    if (!pending) throw new Error('Conversation request is no longer available');
    this.requests.delete(requestId); clearTimeout(pending.timer);
    return pending;
  }

  private afterRequest(): void {
    if (this.current === 'waiting-for-user' && this.requests.size === 0) this.move('active-in-fractal');
  }

  private assertRun(runId: string): void {
    if (!this.runId || this.runId !== runId) throw new Error('Conversation run is no longer owned');
  }

  private move(next: ConversationRuntime): void {
    if (next === this.current) return;
    if (!transitions[this.current].has(next)) throw new Error('Invalid conversation runtime transition');
    this.current = next;
  }
}
