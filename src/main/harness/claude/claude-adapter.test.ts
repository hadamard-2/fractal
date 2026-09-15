import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { ClaudeAdapter } from '@/main/harness/claude/claude-adapter';
import type { NativeEvent } from '@/main/harness/reconciler';
import type { BlockingRequest, HarnessStatus, UserDecision } from '@/shared/conversation-contract';
import type { ClaudeTurnRun } from './claude-runner';
import { ClaudeOwnedProcessRegistry } from './claude-owned-process-registry';

const root = path.join(import.meta.dirname, '__fixtures__');
const ref = { provider: 'claude' as const, nativeSessionId: 'claude-session-1', projectPath: '/canonical/fractal' };
const realpath = async (input: string) => input === '/work/fractal' ? '/canonical/fractal' : input;
const available: HarnessStatus = {
  provider: 'claude', availability: 'available',
  capabilities: { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false },
};

describe('Claude adapter', () => {
  test('discovers canonical summaries without leaking native file locators', async () => {
    const adapter = new ClaudeAdapter(root, { realpath });
    expect((await adapter.probe()).availability).toBe('available');
    const summaries = await adapter.listConversations();
    expect(summaries.find((item) => item.ref.nativeSessionId === ref.nativeSessionId)).toMatchObject({ ref, title: 'Inspect the parser' });
    expect(JSON.stringify(summaries)).not.toContain('.jsonl');
    expect(adapter.capabilities()).toMatchObject({ create: false, approvals: false, questions: false, interrupt: false });
  });
  test('loads normalized history using a discovered locator and rejects forged refs', async () => {
    const adapter = new ClaudeAdapter(root, { realpath });
    const loaded = await adapter.loadConversation(ref); const events: NativeEvent[] = [];
    for await (const event of loaded.events) events.push(event);
    expect(loaded.summary.ref).toEqual(ref);
    expect(events.some((event) => event.payload.kind === 'turn-started' && event.payload.text === 'Inspect the parser')).toBe(true);
    for (const forged of [{ ...ref, projectPath: '/wrong' }, { ...ref, nativeSessionId: '../../private' }, { ...ref, provider: 'codex' as const }]) {
      await expect(adapter.loadConversation(forged)).rejects.toThrow();
      await expect(adapter.watchConversation(forged, vi.fn())).rejects.toThrow();
    }
  });
  test('opens and releases the reviewed native watcher', async () => {
    const adapter = new ClaudeAdapter(root, { realpath });
    const unsubscribe = await adapter.watchConversation(ref, vi.fn());
    expect(unsubscribe).toBeTypeOf('function'); unsubscribe(); unsubscribe();
  });
  test('reports missing history without native error details and rejects creation/continuation', async () => {
    const adapter = new ClaudeAdapter(path.join(root, 'absent-private-path'), { realpath });
    expect(await adapter.probe()).toMatchObject({ provider: 'claude', availability: 'unavailable', message: 'Claude conversation history is unavailable.' });
    await expect(adapter.createConversation('/repo')).rejects.toThrow('not available');
    await expect(adapter.continueConversation(ref, { text: 'hi' })).rejects.toThrow('not available');
  });

  test('reports probed approval and question capabilities independently', async () => {
    const probe = vi.fn(async () => ({ ...available, capabilities: { ...available.capabilities, questions: false } }));
    const adapter = new ClaudeAdapter(root, { realpath, probe });
    expect(await adapter.probe()).toMatchObject({ capabilities: { approvals: true, questions: false } });
    expect(adapter.capabilities()).toMatchObject({ approvals: true, questions: false });
  });

  test.each(['active-externally', 'unknown'] as const)('refuses continuation when runtime is %s', async (runtime) => {
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => runtime });
    await expect(adapter.continueConversation(ref, { text: 'continue' })).rejects.toThrow('Conversation is not idle');
  });

  test('routes each bridge request exactly once and keeps resolved decisions in the event stream', async () => {
    let route!: (request: BlockingRequest, signal: AbortSignal) => Promise<UserDecision>;
    const disposeBridge = vi.fn(async () => undefined);
    const startBridge = vi.fn(async (options: { onRequest(request: BlockingRequest, signal: AbortSignal): Promise<UserDecision> }) => {
      route = options.onRequest;
      return { configPath: '/tmp/private.json', toolName: 'mcp__fractal__permission', dispose: disposeBridge };
    });
    let finish!: () => void;
    const runTurn = vi.fn((): ClaudeTurnRun => ({
      events: (async function* () { await new Promise<void>((resolve) => { finish = resolve; }); yield* [] as NativeEvent[]; })(),
      completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined),
    }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', startBridge, runTurn });
    const run = await adapter.continueConversation(ref, { text: 'continue' });
    const iterator = run.events[Symbol.asyncIterator]();
    const opened = iterator.next();
    const request: BlockingRequest = { id: 'approval-1', kind: 'approval', provider: 'claude', title: 'Run', operation: 'pnpm test', status: 'open' };
    const decision = route(request, new AbortController().signal);
    await expect(opened).resolves.toMatchObject({ value: { payload: { kind: 'request-opened' } } });
    await run.resolveRequest('approval-1', { kind: 'allow-once' });
    await expect(decision).resolves.toEqual({ kind: 'allow-once' });
    await expect(run.resolveRequest('approval-1', { kind: 'deny' })).rejects.toThrow('no longer available');
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'request-resolved' } } });
    finish(); await run.dispose(); expect(disposeBridge).toHaveBeenCalledOnce();
  });

  test('denies and audits a pending bridge request before closing a naturally ended turn', async () => {
    let route!: (request: BlockingRequest, signal: AbortSignal) => Promise<UserDecision>;
    const controller = new AbortController();
    const startBridge = vi.fn(async (options: { onRequest(request: BlockingRequest, signal: AbortSignal): Promise<UserDecision> }) => {
      route = options.onRequest;
      return { configPath: '/tmp/private.json', toolName: 'mcp__fractal__permission', dispose: async () => controller.abort('Permission bridge closed') };
    });
    let finish!: () => void;
    const runTurn = vi.fn((): ClaudeTurnRun => ({
      events: (async function* () { await new Promise<void>((resolve) => { finish = resolve; }); yield* [] as NativeEvent[]; })(),
      completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined),
    }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', startBridge, runTurn });
    const run = await adapter.continueConversation(ref, { text: 'continue' });
    const decision = route({ id: 'pending', kind: 'approval', provider: 'claude', title: 'Run', operation: 'pnpm test', status: 'open' }, controller.signal);
    finish();
    const events = await collect(run.events);
    await expect(decision).resolves.toEqual({ kind: 'deny', reason: 'Permission bridge closed' });
    expect(events.map((event) => event.payload.kind)).toEqual(['request-opened', 'request-resolved']);
    expect(events[1]?.payload).toMatchObject({ decision: { kind: 'deny', reason: 'Permission bridge closed' } });
  });

  test('tracks owned processes before spawn and clears ownership on success and failure', async () => {
    const ownedProcesses = new ClaudeOwnedProcessRegistry();
    let finish!: () => void;
    const runTurn = vi.fn((): ClaudeTurnRun => {
      expect(ownedProcesses.has(ref)).toBe(true);
      return {
        events: (async function* () { await new Promise<void>((resolve) => { finish = resolve; }); yield* [] as NativeEvent[]; })(),
        completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined),
      };
    });
    const startBridge = vi.fn(async () => ({ configPath: '/tmp/private.json', toolName: 'mcp__fractal__permission', dispose: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn, startBridge, ownedProcesses });
    const successful = await adapter.continueConversation(ref, { text: 'continue' });
    expect(ownedProcesses.has(ref)).toBe(true); finish(); await collect(successful.events);
    expect(ownedProcesses.has(ref)).toBe(false);

    runTurn.mockImplementationOnce((): ClaudeTurnRun => {
      expect(ownedProcesses.has(ref)).toBe(true);
      return { events: (async function* () { yield* [] as NativeEvent[]; throw new Error('stream failed'); })(), completion: Promise.resolve({ exitCode: 1, signal: null }), interrupt: vi.fn(async () => undefined) };
    });
    const failed = await adapter.continueConversation(ref, { text: 'again' });
    await expect(collect(failed.events)).rejects.toThrow('stream failed');
    expect(ownedProcesses.has(ref)).toBe(false);
  });

  test('retains ownership after interrupt and during disposal until the process stream settles', async () => {
    const ownedProcesses = new ClaudeOwnedProcessRegistry();
    let finish!: () => void;
    const interrupt = vi.fn(async () => undefined);
    const runTurn = vi.fn((): ClaudeTurnRun => ({
      events: (async function* () { await new Promise<void>((resolve) => { finish = resolve; }); yield* [] as NativeEvent[]; })(),
      completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt,
    }));
    const startBridge = vi.fn(async () => ({ configPath: '/tmp/private.json', toolName: 'mcp__fractal__permission', dispose: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn, startBridge, ownedProcesses });
    const run = await adapter.continueConversation(ref, { text: 'continue' });

    await run.interrupt();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(ownedProcesses.has(ref)).toBe(true);

    let disposed = false;
    const disposal = run.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(ownedProcesses.has(ref)).toBe(true);

    finish();
    await disposal;
    expect(ownedProcesses.has(ref)).toBe(false);
  });

  test('creates UUID drafts in memory, uses session-id once, and later resumes the exact native session', async () => {
    const draftId = '123e4567-e89b-42d3-a456-426614174000';
    const calls: Array<{ newSession?: boolean }> = [];
    const runTurn = vi.fn((options): ClaudeTurnRun => {
      calls.push({ newSession: options.newSession });
      return { events: (async function* () { await options.rereadNative(); yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) };
    });
    const startBridge = vi.fn(async () => ({ configPath: '/tmp/private.json', toolName: 'mcp__fractal__permission', dispose: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', randomUUID: () => draftId, runTurn, startBridge, rereadNative: async () => [] });
    const draft = await adapter.createConversation('/work/fractal');
    expect(draft).toEqual({ provider: 'claude', nativeSessionId: draftId, projectPath: '/canonical/fractal' });
    const first = await adapter.continueConversation(draft, { text: 'begin' }); await collect(first.events); await first.dispose();
    expect(calls[0]).toEqual({ newSession: true });
    await adapter.continueConversation(draft, { text: 'again' });
    expect(calls[1]).toEqual({ newSession: undefined });
  });
});

async function collect(iterable: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> { const values: NativeEvent[] = []; for await (const value of iterable) values.push(value); return values; }
