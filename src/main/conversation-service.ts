import { setImmediate } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { ConversationRegistry } from '@/main/conversation-registry';
import { ConversationRuntimeController } from '@/main/conversation-runtime';
import { nativeEventKey, reconcileNativeEvents, type NativeEvent } from '@/main/harness/reconciler';
import { TurnProjector, type TurnProjectionUpdate } from '@/main/harness/turn-projector';
import type { ConversationRun, Unsubscribe } from '@/main/harness/types';
import { conversationKey, type ConversationRef, type ConversationStreamEvent, type ConversationSummary, type ConversationTurn, type HarnessCapabilities, type ProviderId, type UserDecision } from '@/shared/conversation-contract';
import { parseConversationRef, parseLoadId } from '@/shared/conversation-ipc';

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
type OwnedRun = { ref: ConversationRef; id: string; run: ConversationRun; runtime: ConversationRuntimeController; settled: Promise<void> };

export class ConversationService {
  private readonly loads = new Map<string, Load>();
  private readonly loadIds = new Map<string, Load>();
  private readonly ownedRuns = new Map<string, OwnedRun>();
  private readonly runtimes = new Map<string, ConversationRuntimeController>();
  private readonly requestOwners = new Map<string, OwnedRun>();
  private readonly startingRuns = new Set<string>();
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
      promise: Promise.resolve().then(() => this.load(load)),
      initial: new Map(), buffered: new Map(), projector: new TurnProjector(), journal: new Map(), observations: new Map(), turns: new Map(), unanchored: [], inferredFinishes: new Map(),
    };
    this.loads.set(key, load);
    this.loadIds.set(loadId, load);
    return load.promise;
  }

  async close(input: ConversationRef): Promise<void> {
    const ref = parseConversationRef(input);
    const load = this.loads.get(conversationKey(ref));
    if (load && load.ref.projectPath === ref.projectPath) this.release(load);
  }

  async create(provider: ProviderId, projectPath: string): Promise<ConversationRef> {
    void provider; void projectPath;
    throw new Error('Conversation creation is not available yet');
  }

  async continue(input: ConversationRef, prompt: { text: string }, rendererId: string): Promise<void> {
    this.assertAvailable();
    const ref = parseConversationRef(input);
    const key = conversationKey(ref);
    const load = this.loads.get(key);
    if (!load || load.ref.projectPath !== ref.projectPath) throw new Error('Conversation is not open');
    if (this.ownedRuns.has(key) || this.startingRuns.has(key)) throw new Error('Conversation is not idle');
    const summary = await this.registry.validate(ref);
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
      queueMicrotask(() => {
        const currentLoad = this.loads.get(key);
        if (currentLoad && !currentLoad.closed) this.send(currentLoad, { type: 'runtime.changed', runtime: runtime.state });
      });
    } });
    runtime.observe(summary.runtime);
    if (!runtime.canContinue()) throw new Error('Conversation is not idle');
    const id = randomUUID();
    // No await may separate this claim from the final native status check above.
    runtime.claimOwnedRun(id);
    this.runtimes.set(key, runtime);
    this.startingRuns.add(key);
    this.send(load, { type: 'runtime.changed', runtime: runtime.state });
    let run: ConversationRun;
    try { run = await this.registry.resolve(ref).continueConversation(ref, prompt); }
    catch {
      this.startingRuns.delete(key);
      runtime.failOwnedRun(id);
      this.send(load, { type: 'runtime.changed', runtime: 'failed' });
      await this.reconcileFailure(ref, runtime, id, load);
      throw new Error('Conversation continuation failed');
    }
    this.startingRuns.delete(key);
    const owned = { ref, id, run, runtime, settled: Promise.resolve() } satisfies OwnedRun;
    this.ownedRuns.set(key, owned);
    owned.settled = this.consumeOwnedRun(owned, rendererId, load);
  }

  async interrupt(ref: ConversationRef): Promise<void> {
    const parsed = parseConversationRef(ref);
    const owned = this.ownedRuns.get(conversationKey(parsed));
    if (!owned || owned.ref.projectPath !== parsed.projectPath) throw new Error('No owned conversation run is available');
    await owned.run.interrupt();
  }

  async resolveRequest(requestId: string, decision: UserDecision): Promise<void> {
    const owned = this.requestOwners.get(requestId);
    if (!owned) throw new Error('Conversation request is no longer available');
    await owned.runtime.resolveRequest(requestId, decision);
  }

  async denyRequestsForOwner(rendererId: string, reason: string): Promise<void> {
    await Promise.all(Array.from(this.ownedRuns.values(), (owned) => owned.runtime.releaseRenderer(rendererId, reason)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const load of this.loads.values()) this.release(load);
    const runs = Array.from(this.ownedRuns.values());
    await Promise.allSettled(runs.map(async (owned) => {
      await owned.runtime.denyAll('Conversation service closed');
      await owned.run.interrupt().catch((): void => undefined);
      await owned.settled;
    }));
  }

  private async consumeOwnedRun(owned: OwnedRun, rendererId: string, load: Load): Promise<void> {
    const key = conversationKey(owned.ref);
    let failed = false;
    try {
      for await (const event of owned.run.events) {
        if (event.provider !== owned.ref.provider) throw new Error('Mismatched conversation event provider');
        if (event.payload.kind === 'request-opened' && event.payload.request.status === 'open') {
          if (this.requestOwners.has(event.payload.request.id)) throw new Error('Conversation request is already owned');
          owned.runtime.openRequest({ conversationKey: key, runId: owned.id, rendererId, request: event.payload.request, resolve: (requestId, decision) => owned.run.resolveRequest(requestId, decision) });
          this.requestOwners.set(event.payload.request.id, owned);
          if (!load.closed) {
            this.send(load, { type: 'request.opened', request: event.payload.request });
            this.send(load, { type: 'runtime.changed', runtime: owned.runtime.state });
          }
        }
        if (event.payload.kind === 'request-resolved') {
          owned.runtime.acknowledgeRequest(event.payload.requestId);
          if (!load.closed) {
            this.send(load, { type: 'request.resolved', requestId: event.payload.requestId, decision: event.payload.decision });
          }
        }
        if (!load.closed) this.deliverLive(load, event);
      }
    } catch { failed = true; }
    if (failed) {
      try { owned.runtime.failOwnedRun(owned.id); } catch { /* A concurrent teardown may have reconciled ownership. */ }
      if (!load.closed) this.send(load, { type: 'runtime.changed', runtime: 'failed' });
    }
    await owned.runtime.denyAll(failed ? 'Conversation run failed' : 'Conversation run ended');
    try { await owned.run.dispose(); }
    catch {
      failed = true;
      if (owned.runtime.state !== 'failed') owned.runtime.failOwnedRun(owned.id);
      if (!load.closed) this.send(load, { type: 'runtime.changed', runtime: 'failed' });
    }
    if (this.ownedRuns.get(key) !== owned) return;
    this.ownedRuns.delete(key);
    await this.reconcileFailure(owned.ref, owned.runtime, owned.id, load);
  }

  private async reconcileFailure(ref: ConversationRef, runtime: ConversationRuntimeController, runId: string, load: Load): Promise<void> {
    try {
      const summary = await this.registry.validate(ref);
      if (summary.runtime !== 'idle') return;
      runtime.releaseOwnedRun(runId, 'idle');
      if (!load.closed) this.send(load, { type: 'runtime.changed', runtime: 'idle' });
    } catch { /* Fail closed until a later native discovery proves idle. */ }
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
