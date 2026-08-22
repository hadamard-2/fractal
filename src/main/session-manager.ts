import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  type AgentEvent,
  type Conversation,
  type Entry,
  type EntryId,
  type PermissionDecision,
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
      rt = { seq: 0, entries: new Map(), order: [], pending: new Map() };
      for (const e of stored?.entries ?? []) {
        rt.entries.set(e.id, e);
        rt.order.push(e.id);
      }
      this.runtimes.set(conversationId, rt);
    }
    return rt;
  }

  private emit(conversationId: string, event: DistributiveOmit<AgentEvent, 'v' | 'seq' | 'conversationId'>) {
    const rt = this.runtime(conversationId);
    rt.seq += 1;
    this.emitRaw({ v: CONTRACT_VERSION, seq: rt.seq, conversationId, ...event } as AgentEvent);
  }

  private addEntry(conversationId: string, entry: Entry) {
    const rt = this.runtime(conversationId);
    rt.entries.set(entry.id, entry);
    rt.order.push(entry.id);
    // Ruling 2: emit a deep copy so later in-place mutation of the live entry
    // can't retroactively change an event that already went out.
    this.emit(conversationId, { type: 'entry.added', entry: structuredClone(entry) });
  }

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
      ...(entry.error ? { error: entry.error } : {}),
    });
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
    this.addEntry(conversationId, userEntry);
    this.store.saveEntry(conversationId, userEntry);

    const agentEntry: Entry = {
      id: randomUUID(),
      conversationId,
      author: 'agent',
      createdAt: Date.now(),
      status: 'streaming',
      parts: [],
    };
    this.addEntry(conversationId, agentEntry);

    const abort = new AbortController();
    rt.abort = abort;
    let textPartId: string | null = null;

    const onStep = (step: AdapterStep) => {
      const entry = rt.entries.get(agentEntry.id);
      if (!entry) return;
      switch (step.kind) {
        case 'text': {
          if (!textPartId) {
            textPartId = randomUUID();
            const part = { id: textPartId, kind: 'text' as const, text: '' };
            entry.parts.push(part);
            this.emit(conversationId, {
              type: 'part.added',
              entryId: entry.id,
              index: entry.parts.length - 1,
              part,
            });
          }
          const tp = entry.parts.find((p) => p.id === textPartId)!;
          if (tp.kind === 'text') tp.text += step.delta;
          this.emit(conversationId, {
            type: 'text.appended',
            entryId: entry.id,
            partId: textPartId,
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
            part: step.part,
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
            patch: step.patch,
          });
          break;
        }
        case 'provenance': {
          entry.provenance = step.provenance;
          this.emit(conversationId, {
            type: 'provenance.updated',
            entryId: entry.id,
            provenance: step.provenance,
          });
          break;
        }
        case 'need-permission': {
          const requestId = randomUUID();
          this.emit(conversationId, {
            type: 'permission.requested',
            entryId: entry.id,
            partId: step.partId,
            requestId,
          });
          // Ruling 3 (as briefed): a no-op resolver. The echo adapter never
          // emits need-permission, so this never actually blocks anything;
          // making the adapter genuinely await an answer is backend-shaped
          // work with no backend to shape it against yet.
          rt.pending.set(requestId, () => undefined);
          break;
        }
      }
    };

    void this.adapter
      .run({ text, emit: onStep, signal: abort.signal })
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
    const streaming = rt.order.map((id) => rt.entries.get(id)!).find((e) => e.status === 'streaming');
    if (streaming) this.settle(conversationId, streaming.id, 'interrupted');
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
    const entries = rt.order.length ? rt.order.map((id) => rt.entries.get(id)!) : stored.entries;
    return { conversation: stored.conversation, entries, seq: rt.seq };
  }
}
