// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ExecuteMode } from './execute-mode';
import type { ConversationApi, ConversationRef, ConversationStreamEvent } from '@/shared/conversation-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'native-choice', projectPath: '/work/fractal' };
const capabilities = { create: false, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: false };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
test('explains no selection and opens native sidebar refs while identifying unavailable providers', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
  const api: ConversationApi = {
    list: async () => ({ projects: [{ projectPath: ref.projectPath, displayName: 'Fractal', conversations: [{ ref, title: 'Review native history', updatedAt: 1, runtime: 'unknown', captureCompleteness: 'partial' }] }], providers: [{ provider: 'claude', availability: 'unavailable', capabilities, message: 'CLI executable not found' }] }),
    open: vi.fn<ConversationApi['open']>(async (selected) => ({ summary: { ref: selected, title: 'Native panel title', updatedAt: 1, runtime: 'unknown', captureCompleteness: 'partial' }, capabilities })),
    close: async () => undefined, create: async () => null, continue: async () => undefined, interrupt: async () => undefined, resolveRequest: async () => undefined, onEvent: () => () => undefined,
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api } });
  render(<ExecuteMode onOpenSettings={() => undefined} />);
  expect(screen.getByText('Select a conversation')).toBeTruthy();
  await screen.findByText(/claude.*unavailable/i);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Search' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: /Review native history/ }));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith(ref, expect.any(String)));
  expect(await screen.findByText('Native panel title')).toBeTruthy();
  expect(screen.getByText('(Codex · Status unknown)')).toBeTruthy();
});

test('refreshes breadcrumb metadata when the same native ref is selected again', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
  const listeners = new Set<(event: ConversationStreamEvent) => void>();
  let title = 'Fix parser';
  let project = 'Fractal';
  let runtime: 'unknown' | 'waiting-for-user' = 'unknown';
  const api: ConversationApi = {
    list: async () => ({ projects: [{ projectPath: ref.projectPath, displayName: project, conversations: [{ ref, title, updatedAt: 1, runtime, captureCompleteness: 'partial' }] }], providers: [] }),
    open: async () => ({ summary: { ref, title: 'Native details', updatedAt: 1, runtime: 'unknown', captureCompleteness: 'partial' }, capabilities }),
    close: async () => undefined, create: async () => null, continue: async () => undefined, interrupt: async () => undefined, resolveRequest: async () => undefined,
    onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api } });
  const user = userEvent.setup();
  render(<ExecuteMode onOpenSettings={() => undefined} />);
  await user.click(await screen.findByRole('button', { name: 'Fractal' }));
  await user.click(await screen.findByText('Fix parser'));
  title = 'Fix parser again';
  project = 'Fractal next';
  runtime = 'waiting-for-user';
  act(() => { for (const listener of listeners) listener({ type: 'summary.updated', ref, loadId: 'history-list-refresh', seq: 0, summary: { ref, title, updatedAt: 2, runtime, captureCompleteness: 'partial' } }); });
  await user.click(await screen.findByText('Fix parser again'));
  expect(screen.getByText('Fractal next', { selector: '[data-slot="breadcrumb-item"]' })).toBeTruthy();
  expect(screen.getByText('Fix parser again', { selector: '[data-slot="breadcrumb-page"]' })).toBeTruthy();
  expect(await screen.findByText('(Codex · Waiting for you)')).toBeTruthy();
  expect(screen.queryByText('Fix parser')).toBeNull();
});

test('creates a chat from a project row and opens its native reference', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
  window.ResizeObserver = class { observe(): void { return undefined; } unobserve(): void { return undefined; } disconnect(): void { return undefined; } };
  const create = vi.fn<ConversationApi['create']>(async () => ref);
  const open = vi.fn<ConversationApi['open']>(async () => ({ summary: { ref, title: 'New chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }, capabilities }));
  const api: ConversationApi = {
    list: async () => ({ projects: [{ projectPath: ref.projectPath, displayName: 'Fractal', conversations: [{ ref, title: 'Existing chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }] }], providers: [{ provider: 'codex', availability: 'available', capabilities: { ...capabilities, create: true } }] }),
    open, create, close: async () => undefined, continue: async () => undefined, interrupt: async () => undefined, resolveRequest: async () => undefined, onEvent: () => () => undefined,
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api } });
  render(<ExecuteMode onOpenSettings={() => undefined} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'New chat in Fractal' }));
  await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
  expect(create).toHaveBeenCalledWith({ provider: 'codex', projectPath: '/work/fractal' });
  await waitFor(() => expect(open).toHaveBeenCalledWith(ref, expect.any(String)));
});
