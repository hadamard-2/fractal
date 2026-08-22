import { isWorkPart, type AgentEvent, type Conversation, type Entry, type Part } from '@/shared/agent-contract';

export interface ConversationState {
  conversation: Conversation | null;
  entries: Entry[];
  seq: number;
  // Distinguishes "seq 0 because we have a real baseline of 0" (a freshly
  // created conversation with no events emitted yet) from "seq 0 because we
  // have no baseline at all" (a bare initialState() before any snapshot or
  // event arrived). A plain `seq: number` conflates the two, which turns
  // gap detection off for good the moment a new conversation seeds at seq 0.
  baselineKnown: boolean;
  missedEvents: boolean;
  // Set by the hook when the snapshot fetch itself fails (as opposed to a
  // dropped event mid-stream, which is `missedEvents`). Not touched by
  // `reduce` — it rides along on the spread in `base` like any other field.
  snapshotError: string | null;
}

export function initialState(snapshot?: {
  conversation: Conversation;
  entries: Entry[];
  seq: number;
}): ConversationState {
  return {
    conversation: snapshot?.conversation ?? null,
    entries: snapshot?.entries ?? [],
    seq: snapshot?.seq ?? 0,
    baselineKnown: snapshot !== undefined,
    missedEvents: false,
    snapshotError: null,
  };
}

function mapEntry(entries: Entry[], id: string, fn: (e: Entry) => Entry): Entry[] {
  return entries.map((e) => (e.id === id ? fn(e) : e));
}

function mapPart(entry: Entry, partId: string, fn: (p: Part) => Part): Entry {
  return { ...entry, parts: entry.parts.map((p) => (p.id === partId ? fn(p) : p)) };
}

export function reduce(state: ConversationState, event: AgentEvent): ConversationState {
  const gap = state.baselineKnown && event.seq !== state.seq + 1;
  const base = { ...state, seq: event.seq, baselineKnown: true, missedEvents: state.missedEvents || gap };

  switch (event.type) {
    case 'entry.added':
      return { ...base, entries: [...state.entries, event.entry] };
    case 'part.added':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) => {
          const parts = [...e.parts];
          parts.splice(event.index, 0, event.part);
          return { ...e, parts };
        }),
      };
    case 'text.appended':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) =>
          mapPart(e, event.partId, (p) => (p.kind === 'text' ? { ...p, text: p.text + event.delta } : p)),
        ),
      };
    case 'part.updated':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) =>
          mapPart(e, event.partId, (p) => (isWorkPart(p) ? ({ ...p, ...event.patch } as Part) : p)),
        ),
      };
    case 'entry.status':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) => ({ ...e, status: event.status, error: event.error })),
      };
    case 'provenance.updated':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) => ({ ...e, provenance: event.provenance })),
      };
    case 'conversation.created':
      return { ...base, conversation: event.conversation };
    case 'conversation.updated':
      return {
        ...base,
        conversation: state.conversation
          ? { ...state.conversation, title: event.title ?? state.conversation.title, updatedAt: event.updatedAt }
          : state.conversation,
      };
    case 'permission.requested':
    case 'permission.resolved':
      return base; // permission UI state handled in the hook, not entry state
    default:
      return base;
  }
}
