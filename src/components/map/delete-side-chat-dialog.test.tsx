// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { ConversationApi, SideChatSummary } from '@/shared/conversation-contract';
import { DeleteSideChatDialog } from './delete-side-chat-dialog';

const sideChat: SideChatSummary = {
  ref: { provider: 'claude', nativeSessionId: 'side', projectPath: '/work' },
  parentKey: 'claude:root', afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 1,
};

function setup({ nested = 0, deleteSideChat = vi.fn(async () => undefined), provider = 'claude' }: { nested?: number; deleteSideChat?: ConversationApi['deleteSideChat']; provider?: 'claude' | 'codex' } = {}) {
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { deleteSideChat } } });
  const calls: string[] = [];
  const onDeleted = vi.fn(() => { calls.push('deleted'); });
  const onClose = vi.fn();
  render(<DeleteSideChatDialog nested={nested} onClose={onClose} onDeleted={onDeleted} sideChat={{ ...sideChat, ref: { ...sideChat.ref, provider } }} />);
  return { deleteSideChat, onDeleted, onClose, calls };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('asks with the title, body and buttons from the spec', () => {
  setup();
  expect(screen.getByRole('dialog', { name: 'Delete side chat?' })).toBeTruthy();
  expect(screen.getByText('This deletes the side chat from the map and from Claude Code\'s own history. It can\'t be undone.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
});

test('names the agent the side chat runs in', () => {
  setup({ provider: 'codex' });
  expect(screen.getByText('This deletes the side chat from the map and from Codex\'s own history. It can\'t be undone.')).toBeTruthy();
});

test('counts the side chats inside it', () => {
  setup({ nested: 2 });
  expect(screen.getByText('This deletes the side chat and the 2 side chats inside it from the map and from Claude Code\'s own history. It can\'t be undone.')).toBeTruthy();
});

test('one nested side chat reads in the singular', () => {
  setup({ nested: 1 });
  expect(screen.getByText('This deletes the side chat and the 1 side chat inside it from the map and from Claude Code\'s own history. It can\'t be undone.')).toBeTruthy();
});

test('Delete deletes the side chat once, then reports it and closes', async () => {
  const { deleteSideChat, onDeleted, onClose } = setup();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(deleteSideChat).toHaveBeenCalledTimes(1);
  expect(deleteSideChat).toHaveBeenCalledWith(sideChat.ref);
  expect(onDeleted).toHaveBeenCalledTimes(1);
  expect(onDeleted.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
});

test('both buttons are disabled while the delete runs, and a second click deletes nothing more', async () => {
  let finish: () => void = () => undefined;
  const { deleteSideChat, onClose } = setup({ deleteSideChat: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  const buttons = [screen.getByRole('button', { name: 'Cancel' }), screen.getByRole('button', { name: 'Delete' })];
  for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
  await user.click(buttons[1]);
  await user.keyboard('{Escape}');
  expect(deleteSideChat).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  finish();
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

test('a failed delete keeps the dialog open with the failure, and Delete can be tried again', async () => {
  const deleteSideChat = vi.fn<ConversationApi['deleteSideChat']>().mockRejectedValueOnce(new Error('Error invoking remote method')).mockResolvedValue(undefined);
  const { onDeleted, onClose } = setup({ deleteSideChat });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Couldn\'t delete the side chat.')).toBeTruthy();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(onDeleted).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(deleteSideChat).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Couldn\'t delete the side chat.')).toBeNull();
});

test('Cancel closes without deleting anything', async () => {
  const { deleteSideChat, onDeleted, onClose } = setup();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(deleteSideChat).not.toHaveBeenCalled();
  expect(onDeleted).not.toHaveBeenCalled();
});
