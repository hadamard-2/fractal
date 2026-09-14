// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useConversation } from '@/renderer/use-conversation';
import type { ConversationApi, ConversationRef, ConversationStreamEvent, ConversationTurn, HarnessCapabilities } from '@/shared/conversation-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
const otherRef: ConversationRef = { ...ref, nativeSessionId: 'thread-2' };
const capabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: false };
const summary = { ref, title: 'Conversation', updatedAt: 1, runtime: 'idle' as const, captureCompleteness: 'complete' as const };
type EventPayload = ConversationStreamEvent extends infer Event ? Event extends ConversationStreamEvent ? Omit<Event, 'loadId' | 'seq' | 'ref'> : never : never;

function turn(): ConversationTurn {
  return { id: 'turn-1', nativeId: 'native-turn-1', userMessage: { id: 'message-1', text: 'Hello' }, blocks: [], status: 'active', captureCompleteness: 'complete' };
}

function install(api: Partial<ConversationApi>) {
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api } });
}

function stream(loadId: string, seq: number, payload: EventPayload): ConversationStreamEvent {
  return { loadId, seq, ref, ...payload } as ConversationStreamEvent;
}

afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(window, 'fractal'); });

describe('useConversation', () => {
  test('opens after subscribing so an immediate history event seeds the active generation', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    const open = vi.fn<ConversationApi['open']>(async (_ref, id) => {
      listener?.(stream(id, 0, { type: 'history.chunk', chunkIndex: 0, turns: [turn()] }));
      listener?.(stream(id, 1, { type: 'history.complete' }));
      return { summary, capabilities };
    });
    install({ onEvent: vi.fn((next) => { listener = next; return vi.fn(); }), open, close: vi.fn() });

    const { result, unmount } = renderHook(() => useConversation(ref));

    await waitFor(() => expect(result.current.state.history).toBe('complete'));
    expect(result.current.state.turns).toEqual([turn()]);
    expect(open).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('closes the old load and ignores its late open result after selection changes', async () => {
    let firstLoadId = '';
    let resolveFirst: ((value: Awaited<ReturnType<ConversationApi['open']>>) => void) | undefined;
    const open = vi.fn<ConversationApi['open']>((target, id) => {
      if (target.nativeSessionId === ref.nativeSessionId) {
        firstLoadId = id;
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ summary: { ...summary, ref: otherRef, title: 'Other' }, capabilities });
    });
    const close = vi.fn<ConversationApi['close']>().mockResolvedValue();
    install({ onEvent: vi.fn(() => vi.fn()), open, close });

    const { result, rerender, unmount } = renderHook(({ selected }) => useConversation(selected), { initialProps: { selected: ref } });
    rerender({ selected: otherRef });
    if (!resolveFirst) throw new Error('First open did not start');
    await act(async () => resolveFirst?.({ summary, capabilities }));

    await waitFor(() => expect(result.current.state.ref).toEqual(otherRef));
    expect(close).toHaveBeenCalledWith(ref);
    expect(result.current.state.summary?.title).toBe('Other');
    expect(result.current.state.loadId).not.toBe(firstLoadId);
    unmount();
  });

  test('reopens exactly once after a sequence gap', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    const open = vi.fn<ConversationApi['open']>().mockResolvedValue({ summary, capabilities });
    const close = vi.fn<ConversationApi['close']>().mockResolvedValue();
    install({ onEvent: vi.fn((next) => { listener = next; return vi.fn(); }), open, close });

    const { result, unmount } = renderHook(() => useConversation(ref));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const oldLoadId = result.current.state.loadId;
    if (!oldLoadId) throw new Error('First load did not open');
    act(() => listener?.(stream(oldLoadId, 2, { type: 'runtime.changed', runtime: 'idle' })));

    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.current.state.sync).toBe('current');
    unmount();
  });

  test('delegates only validated send, interrupt, and request resolution inputs', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    const continueConversation = vi.fn<ConversationApi['continue']>().mockResolvedValue();
    const interrupt = vi.fn<ConversationApi['interrupt']>().mockResolvedValue();
    const resolveRequest = vi.fn<ConversationApi['resolveRequest']>().mockResolvedValue();
    install({ onEvent: vi.fn((next) => { listener = next; return vi.fn(); }), open: vi.fn().mockResolvedValue({ summary, capabilities }), close: vi.fn(), continue: continueConversation, interrupt, resolveRequest });
    const { result, unmount } = renderHook(() => useConversation(ref));
    await waitFor(() => expect(result.current.state.capabilities).toEqual(capabilities));
    const activeLoadId = result.current.state.loadId;
    if (!activeLoadId) throw new Error('Conversation did not open');
    act(() => listener?.(stream(activeLoadId, 0, { type: 'history.complete' })));
    act(() => result.current.send('   '));
    act(() => result.current.send('Continue this'));
    act(() => result.current.interrupt());
    act(() => result.current.resolveRequest('request-1', { kind: 'allow-once' }));

    await waitFor(() => expect(continueConversation).toHaveBeenCalledWith(ref, { text: 'Continue this' }));
    expect(interrupt).toHaveBeenCalledWith(ref);
    expect(resolveRequest).toHaveBeenCalledWith('request-1', { kind: 'allow-once' });
    unmount();
  });
});
