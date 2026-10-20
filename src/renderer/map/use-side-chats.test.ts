import { expect, test } from 'vitest';
import { conversationKey, type ConversationRef, type SideChatSummary } from '@/shared/conversation-contract';
import { sideChatsBelow } from './use-side-chats';

const ref = (id: string): ConversationRef => ({ provider: 'claude', nativeSessionId: id, projectPath: '/work' });
const sideChat = (id: string, parent: string): SideChatSummary => ({ ref: ref(id), parentKey: conversationKey(ref(parent)), afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 1 });

const listed = [sideChat('a', 'root'), sideChat('b', 'a'), sideChat('c', 'b'), sideChat('d', 'root'), sideChat('e', 'd')];
const ids = (sideChats: SideChatSummary[]) => sideChats.map((summary) => summary.ref.nativeSessionId);

test('collects the side chats at every depth below one, and no others', () => {
  expect(ids(sideChatsBelow(listed, ref('a')))).toEqual(['b', 'c']);
  expect(ids(sideChatsBelow(listed, ref('d')))).toEqual(['e']);
});

test('a side chat with nothing nested in it has nothing below', () => {
  expect(sideChatsBelow(listed, ref('c'))).toEqual([]);
  expect(sideChatsBelow([], ref('a'))).toEqual([]);
});

test('from the root, it is every side chat', () => {
  expect(ids(sideChatsBelow(listed, ref('root')))).toEqual(['a', 'b', 'c', 'd', 'e']);
});
