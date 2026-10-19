// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConversationHub, resetConversationHubForTests, useConversationStates } from '@/renderer/conversation-hub';
import { initialConversationState } from '@/renderer/conversation-reducer';
import { useConversation } from '@/renderer/use-conversation';
import { conversationKey, type ConversationApi, type ConversationRef, type ConversationStreamEvent, type ConversationTurn, type HarnessCapabilities } from '@/shared/conversation-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
const otherRef: ConversationRef = { ...ref, nativeSessionId: 'thread-2' };
const capabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: false };
const summary = { ref, title: 'Conversation', updatedAt: 1, runtime: 'idle' as const, captureCompleteness: 'complete' as const };
type EventPayload = ConversationStreamEvent extends infer Event ? Event extends ConversationStreamEvent ? Omit<Event, 'loadId' | 'seq' | 'ref'> : never : never;
type HubApi = ConstructorParameters<typeof ConversationHub>[0];

function turn(id = 'turn-1'): ConversationTurn {
  return { id, nativeId: `native-${id}`, userMessage: { id: `message-${id}`, text: 'Hello' }, blocks: [], status: 'active', captureCompleteness: 'complete' };
}

function stream(target: ConversationRef, loadId: string, seq: number, payload: EventPayload): ConversationStreamEvent {
  return { loadId, seq, ref: target, ...payload } as ConversationStreamEvent;
}

function fakeApi(overrides: Partial<HubApi> = {}) {
  let listener: ((event: ConversationStreamEvent) => void) | undefined;
  const api = {
    open: vi.fn<ConversationApi['open']>().mockResolvedValue({ summary, capabilities }),
    close: vi.fn<ConversationApi['close']>().mockResolvedValue(),
    continue: vi.fn<ConversationApi['continue']>().mockResolvedValue(),
    interrupt: vi.fn<ConversationApi['interrupt']>().mockResolvedValue(),
    resolveRequest: vi.fn<ConversationApi['resolveRequest']>().mockResolvedValue(),
    onEvent: vi.fn<ConversationApi['onEvent']>((next) => { listener = next; return vi.fn(); }),
    ...overrides,
  };
  return { api, emit: (event: ConversationStreamEvent) => listener?.(event) };
}

const tick = () => new Promise<void>((resolve) => { queueMicrotask(resolve); });

async function opened(hub: ConversationHub, target: ConversationRef, emit: (event: ConversationStreamEvent) => void): Promise<string> {
  await waitFor(() => expect(hub.state(target).capabilities).toEqual(capabilities));
  const loadId = hub.state(target).loadId;
  if (!loadId) throw new Error('Conversation did not open');
  emit(stream(target, loadId, 0, { type: 'history.complete' }));
  return loadId;
}

afterEach(() => { vi.restoreAllMocks(); resetConversationHubForTests(); Reflect.deleteProperty(window, 'fractal'); });

describe('ConversationHub', () => {
  test('opens on the first lease and closes once after the last is released', async () => {
    const { api } = fakeApi();
    const hub = new ConversationHub(api);
    const releaseFirst = hub.acquire(ref);
    const releaseSecond = hub.acquire({ ...ref });
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(api.onEvent).toHaveBeenCalledTimes(1);

    releaseFirst();
    await tick();
    expect(api.close).not.toHaveBeenCalled();
    expect(hub.state(ref).ref).toEqual(ref);

    releaseSecond();
    releaseSecond();
    await tick();
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(api.close).toHaveBeenCalledWith(ref);
    expect(hub.state(ref)).toBe(initialConversationState);
  });

  test('keeps the load when it is released and acquired again in the same tick', async () => {
    const { api } = fakeApi();
    const hub = new ConversationHub(api);
    hub.acquire(ref)();
    const release = hub.acquire(ref);
    await tick();
    expect(api.close).not.toHaveBeenCalled();
    expect(api.open).toHaveBeenCalledTimes(1);
    release();
    await tick();
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  test('subscribes to events before the first open, so events emitted during open are kept', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    const { api } = fakeApi({
      onEvent: vi.fn((next) => { listener = next; return vi.fn(); }),
      open: vi.fn<ConversationApi['open']>(async (target, id) => {
        listener?.(stream(target, id, 0, { type: 'history.chunk', chunkIndex: 0, turns: [turn()] }));
        return { summary, capabilities };
      }),
    });
    const hub = new ConversationHub(api);
    hub.acquire(ref);
    await waitFor(() => expect(hub.state(ref).capabilities).toEqual(capabilities));
    expect(hub.state(ref).turns).toEqual([turn()]);
  });

  test('routes events by conversation and load through the reducer and ignores other loads', async () => {
    const { api, emit } = fakeApi();
    const hub = new ConversationHub(api);
    const listener = vi.fn();
    hub.subscribe(listener);
    hub.acquire(ref);
    hub.acquire(otherRef);
    const loadId = await opened(hub, ref, emit);
    await opened(hub, otherRef, emit);

    emit(stream(ref, loadId, 1, { type: 'turn.upserted', turn: turn() }));
    expect(hub.state(ref).turns).toEqual([turn()]);
    expect(hub.state(otherRef).turns).toEqual([]);

    const before = hub.state(ref);
    listener.mockClear();
    emit(stream(ref, 'another-load', 2, { type: 'turn.upserted', turn: turn('turn-2') }));
    emit(stream({ ...ref, nativeSessionId: 'unknown' }, loadId, 2, { type: 'turn.upserted', turn: turn('turn-2') }));
    expect(hub.state(ref)).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  test('reopens a conversation once per load after a sequence gap', async () => {
    const { api, emit } = fakeApi();
    const hub = new ConversationHub(api);
    hub.acquire(ref);
    const firstLoadId = await opened(hub, ref, emit);

    emit(stream(ref, firstLoadId, 5, { type: 'runtime.changed', runtime: 'idle' }));
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(api.open).toHaveBeenCalledTimes(2);
    const secondLoadId = hub.state(ref).loadId;
    expect(secondLoadId).not.toBe(firstLoadId);
    expect(hub.state(ref)).toMatchObject({ sync: 'current', history: 'loading' });

    emit(stream(ref, firstLoadId, 6, { type: 'runtime.changed', runtime: 'idle' }));
    expect(api.open).toHaveBeenCalledTimes(2);

    if (!secondLoadId) throw new Error('Reopen did not start');
    emit(stream(ref, secondLoadId, 3, { type: 'history.complete' }));
    expect(api.open).toHaveBeenCalledTimes(3);
    expect(api.close).toHaveBeenCalledTimes(2);
  });

  test('refuses actions on an unacquired or stale load', async () => {
    const { api, emit } = fakeApi();
    const hub = new ConversationHub(api);
    expect(hub.canSend(ref)).toBe(false);
    expect(hub.send(ref, { text: 'nobody holds this' })).toBeUndefined();
    expect(hub.interrupt(ref)).toBeUndefined();
    expect(hub.resolveRequest(ref, 'request-1', { kind: 'allow-once' })).toBeUndefined();

    const release = hub.acquire(ref);
    await opened(hub, ref, emit);
    expect(hub.canSend(ref)).toBe(true);
    expect(hub.canSend({ ...ref, projectPath: '/elsewhere' })).toBe(false);
    await hub.send(ref, { text: 'go' });
    expect(api.continue).toHaveBeenCalledWith(ref, { text: 'go' });

    release();
    expect(hub.canSend(ref)).toBe(false);
    expect(hub.send(ref, { text: 'released' })).toBeUndefined();
    expect(hub.interrupt(ref)).toBeUndefined();
    expect(api.continue).toHaveBeenCalledTimes(1);
    expect(api.interrupt).not.toHaveBeenCalled();
  });

  test('passes a rejection through while its load is current and swallows it after the load changed', async () => {
    const deferred: Array<(cause: Error) => void> = [];
    const pending = () => new Promise<void>((_resolve, reject) => { deferred.push(reject); });
    const { api, emit } = fakeApi({ continue: vi.fn(pending), interrupt: vi.fn(pending) });
    const hub = new ConversationHub(api);
    hub.acquire(ref);
    const firstLoadId = await opened(hub, ref, emit);

    const current = hub.send(ref, { text: 'current' });
    deferred.shift()?.(new Error('Continue failed'));
    await expect(current).rejects.toThrow('Continue failed');

    const stale = hub.interrupt(ref);
    hub.reload(ref);
    expect(hub.state(ref).loadId).not.toBe(firstLoadId);
    deferred.shift()?.(new Error('stale reload'));
    await expect(stale).resolves.toBeUndefined();
  });

  test('ignores a late open result once the load it belonged to has closed', async () => {
    const resolvers: Array<(value: Awaited<ReturnType<ConversationApi['open']>>) => void> = [];
    const { api } = fakeApi({ open: vi.fn<ConversationApi['open']>(() => new Promise((resolve) => { resolvers.push(resolve); })) });
    const hub = new ConversationHub(api);
    hub.acquire(ref)();
    await tick();
    expect(api.close).toHaveBeenCalledTimes(1);
    hub.acquire(ref);
    const reopened = hub.state(ref);
    await act(async () => resolvers[0]?.({ summary, capabilities }));
    expect(api.open).toHaveBeenCalledTimes(2);
    expect(hub.state(ref)).toBe(reopened);
    expect(hub.state(ref).capabilities).toBeNull();
  });

  test('two views of one conversation share one load, and the first keeps streaming after the second unmounts', async () => {
    const { api, emit } = fakeApi();
    Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api } });
    const execute = renderHook(() => useConversation(ref));
    const map = renderHook(() => useConversation({ ...ref }));
    await waitFor(() => expect(execute.result.current.state.capabilities).toEqual(capabilities));
    expect(api.open).toHaveBeenCalledTimes(1);
    const loadId = execute.result.current.state.loadId;
    if (!loadId) throw new Error('Conversation did not open');
    expect(map.result.current.state.loadId).toBe(loadId);

    map.unmount();
    await act(async () => { await tick(); });
    expect(api.close).not.toHaveBeenCalled();
    act(() => emit(stream(ref, loadId, 0, { type: 'history.complete' })));
    act(() => emit(stream(ref, loadId, 1, { type: 'turn.upserted', turn: turn() })));
    expect(execute.result.current.state).toMatchObject({ history: 'complete', turns: [turn()] });
    await act(async () => { await execute.result.current.send('still here'); });
    expect(api.continue).toHaveBeenCalledWith(ref, { text: 'still here' });

    execute.unmount();
    await act(async () => { await tick(); });
    expect(api.close).toHaveBeenCalledTimes(1);
  });
});

describe('useConversationStates', () => {
  test('leases each ref while mounted and keeps its map until one of its states changes', async () => {
    const { api, emit } = fakeApi();
    Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api } });
    const { result, rerender, unmount } = renderHook(({ refs }) => useConversationStates(refs), { initialProps: { refs: [ref, otherRef] } });
    await waitFor(() => expect(result.current.get(conversationKey(otherRef))?.capabilities).toEqual(capabilities));
    await waitFor(() => expect(result.current.get(conversationKey(ref))?.capabilities).toEqual(capabilities));
    expect(api.open).toHaveBeenCalledTimes(2);

    const before = result.current;
    rerender({ refs: [{ ...ref }, { ...otherRef }] });
    await act(async () => { await tick(); });
    expect(result.current).toBe(before);
    expect(api.open).toHaveBeenCalledTimes(2);
    expect(api.close).not.toHaveBeenCalled();

    const loadId = before.get(conversationKey(ref))?.loadId;
    if (!loadId) throw new Error('Conversation did not open');
    act(() => emit(stream(ref, loadId, 0, { type: 'history.complete' })));
    expect(result.current).not.toBe(before);
    expect(result.current.get(conversationKey(ref))?.history).toBe('complete');
    expect(result.current.get(conversationKey(otherRef))).toBe(before.get(conversationKey(otherRef)));

    rerender({ refs: [otherRef] });
    await act(async () => { await tick(); });
    expect(api.close).toHaveBeenCalledWith(ref);
    expect([...result.current.keys()]).toEqual([conversationKey(otherRef)]);
    unmount();
    await act(async () => { await tick(); });
    expect(api.close).toHaveBeenCalledTimes(2);
  });
});
