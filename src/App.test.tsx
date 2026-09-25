// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import App from './App';
vi.mock('@/components/terminal-view', () => ({ TerminalView: (): null => null }));
import type { ConversationApi, ConversationRef } from '@/shared/conversation-contract';
import type { SidebarOrder } from '@/shared/settings-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' };
const capabilities = { create: false, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: false };
const emptyOrder: SidebarOrder = { projects: [], chatsByProject: {} };

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('keeps the selected Execute conversation loaded across mode switches', async () => {
  const list = vi.fn<ConversationApi['list']>(async () => ({ projects: [{ projectPath: ref.projectPath, displayName: 'Fractal', conversations: [{ ref, title: 'Existing chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }] }], providers: [] }));
  const open = vi.fn<ConversationApi['open']>(async () => ({ summary: { ref, title: 'Existing chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }, capabilities }));
  const api: ConversationApi = {
    list, open, close: async () => undefined, create: async () => null, continue: async () => undefined,
    interrupt: async () => undefined, resolveRequest: async () => undefined, onEvent: () => () => undefined,
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api, settings: { get: async () => ({ theme: 'system', defaultCodingAgent: 'claude', sidebarOrder: emptyOrder }) } } });
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
