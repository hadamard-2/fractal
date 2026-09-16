import { describe, expect, test, vi } from 'vitest';
import { ConversationRegistry } from '@/main/conversation-registry';
import { ConversationService } from '@/main/conversation-service';
import type { NativeEvent, NativeEventPayload } from '@/main/harness/reconciler';
import type { ConversationRun, HarnessAdapter, NativeEventSink } from '@/main/harness/types';
import type { ConversationRef, ConversationStreamEvent, ProviderId } from '@/shared/conversation-contract';

const capabilities = { create: true, partialStreaming: true, approvals: false, questions: false, interrupt: true, steerWhileRunning: false, fork: false };
const loadId = '00000000-0000-4000-8000-000000000010';

function nativeEvent(provider: ProviderId, nativeId: string, payload: NativeEventPayload): NativeEvent {
  return { provider, nativeId, nativeType: payload.kind, observedAt: Date.now(), payload };
}

function turn(provider: ProviderId, id: string, text: string): NativeEvent[] {
  return [
    nativeEvent(provider, `start:${id}`, { kind: 'turn-started', turnId: id, userMessageId: `user:${id}`, text }),
    nativeEvent(provider, `finish:${id}`, { kind: 'turn-finished', turnId: id, status: 'completed' }),
  ];
}

async function* events(values: NativeEvent[]) { yield* values; }

function createFakeNativeHarness(provider: ProviderId) {
  const ref: ConversationRef = { provider, nativeSessionId: 'native-1', projectPath: '/work/fractal' };
  const nativeEvents = turn(provider, 'external', 'First prompt');
  const messages = ['First prompt'];
  const sinks = new Set<NativeEventSink>();
  let idle = Promise.resolve();
  const adapter: HarnessAdapter = {
    provider,
    probe: async () => ({ provider, availability: 'available', capabilities }),
    capabilities: () => capabilities,
    listConversations: async () => [{ ref, title: 'Native conversation', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }],
    loadConversation: async () => ({ summary: { ref, title: 'Native conversation', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }, events: events(nativeEvents) }),
    watchConversation: async (_ref, sink) => { sinks.add(sink); return () => sinks.delete(sink); },
    createConversation: async () => ref,
    continueConversation: async (_ref, prompt) => {
      const continuation = turn(provider, 'continued', prompt.text);
      const run: ConversationRun = {
        events: (async function* () {
          for (const event of continuation) { nativeEvents.push(event); sinks.forEach((sink) => sink(event)); yield event; }
          messages.push(prompt.text);
        })(),
        interrupt: async () => undefined,
        resolveRequest: async () => undefined,
        dispose: async () => undefined,
      };
      idle = (async () => { for await (const event of run.events) void event; })();
      return { ...run, events: events(continuation) };
    },
  };
  return { adapter, ref, waitForIdle: () => idle, readNativeMessages: () => [...messages], inspectFractalTranscriptFiles: () => [] as string[] };
}

describe('native continuity', () => {
  test.each(['codex', 'claude'] as const)('%s starts external, continues in Fractal, and remains natively resumable', async (provider) => {
    const harness = createFakeNativeHarness(provider);
    const registry = new ConversationRegistry([harness.adapter], async (path) => path);
    const app = new ConversationService(registry, () => undefined);
    const listed = await app.list();
    const ref = listed.projects[0].conversations[0].ref;
    await app.open(ref, loadId);
    await app.continue(ref, { text: 'Second prompt' }, 'renderer');
    await harness.waitForIdle();
    expect(harness.readNativeMessages()).toEqual(['First prompt', 'Second prompt']);
    expect(harness.inspectFractalTranscriptFiles()).toEqual([]);

    const nativeClient = new ConversationService(new ConversationRegistry([harness.adapter], async (path) => path), () => undefined);
    const resumed: ConversationStreamEvent[] = [];
    const reopened = new ConversationService(new ConversationRegistry([harness.adapter], async (path) => path), (event) => resumed.push(event));
    expect((await nativeClient.list()).projects[0].conversations[0].ref).toEqual(ref);
    await reopened.open(ref, '00000000-0000-4000-8000-000000000012');
    expect(resumed.flatMap((event) => event.type === 'history.chunk' ? event.turns.map((item) => item.userMessage.text) : [])).toEqual(['First prompt', 'Second prompt']);
    await Promise.all([app.dispose(), nativeClient.dispose(), reopened.dispose()]);
  });

  test('reconciles a crash without duplicating persisted final work', async () => {
    const provider = 'codex' as const;
    const ref: ConversationRef = { provider, nativeSessionId: 'native-crash', projectPath: '/work/fractal' };
    const persisted = [
      nativeEvent(provider, 'start:crash', { kind: 'turn-started', turnId: 'crash', userMessageId: 'user:crash', text: 'Continue' }),
      nativeEvent(provider, 'tool-1', { kind: 'action-requested', turnId: 'crash', actionId: 'tool-1', actionKind: 'tool', label: 'Build' }),
    ];
    let crash = false;
    const adapter: HarnessAdapter = {
      provider, capabilities: () => capabilities,
      probe: async () => ({ provider, availability: 'available', capabilities }),
      listConversations: async () => [{ ref, title: 'Crash', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }],
      loadConversation: async () => ({ summary: { ref, title: 'Crash', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }, events: events(persisted) }),
      watchConversation: async () => () => undefined,
      createConversation: async () => ref,
      continueConversation: vi.fn(async () => ({
        events: (async function* () {
          yield nativeEvent(provider, 'start:crash', { kind: 'turn-started', turnId: 'crash', userMessageId: 'user:crash', text: 'Continue' });
          yield nativeEvent(provider, 'tool-1', { kind: 'action-requested', turnId: 'crash', actionId: 'tool-1', actionKind: 'tool', label: 'Build' });
          persisted.push(nativeEvent(provider, 'tool-1:final', { kind: 'action-updated', turnId: 'crash', actionId: 'tool-1', status: 'completed', output: 'done' }));
          persisted.push(nativeEvent(provider, 'finish:crash', { kind: 'turn-finished', turnId: 'crash', status: 'completed' }));
          crash = true;
          throw new Error('Provider process exited');
        })(),
        interrupt: async (): Promise<void> => undefined,
        resolveRequest: async (): Promise<void> => undefined,
        dispose: async (): Promise<void> => undefined,
      })),
    };
    const streamed: ConversationStreamEvent[] = [];
    const app = new ConversationService(new ConversationRegistry([adapter], async (path) => path), (event) => streamed.push(event));
    await app.open(ref, '00000000-0000-4000-8000-000000000011');
    await app.continue(ref, { text: 'Continue' }, 'renderer');
    await vi.waitFor(() => expect(crash).toBe(true));
    await vi.waitFor(() => expect(streamed.some((event) => event.type === 'runtime.changed' && event.runtime === 'idle')).toBe(true));
    const turns = streamed.flatMap((event) => event.type === 'history.chunk' ? event.turns : event.type === 'turn.upserted' ? [event.turn] : []);
    const final = turns.at(-1);
    expect(final).toMatchObject({ id: 'crash', status: 'completed', blocks: [{ kind: 'work-packet', actions: [{ id: 'tool-1', status: 'completed', outputSummary: 'done' }] }] });
    expect(final?.blocks.flatMap((block) => block.kind === 'work-packet' ? block.actions.filter((action) => action.id === 'tool-1') : [])).toHaveLength(1);
    await app.dispose();
  });
});
