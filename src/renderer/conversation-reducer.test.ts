import { describe, expect, test } from 'vitest';
import { conversationReducer, initialConversationState, type ConversationState } from '@/renderer/conversation-reducer';
import type { AgentAction, BlockingRequest, ConversationRef, ConversationStreamEvent, ConversationSummary, ConversationTurn, HarnessCapabilities } from '@/shared/conversation-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
const otherRef: ConversationRef = { ...ref, nativeSessionId: 'thread-2' };
const loadId = 'load-2';

const proseTurn = (text = ''): ConversationTurn => ({
  id: 'turn-1', nativeId: 'native-turn-1', userMessage: { id: 'message-1', text: 'Hello' },
  blocks: [{ id: 'prose-1', kind: 'assistant-prose', provider: 'codex', text }],
  status: 'active', captureCompleteness: 'complete',
});

const command: AgentAction = {
  id: 'command-1', nativeId: 'native-command-1', kind: 'command', provider: 'codex', status: 'completed',
  command: 'pnpm test', exitCode: 0, captureCompleteness: 'complete',
};

const actionTurn = (): ConversationTurn => ({
  ...proseTurn(),
  blocks: [
    { id: 'prose-1', kind: 'assistant-prose', provider: 'codex', text: 'Hello world' },
    { id: 'packet-1', kind: 'work-packet', status: 'active', actions: [] },
  ],
});
const capabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: false };
const openSummary: ConversationSummary = { ref, title: 'Open result', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' };

const event = <T extends Omit<ConversationStreamEvent, 'loadId' | 'ref' | 'seq'>>(seq: number, payload: T): ConversationStreamEvent =>
  ({ loadId, ref, seq, ...payload } as ConversationStreamEvent);

const open = (id = loadId, target = ref) => ({ type: 'opened' as const, loadId: id, ref: target });

function loadedState(overrides: Partial<ConversationState> = {}): ConversationState {
  return { ...conversationReducer(initialConversationState, open()), lastSeq: -1, ...overrides };
}

describe('conversationReducer', () => {
  test('opens a clean loading generation and resets it to the idle baseline', () => {
    const opened = conversationReducer(loadedState({ turns: [proseTurn()], history: 'complete' }), open());
    const reset = conversationReducer(opened, { type: 'reset' });

    expect(opened).toMatchObject({ ref, loadId, lastSeq: -1, turns: [], requests: [], history: 'loading', sync: 'current', runtime: 'unknown', error: null });
    expect(reset).toEqual(initialConversationState);
  });

  test('accepts ordered chunks for the active load only', () => {
    const oldTurn = { ...proseTurn('old'), id: 'old-turn' };
    const firstTurn = proseTurn('first');
    let state = conversationReducer(initialConversationState, open());
    state = conversationReducer(state, { ...event(0, { type: 'history.chunk', chunkIndex: 0, turns: [oldTurn] }), loadId: 'load-1' });
    state = conversationReducer(state, event(0, { type: 'history.chunk', chunkIndex: 0, turns: [firstTurn] }));

    expect(state.turns).toEqual([firstTurn]);
  });

  test('marks a sequence gap instead of applying ambiguous live state', () => {
    let state = loadedState({ lastSeq: 4, turns: [proseTurn('before')], runtime: 'active-in-fractal' });
    state = conversationReducer(state, event(6, { type: 'runtime.changed', runtime: 'idle' }));

    expect(state.sync).toBe('gap');
    expect(state.runtime).toBe('unknown');
    expect(state.lastSeq).toBe(4);
  });

  test('does not let late open metadata overwrite ordered stream metadata or a gap', () => {
    const streamedSummary: ConversationSummary = { ...openSummary, title: 'Stream result', updatedAt: 2, runtime: 'active-externally' };
    let state = loadedState();
    state = conversationReducer(state, event(0, { type: 'runtime.changed', runtime: 'active-externally' }));
    state = conversationReducer(state, event(1, { type: 'summary.updated', summary: streamedSummary }));
    state = conversationReducer(state, event(3, { type: 'runtime.changed', runtime: 'idle' }));
    state = conversationReducer(state, { type: 'open.succeeded', ref, loadId, summary: openSummary, capabilities });

    expect(state).toMatchObject({ summary: streamedSummary, runtime: 'unknown', sync: 'gap', capabilities });
  });

  test('treats turn.upserted as a complete replacement at the existing turn position', () => {
    const before = { ...proseTurn('before'), id: 'before' };
    const target = proseTurn('old');
    const after = { ...proseTurn('after'), id: 'after' };
    const correction: ConversationTurn = {
      ...target,
      status: 'completed',
      blocks: [
        { id: 'notice-1', kind: 'system-notice', message: 'Corrected', tone: 'info' },
        { id: 'prose-1', kind: 'assistant-prose', provider: 'codex', text: 'new' },
      ],
    };
    let state = loadedState({ turns: [before, target, after] });
    state = conversationReducer(state, event(0, { type: 'turn.upserted', turn: correction }));

    expect(state.turns).toEqual([before, correction, after]);
  });

  test('uses chunk indexes as a second contiguous history boundary', () => {
    const first = { ...proseTurn('first'), id: 'first' };
    const duplicate = { ...proseTurn('duplicate'), id: 'duplicate' };
    let state = loadedState();
    state = conversationReducer(state, event(0, { type: 'history.chunk', chunkIndex: 0, turns: [first] }));
    state = conversationReducer(state, event(1, { type: 'history.chunk', chunkIndex: 0, turns: [duplicate] }));
    state = conversationReducer(state, event(2, { type: 'history.chunk', chunkIndex: 2, turns: [duplicate] }));

    expect(state.turns).toEqual([first]);
    expect(state).toMatchObject({ lastSeq: 1, sync: 'gap', runtime: 'unknown' });
  });

  test('merges assistant deltas and action lifecycle updates by stable IDs', () => {
    let state = loadedState({ turns: [proseTurn()] });
    state = conversationReducer(state, event(0, { type: 'assistant.delta', turnId: 'turn-1', blockId: 'prose-1', delta: 'Hello' }));
    state = conversationReducer(state, event(1, { type: 'assistant.delta', turnId: 'turn-1', blockId: 'prose-1', delta: ' world' }));
    state = conversationReducer(state, event(2, { type: 'turn.upserted', turn: actionTurn() }));
    state = conversationReducer(state, event(3, { type: 'action.upserted', turnId: 'turn-1', packetId: 'packet-1', action: command }));

    expect(state.turns[0].blocks.find((block) => block.id === 'prose-1')).toMatchObject({ text: 'Hello world' });
    expect(state.turns[0].blocks.find((block) => block.id === 'packet-1')).toMatchObject({ actions: [command] });
  });

  test('keeps source order while replacing duplicate turns and requests', () => {
    const first = { ...proseTurn('first'), id: 'turn-first' };
    const second = { ...proseTurn('second'), id: 'turn-second' };
    const request: BlockingRequest = { id: 'request-1', kind: 'approval', provider: 'codex', title: 'Run tests', operation: 'pnpm test', status: 'open' };
    let state = loadedState();
    state = conversationReducer(state, event(0, { type: 'history.chunk', chunkIndex: 0, turns: [first, second] }));
    state = conversationReducer(state, event(1, { type: 'history.chunk', chunkIndex: 0, turns: [{ ...first, status: 'completed' }] }));
    state = conversationReducer(state, event(2, { type: 'request.opened', request }));
    state = conversationReducer(state, event(3, { type: 'request.opened', request: { ...request, title: 'Run all tests' } }));

    expect(state.turns.map((turn) => [turn.id, turn.status])).toEqual([['turn-first', 'active'], ['turn-second', 'active']]);
    expect(state.requests).toEqual([{ ...request, title: 'Run all tests' }]);
  });

  test('ignores stale, duplicate, and different-generation events without mutation', () => {
    const state = loadedState({ lastSeq: 2, turns: [proseTurn('stable')] });
    const duplicate = event(2, { type: 'assistant.delta', turnId: 'turn-1', blockId: 'prose-1', delta: ' duplicate' });
    const staleLoad = { ...event(3, { type: 'assistant.delta', turnId: 'turn-1', blockId: 'prose-1', delta: ' stale' }), loadId: 'load-1' };
    const staleRef = { ...event(3, { type: 'assistant.delta', turnId: 'turn-1', blockId: 'prose-1', delta: ' stale' }), ref: otherRef };

    expect(conversationReducer(state, duplicate)).toBe(state);
    expect(conversationReducer(state, staleLoad)).toBe(state);
    expect(conversationReducer(state, staleRef)).toBe(state);
  });

  test('resolves a request only after its ordered provider event', () => {
    const request: BlockingRequest = { id: 'request-1', kind: 'question', provider: 'codex', prompt: 'Proceed?', fieldId: 'proceed', allowFreeText: false, status: 'open' };
    let state = loadedState();
    state = conversationReducer(state, event(0, { type: 'request.opened', request }));
    state = conversationReducer(state, event(1, { type: 'request.resolved', requestId: request.id, decision: { kind: 'answer', answers: { proceed: 'yes' } } }));

    expect(state.requests).toEqual([{ ...request, status: 'resolved', decision: { kind: 'answer', answers: { proceed: 'yes' } } }]);
  });
});
