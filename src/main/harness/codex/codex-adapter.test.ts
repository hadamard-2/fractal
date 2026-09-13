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

function createFakeAppServer(pages = [[thread('newer')], [thread('older')]]) {
  const listeners = new Set<(notification: unknown) => void>();
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    status: { availability: 'available' as const }, requests,
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'thread/list') {
        const index = params.cursor === 'next' ? 1 : 0;
        return { data: pages[index] ?? [], nextCursor: index === 0 ? 'next' : null };
      }
      if (method === 'thread/read') return { thread: threadRead.thread };
      throw new Error(`unexpected ${method}`);
    }),
    onNotification: vi.fn((listener: (notification: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(notification: unknown) { listeners.forEach((listener) => listener(notification)); },
    listenerCount() { return listeners.size; },
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
    const server = createFakeAppServer([[thread('newer'), thread('older')], [thread('older')]]);
    const summaries = await new CodexAdapter(server as never, { realpath: async (value) => value }).listConversations();

    expect(summaries.map((summary) => summary.ref.nativeSessionId)).toEqual(['newer', 'older']);
    expect(server.requests).toHaveLength(2);
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
});
