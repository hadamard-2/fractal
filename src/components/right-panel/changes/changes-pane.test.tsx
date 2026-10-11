// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ChangesView } from '@/renderer/use-changes';
import type { ChangedFile } from '@/shared/changes-contract';
import { ChangesPane } from './changes-pane';

const useChanges = vi.fn<(root: string, active: boolean) => ChangesView>();
vi.mock('@/renderer/use-changes', () => ({ useChanges: (root: string, active: boolean) => useChanges(root, active) }));
const stream = vi.fn();
vi.mock('./diff-stream', () => ({
  DiffStream: (props: { files: ChangedFile[]; jumpTo: { path: string; token: number } | null }) => {
    stream(props);
    return <p data-testid="stream">{props.files.length} files, jump {props.jumpTo ? `${props.jumpTo.path}#${props.jumpTo.token}` : 'none'}</p>;
  },
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(100_000);
  stream.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const refresh = vi.fn();
const view = (over: Partial<ChangesView> = {}): ChangesView => ({ snapshot: null, failed: false, refresh, ...over });
const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path, status: 'modified', added: 2, removed: 1, collapsed: false, body: { kind: 'hunks', hunks: [] }, ...over,
});
const changes = (files: ChangedFile[], head = { branch: 'main' }) => ({ kind: 'changes' as const, fingerprint: 'f', head, files, truncated: false });
const renderPane = (onOpenFile = vi.fn()) => render(<TooltipProvider><ChangesPane active onOpenFile={onOpenFile} root="/repo" /></TooltipProvider>);

test('asks the hook to read the pane\'s project, and says so until the first result', () => {
  useChanges.mockReturnValue(view());
  renderPane();
  expect(useChanges).toHaveBeenCalledWith('/repo', true);
  expect(screen.getByText('Reading changes…')).toBeTruthy();
});

test('shows each whole state', async () => {
  useChanges.mockReturnValue(view({ failed: true }));
  const { rerender } = renderPane();
  expect(screen.getByText('Changes couldn\'t be read')).toBeTruthy();
  await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'Retry' }));
  expect(refresh).toHaveBeenCalledTimes(1);
  const show = (snapshot: ChangesView['snapshot']) => {
    useChanges.mockReturnValue(view({ snapshot }));
    rerender(<TooltipProvider><ChangesPane active onOpenFile={vi.fn()} root="/repo" /></TooltipProvider>);
  };
  show({ kind: 'not-a-repo' });
  expect(screen.getByText('Not a git repository')).toBeTruthy();
  show({ kind: 'git-unavailable' });
  expect(screen.getByText('Git isn\'t available')).toBeTruthy();
  show(changes([]));
  expect(screen.getByText('No uncommitted changes')).toBeTruthy();
  expect(screen.queryByTestId('stream')).toBeNull();
});

test('summarises and lists files, and jumps to one', async () => {
  useChanges.mockReturnValue(view({ snapshot: changes([file('a.ts'), file('new.ts', { status: 'renamed', oldPath: 'old.ts', added: 0, removed: 0 })]) }));
  renderPane();
  expect(screen.getByText('2 files changed · +2 −1')).toBeTruthy();
  expect(screen.getByText('main')).toBeTruthy();
  const list = screen.getByRole('list', { name: 'Changed files' });
  const rename = screen.getByRole('button', { name: /old\.ts → new\.ts/ });
  expect(rename.textContent).toContain('R');
  expect(rename.textContent).toContain('+0 −0');
  expect(list.textContent).toContain('a.ts');
  expect(screen.getByTestId('stream').textContent).toBe('2 files, jump none');
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(rename);
  expect(screen.getByTestId('stream').textContent).toBe('2 files, jump new.ts#1');
  await user.click(rename);
  expect(screen.getByTestId('stream').textContent).toBe('2 files, jump new.ts#2');
});

test('shows a detached head by its short commit, and a singular file count', () => {
  useChanges.mockReturnValue(view({ snapshot: changes([file('a.ts')], { commit: '0123456789abcdef' } as never) }));
  renderPane();
  expect(screen.getByText('1 file changed · +2 −1')).toBeTruthy();
  expect(screen.getByText('0123456')).toBeTruthy();
});

test('collapses and expands the file list', async () => {
  useChanges.mockReturnValue(view({ snapshot: changes([file('a.ts')]) }));
  renderPane();
  const toggle = screen.getByRole('button', { name: 'Changed files' });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('list', { name: 'Changed files' })).toBeNull();
  await user.click(toggle);
  expect(screen.getByRole('list', { name: 'Changed files' })).toBeTruthy();
});

test('refreshes on request', async () => {
  useChanges.mockReturnValue(view({ snapshot: changes([file('a.ts')]) }));
  renderPane();
  expect(screen.queryByText(/Checked/)).toBeNull();
  await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'Refresh changes' }));
  expect(refresh).toHaveBeenCalled();
});

test('shows a failed refresh in the header while keeping the last result', () => {
  useChanges.mockReturnValue(view({ snapshot: changes([file('a.ts')]), failed: true }));
  renderPane();
  expect(screen.getByText('Changes couldn\'t be read')).toBeTruthy();
  expect(screen.queryByText(/Checked/)).toBeNull();
  expect(screen.getByText('1 file changed · +2 −1')).toBeTruthy();
  expect(screen.getByTestId('stream')).toBeTruthy();
});
