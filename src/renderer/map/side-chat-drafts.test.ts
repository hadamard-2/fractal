import type { Node } from '@xyflow/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MapNodeData, SideChatDraft } from '@/renderer/map/map-graph';
import { initialConversationState } from '@/renderer/conversation-reducer';
import { canBranchFrom, draftFromConnectEnd, draftFromMessage, draftsReducer, handOffNodeId } from '@/renderer/map/side-chat-drafts';
import { conversationKey, type ConversationRef, type ConversationTurn, type SideChatSummary } from '@/shared/conversation-contract';

const root: ConversationRef = { provider: 'claude', nativeSessionId: 'root', projectPath: '/work' };
const side: ConversationRef = { provider: 'claude', nativeSessionId: 'side', projectPath: '/work' };
const forked: ConversationRef = { provider: 'claude', nativeSessionId: 'forked', projectPath: '/work' };

const turn = (id: string, status: ConversationTurn['status'] = 'completed'): ConversationTurn => ({
  id, nativeId: id, userMessage: { id: `${id}-user`, text: 'Ask' }, blocks: [], status, captureCompleteness: 'complete',
});

const draft: SideChatDraft = { id: 'd1', parent: root, afterTurnId: 't1', text: 'Why?' };

afterEach(() => { vi.restoreAllMocks(); });

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
