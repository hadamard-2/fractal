// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ToolList } from './tool-entries';

afterEach(cleanup);

test('lists every tool in order, with Terminal and Files available', async () => {
  const onTerminal = vi.fn();
  const onFiles = vi.fn();
  render(<ToolList filesAvailable onFiles={onFiles} onTerminal={onTerminal} />);
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'ReviewSoon', 'TerminalCtrl+`', 'BrowserSoon', 'Files', 'Side chatSoon',
  ]);
  for (const name of ['Review', 'Browser', 'Side chat']) {
    expect(screen.getByRole('menuitem', { name }).hasAttribute('disabled')).toBe(true);
  }
  const terminal = screen.getByRole('menuitem', { name: 'Terminal' });
  expect(terminal.getAttribute('aria-keyshortcuts')).toBe('Control+`');
  const user = userEvent.setup();
  await user.click(terminal);
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(onTerminal).toHaveBeenCalledTimes(1);
  expect(onFiles).toHaveBeenCalledTimes(1);
});

test('disables Files until there is a project', () => {
  render(<ToolList filesAvailable={false} onFiles={vi.fn()} onTerminal={vi.fn()} />);
  const files = screen.getByRole('menuitem', { name: 'Files' });
  expect(files.hasAttribute('disabled')).toBe(true);
  expect(files.textContent).toBe('FilesOpen a project first');
});
