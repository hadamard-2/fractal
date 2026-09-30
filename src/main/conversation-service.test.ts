import { describe, expect, test, vi } from 'vitest';
import { ConversationRegistry } from '@/main/conversation-registry';
import { ConversationService } from '@/main/conversation-service';
import type { ConversationRun, HarnessAdapter, NativeEventSink } from '@/main/harness/types';
import type { NativeEvent, NativeEventPayload } from '@/main/harness/reconciler';
import type { ConversationStreamEvent, ConversationSummary, HarnessCapabilities } from '@/shared/conversation-contract';
import { parseConversationStreamEvent } from '@/shared/conversation-ipc';

const ref = { provider: 'codex' as const, nativeSessionId: 'session', projectPath: '/repo' };
const loadId = '00000000-0000-4000-8000-000000000001';
const nextLoadId = '00000000-0000-4000-8000-000000000002';
const capabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: false, questions: false, interrupt: false, steerWhileRunning: false, fork: false };
const summary: ConversationSummary = { ref, title: 'Session', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' };
function event(nativeId: string, payload: NativeEventPayload): NativeEvent {
  return { provider: 'codex', nativeId, nativeType: payload.kind, observedAt: 1, payload };
}
function start(id = 'turn'): NativeEvent { return event(`start:${id}`, { kind: 'turn-started', turnId: id, userMessageId: `user:${id}`, text: 'Question' }); }
function prose(text: string, final = false, turnId = 'turn'): NativeEvent { return event(`prose:${turnId}`, { kind: 'assistant-text', turnId, blockId: `block:${turnId}`, text, final }); }
function finish(id = 'turn'): NativeEvent { return event(`finish:${id}`, { kind: 'turn-finished', turnId: id, status: 'completed' }); }
async function* iterable(events: NativeEvent[]) { yield* events; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function approvalRequest(id = 'request-owned') {
  return { id, kind: 'approval' as const, provider: 'codex' as const, title: 'Run', operation: 'pwd', rememberScope: 'project:/repo', status: 'open' as const };
}
function runFixture(): ConversationRun & { events: { [Symbol.asyncIterator]: ReturnType<typeof vi.fn> } } {
  const iterator = vi.fn(() => ({ next: vi.fn(async () => ({ done: true as const, value: undefined })) }));
  return { events: { [Symbol.asyncIterator]: iterator }, interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
}
function fixture(history: NativeEvent[] = [], historyChunkSize = 50, provider: 'codex' | 'claude' = 'codex') {
  const sinks: NativeEventSink[] = [];
  const unsubscribe = vi.fn();
  const adapter: HarnessAdapter = {
    provider, capabilities: () => capabilities,
    probe: vi.fn(async () => ({ provider, availability: 'available' as const, capabilities })),
    listConversations: vi.fn(async () => [summary]),
    loadConversation: vi.fn(async () => ({ summary, events: iterable(history) })),
    watchConversation: vi.fn(async (_ref, sink) => { sinks.push(sink); return unsubscribe; }),
    createConversation: vi.fn(), continueConversation: vi.fn(),
  };
  const events: ConversationStreamEvent[] = [];
  const registry = new ConversationRegistry([adapter], async (path) => path);
  const emit = (value: ConversationStreamEvent) => { events.push(parseConversationStreamEvent(value)); };
  const service = new ConversationService(registry, emit, { historyChunkSize });
  return { adapter, service, events, sinks, unsubscribe, registry };
}

describe('ConversationService rename', () => {
  test('renames an idle conversation through its adapter with the trimmed title', async () => {
    const f = fixture();
    const renameConversation = vi.fn(async () => undefined);
    f.adapter.renameConversation = renameConversation;
    await f.service.rename(ref, '  New name ');
    expect(renameConversation).toHaveBeenCalledWith(ref, 'New name');
  });

  test('refuses busy, subagent, unknown, and unsupported conversations', async () => {
    const f = fixture();
    const renameConversation = vi.fn(async () => undefined);
    await expect(f.service.rename(ref, 'Name')).rejects.toThrow('not available');
    f.adapter.renameConversation = renameConversation;
    vi.mocked(f.adapter.listConversations).mockResolvedValueOnce([{ ...summary, runtime: 'active-externally' }]);
    await expect(f.service.rename(ref, 'Name')).rejects.toThrow('busy');
    vi.mocked(f.adapter.listConversations).mockResolvedValueOnce([{ ...summary, parentId: 'parent' }]);
    await expect(f.service.rename(ref, 'Name')).rejects.toThrow('read-only');
    await expect(f.service.rename({ ...ref, nativeSessionId: 'missing' }, 'Name')).rejects.toThrow('not currently available');
    await expect(f.service.rename(ref, '   ')).rejects.toThrow('Invalid conversation title');
    expect(renameConversation).not.toHaveBeenCalled();
  });
});

describe('ConversationService', () => {
  test('streams 205 finalized turns in bounded ordered chunks after establishing the watcher', async () => {
    const f = fixture(Array.from({ length: 205 }, (_, index) => [start(String(index)), finish(String(index))]).flat());
    const response = await f.service.open(ref, loadId);
    expect(f.events.filter((item) => item.type === 'history.chunk').map((item) => item.turns.length)).toEqual([50, 50, 50, 50, 5]);
    expect(f.events.at(-1)?.type).toBe('history.complete');
    expect(f.events.map((item) => item.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(vi.mocked(f.adapter.watchConversation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.adapter.loadConversation).mock.invocationCallOrder[0]);
    expect(response).toEqual({ summary, capabilities });
    await f.service.dispose();
  });

  test('prefers the newer load snapshot over initial watcher data and drains appends before completion', async () => {
    const f = fixture();
    vi.mocked(f.adapter.watchConversation).mockImplementation(async (_ref, sink) => {
      f.sinks.push(sink); [start(), prose('Old')].forEach(sink); return f.unsubscribe;
    });
    vi.mocked(f.adapter.loadConversation).mockResolvedValue({ summary, events: (async function* () {
      yield start(); yield prose('New');
      f.sinks[0](prose('New append'));
    })() });
    await f.service.open(ref, loadId);
    const chunks = f.events.filter((item) => item.type === 'history.chunk');
    expect(chunks[0].turns[0].blocks[0]).toMatchObject({ text: 'New' });
    expect(f.events.at(-2)).toMatchObject({ type: 'assistant.delta', delta: ' append' });
    expect(f.events.at(-1)?.type).toBe('history.complete');
    f.sinks[0](prose('New append'));
    expect(f.events.at(-1)?.type).toBe('history.complete');
    f.sinks[0](prose('Replacement', true));
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', turn: { userMessage: { text: 'Question' }, blocks: [{ text: 'Replacement' }] } });
    await f.service.dispose();
  });

  test('reconciles corrections to older turns without losing their user message or actions', async () => {
    const f = fixture([start('old'), prose('Draft', false, 'old'), finish('old'), start('new'), finish('new')]);
    await f.service.open(ref, loadId);
    f.sinks[0](prose('Corrected', true, 'old'));
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', turn: { id: 'old', status: 'completed', userMessage: { text: 'Question' }, blocks: [{ text: 'Corrected' }] } });
    await f.service.dispose();
  });

  test('uses action updates only for an established packet and emits cumulative text as suffix deltas', async () => {
    const f = fixture([start(), prose('Hello')]);
    await f.service.open(ref, loadId);
    f.sinks[0](prose('Hello world'));
    expect(f.events.at(-1)).toMatchObject({ type: 'assistant.delta', delta: ' world', blockId: 'block:turn' });
    f.sinks[0](event('action', { kind: 'action-requested', turnId: 'turn', actionId: 'a', actionKind: 'command', label: 'pwd' }));
    expect(f.events.at(-1)?.type).toBe('turn.upserted');
    f.sinks[0](event('result', { kind: 'action-updated', turnId: 'turn', actionId: 'a', status: 'completed', output: '/repo' }));
    expect(f.events.at(-2)).toMatchObject({ type: 'action.upserted', action: { id: 'a', status: 'completed', output: '/repo' } });
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', turn: { blocks: [expect.anything(), expect.objectContaining({ kind: 'work-packet', status: 'completed' })] } });
    await f.service.dispose();
  });

  test('supersedes opens before validation completes and suppresses stale generations', async () => {
    const f = fixture([start()]);
    const gate = deferred<ConversationSummary[]>();
    vi.mocked(f.adapter.listConversations).mockReturnValue(gate.promise);
    const first = f.service.open(ref, loadId);
    const second = f.service.open(ref, nextLoadId);
    gate.resolve([summary]);
    await Promise.allSettled([first, second]);
    expect(f.events.every((item) => item.loadId === nextLoadId)).toBe(true);
    expect(f.events[0].seq).toBe(0);
    expect(f.sinks).toHaveLength(1);
    await f.service.dispose();
  });

  test('closes a pending watcher exactly once and ignores its late callbacks', async () => {
    const f = fixture([start()]);
    const ready = deferred<void>();
    const gate = deferred<() => void>();
    vi.mocked(f.adapter.watchConversation).mockImplementation(async (_ref, sink) => { f.sinks.push(sink); ready.resolve(); return gate.promise; });
    const opening = f.service.open(ref, loadId);
    await ready.promise;
    await f.service.close(ref);
    gate.resolve(f.unsubscribe);
    await Promise.allSettled([opening]);
    f.sinks[0](start());
    await f.service.dispose();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([]);
    expect(f.adapter.loadConversation).not.toHaveBeenCalled();
  });

  test('deduplicates the same open and rejects reuse of an active load ID for a different ref', async () => {
    const f = fixture([start()]);
    await Promise.all([f.service.open(ref, loadId), f.service.open(ref, loadId)]);
    expect(f.sinks).toHaveLength(1);
    await expect(f.service.open({ ...ref, nativeSessionId: 'other' }, loadId)).rejects.toThrow();
    await f.service.close(ref);
    f.sinks[0](prose('ignored'));
    expect(f.events.at(-1)?.type).toBe('history.complete');
    await f.service.dispose();
    await expect(f.service.open(ref, nextLoadId)).rejects.toThrow();
  });

  test('sanitizes load errors, emits only on the affected load and releases its watch', async () => {
    const f = fixture();
    vi.mocked(f.adapter.loadConversation).mockRejectedValue(new Error('/private secret transcript'));
    await expect(f.service.open(ref, loadId)).rejects.toThrow();
    expect(f.events).toEqual([{ type: 'load.failed', ref, loadId, seq: 0, message: expect.any(String) }]);
    expect(JSON.stringify(f.events)).not.toContain('secret');
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('validates IDs, refs and chunk bounds before opening native resources', async () => {
    const f = fixture();
    await expect(f.service.open(ref, 'invalid')).rejects.toThrow();
    await expect(f.service.open({ ...ref, projectPath: '/forged' }, loadId)).rejects.toThrow();
    expect(f.sinks).toHaveLength(0);
    for (const historyChunkSize of [0, 51, -1, 1.5, NaN]) expect(() => new ConversationService(f.registry, () => undefined, { historyChunkSize })).toThrow();
  });

  test('keeps creation unavailable while continuation requires a proven idle native session', async () => {
    const f = fixture();
    vi.mocked(f.adapter.createConversation).mockResolvedValue(ref);
    await expect(f.service.create('codex', '/repo')).resolves.toEqual(ref);
    vi.mocked(f.adapter.listConversations).mockResolvedValue([{ ...summary, runtime: 'active-externally' }]);
    await f.service.open(ref, loadId);
    await expect(f.service.continue(ref, { text: 'Go' }, 'renderer')).rejects.toThrow('Conversation is not idle');
    await expect(f.service.interrupt(ref)).rejects.toThrow();
    await expect(f.service.resolveRequest('request', { kind: 'deny' })).rejects.toThrow();
    await f.service.denyRequestsForOwner('renderer', 'closed');
    expect(f.adapter.continueConversation).not.toHaveBeenCalled();
    expect(f.adapter.createConversation).toHaveBeenCalledWith('/repo');
  });

  test('opens an unsent Claude draft as empty native history and forgets it after reconciliation', async () => {
    const f = fixture([], 50, 'claude');
    const claudeRef = { provider: 'claude' as const, nativeSessionId: '00000000-0000-4000-8000-000000000099', projectPath: '/repo' };
    vi.mocked(f.adapter.probe).mockResolvedValue({ provider: 'claude', availability: 'available', capabilities });
    vi.mocked(f.adapter.listConversations).mockResolvedValue([]);
    vi.mocked(f.adapter.createConversation).mockResolvedValue(claudeRef);
    const created = await f.service.create('claude', '/repo');
    const opened = await f.service.open(created, loadId);
    expect(opened.summary).toEqual({ ref: claudeRef, title: 'New Claude conversation', updatedAt: expect.any(Number), runtime: 'idle', captureCompleteness: 'complete' });
    expect(f.events).toContainEqual({ type: 'history.complete', ref: claudeRef, loadId, seq: 0 });
    expect(f.adapter.watchConversation).not.toHaveBeenCalled();
    expect(f.adapter.loadConversation).not.toHaveBeenCalled();

    vi.mocked(f.adapter.listConversations).mockResolvedValue([{ ref: claudeRef, title: 'First native prompt', updatedAt: 2, runtime: 'idle', captureCompleteness: 'complete' }]);
    vi.mocked(f.adapter.loadConversation).mockResolvedValue({ summary: { ref: claudeRef, title: 'First native prompt', updatedAt: 2, runtime: 'idle', captureCompleteness: 'complete' }, events: iterable([]) });
    vi.mocked(f.adapter.continueConversation).mockResolvedValue(runFixture());
    await f.service.continue(claudeRef, { text: 'First native prompt' }, 'renderer');
    expect(f.adapter.continueConversation).toHaveBeenCalledWith(claudeRef, { text: 'First native prompt' });
    await vi.waitFor(() => expect(f.events.some((item) => item.type === 'summary.updated')).toBe(true));
    await f.service.close(claudeRef);
    await f.service.open(claudeRef, nextLoadId);
    expect(f.adapter.loadConversation).toHaveBeenCalled();
    await f.service.dispose();
  });

  test('keeps unused Claude drafts out of discovery and drops them when closed', async () => {
    const f = fixture([], 50, 'claude');
    const draft = { provider: 'claude' as const, nativeSessionId: '00000000-0000-4000-8000-000000000098', projectPath: '/repo' };
    vi.mocked(f.adapter.listConversations).mockResolvedValue([]);
    vi.mocked(f.adapter.createConversation).mockResolvedValue(draft);
    expect(await f.service.create('claude', '/repo')).toEqual(draft);
    expect(await f.service.list()).toMatchObject({ projects: [] });
    await f.service.open(draft, loadId);
    await f.service.close(draft);
    await expect(f.service.open(draft, nextLoadId)).rejects.toThrow();
    await f.service.dispose();
  });

  test('atomically owns one continuation until its stream and disposal settle', async () => {
    const f = fixture();
    const item = deferred<IteratorResult<NativeEvent>>();
    const disposeGate = deferred<void>();
    const nativeRun: ConversationRun = {
      events: { [Symbol.asyncIterator]: () => ({ next: () => item.promise }) },
      interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), dispose: vi.fn(() => disposeGate.promise),
    };
    vi.mocked(f.adapter.continueConversation).mockResolvedValue(nativeRun);
    await f.service.open(ref, loadId);
    await f.service.continue(ref, { text: 'Go' }, 'renderer-1');
    await expect(f.service.continue(ref, { text: 'Again' }, 'renderer-1')).rejects.toThrow('Conversation is not idle');
    item.resolve({ done: true, value: undefined });
    await vi.waitFor(() => expect(nativeRun.dispose).toHaveBeenCalled());
    await expect(f.service.continue(ref, { text: 'Still owned' }, 'renderer-1')).rejects.toThrow('Conversation is not idle');
    disposeGate.resolve();
    await vi.waitFor(() => expect(f.events.some((event) => event.type === 'runtime.changed' && event.runtime === 'idle')).toBe(true));
    expect(vi.mocked(f.adapter.continueConversation)).toHaveBeenCalledTimes(1);
    await f.service.dispose();
  });

  test('owns requests by run and renderer, rejects late answers, and denies renderer loss', async () => {
    const f = fixture();
    const items = [
      event('start:owned', { kind: 'turn-started', turnId: 'owned', userMessageId: 'user:owned', text: 'Go' }),
      event('request:owned', { kind: 'request-opened', turnId: 'owned', request: { id: 'request-owned', kind: 'approval', provider: 'codex', title: 'Run', operation: 'pwd', rememberScope: 'project:/repo', status: 'open' } }),
    ];
    const gate = deferred<IteratorResult<NativeEvent>>();
    let index = 0;
    const nativeRun: ConversationRun = { events: { [Symbol.asyncIterator]: () => ({ next: () => index < items.length ? Promise.resolve({ done: false as const, value: items[index++] }) : gate.promise }) }, interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    vi.mocked(f.adapter.continueConversation).mockResolvedValue(nativeRun);
    await f.service.open(ref, loadId);
    await f.service.continue(ref, { text: 'Go' }, 'renderer-1');
    await vi.waitFor(() => expect(f.events.some((item) => item.type === 'request.opened')).toBe(true));
    await f.service.resolveRequest('request-owned', { kind: 'allow-once' });
    expect(nativeRun.resolveRequest).toHaveBeenCalledWith('request-owned', { kind: 'allow-once' });
    await expect(f.service.resolveRequest('request-owned', { kind: 'deny' })).rejects.toThrow('Conversation request is no longer available');
    gate.resolve({ done: true, value: undefined });
    await vi.waitFor(() => expect(nativeRun.dispose).toHaveBeenCalled());

    const f2 = fixture(); const secondGate = deferred<IteratorResult<NativeEvent>>(); let secondIndex = 0;
    const secondItems = [items[0], { ...items[1], nativeId: 'request:second', payload: { ...items[1].payload, request: approvalRequest('request-second') } }];
    const nativeRun2: ConversationRun = { events: { [Symbol.asyncIterator]: () => ({ next: () => secondIndex < secondItems.length ? Promise.resolve({ done: false as const, value: secondItems[secondIndex++] }) : secondGate.promise }) }, interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    vi.mocked(f2.adapter.continueConversation).mockResolvedValue(nativeRun2);
    await f2.service.open(ref, nextLoadId); await f2.service.continue(ref, { text: 'Go' }, 'renderer-2');
    await vi.waitFor(() => expect(f2.events.some((item) => item.type === 'request.opened')).toBe(true));
    await f2.service.denyRequestsForOwner('renderer-2', 'Fractal window closed');
    expect(nativeRun2.resolveRequest).toHaveBeenCalledWith('request-second', { kind: 'deny', reason: 'Fractal window closed' });
    secondGate.resolve({ done: true, value: undefined });
    await f.service.dispose(); await f2.service.dispose();
  });

  test('rebinds an owned run, pending approval, and completion to a reopened load', async () => {
    const f = fixture();
    const pending: Array<(value: IteratorResult<NativeEvent>) => void> = [];
    const resolveNext = (value: IteratorResult<NativeEvent>) => { const resolve = pending.shift(); expect(resolve).toBeDefined(); resolve?.(value); };
    const nativeRun: ConversationRun = {
      events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<NativeEvent>>((resolve) => pending.push(resolve)) }) },
      interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    };
    vi.mocked(f.adapter.continueConversation).mockResolvedValue(nativeRun);
    await f.service.open(ref, loadId);
    await f.service.continue(ref, { text: 'Go' }, 'renderer');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await f.service.close(ref);
    resolveNext({ done: false, value: event('live-start', { kind: 'turn-started', turnId: 'live', userMessageId: 'user-live', text: 'Go' }) });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    resolveNext({ done: false, value: event('live-request', { kind: 'request-opened', turnId: 'live', request: approvalRequest() }) });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await f.service.open(ref, nextLoadId);
    expect(f.events.filter((item) => item.loadId === nextLoadId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'turn.upserted', turn: expect.objectContaining({ id: 'live' }) }),
      expect.objectContaining({ type: 'request.opened', request: expect.objectContaining({ id: 'request-owned' }) }),
      expect.objectContaining({ type: 'runtime.changed', runtime: 'waiting-for-user' }),
    ]));
    await f.service.resolveRequest('request-owned', { kind: 'allow-once' });
    expect(nativeRun.resolveRequest).toHaveBeenCalledWith('request-owned', { kind: 'allow-once' });
    resolveNext({ done: false, value: event('live-finish', { kind: 'turn-finished', turnId: 'live', status: 'completed' }) });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    resolveNext({ done: true, value: undefined });
    await vi.waitFor(() => expect(f.events.some((item) => item.loadId === nextLoadId && item.type === 'runtime.changed' && item.runtime === 'idle')).toBe(true));
    expect(f.events.filter((item) => item.loadId === loadId && item.type === 'turn.upserted')).toHaveLength(0);
    await f.service.dispose();
  });

  test('selection close during native start does not cancel renderer-owned continuation', async () => {
    const f = fixture();
    const starting = deferred<ConversationRun>();
    const nativeRun = runFixture();
    vi.mocked(f.adapter.continueConversation).mockReturnValue(starting.promise);
    await f.service.open(ref, loadId);
    const continuing = f.service.continue(ref, { text: 'Go' }, 'renderer');
    await vi.waitFor(() => expect(f.adapter.continueConversation).toHaveBeenCalled());
    await f.service.close(ref);
    await f.service.open(ref, nextLoadId);
    starting.resolve(nativeRun);
    await continuing;
    expect(nativeRun.interrupt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(nativeRun.dispose).toHaveBeenCalled());
    await f.service.dispose();
  });

  test('renderer loss denies both pending and future requests from a deselected owned run', async () => {
    const f = fixture();
    const pending: Array<(value: IteratorResult<NativeEvent>) => void> = [];
    const send = (value: IteratorResult<NativeEvent>) => { const next = pending.shift(); expect(next).toBeDefined(); next?.(value); };
    const nativeRun: ConversationRun = {
      events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<NativeEvent>>((resolve) => pending.push(resolve)) }) },
      interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    };
    vi.mocked(f.adapter.continueConversation).mockResolvedValue(nativeRun);
    await f.service.open(ref, loadId);
    await f.service.continue(ref, { text: 'Go' }, 'renderer-lost');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    send({ done: false, value: event('first-request', { kind: 'request-opened', turnId: 'live', request: approvalRequest('first') }) });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await f.service.close(ref);
    await f.service.denyRequestsForOwner('renderer-lost', 'Fractal window closed');
    expect(nativeRun.resolveRequest).toHaveBeenCalledWith('first', { kind: 'deny', reason: 'Fractal window closed' });
    send({ done: false, value: event('late-request', { kind: 'request-opened', turnId: 'live', request: approvalRequest('late') }) });
    await vi.waitFor(() => expect(nativeRun.resolveRequest).toHaveBeenCalledWith('late', { kind: 'deny', reason: 'Fractal window closed' }));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await f.service.open(ref, nextLoadId);
    expect(f.events.filter((item) => item.loadId === nextLoadId && item.type === 'request.opened')).toHaveLength(0);
    await expect(f.service.resolveRequest('late', { kind: 'allow-once' })).rejects.toThrow('Conversation request is no longer available');
    send({ done: true, value: undefined });
    await vi.waitFor(() => expect(nativeRun.dispose).toHaveBeenCalled());
    expect(nativeRun.resolveRequest).toHaveBeenCalledTimes(2);
    await f.service.dispose();
  });

  test('reports continuation failure and returns to idle only when rediscovery proves it', async () => {
    const uncertain = fixture();
    let discoveries = 0;
    vi.mocked(uncertain.adapter.listConversations).mockImplementation(async () => [{ ...summary, runtime: ++discoveries < 3 ? 'idle' : 'unknown' }]);
    let loads = 0;
    vi.mocked(uncertain.adapter.loadConversation).mockImplementation(async () => ({ summary: { ...summary, runtime: ++loads < 2 ? 'idle' : 'unknown' }, events: iterable([]) }));
    vi.mocked(uncertain.adapter.continueConversation).mockRejectedValue(new Error('/private/provider failure'));
    await uncertain.service.open(ref, loadId);
    await expect(uncertain.service.continue(ref, { text: 'Go' }, 'renderer')).rejects.toThrow('Conversation continuation failed');
    expect(uncertain.events.filter((item) => item.type === 'runtime.changed').map((item) => item.runtime)).toEqual(['active-in-fractal', 'failed']);
    await uncertain.service.dispose();

    const proven = fixture();
    vi.mocked(proven.adapter.continueConversation).mockRejectedValue(new Error('/private/provider failure'));
    await proven.service.open(ref, nextLoadId);
    await expect(proven.service.continue(ref, { text: 'Go' }, 'renderer')).rejects.toThrow('Conversation continuation failed');
    expect(proven.events.filter((item) => item.type === 'runtime.changed').map((item) => item.runtime)).toEqual(['active-in-fractal', 'failed', 'idle']);
    expect(JSON.stringify(proven.events)).not.toContain('private');
    expect(proven.adapter.loadConversation).toHaveBeenCalledTimes(2);
    await proven.service.dispose();
  });

  test('denies an open request exactly once when its native event stream fails', async () => {
    const f = fixture();
    const nativeRun: ConversationRun = {
      events: (async function* () { yield event('request', { kind: 'request-opened', turnId: 'owned', request: approvalRequest() }); throw new Error('/private stream failure'); })(),
      interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    };
    vi.mocked(f.adapter.continueConversation).mockResolvedValue(nativeRun);
    await f.service.open(ref, loadId); await f.service.continue(ref, { text: 'Go' }, 'renderer');
    await vi.waitFor(() => expect(nativeRun.dispose).toHaveBeenCalled());
    expect(nativeRun.resolveRequest).toHaveBeenCalledTimes(1);
    expect(nativeRun.resolveRequest).toHaveBeenCalledWith('request-owned', { kind: 'deny', reason: 'Conversation run failed' });
    await f.service.dispose();
  });

  test('tears down a native run returned after its renderer ownership was released', async () => {
    const f = fixture(); const starting = deferred<ConversationRun>(); const nativeRun = runFixture();
    vi.mocked(f.adapter.continueConversation).mockReturnValue(starting.promise);
    await f.service.open(ref, loadId);
    const continuing = f.service.continue(ref, { text: 'Go' }, 'renderer-lost');
    await vi.waitFor(() => expect(f.adapter.continueConversation).toHaveBeenCalled());
    await f.service.denyRequestsForOwner('renderer-lost', 'Fractal window closed');
    starting.resolve(nativeRun);
    await expect(continuing).rejects.toThrow('Conversation continuation ended');
    expect(nativeRun.interrupt).toHaveBeenCalledTimes(1);
    expect(nativeRun.dispose).toHaveBeenCalledTimes(1);
    expect(nativeRun.events[Symbol.asyncIterator]).not.toHaveBeenCalled();
    await f.service.dispose();
  });

  test('tears down a native run returned after service disposal', async () => {
    const f = fixture(); const starting = deferred<ConversationRun>(); const nativeRun = runFixture();
    vi.mocked(f.adapter.continueConversation).mockReturnValue(starting.promise);
    await f.service.open(ref, loadId);
    const continuing = f.service.continue(ref, { text: 'Go' }, 'renderer');
    await vi.waitFor(() => expect(f.adapter.continueConversation).toHaveBeenCalled());
    let disposed = false;
    const disposing = f.service.dispose().then(() => { disposed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);
    starting.resolve(nativeRun);
    await expect(continuing).rejects.toThrow('Conversation continuation ended');
    await disposing;
    expect(disposed).toBe(true);
    expect(nativeRun.interrupt).toHaveBeenCalledTimes(1);
    expect(nativeRun.dispose).toHaveBeenCalledTimes(1);
  });

  test('does not regress cumulative text when an overlapping buffered update is behind the snapshot', async () => {
    const f = fixture();
    vi.mocked(f.adapter.loadConversation).mockImplementation(async () => {
      f.sinks[0](prose('Hello'));
      return { summary, events: iterable([start(), prose('Hello world')]) };
    });
    await f.service.open(ref, loadId);
    expect(f.events.map((item) => item.type)).toEqual(['history.chunk', 'history.complete']);
    await f.service.dispose();
  });

  test('deduplicates repeated native observations in history', async () => {
    const f = fixture([start(), prose('Text'), finish(), start(), prose('Text'), finish()]);
    await f.service.open(ref, loadId);
    expect(f.events.filter((item) => item.type === 'history.chunk').flatMap((item) => item.turns)).toHaveLength(1);
    await f.service.dispose();
  });

  test('retains unanchored provenance when updating the current or an older turn', async () => {
    const warning = event('warning', { kind: 'unsupported', summary: 'Unknown record', captureCompleteness: 'partial' });
    const f = fixture([warning, start(), prose('Old')]);
    await f.service.open(ref, loadId);
    f.sinks[0](prose('Old plus'));
    expect(f.events.at(-1)).toMatchObject({ type: 'assistant.delta', delta: ' plus' });
    f.sinks[0](start('next'));
    f.sinks[0](prose('Corrected', true));
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', turn: { captureCompleteness: 'partial', blocks: [expect.objectContaining({ kind: 'unsupported' }), expect.objectContaining({ text: 'Corrected' })] } });
    await f.service.dispose();
  });

  test('a forged project cannot close an existing generation', async () => {
    const f = fixture([start()]);
    await f.service.open(ref, loadId);
    await expect(f.service.open({ ...ref, projectPath: '/forged' }, nextLoadId)).rejects.toThrow();
    f.sinks[0](prose('Still watching'));
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', loadId });
    expect(f.unsubscribe).not.toHaveBeenCalled();
    await f.service.dispose();
  });

  test('close returns the open iterator without interrupting native runs', async () => {
    const f = fixture();
    const waiting = deferred<void>();
    const item = deferred<IteratorResult<NativeEvent>>();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    vi.mocked(f.adapter.loadConversation).mockResolvedValue({ summary, events: { [Symbol.asyncIterator]: () => ({ next: () => { waiting.resolve(); return item.promise; }, return: returned }) } });
    const opening = f.service.open(ref, loadId);
    await waiting.promise;
    await f.service.close(ref);
    await Promise.resolve();
    expect(returned).toHaveBeenCalledTimes(1);
    item.resolve({ done: false, value: start() });
    await Promise.allSettled([opening]);
    expect(f.events).toEqual([]);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('preserves notices attached to active turns and inferred completion during replay', async () => {
    const warning = event('warning', { kind: 'unsupported', summary: 'Unknown record', captureCompleteness: 'partial' });
    const f = fixture([start(), warning, prose('Old'), start('next')]);
    await f.service.open(ref, loadId);
    f.sinks[0](prose('Correction', true));
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', turn: { id: 'turn', status: 'completed', captureCompleteness: 'partial', blocks: [expect.objectContaining({ kind: 'unsupported' }), expect.objectContaining({ text: 'Correction' })] } });
    await f.service.dispose();
  });

  test('releases resources even when delivering the failure event throws', async () => {
    const f = fixture([start()]);
    const service = new ConversationService(f.registry, () => { throw new Error('Renderer gone'); });
    await expect(service.open(ref, loadId)).rejects.toThrow();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  test('yields between chunks so cancellation can stop a large history', async () => {
    const f = fixture(Array.from({ length: 205 }, (_, index) => [start(String(index)), finish(String(index))]).flat());
    const emitted: ConversationStreamEvent[] = [];
    const service = new ConversationService(f.registry, (value) => {
      emitted.push(value);
      if (value.type === 'history.chunk') setImmediate(() => { void service.close(ref); });
    });
    await expect(service.open(ref, loadId)).rejects.toThrow();
    expect(emitted.map((item) => item.type)).toEqual(['history.chunk']);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('returns only lightweight summary fields from native load metadata', async () => {
    const f = fixture();
    const nativeSummary = { ...summary, rawTranscript: ['private native record'], fileLocator: '/private/session.jsonl' };
    vi.mocked(f.adapter.loadConversation).mockResolvedValue({ summary: nativeSummary, events: iterable([]) });
    const result = await f.service.open(ref, loadId);
    expect(result).toEqual({ summary, capabilities });
    await f.service.dispose();
  });

  test.each([50, 1])('delivers a finalized history correction before completion with chunk size %i', async (chunkSize) => {
    const f = fixture([start('A'), prose('Old', false, 'A'), finish('A'), prose('Corrected', true, 'A')], chunkSize);
    await f.service.open(ref, loadId);
    const delivered = f.events.flatMap((item) => item.type === 'history.chunk' ? item.turns : item.type === 'turn.upserted' ? [item.turn] : []);
    expect(delivered.at(-1)).toMatchObject({ id: 'A', status: 'completed', blocks: [{ text: 'Corrected' }] });
    expect(f.events.at(-1)?.type).toBe('history.complete');
    expect(f.events.map((item) => item.seq)).toEqual(chunkSize === 1 ? [0, 1, 2] : [0, 1]);
    if (chunkSize === 1) expect(f.events[1].type).toBe('turn.upserted');
    await f.service.dispose();
  });

  test('replaces an already delivered finalized turn when live corrected text extends its prefix', async () => {
    const f = fixture([start('A'), prose('Old', false, 'A'), finish('A')]);
    await f.service.open(ref, loadId);
    f.sinks[0](prose('Old corrected', true, 'A'));
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', turn: { id: 'A', status: 'completed', blocks: [{ text: 'Old corrected' }] } });
    await f.service.dispose();
  });

  test('older-turn replay preserves B as the active turn when C starts', async () => {
    const work = event('work:B', { kind: 'action-requested', turnId: 'B', actionId: 'command:B', actionKind: 'command', label: 'pwd' });
    const f = fixture([start('A'), prose('Old', false, 'A'), finish('A'), start('B'), prose('Working', false, 'B'), work]);
    await f.service.open(ref, loadId);
    const offset = f.events.length;
    f.sinks[0](prose('Corrected', true, 'A'));
    f.sinks[0](start('C'));
    expect(f.events.slice(offset)).toMatchObject([
      { type: 'turn.upserted', turn: { id: 'A', status: 'completed', blocks: [{ text: 'Corrected' }] } },
      { type: 'turn.upserted', turn: { id: 'B', status: 'completed', userMessage: { text: 'Question' }, blocks: [{ text: 'Working' }, { kind: 'work-packet', status: 'completed', actions: [{ id: 'command:B', status: 'completed' }] }] } },
      { type: 'turn.upserted', turn: { id: 'C', status: 'active' } },
    ]);
    expect(f.events.slice(offset).map((item) => item.seq)).toEqual([2, 3, 4]);
    await f.service.dispose();
  });

  test('unanchored notices after an older correction still attach to active B', async () => {
    const f = fixture([start('A'), prose('Old', false, 'A'), finish('A'), start('B')]);
    await f.service.open(ref, loadId);
    f.sinks[0](prose('Corrected', true, 'A'));
    f.sinks[0](event('warning', { kind: 'unsupported', summary: 'Unknown record', captureCompleteness: 'partial' }));
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', turn: { id: 'B', status: 'active', captureCompleteness: 'partial', blocks: [{ kind: 'unsupported' }] } });
    f.sinks[0](start('C'));
    expect(f.events.at(-2)).toMatchObject({ type: 'turn.upserted', turn: { id: 'B', status: 'completed', blocks: [{ kind: 'unsupported' }] } });
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', turn: { id: 'C', blocks: [] } });
    await f.service.dispose();
  });

  test('history correction to A also preserves active B until C finalizes it', async () => {
    const f = fixture([start('A'), prose('Old', false, 'A'), finish('A'), start('B'), prose('Corrected', true, 'A'), start('C')]);
    await f.service.open(ref, loadId);
    const turns = f.events.flatMap((item) => item.type === 'history.chunk' ? item.turns : []);
    expect(turns).toMatchObject([
      { id: 'A', status: 'completed', blocks: [{ text: 'Corrected' }] },
      { id: 'B', status: 'completed' },
      { id: 'C', status: 'active' },
    ]);
    await f.service.dispose();
  });

  test('a same-identity live shortening after bootstrap stays observable', async () => {
    const f = fixture([start(), prose('Draft')]);
    await f.service.open(ref, loadId);
    f.sinks[0](prose('Dra'));
    expect(f.events.at(-1)).toMatchObject({ type: 'turn.upserted', turn: { blocks: [{ text: 'Dra' }] } });
    await f.service.dispose();
  });

  test('allows only attachment paths recorded on the open conversation', async () => {
    const f = fixture([
      event('start:a', { kind: 'turn-started', turnId: 'a', userMessageId: 'user:a', text: 'Look\n\n<attachments>\n/repo/notes.md\n</attachments>', attachments: [{ path: '/tmp/shot.png', kind: 'image' }] }),
      finish('a'),
    ]);
    expect(f.service.attachmentAllowed(ref, '/repo/notes.md')).toBe(false);
    await f.service.open(ref, loadId);
    expect(f.service.attachmentAllowed(ref, '/repo/notes.md')).toBe(true);
    expect(f.service.attachmentAllowed(ref, '/tmp/shot.png')).toBe(true);
    expect(f.service.attachmentAllowed(ref, '/etc/passwd')).toBe(false);
    expect(f.service.attachmentAllowed({ ...ref, projectPath: '/other' }, '/repo/notes.md')).toBe(false);
    await f.service.close(ref);
    expect(f.service.attachmentAllowed(ref, '/repo/notes.md')).toBe(false);
    await f.service.dispose();
  });
});
