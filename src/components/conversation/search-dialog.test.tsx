// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { ProjectConversationGroup } from '@/shared/conversation-contract';
import { SearchDialog } from './search-dialog';

const groups: ProjectConversationGroup[] = [{
  projectPath: '/work/fractal',
  displayName: 'Fractal',
  conversations: [
    { ref: { provider: 'codex', nativeSessionId: 'thread-1', projectPath: '/work/fractal' }, title: 'Review IPC', updatedAt: 2, runtime: 'idle', captureCompleteness: 'complete' },
    { ref: { provider: 'claude', nativeSessionId: 'session-2', projectPath: '/work/fractal' }, title: 'Fix parser', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' },
  ],
}];

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
});
afterEach(cleanup);

test('searches conversations in a dialog and selects the native conversation', async () => {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  render(<SearchDialog groups={groups} onOpenChange={onOpenChange} onSelect={onSelect} open />);
  const user = userEvent.setup();
  expect(screen.getByRole('dialog')).toBeTruthy();
  await user.type(screen.getByRole('searchbox'), 'parser');
  expect(screen.getByRole('button', { name: /Fix parser/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Review IPC/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: /Fix parser/ }));
  expect(onSelect).toHaveBeenCalledWith({ ref: groups[0].conversations[1].ref, title: 'Fix parser', section: 'Fractal', runtime: 'idle' });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('shows empty results without filtering away the recent chats at rest', async () => {
  render(<SearchDialog groups={groups} onOpenChange={vi.fn()} onSelect={vi.fn()} open />);
  const user = userEvent.setup();
  expect(screen.getByText('Recent chats')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Review IPC/ })).toBeTruthy();
  await user.type(screen.getByRole('searchbox'), 'missing');
  expect(screen.getByRole('status').textContent).toBe('No conversations found.');
});

test('clears the query from its trailing control without a separate dialog close button', async () => {
  render(<SearchDialog groups={groups} onOpenChange={vi.fn()} onSelect={vi.fn()} open />);
  const user = userEvent.setup();
  const search = screen.getByRole('searchbox');
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  await user.type(search, 'parser');
  await user.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(search).toHaveProperty('value', '');
  expect(screen.getByRole('button', { name: /Review IPC/ })).toBeTruthy();
});
