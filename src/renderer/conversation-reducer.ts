import type { AgentEvent, Conversation, Entry, Part } from '@/shared/agent-contract';

export interface ConversationState {
  conversation: Conversation | null;
  entries: Entry[];
  seq: number;
  missedEvents: boolean;
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
    missedEvents: false,
  };
}

function mapEntry(entries: Entry[], id: string, fn: (e: Entry) => Entry): Entry[] {
  return entries.map((e) => (e.id === id ? fn(e) : e));
}

function mapPart(entry: Entry, partId: string, fn: (p: Part) => Part): Entry {
  return { ...entry, parts: entry.parts.map((p) => (p.id === partId ? fn(p) : p)) };
}

export function reduce(state: ConversationState, event: AgentEvent): ConversationState {
  const gap = state.seq !== 0 && event.seq !== state.seq + 1;
  const base = { ...state, seq: event.seq, missedEvents: state.missedEvents || gap };

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
          mapPart(e, event.partId, (p) => ({ ...p, ...event.patch }) as Part),
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
