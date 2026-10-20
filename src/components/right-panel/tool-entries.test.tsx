// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { ToolList, ToolMenuItems } from './tool-entries';

afterEach(cleanup);

test('lists every tool in order, with Terminal and Files available', async () => {
  const onTerminal = vi.fn();
  const onFiles = vi.fn();
  render(<ToolList onChanges={vi.fn()} onFiles={onFiles} onTerminal={onTerminal} projectOpen sideChat={{ hint: 'No reply to branch from yet' }} />);
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'ChangesCtrl+Shift+D', 'TerminalCtrl+`', 'BrowserSoon', 'FilesCtrl+Shift+F', 'Side chatNo reply to branch from yet',
  ]);
  for (const name of ['Browser', 'Side chat']) {
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

test('disables Terminal, Files and Changes until there is a project', () => {
  render(<ToolList onChanges={vi.fn()} onFiles={vi.fn()} onTerminal={vi.fn()} projectOpen={false} sideChat={{ hint: 'Open a conversation first' }} />);
  for (const name of ['Terminal', 'Files', 'Changes']) {
    const item = screen.getByRole('menuitem', { name });
    expect(item.hasAttribute('disabled')).toBe(true);
    expect(item.hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(item.textContent).toBe(`${name}Open a project first`);
  }
});

test('Changes is enabled with a project and shows its shortcut', async () => {
  const onChanges = vi.fn();
  render(<ToolList onChanges={onChanges} onFiles={vi.fn()} onTerminal={vi.fn()} projectOpen sideChat={{}} />);
  const item = screen.getByRole('menuitem', { name: 'Changes' });
  expect(item.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+D');
  expect(item.hasAttribute('disabled')).toBe(false);
  await userEvent.setup().click(item);
  expect(onChanges).toHaveBeenCalledTimes(1);
});

test.each(['Open a conversation first', 'Not available in subagent chats', 'No reply to branch from yet'])('Side chat is disabled with the hint %s', (hint) => {
  render(<ToolList onChanges={vi.fn()} onFiles={vi.fn()} onTerminal={vi.fn()} projectOpen sideChat={{ hint }} />);
  const item = screen.getByRole('menuitem', { name: 'Side chat' });
  expect(item.hasAttribute('disabled')).toBe(true);
  expect(item.textContent).toBe(`Side chat${hint}`);
  cleanup();
  render(<DropdownMenu open><DropdownMenuContent><ToolMenuItems onChanges={vi.fn()} onFiles={vi.fn()} onTerminal={vi.fn()} projectOpen sideChat={{ hint }} /></DropdownMenuContent></DropdownMenu>);
  const menuItem = screen.getByRole('menuitem', { name: 'Side chat' });
  expect(menuItem.getAttribute('aria-disabled')).toBe('true');
  expect(menuItem.textContent).toBe(`Side chat${hint}`);
});

test('Side chat is enabled with a handler, in the list and in the menu', async () => {
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(<ToolList onChanges={vi.fn()} onFiles={vi.fn()} onTerminal={vi.fn()} projectOpen sideChat={{ onSelect }} />);
  const item = screen.getByRole('menuitem', { name: 'Side chat' });
  expect(item.hasAttribute('disabled')).toBe(false);
  expect(item.textContent).toBe('Side chat');
  await user.click(item);
  cleanup();
  render(<DropdownMenu open><DropdownMenuContent><ToolMenuItems onChanges={vi.fn()} onFiles={vi.fn()} onTerminal={vi.fn()} projectOpen sideChat={{ onSelect }} /></DropdownMenuContent></DropdownMenu>);
  const menuItem = screen.getByRole('menuitem', { name: 'Side chat' });
  expect(menuItem.hasAttribute('aria-disabled')).toBe(false);
  await user.click(menuItem);
  expect(onSelect).toHaveBeenCalledTimes(2);
});
