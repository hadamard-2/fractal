// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
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

test('labels a Changes tab and shows its project as the tooltip', async () => {
  const changes: PanelTab = { kind: 'changes', id: 'c', projectPath: '/repo/app' };
  expect(panelTabLabel(changes, 0)).toBe('Changes');
  expect(tabPanelId(changes)).toBe('panel-c');
  const onPin = vi.fn();
  render(<TooltipProvider><PanelTabs onClose={vi.fn()} onPin={onPin} onSelect={vi.fn()} selectedId="c" tabs={[changes]} /></TooltipProvider>);
  const tab = screen.getByRole('tab', { name: 'Changes' });
  expect(tab.getAttribute('aria-controls')).toBe('panel-c');
  const user = userEvent.setup();
  await user.dblClick(tab);
  expect(onPin).not.toHaveBeenCalled();
  cleanup();
  render(<TooltipProvider><PanelTabs onClose={vi.fn()} onPin={onPin} onSelect={vi.fn()} selectedId="c" tabs={[changes]} /></TooltipProvider>);
  await user.tab();
  expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', '/repo/app');
});

describe('side-chat tabs', () => {
  const root = { provider: 'claude' as const, nativeSessionId: 'root', projectPath: '/repo' };
  const sideChat = (branchPointText?: string): PanelTab => ({ kind: 'side-chat', id: 's', root, sideChat: null, ...(branchPointText === undefined ? {} : { branchPointText }) });
  const tooltipOf = async (tab: PanelTab) => {
    render(<TooltipProvider><PanelTabs onClose={vi.fn()} onPin={vi.fn()} onSelect={vi.fn()} selectedId="s" tabs={[tab]} /></TooltipProvider>);
    expect(screen.getByRole('tab', { name: 'Side chat' }).getAttribute('aria-controls')).toBe('panel-s');
    expect(document.querySelector('[title]')).toBeNull();
    await userEvent.setup().tab();
    const text = (await screen.findByRole('tooltip')).textContent;
    cleanup();
    return text;
  };

  test('is labelled Side chat', () => {
    expect(panelTabLabel(sideChat('Anything'), 0)).toBe('Side chat');
  });

  test('shows the first line of its branch point as the tooltip, cut to 80 characters', async () => {
    expect(await tooltipOf(sideChat('Short reply\nSecond line'))).toBe('Short reply');
    expect(await tooltipOf(sideChat(`${'a'.repeat(80)}\nmore`))).toBe('a'.repeat(80));
    expect(await tooltipOf(sideChat(`${'b'.repeat(81)}`))).toBe(`${'b'.repeat(80)}…`);
  });

  test('falls back to Side chat as the tooltip without branch-point text', async () => {
    expect(await tooltipOf(sideChat())).toBe('Side chat');
    expect(await tooltipOf(sideChat(''))).toBe('Side chat');
  });
});
