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

const summaryFor = (nativeSessionId: string): ConversationSummary => ({
  ...summary,
  ref: { ...summary.ref, nativeSessionId },
});

describe('ConversationHeader', () => {
  test('contains rejected clipboard promises', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => Promise.reject(new Error('blocked'))) } });
    render(<ConversationHeader capabilities={capabilities} onInterrupt={vi.fn()} summary={summary} />);

    await user.click(screen.getByRole('button', { name: 'Conversation details menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy session ID' }));
  });

  test('scopes pending interrupts to a native conversation and ignores stale rejection', async () => {
    const user = userEvent.setup();
    const rejects: Array<(reason?: unknown) => void> = [];
    const onInterrupt = vi.fn(() => new Promise<void>((_resolve, reject) => { rejects.push(reject); }));
    const { rerender } = render(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} summary={summaryFor('A')} />);

    await user.click(screen.getByRole('button', { name: 'Interrupt session' }));
    expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(true);

    rerender(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} summary={summaryFor('B')} />);
    expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Interrupt session' }));
    expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(true);

    rejects[0](new Error('stale interruption refused'));
    await Promise.resolve();
    expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(true);

    rejects[1](new Error('current interruption refused'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(false));
  });

  test('keeps a successful current interrupt pending until runtime changes', async () => {
    const user = userEvent.setup();
    const settles: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = [];
    const onInterrupt = vi.fn(() => new Promise<void>((resolve, reject) => { settles.push({ resolve, reject }); }));
    const { rerender } = render(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} summary={summaryFor('A')} />);

    await user.click(screen.getByRole('button', { name: 'Interrupt session' }));
    settles[0].resolve();
    await Promise.resolve();
    expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(true);

    rerender(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} runtime="idle" summary={summaryFor('A')} />);
    expect(screen.queryByRole('button', { name: 'Interrupt session' })).toBeNull();
    rerender(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} summary={summaryFor('A')} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(false));
  });

  test('ignores stale same-conversation rejection after a runtime transition and newer attempt', async () => {
    const user = userEvent.setup();
    const settles: Array<{ reject: (reason?: unknown) => void }> = [];
    const onInterrupt = vi.fn(() => new Promise<void>((_resolve, reject) => { settles.push({ reject }); }));
    const { rerender } = render(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} summary={summaryFor('A')} />);

    await user.click(screen.getByRole('button', { name: 'Interrupt session' }));
    rerender(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} runtime="idle" summary={summaryFor('A')} />);
    rerender(<ConversationHeader capabilities={capabilities} onInterrupt={onInterrupt} summary={summaryFor('A')} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Interrupt session' }));

    settles[0].reject(new Error('stale interruption refused'));
    await Promise.resolve();
    expect(screen.getByRole('button', { name: 'Interrupt session' }).hasAttribute('disabled')).toBe(true);
    settles[1].reject(new Error('current interruption refused'));
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
