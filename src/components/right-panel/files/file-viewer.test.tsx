// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import type { FileContent, FilesEvent } from '@/shared/files-contract';
import { FileViewer } from './file-viewer';

vi.mock('./open-menu', () => ({ OpenMenu: ({ line }: { line?: number }) => <div data-open-line={line ?? ''} data-testid="open-menu" /> }));

const listeners = new Set<(event: FilesEvent) => void>();
let readFile: Mock;
let writeText: Mock;
beforeEach(() => {
  listeners.clear();
  readFile = vi.fn(async (): Promise<FileContent> => ({ kind: 'text', content: 'one\ntwo\nthree', size: 13 }));
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(window, 'fractal', { configurable: true, value: { files: {
    readFile,
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: FilesEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  } } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  // jsdom has no layout; the virtualizer measures its scroll element through these.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const row = (line: number) => document.querySelector(`[data-line="${line}"]`) as HTMLElement;

test('shows the breadcrumb and numbered lines, and marks the clicked line as current', async () => {
  render(<FileViewer path="src/notes.unknownext" root="/work/repo" />);
  expect(await screen.findByText('two')).toBeTruthy();
  expect(screen.getByRole('navigation', { name: 'File path' }).textContent).toBe('repo›src›notes.unknownext');
  fireEvent.click(row(2));
  expect(row(2).getAttribute('aria-current')).toBe('true');
  expect(screen.getByTestId('open-menu').getAttribute('data-open-line')).toBe('2');
});

test('reads the file again when main reports a change', async () => {
  render(<FileViewer path="notes.unknownext" root="/repo" />);
  await screen.findByText('two');
  readFile.mockResolvedValue({ kind: 'text', content: 'changed', size: 7 });
  const watchId = (window.fractal.files.watch as Mock).mock.calls[0][0] as string;
  act(() => { for (const listener of listeners) listener({ type: 'changed', watchId }); });
  expect(await screen.findByText('changed')).toBeTruthy();
});

test.each([
  [{ kind: 'binary', size: 1_258_291 }, 'Binary file · 1.2 MiB', true],
  [{ kind: 'too-large', size: 14 * 1024 * 1024 }, 'Too large to preview · 14.0 MiB', true],
  [{ kind: 'missing' }, 'This file no longer exists', false],
  [{ kind: 'unreadable' }, 'This file cannot be read', false],
] as Array<[FileContent, string, boolean]>)('explains content it does not show as text: %j', async (content, message, offersOpen) => {
  readFile.mockResolvedValue(content);
  render(<FileViewer path="a.bin" root="/repo" />);
  expect(await screen.findByText(message)).toBeTruthy();
  // The header always has an Open menu; binary and too-large files get a second one under the message.
  expect(screen.getAllByTestId('open-menu')).toHaveLength(offersOpen ? 2 : 1);
});

test('copies the file\'s absolute path', async () => {
  render(<FileViewer path="src/a.unknownext" root="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy path' }));
  expect(writeText).toHaveBeenCalledWith('/repo/src/a.unknownext');
});
