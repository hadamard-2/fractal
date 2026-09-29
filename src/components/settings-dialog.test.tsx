// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { SettingsDialog } from './settings-dialog';
import type { AgentEnvironment, FractalSettings } from '@/shared/settings-contract';

beforeAll(() => {
  // jsdom has no layout; Radix scrolls the selected option into view.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: (): void => undefined });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('loads the coding agent and saves a choice from its selector', async () => {
  let stored: FractalSettings = {
    theme: 'system', defaultCodingAgent: 'claude', sidebarOrder: { projects: [], chatsByProject: {} }, projectVisibility: { archived: [], removed: [] }, projectFilter: 'active', showAgentColorTags: true, agentExecutables: { claude: '', codex: '' },
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

test('turns agent color tags off, reporting the change and reverting it if the save fails', async () => {
  const stored: FractalSettings = {
    theme: 'system', defaultCodingAgent: 'claude', sidebarOrder: { projects: [], chatsByProject: {} }, projectVisibility: { archived: [], removed: [] }, projectFilter: 'active', showAgentColorTags: true, agentExecutables: { claude: '', codex: '' },
  };
  const set = vi.fn(async () => { throw new Error('disk full'); });
  Object.defineProperty(window, 'fractal', { configurable: true, value: {
    settings: { get: async () => stored, set },
  } });
  const onChange = vi.fn();

  render(<SettingsDialog open onOpenChange={vi.fn()} onShowAgentColorTagsChange={onChange} />);
  const toggle = await screen.findByRole('switch', { name: 'Agent color tags' });
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));

  await userEvent.setup().click(toggle);
  expect(set).toHaveBeenCalledWith({ showAgentColorTags: false });
  await waitFor(() => expect(onChange.mock.calls).toEqual([[false], [true]]));
  expect(toggle.getAttribute('aria-checked')).toBe('true');
});

function mountWithSettings(agentExecutables: FractalSettings['agentExecutables'], agentEnvironment: () => Promise<AgentEnvironment>) {
  let stored: FractalSettings = {
    theme: 'system', defaultCodingAgent: 'claude', sidebarOrder: { projects: [], chatsByProject: {} }, projectVisibility: { archived: [], removed: [] }, projectFilter: 'active', showAgentColorTags: true, agentExecutables,
  };
  const set = vi.fn(async (patch: Partial<FractalSettings>) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  Object.defineProperty(window, 'fractal', { configurable: true, value: { settings: { get: async () => stored, set, agentEnvironment } } });
  render(<SettingsDialog open onOpenChange={vi.fn()} />);
  return set;
}

const resolvedEnvironment = async (): Promise<AgentEnvironment> => ({ shellPath: { status: 'resolved', shell: '/usr/bin/zsh' }, searchPath: ['/usr/bin', '/home/me/.local/bin'] });

test('shows each agent location and saves an edit when the field loses focus', async () => {
  const set = mountWithSettings({ claude: '/opt/claude', codex: '' }, resolvedEnvironment);
  const claude = await screen.findByRole('textbox', { name: 'Claude Code location' });
  await waitFor(() => expect((claude as HTMLInputElement).value).toBe('/opt/claude'));
  const codex = screen.getByRole('textbox', { name: 'Codex location' }) as HTMLInputElement;
  expect(codex.value).toBe('');
  expect(codex.placeholder).toBe('codex');

  const user = userEvent.setup();
  await user.click(codex);
  await user.keyboard('~/bin/codex');
  await user.tab();
  await waitFor(() => expect(set).toHaveBeenCalledWith({ agentExecutables: { claude: '/opt/claude', codex: '~/bin/codex' } }));
});

test('Enter saves, and clearing a location goes back to searching PATH', async () => {
  const set = mountWithSettings({ claude: '/opt/claude', codex: '' }, resolvedEnvironment);
  const claude = await screen.findByRole('textbox', { name: 'Claude Code location' });
  await waitFor(() => expect((claude as HTMLInputElement).value).toBe('/opt/claude'));

  const user = userEvent.setup();
  await user.clear(claude);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(set).toHaveBeenCalledWith({ agentExecutables: { claude: '', codex: '' } }));
});

test('does not save a location that did not change', async () => {
  const set = mountWithSettings({ claude: '/opt/claude', codex: '' }, resolvedEnvironment);
  const claude = await screen.findByRole('textbox', { name: 'Claude Code location' });
  await waitFor(() => expect((claude as HTMLInputElement).value).toBe('/opt/claude'));
  const user = userEvent.setup();
  await user.click(claude);
  await user.tab();
  expect(set).not.toHaveBeenCalled();
});

test('lists the folders Fractal searches and says the login shell PATH is included', async () => {
  mountWithSettings({ claude: '', codex: '' }, resolvedEnvironment);
  expect(await screen.findByText("Includes your login shell's PATH (/usr/bin/zsh).")).toBeTruthy();
  const folders = screen.getByRole('list', { name: 'Folders searched for agents' });
  expect(Array.from(folders.querySelectorAll('li'), (item) => item.textContent)).toEqual(['/usr/bin', '/home/me/.local/bin']);
});

test('says when the login shell PATH could not be read', async () => {
  mountWithSettings({ claude: '', codex: '' }, async () => ({ shellPath: { status: 'failed', shell: '/usr/bin/zsh', reason: 'timed out after 5000 ms' }, searchPath: ['/usr/bin'] }));
  expect(await screen.findByText("Couldn't read your login shell's PATH (/usr/bin/zsh timed out after 5000 ms), so only the PATH Fractal was launched with is searched.")).toBeTruthy();
});
