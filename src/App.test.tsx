// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import App from './App';
vi.mock('@/components/terminal-view', () => ({ TerminalView: ({ cwd }: { cwd: string | null }) => <div data-cwd={cwd ?? ''} data-testid="terminal" /> }));
import type { ConversationApi, ConversationRef } from '@/shared/conversation-contract';
import type { SidebarOrder } from '@/shared/settings-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
const capabilities = { create: false, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: false };
const emptyOrder: SidebarOrder = { projects: [], chatsByProject: {} };

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function installApi() {
  const list = vi.fn<ConversationApi['list']>(async () => ({ projects: [{ projectPath: ref.projectPath, displayName: 'Fractal', conversations: [{ ref, title: 'Existing chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }] }], providers: [] }));
  const open = vi.fn<ConversationApi['open']>(async () => ({ summary: { ref, title: 'Existing chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }, capabilities }));
  const api: ConversationApi = {
    list, open, close: async () => undefined, create: async () => null, continue: async () => undefined,
    interrupt: async () => undefined, resolveRequest: async () => undefined, previewAttachment: async () => ({ kind: 'missing' as const }), openAttachment: async () => undefined, onEvent: () => () => undefined,
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api, settings: { get: async () => ({ theme: 'system', defaultCodingAgent: 'claude', sidebarOrder: emptyOrder }) } } });
  return { list, open };
}

test('keeps the selected Execute conversation loaded across mode switches', async () => {
  const { list, open } = installApi();
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Fractal' }));
  await user.click(screen.getByRole('button', { name: /Existing chat, Codex conversation/ }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  const listCalls = list.mock.calls.length;
  expect(listCalls).toBeGreaterThan(0);

  await user.click(screen.getByRole('radio', { name: 'Map' }));
  await user.click(screen.getByRole('radio', { name: 'Execute' }));
  expect(list).toHaveBeenCalledTimes(listCalls);
  expect(open).toHaveBeenCalledTimes(1);
});

test('keeps one right panel across modes and slides the mode toggle to its edge', async () => {
  installApi();
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Fractal' }));
  await user.click(screen.getByRole('button', { name: /Existing chat, Codex conversation/ }));
  const shift = document.querySelector('[data-slot="mode-toggle-shift"]') as HTMLElement;
  expect(shift.style.transform).toBe('translateX(0px)');

  await user.click(screen.getByRole('button', { name: 'Open right panel' }));
  expect(shift.style.transform).toBe('translateX(-272px)');
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getByTestId('terminal').getAttribute('data-cwd')).toBe('/work/fractal');

  await user.click(screen.getByRole('radio', { name: 'Map' }));
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(shift.style.transform).toBe('translateX(-272px)');
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByTestId('terminal').map((terminal) => terminal.getAttribute('data-cwd'))).toEqual(['/work/fractal', '/work/fractal']);

  await user.click(screen.getByRole('button', { name: 'Close right panel' }));
  expect(shift.style.transform).toBe('translateX(0px)');
  expect(screen.getByRole('button', { name: 'Open right panel' })).toBeTruthy();
});

test('Mod+1–3 switch modes in the toggle order', async () => {
  installApi();
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: 'Fractal' });
  await user.keyboard('{Control>}2{/Control}');
  expect(screen.getByRole('radio', { name: 'Map' }).getAttribute('aria-checked')).toBe('true');
  await user.keyboard('{Control>}3{/Control}');
  expect(screen.getByRole('radio', { name: 'Explain' }).getAttribute('aria-checked')).toBe('true');
  await user.keyboard('{Control>}1{/Control}');
  // Back on the home screen, where the toggle is hidden but still tracks the mode.
  expect(screen.getByRole('radio', { name: 'Execute', hidden: true }).getAttribute('aria-checked')).toBe('true');
});

test('hides the mode toggle on the home screen only', async () => {
  installApi();
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: 'Fractal' });
  expect(screen.queryByRole('radiogroup', { name: 'Mode' })).toBeNull();
  await user.keyboard('{Control>}2{/Control}');
  expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeTruthy();
  await user.keyboard('{Control>}1{/Control}');
  await user.click(screen.getByRole('button', { name: 'Fractal' }));
  await user.click(screen.getByRole('button', { name: /Existing chat, Codex conversation/ }));
  expect(await screen.findByRole('radiogroup', { name: 'Mode' })).toBeTruthy();
});
