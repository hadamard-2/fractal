import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConversationHub } from '@/renderer/conversation-hub';
import { quoteSelection, submitDraft, type SideChatRequest } from '@/renderer/side-chat-start';
import type { ConversationApi, ConversationRef, ConversationStreamEvent, HarnessCapabilities, ModelChoice } from '@/shared/conversation-contract';

const root: ConversationRef = { provider: 'claude', nativeSessionId: 'root', projectPath: '/work' };
const side: ConversationRef = { provider: 'claude', nativeSessionId: 'side', projectPath: '/work' };
const forked: ConversationRef = { provider: 'claude', nativeSessionId: 'forked', projectPath: '/work' };
const capabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: true };

function fakeHub() {
  const listeners = new Set<(event: ConversationStreamEvent) => void>();
  const api = {
    open: vi.fn<ConversationApi['open']>(async (ref) => ({ summary: { ref, title: 'Side', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }, capabilities })),
    close: vi.fn<ConversationApi['close']>().mockResolvedValue(),
    continue: vi.fn<ConversationApi['continue']>().mockResolvedValue(),
    interrupt: vi.fn<ConversationApi['interrupt']>().mockResolvedValue(),
    resolveRequest: vi.fn<ConversationApi['resolveRequest']>().mockResolvedValue(),
    onEvent: vi.fn<ConversationApi['onEvent']>((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  };
  const hub = new ConversationHub(api);
  /** Delivers the conversation's whole history once the hub has opened it. */
  const complete = async (ref: ConversationRef) => {
    await vi.waitFor(() => expect(hub.state(ref).capabilities).toEqual(capabilities));
    const loadId = hub.state(ref).loadId ?? '';
    for (const listener of listeners) listener({ ref, loadId, seq: 0, type: 'history.complete' });
  };
  return { hub, api, complete };
}

function deps(hub: ConversationHub, overrides: Partial<Parameters<typeof submitDraft>[1]> = {}) {
  return {
    hub,
    fork: vi.fn<ConversationApi['fork']>().mockResolvedValue(forked),
    deleteSideChat: vi.fn<ConversationApi['deleteSideChat']>().mockResolvedValue(),
    modelChoice: vi.fn<(ref: ConversationRef) => Promise<ModelChoice | null>>().mockResolvedValue({ model: 'opus', effort: 'high' }),
    refreshSideChats: vi.fn<() => Promise<void>>().mockResolvedValue(),
    ...overrides,
  };
}

const draft: SideChatRequest = { parent: root, afterTurnId: 't1', text: 'Why?' };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('quoteSelection', () => {
  test('prefixes every line with "> " and ends with a blank line', () => {
    expect(quoteSelection('one\ntwo')).toBe('> one\n> two\n\n');
  });

  test('drops the whitespace around the selection', () => {
    expect(quoteSelection('\n  one\n')).toBe('> one\n\n');
  });
});

describe('submitDraft, new side chat', () => {
  test('forks after the turn, refreshes the side chats, and sends with the parent\'s model choice once the history is complete and idle', async () => {
    const { hub, api, complete } = fakeHub();
    const d = deps(hub);
    const submitted = submitDraft(draft, d);

    await vi.waitFor(() => expect(d.refreshSideChats).toHaveBeenCalled());
    expect(d.fork).toHaveBeenCalledWith(root, { turnId: 't1', position: 'after' }, 'side-chat');
    expect(api.continue).not.toHaveBeenCalled();

    await complete(forked);
    await expect(submitted).resolves.toEqual(forked);
    expect(api.continue).toHaveBeenCalledWith(forked, { text: 'Why?', model: 'opus', effort: 'high' });
    expect(api.continue.mock.calls[0][1]).not.toHaveProperty('access');
    expect(d.modelChoice).toHaveBeenCalledTimes(1);
    expect(d.modelChoice).toHaveBeenCalledWith(root);
    expect(d.deleteSideChat).not.toHaveBeenCalled();
  });

  test('a null model choice sends the text alone', async () => {
    const { hub, api, complete } = fakeHub();
    const submitted = submitDraft(draft, deps(hub, { modelChoice: vi.fn().mockResolvedValue(null) }));
    await complete(forked);
    await submitted;
    expect(api.continue).toHaveBeenCalledWith(forked, { text: 'Why?' });
  });

  test('holds the side chat open while it waits and sends, and lets go after', async () => {
    const { hub, api, complete } = fakeHub();
    const submitted = submitDraft(draft, deps(hub));
    await vi.waitFor(() => expect(api.open).toHaveBeenCalledWith(forked, expect.any(String)));
    await complete(forked);
    await submitted;
    await vi.waitFor(() => expect(api.close).toHaveBeenCalledWith(forked));
  });

  test('a failed fork rejects and sends nothing', async () => {
    const { hub, api } = fakeHub();
    const d = deps(hub, { fork: vi.fn<ConversationApi['fork']>().mockRejectedValue(new Error('no')) });
    await expect(submitDraft(draft, d)).rejects.toThrow("Couldn't start the side chat.");
    expect(api.continue).not.toHaveBeenCalled();
    expect(d.deleteSideChat).not.toHaveBeenCalled();
  });

  test('a history that does not complete in time rejects and deletes the new side chat', async () => {
    vi.useFakeTimers();
    const { hub, api } = fakeHub();
    const d = deps(hub, { timeoutMs: 1000 });
    const submitted = submitDraft(draft, d);
    const outcome = expect(submitted).rejects.toThrow("Couldn't start the side chat.");
    await vi.advanceTimersByTimeAsync(999);
    expect(d.deleteSideChat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(api.continue).not.toHaveBeenCalled();
    expect(d.deleteSideChat).toHaveBeenCalledWith(forked);
    // Listed again, so the deleted side chat leaves the map.
    expect(d.refreshSideChats).toHaveBeenCalledTimes(2);
  });

  test('waits 30 seconds by default', async () => {
    vi.useFakeTimers();
    const { hub } = fakeHub();
    const d = deps(hub);
    const outcome = expect(submitDraft(draft, d)).rejects.toThrow("Couldn't start the side chat.");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(d.deleteSideChat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  test('a failed first send deletes the new side chat, ignoring a failed delete', async () => {
    const { hub, api, complete } = fakeHub();
    api.continue.mockRejectedValue(new Error('busy'));
    const d = deps(hub, { deleteSideChat: vi.fn<ConversationApi['deleteSideChat']>().mockRejectedValue(new Error('gone')) });
    const submitted = submitDraft(draft, d);
    const outcome = expect(submitted).rejects.toThrow("Couldn't start the side chat.");
    await complete(forked);
    await outcome;
    expect(d.deleteSideChat).toHaveBeenCalledWith(forked);
  });
});

describe('submitDraft, onStarted', () => {
  test('is called once with the forked ref, before the model choice and the send', async () => {
    const { hub, api, complete } = fakeHub();
    const order: string[] = [];
    const onStarted = vi.fn((ref: ConversationRef) => { order.push(`started:${ref.nativeSessionId}`); });
    const d = deps(hub, {
      onStarted,
      modelChoice: vi.fn(async () => { order.push('modelChoice'); return null; }),
    });
    api.continue.mockImplementation(async () => { order.push('send'); });
    const submitted = submitDraft(draft, d);
    await complete(forked);
    await submitted;
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['started:forked', 'modelChoice', 'send']);
  });

  test('is called before the history is read', async () => {
    const { hub, api } = fakeHub();
    const onStarted = vi.fn();
    const submitted = submitDraft(draft, deps(hub, { onStarted, timeoutMs: 10 }));
    const outcome = expect(submitted).rejects.toThrow("Couldn't start the side chat.");
    await outcome;
    expect(onStarted).toHaveBeenCalledWith(forked);
    expect(api.continue).not.toHaveBeenCalled();
  });

  test('is not called when the fork fails', async () => {
    const { hub } = fakeHub();
    const onStarted = vi.fn();
    const d = deps(hub, { onStarted, fork: vi.fn<ConversationApi['fork']>().mockRejectedValue(new Error('no')) });
    await expect(submitDraft(draft, d)).rejects.toThrow("Couldn't start the side chat.");
    expect(onStarted).not.toHaveBeenCalled();
  });

  test('is not called when the request continues a side chat', async () => {
    const { hub, complete } = fakeHub();
    const release = hub.acquire(side);
    await complete(side);
    const onStarted = vi.fn();
    await submitDraft({ text: 'Why?', continues: side }, deps(hub, { onStarted }));
    expect(onStarted).not.toHaveBeenCalled();
    release();
  });
});

describe('submitDraft, continuing', () => {
  const continuing: SideChatRequest = { text: 'Why?', continues: side };

  test('sends to the side chat without forking', async () => {
    const { hub, api, complete } = fakeHub();
    const release = hub.acquire(side);
    await complete(side);
    const d = deps(hub);
    await expect(submitDraft(continuing, d)).resolves.toEqual(side);
    expect(d.fork).not.toHaveBeenCalled();
    expect(api.continue).toHaveBeenCalledWith(side, { text: 'Why?', model: 'opus', effort: 'high' });
    expect(d.modelChoice).toHaveBeenCalledTimes(1);
    expect(d.modelChoice).toHaveBeenCalledWith(side);
    release();
  });

  test('a failed send rejects, and deletes nothing', async () => {
    const { hub, api, complete } = fakeHub();
    const release = hub.acquire(side);
    await complete(side);
    api.continue.mockRejectedValue(new Error('busy'));
    const d = deps(hub);
    await expect(submitDraft(continuing, d)).rejects.toThrow("Couldn't send to the side chat.");
    expect(d.deleteSideChat).not.toHaveBeenCalled();
    release();
  });

  test('a side chat that can\'t take a message yet rejects', async () => {
    const { hub } = fakeHub();
    await expect(submitDraft(continuing, deps(hub))).rejects.toThrow("Couldn't send to the side chat.");
  });
});
