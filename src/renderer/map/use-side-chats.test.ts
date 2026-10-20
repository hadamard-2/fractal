// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { announceSideChats } from '@/renderer/side-chat-events';
import { conversationKey, type ConversationApi, type ConversationRef, type SideChatSummary } from '@/shared/conversation-contract';
import { sideChatsBelow, useSideChats } from './use-side-chats';

const ref = (id: string): ConversationRef => ({ provider: 'claude', nativeSessionId: id, projectPath: '/work' });
const sideChat = (id: string, parent: string): SideChatSummary => ({ ref: ref(id), parentKey: conversationKey(ref(parent)), afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 1 });

const listed = [sideChat('a', 'root'), sideChat('b', 'a'), sideChat('c', 'b'), sideChat('d', 'root'), sideChat('e', 'd')];
const ids = (sideChats: SideChatSummary[]) => sideChats.map((summary) => summary.ref.nativeSessionId);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

function install(sideChats: ConversationApi['sideChats']) {
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { sideChats } } });
}

test('listed is false until the first listing for the root resolves, and false again after the root changes', async () => {
  const resolvers: Array<(value: SideChatSummary[]) => void> = [];
  const sideChats = vi.fn<ConversationApi['sideChats']>(() => new Promise((resolve) => { resolvers.push(resolve); }));
  install(sideChats);
  const { result, rerender } = renderHook(({ root }) => useSideChats(root), { initialProps: { root: ref('one') as ConversationRef | null } });
  expect(result.current.listed).toBe(false);
  await waitFor(() => expect(resolvers).toHaveLength(1));
  await act(async () => { resolvers[0]([sideChat('a', 'one')]); });
  expect(result.current.listed).toBe(true);
  expect(ids(result.current.sideChats)).toEqual(['a']);

  rerender({ root: ref('two') });
  expect(result.current.listed).toBe(false);
  expect(result.current.sideChats).toEqual([]);
  await waitFor(() => expect(resolvers).toHaveLength(2));
  await act(async () => { resolvers[1]([]); });
  expect(result.current.listed).toBe(true);
});

test('listed stays false without a root', () => {
  install(vi.fn<ConversationApi['sideChats']>().mockResolvedValue([]));
  const { result } = renderHook(() => useSideChats(null));
  expect(result.current.listed).toBe(false);
});

test('announceSideChats lists again for every hook on that root, and for no other root', async () => {
  const sideChats = vi.fn<ConversationApi['sideChats']>().mockResolvedValue([]);
  install(sideChats);
  const first = renderHook(() => useSideChats(ref('one')));
  const second = renderHook(() => useSideChats(ref('one')));
  const other = renderHook(() => useSideChats(ref('two')));
  await waitFor(() => expect(first.result.current.listed && second.result.current.listed && other.result.current.listed).toBe(true));
  expect(sideChats).toHaveBeenCalledTimes(3);

  act(() => announceSideChats(conversationKey(ref('one'))));
  await waitFor(() => expect(sideChats).toHaveBeenCalledTimes(5));
  expect(sideChats.mock.calls.slice(3).map(([root]) => root.nativeSessionId)).toEqual(['one', 'one']);
});

test('a hook stops listening to announcements once unmounted', async () => {
  const sideChats = vi.fn<ConversationApi['sideChats']>().mockResolvedValue([]);
  install(sideChats);
  const { result, unmount } = renderHook(() => useSideChats(ref('one')));
  await waitFor(() => expect(result.current.listed).toBe(true));
  unmount();
  announceSideChats(conversationKey(ref('one')));
  expect(sideChats).toHaveBeenCalledTimes(1);
});

test('failed is set when the latest listing fails, cleared when the next starts, and only for that root', async () => {
  const sideChats = vi.fn<ConversationApi['sideChats']>().mockRejectedValueOnce(new Error('Listing failed'));
  let release: (value: SideChatSummary[]) => void = () => undefined;
  sideChats.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  sideChats.mockResolvedValue([]);
  install(sideChats);
  const { result, rerender } = renderHook(({ root }) => useSideChats(root), { initialProps: { root: ref('one') } });
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.listed).toBe(false);

  act(() => { void result.current.refresh(); });
  expect(result.current.failed).toBe(false);
  await act(async () => { release([sideChat('a', 'one')]); });
  expect(result.current).toMatchObject({ failed: false, listed: true });

  sideChats.mockRejectedValueOnce(new Error('Listing failed'));
  await act(async () => { await result.current.refresh(); });
  // A failure keeps what's shown.
  expect(result.current).toMatchObject({ failed: true, listed: true });
  expect(ids(result.current.sideChats)).toEqual(['a']);
  rerender({ root: ref('two') });
  expect(result.current.failed).toBe(false);
});
