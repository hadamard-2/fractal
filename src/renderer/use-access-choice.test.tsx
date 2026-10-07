// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { accessLevels } from '@/shared/access-levels';
import type { AccessApi, AccessListing, ConversationRef, ConversationRuntime } from '@/shared/conversation-contract';
import { useAccessChoice } from './use-access-choice';

const refA: ConversationRef = { provider: 'claude', nativeSessionId: 'a', projectPath: '/work' };
const refB: ConversationRef = { provider: 'claude', nativeSessionId: 'b', projectPath: '/work' };
const levels = accessLevels('claude');
const listing = (level: string, extra: Partial<AccessListing> = {}): AccessListing => ({ levels, access: { state: { kind: 'level', level }, picked: false }, allowDangerous: false, ...extra });

function install(api: Partial<AccessApi> | undefined) {
  Object.defineProperty(window, 'fractal', { configurable: true, value: api ? { access: api } : {} });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('loads the listing', async () => {
  install({ list: vi.fn(async () => listing('auto', { observed: { kind: 'level', level: 'default' }, allowDangerous: true })), choose: vi.fn(async () => undefined) });
  const { result } = renderHook(() => useAccessChoice(refA, 'idle'));
  expect(result.current.loaded).toBe(false);
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current).toMatchObject({ levels, access: { state: { kind: 'level', level: 'auto' }, picked: false }, observed: { kind: 'level', level: 'default' }, allowDangerous: true });
});

test('a pick applies at once and is saved', async () => {
  const choose = vi.fn(async () => undefined);
  install({ list: vi.fn(async () => listing('auto')), choose });
  const { result } = renderHook(() => useAccessChoice(refA, 'idle'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => result.current.choose('plan'));
  expect(result.current.access).toEqual({ state: { kind: 'level', level: 'plan' }, picked: true });
  await waitFor(() => expect(choose).toHaveBeenCalledWith(refA, 'plan'));
});

test('a pick made while the first list is in flight wins', async () => {
  let resolve: (value: AccessListing) => void = () => undefined;
  const choose = vi.fn(async () => undefined);
  const list = vi.fn(() => new Promise<AccessListing>((r) => { resolve = r; }));
  install({ list, choose });
  const { result } = renderHook(() => useAccessChoice(refA, 'idle'));
  await waitFor(() => expect(list).toHaveBeenCalled());
  act(() => result.current.choose('plan'));
  await act(async () => resolve(listing('auto', { allowDangerous: true })));
  expect(result.current.access).toEqual({ state: { kind: 'level', level: 'plan' }, picked: true });
  expect(result.current.levels).toEqual(levels);
  expect(result.current.allowDangerous).toBe(true);
  expect(result.current.loaded).toBe(true);
});

test('never shows the previous conversation\'s result after the ref changes', async () => {
  const resolvers = new Map<string, (value: AccessListing) => void>();
  install({ list: vi.fn((ref: ConversationRef) => new Promise<AccessListing>((r) => { resolvers.set(ref.nativeSessionId, r); })), choose: vi.fn(async () => undefined) });
  const { result, rerender } = renderHook(({ ref }) => useAccessChoice(ref, 'idle'), { initialProps: { ref: refA } });
  await waitFor(() => expect(resolvers.has('a')).toBe(true));
  rerender({ ref: refB });
  await waitFor(() => expect(resolvers.has('b')).toBe(true));
  await act(async () => resolvers.get('a')?.(listing('plan')));
  expect(result.current).toMatchObject({ access: null, loaded: false });
  await act(async () => resolvers.get('b')?.(listing('auto')));
  expect(result.current.access?.state).toEqual({ kind: 'level', level: 'auto' });
});

test('lists again when a turn in Fractal ends', async () => {
  const list = vi.fn(async () => listing('auto'));
  install({ list, choose: vi.fn(async () => undefined) });
  const { result, rerender } = renderHook(({ runtime }: { runtime: ConversationRuntime }) => useAccessChoice(refA, runtime), { initialProps: { runtime: 'active-in-fractal' as ConversationRuntime } });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(list).toHaveBeenCalledTimes(1);
  list.mockResolvedValue(listing('auto', { observed: { kind: 'level', level: 'default' } }));
  rerender({ runtime: 'idle' });
  await waitFor(() => expect(result.current.observed).toEqual({ kind: 'level', level: 'default' }));
  expect(list).toHaveBeenCalledTimes(2);
});

test('does not list again for other runtime changes', async () => {
  const list = vi.fn(async () => listing('auto'));
  install({ list, choose: vi.fn(async () => undefined) });
  const { result, rerender } = renderHook(({ runtime }: { runtime: ConversationRuntime }) => useAccessChoice(refA, runtime), { initialProps: { runtime: 'idle' as ConversationRuntime } });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  rerender({ runtime: 'active-in-fractal' });
  expect(list).toHaveBeenCalledTimes(1);
});

test('a refresh keeps a pick the user made', async () => {
  install({ list: vi.fn(async () => listing('auto')), choose: vi.fn(async () => undefined) });
  const { result } = renderHook(() => useAccessChoice(refA, 'idle'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => result.current.choose('plan'));
  await act(async () => result.current.refresh());
  expect(result.current.access).toEqual({ state: { kind: 'level', level: 'plan' }, picked: true });
});

test.each([
  ['a missing api', undefined],
  ['a rejecting api', { list: vi.fn(async () => { throw new Error('boom'); }), choose: vi.fn(async () => undefined) }],
])('falls back to defaults with %s', async (_name, api) => {
  install(api);
  const { result } = renderHook(() => useAccessChoice(refA, 'idle'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current).toMatchObject({ levels: [], access: null, allowDangerous: false, loaded: true });
  expect(result.current.observed).toBeUndefined();
});
