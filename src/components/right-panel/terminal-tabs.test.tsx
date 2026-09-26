// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { nextTerminalNumber, TerminalTabs, terminalTabLabel, type TerminalTab } from './terminal-tabs';

afterEach(cleanup);

test('labels a lone terminal plainly and numbers several', () => {
  expect(terminalTabLabel({ id: 'a', cwd: null, number: 2, shell: 'zsh' }, 1)).toBe('Terminal');
  expect(terminalTabLabel({ id: 'a', cwd: null, number: 1, shell: 'zsh' }, 2)).toBe('Terminal 1');
  expect(terminalTabLabel({ id: 'b', cwd: null, number: 3 }, 2)).toBe('Terminal 3');
});

test('takes the lowest number no open tab is using', () => {
  const tab = (number: number): TerminalTab => ({ id: String(number), cwd: null, number });
  expect(nextTerminalNumber([])).toBe(1);
  expect(nextTerminalNumber([tab(1), tab(3)])).toBe(2);
  expect(nextTerminalNumber([tab(2)])).toBe(1);
  expect(nextTerminalNumber([tab(1), tab(2)])).toBe(3);
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
  expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe('true');
  const exited = screen.getByRole('tab', { name: 'Terminal 2 (exited)' });
  expect(exited.getAttribute('aria-selected')).toBe('false');
  await user.click(exited);
  expect(onSelect).toHaveBeenCalledWith('b');
  await user.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
  expect(onClose).toHaveBeenCalledWith('a');
  fireEvent(exited, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(onClose).toHaveBeenCalledWith('b');
});
