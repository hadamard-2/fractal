// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { PanelTab } from '@/renderer/panel-tabs';
import { PanelTabs, panelTabLabel, tabPanelId } from './panel-tabs';

afterEach(cleanup);

const tabs: PanelTab[] = [
  { kind: 'terminal', id: 'a', cwd: '/repo', number: 1, shell: 'zsh' },
  { kind: 'terminal', id: 'b', cwd: '/repo', number: 2, shell: 'zsh', exited: true },
  { kind: 'file', id: 'f', projectPath: '/repo', path: 'src/a.ts', preview: true },
  { kind: 'file', id: 'g', projectPath: '/repo', path: null, preview: true },
  { kind: 'file', id: 'h', projectPath: '/repo', path: 'README.md', preview: false },
];

test('labels terminals and file tabs, and names each tab\'s panel', () => {
  expect(panelTabLabel(tabs[0], 2)).toBe('Terminal 1');
  expect(panelTabLabel(tabs[2], 2)).toBe('a.ts');
  expect(panelTabLabel(tabs[3], 2)).toBe('Files');
  expect(tabPanelId(tabs[0])).toBe('terminal-panel-a');
  expect(tabPanelId(tabs[2])).toBe('panel-f');
});

test('selects, closes, pins file tabs on double-click, and marks previews and exited shells', async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onPin = vi.fn();
  render(<TooltipProvider><PanelTabs onClose={onClose} onPin={onPin} onSelect={onSelect} selectedId="f" tabs={tabs} /></TooltipProvider>);
  const user = userEvent.setup();
  const preview = screen.getByRole('tab', { name: 'a.ts (preview)' });
  expect(preview.getAttribute('aria-selected')).toBe('true');
  expect(preview.querySelector('.italic')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'README.md' }).querySelector('.italic')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Terminal 2 (exited)' })).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));
  expect(onSelect).toHaveBeenCalledWith('a');
  await user.dblClick(preview);
  expect(onPin).toHaveBeenCalledWith('f');
  await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
  expect(onPin).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Close a.ts' }));
  expect(onClose).toHaveBeenCalledWith('f');
  fireEvent(screen.getByRole('tab', { name: 'README.md' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(onClose).toHaveBeenCalledWith('h');
});
