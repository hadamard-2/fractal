// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import type { FileEntry, FilesEvent } from '@/shared/files-contract';
import { FileTree } from './file-tree';

const entry = (name: string, kind: FileEntry['kind'] = 'file', extra: Partial<FileEntry> = {}): FileEntry =>
  ({ name, kind, symlink: false, ignored: false, outside: false, ...extra });
const listeners = new Set<(event: FilesEvent) => void>();
let files: { listDirectory: Mock; listFiles: Mock; watch: Mock; unwatch: Mock; onEvent: Mock };

beforeEach(() => {
  listeners.clear();
  const directories: Record<string, FileEntry[]> = {
    '': [entry('out', 'directory', { ignored: true }), entry('src', 'directory'), entry('leak', 'file', { symlink: true, outside: true }), entry('README.md')],
    src: [entry('a.ts')],
  };
  files = {
    listDirectory: vi.fn(async (_root: string, path: string) => directories[path] ?? []),
    listFiles: vi.fn(async () => ({ paths: ['README.md', 'src/a.ts', 'src/abc/readme.ts'], truncated: true })),
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: FilesEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { files } });
});
afterEach(cleanup);

const emitChange = (watchId: string) => act(() => { for (const listener of listeners) listener({ type: 'changed', watchId }); });
const watchIdFor = (path: string) => files.watch.mock.calls.find((call) => call[2] === path)?.[0] as string;

test('lists the root, dims ignored entries, and disables links that leave the project', async () => {
  render(<FileTree onOpen={vi.fn()} root="/repo" selectedPath={null} />);
  expect(await screen.findByRole('button', { name: 'README.md' })).toBeTruthy();
  expect(files.listDirectory).toHaveBeenCalledWith('/repo', '');
  expect(files.listDirectory).not.toHaveBeenCalledWith('/repo', 'src');
  expect(screen.getByRole('button', { name: 'out' }).className).toContain('text-muted-foreground');
  expect(screen.getByRole('button', { name: 'leak' }).hasAttribute('disabled')).toBe(true);
});

test('expands and collapses folders, watching only what is expanded', async () => {
  const user = userEvent.setup();
  render(<FileTree onOpen={vi.fn()} root="/repo" selectedPath={null} />);
  await user.click(await screen.findByRole('button', { name: 'src' }));
  expect(await screen.findByRole('button', { name: 'a.ts' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'src' }).getAttribute('aria-expanded')).toBe('true');
  const srcWatch = watchIdFor('src');
  expect(srcWatch).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'src' }));
  expect(screen.queryByRole('button', { name: 'a.ts' })).toBeNull();
  expect(files.unwatch).toHaveBeenCalledWith(srcWatch);
});

test('reloads a folder when main reports it changed', async () => {
  render(<FileTree onOpen={vi.fn()} root="/repo" selectedPath={null} />);
  await screen.findByRole('button', { name: 'README.md' });
  files.listDirectory.mockResolvedValueOnce([entry('NEW.md')]);
  emitChange(watchIdFor(''));
  expect(await screen.findByRole('button', { name: 'NEW.md' })).toBeTruthy();
});

test('opens a file as a preview on click and in a new tab on double- or middle-click', async () => {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<FileTree onOpen={onOpen} root="/repo" selectedPath="README.md" />);
  const readme = await screen.findByRole('button', { name: 'README.md' });
  expect(readme.getAttribute('aria-current')).toBe('true');
  await user.click(readme);
  expect(onOpen).toHaveBeenLastCalledWith('README.md', { pinned: false });
  await user.dblClick(readme);
  expect(onOpen).toHaveBeenLastCalledWith('README.md', { pinned: true });
  onOpen.mockClear();
  fireEvent(readme, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(onOpen).toHaveBeenCalledWith('README.md', { pinned: true });
});

test('filters the whole project, fetching the list again each time the filter opens', async () => {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<FileTree onOpen={onOpen} root="/repo" selectedPath={null} />);
  const filter = await screen.findByRole('textbox', { name: 'Filter files' });
  await user.type(filter, 'readme');
  expect(await screen.findByRole('button', { name: 'src/abc/readme.ts' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'README.md' })).toBeTruthy();
  expect(screen.getByText('Searched the first 50,000 files.')).toBeTruthy();
  expect(files.listFiles).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'src/abc/readme.ts' }));
  expect(onOpen).toHaveBeenCalledWith('src/abc/readme.ts', { pinned: false });
  await user.clear(filter);
  await user.type(filter, 'a');
  await waitFor(() => expect(files.listFiles).toHaveBeenCalledTimes(2));
});
