// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppShell } from './app-shell';
import { ExecuteMode } from './execute-mode';
vi.mock('./terminal-view', () => ({ TerminalView: (): null => null }));
import type { ConversationApi, ConversationRef, ConversationStreamEvent } from '@/shared/conversation-contract';
import type { SidebarOrder } from '@/shared/settings-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'native-choice', projectPath: '/work/fractal' };
const capabilities = { create: false, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: false };
const emptyOrder: SidebarOrder = { projects: [], chatsByProject: {} };
const settings = { get: async () => ({ theme: 'system' as const, defaultCodingAgent: 'ask' as const, sidebarOrder: emptyOrder }), set: async () => ({ theme: 'system' as const, defaultCodingAgent: 'ask' as const, sidebarOrder: emptyOrder }) };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
test('explains no selection and opens native sidebar refs while identifying unavailable providers', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
  const api: ConversationApi = {
    list: async () => ({ projects: [{ projectPath: ref.projectPath, displayName: 'Fractal', conversations: [{ ref, title: 'Review native history', updatedAt: 1, runtime: 'unknown', captureCompleteness: 'partial' }] }], providers: [{ provider: 'claude', availability: 'unavailable', capabilities, message: 'CLI executable not found' }] }),
    open: vi.fn<ConversationApi['open']>(async (selected) => ({ summary: { ref: selected, title: 'Native panel title', updatedAt: 1, runtime: 'unknown', captureCompleteness: 'partial' }, capabilities })),
    close: async () => undefined, create: async () => null, continue: async () => undefined, interrupt: async () => undefined, resolveRequest: async () => undefined, onEvent: () => () => undefined,
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api, settings } });
  const onProjectPathChange = vi.fn();
  render(<AppShell onOpenSettings={() => undefined} onProjectPathChange={onProjectPathChange}>{(shell) => <ExecuteMode {...shell} />}</AppShell>);
  expect(onProjectPathChange).toHaveBeenLastCalledWith(null);
  expect(screen.getByText('Pick up a thread')).toBeTruthy();
  await screen.findByText("Claude Code isn't available, so its conversations are hidden");
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Search' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: /Review native history/ }));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith(ref, expect.any(String)));
  expect(onProjectPathChange).toHaveBeenLastCalledWith('/work/fractal');
  expect(screen.queryByLabelText('Conversation details')).toBeNull();
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
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api, settings } });
  const user = userEvent.setup();
  render(<AppShell onOpenSettings={() => undefined}>{(shell) => <ExecuteMode {...shell} />}</AppShell>);
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
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api, settings } });
  render(<AppShell onOpenSettings={() => undefined}>{(shell) => <ExecuteMode {...shell} />}</AppShell>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'New chat in Fractal' }));
  await user.click(screen.getByRole('button', { name: 'Codex' }));
  expect(create).toHaveBeenCalledWith({ provider: 'codex', projectPath: '/work/fractal' });
  await waitFor(() => expect(open).toHaveBeenCalledWith(ref, expect.any(String)));
});

describe('home screen actions', () => {
  const creatable = { ...capabilities, create: true };
  const other: ConversationRef = { provider: 'codex', nativeSessionId: 'native-other', projectPath: '/work/other' };
  function install(create: ConversationApi['create']) {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    const api: ConversationApi = {
      list: async () => ({
        projects: [
          { projectPath: other.projectPath, displayName: 'Other', conversations: [{ ref: other, title: 'Older chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }] },
          { projectPath: ref.projectPath, displayName: 'Fractal', conversations: [{ ref, title: 'Newer chat', updatedAt: 5, runtime: 'idle', captureCompleteness: 'complete' }] },
        ],
        providers: [{ provider: 'codex', availability: 'available', capabilities: creatable }],
      }),
      open: async (selected) => ({ summary: { ref: selected, title: 'Chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }, capabilities }),
      close: async () => undefined, create, continue: async () => undefined, interrupt: async () => undefined, resolveRequest: async () => undefined, onEvent: () => () => undefined,
    };
    const codexDefault = { get: async () => ({ theme: 'system' as const, defaultCodingAgent: 'codex' as const, sidebarOrder: emptyOrder }), set: settings.set };
    Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api, settings: codexDefault } });
    return render(<AppShell onOpenSettings={() => undefined}>{(shell) => <ExecuteMode {...shell} />}</AppShell>);
  }

  test('new conversation with nothing selected asks for a project, most recent first', async () => {
    const create = vi.fn<ConversationApi['create']>(async ({ provider, projectPath }) => ({ provider, nativeSessionId: 'created', projectPath: projectPath ?? '' }));
    install(create);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /New conversation/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.click(button);
    const dialog = await screen.findByRole('dialog');
    const rows = within(dialog).getAllByRole('button').map((row) => row.textContent);
    expect(rows).toEqual(['Fractal/work/fractal', 'Other/work/other', 'Choose another folder…']);
    await user.click(within(dialog).getByRole('button', { name: /Other/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ provider: 'codex', projectPath: '/work/other' }));
  });

  test('choosing another folder hands the folder choice to the main process', async () => {
    const create = vi.fn<ConversationApi['create']>(async () => null);
    install(create);
    const user = userEvent.setup();
    await screen.findByText('Fractal');
    await user.keyboard('{Control>}n{/Control}');
    await user.click(await screen.findByRole('button', { name: 'Choose another folder…' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ provider: 'codex' }));
  });

  test('Mod+O and the sidebar New project row start a chat in a picked folder', async () => {
    const create = vi.fn<ConversationApi['create']>(async () => null);
    install(create);
    const user = userEvent.setup();
    await screen.findByText('Fractal');
    await waitFor(() => expect((screen.getByRole('button', { name: /New conversation/ }) as HTMLButtonElement).disabled).toBe(false));
    await user.keyboard('{Control>}o{/Control}');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenLastCalledWith({ provider: 'codex' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith({ provider: 'codex' });
  });

  test('Mod+N with a conversation open starts one in its project without asking', async () => {
    const create = vi.fn<ConversationApi['create']>(async ({ provider, projectPath }) => ({ provider, nativeSessionId: 'created', projectPath: projectPath ?? '' }));
    install(create);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Other' }));
    await user.click(await screen.findByText('Older chat'));
    await user.keyboard('{Control>}n{/Control}');
    await waitFor(() => expect(create).toHaveBeenCalledWith({ provider: 'codex', projectPath: '/work/other' }));
    expect(screen.queryByText('Choose the project to start it in.')).toBeNull();
  });

  test('Mod+K opens search, but not from inside a terminal', async () => {
    install(vi.fn<ConversationApi['create']>(async () => null));
    const user = userEvent.setup();
    await screen.findByText('Fractal');
    const terminal = document.createElement('div');
    terminal.dataset.slot = 'terminal';
    const input = document.createElement('textarea');
    terminal.append(input);
    document.body.append(terminal);
    input.focus();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('searchbox')).toBeNull();
    terminal.remove();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('searchbox')).toBeTruthy();
  });
});
