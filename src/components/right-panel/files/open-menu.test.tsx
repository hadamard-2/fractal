// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import type { EditorInfo } from '@/shared/files-contract';
import { defaultOpener, OpenMenu } from './open-menu';

const editors: EditorInfo[] = [{ id: 'vscode', label: 'VS Code' }, { id: 'zed', label: 'Zed' }];
let open: Mock;
let set: Mock;
beforeEach(() => {
  open = vi.fn(async () => ({ ok: true }));
  set = vi.fn(async () => ({}));
  Object.defineProperty(window, 'fractal', { configurable: true, value: {
    files: { editors: vi.fn(async () => editors), open },
    settings: { get: vi.fn(async () => ({ fileOpener: 'zed' })), set },
  } });
});
afterEach(cleanup);

test('runs the remembered opener while it is still available, else the first editor, else the default app', () => {
  expect(defaultOpener('zed', editors)).toBe('zed');
  expect(defaultOpener('system', editors)).toBe('system');
  expect(defaultOpener('cursor', editors)).toBe('vscode');
  expect(defaultOpener(null, [])).toBe('system');
});

test('opens with the remembered editor at the current line', async () => {
  const user = userEvent.setup();
  render(<OpenMenu line={7} path="src/a.ts" root="/repo" />);
  await user.click(await screen.findByRole('button', { name: 'Open in Zed' }));
  expect(open).toHaveBeenCalledWith('zed', '/repo', 'src/a.ts', 7);
  expect(set).not.toHaveBeenCalled();
});

test('remembers an editor chosen from the menu once it opens, but not Show in folder', async () => {
  const user = userEvent.setup();
  render(<OpenMenu path="src/a.ts" root="/repo" />);
  await screen.findByRole('button', { name: 'Open in Zed' });
  await user.click(screen.getByRole('button', { name: 'Choose how to open' }));
  await user.click(await screen.findByRole('menuitem', { name: 'VS Code' }));
  expect(open).toHaveBeenCalledWith('vscode', '/repo', 'src/a.ts', undefined);
  await waitFor(() => expect(set).toHaveBeenCalledWith({ fileOpener: 'vscode' }));
  expect(screen.getByRole('button', { name: 'Open in VS Code' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Choose how to open' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Show in folder' }));
  expect(open).toHaveBeenLastCalledWith('reveal', '/repo', 'src/a.ts', undefined);
  expect(set).toHaveBeenCalledTimes(1);
});

test('shows why a file could not be opened', async () => {
  open.mockResolvedValue({ ok: false, message: 'Couldn\'t start Zed' });
  const user = userEvent.setup();
  render(<OpenMenu path="src/a.ts" root="/repo" />);
  await user.click(await screen.findByRole('button', { name: 'Open in Zed' }));
  expect((await screen.findByRole('status')).textContent).toBe('Couldn\'t start Zed');
  expect(set).not.toHaveBeenCalled();
});
