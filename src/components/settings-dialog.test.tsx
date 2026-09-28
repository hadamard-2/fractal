// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { SettingsDialog } from './settings-dialog';
import type { FractalSettings } from '@/shared/settings-contract';

beforeAll(() => {
  // jsdom has no layout; Radix scrolls the selected option into view.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: (): void => undefined });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('loads the coding agent and saves a choice from its selector', async () => {
  let stored: FractalSettings = {
    theme: 'system', defaultCodingAgent: 'claude', sidebarOrder: { projects: [], chatsByProject: {} }, projectVisibility: { archived: [], removed: [] }, projectFilter: 'active',
  };
  const set = vi.fn(async (patch: Partial<FractalSettings>) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  Object.defineProperty(window, 'fractal', { configurable: true, value: {
    settings: { get: async () => stored, set },
  } });

  render(<SettingsDialog open onOpenChange={vi.fn()} />);
  const codingAgent = await screen.findByRole('combobox', { name: 'Coding agent' });
  expect(codingAgent.textContent).toContain('Claude Code');

  const user = userEvent.setup();
  codingAgent.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('option', { name: 'Ask every time' })).toBeTruthy();
  await user.keyboard('{End}{Enter}');
  await waitFor(() => expect(set).toHaveBeenCalledWith({ defaultCodingAgent: 'ask' }));
  expect(codingAgent.textContent).toContain('Ask every time');
});

test('shows Claude Code when settings came from an older payload without an agent choice', async () => {
  const olderSettings = { theme: 'system', sidebarOrder: { projects: [], chatsByProject: {} } } as FractalSettings;
  Object.defineProperty(window, 'fractal', { configurable: true, value: {
    settings: { get: async () => olderSettings },
  } });

  render(<SettingsDialog open onOpenChange={vi.fn()} />);
  const codingAgent = await screen.findByRole('combobox', { name: 'Coding agent' });
  await waitFor(() => expect(codingAgent.textContent).toContain('Claude Code'));
});
