import { setImmediate } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { ConversationRegistry } from '@/main/conversation-registry';
import { ConversationRuntimeController } from '@/main/conversation-runtime';
import { nativeEventKey, reconcileNativeEvents, type NativeEvent } from '@/main/harness/reconciler';
import { TurnProjector, type TurnProjectionUpdate } from '@/main/harness/turn-projector';
import type { AgentPrompt, ConversationRun, Unsubscribe } from '@/main/harness/types';
import { conversationKey, type ConversationRef, type ConversationStreamEvent, type ConversationSummary, type ConversationTurn, type HarnessCapabilities, type ProviderId, type UserDecision } from '@/shared/conversation-contract';
import { parseConversationRef, parseConversationTitle, parseLoadId } from '@/shared/conversation-ipc';

type OpenResult = { summary: ConversationSummary; capabilities: HarnessCapabilities };
type StreamPayload = ConversationStreamEvent extends infer Event ? Event extends ConversationStreamEvent ? Omit<Event, 'loadId' | 'seq' | 'ref'> : never : never;
type Load = {
  ref: ConversationRef;
  loadId: string;
  seq: number;
  closed: boolean;
  phase: 'watching' | 'loading' | 'live';
  unsubscribe?: Unsubscribe;
  iterator?: AsyncIterator<NativeEvent>;
  promise: Promise<OpenResult>;
  initial: Map<string, NativeEvent>;
  buffered: Map<string, NativeEvent>;
  projector: TurnProjector;
  currentTurnId?: string;
  // Normalized observations support replacements of previously emitted turns.
  // They are scoped to this open, never persisted or returned as a transcript.
  journal: Map<string, NativeEvent[]>;
  observations: Map<string, NativeEvent>;
  turns: Map<string, ConversationTurn>;
  unanchored: NativeEvent[];
  inferredFinishes: Map<string, number>;
};
type OwnedRun = { ref: ConversationRef; id: string; rendererId: string; run: ConversationRun; runtime: ConversationRuntimeController; settled: Promise<void>; events: Map<string, NativeEvent>; requests: Map<string, Extract<ConversationStreamEvent, { type: 'request.opened' }>['request']>; revokedReason?: string; revokedRequests: Set<string> };
type StartingRun = { id: string; rendererId: string; runtime: ConversationRuntimeController; cancelled: boolean; settled: Promise<void>; settle(): void };

const BUSY_RUNTIMES: ReadonlySet<ConversationSummary['runtime']> = new Set(['active-in-fractal', 'active-externally', 'waiting-for-user']);

export class ConversationService {
  private readonly loads = new Map<string, Load>();
  private readonly loadIds = new Map<string, Load>();
  private readonly ownedRuns = new Map<string, OwnedRun>();
  private readonly runtimes = new Map<string, ConversationRuntimeController>();
  private readonly requestOwners = new Map<string, OwnedRun>();
  private readonly startingRuns = new Map<string, StartingRun>();
  private readonly drafts = new Map<string, ConversationSummary>();
  private readonly chunkSize: number;
  private disposed = false;

  constructor(private readonly registry: ConversationRegistry, private readonly emit: (event: ConversationStreamEvent) => void, options: { historyChunkSize?: number } = {}) {
    this.chunkSize = options.historyChunkSize ?? 50;
    if (!Number.isInteger(this.chunkSize) || this.chunkSize < 1 || this.chunkSize > 50) throw new Error('History chunk size must be between 1 and 50');
  }

  async list() { this.assertAvailable(); return this.registry.list(); }

  async open(input: ConversationRef, inputLoadId: string): Promise<OpenResult> {
    this.assertAvailable();
    const ref = parseConversationRef(input);
    const loadId = parseLoadId(inputLoadId);
    const key = conversationKey(ref);
    const duplicate = this.loadIds.get(loadId);
    if (duplicate) {
      if (conversationKey(duplicate.ref) !== key || duplicate.ref.projectPath !== ref.projectPath) throw new Error('Load id is already in use');
      return duplicate.promise;
    }
    const previous = this.loads.get(key);
    if (previous && previous.ref.projectPath !== ref.projectPath) throw new Error('Conversation project does not match the open conversation');
    if (previous) this.release(previous);
    const load: Load = {
      ref, loadId, seq: 0, closed: false, phase: 'watching',
      promise: Promise.resolve(undefined as never),
      initial: new Map(), buffered: new Map(), projector: new TurnProjector(), journal: new Map(), observations: new Map(), turns: new Map(), unanchored: [], inferredFinishes: new Map(),
    };
    this.loads.set(key, load);
    this.loadIds.set(loadId, load);
    const draft = this.drafts.get(key);
    if (draft?.ref.projectPath === ref.projectPath) {
      load.phase = 'live';
      load.promise = Promise.resolve({ summary: structuredClone(draft), capabilities: this.registry.resolve(ref).capabilities() });
      this.send(load, { type: 'history.complete' });
      this.replayOwnedRun(load);
      return load.promise;
    }
    load.promise = Promise.resolve().then(() => this.load(load));
    return load.promise;
  }

  async close(input: ConversationRef): Promise<void> {
    const ref = parseConversationRef(input);
    const load = this.loads.get(conversationKey(ref));
    if (load && load.ref.projectPath === ref.projectPath) {
      this.release(load);
      this.drafts.delete(conversationKey(ref));
    }
  }

  /** Whether a path is an attachment on a user message of this open conversation; the only files the preview may read. */
  attachmentAllowed(input: ConversationRef, file: string): boolean {
    const ref = parseConversationRef(input);
    const load = this.currentLoad(ref);
    if (!load) return false;
    for (const turn of load.turns.values()) {
      if (turn.userMessage.attachments?.some((attachment) => attachment.path === file)) return true;
    }
    return false;
  }

  async create(provider: ProviderId, projectPath: string): Promise<ConversationRef> {
    this.assertAvailable();
    const ref = await this.registry.create(provider, projectPath);
    if (provider === 'claude') {
      this.drafts.set(conversationKey(ref), { ref, title: 'New Claude conversation', updatedAt: Date.now(), runtime: 'idle', captureCompleteness: 'complete' });
    } else {
      await this.registry.refreshProvider(provider);
    }
    return ref;
  }

  async continue(input: ConversationRef, prompt: AgentPrompt, rendererId: string): Promise<void> {
    this.assertAvailable();
    const ref = parseConversationRef(input);
    const key = conversationKey(ref);
    const load = this.loads.get(key);
    if (!load || load.ref.projectPath !== ref.projectPath) throw new Error('Conversation is not open');
    if (this.ownedRuns.has(key) || this.startingRuns.has(key)) throw new Error('Conversation is not idle');
    const draft = this.drafts.get(key);
    const summary = draft?.ref.projectPath === ref.projectPath ? draft : await this.registry.validate(ref);
    if (this.ownedRuns.has(key) || this.startingRuns.has(key)) throw new Error('Conversation is not idle');
    const previous = this.runtimes.get(key);
    if (previous?.ownedRunId) {
      if (summary.runtime !== 'idle') throw new Error('Conversation is not idle');
      previous.releaseOwnedRun(previous.ownedRunId, 'idle');
    }
    const runtime = new ConversationRuntimeController({ onRequestClosed: (requestId) => {
      const owner = this.requestOwners.get(requestId);
      if (owner?.runtime !== runtime) return;
      this.requestOwners.delete(requestId);
      owner.requests.delete(requestId);
      queueMicrotask(() => {
        const currentLoad = this.loads.get(key);
        if (currentLoad?.phase === 'live') this.send(currentLoad, { type: 'runtime.changed', runtime: runtime.state });
      });
    } });
    runtime.observe(summary.runtime);
    if (!runtime.canContinue()) throw new Error('Conversation is not idle');
    const id = randomUUID();
    // No await may separate this claim from the final native status check above.
    runtime.claimOwnedRun(id);
    this.runtimes.set(key, runtime);
    let settleStart!: () => void;
    const startSettled = new Promise<void>((resolve) => { settleStart = resolve; });
    const starting: StartingRun = { id, rendererId, runtime, cancelled: false, settled: startSettled, settle: settleStart };
    this.startingRuns.set(key, starting);
    this.send(load, { type: 'runtime.changed', runtime: runtime.state });
    try {
      let run: ConversationRun;
      try { run = await this.registry.resolve(ref).continueConversation(ref, prompt); }
      catch {
        await runtime.failOwnedRun(id, 'Conversation continuation failed');
        const currentLoad = this.currentLoad(ref);
        if (currentLoad) { this.markTurnFailed(currentLoad, id); this.send(currentLoad, { type: 'runtime.changed', runtime: 'failed' }); }
        await this.reconcileFailure(ref, runtime, id);
        throw new Error('Conversation continuation failed');
      }
      if (starting.cancelled || this.disposed) {
        await run.interrupt().catch((): void => undefined);
        await run.dispose().catch((): void => undefined);
        await runtime.failOwnedRun(id, 'Conversation continuation ended');
        throw new Error('Conversation continuation ended');
      }
      const owned = { ref, id, rendererId, run, runtime, settled: Promise.resolve(), events: new Map(), requests: new Map(), revokedRequests: new Set<string>() } satisfies OwnedRun;
      this.ownedRuns.set(key, owned);
      owned.settled = this.consumeOwnedRun(owned, rendererId);
    } finally {
      if (this.startingRuns.get(key) === starting) this.startingRuns.delete(key);
      starting.settle();
    }
  }

  async interrupt(ref: ConversationRef): Promise<void> {
    const parsed = parseConversationRef(ref);
    const owned = this.ownedRuns.get(conversationKey(parsed));
    if (!owned || owned.ref.projectPath !== parsed.projectPath) throw new Error('No owned conversation run is available');
    await owned.run.interrupt();
  }

  async rename(input: ConversationRef, inputTitle: string): Promise<void> {
    this.assertAvailable();
    const ref = parseConversationRef(input), title = parseConversationTitle(inputTitle);
    const summary = await this.registry.validate(ref);
    if (summary.parentId !== undefined) throw new Error('Subagent conversations are read-only');
    // A turn in flight may be writing the same history; wait for it to settle.
    if (this.ownedRuns.has(conversationKey(ref)) || this.startingRuns.has(conversationKey(ref)) || BUSY_RUNTIMES.has(summary.runtime)) throw new Error('Conversation is busy');
    const adapter = this.registry.resolve(ref);
    if (!adapter.renameConversation) throw new Error('Renaming is not available for this conversation');
    await adapter.renameConversation(summary.ref, title);
  }

  async resolveRequest(requestId: string, decision: UserDecision): Promise<void> {
    const owned = this.requestOwners.get(requestId);
    if (!owned) throw new Error('Conversation request is no longer available');
    await owned.runtime.resolveRequest(requestId, decision);
  }

  async denyRequestsForOwner(rendererId: string, reason: string): Promise<void> {
    for (const starting of this.startingRuns.values()) if (starting.rendererId === rendererId) starting.cancelled = true;
    const ownedRuns = Array.from(this.ownedRuns.values()).filter((owned) => owned.rendererId === rendererId);
    for (const owned of ownedRuns) {
      owned.revokedReason = reason;
      for (const requestId of owned.requests.keys()) owned.revokedRequests.add(requestId);
    }
    await Promise.all(ownedRuns.map((owned) => owned.runtime.releaseRenderer(rendererId, reason)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.drafts.clear();
    const starts = Array.from(this.startingRuns.values());
    for (const starting of starts) starting.cancelled = true;
    for (const load of this.loads.values()) this.release(load);
    await Promise.allSettled(starts.map((starting) => starting.settled));
    const runs = Array.from(this.ownedRuns.values());
    await Promise.allSettled(runs.map(async (owned) => {
      await owned.runtime.denyAll('Conversation service closed');
      await owned.run.interrupt().catch((): void => undefined);
      await owned.settled;
    }));
  }

  private async consumeOwnedRun(owned: OwnedRun, rendererId: string): Promise<void> {
    const key = conversationKey(owned.ref);
    let failed = false;
    try {
      for await (const event of owned.run.events) {
        if (event.provider !== owned.ref.provider) throw new Error('Mismatched conversation event provider');
        if (event.payload.kind === 'request-opened' && event.payload.request.status === 'open') {
          if (owned.revokedReason !== undefined) {
            if (!owned.revokedRequests.has(event.payload.request.id)) {
              owned.revokedRequests.add(event.payload.request.id);
              await owned.run.resolveRequest(event.payload.request.id, { kind: 'deny', reason: owned.revokedReason });
            }
            continue;
          }
          if (this.requestOwners.has(event.payload.request.id)) throw new Error('Conversation request is already owned');
          owned.runtime.openRequest({ conversationKey: key, runId: owned.id, rendererId, request: event.payload.request, resolve: (requestId, decision) => owned.run.resolveRequest(requestId, decision) });
          this.requestOwners.set(event.payload.request.id, owned);
          owned.requests.set(event.payload.request.id, event.payload.request);
          const load = this.currentLoad(owned.ref);
          if (load?.phase === 'live') {
            this.send(load, { type: 'request.opened', request: event.payload.request });
            this.send(load, { type: 'runtime.changed', runtime: owned.runtime.state });
          }
        }
        owned.events.set(nativeEventKey(event), event);
        if (event.payload.kind === 'request-resolved') {
          owned.runtime.acknowledgeRequest(event.payload.requestId);
          const load = this.currentLoad(owned.ref);
          if (load?.phase === 'live') {
            this.send(load, { type: 'request.resolved', requestId: event.payload.requestId, decision: event.payload.decision });
          }
        }
        const load = this.currentLoad(owned.ref);
        if (load) this.receive(load, event);
      }
    } catch { failed = true; }
    if (failed) {
      try { await owned.runtime.failOwnedRun(owned.id, 'Conversation run failed'); } catch { /* A concurrent teardown may have reconciled ownership. */ }
      const load = this.currentLoad(owned.ref);
      if (load) { this.markTurnFailed(load, owned.id); this.send(load, { type: 'runtime.changed', runtime: 'failed' }); }
    }
    if (!failed) await owned.runtime.denyAll('Conversation run ended');
    try { await owned.run.dispose(); }
    catch {
      failed = true;
      if (owned.runtime.state !== 'failed') await owned.runtime.failOwnedRun(owned.id, 'Conversation run failed');
      const load = this.currentLoad(owned.ref);
      if (load) { this.markTurnFailed(load, owned.id); this.send(load, { type: 'runtime.changed', runtime: 'failed' }); }
    }
    if (this.ownedRuns.get(key) !== owned) return;
    this.ownedRuns.delete(key);
    await this.reconcileFailure(owned.ref, owned.runtime, owned.id);
  }

  private async reconcileFailure(ref: ConversationRef, runtime: ConversationRuntimeController, runId: string): Promise<void> {
    try {
      await this.registry.validate(ref);
      const loaded = await this.registry.resolve(ref).loadConversation(ref);
      if (conversationKey(loaded.summary.ref) !== conversationKey(ref) || loaded.summary.ref.projectPath !== ref.projectPath) return;
      for await (const event of loaded.events) {
        if (event.provider !== ref.provider) throw new Error('Mismatched conversation event provider');
        const load = this.currentLoad(ref);
        if (load) this.receive(load, event);
      }
      if (loaded.summary.runtime !== 'idle') return;
      this.drafts.delete(conversationKey(ref));
      runtime.releaseOwnedRun(runId, 'idle');
      const load = this.currentLoad(ref);
      if (load) {
        this.send(load, { type: 'summary.updated', summary: loaded.summary });
        this.send(load, { type: 'runtime.changed', runtime: 'idle' });
      }
    } catch { /* Fail closed until a later native discovery proves idle. */ }
  }

  private markTurnFailed(load: Load, runId: string): void {
    if (load.closed || !load.currentTurnId || load.turns.get(load.currentTurnId)?.status !== 'active') return;
    this.deliverLive(load, {
      provider: load.ref.provider,
      nativeId: `fractal:recovery:${runId}`,
      nativeType: 'fractal-recovery',
      observedAt: Date.now(),
      payload: { kind: 'turn-finished', turnId: load.currentTurnId, status: 'failed' },
    });
  }

  private async load(load: Load): Promise<OpenResult> {
    try {
      const summary = await this.registry.validate(load.ref);
      this.assertCurrent(load);
      const adapter = this.registry.resolve(summary.ref);
      const unsubscribe = await adapter.watchConversation(summary.ref, (event) => this.receive(load, event));
      if (load.closed) { unsubscribe(); this.assertCurrent(load); }
      load.unsubscribe = unsubscribe;
      load.phase = 'loading';
      const loaded = await adapter.loadConversation(summary.ref);
      this.assertCurrent(load);
      if (conversationKey(loaded.summary.ref) !== conversationKey(summary.ref) || loaded.summary.ref.projectPath !== summary.ref.projectPath) throw new Error('Loaded conversation does not match discovery');
      load.iterator = loaded.events[Symbol.asyncIterator]();
      let chunk: ConversationTurn[] = [];
      let chunkIndex = 0;
      const published = new Set<string>();
      const acceptHistoryUpdate = (update: TurnProjectionUpdate) => {
        const index = chunk.findIndex((turn) => turn.id === update.turn.id);
        if (index >= 0) chunk[index] = update.turn;
        else if (published.has(update.turn.id)) this.send(load, { type: 'turn.upserted', turn: update.turn });
        else if (update.finalized) chunk.push(update.turn);
      };
      const flush = async () => {
        if (!chunk.length) return;
        for (const turn of chunk) published.add(turn.id);
        this.send(load, { type: 'history.chunk', chunkIndex: chunkIndex++, turns: chunk });
        chunk = [];
        await setImmediate();
        this.assertCurrent(load);
      };
      while (!load.closed) {
        this.assertCurrent(load);
        const next = await load.iterator.next();
        this.assertCurrent(load);
        if (next.done) break;
        const event = next.value;
        this.assertProvider(load, event);
        load.initial.delete(nativeEventKey(event));
        const prior = load.observations.get(nativeEventKey(event));
        if (prior && JSON.stringify(prior.payload) === JSON.stringify(event.payload)) continue;
        for (const update of this.project(load, event)) {
          acceptHistoryUpdate(update);
          if (chunk.length === this.chunkSize) await flush();
        }
      }
      this.assertCurrent(load);
      load.iterator = undefined;
      for (const update of load.projector.finish()) {
        load.turns.set(update.turn.id, update.turn);
        load.currentTurnId = update.turn.id;
        acceptHistoryUpdate(update);
        if (chunk.length === this.chunkSize) await flush();
      }
      await flush();
      for (const event of load.initial.values()) this.deliverLive(load, event, true);
      load.initial.clear();
      // Keep buffering through complete emission, including synchronous emit callbacks.
      this.drain(load, true);
      this.send(load, { type: 'history.complete' });
      this.drain(load);
      load.phase = 'live';
      this.replayOwnedRun(load);
      const { title, updatedAt, createdAt, runtime, captureCompleteness } = loaded.summary;
      return {
        summary: { ref: summary.ref, title, updatedAt, runtime, captureCompleteness, ...(createdAt === undefined ? {} : { createdAt }) },
        capabilities: structuredClone(adapter.capabilities()),
      };
    } catch {
      const cancelled = load.closed;
      this.fail(load, 'The conversation could not be loaded.');
      throw new Error(cancelled ? 'Conversation load ended' : 'The conversation could not be loaded.');
    }
  }

  private receive(load: Load, event: NativeEvent): void {
    if (load.closed) return;
    try {
      this.assertProvider(load, event);
      if (load.phase === 'watching') load.initial.set(nativeEventKey(event), event);
      else if (load.phase === 'loading') load.buffered.set(nativeEventKey(event), event);
      else this.deliverLive(load, event);
    } catch {
      this.fail(load, 'Conversation updates are unavailable.');
    }
  }

  private drain(load: Load, bootstrapOverlap = false): void {
    while (load.buffered.size && !load.closed) {
      const batch = Array.from(load.buffered.values());
      load.buffered.clear();
      for (const event of batch) this.deliverLive(load, event, bootstrapOverlap);
    }
  }

  private record(load: Load, event: NativeEvent): void {
    load.observations.set(nativeEventKey(event), event);
    const current = load.currentTurnId ? load.turns.get(load.currentTurnId) : undefined;
    const turnId = event.payload.turnId ?? (event.payload.kind === 'unsupported' && current?.status === 'active' ? current.id : undefined);
    if (turnId) {
      const prefix = load.journal.has(turnId) ? [] : load.unanchored.splice(0);
      load.journal.set(turnId, reconcileNativeEvents(load.journal.get(turnId) ?? prefix, [event]));
    } else if (event.payload.kind === 'unsupported') {
      load.unanchored = reconcileNativeEvents(load.unanchored, [event]);
    }
  }

  private deliverLive(load: Load, event: NativeEvent, bootstrapOverlap = false): void {
    if (load.closed) return;
    const prior = load.observations.get(nativeEventKey(event));
    if (prior && (JSON.stringify(prior.payload) === JSON.stringify(event.payload) || (bootstrapOverlap && isRegression(prior, event)))) return;
    const turnId = event.payload.turnId;
    const before = turnId ? load.turns.get(turnId) : undefined;
    for (const update of this.project(load, event)) {
      this.sendTurnUpdate(load, event, update.turn.id === turnId ? before : undefined, update.turn);
    }
  }

  private project(load: Load, event: NativeEvent): TurnProjectionUpdate[] {
    const prior = load.observations.get(nativeEventKey(event));
    const turnId = event.payload.turnId;
    const before = turnId ? load.turns.get(turnId) : undefined;
    this.record(load, event);
    // Replaying an older turn must not move the live chronology away from its
    // latest turn: that projector owns pending notices and the next boundary.
    if (turnId && (prior || load.currentTurnId !== turnId) && before) {
      const replay = new TurnProjector();
      let after: ConversationTurn | undefined;
      for (const observation of load.journal.get(turnId) ?? []) {
        for (const update of replay.push(observation)) after = update.turn;
      }
      const completedAt = load.inferredFinishes.get(turnId);
      if (completedAt !== undefined && before.status !== 'active') {
        for (const update of replay.push({ ...event, payload: { kind: 'turn-finished', turnId, status: before.status }, observedAt: completedAt })) after = update.turn;
      }
      if (!after) throw new Error('Conversation turn could not be projected');
      load.turns.set(turnId, after);
      if (load.currentTurnId === turnId) {
        load.projector = replay;
        for (const pending of load.unanchored) replay.push(pending);
      }
      return [{ turn: after, finalized: after.status !== 'active' }];
    }
    const updates = load.projector.push(event);
    for (const update of updates) {
      if (update.finalized && update.turn.id !== event.payload.turnId) load.inferredFinishes.set(update.turn.id, event.observedAt);
      load.turns.set(update.turn.id, update.turn);
      load.currentTurnId = update.turn.id;
    }
    return updates;
  }

  private sendTurnUpdate(load: Load, event: NativeEvent, before: ConversationTurn | undefined, after: ConversationTurn): void {
    if (before && before.status !== 'active') {
      this.send(load, { type: 'turn.upserted', turn: after });
      return;
    }
    if (before && event.payload.kind === 'assistant-text') {
      const id = event.payload.blockId ?? event.nativeId;
      const oldBlock = before.blocks.find((block) => block.id === id);
      const newBlock = after.blocks.find((block) => block.id === id);
      if (oldBlock?.kind === 'assistant-prose' && newBlock?.kind === 'assistant-prose' && newBlock.text.startsWith(oldBlock.text)) {
        const expected = structuredClone(before);
        const block = expected.blocks.find((block) => block.id === id);
        if (block?.kind === 'assistant-prose') block.text = newBlock.text;
        if (JSON.stringify(expected) === JSON.stringify(after)) {
          const delta = newBlock.text.slice(oldBlock.text.length);
          if (delta) this.send(load, { type: 'assistant.delta', turnId: after.id, blockId: id, delta });
          return;
        }
      }
    }
    if (before && event.payload.kind === 'action-updated') {
      const actionId = event.payload.actionId;
      for (const packet of after.blocks) {
        if (packet.kind !== 'work-packet') continue;
        const oldPacket = before.blocks.find((block) => block.id === packet.id);
        const action = packet.actions.find((item) => item.id === actionId);
        if (action && oldPacket?.kind === 'work-packet' && oldPacket.actions.some((item) => item.id === actionId)) {
          this.send(load, { type: 'action.upserted', turnId: after.id, packetId: packet.id, action });
          // Packet/turn metadata is not part of an action update.
          if (oldPacket.status !== packet.status || oldPacket.completedAt !== packet.completedAt) this.send(load, { type: 'turn.upserted', turn: after });
          return;
        }
      }
    }
    this.send(load, { type: 'turn.upserted', turn: after });
  }

  private send(load: Load, payload: StreamPayload): void {
    if (!load.closed) this.emit(structuredClone({ ...payload, ref: load.ref, loadId: load.loadId, seq: load.seq++ }));
  }

  private currentLoad(ref: ConversationRef): Load | undefined {
    const load = this.loads.get(conversationKey(ref));
    return load && !load.closed && load.ref.projectPath === ref.projectPath ? load : undefined;
  }

  private replayOwnedRun(load: Load): void {
    const key = conversationKey(load.ref);
    const starting = this.startingRuns.get(key);
    if (starting) this.send(load, { type: 'runtime.changed', runtime: starting.runtime.state });
    const owned = this.ownedRuns.get(key);
    if (!owned || owned.ref.projectPath !== load.ref.projectPath) return;
    for (const event of owned.events.values()) this.deliverLive(load, event, true);
    for (const request of owned.requests.values()) this.send(load, { type: 'request.opened', request });
    this.send(load, { type: 'runtime.changed', runtime: owned.runtime.state });
  }

  private fail(load: Load, message: string): void {
    if (load.closed) return;
    try { this.send(load, { type: 'load.failed', message }); }
    catch { /* A lost event recipient must not retain native resources. */ }
    finally { this.release(load); }
  }

  private release(load: Load): void {
    if (load.closed) return;
    load.closed = true;
    if (this.loads.get(conversationKey(load.ref)) === load) this.loads.delete(conversationKey(load.ref));
    if (this.loadIds.get(load.loadId) === load) this.loadIds.delete(load.loadId);
    const unsubscribe = load.unsubscribe;
    load.unsubscribe = undefined;
    try { unsubscribe?.(); } catch { /* Continue releasing generation-owned state. */ }
    const iterator = load.iterator;
    load.iterator = undefined;
    const returnIterator = iterator?.return?.bind(iterator);
    if (returnIterator) void Promise.resolve().then(returnIterator).catch((): void => undefined);
    load.initial.clear(); load.buffered.clear(); load.journal.clear(); load.observations.clear(); load.turns.clear();
    load.unanchored = [];
    load.inferredFinishes.clear();
    load.projector = new TurnProjector();
  }

  private assertCurrent(load: Load): void {
    if (load.closed || this.disposed) throw new Error('Conversation load ended');
  }

  private assertProvider(load: Load, event: NativeEvent): void {
    if (event.provider !== load.ref.provider) throw new Error('Mismatched conversation event provider');
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error('Conversation service is disposed');
  }
}

function isRegression(prior: NativeEvent, incoming: NativeEvent): boolean {
  if (prior.payload.kind === 'assistant-text' && incoming.payload.kind === 'assistant-text') {
    return !incoming.payload.final && (prior.payload.final || (prior.payload.text.length > incoming.payload.text.length && prior.payload.text.startsWith(incoming.payload.text)));
  }
  return prior.payload.kind === 'action-updated' && incoming.payload.kind === 'action-updated'
    && ['completed', 'failed', 'denied', 'interrupted'].includes(prior.payload.status)
    && ['requested', 'running', 'awaiting-approval'].includes(incoming.payload.status);
}
