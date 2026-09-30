import path from 'node:path';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import { ClaudeAdapter } from '@/main/harness/claude/claude-adapter';
import type { NativeEvent } from '@/main/harness/reconciler';
import type { BlockingRequest, HarnessStatus, UserDecision } from '@/shared/conversation-contract';
import type { ClaudeTurnRun, RunClaudeTurnOptions } from './claude-runner';
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
  test('hands the prompt model choice to the runner', async () => {
    const runTurn = vi.fn((_options: RunClaudeTurnOptions): ClaudeTurnRun => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn });
    const run = await adapter.continueConversation(ref, { text: 'Go', model: 'opus', effort: 'high' });
    expect(runTurn.mock.calls[0][0]).toMatchObject({ model: 'opus', effort: 'high' });
    await run.dispose();
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

  test('renames by appending a custom-title record, and refuses a file mid-write or a subagent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-adapter-rename-'));
    const file = path.join(directory, 'project', 'session-1.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"type":"user","uuid":"a","sessionId":"session-1","cwd":"/work/fractal","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"Original"}}\n');
    await mkdir(path.join(directory, 'project', 'session-1', 'subagents'), { recursive: true });
    await writeFile(path.join(directory, 'project', 'session-1', 'subagents', 'agent-a1.jsonl'), '{"type":"user","uuid":"c","isSidechain":true,"sessionId":"session-1","cwd":"/work/fractal","message":{"role":"user","content":"Child"}}\n');
    const adapter = new ClaudeAdapter(directory, { realpath });
    const session = { ...ref, nativeSessionId: 'session-1' };

    await adapter.renameConversation(session, 'Renamed chat');
    expect((await readFile(file, 'utf8')).trimEnd().split('\n').at(-1)).toBe('{"type":"custom-title","customTitle":"Renamed chat","sessionId":"session-1"}');
    // The untimestamped rename record must not count as activity.
    expect((await adapter.listConversations()).find((item) => item.ref.nativeSessionId === 'session-1')).toMatchObject({ title: 'Renamed chat', updatedAt: Date.parse('2026-09-01T10:00:00.000Z') });

    await appendFile(file, '{"type":"assistant","partial":');
    await expect(adapter.renameConversation(session, 'Again')).rejects.toThrow('being written');
    await expect(adapter.renameConversation({ ...ref, nativeSessionId: 'session-1/agent-a1' }, 'Child')).rejects.toThrow('Subagent conversations are read-only');
    await rm(directory, { recursive: true, force: true });
  });

  test('loads a subagent transcript but refuses to continue it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-adapter-subagent-'));
    await mkdir(path.join(directory, 'project', 'parent', 'subagents'), { recursive: true });
    await writeFile(path.join(directory, 'project', 'parent', 'subagents', 'agent-a1.jsonl'), '{"type":"user","uuid":"c","isSidechain":true,"sessionId":"parent","cwd":"/work/fractal","message":{"role":"user","content":"Child"}}\n');
    const runTurn = vi.fn();
    const adapter = new ClaudeAdapter(directory, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn });
    const child = { ...ref, nativeSessionId: 'parent/agent-a1' };
    expect((await adapter.loadConversation(child)).summary.parentId).toBe('parent');
    await expect(adapter.continueConversation(child, { text: 'continue' })).rejects.toThrow('Subagent conversations are read-only');
    expect(runTurn).not.toHaveBeenCalled();
    await rm(directory, { recursive: true, force: true });
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

  test('composes the attachment block and reads images into the runner prompt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-attach-'));
    const image = path.join(directory, 'shot.png');
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const runTurn = vi.fn((_options: RunClaudeTurnOptions): ClaudeTurnRun => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn });
    const run = await adapter.continueConversation(ref, { text: 'Compare', attachments: [{ path: '/repo/a.ts' }, { path: image, image: 'image/png' }] });
    expect(runTurn.mock.calls[0][0].prompt).toEqual({
      text: 'Compare\n\n<attachments>\n/repo/a.ts\n</attachments>',
      images: [{ mediaType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') }],
    });
    await run.dispose(); await rm(directory, { recursive: true, force: true });
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

  test('propagates a failed runner completion even when its event stream closes cleanly', async () => {
    const ownedProcesses = new ClaudeOwnedProcessRegistry();
    let fail!: (error: Error) => void;
    const completion = new Promise<never>((_resolve, reject) => { fail = reject; });
    const runTurn = (): ClaudeTurnRun => ({
      events: (async function* () { yield { provider: 'claude', nativeId: 'native-user', nativeType: 'user', observedAt: 1, payload: { kind: 'turn-started', turnId: 'native-user', userMessageId: 'native-user', text: 'go' } } as NativeEvent; })(),
      completion, interrupt: vi.fn(async () => undefined),
    });
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn, startBridge: async () => ({ configPath: '/tmp/private.json', toolName: 'permission', dispose: async () => undefined }), ownedProcesses });
    const run = await adapter.continueConversation(ref, { text: 'go' });
    const observed: NativeEvent[] = [];
    const reading = (async () => { for await (const event of run.events) observed.push(event); })();
    fail(new Error('Claude process exited with code 1'));
    await expect(reading).rejects.toThrow('Claude process exited with code 1');
    expect(observed.map((event) => event.nativeId)).toEqual(['native-user']);
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
    expect(runTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({ ref: draft, newSession: true }));
    await adapter.continueConversation(draft, { text: 'again' });
    expect(calls[1]).toEqual({ newSession: undefined });
  });
});

async function collect(iterable: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> { const values: NativeEvent[] = []; for await (const value of iterable) values.push(value); return values; }
