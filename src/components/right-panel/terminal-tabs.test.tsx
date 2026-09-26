// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TerminalTabs, terminalTabLabel, type TerminalTab } from './terminal-tabs';

afterEach(cleanup);

test('labels tabs by shell, numbering all but the first', () => {
  expect(terminalTabLabel({ id: 'a', cwd: null, number: 1 })).toBe('Terminal');
  expect(terminalTabLabel({ id: 'a', cwd: null, number: 1, shell: 'zsh' })).toBe('zsh');
  expect(terminalTabLabel({ id: 'b', cwd: null, number: 2, shell: 'zsh' })).toBe('zsh 2');
  expect(terminalTabLabel({ id: 'c', cwd: null, number: 3 })).toBe('Terminal 3');
});

test('selects, closes, closes on middle-click, and marks exited shells', async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const tabs: TerminalTab[] = [
    { id: 'a', cwd: '/repo', number: 1, shell: 'zsh' },
    { id: 'b', cwd: '/repo', number: 2, shell: 'zsh', exited: true },
  ];
  render(<TooltipProvider><TerminalTabs onClose={onClose} onSelect={onSelect} selectedId="a" tabs={tabs} /></TooltipProvider>);
  const user = userEvent.setup();
  expect(screen.getByRole('tab', { name: 'zsh' }).getAttribute('aria-selected')).toBe('true');
  const exited = screen.getByRole('tab', { name: 'zsh 2 (exited)' });
  expect(exited.getAttribute('aria-selected')).toBe('false');
  await user.click(exited);
  expect(onSelect).toHaveBeenCalledWith('b');
  await user.click(screen.getByRole('button', { name: 'Close zsh' }));
  expect(onClose).toHaveBeenCalledWith('a');
  fireEvent(exited, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(onClose).toHaveBeenCalledWith('b');
});
