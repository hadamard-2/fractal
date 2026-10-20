import { describe, expect, test, vi } from 'vitest';
import { CodexAdapter } from '@/main/harness/codex/codex-adapter';
import threadRead from '@/main/harness/codex/__fixtures__/thread-read.json';
import { JsonRpcError } from '@/main/harness/codex/json-rpc-peer';

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

function codexModel(model: string, efforts: string[]) {
  return {
    id: model, model, displayName: model.toUpperCase(), description: `${model} description`, hidden: false, isDefault: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: 'medium',
  };
}

const workspaceWrite = { type: 'workspaceWrite', writableRoots: ['/extra'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };

function createFakeAppServer(pages = [[thread('newer')], [thread('older')]], repeatCursor = false, importedThreads: string[] | Error = []) {
  const listeners = new Set<(notification: unknown) => void>();
  const requestListeners = new Set<(request: unknown) => void>();
  const statusListeners = new Set<(status: { availability: 'available' | 'unavailable'; message?: string }) => void>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const responses: Array<{ id: string | number; result: unknown }> = [];
  let duringTurnStart: (() => void) | undefined;
  let forkCwd: string | undefined;
  const resumeAccess = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: workspaceWrite };
  return {
    status: { availability: 'available' as const }, requests, responses,
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'thread/list') {
        const index = params.cursor === 'next' ? 1 : 0;
        if (repeatCursor && requests.length > 4) throw new Error('pagination did not terminate');
        return { data: pages[index] ?? [], nextCursor: index === 0 || repeatCursor ? 'next' : null };
      }
      if (method === 'externalAgentConfig/import/readHistories') {
        if (importedThreads instanceof Error) throw importedThreads;
        return { data: [{ importId: 'import-1', providerId: 'claude-code', completedAtMs: 1, failures: [], successes: [
          { itemType: 'AGENTS_MD', cwd: null, source: 'CLAUDE.md', target: 'newer', title: null },
          ...importedThreads.map((target) => ({ itemType: 'SESSIONS', cwd: '/work/fractal', source: `/claude/${target}.jsonl`, target, title: target })),
        ] }], connectors: [] };
      }
      if (method === 'thread/read') return { thread: threadRead.thread };
      if (method === 'thread/start') return { thread: { ...threadRead.thread, id: 'created-thread', cwd: params.cwd }, model: 'gpt-5.5', reasoningEffort: 'medium', ...resumeAccess };
      if (method === 'thread/resume') return { thread: { ...threadRead.thread, id: params.threadId }, model: 'gpt-5.6-terra', reasoningEffort: 'high', ...resumeAccess };
      if (method === 'model/list') return params.cursor === 'models-2'
        ? { data: [codexModel('gpt-5.5', ['low', 'medium', 'high', 'xhigh'])], nextCursor: null }
        : { data: [codexModel('gpt-5.6-terra', ['low', 'medium', 'ultra']), { ...codexModel('codex-auto-review', ['low']), hidden: true }], nextCursor: 'models-2' };
      if (method === 'config/read') return { config: { model: null, mcp_servers: { node_repl: { command: 'node_repl' }, docs: { url: 'https://example.test/mcp' } } }, origins: {}, layers: null };
      if (method === 'thread/fork') return { thread: { ...threadRead.thread, id: 'forked-thread', cwd: forkCwd ?? params.cwd }, ...resumeAccess };
      if (method === 'turn/start') { duringTurnStart?.(); return { turn: { ...threadRead.thread.turns[0], id: 'turn-live', status: 'inProgress' } }; }
      if (method === 'turn/interrupt') return {};
      if (method === 'thread/name/set') return {};
      if (method === 'thread/delete') return {};
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
    setForkCwd(cwd: string) { forkCwd = cwd; },
    setResumeAccess(access: Record<string, unknown>) { Object.assign(resumeAccess, access); },
  };
}

describe('Codex read adapter', () => {
  test('reports the server\'s version and warns when it is older than the tested floor', async () => {
    const server = createFakeAppServer();
    Object.assign(server.status, { userAgent: 'fractal/0.160.0 (Ubuntu 26.4.0; x86_64)' });
    const adapter = new CodexAdapter(server as never, { realpath: async (input: string) => input });
    await expect(adapter.probe()).resolves.toMatchObject({
      availability: 'available', version: 'fractal/0.160.0 (Ubuntu 26.4.0; x86_64)', warning: expect.stringMatching(/^Codex 0\.160\.0 is older than/),
    });
  });

  test('paginates active threads in native order and maps stable summary fields', async () => {
    const server = createFakeAppServer();
    const summaries = await new CodexAdapter(server as never).listConversations();

    expect(server.requests.map((request) => request.method)).toEqual(['externalAgentConfig/import/readHistories', 'thread/list', 'thread/list']);
    expect(server.requests[1]?.params).toEqual({ archived: false, sortKey: 'updated_at', sortDirection: 'desc', limit: 100, useStateDbOnly: true });
    expect(server.requests[2]?.params).toEqual({ archived: false, sortKey: 'updated_at', sortDirection: 'desc', limit: 100, useStateDbOnly: true, cursor: 'next' });
    expect(summaries.map((summary) => summary.ref.nativeSessionId)).toEqual(['newer', 'older']);
    expect(summaries.map((summary) => summary.title)).toEqual(['Newest native name', 'Older preview title']);
    expect(summaries[0]).toMatchObject({ runtime: 'idle', createdAt: 1768000000000, updatedAt: 1768000030000, captureCompleteness: 'unknown' });
  });

  test('stops a repeated cursor and deduplicates overlapping native pages', async () => {
    const server = createFakeAppServer([[thread('newer'), thread('older')], [thread('older')]], true);
    const summaries = await new CodexAdapter(server as never, { realpath: async (value) => value }).listConversations();

    expect(summaries.map((summary) => summary.ref.nativeSessionId)).toEqual(['newer', 'older']);
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]?.params).toMatchObject({ cursor: 'next' });
  });

  test('leaves out threads Codex imported from another agent\'s sessions', async () => {
    const server = createFakeAppServer([[thread('newer'), thread('copy')], [thread('older')]], false, ['copy']);
    const summaries = await new CodexAdapter(server as never).listConversations();

    expect(summaries.map((summary) => summary.ref.nativeSessionId)).toEqual(['newer', 'older']);
  });

  test('lists every thread when Codex cannot report its imports', async () => {
    const server = createFakeAppServer([[thread('newer'), thread('copy')], []], false, new Error('unknown method'));
    const summaries = await new CodexAdapter(server as never).listConversations();

    expect(summaries.map((summary) => summary.ref.nativeSessionId)).toEqual(['newer', 'copy']);
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

  test('renames a thread through thread/name/set', async () => {
    const server = createFakeAppServer();
    await new CodexAdapter(server as never).renameConversation({ provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' }, 'Renamed');
    expect(server.requests).toEqual([{ method: 'thread/name/set', params: { threadId: 'thread-1', name: 'Renamed' } }]);
  });

  test('lists visible models across pages with their efforts', async () => {
    const server = createFakeAppServer();
    await expect(new CodexAdapter(server as never).listModels()).resolves.toEqual([
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-TERRA', description: 'gpt-5.6-terra description', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'medium' },
      { id: 'gpt-5.5', label: 'GPT-5.5', description: 'gpt-5.5 description', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    ]);
    expect(server.requests.filter((request) => request.method === 'model/list').map((request) => request.params)).toEqual([{}, { cursor: 'models-2' }]);
  });

  test('reads the last run from thread/resume without unsubscribing', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    await expect(adapter.readLastRun({ provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' })).resolves.toEqual({ model: 'gpt-5.6-terra', effort: 'high' });
    expect(server.requests).toEqual([{ method: 'thread/resume', params: { threadId: 'thread-1', cwd: '/work/fractal' } }]);
  });

  test('reads the thread access from thread/resume', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const ref = { provider: 'codex' as const, nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
    await expect(adapter.readAccess(ref)).resolves.toEqual({ kind: 'level', level: 'auto' });
    server.setResumeAccess({ approvalPolicy: 'never' });
    await expect(adapter.readAccess(ref)).resolves.toEqual({ kind: 'custom', label: 'workspace-write · never ask' });
  });

  test('shares one thread/resume between concurrent reads, and asks again afterwards', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const ref = { provider: 'codex' as const, nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
    await Promise.all([adapter.readAccess(ref), adapter.readLastRun(ref)]);
    expect(server.requests.filter((request) => request.method === 'thread/resume')).toHaveLength(1);
    await adapter.readAccess(ref);
    expect(server.requests.filter((request) => request.method === 'thread/resume')).toHaveLength(2);
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

  test('maps native active, waiting, error, and fallback titles into summaries, with a failed last turn as idle', async () => {
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
      ['waiting', 'waiting-for-user'], ['failed', 'idle'], ['active', 'active-externally'],
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

  test('sends images as localImage items and other files as a trailing attachments block', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const run = await adapter.continueConversation(ref, { text: 'Compare', attachments: [{ path: '/repo/a.ts' }, { path: '/tmp/shot.png', image: 'image/png' }] });
    expect(server.requests.at(-1)).toEqual({ method: 'turn/start', params: { threadId: 'thread-1', input: [
      { type: 'text', text: 'Compare\n\n<attachments>\n/repo/a.ts\n</attachments>', text_elements: [] },
      { type: 'localImage', path: '/tmp/shot.png' },
    ] } });
    await run.dispose();
  });

  test('omits the text item for an image-only message', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const run = await adapter.continueConversation(ref, { text: '', attachments: [{ path: '/tmp/shot.png', image: 'image/png' }] });
    expect(server.requests.at(-1)).toEqual({ method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'localImage', path: '/tmp/shot.png' }] } });
    await run.dispose();
  });

  const turnStartParams = (server: ReturnType<typeof createFakeAppServer>) => server.requests.findLast((request) => request.method === 'turn/start')?.params as Record<string, unknown>;

  test('sends a picked level as turn/start overrides built from the resumed sandbox', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const run = await adapter.continueConversation(ref, { text: 'Go', access: { state: { kind: 'level', level: 'auto-review' }, picked: true } });
    expect(turnStartParams(server)).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: workspaceWrite });
    await run.dispose();
  });

  test.each([
    ['a read-back level', { state: { kind: 'level', level: 'auto' }, picked: false }],
    ['a custom state', { state: { kind: 'custom', label: 'workspace-write · never ask' }, picked: true }],
  ] as const)('sends no access overrides for %s', async (_name, access) => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const run = await adapter.continueConversation(ref, { text: 'Go', access });
    const params = turnStartParams(server);
    expect(params).not.toHaveProperty('approvalPolicy');
    expect(params).not.toHaveProperty('approvalsReviewer');
    expect(params).not.toHaveProperty('sandboxPolicy');
    await run.dispose();
  });

  test('sends the chosen model and effort on turn/start', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const run = await adapter.continueConversation(ref, { text: 'Go', model: 'gpt-5.5', effort: 'high' });
    expect(server.requests.at(-1)).toEqual({ method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Go', text_elements: [] }], model: 'gpt-5.5', effort: 'high' } });
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

  test('routes several questions as one request, each under its native field ID', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Ask' });
    const iterator = run.events[Symbol.asyncIterator]();
    server.emitRequest({
      id: 12, method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'question-item', isBlocking: true, autoResolutionMs: null,
        questions: [
          { id: 'where', header: 'Where', question: 'Where?', isOther: false, isSecret: false, options: [{ label: 'Production', description: 'Live' }] },
          { id: 'why', header: 'Why', question: 'Why?', isOther: true, isSecret: false, options: null },
        ] },
    });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'request-opened', request: { questions: [
      { fieldId: 'where', prompt: 'Where?', choices: [{ value: 'Production', label: 'Production', description: 'Live' }], allowFreeText: false },
      { fieldId: 'why', prompt: 'Why?', allowFreeText: true },
    ] } } } });
    await run.resolveRequest('12', { kind: 'answer', answers: { where: 'Production', why: 'Release day' } });
    expect(server.responses).toContainEqual({ id: 12, result: { answers: { where: { answers: ['Production'] }, why: { answers: ['Release day'] } } } });
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

describe('Codex summary of a single thread', () => {
  const ref = { provider: 'codex' as const, nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
  const adapterFor = (server: ReturnType<typeof createFakeAppServer>) => new CodexAdapter(server as never, { realpath: async (value) => value });
  function readFails(server: ReturnType<typeof createFakeAppServer>, error: Error) {
    const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    server.request.mockImplementation(async (method, params) => { if (method === 'thread/read') throw error; return request(method, params); });
  }

  test('reads the thread without its turns and maps it like a listed one', async () => {
    const server = createFakeAppServer();
    await expect(adapterFor(server).readSummary(ref)).resolves.toEqual({
      ref, title: 'Native history', createdAt: 1768000000000, updatedAt: 1768000010000, runtime: 'idle', captureCompleteness: 'unknown',
    });
    expect(server.requests).toEqual([{ method: 'thread/read', params: { threadId: 'thread-1', includeTurns: false } }]);
  });

  test('reports the thread\'s own project, leaving the comparison to the caller', async () => {
    const server = createFakeAppServer();
    await expect(adapterFor(server).readSummary({ ...ref, projectPath: '/work/other' })).resolves.toMatchObject({ ref: { projectPath: '/work/fractal' } });
  });

  test('is null when Codex says the thread is not loaded', async () => {
    const server = createFakeAppServer();
    readFails(server, new JsonRpcError(-32600, 'thread not loaded: thread-1'));
    await expect(adapterFor(server).readSummary(ref)).resolves.toBeNull();
  });

  test.each([
    { label: 'the same code with another message', error: new JsonRpcError(-32600, 'invalid request') },
    { label: 'the same message with another code', error: new JsonRpcError(-32603, 'thread not loaded: thread-1') },
    { label: 'a transport failure', error: new Error('thread not loaded: thread-1') },
  ])('rethrows $label', async ({ error }) => {
    const server = createFakeAppServer();
    readFails(server, error);
    await expect(adapterFor(server).readSummary(ref)).rejects.toBe(error);
  });

  test('refuses a thread Codex returns under another id', async () => {
    const server = createFakeAppServer();
    await expect(adapterFor(server).readSummary({ ...ref, nativeSessionId: 'thread-2' })).rejects.toThrow('does not match');
  });

  test('refuses a conversation that is not a Codex thread', async () => {
    const server = createFakeAppServer();
    await expect(adapterFor(server).readSummary({ ...ref, provider: 'claude' })).rejects.toThrow('Conversation provider must be codex');
    expect(server.requests).toEqual([]);
  });
});

function permissionParams() {
  return {
    threadId: 'thread-1', turnId: 'turn-live', itemId: 'permission', environmentId: null as string | null, startedAtMs: 1,
    cwd: '/repo', reason: 'Needs repository and network access',
    permissions: { network: { enabled: true }, fileSystem: { read: ['/repo'], write: ['/repo'], globScanMaxDepth: 4 } },
  };
}

describe('Codex fork and read-only runs', () => {
  const ref = { provider: 'codex' as const, nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
  const adapterFor = (server: ReturnType<typeof createFakeAppServer>) => new CodexAdapter(server as never, { realpath: async (value) => value });
  const readOnlyConfig = { features: { apps: false, plugins: false, hooks: false, multi_agent: false }, mcp_servers: { node_repl: { enabled: false }, docs: { enabled: false } } };
  const forkParams = (server: ReturnType<typeof createFakeAppServer>) => server.requests.find((request) => request.method === 'thread/fork')?.params;

  test('reports that it can fork', () => {
    expect(adapterFor(createFakeAppServer()).capabilities().fork).toBe(true);
  });

  test('forks a read-only side chat through the turn on the parent\'s model, with approvals off and the note as developer instructions', async () => {
    const server = createFakeAppServer();
    const forked = await adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: true, note: 'Side chat note', title: 'Side' });
    expect(forkParams(server)).toEqual({
      threadId: 'thread-1', lastTurnId: 'turn-3', cwd: '/work/fractal', sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', developerInstructions: 'Side chat note', config: readOnlyConfig, model: 'gpt-5.6-terra',
    });
    expect(forked).toEqual({ provider: 'codex', nativeSessionId: 'forked-thread', projectPath: '/work/fractal' });
    const methods = server.requests.map((request) => request.method);
    expect(server.requests.find((request) => request.method === 'thread/resume')?.params).toEqual({ threadId: 'thread-1', cwd: '/work/fractal' });
    expect(methods.indexOf('thread/resume')).toBeLessThan(methods.indexOf('thread/fork'));
  });

  test('keeps a side chat on the parent\'s read-only settings, not its access, and sends no model when the parent reports none', async () => {
    const server = createFakeAppServer();
    const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    server.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      return method === 'thread/resume' ? { ...(result as object), model: '', sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'on-request' } : result;
    });
    await adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' });
    expect(forkParams(server)).toEqual({
      threadId: 'thread-1', lastTurnId: 'turn-3', cwd: '/work/fractal', sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', config: readOnlyConfig,
    });
  });

  test('does not fork a side chat when the parent cannot be resumed', async () => {
    const server = createFakeAppServer();
    const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    server.request.mockImplementation(async (method, params) => { if (method === 'thread/resume') throw new Error('resume failed'); return request(method, params); });
    await expect(adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' })).rejects.toThrow('resume failed');
    expect(server.requests.map((entry) => entry.method)).not.toContain('thread/fork');
  });

  test('forks a side chat with every configured MCP server off, read from the project\'s effective config', async () => {
    const server = createFakeAppServer();
    await adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' });
    expect(server.requests.find((request) => request.method === 'config/read')?.params).toEqual({ cwd: '/work/fractal' });
    expect(forkParams(server)).toMatchObject({ config: {
      features: { apps: false, plugins: false, hooks: false, multi_agent: false },
      mcp_servers: { node_repl: { enabled: false }, docs: { enabled: false } },
    } });
  });

  test('does not fork a side chat when it cannot read the configured MCP servers', async () => {
    const server = createFakeAppServer();
    const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    server.request.mockImplementation(async (method, params) => { if (method === 'config/read') throw new Error('no config'); return request(method, params); });
    await expect(adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' })).rejects.toThrow('no config');
    expect(server.requests.map((entry) => entry.method)).not.toContain('thread/fork');
  });

  test('titles the fork with thread/name/set after forking', async () => {
    const server = createFakeAppServer();
    await adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side: why the cache' });
    expect(server.requests.at(-1)).toEqual({ method: 'thread/name/set', params: { threadId: 'forked-thread', name: 'Side: why the cache' } });
    const full = createFakeAppServer();
    await adapterFor(full).forkConversation(ref, 'turn-3', { readOnly: false, title: 'Fork of it' });
    expect(full.requests.at(-1)).toEqual({ method: 'thread/name/set', params: { threadId: 'forked-thread', name: 'Fork of it' } });
  });

  test('still returns the fork when titling it fails', async () => {
    const server = createFakeAppServer();
    const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    server.request.mockImplementation(async (method, params) => { if (method === 'thread/name/set') throw new Error('rename failed'); return request(method, params); });
    await expect(adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: false, title: 'Fork' })).resolves.toMatchObject({ nativeSessionId: 'forked-thread' });
  });

  test('repeats the MCP overrides whenever a side chat thread is resumed, so a reload cannot bring the servers back', async () => {
    const server = createFakeAppServer();
    const adapter = adapterFor(server);
    const side = await adapter.forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' });
    await adapter.readAccess(side);
    const run = await adapter.continueConversation(side, { text: 'Look', branch: { readOnly: true } });
    const resumes = server.requests.filter((request) => request.method === 'thread/resume' && (request.params as { threadId?: string }).threadId === 'forked-thread');
    expect(resumes).toHaveLength(2);
    for (const resume of resumes) expect(resume.params).toEqual({ threadId: 'forked-thread', cwd: '/work/fractal', config: readOnlyConfig });
    await run.dispose();
  });

  test('applies the MCP overrides when a read-only run resumes a thread this process did not fork', async () => {
    const server = createFakeAppServer();
    const run = await adapterFor(server).continueConversation(ref, { text: 'Look', branch: { readOnly: true } });
    expect(server.requests.find((request) => request.method === 'thread/resume')?.params).toEqual({ threadId: 'thread-1', cwd: '/work/fractal', config: readOnlyConfig });
    await run.dispose();
  });

  test('sends the MCP overrides on the first resume of a side chat this process did not fork, when the service says it is one', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value, isReadOnlyThread: (id) => id === 't-side' });
    await adapter.readAccess({ provider: 'codex', nativeSessionId: 't-side', projectPath: '/work/fractal' });
    expect(server.requests.filter((request) => request.method === 'thread/resume')).toEqual([
      { method: 'thread/resume', params: { threadId: 't-side', cwd: '/work/fractal', config: readOnlyConfig } },
    ]);
    await adapter.readAccess(ref);
    expect(server.requests.filter((request) => request.method === 'thread/resume').at(-1)?.params).toEqual({ threadId: 'thread-1', cwd: '/work/fractal' });
  });

  describe('loading a side chat', () => {
    const side = { provider: 'codex' as const, nativeSessionId: 't-side', projectPath: '/work/fractal' };
    const sideAdapter = (server: ReturnType<typeof createFakeAppServer>) => new CodexAdapter(server as never, { realpath: async (value) => value, isReadOnlyThread: (id) => id === 't-side' });
    function readsAs(server: ReturnType<typeof createFakeAppServer>, id: string) {
      const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
      server.request.mockImplementation(async (method, params) => {
        const result = await request(method, params);
        return method === 'thread/read' ? { thread: { ...threadRead.thread, id } } : result;
      });
    }

    test('resumes a read-only thread with its read-only config before reading it, so it loads in this server', async () => {
      const server = createFakeAppServer();
      readsAs(server, 't-side');
      const adapter = sideAdapter(server);
      await adapter.loadConversation(side);
      const methods = server.requests.map((request) => request.method);
      expect(server.requests.find((request) => request.method === 'thread/resume')?.params).toEqual({ threadId: 't-side', cwd: '/work/fractal', config: readOnlyConfig });
      expect(methods.indexOf('thread/resume')).toBeLessThan(methods.indexOf('thread/read'));
      // Still resumable with its overrides afterwards: the load did not count as a resume without them.
      const run = await adapter.continueConversation(side, { text: 'Look', branch: { readOnly: true } });
      await run.dispose();
    });

    test('resumes a side chat this process forked', async () => {
      const server = createFakeAppServer();
      readsAs(server, 'forked-thread');
      const adapter = adapterFor(server);
      const forked = await adapter.forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' });
      await adapter.loadConversation(forked);
      expect(server.requests.filter((request) => request.method === 'thread/resume').at(-1)?.params).toEqual({ threadId: 'forked-thread', cwd: '/work/fractal', config: readOnlyConfig });
    });

    test('does not resume a thread that is not read-only', async () => {
      const server = createFakeAppServer();
      await sideAdapter(server).loadConversation(ref);
      expect(server.requests.map((request) => request.method)).toEqual(['thread/read']);
    });

    test('fails the load when the resume fails, without reading', async () => {
      const server = createFakeAppServer();
      const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
      server.request.mockImplementation(async (method, params) => { if (method === 'thread/resume') throw new Error('resume failed'); return request(method, params); });
      await expect(sideAdapter(server).loadConversation(side)).rejects.toThrow('resume failed');
      expect(server.requests.map((entry) => entry.method)).not.toContain('thread/read');
    });
  });

  test('refuses a read-only run on a thread already resumed in this process without the overrides', async () => {
    const server = createFakeAppServer();
    const adapter = adapterFor(server);
    await adapter.readAccess(ref);
    await expect(adapter.continueConversation(ref, { text: 'Look', branch: { readOnly: true } })).rejects.toThrow('Read-only thread resumed without its read-only settings');
    expect(server.requests.map((request) => request.method)).not.toContain('turn/start');
  });

  test('refuses a read-only run when the thread only became known as a side chat after it was resumed without the overrides', async () => {
    const server = createFakeAppServer();
    let sideChat = false;
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value, isReadOnlyThread: () => sideChat });
    await adapter.readAccess(ref);
    sideChat = true;
    await expect(adapter.continueConversation(ref, { text: 'Look', branch: { readOnly: true } })).rejects.toThrow('Read-only thread resumed without its read-only settings');
    await expect(adapter.continueConversation(ref, { text: 'Look' })).rejects.toThrow('Read-only thread resumed without its read-only settings');
    expect(server.requests.map((request) => request.method)).not.toContain('turn/start');
  });

  test('runs a thread the service names as a side chat read-only even when the prompt carries no branch', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value, isReadOnlyThread: (id) => id === 'thread-1' });
    const run = await adapter.continueConversation(ref, { text: 'Look', access: { state: { kind: 'level', level: 'full-access' }, picked: true } });
    expect(server.requests.find((request) => request.method === 'thread/resume')?.params).toEqual({ threadId: 'thread-1', cwd: '/work/fractal', config: readOnlyConfig });
    expect(server.requests.findLast((request) => request.method === 'turn/start')?.params).toMatchObject({
      approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    server.emitRequest({ id: 71, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'command', startedAtMs: 1, environmentId: null, command: 'rm -rf x', cwd: '/repo',
    } });
    expect(server.responses).toEqual([{ id: 71, result: { decision: 'decline' } }]);
    await run.dispose();
  });

  test('titling or reading a thread does not load it, so neither blocks a later read-only run', async () => {
    const server = createFakeAppServer();
    const adapter = adapterFor(server);
    await adapter.renameConversation(ref, 'Renamed');
    await adapter.loadConversation(ref);
    const run = await adapter.continueConversation(ref, { text: 'Look', branch: { readOnly: true } });
    expect(server.requests.find((request) => request.method === 'thread/resume')?.params).toMatchObject({ config: readOnlyConfig });
    await run.dispose();
  });

  test('refuses a read-only run while a resume without the overrides is still in flight', async () => {
    const server = createFakeAppServer();
    const adapter = adapterFor(server);
    const reading = adapter.readAccess(ref);
    await expect(adapter.continueConversation(ref, { text: 'Look', branch: { readOnly: true } })).rejects.toThrow('Read-only thread resumed without its read-only settings');
    await reading;
  });

  test('leaves MCP config off the resume of a thread that is not a side chat', async () => {
    const server = createFakeAppServer();
    const run = await adapterFor(server).continueConversation(ref, { text: 'Go', branch: { readOnly: false } });
    expect(server.requests.find((request) => request.method === 'thread/resume')?.params).toEqual({ threadId: 'thread-1', cwd: '/work/fractal' });
    expect(server.requests.map((request) => request.method)).not.toContain('config/read');
    await run.dispose();
  });

  test('forks a side chat without developer instructions when there is no note', async () => {
    const server = createFakeAppServer();
    await adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' });
    expect(forkParams(server)).not.toHaveProperty('developerInstructions');
  });

  test('forks a full fork with the parent\'s model and access, and no developer instructions without a note', async () => {
    const server = createFakeAppServer();
    const forked = await adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: false, title: 'Fork' });
    expect(server.requests.map((request) => request.method)).toEqual(['thread/resume', 'thread/fork', 'thread/name/set']);
    expect(forkParams(server)).toEqual({
      threadId: 'thread-1', lastTurnId: 'turn-3', cwd: '/work/fractal', model: 'gpt-5.6-terra', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
    });
    expect(forked).toEqual({ provider: 'codex', nativeSessionId: 'forked-thread', projectPath: '/work/fractal' });
  });

  test.each([
    [{ type: 'readOnly', networkAccess: false }, 'read-only'],
    [{ type: 'dangerFullAccess' }, 'danger-full-access'],
    [{ type: 'externalSandbox', networkAccess: 'restricted' }, undefined],
  ])('maps the parent sandbox %j to %s for a full fork', async (sandbox, mapped) => {
    const server = createFakeAppServer();
    server.setResumeAccess({ sandbox });
    await adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: false, note: 'Fork note', title: 'Fork' });
    const params = forkParams(server) as Record<string, unknown>;
    if (mapped) expect(params.sandbox).toBe(mapped); else expect(params).not.toHaveProperty('sandbox');
    expect(params.developerInstructions).toBe('Fork note');
  });

  test('rejects a fork that landed in another project', async () => {
    const server = createFakeAppServer();
    server.setForkCwd('/work/other');
    await expect(adapterFor(server).forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' })).rejects.toThrow('does not match the selected project');
  });

  describe('deleting a thread', () => {
    test('sends thread/delete with the thread id', async () => {
      const server = createFakeAppServer();
      await adapterFor(server).deleteConversation(ref);
      expect(server.requests).toEqual([{ method: 'thread/delete', params: { threadId: 'thread-1' } }]);
    });

    test('forgets the thread once it is deleted, so a re-created thread of that id is not held to old settings', async () => {
      const server = createFakeAppServer();
      const adapter = adapterFor(server);
      const side = await adapter.forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' });
      await adapter.deleteConversation(side);
      await adapter.readAccess(side);
      expect(server.requests.findLast((request) => request.method === 'thread/resume')?.params).toEqual({ threadId: 'forked-thread', cwd: '/work/fractal' });
      await adapter.readAccess(ref);
      await adapter.deleteConversation(ref);
      const run = await adapter.continueConversation(ref, { text: 'Look', branch: { readOnly: true } });
      await run.dispose();
    });

    test('leaves its bookkeeping unchanged when the request is rejected', async () => {
      const server = createFakeAppServer();
      const adapter = adapterFor(server);
      const side = await adapter.forkConversation(ref, 'turn-3', { readOnly: true, title: 'Side' });
      await adapter.readAccess(ref);
      const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
      server.request.mockImplementation(async (method, params) => { if (method === 'thread/delete') throw new Error('delete refused'); return request(method, params); });
      await expect(adapter.deleteConversation(side)).rejects.toThrow('delete refused');
      await expect(adapter.deleteConversation(ref)).rejects.toThrow('delete refused');
      await adapter.readAccess(side);
      expect(server.requests.findLast((request) => request.method === 'thread/resume')?.params).toEqual({ threadId: 'forked-thread', cwd: '/work/fractal', config: readOnlyConfig });
      await expect(adapter.continueConversation(ref, { text: 'Look', branch: { readOnly: true } })).rejects.toThrow('Read-only thread resumed without its read-only settings');
    });

    test('refuses a conversation that is not a Codex thread', async () => {
      const server = createFakeAppServer();
      await expect(adapterFor(server).deleteConversation({ ...ref, provider: 'claude' })).rejects.toThrow('Conversation provider must be codex');
      expect(server.requests).toEqual([]);
    });
  });

  test('runs a side chat turn read-only even when the prompt picks full access', async () => {
    const server = createFakeAppServer();
    const run = await adapterFor(server).continueConversation(ref, { text: 'Look', branch: { readOnly: true }, access: { state: { kind: 'level', level: 'full-access' }, picked: true } });
    expect(server.requests.findLast((request) => request.method === 'turn/start')?.params).toMatchObject({
      approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    await run.dispose();
  });

  test('does not apply read-only overrides to a full fork run', async () => {
    const server = createFakeAppServer();
    const run = await adapterFor(server).continueConversation(ref, { text: 'Go', branch: { readOnly: false } });
    expect(server.requests.findLast((request) => request.method === 'turn/start')?.params).not.toHaveProperty('sandboxPolicy');
    await run.dispose();
  });

  test('declines every approval and question during a read-only run without opening a request', async () => {
    const server = createFakeAppServer();
    const run = await adapterFor(server).continueConversation(ref, { text: 'Look', branch: { readOnly: true } });
    const iterator = run.events[Symbol.asyncIterator]();
    server.emitRequest({ id: 61, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'command', startedAtMs: 1, environmentId: null, command: 'rm -rf x', cwd: '/repo',
    } });
    server.emitRequest({ id: 62, method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'question-item', isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'answer', header: 'Choice', question: 'Which?', isOther: true, isSecret: false, options: null }],
    } });
    expect(server.responses).toEqual([{ id: 61, result: { decision: 'decline' } }]);
    expect(server.respondError).toHaveBeenCalledWith(62, expect.any(Number), expect.any(String));
    server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...threadRead.thread.turns[0], id: 'turn-live', status: 'completed' } } });
    const events = []; for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event);
    expect(events.filter((event) => event.payload.kind === 'request-opened')).toEqual([]);
    await run.dispose();
  });
});

describe('Codex failed turns', () => {
  const ref = { provider: 'codex' as const, nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
  // What codex-cli 0.162.1 sends when a turn fails before producing anything, e.g. on a model the account cannot use.
  const failedCompletion = { method: 'turn/completed', params: { threadId: 'thread-1', turn: {
    id: 'turn-live', items: [] as unknown[], itemsView: 'notLoaded', status: 'failed', error: { message: 'The model is not available for this account.', codexErrorInfo: null as unknown, additionalDetails: null as unknown },
    startedAt: 1, completedAt: 2, durationMs: 1_000,
  } } };

  test('ends the run on a failed completion whose items are not loaded', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    server.emit(failedCompletion);
    const events = []; for await (const event of run.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ payload: { kind: 'turn-finished', turnId: 'turn-live', status: 'failed' } });
    expect(server.listenerCount()).toBe(0);
  });

  test('says why the turn failed, once, before it finishes', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    server.emit({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-live', willRetry: false, error: failedCompletion.params.turn.error } });
    server.emit(failedCompletion);
    const events = []; for await (const event of run.events) events.push(event);
    expect(events.map((event) => [event.nativeId, event.payload])).toEqual([
      ['turn-live:error', { kind: 'system-notice', turnId: 'turn-live', message: 'The model is not available for this account.', tone: 'error' }],
      ['turn-live:error', { kind: 'system-notice', turnId: 'turn-live', message: 'The model is not available for this account.', tone: 'error' }],
      ['turn-live:status', { kind: 'turn-finished', turnId: 'turn-live', status: 'failed' }],
    ]);
  });

  test('loads a thread whose last turn failed as idle, so it can take the next message', async () => {
    const server = createFakeAppServer();
    const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    server.request.mockImplementation(async (method, params) => method === 'thread/read'
      ? { thread: { ...threadRead.thread, status: { type: 'systemError' } } }
      : request(method, params));
    const loaded = await new CodexAdapter(server as never, { realpath: async (value) => value }).loadConversation(ref);
    expect(loaded.summary.runtime).toBe('idle');
  });

  test('settles a stop requested before the failed completion arrives', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const interrupted = run.interrupt();
    server.emit(failedCompletion);
    await expect(interrupted).resolves.toBeUndefined();
  });

  test('still ignores a notLoaded completion that is otherwise malformed', async () => {
    const server = createFakeAppServer();
    const run = await new CodexAdapter(server as never, { realpath: async (value) => value }).continueConversation(ref, { text: 'Run' });
    const iterator = run.events[Symbol.asyncIterator]();
    server.emit({ ...failedCompletion, params: { ...failedCompletion.params, turn: { ...failedCompletion.params.turn, items: null } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'unsupported' } } });
    server.emit(failedCompletion);
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'system-notice', tone: 'error' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'turn-finished', status: 'failed' } } });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});

describe('Codex thread this process started, before its first turn', () => {
  const created = { provider: 'codex' as const, nativeSessionId: 'created-thread', projectPath: '/work/fractal' };
  const unsupported = () => new JsonRpcError(-32601, 'list_turns is not supported yet');

  // The app server that started a thread refuses to list its turns or resume it until it has a turn.
  function refusesUntilFirstTurn(server: ReturnType<typeof createFakeAppServer>) {
    const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    let turned = false;
    server.request.mockImplementation(async (method, params) => {
      if (method === 'turn/start') turned = true;
      if (params?.threadId === 'created-thread' && !turned) {
        if (method === 'thread/resume' || (method === 'thread/read' && params.includeTurns === true)) { server.requests.push({ method, params }); throw unsupported(); }
        if (method === 'thread/read') { server.requests.push({ method, params }); return { thread: { ...threadRead.thread, id: 'created-thread', preview: '', name: null, turns: [] } }; }
      }
      const result = await request(method, params);
      return method === 'thread/read' && params.threadId === 'created-thread' ? { thread: { ...threadRead.thread, id: 'created-thread' } } : result;
    });
  }

  async function started() {
    const server = createFakeAppServer();
    refusesUntilFirstTurn(server);
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    await adapter.createConversation('/work/fractal');
    return { server, adapter };
  }

  test('loads as an empty, complete conversation', async () => {
    const { server, adapter } = await started();
    const loaded = await adapter.loadConversation(created);
    const events = []; for await (const event of loaded.events) events.push(event);
    expect(events).toEqual([]);
    expect(loaded.summary).toMatchObject({ ref: created, runtime: 'idle', captureCompleteness: 'complete' });
    expect(server.requests.filter((entry) => entry.method === 'thread/read').map((entry) => entry.params)).toEqual([
      { threadId: 'created-thread', includeTurns: true }, { threadId: 'created-thread', includeTurns: false },
    ]);
  });

  test('watches it from an empty history', async () => {
    const { adapter } = await started();
    const sink = vi.fn();
    const unsubscribe = await adapter.watchConversation(created, sink);
    expect(sink).not.toHaveBeenCalled();
    unsubscribe();
  });

  test('reads its model, effort and access from the thread/start response', async () => {
    const { adapter } = await started();
    await expect(adapter.readLastRun(created)).resolves.toEqual({ model: 'gpt-5.5', effort: 'medium' });
    await expect(adapter.readAccess(created)).resolves.toEqual(await new CodexAdapter(createFakeAppServer() as never, { realpath: async (value) => value }).readAccess(created));
  });

  test('takes its first message, then reads and resumes it like any thread', async () => {
    const { server, adapter } = await started();
    const run = await adapter.continueConversation(created, { text: 'First message' });
    expect(server.requests.at(-1)).toEqual({ method: 'turn/start', params: { threadId: 'created-thread', input: [{ type: 'text', text: 'First message', text_elements: [] }] } });
    await run.dispose();
    await adapter.loadConversation(created);
    expect(server.requests.filter((entry) => entry.method === 'thread/read').at(-1)?.params).toEqual({ threadId: 'created-thread', includeTurns: true });
  });

  test('does not stand in for a refusal once the first turn has started', async () => {
    const { server, adapter } = await started();
    const run = await adapter.continueConversation(created, { text: 'First message' });
    await run.dispose();
    const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    server.request.mockImplementation(async (method, params) => { if (method === 'thread/resume' || method === 'thread/read') throw unsupported(); return request(method, params); });
    await expect(adapter.loadConversation(created)).rejects.toThrow('list_turns is not supported yet');
    await expect(adapter.readLastRun(created)).rejects.toThrow('list_turns is not supported yet');
  });

  test('passes on any other refusal', async () => {
    const { server, adapter } = await started();
    const request = server.request.getMockImplementation() as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    server.request.mockImplementation(async (method, params) => { if (method === 'thread/resume' || method === 'thread/read') throw new JsonRpcError(-32603, 'internal error'); return request(method, params); });
    await expect(adapter.loadConversation(created)).rejects.toThrow('internal error');
    await expect(adapter.continueConversation(created, { text: 'First message' })).rejects.toThrow('internal error');
  });

  test('does not stand in for a thread it did not start', async () => {
    const server = createFakeAppServer();
    refusesUntilFirstTurn(server);
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    await expect(adapter.loadConversation(created)).rejects.toThrow('list_turns is not supported yet');
    await expect(adapter.readLastRun(created)).rejects.toThrow('list_turns is not supported yet');
  });
});
