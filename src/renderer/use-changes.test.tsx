// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHANGES_POLL_MS, type ChangesResult } from '@/shared/changes-contract';
import { useChanges } from './use-changes';

const changed = (fingerprint: string): ChangesResult => ({ kind: 'changes', fingerprint, head: { branch: 'main' }, files: [], truncated: false });

let visibility: DocumentVisibilityState = 'visible';
const read = vi.fn<(root: string, fingerprint?: string) => Promise<ChangesResult>>();

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  read.mockReset();
  Object.defineProperty(window, 'fractal', { configurable: true, value: { changes: { read } } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(window, 'fractal');
});

describe('useChanges', () => {
  test('reads on activation and every 2 s while active and visible', async () => {
    read.mockResolvedValue(changed('fp1'));
    const { rerender } = renderHook(({ active }) => useChanges('/a', active), { initialProps: { active: true } });
    expect(read).toHaveBeenCalledTimes(1);
    await tick(CHANGES_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);

    rerender({ active: false });
    await tick(CHANGES_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    rerender({ active: true });
    await tick(CHANGES_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);

    setVisibility('visible');
    expect(read).toHaveBeenCalledTimes(3);
    await tick(CHANGES_POLL_MS);
    expect(read).toHaveBeenCalledTimes(4);

    setVisibility('hidden');
    await tick(CHANGES_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(4);
  });

  test('reads at once when the window gains focus while active', async () => {
    read.mockResolvedValue(changed('fp1'));
    renderHook(() => useChanges('/a', true));
    await tick(0);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('sends the last fingerprint and keeps the snapshot on unchanged', async () => {
    const first = changed('fp1');
    read.mockResolvedValueOnce(first).mockResolvedValueOnce({ kind: 'unchanged', fingerprint: 'fp1' });
    const { result } = renderHook(() => useChanges('/a', true));
    await tick(0);
    expect(read).toHaveBeenLastCalledWith('/a', undefined);
    expect(result.current.snapshot).toBe(first);
    const view = result.current;

    await tick(CHANGES_POLL_MS);
    expect(read).toHaveBeenLastCalledWith('/a', 'fp1');
    // Nothing changed, so the hook hands back the same view rather than re-rendering with an equal one.
    expect(result.current).toBe(view);
  });

  test('never overlaps reads, and runs a refresh requested mid-read afterwards', async () => {
    let settle!: (result: ChangesResult) => void;
    read.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; })).mockResolvedValue(changed('fp2'));
    const { result } = renderHook(() => useChanges('/a', true));
    await tick(CHANGES_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);

    act(() => result.current.refresh());
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { settle(changed('fp1')); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith('/a', 'fp1');
  });

  test('keeps refresh stable across renders', async () => {
    read.mockResolvedValue(changed('fp1'));
    const { result, rerender } = renderHook(({ root }) => useChanges(root, true), { initialProps: { root: '/a' } });
    const refresh = result.current.refresh;
    await tick(0);
    rerender({ root: '/b' });
    expect(result.current.refresh).toBe(refresh);
  });

  test('keeps the last good snapshot when a read fails', async () => {
    const first = changed('fp1');
    read.mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ kind: 'error', message: 'boom' })
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValueOnce({ kind: 'not-a-repo' });
    const { result } = renderHook(() => useChanges('/a', true));
    await tick(0);
    expect(result.current.failed).toBe(false);

    await tick(CHANGES_POLL_MS);
    expect(result.current).toMatchObject({ snapshot: first, failed: true });
    await tick(CHANGES_POLL_MS);
    expect(result.current).toMatchObject({ snapshot: first, failed: true });
    expect(read).toHaveBeenLastCalledWith('/a', 'fp1');

    await tick(CHANGES_POLL_MS);
    expect(result.current).toMatchObject({ snapshot: { kind: 'not-a-repo' }, failed: false });
  });

  test('ignores a late response for a previous root and never updates after unmount', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const settlers: Record<string, (result: ChangesResult) => void> = {};
    read.mockImplementation((root) => new Promise((resolve) => { settlers[root] = resolve; }));
    const { result, rerender, unmount } = renderHook(({ root }) => useChanges(root, true), { initialProps: { root: '/a' } });
    rerender({ root: '/b' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith('/b', undefined);

    expect(result.current.snapshot).toBeNull();
    await act(async () => { settlers['/b'](changed('from-b')); });
    expect(result.current.snapshot).toMatchObject({ fingerprint: 'from-b' });
    await act(async () => { settlers['/a'](changed('from-a')); });
    expect(result.current.snapshot).toMatchObject({ fingerprint: 'from-b' });

    await tick(CHANGES_POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith('/b', 'from-b');
    act(() => result.current.refresh());
    unmount();
    await act(async () => { settlers['/b'](changed('late')); });
    await tick(CHANGES_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(3);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  test('runs no queued read once the tool is deselected or the window is hidden', async () => {
    const settlers: Array<(result: ChangesResult) => void> = [];
    read.mockImplementation(() => new Promise((resolve) => { settlers.push(resolve); }));
    const { result, rerender } = renderHook(({ active }) => useChanges('/a', active), { initialProps: { active: true } });
    expect(read).toHaveBeenCalledTimes(1);
    act(() => result.current.refresh());
    rerender({ active: false });
    await act(async () => { settlers[0](changed('fp1')); });
    await tick(CHANGES_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);

    rerender({ active: true });
    expect(read).toHaveBeenCalledTimes(2);
    act(() => result.current.refresh());
    setVisibility('hidden');
    await act(async () => { settlers[1](changed('fp2')); });
    await tick(CHANGES_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('does not re-expose an earlier state of a root revisited before the other root resolved', async () => {
    const settlers: Array<(result: ChangesResult) => void> = [];
    read.mockImplementation(() => new Promise((resolve) => { settlers.push(resolve); }));
    const { result, rerender } = renderHook(({ root }) => useChanges(root, true), { initialProps: { root: '/a' } });
    await act(async () => { settlers[0](changed('x')); });
    expect(result.current.snapshot).toMatchObject({ fingerprint: 'x' });

    rerender({ root: '/b' });
    rerender({ root: '/a' });
    expect(result.current).toMatchObject({ snapshot: null, failed: false });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => { settlers[2](changed('y')); });
    expect(result.current.snapshot).toMatchObject({ fingerprint: 'y' });
  });

  test('clears the snapshot and the failure when the root changes', async () => {
    read.mockResolvedValueOnce({ kind: 'error', message: 'x' }).mockReturnValue(new Promise(() => undefined));
    const { result, rerender } = renderHook(({ root }) => useChanges(root, true), { initialProps: { root: '/a' } });
    await tick(0);
    expect(result.current.failed).toBe(true);
    rerender({ root: '/b' });
    expect(result.current).toMatchObject({ snapshot: null, failed: false });
  });

  test('still applies a response that arrives after the tool was deselected', async () => {
    let settle!: (result: ChangesResult) => void;
    read.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const { result, rerender } = renderHook(({ active }) => useChanges('/a', active), { initialProps: { active: true } });
    rerender({ active: false });
    await act(async () => { settle(changed('fp1')); });
    expect(result.current.snapshot).toMatchObject({ fingerprint: 'fp1' });
  });
});
