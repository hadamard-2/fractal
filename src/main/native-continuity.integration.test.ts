import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import threadRead from '@/main/harness/codex/__fixtures__/thread-read.json';
import { CodexAdapter } from '@/main/harness/codex/codex-adapter';
import { ClaudeAdapter } from '@/main/harness/claude/claude-adapter';
import type { ClaudeTurnRun, RunClaudeTurnOptions } from '@/main/harness/claude/claude-runner';
import { ConversationRegistry } from '@/main/conversation-registry';
import { ConversationService } from '@/main/conversation-service';
import type { NativeEvent, NativeEventPayload } from '@/main/harness/reconciler';
import type { ConversationRun, HarnessAdapter } from '@/main/harness/types';
import type { ConversationRef, ConversationStreamEvent, HarnessCapabilities, ProviderId } from '@/shared/conversation-contract';

const loadIds = { codex: '00000000-0000-4000-8000-000000000010', claude: '00000000-0000-4000-8000-000000000011', crash: '00000000-0000-4000-8000-000000000012' };
const capabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: false, questions: false, interrupt: true, steerWhileRunning: false, fork: false };
const tempDirectories: string[] = [];

afterEach(async () => { await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function nativeEvent(provider: ProviderId, nativeId: string, payload: NativeEventPayload): NativeEvent { return { provider, nativeId, nativeType: payload.kind, observedAt: 1, payload }; }
async function* nativeEvents(values: readonly NativeEvent[]) { yield* values; }

function expectNoFractalTranscriptWriter(service: ConversationService): void {
  expect(Object.keys(service).some((key) => /store|storage|transcript|data.*path/i.test(key))).toBe(false);
}

function codexThread() {
  const thread = clone(threadRead.thread);
  thread.id = 'native-codex-1'; thread.sessionId = 'native-codex-session'; thread.name = null; thread.preview = 'First Codex prompt';
  thread.turns = [{ ...clone(thread.turns[0]), id: 'codex-external', items: [{ type: 'userMessage', id: 'codex-user-1', clientId: null, content: [{ type: 'text', text: 'First Codex prompt', text_elements: [] }] }, { type: 'agentMessage', id: 'codex-agent-1', text: 'External answer', phase: null, memoryCitation: null, delivery: null }] }];
  return thread;
}

function createCodexNativeBoundary() {
  const thread = codexThread();
  const listeners = new Set<(notification: never) => void>();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = {
    status: { availability: 'available' as const }, requests,
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'thread/list') return { data: [clone(thread)], nextCursor: null };
      if (method === 'thread/read') return { thread: clone(thread) };
      if (method === 'thread/resume') return { thread: clone(thread) };
      if (method === 'turn/start') {
        const input = params.input as Array<{ text: string }>;
        const turn = { ...clone(thread.turns[0]), id: 'codex-continued', status: 'completed', items: [{ type: 'userMessage', id: 'codex-user-2', clientId: null as string | null, content: [{ type: 'text', text: input[0].text, text_elements: [] as never[] }] }, { type: 'agentMessage', id: 'codex-agent-2', text: 'Fractal answer', phase: null as string | null, memoryCitation: null as never, delivery: null as never }] };
        queueMicrotask(() => { thread.turns.push(turn); listeners.forEach((listener) => listener({ method: 'turn/completed', params: { threadId: thread.id, turn: clone(turn) } } as never)); });
        return { turn: { ...turn, status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected native Codex operation: ${method}`);
    }),
    onNotification(listener: (notification: never) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    onServerRequest: (): (() => void) => () => undefined, onStatus: (): (() => void) => () => undefined,
    respond: (): void => undefined, respondError: (): void => undefined,
  };
  return {
    adapter: new CodexAdapter(server as never, { realpath: async (value) => value }),
    async nativeResumeAndRead(): Promise<string[]> {
      await server.request('thread/resume', { threadId: thread.id, cwd: thread.cwd });
      const snapshot = await server.request('thread/read', { threadId: thread.id });
      if (!('thread' in snapshot)) throw new Error('Native thread read failed');
      return snapshot.thread.turns.flatMap((turn) => turn.items.flatMap((item) => item.type === 'userMessage' ? item.content.flatMap((content) => content.type === 'text' ? [content.text] : []) : []));
    },
    requests,
  };
}

async function createClaudeNativeBoundary() {
  const root = await mkdtemp(path.join(tmpdir(), 'fractal-native-claude-'));
  tempDirectories.push(root);
  const transcript = path.join(root, 'native-claude-1.jsonl');
  const record = (value: object) => `${JSON.stringify(value)}\n`;
  await writeFile(transcript, record({ type: 'user', uuid: 'claude-user-1', parentUuid: null, sessionId: 'native-claude-1', cwd: '/work/fractal', timestamp: '2026-09-12T01:00:00.000Z', message: { role: 'user', content: 'First Claude prompt' } }));
  const runTurn = vi.fn((options: RunClaudeTurnOptions): ClaudeTurnRun => {
    const events = (async function* () {
      await appendFile(transcript, record({ type: 'user', uuid: 'claude-user-2', parentUuid: 'claude-user-1', sessionId: 'native-claude-1', cwd: '/work/fractal', timestamp: '2026-09-12T01:00:01.000Z', message: { role: 'user', content: options.prompt.text } }));
      await appendFile(transcript, record({ type: 'assistant', uuid: 'claude-agent-2', parentUuid: 'claude-user-2', sessionId: 'native-claude-1', cwd: '/work/fractal', timestamp: '2026-09-12T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Fractal answer' }] } }));
      yield* await options.rereadNative() as NativeEvent[];
    })();
    return { events, completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: async () => undefined };
  });
  const dependencies = { realpath: async (value: string) => value, probe: async () => ({ provider: 'claude' as const, availability: 'available' as const, capabilities }), runtime: async () => 'idle' as const, runTurn };
  return {
    adapter: new ClaudeAdapter(root, dependencies), runTurn,
    async nativeResumeAndRead(): Promise<string[]> {
      const adapter = new ClaudeAdapter(root, dependencies);
      const [summary] = await adapter.listConversations();
      const loaded = await adapter.loadConversation(summary.ref);
      const prompts: string[] = [];
      for await (const event of loaded.events) if (event.payload.kind === 'turn-started') prompts.push(event.payload.text);
      return prompts;
    },
  };
}

describe('native continuity at provider boundaries', () => {
  test('Codex starts in App Server state, continues through CodexAdapter, and remains App Server resumable', async () => {
    const native = createCodexNativeBoundary();
    const service = new ConversationService(new ConversationRegistry([native.adapter], async (value) => value), () => undefined);
    const ref = (await service.list()).projects[0].conversations[0].ref;
    await service.open(ref, loadIds.codex);
    await service.continue(ref, { text: 'Second Codex prompt' }, 'renderer');
    await vi.waitFor(() => expect(native.requests.some((request) => request.method === 'turn/start')).toBe(true));
    await vi.waitFor(async () => expect(await native.nativeResumeAndRead()).toEqual(['First Codex prompt', 'Second Codex prompt']));
    expect(native.requests.filter((request) => request.method === 'thread/resume')).toHaveLength(2);
    expectNoFractalTranscriptWriter(service);
    await service.dispose();
  });

  test('Claude starts in provider JSONL, continues through ClaudeAdapter runner resume, and remains natively readable', async () => {
    const native = await createClaudeNativeBoundary();
    const service = new ConversationService(new ConversationRegistry([native.adapter], async (value) => value), () => undefined);
    const ref = (await service.list()).projects[0].conversations[0].ref;
    await service.open(ref, loadIds.claude);
    await service.continue(ref, { text: 'Second Claude prompt' }, 'renderer');
    await vi.waitFor(() => expect(native.runTurn).toHaveBeenCalled());
    await vi.waitFor(async () => expect(await native.nativeResumeAndRead()).toEqual(['First Claude prompt', 'Second Claude prompt']));
    expect(native.runTurn).toHaveBeenCalledWith(expect.objectContaining({ ref }));
    expect(native.runTurn.mock.calls[0][0]).not.toHaveProperty('newSession');
    expectNoFractalTranscriptWriter(service);
    await service.dispose();
  });
});

describe('native crash reconciliation', () => {
  test('does not emit a persisted final native observation twice after its stream crashes', async () => {
    const provider = 'codex' as const;
    const ref: ConversationRef = { provider, nativeSessionId: 'native-crash', projectPath: '/work/fractal' };
    const start = nativeEvent(provider, 'start:crash', { kind: 'turn-started', turnId: 'crash', userMessageId: 'user:crash', text: 'Continue' });
    const finalObservation = nativeEvent(provider, 'native-final-X', { kind: 'unsupported', turnId: 'crash', summary: 'Provider final marker', captureCompleteness: 'partial' });
    let persisted: NativeEvent[] = [start];
    const adapter: HarnessAdapter = {
      provider, capabilities: () => capabilities,
      probe: async () => ({ provider, availability: 'available', capabilities }),
      listConversations: async () => [{ ref, title: 'Crash', updatedAt: 1, runtime: 'idle', captureCompleteness: 'partial' }],
      loadConversation: async () => ({ summary: { ref, title: 'Crash', updatedAt: 1, runtime: 'idle', captureCompleteness: 'partial' }, events: nativeEvents(persisted) }),
      watchConversation: async () => () => undefined, createConversation: async () => ref,
      continueConversation: async (): Promise<ConversationRun> => ({
        events: (async function* () { yield start; yield finalObservation; persisted = [start, finalObservation]; throw new Error('Provider process exited'); })(),
        interrupt: async () => undefined, resolveRequest: async () => undefined, dispose: async () => undefined,
      }),
    };
    const emitted: ConversationStreamEvent[] = [];
    const projected = vi.spyOn(ConversationService.prototype as never, 'project');
    const service = new ConversationService(new ConversationRegistry([adapter], async (value) => value), (event) => emitted.push(event));
    await service.open(ref, loadIds.crash);
    await service.continue(ref, { text: 'Continue' }, 'renderer');
    await vi.waitFor(() => expect(emitted.some((event) => event.type === 'runtime.changed' && event.runtime === 'idle')).toBe(true));
    expect(projected.mock.calls.filter(([, event]) => (event as NativeEvent).nativeId === finalObservation.nativeId)).toHaveLength(1);
    expect(emitted.some((event) => event.type === 'turn.upserted' && event.turn.blocks.some((block) => block.id === finalObservation.nativeId))).toBe(true);
    projected.mockRestore();
    await service.dispose();
  });
});
