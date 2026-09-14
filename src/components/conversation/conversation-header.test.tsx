// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ConversationSummary, HarnessCapabilities } from '@/shared/conversation-contract';
import { ConversationHeader } from './conversation-header';

afterEach(cleanup);

const summary: ConversationSummary = {
  ref: { provider: 'codex', nativeSessionId: 'session-1', projectPath: '/work/fractal' },
  title: 'Fix parser', updatedAt: 1, runtime: 'active-in-fractal', captureCompleteness: 'complete',
};

const capabilities: HarnessCapabilities = {
  create: true, partialStreaming: true, approvals: true, questions: true,
  interrupt: true, steerWhileRunning: true, fork: false,
};

describe('ConversationHeader', () => {
  test('contains rejected clipboard and interrupt calls, disabling only while interrupt is pending', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => Promise.reject(new Error('blocked'))) } });
    let rejectInterrupt: ((reason?: unknown) => void) | undefined;
    const onInterrupt = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectInterrupt = reject; }));
    render(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} summary={summary} />);

    await user.click(screen.getByRole('button', { name: 'Conversation details menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy session ID' }));
    await user.click(screen.getByRole('button', { name: 'Interrupt session' }));
    expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(true);

    rejectInterrupt?.(new Error('interruption refused'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(false));
  });

  test('contains synchronous interrupt failures and explains externally active read-only state', async () => {
    const user = userEvent.setup();
    const onInterrupt = vi.fn(() => { throw new Error('interruption refused'); });
    const { rerender } = render(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} summary={summary} />);

    await user.click(screen.getByRole('button', { name: 'Interrupt session' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(false));

    rerender(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} runtime="active-externally" summary={summary} />);
    expect(screen.queryByRole('button', { name: 'Interrupt session' })).toBeNull();
    expect(screen.getByText('This session is active outside Fractal, so the composer is read-only.')).toBeTruthy();
  });
});
