// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ChangedFile, DiffHunk, DiffLine } from '@/shared/changes-contract';
import { DiffStream } from './diff-stream';

vi.mock('../files/open-menu', () => ({
  OpenWithMenu: ({ path, line }: { path: string; line?: number }) => <div data-open-line={line ?? ''} data-open-path={path} data-testid="open-menu" />,
}));

// The real virtualizer, with scrollToIndex recorded rather than performed (jsdom cannot scroll).
const scrollToIndex = vi.fn();
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  const patched = new WeakSet<object>();
  return {
    ...actual,
    useVirtualizer: (...args: Parameters<typeof actual.useVirtualizer>) => {
      const virtualizer = actual.useVirtualizer(...args);
      if (!patched.has(virtualizer)) {
        patched.add(virtualizer);
        virtualizer.scrollToIndex = (...call: Parameters<typeof virtualizer.scrollToIndex>) => { scrollToIndex(...call); };
      }
      return virtualizer;
    },
  };
});

beforeEach(() => {
  scrollToIndex.mockClear();
  // jsdom has no layout; the virtualizer measures its scroll element through these.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const hunk = (oldStart: number, newStart: number, lines: DiffLine[], header = ''): DiffHunk => ({ header, oldStart, newStart, lines });
const ctx = (o: number, n: number, text = 'x'): DiffLine => ({ kind: 'context', text, oldNumber: o, newNumber: n });
const add = (n: number, text = 'x'): DiffLine => ({ kind: 'added', text, newNumber: n });
const del = (o: number, text = 'x'): DiffLine => ({ kind: 'removed', text, oldNumber: o });
const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path, status: 'modified', added: 1, removed: 1, collapsed: false, body: { kind: 'hunks', hunks: [] }, ...over,
});
const withHunks = (path: string, hunks: DiffHunk[], over: Partial<ChangedFile> = {}) => file(path, { body: { kind: 'hunks', hunks }, ...over });

const renderStream = (files: ChangedFile[], props: Partial<Parameters<typeof DiffStream>[0]> = {}) => render(
  <TooltipProvider><DiffStream files={files} jumpTo={null} onOpenFile={vi.fn()} root="/repo" {...props} /></TooltipProvider>,
);
const rowOf = (key: string) => document.querySelector(`[data-row="${key}"]`) as HTMLElement;
const keys = () => [...document.querySelectorAll('[data-row]')].map((element) => element.getAttribute('data-row'));

const sample = withHunks('a.unknownext', [hunk(1, 1, [ctx(1, 1, 'keep'), del(2, 'old'), add(2, 'new'), add(3, 'more')], 'function run()')]);

test('renders hunks with gutters, markers and tints', () => {
  renderStream([sample]);
  expect(rowOf('h:a.unknownext:1').textContent).toBe('function run()');
  expect(rowOf('h:a.unknownext:1').textContent).not.toContain('@@');
  const removed = rowOf('l:a.unknownext:r:2');
  expect(removed.textContent).toBe('2-old');
  expect(removed.innerHTML).toContain('bg-red-500/10');
  const added = rowOf('l:a.unknownext:a:2:1');
  expect(added.textContent).toBe('2+new');
  expect(added.innerHTML).toContain('bg-green-500/10');
  const context = rowOf('l:a.unknownext:c:1');
  expect(context.textContent).toBe('11 keep');
  expect(context.innerHTML).not.toContain('bg-red-500');
  expect(context.innerHTML).not.toContain('bg-green-500');
  expect(rowOf('f:a.unknownext').textContent).toContain('+1 −1');
});

test('keeps an empty hunk header as a visible separator row and mutes the no-newline note', () => {
  renderStream([withHunks('a.unknownext', [hunk(1, 1, [ctx(1, 1, 'last'), { kind: 'no-newline', text: ' No newline at end of file' }])])]);
  expect(rowOf('h:a.unknownext:1')).toBeTruthy();
  expect(rowOf('l:a.unknownext:no-newline:::0').textContent).toBe('No newline at end of file');
});

test('collapses and expands a file', async () => {
  const big = withHunks('big.lock', [hunk(1, 1, [add(1, 'locked')])], { collapsed: true });
  renderStream([big, sample]);
  expect(screen.queryByText('locked')).toBeNull();
  expect(rowOf('f:big.lock').querySelector('[aria-expanded="false"]')).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Expand big.lock' }));
  expect(screen.getByText('locked')).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse a.unknownext' }));
  expect(screen.queryByText('keep')).toBeNull();
  expect(screen.getByText('locked')).toBeTruthy();
});

test('passes the clicked line to the Open menu and highlights it', () => {
  renderStream([sample, withHunks('b.unknownext', [hunk(1, 1, [add(1)])])]);
  const menus = () => screen.getAllByTestId('open-menu').map((menu) => menu.getAttribute('data-open-line'));
  expect(menus()).toEqual(['', '']);
  fireEvent.click(rowOf('l:a.unknownext:r:2').firstElementChild as HTMLElement);
  // A removed line opens at the nearest new-side line before it.
  expect(menus()).toEqual(['1', '']);
  expect(rowOf('l:a.unknownext:r:2').innerHTML).toContain('aria-current="true"');
  fireEvent.click(rowOf('l:a.unknownext:a:2:1').firstElementChild as HTMLElement);
  expect(menus()).toEqual(['2', '']);
  expect(rowOf('l:a.unknownext:r:2').innerHTML).not.toContain('aria-current');
});

test('offers no actions on deleted files and folders, and Open file elsewhere', async () => {
  const onOpenFile = vi.fn();
  renderStream([
    file('gone.ts', { status: 'deleted', body: { kind: 'hunks', hunks: [] } }),
    file('nested', { status: 'added', body: { kind: 'folder' } }),
    file('src/a.ts', { status: 'added', body: { kind: 'hunks', hunks: [] } }),
  ], { onOpenFile });
  expect(screen.getAllByRole('button', { name: 'Open file' })).toHaveLength(1);
  expect(screen.getAllByTestId('open-menu').map((menu) => menu.getAttribute('data-open-path'))).toEqual(['src/a.ts']);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open file' }));
  expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
});

test('shows the conflicted badge and each body message', () => {
  renderStream([
    file('c.ts', { status: 'conflicted' }),
    file('a.bin', { body: { kind: 'binary', size: 1_258_291 } }),
    file('big.ts', { added: 9, removed: 2, body: { kind: 'too-large' } }),
    file('run.sh', { body: { kind: 'mode', oldMode: '100644', newMode: '100755' } }),
    file('link', { status: 'type-changed', body: { kind: 'type-change', from: 'file', to: 'symlink' } }),
    file('sub', { body: { kind: 'submodule', commit: 'abc1234def' } }),
    file('nested', { status: 'added', body: { kind: 'folder' } }),
    file('late.ts', { body: { kind: 'not-loaded' } }),
  ]);
  expect(screen.getAllByText('Conflicted')).toHaveLength(1);
  expect(rowOf('f:c.ts').textContent).toContain('Conflicted');
  for (const text of [
    'Binary file changed · 1.2 MiB', 'Diff too large to show · +9 −2', 'File mode changed 644 → 755', 'Changed from a file to a symlink',
    'Submodule moved to `abc1234`', 'Untracked folder · contents not shown', 'Not loaded: too many changes',
  ]) expect(screen.getByText(text)).toBeTruthy();
});

// 60 context lines are 1200px of rows against the 200px viewport.
const long = (extra: DiffLine[] = []) => withHunks('long.unknownext', [hunk(1, 1 + extra.length, [
  ...extra,
  ...Array.from({ length: 60 }, (_, index) => ctx(index + 1, index + 1 + extra.length, `line ${index + 1}`)),
])]);
const scrollTo = (top: number) => {
  const scroller = screen.getByRole('region', { name: 'Changes' });
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: top });
  fireEvent.scroll(scroller);
};

test('draws a copy of the current file\'s header over the stream once its own header has scrolled away', () => {
  renderStream([long(), sample]);
  const headers = () => screen.getAllByRole('button', { name: 'Collapse long.unknownext' });
  expect(headers()).toHaveLength(1);
  scrollTo(400);
  expect(headers()).toHaveLength(2);
  scrollTo(0);
  expect(headers()).toHaveLength(1);
});

test('keeps the reading position across a refresh', () => {
  const { rerender } = renderStream([long()]);
  // Rows are the file (36px), a hunk (20px) and then 20px lines, so 400px down the first line in view is line 18.
  scrollTo(400);
  scrollToIndex.mockClear();
  rerender(<TooltipProvider><DiffStream files={[long([add(1, 'inserted'), add(2, 'inserted too')])]} jumpTo={null} onOpenFile={vi.fn()} root="/repo" /></TooltipProvider>);
  // Rows: file, hunk, two added lines, then line 1 at index 4, so line 18 is at index 21.
  expect(scrollToIndex).toHaveBeenCalledWith(21, { align: 'start' });
});

test('falls back to the nearest remaining row of the same file, and stays put when the file is gone', () => {
  const { rerender } = renderStream([long(), sample]);
  scrollTo(400);
  scrollToIndex.mockClear();
  // Line 18, the first in view, is gone: the nearest row of the file still shown is line 17, at index 18.
  const lines = Array.from({ length: 60 }, (_, index) => ctx(index + 1, index + 1, `line ${index + 1}`)).filter((line) => line.oldNumber !== 18);
  rerender(<TooltipProvider><DiffStream files={[withHunks('long.unknownext', [hunk(1, 1, lines)]), sample]} jumpTo={null} onOpenFile={vi.fn()} root="/repo" /></TooltipProvider>);
  expect(scrollToIndex).toHaveBeenCalledTimes(1);
  expect(scrollToIndex).toHaveBeenCalledWith(18, { align: 'start' });
  scrollToIndex.mockClear();
  rerender(<TooltipProvider><DiffStream files={[sample]} jumpTo={null} onOpenFile={vi.fn()} root="/repo" /></TooltipProvider>);
  expect(scrollToIndex).not.toHaveBeenCalled();
});

test('a jump expands its file and scrolls to its header', () => {
  const big = withHunks('big.lock', [hunk(1, 1, [add(1, 'locked')])], { collapsed: true });
  const files = [sample, big];
  const { rerender } = renderStream(files);
  expect(keys()).not.toContain('l:big.lock:a:0:1');
  rerender(<TooltipProvider><DiffStream files={files} jumpTo={{ path: 'big.lock', token: 1 }} onOpenFile={vi.fn()} root="/repo" /></TooltipProvider>);
  expect(screen.getByText('locked')).toBeTruthy();
  const index = keys().indexOf('f:big.lock');
  expect(scrollToIndex).toHaveBeenLastCalledWith(index, { align: 'start' });
  scrollToIndex.mockClear();
  rerender(<TooltipProvider><DiffStream files={files} jumpTo={{ path: 'a.unknownext', token: 2 }} onOpenFile={vi.fn()} root="/repo" /></TooltipProvider>);
  expect(scrollToIndex).toHaveBeenCalledWith(0, { align: 'start' });
});
