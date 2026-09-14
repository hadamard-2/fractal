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
    act(() => listener?.(stream(oldLoadId, 1, { type: 'history.complete' })));
    expect(result.current.state.loadId).not.toBe(oldLoadId);
    expect(result.current.state.history).toBe('loading');
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
    await act(async () => { await result.current.send('Continue this'); });
    await act(async () => { await result.current.interrupt(); });
    await act(async () => { await result.current.resolveRequest('request-1', { kind: 'allow-once' }); });

    await waitFor(() => expect(continueConversation).toHaveBeenCalledWith(ref, { text: 'Continue this' }));
    expect(interrupt).toHaveBeenCalledWith(ref);
    expect(resolveRequest).toHaveBeenCalledWith('request-1', { kind: 'allow-once' });
    unmount();
  });

  test('preserves stream metadata that arrives before a deferred open resolves', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    let resolveOpen: ((value: Awaited<ReturnType<ConversationApi['open']>>) => void) | undefined;
    install({
      onEvent: vi.fn((next) => { listener = next; return vi.fn(); }),
      open: vi.fn<ConversationApi['open']>(() => new Promise((resolve) => { resolveOpen = resolve; })),
      close: vi.fn(),
    });
    const { result, unmount } = renderHook(() => useConversation(ref));
    const activeLoadId = result.current.state.loadId;
    if (!activeLoadId || !resolveOpen) throw new Error('Conversation did not open');
    const streamed = { ...summary, title: 'Stream title', updatedAt: 2, runtime: 'active-externally' as const };
    act(() => {
      listener?.(stream(activeLoadId, 0, { type: 'runtime.changed', runtime: 'active-externally' }));
      listener?.(stream(activeLoadId, 1, { type: 'summary.updated', summary: streamed }));
    });
    await act(async () => resolveOpen?.({ summary, capabilities }));

    expect(result.current.state).toMatchObject({ summary: streamed, runtime: 'active-externally', capabilities });
    unmount();
  });

  test('returns current action failures and never invokes preload from retained stale callbacks', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    const continueConversation = vi.fn<ConversationApi['continue']>().mockRejectedValue(new Error('Continue failed'));
    const interrupt = vi.fn<ConversationApi['interrupt']>().mockRejectedValue(new Error('Interrupt failed'));
    const resolveRequest = vi.fn<ConversationApi['resolveRequest']>().mockRejectedValue(new Error('Resolve failed'));
    install({ onEvent: vi.fn((next) => { listener = next; return vi.fn(); }), open: vi.fn().mockResolvedValue({ summary, capabilities }), close: vi.fn(), continue: continueConversation, interrupt, resolveRequest });
    const { result, rerender, unmount } = renderHook(({ selected }) => useConversation(selected), { initialProps: { selected: ref } });
    await waitFor(() => expect(result.current.state.capabilities).toEqual(capabilities));
    const currentLoadId = result.current.state.loadId;
    if (!currentLoadId) throw new Error('Conversation did not open');
    act(() => listener?.(stream(currentLoadId, 0, { type: 'history.complete' })));
    const current = { send: result.current.send, interrupt: result.current.interrupt, resolveRequest: result.current.resolveRequest };

    await expect(current.send('Continue this')).rejects.toThrow('Continue failed');
    await expect(current.interrupt()).rejects.toThrow('Interrupt failed');
    await expect(current.resolveRequest('request-1', { kind: 'allow-once' })).rejects.toThrow('Resolve failed');
    rerender({ selected: otherRef });
    current.send('stale'); current.interrupt(); current.resolveRequest('request-1', { kind: 'allow-once' });
    expect(continueConversation).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(resolveRequest).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('replays setup and cleanup under Testing Library StrictMode without reopening equivalent refs', async () => {
    const unsubscribe = vi.fn();
    const onEvent = vi.fn<ConversationApi['onEvent']>(() => unsubscribe);
    const open = vi.fn<ConversationApi['open']>().mockResolvedValue({ summary, capabilities });
    const close = vi.fn<ConversationApi['close']>().mockResolvedValue();
    install({ onEvent, open, close });
    const { rerender, unmount } = renderHook(({ selected }) => useConversation(selected), { initialProps: { selected: ref }, reactStrictMode: true });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    rerender({ selected: { ...ref } });
    expect(open).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  test('makes callbacks inert across a same-ref reload, null selection, and unmount', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    let resolveClose: (() => void) | undefined;
    const continueConversation = vi.fn<ConversationApi['continue']>().mockResolvedValue();
    const interrupt = vi.fn<ConversationApi['interrupt']>().mockResolvedValue();
    const resolveRequest = vi.fn<ConversationApi['resolveRequest']>().mockResolvedValue();
    const open = vi.fn<ConversationApi['open']>().mockResolvedValue({ summary, capabilities });
    const close = vi.fn<ConversationApi['close']>(() => new Promise<void>((resolve) => { resolveClose = resolve; }));
    install({ onEvent: vi.fn((next) => { listener = next; return vi.fn(); }), open, close, continue: continueConversation, interrupt, resolveRequest });
    const { result, rerender, unmount } = renderHook(({ selected }) => useConversation(selected), { initialProps: { selected: ref } });
    await waitFor(() => expect(result.current.state.capabilities).toEqual(capabilities));
    const firstLoadId = result.current.state.loadId;
    if (!firstLoadId) throw new Error('Conversation did not open');
    act(() => listener?.(stream(firstLoadId, 0, { type: 'history.complete' })));
    const beforeReload = { send: result.current.send, interrupt: result.current.interrupt, resolveRequest: result.current.resolveRequest };
    act(() => result.current.reload());
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    beforeReload.send('stale'); beforeReload.interrupt(); beforeReload.resolveRequest('request-1', { kind: 'allow-once' });
    expect(continueConversation).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(resolveRequest).not.toHaveBeenCalled();
    const beforeNull = { send: result.current.send, interrupt: result.current.interrupt, resolveRequest: result.current.resolveRequest };
    rerender({ selected: null });
    beforeNull.send('stale'); beforeNull.interrupt(); beforeNull.resolveRequest('request-1', { kind: 'allow-once' });
    expect(continueConversation).not.toHaveBeenCalled();
    const beforeUnmount = { send: result.current.send, interrupt: result.current.interrupt, resolveRequest: result.current.resolveRequest };
    unmount();
    beforeUnmount.send('stale'); beforeUnmount.interrupt(); beforeUnmount.resolveRequest('request-1', { kind: 'allow-once' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(resolveRequest).not.toHaveBeenCalled();
    resolveClose?.();
  });

  test('suppresses deferred action rejections after ref change, reload, null selection, and unmount', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    const deferred: Array<{ reject: (cause: Error) => void }> = [];
    const pending = () => new Promise<void>((_resolve, reject) => { deferred.push({ reject }); });
    const continueConversation = vi.fn<ConversationApi['continue']>(pending);
    const interrupt = vi.fn<ConversationApi['interrupt']>(pending);
    const resolveRequest = vi.fn<ConversationApi['resolveRequest']>(pending);
    install({ onEvent: vi.fn((next) => { listener = next; return vi.fn(); }), open: vi.fn().mockResolvedValue({ summary, capabilities }), close: vi.fn(), continue: continueConversation, interrupt, resolveRequest });
    const { result, rerender, unmount } = renderHook(({ selected }) => useConversation(selected), { initialProps: { selected: ref } });
    await waitFor(() => expect(result.current.state.capabilities).toEqual(capabilities));
    const firstLoadId = result.current.state.loadId;
    if (!firstLoadId) throw new Error('Conversation did not open');
    act(() => listener?.(stream(firstLoadId, 0, { type: 'history.complete' })));

    const afterRefChange = result.current.send('first');
    rerender({ selected: otherRef });
    const refChangeOutcome = expect(afterRefChange).resolves.toBeUndefined();
    deferred.shift()?.reject(new Error('stale ref'));
    await refChangeOutcome;

    const afterReload = result.current.interrupt();
    act(() => result.current.reload());
    const reloadOutcome = expect(afterReload).resolves.toBeUndefined();
    deferred.shift()?.reject(new Error('stale reload'));
    await reloadOutcome;

    const afterNull = result.current.resolveRequest('request-1', { kind: 'allow-once' });
    rerender({ selected: null });
    const nullOutcome = expect(afterNull).resolves.toBeUndefined();
    deferred.shift()?.reject(new Error('stale null'));
    await nullOutcome;

    rerender({ selected: ref });
    await waitFor(() => expect(result.current.state.ref).toEqual(ref));
    const afterUnmount = result.current.interrupt();
    const unmountOutcome = expect(afterUnmount).resolves.toBeUndefined();
    unmount();
    deferred.shift()?.reject(new Error('stale unmount'));
    await unmountOutcome;
  });

  test('keeps the replacement load usable after an earlier close settles late', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    let resolveFirstClose: (() => void) | undefined;
    const close = vi.fn<ConversationApi['close']>(() => new Promise<void>((resolve) => { resolveFirstClose ??= resolve; }));
    const continueConversation = vi.fn<ConversationApi['continue']>().mockResolvedValue();
    const open = vi.fn<ConversationApi['open']>().mockResolvedValue({ summary, capabilities });
    install({ onEvent: vi.fn((next) => { listener = next; return vi.fn(); }), open, close, continue: continueConversation, interrupt: vi.fn(), resolveRequest: vi.fn() });
    const { result, unmount } = renderHook(() => useConversation(ref));
    await waitFor(() => expect(result.current.state.capabilities).toEqual(capabilities));
    const firstLoadId = result.current.state.loadId;
    if (!firstLoadId) throw new Error('Conversation did not open');
    act(() => listener?.(stream(firstLoadId, 0, { type: 'history.complete' })));
    act(() => result.current.reload());
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    const replacementLoadId = result.current.state.loadId;
    if (!replacementLoadId) throw new Error('Replacement did not open');
    act(() => listener?.(stream(replacementLoadId, 0, { type: 'history.complete' })));
    await act(async () => { await result.current.send('before late close'); });
    await act(async () => resolveFirstClose?.());
    act(() => listener?.(stream(replacementLoadId, 1, { type: 'runtime.changed', runtime: 'active-in-fractal' })));
    await act(async () => { await result.current.send('after late close'); });

    expect(result.current.state).toMatchObject({ loadId: replacementLoadId, runtime: 'active-in-fractal' });
    expect(continueConversation).toHaveBeenCalledTimes(2);
    unmount();
  });
});
