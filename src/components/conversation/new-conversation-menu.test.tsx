// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { NewConversationMenu } from './new-conversation-menu';
import { SidebarProvider } from '@/components/ui/sidebar';
import type { ConversationApi, ConversationRef, HarnessStatus } from '@/shared/conversation-contract';
import type { DefaultCodingAgent, FractalSettings } from '@/shared/settings-contract';

const capabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false };
const codex: HarnessStatus = { provider: 'codex', availability: 'available', capabilities };
const claude: HarnessStatus = { provider: 'claude', availability: 'unavailable', capabilities: { ...capabilities, create: false }, message: '/private/provider secret' };
const availableClaude: HarnessStatus = { ...claude, availability: 'available', capabilities };
const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'native-thread', projectPath: '/work/fractal' };
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
  window.ResizeObserver = class { observe(): void { return undefined; } unobserve(): void { return undefined; } disconnect(): void { return undefined; } };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function install(create: ConversationApi['create'], defaultCodingAgent: DefaultCodingAgent = 'ask') {
  const settings: FractalSettings = { theme: 'system', defaultCodingAgent, sidebarOrder: { projects: [], chatsByProject: {} } };
  Object.defineProperty(window, 'fractal', { configurable: true, value: {
    conversations: { create },
    settings: { get: async () => settings },
  } });
}

function renderMenu(providers: HarnessStatus[], onCreated: (ref: ConversationRef) => void) {
  return render(<SidebarProvider><NewConversationMenu onCreated={onCreated} projectName="Fractal" projectPath="/work/fractal" providers={providers} /></SidebarProvider>);
}

describe('NewConversationMenu', () => {
  test('creates with the saved agent and keeps an explicit agent chooser', async () => {
    const create = vi.fn<ConversationApi['create']>(async ({ provider }) => ({ ...ref, provider }));
    const onCreated = vi.fn(); install(create, 'claude');
    renderMenu([codex, availableClaude], onCreated);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ provider: 'claude', projectPath: '/work/fractal' }));
    expect(onCreated).toHaveBeenCalledWith({ ...ref, provider: 'claude' });

    await user.click(screen.getByRole('button', { name: 'Choose coding agent for Fractal' }));
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(create).toHaveBeenCalledWith({ provider: 'codex', projectPath: '/work/fractal' });
  });

  test('opens the chooser when the saved agent cannot create a chat', async () => {
    const create = vi.fn<ConversationApi['create']>(async () => ref);
    install(create, 'claude');
    renderMenu([codex, claude], vi.fn());

    await userEvent.setup().click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    expect(await screen.findByRole('menuitem', { name: 'Codex' })).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  test('uses Claude Code when an older settings payload has no agent choice', async () => {
    const create = vi.fn<ConversationApi['create']>(async ({ provider }) => ({ ...ref, provider }));
    const olderSettings = { theme: 'system', sidebarOrder: { projects: [], chatsByProject: {} } } as FractalSettings;
    Object.defineProperty(window, 'fractal', { configurable: true, value: {
      conversations: { create },
      settings: { get: async () => olderSettings },
    } });
    renderMenu([codex, availableClaude], vi.fn());

    await userEvent.setup().click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ provider: 'claude', projectPath: '/work/fractal' }));
  });

  test('reads the current preference when the same project starts another chat', async () => {
    let defaultCodingAgent: DefaultCodingAgent = 'claude';
    const create = vi.fn<ConversationApi['create']>(async ({ provider }) => ({ ...ref, provider }));
    Object.defineProperty(window, 'fractal', { configurable: true, value: {
      conversations: { create },
      settings: { get: async (): Promise<FractalSettings> => ({ theme: 'system', defaultCodingAgent, sidebarOrder: { projects: [], chatsByProject: {} } }) },
    } });
    renderMenu([codex, availableClaude], vi.fn());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    defaultCodingAgent = 'ask';
    await user.click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    expect(await screen.findByRole('menuitem', { name: 'Codex' })).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('offers only available creation providers and selects the native reference', async () => {
    const create = vi.fn<ConversationApi['create']>(async () => ref);
    const onCreated = vi.fn(); install(create);
    renderMenu([codex, claude], onCreated);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    expect(screen.getByRole('menuitem', { name: 'Codex' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Claude Code' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(create).toHaveBeenCalledWith({ provider: 'codex', projectPath: '/work/fractal' });
    expect(onCreated).toHaveBeenCalledWith(ref);
  });

  test('keeps selection unchanged when creation returns no reference', async () => {
    const create = vi.fn<ConversationApi['create']>().mockResolvedValueOnce(null).mockResolvedValueOnce(ref);
    const onCreated = vi.fn(); install(create);
    renderMenu([codex], onCreated);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(onCreated).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(create).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledWith(ref);
  });

  test('shows a sanitized provider failure without changing selection', async () => {
    const onCreated = vi.fn(); install(vi.fn(async () => { throw new Error('/private/provider secret'); }));
    renderMenu([codex], onCreated);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect((await screen.findByRole('status')).textContent).toBe('Codex could not create a conversation.');
    expect(screen.queryByText(/private|secret/i)).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('serializes creation and ignores a stale completion after unmount', async () => {
    const pending = deferred<ConversationRef | null>();
    const create = vi.fn<ConversationApi['create']>(() => pending.promise);
    const onCreated = vi.fn(); install(create);
    const view = renderMenu([codex, { ...codex, provider: 'claude' }], onCreated);
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'New chat in Fractal' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    expect(trigger).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toBe('Creating Codex conversation…');
    trigger.removeAttribute('disabled');
    await user.click(trigger);
    expect(create).toHaveBeenCalledTimes(1);
    view.unmount();
    pending.resolve(ref);
    await Promise.resolve();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
