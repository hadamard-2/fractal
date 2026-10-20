// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { clearForkDraft, forkDraft, forkDraftOf } from '@/renderer/forking';
import { conversationKey, type ConversationApi, type ConversationRef, type ConversationTurn } from '@/shared/conversation-contract';
import { useForkLauncherValue } from './fork-launcher';

const source: ConversationRef = { provider: 'claude', nativeSessionId: 'source', projectPath: '/work/fractal' };
const created: ConversationRef = { provider: 'claude', nativeSessionId: 'forked', projectPath: '/work/fractal' };
const turn: ConversationTurn = { id: 'turn-1', nativeId: 'turn-1', userMessage: { id: 'u', text: 'Try the other parser', images: [{ mediaType: 'image/png', data: 'AAAA' }] }, blocks: [], status: 'completed', captureCompleteness: 'complete' };

function stubFork(fork: ConversationApi['fork']) {
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { fork } } });
}

afterEach(() => { cleanup(); clearForkDraft(conversationKey(created)); vi.restoreAllMocks(); });

test('forking before a message leaves its draft for the fork, then opens the fork', async () => {
  const fork = vi.fn<ConversationApi['fork']>(async () => created);
  stubFork(fork);
  const open = vi.fn((ref: ConversationRef) => { expect(forkDraft(conversationKey(ref))).toEqual(forkDraftOf(turn)); });
  const { result } = renderHook(() => useForkLauncherValue(open));
  await act(() => result.current.fork(source, turn, 'before'));
  expect(fork).toHaveBeenCalledWith(source, { turnId: 'turn-1', position: 'before' }, 'fork');
  expect(open).toHaveBeenCalledWith(created);
});

test('forking after a reply leaves no draft', async () => {
  stubFork(async () => created);
  const open = vi.fn();
  const { result } = renderHook(() => useForkLauncherValue(open));
  await act(() => result.current.fork(source, turn, 'after'));
  expect(open).toHaveBeenCalledWith(created);
  expect(forkDraft(conversationKey(created))).toBeUndefined();
});

test('is pending until the agent answers', async () => {
  let resolve!: (ref: ConversationRef) => void;
  stubFork(() => new Promise((settle) => { resolve = settle; }));
  const { result } = renderHook(() => useForkLauncherValue(vi.fn()));
  expect(result.current.pending).toBe(false);
  let forking!: Promise<void>;
  act(() => { forking = result.current.fork(source, turn, 'after'); });
  expect(result.current.pending).toBe(true);
  await act(async () => { resolve(created); await forking; });
  expect(result.current.pending).toBe(false);
});

test('passes on the agent\'s error and opens nothing', async () => {
  stubFork(async () => { throw new Error('Claude could not fork this session'); });
  const open = vi.fn();
  const { result } = renderHook(() => useForkLauncherValue(open));
  await act(() => expect(result.current.fork(source, turn, 'before')).rejects.toThrow('Claude could not fork this session'));
  expect(open).not.toHaveBeenCalled();
  expect(result.current.pending).toBe(false);
  expect(forkDraft(conversationKey(created))).toBeUndefined();
});
