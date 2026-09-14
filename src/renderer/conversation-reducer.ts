import type {
  BlockingRequest,
  ConversationRef,
  ConversationRuntime,
  ConversationStreamEvent,
  ConversationSummary,
  ConversationTurn,
  HarnessCapabilities,
  TurnBlock,
} from '@/shared/conversation-contract';

export interface ConversationState {
  ref: ConversationRef | null;
  loadId: string | null;
  lastSeq: number;
  turns: ConversationTurn[];
  summary: ConversationSummary | null;
  capabilities: HarnessCapabilities | null;
  runtime: ConversationRuntime;
  requests: BlockingRequest[];
  history: 'idle' | 'loading' | 'complete' | 'failed';
  sync: 'current' | 'gap';
  error: string | null;
  nextHistoryChunkIndex: number;
  streamedRuntime: boolean;
  streamedSummary: boolean;
}

export const initialConversationState: ConversationState = {
  ref: null,
  loadId: null,
  // The service numbers its first event 0, so -1 makes that event contiguous.
  lastSeq: -1,
  turns: [],
  summary: null,
  capabilities: null,
  runtime: 'unknown',
  requests: [],
  history: 'idle',
  sync: 'current',
  error: null,
  nextHistoryChunkIndex: 0,
  streamedRuntime: false,
  streamedSummary: false,
};

type LocalAction =
  | { type: 'opened'; ref: ConversationRef; loadId: string }
  | { type: 'reset' }
  | { type: 'open.succeeded'; ref: ConversationRef; loadId: string; summary: ConversationSummary; capabilities: HarnessCapabilities }
  | { type: 'open.failed'; ref: ConversationRef; loadId: string; message: string };

export type ConversationAction = ConversationStreamEvent | LocalAction;

function sameRef(left: ConversationRef, right: ConversationRef): boolean {
  return left.provider === right.provider
    && left.nativeSessionId === right.nativeSessionId
    && left.projectPath === right.projectPath;
}

function freshState(ref: ConversationRef, loadId: string): ConversationState {
  return { ...initialConversationState, ref, loadId, turns: [], requests: [], history: 'loading' };
}

function upsertById<T extends { id: string }>(items: T[], incoming: T): T[] {
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index < 0) return [...items, incoming];
  const next = [...items];
  next[index] = incoming;
  return next;
}

function upsertTurns(turns: ConversationTurn[], incoming: ConversationTurn[]): ConversationTurn[] {
  return incoming.reduce(upsertById, turns);
}

function updateTurn(turns: ConversationTurn[], turnId: string, update: (turn: ConversationTurn) => ConversationTurn): ConversationTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) return turns;
  const next = [...turns];
  next[index] = update(turns[index]);
  return next;
}

function updateBlock(blocks: TurnBlock[], blockId: string, update: (block: TurnBlock) => TurnBlock): TurnBlock[] {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return blocks;
  const next = [...blocks];
  next[index] = update(blocks[index]);
  return next;
}

function applyEvent(state: ConversationState, event: ConversationStreamEvent): ConversationState {
  switch (event.type) {
    case 'history.chunk':
      return {
        ...state,
        turns: upsertTurns(state.turns, event.turns),
        nextHistoryChunkIndex: state.nextHistoryChunkIndex + 1,
      };
    case 'history.complete':
      return { ...state, history: 'complete' };
    case 'turn.upserted':
      return { ...state, turns: upsertTurns(state.turns, [event.turn]) };
    case 'assistant.delta':
      return {
        ...state,
        turns: updateTurn(state.turns, event.turnId, (turn) => ({
          ...turn,
          blocks: updateBlock(turn.blocks, event.blockId, (block) =>
            block.kind === 'assistant-prose' ? { ...block, text: block.text + event.delta } : block),
        })),
      };
    case 'action.upserted':
      return {
        ...state,
        turns: updateTurn(state.turns, event.turnId, (turn) => ({
          ...turn,
          blocks: updateBlock(turn.blocks, event.packetId, (block) =>
            block.kind === 'work-packet'
              ? { ...block, actions: upsertById(block.actions, event.action) }
              : block),
        })),
      };
    case 'runtime.changed':
      return { ...state, runtime: event.runtime, streamedRuntime: true };
    case 'request.opened':
      return { ...state, requests: upsertById(state.requests, event.request) };
    case 'request.resolved': {
      // Imported requests may exist only in turn blocks. Keep their native
      // resolution in the same authoritative overlay as live requests, so
      // later turn updates cannot resurrect their open controls.
      const request = state.requests.find((item) => item.id === event.requestId)
        ?? state.turns.flatMap((turn) => turn.blocks.flatMap((block) =>
          block.kind === 'approval' || block.kind === 'question' ? [block.request] : []))
          .find((item) => item.id === event.requestId);
      return {
        ...state,
        requests: request
          ? upsertById(state.requests, { ...request, status: 'resolved', decision: event.decision })
          : state.requests,
      };
    }
    case 'summary.updated':
      return { ...state, summary: event.summary, runtime: event.summary.runtime, streamedRuntime: true, streamedSummary: true };
    case 'load.failed':
      return { ...state, history: 'failed', runtime: 'failed', error: event.message, streamedRuntime: true };
  }
}

function isCurrentEvent(state: ConversationState, event: ConversationStreamEvent): boolean {
  return state.ref !== null && state.loadId === event.loadId && sameRef(state.ref, event.ref);
}

function isCurrentLocalAction(state: ConversationState, action: Extract<LocalAction, { ref: ConversationRef; loadId: string }>): boolean {
  return state.ref !== null && state.loadId === action.loadId && sameRef(state.ref, action.ref);
}

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case 'opened':
      return freshState(action.ref, action.loadId);
    case 'reset':
      return initialConversationState;
    case 'open.succeeded':
      return isCurrentLocalAction(state, action)
        ? {
          ...state,
          capabilities: action.capabilities,
          summary: state.streamedSummary ? state.summary : action.summary,
          runtime: state.sync === 'gap' ? 'unknown' : state.streamedRuntime ? state.runtime : action.summary.runtime,
        }
        : state;
    case 'open.failed':
      return isCurrentLocalAction(state, action)
        ? { ...state, history: 'failed', runtime: 'failed', error: action.message }
        : state;
    default:
      if (!isCurrentEvent(state, action) || state.sync === 'gap' || action.seq <= state.lastSeq) return state;
      if (action.seq !== state.lastSeq + 1) return { ...state, sync: 'gap', runtime: 'unknown' };
      if (action.type === 'history.chunk') {
        if (action.chunkIndex < state.nextHistoryChunkIndex) return { ...state, lastSeq: action.seq };
        if (action.chunkIndex > state.nextHistoryChunkIndex) return { ...state, sync: 'gap', runtime: 'unknown' };
      }
      return { ...applyEvent(state, action), lastSeq: action.seq };
  }
}
