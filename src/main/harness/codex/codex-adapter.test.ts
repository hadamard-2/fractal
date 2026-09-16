import { describe, expect, test, vi } from 'vitest';
import { CodexAdapter } from '@/main/harness/codex/codex-adapter';
import threadRead from '@/main/harness/codex/__fixtures__/thread-read.json';

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function thread(id: string, cwd = '/work/fractal') {
  const value = clone(threadRead.thread);
  value.id = id;
  value.cwd = cwd;
  value.name = id === 'newer' ? 'Newest native name' : null;
  value.preview = id === 'older' ? 'Older preview title' : value.preview;
  value.updatedAt = id === 'newer' ? 1768000030 : 1768000020;
  return value;
}

function createFakeAppServer(pages = [[thread('newer')], [thread('older')]], repeatCursor = false) {
  const listeners = new Set<(notification: unknown) => void>();
  const requestListeners = new Set<(request: unknown) => void>();
  const statusListeners = new Set<(status: { availability: 'available' | 'unavailable'; message?: string }) => void>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const responses: Array<{ id: string | number; result: unknown }> = [];
  let duringTurnStart: (() => void) | undefined;
  return {
    status: { availability: 'available' as const }, requests, responses,
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'thread/list') {
        const index = params.cursor === 'next' ? 1 : 0;
        if (repeatCursor && requests.length > 3) throw new Error('pagination did not terminate');
        return { data: pages[index] ?? [], nextCursor: index === 0 || repeatCursor ? 'next' : null };
      }
      if (method === 'thread/read') return { thread: threadRead.thread };
      if (method === 'thread/start') return { thread: { ...threadRead.thread, id: 'created-thread', cwd: params.cwd } };
      if (method === 'thread/resume') return { thread: threadRead.thread };
      if (method === 'turn/start') { duringTurnStart?.(); return { turn: { ...threadRead.thread.turns[0], id: 'turn-live', status: 'inProgress' } }; }
      if (method === 'turn/interrupt') return {};
      throw new Error(`unexpected ${method}`);
    }),
    onNotification: vi.fn((listener: (notification: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(notification: unknown) { listeners.forEach((listener) => listener(notification)); },
    listenerCount() { return listeners.size; },
    onServerRequest: vi.fn((listener: (request: unknown) => void) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    }),
    requestListenerCount() { return requestListeners.size; },
    emitRequest(request: unknown) { requestListeners.forEach((listener) => listener(request)); },
    respond(id: string | number, result: unknown) { responses.push({ id, result }); },
    respondError: vi.fn(),
    onStatus(listener: (status: { availability: 'available' | 'unavailable'; message?: string }) => void) {
      statusListeners.add(listener); return () => statusListeners.delete(listener);
    },
    emitStatus(status: { availability: 'available' | 'unavailable'; message?: string }) {
      Object.assign(this.status, status); statusListeners.forEach((listener) => listener(status));
    },
    duringTurnStart(callback: () => void) { duringTurnStart = callback; },
  };
}

describe('Codex read adapter', () => {
  test('paginates active threads in native order and maps stable summary fields', async () => {
    const server = createFakeAppServer();
    const summaries = await new CodexAdapter(server as never).listConversations();

    expect(server.requests.map((request) => request.method)).toEqual(['thread/list', 'thread/list']);
    expect(server.requests[0]?.params).toEqual({ archived: false, sortKey: 'updated_at', sortDirection: 'desc', limit: 100 });
    expect(server.requests[1]?.params).toEqual({ archived: false, sortKey: 'updated_at', sortDirection: 'desc', limit: 100, cursor: 'next' });
    expect(summaries.map((summary) => summary.ref.nativeSessionId)).toEqual(['newer', 'older']);
    expect(summaries.map((summary) => summary.title)).toEqual(['Newest native name', 'Older preview title']);
    expect(summaries[0]).toMatchObject({ runtime: 'idle', createdAt: 1768000000000, updatedAt: 1768000030000, captureCompleteness: 'unknown' });
  });

  test('stops a repeated cursor and deduplicates overlapping native pages', async () => {
    const server = createFakeAppServer([[thread('newer'), thread('older')], [thread('older')]], true);
    const summaries = await new CodexAdapter(server as never, { realpath: async (value) => value }).listConversations();

    expect(summaries.map((summary) => summary.ref.nativeSessionId)).toEqual(['newer', 'older']);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.params).toMatchObject({ cursor: 'next' });
  });

  test.each([
    { label: 'malformed items', items: [null, 3, false, 'broken', ...threadRead.thread.turns[0].items], title: 'Trace the history adapter' },
    { label: 'malformed content entries', items: [{ type: 'userMessage', id: 'user-1', content: [null, 3, false, 'broken', { type: 'text', text: {} }, { type: 'text', text: 'Recovered title' }] }], title: 'Recovered title' },
    { label: 'no usable content', items: [{ type: 'userMessage', id: 'user-1', content: [null, 3, { type: 'text', text: {} }] }], title: 'Codex conversation' },
  ])('loads a partial conversation with $label without aborting title derivation', async ({ items, title }) => {
    const server = createFakeAppServer();
    const snapshot = clone(threadRead.thread);
    snapshot.name = null;
    snapshot.preview = '';
    snapshot.turns = [{ ...snapshot.turns[0], items: items as never }];
    server.request.mockResolvedValue({ thread: snapshot });

    const loaded = await new CodexAdapter(server as never).loadConversation({ provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' });
    const events = [];
    for await (const event of loaded.events) events.push(event);
    expect(loaded.summary).toMatchObject({ title, captureCompleteness: 'partial' });
    expect(events.some((event) => event.payload.kind === 'unsupported')).toBe(true);
  });

  test('only loads a discovered Codex thread with matching provider ID and canonical project path', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never);
    await expect(adapter.loadConversation({ provider: 'claude', nativeSessionId: 'thread-1', projectPath: '/work/fractal' })).rejects.toThrow('provider');
    await expect(adapter.loadConversation({ provider: 'codex', nativeSessionId: 'other', projectPath: '/work/fractal' })).rejects.toThrow('thread');
    await expect(adapter.loadConversation({ provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/other' })).rejects.toThrow('project');
  });

  test('uses injected realpath consistently for summary and symlinked references', async () => {
    const server = createFakeAppServer([[thread('thread-1', '/links/fractal')], []]);
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value === '/links/fractal' ? '/work/fractal' : value });
    const [summary] = await adapter.listConversations();

    expect(summary?.ref.projectPath).toBe('/work/fractal');
    await expect(adapter.loadConversation({ provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/links/fractal' })).resolves.toBeDefined();
  });

  test('maps native active, waiting, error, and fallback titles into summaries', async () => {
    const waiting = thread('waiting');
    waiting.name = null;
    waiting.preview = '';
    waiting.status = { type: 'active', activeFlags: ['waitingOnUserInput'] } as never;
    const failed = thread('failed');
    failed.status = { type: 'systemError' };
    const active = thread('active');
    active.status = { type: 'active', activeFlags: [] } as never;
    const summaries = await new CodexAdapter(createFakeAppServer([[waiting, failed, active], []]) as never).listConversations();

    expect(summaries.map((summary) => [summary.ref.nativeSessionId, summary.runtime])).toEqual([
      ['waiting', 'waiting-for-user'], ['failed', 'failed'], ['active', 'active-externally'],
    ]);
    expect(summaries[0]?.title).toBe('Trace the history adapter');
  });

  test('filters live notifications by thread, reconciles history duplicates, and removes only its subscription', async () => {
    const server = createFakeAppServer();
    const sink = vi.fn();
    const unsubscribe = await new CodexAdapter(server as never).watchConversation({ provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' }, sink);

    expect(server.listenerCount()).toBe(1);
    expect(sink).toHaveBeenCalled();
    sink.mockClear();
    server.emit({ method: 'item/completed', params: { threadId: 'other', turnId: 'turn-1', completedAtMs: 1, item: { type: 'agentMessage', id: 'message-1', text: 'wrong', phase: null, memoryCitation: null, delivery: null } } });
    server.emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1, item: { type: 'agentMessage', id: 'message-1', text: 'I will inspect it.', phase: null, memoryCitation: null, delivery: null } } });
    expect(sink).not.toHaveBeenCalled();
    server.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-live', delta: 'live' } });
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ nativeId: 'message-live', payload: expect.objectContaining({ final: false }) }));
    unsubscribe();
    expect(server.listenerCount()).toBe(0);
  });

  test.each([
    { label: 'uncovered assistant chunk', method: 'item/agentMessage/delta', itemId: 'message-1', snapshotText: 'Hello', chunks: [' world'], expected: 'Hello world!' },
    { label: 'covered assistant chunk', method: 'item/agentMessage/delta', itemId: 'message-1', snapshotText: 'Hello world', chunks: [' world'], expected: 'Hello world!' },
    { label: 'covered assistant sequence', method: 'item/agentMessage/delta', itemId: 'message-1', snapshotText: 'Hello world', chunks: [' wor', 'ld'], expected: 'Hello world!' },
    { label: 'uncovered command chunk', method: 'item/commandExecution/outputDelta', itemId: 'command-1', snapshotText: 'Hello', chunks: [' world'], expected: 'Hello world!' },
    { label: 'covered command sequence', method: 'item/commandExecution/outputDelta', itemId: 'command-1', snapshotText: 'Hello world', chunks: [' wor', 'ld'], expected: 'Hello world!' },
  ])('reconciles a deferred read with $label before later live deltas', async ({ method, itemId, snapshotText, chunks, expected }) => {
    let resolveRead: ((value: unknown) => void) | undefined;
    const server = createFakeAppServer();
    server.request.mockImplementation((method: string) => method === 'thread/read'
      ? new Promise((resolve) => { resolveRead = resolve; })
      : Promise.resolve({ data: [], nextCursor: null }));
    const sink = vi.fn();
    const watching = new CodexAdapter(server as never, { realpath: async (value) => value }).watchConversation({ provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' }, sink);
    for (const delta of chunks) server.emit({ method, params: { threadId: 'thread-1', turnId: 'turn-1', itemId, delta } });
    const snapshot = clone(threadRead.thread);
    snapshot.turns[0].status = 'inProgress';
    snapshot.turns[0].completedAt = null;
    const item = snapshot.turns[0].items.find((item) => item.id === itemId);
    if (!item) throw new Error('fixture is missing the live item');
    Object.assign(item, method === 'item/agentMessage/delta' ? { text: snapshotText } : { aggregatedOutput: snapshotText, status: 'inProgress' });
    resolveRead?.({ thread: snapshot });
    const unsubscribe = await watching;
    server.emit({ method, params: { threadId: 'thread-1', turnId: 'turn-1', itemId, delta: '!' } });

    const updates = sink.mock.calls.map(([event]) => event).filter((event) => event.nativeId === (method === 'item/agentMessage/delta' ? itemId : `${itemId}:status`));
    expect(updates.at(-1)).toMatchObject({ payload: method === 'item/agentMessage/delta' ? { text: expected } : { output: expected } });
    expect(JSON.stringify(updates)).not.toContain('Hello world world');
    unsubscribe();
    expect(server.listenerCount()).toBe(0);
  });

  test('removes both subscriptions when the initial thread read rejects', async () => {
    const server = createFakeAppServer();
    server.request.mockRejectedValue(new Error('initial read failed'));
    const sink = vi.fn();
    const watching = new CodexAdapter(server as never).watchConversation({ provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' }, sink);
    expect(server.listenerCount()).toBe(1);
    expect(server.requestListenerCount()).toBe(1);

    await expect(watching).rejects.toThrow('initial read failed');
    expect(server.listenerCount()).toBe(0);
    expect(server.requestListenerCount()).toBe(0);
    server.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'late' } });
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('Codex native continuation', () => {
  const ref = { provider: 'codex' as const, nativeSessionId: 'thread-1', projectPath: '/work/fractal' };

  test('creates and resumes native threads through stable typed operations', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    await expect(adapter.createConversation('/work/fractal')).resolves.toEqual({
      provider: 'codex', nativeSessionId: 'created-thread', projectPath: '/work/fractal',
    });
    const run = await adapter.continueConversation(ref, { text: 'Continue the fix' });
    expect(server.requests.slice(-2)).toEqual([
      { method: 'thread/resume', params: { threadId: 'thread-1', cwd: '/work/fractal' } },
      { method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Continue the fix', text_elements: [] }] } },
    ]);
    await run.dispose();
  });

  test('routes an approval once, fails closed for unsupported decisions, and interrupts once', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const run = await adapter.continueConversation(ref, { text: 'Run it' });
    server.emitRequest({
      id: 7, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'command-1', startedAtMs: 5, approvalId: 'approval-1', environmentId: null, command: 'rm file', cwd: '/work/fractal' },
    });
    await run.resolveRequest('approval-1', { kind: 'deny', reason: 'Do not delete it' });
    expect(server.responses).toEqual([{ id: 7, result: { decision: 'decline' } }]);
    await expect(run.resolveRequest('approval-1', { kind: 'allow-once' })).rejects.toThrow('no longer available');

    let interrupted = false;
    const interruptA = run.interrupt().then(() => { interrupted = true; });
    const interruptB = run.interrupt();
    await vi.waitFor(() => expect(server.requests.filter(({ method }) => method === 'turn/interrupt')).toHaveLength(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(interrupted).toBe(false);
    expect(server.requests.filter(({ method }) => method === 'turn/interrupt')).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-live' } },
    ]);
    server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...threadRead.thread.turns[0], id: 'turn-live', status: 'interrupted' } } });
    await Promise.all([interruptA, interruptB]);
    await run.dispose();
  });

  test('emits exactly one resolution with the submitted decision across native completion', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const iterator = run.events[Symbol.asyncIterator]();
    server.emitRequest({ id: 44, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'command', startedAtMs: 1, environmentId: null, command: 'pnpm lint', cwd: '/repo',
    } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'request-opened', request: { id: '44' } } } });
    await run.resolveRequest('44', { kind: 'allow-once' });
    server.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 44 } });
    server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...threadRead.thread.turns[0], id: 'turn-live', status: 'completed' } } });
    const remaining = []; for await (const event of { [Symbol.asyncIterator]: () => iterator }) remaining.push(event);
    expect(remaining.filter((event) => event.payload.kind === 'request-resolved')).toMatchObject([
      { payload: { requestId: '44', decision: { kind: 'allow-once' } } },
    ]);
  });

  test('correlates file approval with native file changes before presenting it', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Edit' });
    const iterator = run.events[Symbol.asyncIterator]();
    server.emit({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-live', startedAtMs: 1,
      item: { type: 'fileChange', id: 'change', changes: [{ path: '/repo/config.ts', kind: 'update', diff: '@@ config' }], status: 'inProgress' } } });
    server.emitRequest({ id: 45, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'change', startedAtMs: 2, reason: 'Update config', grantRoot: null } });
    const events = [await iterator.next(), await iterator.next(), await iterator.next()];
    expect(JSON.stringify(events)).toContain('/repo/config.ts');
    expect(events.at(-1)?.value?.payload).toMatchObject({ kind: 'request-opened', request: { operation: expect.stringContaining('/repo/config.ts') } });
    await run.dispose();
  });

  test('fails a file approval closed when the referenced edit is not known', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Edit' });
    server.emitRequest({ id: 46, method: 'item/fileChange/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'unknown-change', startedAtMs: 1, reason: null, grantRoot: null,
    } });
    expect(server.responses).toEqual([{ id: 46, result: { decision: 'decline' } }]);
    await run.dispose();
  });

  test('fails a command approval closed when the command is absent', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    server.emitRequest({ id: 48, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'command', startedAtMs: 1, environmentId: null, command: null, cwd: '/repo',
    } });
    expect(server.responses).toEqual([{ id: 48, result: { decision: 'decline' } }]);
    await run.dispose();
  });

  test('resolves a provider-timed-out request once with a denial', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const iterator = run.events[Symbol.asyncIterator]();
    server.emitRequest({ id: 47, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'command', startedAtMs: 1, environmentId: null, command: 'pnpm lint', cwd: '/repo',
    } });
    await iterator.next();
    server.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 47 } });
    server.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 47 } });
    server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...threadRead.thread.turns[0], id: 'turn-live', status: 'completed' } } });
    const remaining = []; for await (const event of { [Symbol.asyncIterator]: () => iterator }) remaining.push(event);
    expect(remaining.filter((event) => event.payload.kind === 'request-resolved')).toHaveLength(1);
    expect(remaining).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: 'request-resolved', decision: expect.objectContaining({ kind: 'deny' }) }) }));
    expect(server.responses).toEqual([]);
  });

  test.each(['completed', 'interrupted'] as const)('settles every pending approval before a %s turn closes', async (status) => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    server.emitRequest({ id: 50, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'command-a', startedAtMs: 1, environmentId: null, command: 'pnpm lint', cwd: '/repo',
    } });
    server.emitRequest({ id: 51, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'command-b', startedAtMs: 2, environmentId: null, command: 'pnpm test', cwd: '/repo',
    } });
    server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...threadRead.thread.turns[0], id: 'turn-live', status } } });
    server.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 50 } });
    const events = []; for await (const event of run.events) events.push(event);
    expect(events.map((event) => event.payload.kind)).toEqual([
      'request-opened', 'request-opened', 'request-resolved', 'request-resolved', 'turn-finished',
    ]);
    expect(events.filter((event) => event.payload.kind === 'request-resolved').map((event) => event.payload)).toMatchObject([
      { requestId: '50', decision: { kind: 'deny' } }, { requestId: '51', decision: { kind: 'deny' } },
    ]);
    expect(server.responses).toEqual([
      { id: 50, result: { decision: 'decline' } }, { id: 51, result: { decision: 'decline' } },
    ]);
    await expect(run.resolveRequest('50', { kind: 'allow-once' })).rejects.toThrow('no longer available');
  });

  test('routes a supported single-field question by its native field ID', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Ask' });
    server.emitRequest({
      id: 11, method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'question-item', isBlocking: true, autoResolutionMs: null,
        questions: [{ id: 'answer', header: 'Choice', question: 'Which?', isOther: true, isSecret: false, options: [{ label: 'option-b', description: 'Use option B' }] }] },
    });
    await run.resolveRequest('11', { kind: 'answer', answers: { answer: 'option-b' } });
    expect(server.responses).toContainEqual({ id: 11, result: { answers: { answer: { answers: ['option-b'] } } } });
    await run.dispose();
  });

  test('scopes native events and requests to the exact resumed thread and started turn', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run it' });
    const iterator = run.events[Symbol.asyncIterator]();
    server.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'other-turn', itemId: 'wrong-turn', delta: 'wrong' } });
    server.emit({ method: 'item/agentMessage/delta', params: { threadId: 'other', turnId: 'turn-live', itemId: 'wrong-thread', delta: 'wrong' } });
    server.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'right', delta: 'right' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { nativeId: 'right', payload: { text: 'right' } } });
    await run.dispose();
  });

  test('fails pending requests closed and rereads native IDs before proving an idle reconnect', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run it' });
    server.emitRequest({
      id: 7, method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'change-1', startedAtMs: 5, reason: null, grantRoot: null },
    });
    server.emitStatus({ availability: 'unavailable', message: 'exited' });
    await expect(run.resolveRequest('7', { kind: 'allow-once' })).rejects.toThrow('no longer available');
    server.emitStatus({ availability: 'available' });

    const events = [];
    for await (const event of run.events) events.push(event);
    expect(server.requests.some(({ method }) => method === 'thread/read')).toBe(true);
    expect(events.some((event) => event.nativeId === 'message-1')).toBe(true);
    expect(events.some((event) => event.payload.kind === 'system-notice' && event.payload.message.includes('idle'))).toBe(true);
  });

  test('publishes a denial resolution immediately when disconnect invalidates a pending request', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const iterator = run.events[Symbol.asyncIterator]();
    server.emitRequest({ id: 12, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'command', startedAtMs: 1, environmentId: null, command: 'pnpm lint', cwd: '/repo' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'request-opened', request: { id: '12' } } } });
    server.emitStatus({ availability: 'unavailable', message: 'exited' });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'request-resolved', requestId: '12', decision: { kind: 'deny' } } } });
    await run.dispose();
  });

  test('fails the run after the final reconnect failure instead of leaving ownership open', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const iterator = run.events[Symbol.asyncIterator]();
    server.emitStatus({ availability: 'unavailable', message: 'Codex App Server reconnect failed after 3 attempts' });
    await expect(iterator.next()).rejects.toThrow('reconnect failed after 3 attempts');
  });

  test('buffers matching synchronous traffic emitted while turn/start is in flight', async () => {
    const server = createFakeAppServer();
    server.duringTurnStart(() => {
      server.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'sync', delta: 'captured' } });
      server.emitRequest({ id: 13, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'sync-command', startedAtMs: 1, environmentId: null, command: 'pnpm lint', cwd: '/repo' } });
      server.emit({ method: 'item/agentMessage/delta', params: { threadId: 'other', turnId: 'turn-live', itemId: 'wrong', delta: 'leaked' } });
      server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...threadRead.thread.turns[0], id: 'turn-live', status: 'completed' } } });
    });
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const iterator = run.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { nativeId: 'sync', payload: { text: 'captured' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'request-opened', request: { id: '13' } } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'request-resolved', requestId: '13', decision: { kind: 'deny' } } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'turn-finished', turnId: 'turn-live' } } });
    await run.dispose();
  });

  test('does not settle interrupt on a malformed matching completion', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const iterator = run.events[Symbol.asyncIterator]();
    let settled = false; const interrupt = run.interrupt().then(() => { settled = true; });
    server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'bogus' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'unsupported' } } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...threadRead.thread.turns[0], id: 'turn-live', status: 'interrupted' } } });
    await interrupt;
  });

  test('captures a valid synchronous completion emitted during turn/start', async () => {
    const server = createFakeAppServer();
    server.duringTurnStart(() => server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...threadRead.thread.turns[0], id: 'turn-live', status: 'completed' } } }));
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const events = []; for await (const event of run.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ payload: { kind: 'turn-finished', turnId: 'turn-live', status: 'completed' } });
  });

  test('fails a colliding public request ID closed without overwriting the first owner', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const params = { threadId: 'thread-1', turnId: 'turn-live', itemId: 'command', startedAtMs: 1, approvalId: 'duplicate', environmentId: null as string | null, command: 'pnpm lint', cwd: '/repo' };
    server.emitRequest({ id: 20, method: 'item/commandExecution/requestApproval', params });
    server.emitRequest({ id: 21, method: 'item/commandExecution/requestApproval', params: { ...params, itemId: 'command-2' } });
    await run.resolveRequest('duplicate', { kind: 'allow-once' });
    expect(server.responses).toEqual([{ id: 21, result: { decision: 'decline' } }, { id: 20, result: { decision: 'accept' } }]);
    await run.dispose();
  });

  test.each([
    { decision: { kind: 'allow-once' } as const, result: { permissions: { network: { enabled: true }, fileSystem: { read: ['/repo'], write: ['/repo'], globScanMaxDepth: 4 } }, scope: 'turn' } },
    { decision: { kind: 'allow-and-remember', scope: 'session' } as const, result: { permissions: { network: { enabled: true }, fileSystem: { read: ['/repo'], write: ['/repo'], globScanMaxDepth: 4 } }, scope: 'session' } },
    { decision: { kind: 'deny', reason: 'No' } as const, result: { permissions: {}, scope: 'turn' } },
  ])('responds to a permission request with the generated $result.scope grant shape', async ({ decision, result }) => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    server.emitRequest({ id: 30, method: 'item/permissions/requestApproval', params: permissionParams() });
    await run.resolveRequest('30', decision);
    expect(server.responses).toEqual([{ id: 30, result }]);
    await run.dispose();
  });

  test('rejects a remembered permission scope that is not the exact provider scope', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    server.emitRequest({ id: 31, method: 'item/permissions/requestApproval', params: permissionParams() });
    await run.resolveRequest('31', { kind: 'allow-and-remember', scope: 'project:/repo' });
    expect(server.responses).toEqual([{ id: 31, result: { permissions: {}, scope: 'turn' } }]);
    await run.dispose();
  });

  test('denies a permission request with the generated empty turn grant on disconnect', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    server.emitRequest({ id: 32, method: 'item/permissions/requestApproval', params: permissionParams() });
    server.emitStatus({ availability: 'unavailable', message: 'exited' });
    expect(server.responses).toEqual([{ id: 32, result: { permissions: {}, scope: 'turn' } }]);
    await run.dispose();
  });
});

function permissionParams() {
  return {
    threadId: 'thread-1', turnId: 'turn-live', itemId: 'permission', environmentId: null as string | null, startedAtMs: 1,
    cwd: '/repo', reason: 'Needs repository and network access',
    permissions: { network: { enabled: true }, fileSystem: { read: ['/repo'], write: ['/repo'], globScanMaxDepth: 4 } },
  };
}
