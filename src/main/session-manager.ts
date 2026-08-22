import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  type AgentEvent,
  type Conversation,
  type Entry,
  type EntryId,
  type PermissionDecision,
  type TextPart,
} from '@/shared/agent-contract';
import type { ConversationStore } from '@/main/conversation-store';
import type { AdapterStep, BackendAdapter } from '@/main/backend-adapter';

// Plain Omit collapses over AgentEvent's union (EventEnvelope & (A|B|C)) down to
// just the fields common to every variant, dropping type-specific fields like
// `entry` or `entryId`. Distribute it over the union first instead.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Runtime {
  seq: number;
  entries: Map<EntryId, Entry>;
  order: EntryId[];
  abort?: AbortController;
  pending: Map<string, (decision: PermissionDecision) => void>;
  // Maps an in-flight agent entry to the user entry that started its turn,
  // so settle() can persist both together regardless of which path
  // (complete/error/cancel) settles the turn.
  turnUserEntry: Map<EntryId, Entry>;
}

export class SessionManager {
  private readonly store: ConversationStore;
  private readonly adapter: BackendAdapter;
  private readonly emitRaw: (event: AgentEvent) => void;
  private readonly runtimes = new Map<string, Runtime>();

  constructor(deps: {
    store: ConversationStore;
    adapter: BackendAdapter;
    emit: (event: AgentEvent) => void;
  }) {
    this.store = deps.store;
    this.adapter = deps.adapter;
    this.emitRaw = deps.emit;
  }

  private runtime(conversationId: string): Runtime {
    let rt = this.runtimes.get(conversationId);
    if (!rt) {
      const stored = this.store.load(conversationId);
      rt = { seq: 0, entries: new Map(), order: [], pending: new Map(), turnUserEntry: new Map() };
      for (const e of stored?.entries ?? []) {
        rt.entries.set(e.id, e);
        rt.order.push(e.id);
      }
      this.runtimes.set(conversationId, rt);
    }
    return rt;
  }

  // Invariant: an emitted event never shares a mutable object with runtime
  // state. Every emit site below that carries an object the runtime keeps
  // mutating in place (entry, part, patch, provenance) must pass a
  // structuredClone of it, not the live reference — otherwise a later
  // in-place mutation silently rewrites an event that already "went out".
  private emit(conversationId: string, event: DistributiveOmit<AgentEvent, 'v' | 'seq' | 'conversationId'>) {
    const rt = this.runtime(conversationId);
    rt.seq += 1;
    this.emitRaw({ v: CONTRACT_VERSION, seq: rt.seq, conversationId, ...event } as AgentEvent);
  }

  private addEntry(conversationId: string, entry: Entry) {
    const rt = this.runtime(conversationId);
    rt.entries.set(entry.id, entry);
    rt.order.push(entry.id);
    this.emit(conversationId, { type: 'entry.added', entry: structuredClone(entry) });
  }

  // `precedingEntry` (the user entry that started this turn) is persisted
  // immediately before the agent entry so the two land together or neither
  // does — spec §4's "looks as though the turn never happened" requires the
  // user's message to not survive on disk with no reply if main crashes
  // mid-turn. It was already emitted live via entry.added; only the write
  // was deferred.
  private settle(conversationId: string, entryId: EntryId, status: Entry['status']) {
    const rt = this.runtime(conversationId);
    const entry = rt.entries.get(entryId);
    if (!entry) return;
    // Idempotent: once an entry leaves 'streaming' it is settled. This is what
    // stops the adapter's .then()/.catch() and a concurrent cancelTurn() from
    // both settling (and double-writing) the same entry.
    if (entry.status !== 'streaming') return;
    entry.status = status;
    // Ruling 1: forward the entry's error (if any) onto the terminal status event.
    this.emit(conversationId, {
      type: 'entry.status',
      entryId,
      status,
      ...(entry.error ? { error: structuredClone(entry.error) } : {}),
    });
    const userEntry = rt.turnUserEntry.get(entryId);
    if (userEntry) {
      this.store.saveEntry(conversationId, userEntry);
      rt.turnUserEntry.delete(entryId);
    }
    this.store.saveEntry(conversationId, entry); // write-on-settle
  }

  sendMessage({ conversationId, text }: { conversationId: string; text: string }): { entryId: EntryId } {
    const rt = this.runtime(conversationId);

    const userEntry: Entry = {
      id: randomUUID(),
      conversationId,
      author: 'user',
      createdAt: Date.now(),
      status: 'complete',
      parts: [{ id: randomUUID(), kind: 'text', text }],
    };
    // Emitted live immediately so the sender sees their message right away,
    // but persistence is deferred to settle() (see settle's doc comment):
    // writing it now would let a mid-turn crash leave an orphaned user
    // message with no reply and no marker on disk.
    this.addEntry(conversationId, userEntry);

    const agentEntry: Entry = {
      id: randomUUID(),
      conversationId,
      author: 'agent',
      createdAt: Date.now(),
      status: 'streaming',
      parts: [],
    };
    this.addEntry(conversationId, agentEntry);
    rt.turnUserEntry.set(agentEntry.id, userEntry);

    const abort = new AbortController();
    rt.abort = abort;
    // Tracks the live streaming text part directly, so later deltas don't
    // need a non-null `find(...)!` to relocate it.
    let textPart: TextPart | null = null;

    const requestPermission = (partId: string): Promise<PermissionDecision> => {
      const requestId = randomUUID();
      this.emit(conversationId, {
        type: 'permission.requested',
        entryId: agentEntry.id,
        partId,
        requestId,
      });
      return new Promise<PermissionDecision>((resolve) => {
        rt.pending.set(requestId, resolve);
      });
    };

    const onStep = (step: AdapterStep) => {
      const entry = rt.entries.get(agentEntry.id);
      if (!entry) return;
      switch (step.kind) {
        case 'text': {
          if (!textPart) {
            textPart = { id: randomUUID(), kind: 'text', text: '' };
            entry.parts.push(textPart);
            this.emit(conversationId, {
              type: 'part.added',
              entryId: entry.id,
              index: entry.parts.length - 1,
              part: structuredClone(textPart),
            });
          }
          textPart.text += step.delta;
          this.emit(conversationId, {
            type: 'text.appended',
            entryId: entry.id,
            partId: textPart.id,
            delta: step.delta,
          });
          break;
        }
        case 'work-start': {
          entry.parts.push(step.part);
          this.emit(conversationId, {
            type: 'part.added',
            entryId: entry.id,
            index: entry.parts.length - 1,
            part: structuredClone(step.part),
          });
          break;
        }
        case 'work-end': {
          const wp = entry.parts.find((p) => p.id === step.partId);
          if (wp) Object.assign(wp, step.patch);
          this.emit(conversationId, {
            type: 'part.updated',
            entryId: entry.id,
            partId: step.partId,
            patch: structuredClone(step.patch),
          });
          break;
        }
        case 'provenance': {
          entry.provenance = step.provenance;
          this.emit(conversationId, {
            type: 'provenance.updated',
            entryId: entry.id,
            provenance: structuredClone(step.provenance),
          });
          break;
        }
      }
    };

    void this.adapter
      .run({ text, emit: onStep, requestPermission, signal: abort.signal })
      .then(() => {
        if (!abort.signal.aborted) this.settle(conversationId, agentEntry.id, 'complete');
      })
      .catch((err: unknown) => {
        const entry = rt.entries.get(agentEntry.id);
        if (entry) entry.error = { message: err instanceof Error ? err.message : String(err) };
        this.settle(conversationId, agentEntry.id, 'error');
      });

    return { entryId: agentEntry.id };
  }

  cancelTurn({ conversationId }: { conversationId: string }): void {
    const rt = this.runtimes.get(conversationId);
    if (!rt?.abort) return;
    rt.abort.abort();
    let streaming: Entry | undefined;
    for (const id of rt.order) {
      const candidate = rt.entries.get(id);
      if (candidate?.status === 'streaming') {
        streaming = candidate;
        break;
      }
    }
    if (streaming) this.settle(conversationId, streaming.id, 'interrupted');
    // A cancelled turn must not strand a permission promise an adapter is
    // still awaiting: resolve every request still parked for this
    // conversation as denied (rather than leaving it hanging, or rejecting
    // and forcing every adapter to try/catch requestPermission). A denial
    // is the decision that already matches "the turn was cancelled" — the
    // adapter should stop, not proceed as if allowed.
    for (const [requestId, resolve] of rt.pending) {
      rt.pending.delete(requestId);
      const decision: PermissionDecision = { outcome: 'deny', reason: 'Turn cancelled' };
      resolve(decision);
      this.emit(conversationId, { type: 'permission.resolved', requestId, decision });
    }
  }

  respondToPermission({ requestId, decision }: { requestId: string; decision: PermissionDecision }): void {
    for (const [conversationId, rt] of this.runtimes) {
      const resolve = rt.pending.get(requestId);
      if (resolve) {
        rt.pending.delete(requestId);
        resolve(decision);
        this.emit(conversationId, { type: 'permission.resolved', requestId, decision });
        return;
      }
    }
  }

  snapshot(conversationId: string): { conversation: Conversation; entries: Entry[]; seq: number } | null {
    const stored = this.store.load(conversationId);
    if (!stored) return null;
    const rt = this.runtime(conversationId);
    const entries: Entry[] = [];
    for (const id of rt.order) {
      const entry = rt.entries.get(id);
      if (entry) entries.push(entry);
    }
    return { conversation: stored.conversation, entries: entries.length ? entries : stored.entries, seq: rt.seq };
  }
}
