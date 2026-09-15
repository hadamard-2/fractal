import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConversationRuntimeController } from '@/main/conversation-runtime';

const approval = { id: 'request-1', kind: 'approval' as const, provider: 'codex' as const, title: 'Run', operation: 'pnpm test', rememberScope: 'project:/repo', status: 'open' as const };

afterEach(() => vi.useRealTimers());

describe('ConversationRuntimeController', () => {
  test('permits continuation only when idle is proven and rejects invalid transitions safely', () => {
    const runtime = new ConversationRuntimeController();
    expect(runtime.canContinue('idle')).toBe(true);
    expect(runtime.canContinue('active-externally')).toBe(false);
    expect(runtime.canContinue('unknown')).toBe(false);
    runtime.observe('idle');
    runtime.claimOwnedRun('run-1');
    expect(runtime.state).toBe('active-in-fractal');
    expect(() => runtime.observe('active-externally')).toThrow('Invalid conversation runtime transition');
  });

  test('moves an owned run through waiting and back without surrendering ownership', async () => {
    const resolve = vi.fn(async () => undefined);
    const runtime = new ConversationRuntimeController();
    runtime.observe('idle');
    runtime.claimOwnedRun('run-1');
    runtime.openRequest({ conversationKey: 'codex:session', runId: 'run-1', rendererId: 'renderer-1', request: approval, resolve });
    expect(runtime.state).toBe('waiting-for-user');
    await runtime.resolveRequest('request-1', { kind: 'allow-once' });
    expect(resolve).toHaveBeenCalledWith('request-1', { kind: 'allow-once' });
    expect(runtime.state).toBe('active-in-fractal');
    expect(runtime.ownedRunId).toBe('run-1');
    await expect(runtime.resolveRequest('request-1', { kind: 'deny' })).rejects.toThrow('Conversation request is no longer available');
  });

  test('denies a mismatched remembered scope and cleans up even when denial fails', async () => {
    const resolve = vi.fn(async () => { throw new Error('/private adapter failure'); });
    const runtime = new ConversationRuntimeController();
    runtime.observe('idle'); runtime.claimOwnedRun('run-1');
    runtime.openRequest({ conversationKey: 'codex:session', runId: 'run-1', rendererId: 'renderer-1', request: approval, resolve });
    await expect(runtime.resolveRequest('request-1', { kind: 'allow-and-remember', scope: 'project:/other' })).rejects.toThrow('Remembered permission scope does not match');
    expect(resolve).toHaveBeenCalledWith('request-1', { kind: 'deny', reason: 'Permission scope did not match' });
    expect(runtime.state).toBe('active-in-fractal');
    await expect(runtime.resolveRequest('request-1', { kind: 'deny' })).rejects.toThrow('Conversation request is no longer available');
  });

  test('rejects duplicate request ownership and denies unresolved requests after ten minutes', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => undefined);
    const runtime = new ConversationRuntimeController();
    runtime.observe('idle'); runtime.claimOwnedRun('run-1');
    const input = { conversationKey: 'codex:session', runId: 'run-1', rendererId: 'renderer-1', request: approval, resolve };
    runtime.openRequest(input);
    expect(() => runtime.openRequest(input)).toThrow('Conversation request is already owned');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    expect(resolve).toHaveBeenCalledWith('request-1', { kind: 'deny', reason: 'Request timed out' });
    expect(runtime.state).toBe('active-in-fractal');
  });

  test('contains a rejected timeout denial while closing ownership and restoring state', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => { throw new Error('/private timeout failure'); });
    const runtime = new ConversationRuntimeController();
    runtime.observe('idle'); runtime.claimOwnedRun('run-1');
    runtime.openRequest({ conversationKey: 'codex:session', runId: 'run-1', rendererId: 'renderer-1', request: approval, resolve });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    expect(runtime.state).toBe('active-in-fractal');
    await expect(runtime.resolveRequest('request-1', { kind: 'deny' })).rejects.toThrow('Conversation request is no longer available');
  });

  test('denies every pending native request exactly once before entering failed', async () => {
    const resolve = vi.fn(async () => undefined);
    const runtime = new ConversationRuntimeController();
    runtime.observe('idle'); runtime.claimOwnedRun('run-1');
    runtime.openRequest({ conversationKey: 'codex:session', runId: 'run-1', rendererId: 'renderer-1', request: approval, resolve });
    await runtime.failOwnedRun('run-1', 'Conversation run failed');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('request-1', { kind: 'deny', reason: 'Conversation run failed' });
    expect(runtime.state).toBe('failed');
  });

  test('denies unresolved requests immediately when their renderer disappears', async () => {
    const resolve = vi.fn(async () => undefined);
    const runtime = new ConversationRuntimeController();
    runtime.observe('idle'); runtime.claimOwnedRun('run-1');
    runtime.openRequest({ conversationKey: 'codex:session', runId: 'run-1', rendererId: 'renderer-1', request: approval, resolve });
    await runtime.releaseRenderer('renderer-1', 'Fractal window closed');
    expect(resolve).toHaveBeenCalledWith('request-1', { kind: 'deny', reason: 'Fractal window closed' });
    expect(runtime.state).toBe('active-in-fractal');
  });

  test('returns from failure to idle only with a fresh proven observation', async () => {
    const runtime = new ConversationRuntimeController();
    runtime.observe('idle'); runtime.claimOwnedRun('run-1'); await runtime.failOwnedRun('run-1', 'failed');
    expect(runtime.state).toBe('failed');
    expect(() => runtime.releaseOwnedRun('run-1', 'unknown')).toThrow('Conversation runtime is not proven idle');
    runtime.releaseOwnedRun('run-1', 'idle');
    expect(runtime.state).toBe('idle');
    expect(runtime.ownedRunId).toBeUndefined();
  });
});
