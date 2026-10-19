// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ConversationRef } from '@/shared/conversation-contract';
import { EMPTY_MAP_LAYOUT, type MapApi, type MapLayout } from '@/shared/map-contract';
import { useMapLayout } from './use-map-layout';

const refA: ConversationRef = { provider: 'claude', nativeSessionId: 'a', projectPath: '/work' };
const refB: ConversationRef = { provider: 'claude', nativeSessionId: 'b', projectPath: '/work' };
const stored: MapLayout = { view: 'full', nodes: { kept: { x: 20, y: 40, width: 400 } } };

function install(map: Partial<MapApi>) {
  const api: MapApi = { layout: vi.fn(async () => EMPTY_MAP_LAYOUT), saveLayout: vi.fn(async () => undefined), ...map };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { map: api } });
  return api;
}

/** Lets pending promise callbacks run; waitFor can't poll while setTimeout is faked. */
const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });

/** Mounts the hook and waits for its first load with real timers, then fakes the save timer. */
async function mounted(root: ConversationRef | null = refA) {
  const hook = renderHook(({ ref }) => useMapLayout(ref), { initialProps: { ref: root } });
  await settle();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return hook;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

test('reads the stored layout for the root', async () => {
  const api = install({ layout: vi.fn(async () => stored) });
  const { result } = renderHook(() => useMapLayout(refA));
  expect(result.current.layout).toEqual(EMPTY_MAP_LAYOUT);
  await waitFor(() => expect(result.current.layout).toEqual(stored));
  expect(api.layout).toHaveBeenCalledWith(refA);
});

test('saves a burst of moves once, 300 ms after the last', async () => {
  const api = install({ layout: vi.fn(async () => stored) });
  const { result } = await mounted();
  act(() => {
    result.current.moveNode('n1', { x: 20, y: 20 });
    result.current.moveNode('n1', { x: 40, y: 20 });
    result.current.moveNode('n2', { x: 0, y: 100 });
  });
  act(() => { vi.advanceTimersByTime(299); });
  await settle();
  expect(api.saveLayout).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  await settle();
  expect(api.saveLayout).toHaveBeenCalledTimes(1);
  expect(api.saveLayout).toHaveBeenCalledWith(refA, {
    view: 'full',
    nodes: { kept: { x: 20, y: 40, width: 400 }, n1: { x: 40, y: 20 }, n2: { x: 0, y: 100 } },
  });
});

test('a resize keeps the position and a move keeps the width', async () => {
  install({ layout: vi.fn(async () => stored) });
  const { result } = await mounted();
  act(() => { result.current.resizeNode('kept', 600); });
  act(() => { result.current.moveNode('kept', { x: 60, y: 80 }); });
  expect(result.current.layout.nodes.kept).toEqual({ x: 60, y: 80, width: 600 });
});

test('a resize stays within 240 to 960 and leaves an unlisted node to automatic layout', async () => {
  install({ layout: vi.fn(async () => stored) });
  const { result } = await mounted();
  act(() => { result.current.resizeNode('kept', 2000); });
  expect(result.current.layout.nodes.kept.width).toBe(960);
  act(() => { result.current.resizeNode('kept', 100); });
  expect(result.current.layout.nodes.kept.width).toBe(240);
  act(() => { result.current.resizeNode('unlisted', 400); });
  expect(result.current.layout.nodes.unlisted).toBeUndefined();
});

test('flushes the pending save when the root changes, and loads the new root', async () => {
  const api = install({ layout: vi.fn(async (ref: ConversationRef) => ref.nativeSessionId === 'a' ? stored : EMPTY_MAP_LAYOUT) });
  const { result, rerender } = await mounted();
  expect(result.current.layout).toEqual(stored);
  act(() => { result.current.setView('preview'); });
  rerender({ ref: refB });
  expect(result.current.layout).toEqual(EMPTY_MAP_LAYOUT);
  await settle();
  expect(api.saveLayout).toHaveBeenCalledWith(refA, { ...stored, view: 'preview' });
  expect(api.layout).toHaveBeenLastCalledWith(refB);
  act(() => { vi.advanceTimersByTime(1000); });
  await settle();
  expect(api.saveLayout).toHaveBeenCalledTimes(1);
});

test('flushes the pending save on unmount', async () => {
  const api = install({});
  const { result, unmount } = await mounted();
  act(() => { result.current.moveNode('n1', { x: 20, y: 20 }); });
  unmount();
  await settle();
  expect(api.saveLayout).toHaveBeenCalledWith(refA, { view: 'preview', nodes: { n1: { x: 20, y: 20 } } });
});

test('a failed save leaves the in-memory layout in place', async () => {
  const api = install({ saveLayout: vi.fn(async () => { throw new Error('disk full'); }) });
  const { result } = await mounted();
  act(() => { result.current.moveNode('n1', { x: 20, y: 20 }); });
  act(() => { vi.advanceTimersByTime(300); });
  await settle();
  expect(api.saveLayout).toHaveBeenCalledTimes(1);
  expect(result.current.layout).toEqual({ view: 'preview', nodes: { n1: { x: 20, y: 20 } } });
});

test('an edit made before the stored layout arrives lands on top of it rather than replacing it', async () => {
  let resolve: (layout: MapLayout) => void = () => undefined;
  const api = install({ layout: vi.fn(() => new Promise<MapLayout>((settle) => { resolve = settle; })) });
  const { result } = await mounted();
  act(() => { result.current.moveNode('n1', { x: 20, y: 20 }); });
  act(() => { vi.advanceTimersByTime(300); });
  await settle();
  expect(api.saveLayout).not.toHaveBeenCalled();
  resolve(stored);
  await settle();
  const merged = { view: 'full', nodes: { kept: { x: 20, y: 40, width: 400 }, n1: { x: 20, y: 20 } } };
  expect(result.current.layout).toEqual(merged);
  expect(api.saveLayout).toHaveBeenCalledWith(refA, merged);
});

test('an unreadable layout reads as empty', async () => {
  const api = install({ layout: vi.fn(async () => { throw new Error('nope'); }) });
  const { result } = await mounted();
  expect(api.layout).toHaveBeenCalled();
  expect(result.current.layout).toEqual(EMPTY_MAP_LAYOUT);
});

test('with no root there is nothing to load or save', async () => {
  const api = install({});
  const { result } = await mounted(null);
  act(() => { result.current.moveNode('n1', { x: 20, y: 20 }); });
  act(() => { vi.advanceTimersByTime(1000); });
  await settle();
  expect(result.current.layout).toEqual(EMPTY_MAP_LAYOUT);
  expect(api.layout).not.toHaveBeenCalled();
  expect(api.saveLayout).not.toHaveBeenCalled();
});
