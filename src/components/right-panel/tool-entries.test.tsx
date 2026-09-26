// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ToolList } from './tool-entries';

afterEach(cleanup);

test('lists every tool in order with only Terminal available', async () => {
  const onTerminal = vi.fn();
  render(<ToolList onTerminal={onTerminal} />);
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'ReviewSoon', 'TerminalCtrl+`', 'BrowserSoon', 'FilesSoon', 'Side chatSoon',
  ]);
  for (const name of ['Review', 'Browser', 'Files', 'Side chat']) {
    expect(screen.getByRole('menuitem', { name }).hasAttribute('disabled')).toBe(true);
  }
  const terminal = screen.getByRole('menuitem', { name: 'Terminal' });
  expect(terminal.hasAttribute('disabled')).toBe(false);
  expect(terminal.getAttribute('aria-keyshortcuts')).toBe('Control+`');
  await userEvent.setup().click(terminal);
  expect(onTerminal).toHaveBeenCalledTimes(1);
});
