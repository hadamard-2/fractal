import { setImmediate } from 'node:timers/promises';
import type { ConversationRegistry } from '@/main/conversation-registry';
import { nativeEventKey, reconcileNativeEvents, type NativeEvent } from '@/main/harness/reconciler';
import { TurnProjector } from '@/main/harness/turn-projector';
import type { Unsubscribe } from '@/main/harness/types';
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

export class ConversationService {
  private readonly loads = new Map<string, Load>();
  private readonly loadIds = new Map<string, Load>();
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

  async continue(ref: ConversationRef, prompt: { text: string }): Promise<void> {
    void ref; void prompt;
    throw new Error('Conversation continuation is not available yet');
  }

  async interrupt(ref: ConversationRef): Promise<void> {
    void ref;
    throw new Error('No owned conversation run is available');
  }

  async resolveRequest(requestId: string, decision: UserDecision): Promise<void> {
    void requestId; void decision;
    throw new Error('No owned conversation request is available');
  }

  async denyRequestsForOwner(rendererId: string, reason: string): Promise<void> {
    // Run/request ownership is introduced with continuation support.
    void rendererId; void reason;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const load of this.loads.values()) this.release(load);
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
      const flush = async () => {
        if (!chunk.length) return;
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
        this.record(load, event);
        for (const update of load.projector.push(event)) {
          if (update.finalized && update.turn.id !== event.payload.turnId) load.inferredFinishes.set(update.turn.id, event.observedAt);
          load.turns.set(update.turn.id, update.turn);
          load.currentTurnId = update.turn.id;
          if (update.finalized) chunk.push(update.turn);
          if (chunk.length === this.chunkSize) await flush();
        }
      }
      this.assertCurrent(load);
      load.iterator = undefined;
      for (const update of load.projector.finish()) {
        load.turns.set(update.turn.id, update.turn);
        load.currentTurnId = update.turn.id;
        chunk.push(update.turn);
        if (chunk.length === this.chunkSize) await flush();
      }
      await flush();
      for (const event of load.initial.values()) this.deliverLive(load, event);
      load.initial.clear();
      // Keep buffering through complete emission, including synchronous emit callbacks.
      this.drain(load);
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

  private drain(load: Load): void {
    while (load.buffered.size && !load.closed) {
      const batch = Array.from(load.buffered.values());
      load.buffered.clear();
      for (const event of batch) this.deliverLive(load, event);
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

  private deliverLive(load: Load, event: NativeEvent): void {
    if (load.closed) return;
    const prior = load.observations.get(nativeEventKey(event));
    if (prior && (JSON.stringify(prior.payload) === JSON.stringify(event.payload) || isRegression(prior, event))) return;
    const turnId = event.payload.turnId;
    const before = turnId ? load.turns.get(turnId) : undefined;
    this.record(load, event);
    // A replacement may refer to an older turn. Rebuild only that turn, preserving
    // its original event positions instead of treating it as a new partial turn.
    if (turnId && (prior || load.currentTurnId !== turnId) && before) {
      load.projector = new TurnProjector();
      for (const observation of load.journal.get(turnId) ?? []) {
        for (const update of load.projector.push(observation)) load.turns.set(update.turn.id, update.turn);
      }
      const completedAt = load.inferredFinishes.get(turnId);
      if (completedAt !== undefined && before.status !== 'active') {
        for (const update of load.projector.push({ ...event, payload: { kind: 'turn-finished', turnId, status: before.status }, observedAt: completedAt })) load.turns.set(update.turn.id, update.turn);
      }
      load.currentTurnId = turnId;
      const after = load.turns.get(turnId);
      if (!after) throw new Error('Conversation turn could not be projected');
      this.sendTurnUpdate(load, event, before, after);
      return;
    }
    for (const update of load.projector.push(event)) {
      if (update.finalized && update.turn.id !== event.payload.turnId) load.inferredFinishes.set(update.turn.id, event.observedAt);
      load.turns.set(update.turn.id, update.turn);
      load.currentTurnId = update.turn.id;
      this.sendTurnUpdate(load, event, update.turn.id === turnId ? before : undefined, update.turn);
    }
  }

  private sendTurnUpdate(load: Load, event: NativeEvent, before: ConversationTurn | undefined, after: ConversationTurn): void {
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
