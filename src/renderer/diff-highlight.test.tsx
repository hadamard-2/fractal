// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ChangedFile, DiffLine } from '@/shared/changes-contract';
import { FILE_HIGHLIGHT_MAX_BYTES } from '@/shared/files-contract';
import { useDiffHighlights } from './diff-highlight';

type Callback = (result: { tokens: Array<Array<{ content: string }>> }) => void;
const highlight = vi.fn<(options: { code: string; language: string }, callback: Callback) => null>();
vi.mock('@/components/code/fractal-theme', () => ({
  codePlugin: {
    getThemes: () => ['light', 'dark'],
    highlight: (options: { code: string; language: string }, callback: Callback) => highlight(options, callback),
  },
}));

beforeEach(() => highlight.mockReset().mockReturnValue(null));

const ctx = (text: string): DiffLine => ({ kind: 'context', text, oldNumber: 1, newNumber: 1 });
const add = (text: string): DiffLine => ({ kind: 'added', text, newNumber: 2 });
const del = (text: string): DiffLine => ({ kind: 'removed', text, oldNumber: 2 });
const file = (path: string, lines: DiffLine[]): ChangedFile => ({
  path, status: 'modified', added: 1, removed: 1, collapsed: false, body: { kind: 'hunks', hunks: [{ header: '', oldStart: 1, newStart: 1, lines }] },
});
const tokens = (...lines: string[]) => ({ tokens: lines.map((content) => [{ content }]) });

test('highlights a visible file as its old side and its new side, once each, and answers by side and index', () => {
  const files = [file('a.ts', [ctx('keep'), del('old'), add('new'), { kind: 'no-newline', text: ' No newline at end of file' }])];
  const { result, rerender } = renderHook(({ visible }) => useDiffHighlights(files, visible), { initialProps: { visible: [0] } });
  expect(highlight.mock.calls.map(([options]) => [options.language, options.code])).toEqual([['ts', 'keep\nold'], ['ts', 'keep\nnew']]);
  expect(result.current(0, 'new', 1)).toBeNull();
  act(() => {
    highlight.mock.calls[0][1](tokens('keep', 'old'));
    highlight.mock.calls[1][1](tokens('keep', 'new'));
  });
  expect(result.current(0, 'old', 1)).toEqual([{ content: 'old' }]);
  expect(result.current(0, 'new', 1)).toEqual([{ content: 'new' }]);
  expect(result.current(1, 'new', 0)).toBeNull();
  rerender({ visible: [0] });
  expect(highlight).toHaveBeenCalledTimes(2);
});

test('highlights only files that are visible, and highlights a file again after a new read', () => {
  const a = file('a.ts', [add('one')]);
  const b = file('b.ts', [add('two')]);
  const { rerender } = renderHook(({ files, visible }) => useDiffHighlights(files, visible), { initialProps: { files: [a, b], visible: [1] } });
  expect(highlight.mock.calls.map(([options]) => options.code)).toEqual(['two']);
  rerender({ files: [a, b], visible: [0, 1] });
  expect(highlight).toHaveBeenCalledTimes(2);
  rerender({ files: [{ ...a }, b], visible: [0, 1] });
  expect(highlight).toHaveBeenCalledTimes(3);
});

test('leaves files with no language, no hunks, or a side over the size bound unhighlighted', () => {
  const big = file('big.ts', [add('x'.repeat(FILE_HIGHLIGHT_MAX_BYTES + 1))]);
  const files: ChangedFile[] = [file('notes.unknownext', [add('x')]), { ...file('a.ts', []), body: { kind: 'binary', size: 1 } }, big];
  const { result } = renderHook(() => useDiffHighlights(files, [0, 1, 2]));
  expect(highlight).not.toHaveBeenCalled();
  expect(result.current(2, 'new', 0)).toBeNull();
});

test('uses a result the highlighter already has without waiting for its callback', () => {
  highlight.mockReturnValue(tokens('cached') as never);
  const files = [file('a.ts', [add('cached')])];
  const { result } = renderHook(() => useDiffHighlights(files, [0]));
  expect(result.current(0, 'new', 0)).toEqual([{ content: 'cached' }]);
});
