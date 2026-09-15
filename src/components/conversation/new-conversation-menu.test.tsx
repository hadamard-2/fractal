// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NewConversationMenu } from './new-conversation-menu';
import type { ConversationApi, ConversationRef, HarnessStatus } from '@/shared/conversation-contract';

const capabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false };
const codex: HarnessStatus = { provider: 'codex', availability: 'available', capabilities };
const claude: HarnessStatus = { provider: 'claude', availability: 'unavailable', capabilities: { ...capabilities, create: false }, message: '/private/provider secret' };
const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'native-thread', projectPath: '/work/fractal' };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function install(create: ConversationApi['create']) {
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { create } } });
}

describe('NewConversationMenu', () => {
  test('offers only available creation providers and selects the native reference', async () => {
    const create = vi.fn<ConversationApi['create']>(async () => ref);
    const onCreated = vi.fn(); install(create);
    render(<NewConversationMenu providers={[codex, claude]} onCreated={onCreated} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(screen.getByRole('menuitem', { name: 'Codex' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Claude Code' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(create).toHaveBeenCalledWith({ provider: 'codex' });
    expect(onCreated).toHaveBeenCalledWith(ref);
  });

  test('keeps selection unchanged when directory selection is cancelled', async () => {
    const onCreated = vi.fn(); install(vi.fn(async () => null));
    render(<NewConversationMenu providers={[codex]} onCreated={onCreated} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('shows a sanitized provider failure without changing selection', async () => {
    const onCreated = vi.fn(); install(vi.fn(async () => { throw new Error('/private/provider secret'); }));
    render(<NewConversationMenu providers={[codex]} onCreated={onCreated} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    await user.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect((await screen.findByRole('status')).textContent).toBe('Codex could not create a conversation.');
    expect(screen.queryByText(/private|secret/i)).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
