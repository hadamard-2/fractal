// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ToolList } from './tool-entries';

afterEach(cleanup);

test('lists every tool in order, with Terminal and Files available', async () => {
  const onTerminal = vi.fn();
  const onFiles = vi.fn();
  render(<ToolList onFiles={onFiles} onTerminal={onTerminal} projectOpen />);
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'ReviewSoon', 'TerminalCtrl+`', 'BrowserSoon', 'FilesCtrl+Shift+F', 'Side chatSoon',
  ]);
  for (const name of ['Review', 'Browser', 'Side chat']) {
    expect(screen.getByRole('menuitem', { name }).hasAttribute('disabled')).toBe(true);
  }
  const terminal = screen.getByRole('menuitem', { name: 'Terminal' });
  expect(terminal.getAttribute('aria-keyshortcuts')).toBe('Control+`');
  expect(screen.getByRole('menuitem', { name: 'Files' }).getAttribute('aria-keyshortcuts')).toBe('Control+Shift+F');
  const user = userEvent.setup();
  await user.click(terminal);
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(onTerminal).toHaveBeenCalledTimes(1);
  expect(onFiles).toHaveBeenCalledTimes(1);
});

test('disables Terminal and Files until there is a project', () => {
  render(<ToolList onFiles={vi.fn()} onTerminal={vi.fn()} projectOpen={false} />);
  for (const name of ['Terminal', 'Files']) {
    const item = screen.getByRole('menuitem', { name });
    expect(item.hasAttribute('disabled')).toBe(true);
    expect(item.hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(item.textContent).toBe(`${name}Open a project first`);
  }
});
