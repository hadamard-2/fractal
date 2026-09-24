// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { NewConversationMenu } from './new-conversation-menu';
import { SidebarProvider } from '@/components/ui/sidebar';
import type { ConversationApi, ConversationRef, HarnessStatus } from '@/shared/conversation-contract';

const capabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false };
const codex: HarnessStatus = { provider: 'codex', availability: 'available', capabilities };
const claude: HarnessStatus = { provider: 'claude', availability: 'unavailable', capabilities: { ...capabilities, create: false }, message: '/private/provider secret' };
const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'native-thread', projectPath: '/work/fractal' };
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
  window.ResizeObserver = class { observe(): void { return undefined; } unobserve(): void { return undefined; } disconnect(): void { return undefined; } };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function install(create: ConversationApi['create']) {
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { create } } });
}

function renderMenu(providers: HarnessStatus[], onCreated: (ref: ConversationRef) => void) {
  return render(<SidebarProvider><NewConversationMenu providers={providers} onCreated={onCreated} /></SidebarProvider>);
}

describe('NewConversationMenu', () => {
  test('offers only available creation providers and selects the native reference', async () => {
    const create = vi.fn<ConversationApi['create']>(async () => ref);
    const onCreated = vi.fn(); install(create);
    renderMenu([codex, claude], onCreated);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getByRole('menuitem', { name: 'Codex' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Claude Code' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(create).toHaveBeenCalledWith({ provider: 'codex' });
    expect(onCreated).toHaveBeenCalledWith(ref);
  });

  test('keeps selection unchanged when directory selection is cancelled', async () => {
    const create = vi.fn<ConversationApi['create']>().mockResolvedValueOnce(null).mockResolvedValueOnce(ref);
    const onCreated = vi.fn(); install(create);
    renderMenu([codex], onCreated);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(onCreated).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(create).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledWith(ref);
  });

  test('shows a sanitized provider failure without changing selection', async () => {
    const onCreated = vi.fn(); install(vi.fn(async () => { throw new Error('/private/provider secret'); }));
    renderMenu([codex], onCreated);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New chat' }));
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
    const trigger = screen.getByRole('button', { name: 'New chat' });
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
