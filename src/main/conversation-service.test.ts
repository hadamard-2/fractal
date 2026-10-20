import { describe, expect, test, vi } from 'vitest';
import type { BranchRecord } from '@/main/branch-store';
import { FORK_NOTE, SIDE_CHAT_NOTE } from '@/main/branch-notes';
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

describe('ConversationService.knowsProject', () => {
  test('discovers again before saying a project is unknown', async () => {
    const f = fixture();
    expect(await f.service.knowsProject('/repo')).toBe(true);
    expect(await f.service.knowsProject('/elsewhere')).toBe(false);
    await f.service.dispose();
  });

  test('knows the project of an unsent Claude draft', async () => {
    const f = fixture([], 50, 'claude');
    const draft = { provider: 'claude' as const, nativeSessionId: '00000000-0000-4000-8000-000000000097', projectPath: '/new' };
    vi.mocked(f.adapter.listConversations).mockResolvedValue([]);
    vi.mocked(f.adapter.createConversation).mockResolvedValue(draft);
    await f.service.create('claude', '/new');
    expect(await f.service.knowsProject('/new')).toBe(true);
    await f.service.dispose();
  });
});

describe('ConversationService branches', () => {
  const forkedRef = { ...ref, nativeSessionId: 'forked' };
  const forkCapabilities: HarnessCapabilities = { ...capabilities, fork: true };
  function branchFixture(history: NativeEvent[] = [start('t1'), finish('t1'), start('t2'), finish('t2')]) {
    const extra: ConversationSummary[] = [];
    const deleteConversation = vi.fn<NonNullable<HarnessAdapter['deleteConversation']>>(async () => undefined);
    const source: ConversationSummary = { ...summary, title: 'Chat' };
    const forked: ConversationSummary = { ...summary, ref: forkedRef, title: 'Chat (fork)', updatedAt: 0 };
    const adapter: HarnessAdapter = {
      provider: 'codex', capabilities: () => forkCapabilities,
      probe: vi.fn(async () => ({ provider: 'codex' as const, availability: 'available' as const, capabilities: forkCapabilities })),
      listConversations: vi.fn(async () => [source, forked, ...extra]),
      loadConversation: vi.fn(async (loaded) => ({ summary: [forked, ...extra].find((item) => item.ref.nativeSessionId === loaded.nativeSessionId) ?? source, events: iterable(history) })),
      watchConversation: vi.fn(async () => vi.fn()),
      createConversation: vi.fn(async () => forkedRef), continueConversation: vi.fn(async () => runFixture()),
      forkConversation: vi.fn(async () => forkedRef),
      deleteConversation,
    };
    const records = new Map<string, BranchRecord>();
    const branches = {
      get: (key: string) => records.get(key), set: (key: string, record: BranchRecord) => { records.set(key, record); },
      delete: (key: string) => { records.delete(key); },
      sideChatKeys: () => new Set([...records].filter(([, record]) => record.kind === 'side-chat').map(([key]) => key)),
      descendants: (root: string) => {
        const found: Array<[string, BranchRecord]> = [];
        const queue = [root];
        for (const key of queue) {
          for (const entry of [...records].filter(([, record]) => record.parentKey === key).sort((a, b) => a[1].createdAt - b[1].createdAt)) { found.push(entry); queue.push(entry[0]); }
        }
        return found;
      },
    };
    const events: ConversationStreamEvent[] = [];
    const registry = new ConversationRegistry([adapter], async (path) => path);
    const service = new ConversationService(registry, (value) => { events.push(parseConversationStreamEvent(value)); }, { branches });
    return { adapter, service, records, events, branches, extra, deleteConversation };
  }
  const record = (kind: 'side-chat' | 'fork', note?: string): BranchRecord => ({ kind, parentKey: 'codex:session', afterTurnId: 't1', inheritedTurnCount: 1, ...(note ? { note } : {}), createdAt: 1 });

  test('forks a side chat after a reply, read-only and with the side chat note, and records it', async () => {
    const f = branchFixture();
    await f.service.open(ref, loadId);
    await expect(f.service.fork(ref, { turnId: 't1', position: 'after' }, 'side-chat')).resolves.toEqual(forkedRef);
    expect(f.adapter.forkConversation).toHaveBeenCalledWith(ref, 't1', { readOnly: true, note: SIDE_CHAT_NOTE, title: 'Chat (side chat)' });
    expect(f.records.get('codex:forked')).toMatchObject({ kind: 'side-chat', parentKey: 'codex:session', afterTurnId: 't1', inheritedTurnCount: 1, note: SIDE_CHAT_NOTE });
    expect(f.service.branchKind(forkedRef)).toBe('side-chat');
    expect(f.service.branchKind(ref)).toBeUndefined();
    await f.service.dispose();
  });

  test('forks after the latest turn without a note', async () => {
    const f = branchFixture();
    await f.service.open(ref, loadId);
    await f.service.fork(ref, { turnId: 't2', position: 'after' }, 'fork');
    expect(f.adapter.forkConversation).toHaveBeenCalledWith(ref, 't2', { readOnly: false, title: 'Chat (fork)' });
    expect(f.records.get('codex:forked')).toMatchObject({ kind: 'fork', afterTurnId: 't2', inheritedTurnCount: 2 });
    expect(f.records.get('codex:forked')).not.toHaveProperty('note');
    await f.service.dispose();
  });

  test('forks before a turn from the turn that precedes it in history order, with the fork note', async () => {
    const f = branchFixture();
    await f.service.open(ref, loadId);
    await f.service.fork(ref, { turnId: 't2', position: 'before' }, 'fork');
    expect(f.adapter.forkConversation).toHaveBeenCalledWith(ref, 't1', { readOnly: false, note: FORK_NOTE, title: 'Chat (fork)' });
    expect(f.records.get('codex:forked')).toMatchObject({ afterTurnId: 't1', inheritedTurnCount: 1, note: FORK_NOTE });
    await f.service.dispose();
  });

  test('keeps history order when an earlier turn is corrected after later ones', async () => {
    const sinks: NativeEventSink[] = [];
    const f = branchFixture([start('t1'), prose('Draft', false, 't1'), finish('t1'), start('t2'), finish('t2')]);
    vi.mocked(f.adapter.watchConversation).mockImplementation(async (_ref, sink) => { sinks.push(sink); return vi.fn(); });
    await f.service.open(ref, loadId);
    sinks[0](prose('Corrected', true, 't1'));
    await f.service.fork(ref, { turnId: 't2', position: 'before' }, 'fork');
    expect(f.adapter.forkConversation).toHaveBeenCalledWith(ref, 't1', expect.anything());
    await f.service.dispose();
  });

  test('forks before the first turn into a new empty conversation', async () => {
    const f = branchFixture();
    await f.service.open(ref, loadId);
    await f.service.fork(ref, { turnId: 't1', position: 'before' }, 'fork');
    expect(f.adapter.forkConversation).not.toHaveBeenCalled();
    expect(f.adapter.createConversation).toHaveBeenCalledWith('/repo');
    expect(f.records.get('codex:forked')).toMatchObject({ kind: 'fork', afterTurnId: null, inheritedTurnCount: 0 });
    await f.service.dispose();
  });

  test('does not fork a conversation that is still loading', async () => {
    const f = branchFixture();
    const gate = deferred<void>();
    const loading = vi.mocked(f.adapter.loadConversation);
    const loadHistory = loading.getMockImplementation();
    loading.mockImplementation(async (loaded) => { await gate.promise; return loadHistory?.(loaded) ?? Promise.reject(new Error('no history')); });
    const opening = f.service.open(ref, loadId);
    await expect(f.service.fork(ref, { turnId: 't1', position: 'after' }, 'fork')).rejects.toThrow('Conversation is not open');
    expect(f.adapter.forkConversation).not.toHaveBeenCalled();
    gate.resolve();
    await opening;
    await expect(f.service.fork(ref, { turnId: 't1', position: 'after' }, 'fork')).resolves.toEqual(forkedRef);
    await f.service.dispose();
  });

  test('rejects forks that cannot be made', async () => {
    const f = branchFixture([start('t1'), finish('t1'), start('t2')]);
    await expect(f.service.fork(ref, { turnId: 't1', position: 'after' }, 'fork')).rejects.toThrow('Conversation is not open');
    await f.service.open(ref, loadId);
    await expect(f.service.fork(ref, { turnId: 'missing', position: 'after' }, 'fork')).rejects.toThrow('Fork point is not in this conversation');
    await expect(f.service.fork(ref, { turnId: 't1', position: 'before' }, 'side-chat')).rejects.toThrow('Side chats branch after a reply');
    vi.mocked(f.adapter.listConversations).mockResolvedValue([{ ...summary, parentId: 'parent' }]);
    await expect(f.service.fork(ref, { turnId: 't1', position: 'after' }, 'fork')).rejects.toThrow('Subagent conversations are read-only');
    expect(f.adapter.forkConversation).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
    await f.service.dispose();
  });

  test.each(['active-in-fractal', 'active-externally', 'waiting-for-user'] as const)('refuses to fork from an unfinished turn while the conversation is %s', async (runtime) => {
    const f = branchFixture([start('t1'), finish('t1'), start('t2')]);
    vi.mocked(f.adapter.listConversations).mockResolvedValue([{ ...summary, runtime }]);
    await f.service.open(ref, loadId);
    await expect(f.service.fork(ref, { turnId: 't2', position: 'after' }, 'side-chat')).rejects.toThrow('Cannot fork from a turn in progress');
    await expect(f.service.fork(ref, { turnId: 't1', position: 'after' }, 'side-chat')).resolves.toEqual(forkedRef);
    expect(f.adapter.forkConversation).toHaveBeenCalledTimes(1);
    await f.service.dispose();
  });

  test('forks from an unfinished turn when the conversation is idle, as a history that never recorded its end leaves it', async () => {
    const f = branchFixture([start('t1'), finish('t1'), start('t2')]);
    await f.service.open(ref, loadId);
    await expect(f.service.fork(ref, { turnId: 't2', position: 'after' }, 'side-chat')).resolves.toEqual(forkedRef);
    expect(f.adapter.forkConversation).toHaveBeenCalledWith(ref, 't2', expect.anything());
    await f.service.dispose();
  });

  test('refuses to fork from an unfinished turn while Fractal is running the conversation, even if the agent says idle', async () => {
    const f = branchFixture([start('t1'), finish('t1'), start('t2')]);
    await f.service.open(ref, loadId);
    const gate = deferred<ConversationRun>();
    vi.mocked(f.adapter.continueConversation).mockReturnValue(gate.promise);
    const starting = f.service.continue(ref, { text: 'Go' }, 'renderer');
    await vi.waitFor(() => expect(f.adapter.continueConversation).toHaveBeenCalled());
    await expect(f.service.fork(ref, { turnId: 't2', position: 'after' }, 'side-chat')).rejects.toThrow('Cannot fork from a turn in progress');
    const run = runFixture();
    const end = deferred<IteratorResult<NativeEvent>>();
    run.events[Symbol.asyncIterator].mockReturnValue({ next: () => end.promise });
    gate.resolve(run);
    await starting;
    await expect(f.service.fork(ref, { turnId: 't2', position: 'after' }, 'side-chat')).rejects.toThrow('Cannot fork from a turn in progress');
    expect(f.adapter.forkConversation).not.toHaveBeenCalled();
    end.resolve({ done: true, value: undefined });
    await f.service.dispose();
  });

  test('sends every side chat turn read-only with its note and without the access choice', async () => {
    const f = branchFixture();
    f.records.set('codex:forked', record('side-chat', SIDE_CHAT_NOTE));
    await f.service.open(forkedRef, loadId);
    const access = { state: { kind: 'level' as const, level: 'full-access' }, picked: true };
    await f.service.continue(forkedRef, { text: 'Go', model: 'm', access }, 'renderer');
    expect(f.adapter.continueConversation).toHaveBeenCalledWith(forkedRef, { text: 'Go', model: 'm', branch: { readOnly: true, note: SIDE_CHAT_NOTE } });
    expect(vi.mocked(f.adapter.continueConversation).mock.calls[0][1]).not.toHaveProperty('access');
    await f.service.dispose();
  });

  test('sends a fork its note and keeps the access choice; a plain conversation sends no branch', async () => {
    const f = branchFixture();
    f.records.set('codex:forked', record('fork', FORK_NOTE));
    const access = { state: { kind: 'level' as const, level: 'plan' }, picked: true };
    await f.service.open(forkedRef, loadId);
    await f.service.continue(forkedRef, { text: 'Go', access }, 'renderer');
    expect(f.adapter.continueConversation).toHaveBeenLastCalledWith(forkedRef, { text: 'Go', access, branch: { readOnly: false, note: FORK_NOTE } });
    await f.service.open(ref, nextLoadId);
    await f.service.continue(ref, { text: 'Plain' }, 'renderer');
    expect(f.adapter.continueConversation).toHaveBeenLastCalledWith(ref, { text: 'Plain' });
    expect(vi.mocked(f.adapter.continueConversation).mock.calls[1][1]).not.toHaveProperty('branch');
    await f.service.dispose();
  });

  test('leaves side chats out of the list and keeps forks', async () => {
    const f = branchFixture();
    expect((await f.service.list()).projects[0].conversations.map((item) => item.ref.nativeSessionId)).toEqual(['session', 'forked']);
    f.records.set('codex:forked', record('fork'));
    expect((await f.service.list()).projects[0].conversations.map((item) => item.ref.nativeSessionId)).toEqual(['session', 'forked']);
    f.records.set('codex:forked', record('side-chat'));
    expect((await f.service.list()).projects[0].conversations.map((item) => item.ref.nativeSessionId)).toEqual(['session']);
  });

  describe('side chats', () => {
    const at = (id: string) => ({ ...ref, nativeSessionId: id });
    const entry = (kind: 'side-chat' | 'fork', parent: string, createdAt: number, more: Partial<BranchRecord> = {}): BranchRecord => ({ kind, parentKey: `codex:${parent}`, afterTurnId: 't1', inheritedTurnCount: 1, createdAt, ...more });
    // session -> sc1 -> sc2 -> sc3, with a fork of sc2 that has a side chat of its own.
    function tree() {
      const f = branchFixture();
      f.records.set('codex:sc1', entry('side-chat', 'session', 1, { branchPointText: 'Branch point' }));
      f.records.set('codex:sc2', entry('side-chat', 'sc1', 2));
      f.records.set('codex:sc3', entry('side-chat', 'sc2', 3));
      f.records.set('codex:fk', entry('fork', 'sc2', 4));
      f.records.set('codex:fk-sc', entry('side-chat', 'fk', 5));
      for (const id of ['sc1', 'sc2', 'sc3', 'fk', 'fk-sc']) f.extra.push({ ...summary, ref: at(id), title: id });
      return f;
    }

    test('lists the side chats reachable through side chats, parents first, and leaves out a fork and what is below it', () => {
      const f = tree();
      const listed = f.service.sideChats(ref);
      expect(listed).toEqual([
        { ref: at('sc1'), parentKey: 'codex:session', afterTurnId: 't1', inheritedTurnCount: 1, branchPointText: 'Branch point', createdAt: 1 },
        { ref: at('sc2'), parentKey: 'codex:sc1', afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 2 },
        { ref: at('sc3'), parentKey: 'codex:sc2', afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 3 },
      ]);
      expect(listed[1]).not.toHaveProperty('branchPointText');
      expect(f.service.sideChats(at('fk')).map((item) => item.ref.nativeSessionId)).toEqual(['fk-sc']);
    });

    test('leaves out a side chat that has no branch point', () => {
      const f = tree();
      f.records.set('codex:sc3', entry('side-chat', 'sc2', 3, { afterTurnId: null }));
      expect(f.service.sideChats(ref).map((item) => item.ref.nativeSessionId)).toEqual(['sc1', 'sc2']);
    });

    test('lists nothing when no branch store is wired', () => {
      const f = fixture();
      expect(f.service.sideChats(ref)).toEqual([]);
    });

    test('records the start of the reply a side chat is cut after, at most 500 characters, and none for a fork', async () => {
      const long = 'x'.repeat(600);
      const f = branchFixture([start('t1'), prose('First part', false, 't1'), event('prose2:t1', { kind: 'assistant-text', turnId: 't1', blockId: 'block2:t1', text: long, final: true }), finish('t1'), start('t2'), finish('t2')]);
      await f.service.open(ref, loadId);
      await f.service.fork(ref, { turnId: 't1', position: 'after' }, 'side-chat');
      const stored = f.records.get('codex:forked')?.branchPointText;
      expect(stored).toBe(`First part\n\n${long}`.slice(0, 500));
      expect(stored).toHaveLength(500);
      f.records.clear();
      await f.service.fork(ref, { turnId: 't1', position: 'after' }, 'fork');
      expect(f.records.get('codex:forked')).not.toHaveProperty('branchPointText');
      await f.service.dispose();
    });

    test('records no branch point text for a reply without prose', async () => {
      const f = branchFixture();
      await f.service.open(ref, loadId);
      await f.service.fork(ref, { turnId: 't1', position: 'after' }, 'side-chat');
      expect(f.records.get('codex:forked')).not.toHaveProperty('branchPointText');
      await f.service.dispose();
    });

    test('rolls the native fork back when the record cannot be stored, and rethrows', async () => {
      const f = branchFixture();
      await f.service.open(ref, loadId);
      f.branches.set = () => { throw new Error('disk full'); };
      await expect(f.service.fork(ref, { turnId: 't1', position: 'after' }, 'side-chat')).rejects.toThrow('disk full');
      expect(f.deleteConversation).toHaveBeenCalledWith(forkedRef);
      f.deleteConversation.mockRejectedValue(new Error('cannot delete'));
      await expect(f.service.fork(ref, { turnId: 't1', position: 'after' }, 'side-chat')).rejects.toThrow('disk full');
      await f.service.dispose();
    });

    test('deletes a side chat and the side chats below it, deepest first, native sessions before records, and keeps the fork', async () => {
      const f = tree();
      const order: string[] = [];
      f.deleteConversation.mockImplementation(async (deleted) => { order.push(`native:${deleted.nativeSessionId}`); expect(f.records.has(`codex:${deleted.nativeSessionId}`)).toBe(true); });
      f.branches.delete = (key: string) => { order.push(`record:${key}`); f.records.delete(key); };
      await expect(f.service.deleteSideChat(at('sc1'))).resolves.toEqual([at('sc3'), at('sc2'), at('sc1')]);
      expect(order).toEqual(['native:sc3', 'record:codex:sc3', 'native:sc2', 'record:codex:sc2', 'native:sc1', 'record:codex:sc1']);
      expect([...f.records.keys()]).toEqual(['codex:fk', 'codex:fk-sc']);
      await f.service.dispose();
    });

    test('releases the open load of a deleted side chat', async () => {
      const f = tree();
      await f.service.open(at('sc2'), loadId);
      f.events.length = 0;
      await f.service.deleteSideChat(at('sc1'));
      await expect(f.service.continue(at('sc2'), { text: 'Go' }, 'renderer')).rejects.toThrow('Conversation is not open');
      await f.service.dispose();
    });

    test('only deletes side chats', async () => {
      const f = tree();
      await expect(f.service.deleteSideChat(ref)).rejects.toThrow('Only side chats can be deleted');
      await expect(f.service.deleteSideChat(at('fk'))).rejects.toThrow('Only side chats can be deleted');
      expect(f.deleteConversation).not.toHaveBeenCalled();
    });

    test('deletes nothing while any side chat in the subtree is busy', async () => {
      const f = tree();
      const busy = (runtime: ConversationSummary['runtime']) => { f.extra.splice(0, f.extra.length, ...f.extra.map((item) => item.ref.nativeSessionId === 'sc3' ? { ...item, runtime } : item)); };
      for (const runtime of ['active-in-fractal', 'active-externally', 'waiting-for-user'] as const) {
        busy(runtime);
        await expect(f.service.deleteSideChat(at('sc1'))).rejects.toThrow('Side chat is busy');
      }
      busy('idle');
      // A run Fractal owns, or is starting, counts even though the agent's own listing says idle.
      await f.service.open(at('sc3'), loadId);
      const gate = deferred<ConversationRun>();
      vi.mocked(f.adapter.continueConversation).mockReturnValue(gate.promise);
      const starting = f.service.continue(at('sc3'), { text: 'Go' }, 'renderer');
      await vi.waitFor(() => expect(f.adapter.continueConversation).toHaveBeenCalled());
      await expect(f.service.deleteSideChat(at('sc1'))).rejects.toThrow('Side chat is busy');
      const run = runFixture();
      const end = deferred<IteratorResult<NativeEvent>>();
      run.events[Symbol.asyncIterator].mockReturnValue({ next: () => end.promise });
      gate.resolve(run);
      await starting;
      await expect(f.service.deleteSideChat(at('sc1'))).rejects.toThrow('Side chat is busy');
      expect(f.deleteConversation).not.toHaveBeenCalled();
      expect(f.records.size).toBe(5);
      end.resolve({ done: true, value: undefined });
      await f.service.dispose();
    });

    test('a busy fork below the side chat does not block the deletion', async () => {
      const f = tree();
      f.extra.splice(0, f.extra.length, ...f.extra.map((item) => item.ref.nativeSessionId === 'fk' ? { ...item, runtime: 'active-in-fractal' as const } : item));
      await expect(f.service.deleteSideChat(at('sc1'))).resolves.toHaveLength(3);
      await f.service.dispose();
    });

    test('stops at a native delete that fails, keeping its record and those above it', async () => {
      const f = tree();
      f.deleteConversation.mockImplementation(async (deleted) => { if (deleted.nativeSessionId === 'sc2') throw new Error('refused'); });
      await expect(f.service.deleteSideChat(at('sc1'))).rejects.toThrow('refused');
      expect([...f.records.keys()]).toEqual(['codex:sc1', 'codex:sc2', 'codex:fk', 'codex:fk-sc']);
      expect(f.deleteConversation).toHaveBeenCalledTimes(2);
      await f.service.dispose();
    });

    test('refuses runs, forks and another deletion on the side chats it is deleting until it finishes', async () => {
      const f = tree();
      await f.service.open(at('sc1'), loadId);
      const gate = deferred<void>();
      f.deleteConversation.mockImplementation(async (deleted) => { if (deleted.nativeSessionId === 'sc3') await gate.promise; });
      const deleting = f.service.deleteSideChat(at('sc1'));
      await vi.waitFor(() => expect(f.deleteConversation).toHaveBeenCalledWith(at('sc3')));
      await expect(f.service.continue(at('sc1'), { text: 'Go' }, 'renderer')).rejects.toThrow('Conversation is not idle');
      await expect(f.service.fork(at('sc1'), { turnId: 't1', position: 'after' }, 'side-chat')).rejects.toThrow('Conversation is not idle');
      await expect(f.service.deleteSideChat(at('sc1'))).rejects.toThrow('Side chat is busy');
      await expect(f.service.deleteSideChat(at('sc2'))).rejects.toThrow('Side chat is busy');
      expect(f.adapter.continueConversation).not.toHaveBeenCalled();
      expect(f.adapter.forkConversation).not.toHaveBeenCalled();
      expect(f.deleteConversation).toHaveBeenCalledTimes(1);
      gate.resolve();
      await expect(deleting).resolves.toEqual([at('sc3'), at('sc2'), at('sc1')]);
      // A new side chat under a key the deletion held is not refused once it has finished.
      f.records.set('codex:sc1', entry('side-chat', 'session', 6));
      await f.service.open(at('sc1'), nextLoadId);
      await f.service.continue(at('sc1'), { text: 'Go' }, 'renderer');
      expect(f.adapter.continueConversation).toHaveBeenCalledTimes(1);
      await f.service.dispose();
    });

    test('refuses a run whose status check was still pending when the deletion started', async () => {
      const f = tree();
      await f.service.open(at('sc1'), loadId);
      const listing = deferred<ConversationSummary[]>();
      vi.mocked(f.adapter.listConversations).mockReturnValueOnce(listing.promise);
      const continuing = f.service.continue(at('sc1'), { text: 'Go' }, 'renderer');
      await vi.waitFor(() => expect(f.adapter.listConversations).toHaveBeenCalledTimes(2));
      const deleting = f.service.deleteSideChat(at('sc1'));
      listing.resolve([{ ...summary, title: 'Chat' }, ...f.extra]);
      await expect(continuing).rejects.toThrow('Conversation is not idle');
      await expect(deleting).resolves.toHaveLength(3);
      expect(f.adapter.continueConversation).not.toHaveBeenCalled();
      await f.service.dispose();
    });

    test('lets the side chats of a deletion that failed run again', async () => {
      const f = tree();
      await f.service.open(at('sc1'), loadId);
      f.deleteConversation.mockRejectedValue(new Error('refused'));
      await expect(f.service.deleteSideChat(at('sc1'))).rejects.toThrow('refused');
      await f.service.continue(at('sc1'), { text: 'Go' }, 'renderer');
      expect(f.adapter.continueConversation).toHaveBeenCalledTimes(1);
      await f.service.dispose();
    });

    test('deletes nothing when a side chat is named under a project it is not listed in', async () => {
      const f = tree();
      await expect(f.service.deleteSideChat({ ...at('sc1'), projectPath: '/other' })).rejects.toThrow('Conversation is not currently available in this project');
      expect(f.deleteConversation).not.toHaveBeenCalled();
      expect(f.records.size).toBe(5);
    });

    test('deletes nothing when the agent cannot list its conversations', async () => {
      const f = tree();
      vi.mocked(f.adapter.listConversations).mockRejectedValue(new Error('offline'));
      await expect(f.service.deleteSideChat(at('sc1'))).rejects.toThrow('Conversation provider is not available');
      expect(f.deleteConversation).not.toHaveBeenCalled();
      expect(f.records.size).toBe(5);
    });

    test('removes only the record of a side chat the agent no longer has, and still reports it deleted', async () => {
      const f = tree();
      f.extra.splice(0, f.extra.length, ...f.extra.filter((item) => item.ref.nativeSessionId !== 'sc2'));
      await expect(f.service.deleteSideChat(at('sc1'))).resolves.toEqual([at('sc3'), at('sc2'), at('sc1')]);
      expect(f.deleteConversation.mock.calls.map(([deleted]) => deleted.nativeSessionId)).toEqual(['sc3', 'sc1']);
      expect([...f.records.keys()]).toEqual(['codex:fk', 'codex:fk-sc']);
      await f.service.dispose();
    });

    test('deletes natively a side chat the listing lacks but the agent still has, then its record', async () => {
      const f = tree();
      const unlisted = f.extra.find((item) => item.ref.nativeSessionId === 'sc2');
      f.extra.splice(0, f.extra.length, ...f.extra.filter((item) => item !== unlisted));
      f.adapter.readSummary = vi.fn(async (read) => read.nativeSessionId === 'sc2' ? unlisted ?? null : null);
      const order: string[] = [];
      f.deleteConversation.mockImplementation(async (deleted) => { order.push(`native:${deleted.nativeSessionId}`); });
      f.branches.delete = (key: string) => { order.push(`record:${key}`); f.records.delete(key); };
      await expect(f.service.deleteSideChat(at('sc1'))).resolves.toEqual([at('sc3'), at('sc2'), at('sc1')]);
      expect(f.adapter.readSummary).toHaveBeenCalledWith(at('sc2'));
      expect(order).toEqual(['native:sc3', 'record:codex:sc3', 'native:sc2', 'record:codex:sc2', 'native:sc1', 'record:codex:sc1']);
      await f.service.dispose();
    });

    test('removes only the record of an unlisted side chat the agent confirms is gone', async () => {
      const f = tree();
      f.extra.splice(0, f.extra.length, ...f.extra.filter((item) => item.ref.nativeSessionId !== 'sc2'));
      f.adapter.readSummary = vi.fn(async () => null);
      await expect(f.service.deleteSideChat(at('sc1'))).resolves.toEqual([at('sc3'), at('sc2'), at('sc1')]);
      expect(f.deleteConversation.mock.calls.map(([deleted]) => deleted.nativeSessionId)).toEqual(['sc3', 'sc1']);
      expect([...f.records.keys()]).toEqual(['codex:fk', 'codex:fk-sc']);
      await f.service.dispose();
    });

    test('is not available without a branch store', async () => {
      const f = fixture();
      await expect(f.service.deleteSideChat(ref)).rejects.toThrow('Side chat deletion is not available');
    });
  });
});
