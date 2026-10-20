import type { Node } from '@xyflow/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConversationHub } from '@/renderer/conversation-hub';
import type { MapNodeData, SideChatDraft } from '@/renderer/map/map-graph';
import { initialConversationState } from '@/renderer/conversation-reducer';
import { canBranchFrom, draftFromConnectEnd, draftFromMessage, draftsReducer, handOffNodeId, quoteSelection, submitDraft } from '@/renderer/map/side-chat-drafts';
import { conversationKey, type ConversationApi, type ConversationRef, type ConversationStreamEvent, type ConversationTurn, type HarnessCapabilities, type ModelChoice, type SideChatSummary } from '@/shared/conversation-contract';

const root: ConversationRef = { provider: 'claude', nativeSessionId: 'root', projectPath: '/work' };
const side: ConversationRef = { provider: 'claude', nativeSessionId: 'side', projectPath: '/work' };
const forked: ConversationRef = { provider: 'claude', nativeSessionId: 'forked', projectPath: '/work' };
const capabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: true };

const turn = (id: string, status: ConversationTurn['status'] = 'completed'): ConversationTurn => ({
  id, nativeId: id, userMessage: { id: `${id}-user`, text: 'Ask' }, blocks: [], status, captureCompleteness: 'complete',
});

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

const draft: SideChatDraft = { id: 'd1', parent: root, afterTurnId: 't1', text: 'Why?' };

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

describe('submitDraft, continuing', () => {
  const continuing: SideChatDraft = { ...draft, parent: side, continues: side };

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

describe('drafts', () => {
  test('add, move and remove change only the draft named', () => {
    const other: SideChatDraft = { ...draft, id: 'd2' };
    let drafts = draftsReducer([], { type: 'add', draft });
    drafts = draftsReducer(drafts, { type: 'add', draft: other });
    drafts = draftsReducer(drafts, { type: 'move', id: 'd1', position: { x: 20, y: 40 } });
    expect(drafts).toEqual([{ ...draft, position: { x: 20, y: 40 } }, other]);
    expect(draftsReducer(drafts, { type: 'remove', id: 'd1' })).toEqual([other]);
    expect(draftsReducer(drafts, { type: 'remove', id: 'missing' })).toBe(drafts);
  });
});

type ReplyData = Extract<MapNodeData, { kind: 'reply' }>;
const reply = (overrides: Partial<ReplyData> = {}): ReplyData => ({ kind: 'reply', owner: root, line: 'main', turn: turn('t1'), latest: false, canBranch: true, ...overrides });
const fromNode = (data: MapNodeData) => ({ data }) as Pick<Node<MapNodeData>, 'data'>;
const branch = (data: MapNodeData) => ({ fromNode: fromNode(data), fromHandle: { id: 'branch' as string | null }, toNode: null as unknown });
const drop = { clientX: 300, clientY: 200, target: null as EventTarget | null };
const toFlow = vi.fn(({ x, y }: { x: number; y: number }) => ({ x: x / 2, y: y / 2 }));

describe('draftFromConnectEnd', () => {
  test('a drop on empty canvas starts a side chat after a main-line reply, at the drop point in flow coordinates', () => {
    expect(draftFromConnectEnd(branch(reply()), drop, toFlow, 'd1')).toEqual({ id: 'd1', parent: root, afterTurnId: 't1', text: '', position: { x: 150, y: 100 } });
    expect(toFlow).toHaveBeenCalledWith({ x: 300, y: 200 });
  });

  test('the main line\'s latest reply also starts a side chat', () => {
    expect(draftFromConnectEnd(branch(reply({ latest: true })), drop, toFlow, 'd1')?.continues).toBeUndefined();
  });

  test('a side chat\'s earlier reply starts a nested side chat after it', () => {
    const draftFromSide = draftFromConnectEnd(branch(reply({ owner: side, line: 'side', turn: turn('s1') })), drop, toFlow, 'd1');
    expect(draftFromSide).toEqual({ id: 'd1', parent: side, afterTurnId: 's1', text: '', position: { x: 150, y: 100 } });
  });

  test('a side chat\'s latest reply continues that side chat', () => {
    const continued = draftFromConnectEnd(branch(reply({ owner: side, line: 'side', turn: turn('s2'), latest: true })), drop, toFlow, 'd1');
    expect(continued).toEqual({ id: 'd1', parent: side, afterTurnId: 's2', continues: side, text: '', position: { x: 150, y: 100 } });
  });

  test('a drop on a node, from another handle, or from a reply that can\'t branch makes no draft', () => {
    expect(draftFromConnectEnd({ ...branch(reply()), toNode: {} }, drop, toFlow, 'd1')).toBeNull();
    const onNode = { ...drop, target: { closest: (selector: string) => selector === '.react-flow__node' ? {} : null } as unknown as EventTarget };
    expect(draftFromConnectEnd(branch(reply()), onNode, toFlow, 'd1')).toBeNull();
    expect(draftFromConnectEnd({ ...branch(reply()), fromHandle: { id: null } }, drop, toFlow, 'd1')).toBeNull();
    expect(draftFromConnectEnd(branch(reply({ canBranch: false })), drop, toFlow, 'd1')).toBeNull();
    expect(draftFromConnectEnd({ fromNode: null, fromHandle: null, toNode: null }, drop, toFlow, 'd1')).toBeNull();
  });
});

describe('canBranchFrom', () => {
  test('a message can branch when its node says so, whatever its turn\'s status', () => {
    expect(canBranchFrom(reply({ turn: turn('t1', 'active') }))).toBe(true);
    expect(canBranchFrom({ kind: 'user', owner: root, line: 'main', turn: turn('t1', 'active'), canBranch: true })).toBe(true);
    expect(canBranchFrom(reply({ canBranch: false }))).toBe(false);
    expect(canBranchFrom({ kind: 'user', owner: root, line: 'main', turn: turn('t1'), canBranch: false })).toBe(false);
    expect(canBranchFrom({ kind: 'composer', draft })).toBe(false);
  });
});

describe('draftFromMessage', () => {
  test('a reply\'s selection branches after that reply, quoted', () => {
    expect(draftFromMessage(reply({ owner: side, line: 'side', turn: turn('s1'), latest: true }), 'the lockfile', 'd1'))
      .toEqual({ id: 'd1', parent: side, afterTurnId: 's1', text: '> the lockfile\n\n' });
  });

  test('a user message\'s selection branches after the same turn\'s reply', () => {
    expect(draftFromMessage({ kind: 'user', owner: root, line: 'main', turn: turn('t3'), canBranch: true }, 'why', 'd1'))
      .toEqual({ id: 'd1', parent: root, afterTurnId: 't3', text: '> why\n\n' });
  });

  test('nothing branches from a reply or user message that can\'t, or a node that isn\'t a message', () => {
    expect(draftFromMessage(reply({ canBranch: false }), 'x', 'd1')).toBeNull();
    expect(draftFromMessage({ kind: 'user', owner: root, line: 'main', turn: turn('t1', 'active'), canBranch: false }, 'x', 'd1')).toBeNull();
    expect(draftFromMessage({ kind: 'composer', draft }, 'x', 'd1')).toBeNull();
  });
});

describe('handOffNodeId', () => {
  const position = { x: 400, y: 80 };
  const summary: SideChatSummary = { ref: forked, parentKey: conversationKey(root), afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 1 };
  const state = (...ids: string[]) => ({ ...initialConversationState, turns: ids.map((id) => turn(id)) });

  test('a new side chat\'s dropped spot goes to its first own user node, once that turn shows up', () => {
    const handOff = { ref: forked, position, before: null as ReadonlySet<string> | null };
    expect(handOffNodeId(handOff, state('t1'), summary)).toBeNull();
    expect(handOffNodeId(handOff, state('t1', 's1'), undefined)).toBeNull();
    expect(handOffNodeId(handOff, state('t1', 's1'), summary)).toBe(`${conversationKey(forked)}|s1|user`);
  });

  test('a continued side chat\'s goes to the first turn it didn\'t have before the send', () => {
    const handOff = { ref: side, position, before: new Set(['t1', 's1']) };
    expect(handOffNodeId(handOff, state('t1', 's1'), undefined)).toBeNull();
    expect(handOffNodeId(handOff, state('t1', 's1', 's2'), undefined)).toBe(`${conversationKey(side)}|s2|user`);
  });
});
