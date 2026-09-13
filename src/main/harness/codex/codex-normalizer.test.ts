import { describe, expect, test } from 'vitest';
import { normalizeCodexNotification, normalizeCodexServerRequest, normalizeCodexThread } from '@/main/harness/codex/codex-normalizer';
import threadRead from '@/main/harness/codex/__fixtures__/thread-read.json';
import notifications from '@/main/harness/codex/__fixtures__/notifications.json';

describe('Codex native normalization', () => {
  test('preserves thread item chronology and native IDs', () => {
    const events = normalizeCodexThread(threadRead.thread as never);

    expect(events.slice(0, 6).map((event) => event.payload.kind)).toEqual([
      'turn-started', 'assistant-text', 'action-requested', 'action-updated', 'assistant-text', 'turn-finished',
    ]);
    expect(events.slice(0, 6).map((event) => event.nativeId)).toEqual([
      'user-1', 'message-1', 'command-1', 'command-1:status', 'message-2', 'turn-1:status',
    ]);
  });

  test('maps native file, tool, search, and subagent activity without raw tool payloads', () => {
    const events = normalizeCodexThread(threadRead.thread as never);
    const actionKinds = events.flatMap((event) => event.payload.kind === 'action-requested' ? [event.payload.actionKind] : []);

    expect(actionKinds).toEqual(['command', 'file-edit', 'file-read', 'search', 'subagent']);
    expect(events.find((event) => event.nativeId === 'file-1:status')?.payload).toMatchObject({ patch: '@@ safe patch' });
    const unsupported = events.find((event) => event.nativeId === 'future-1');
    expect(unsupported).toMatchObject({ nativeType: 'futureItem', payload: { kind: 'unsupported', captureCompleteness: 'partial' } });
    expect(JSON.stringify(events)).not.toContain('privatePayload');
    expect(JSON.stringify(events)).not.toContain('not exposed');
  });

  test('uses stable item identity to merge partial and final assistant observations', () => {
    const [partial, final] = notifications.slice(0, 2).flatMap((notification) => normalizeCodexNotification(notification as never));

    expect(partial).toMatchObject({ nativeId: 'message-live', payload: { kind: 'assistant-text', text: 'partial', final: false } });
    expect(final).toMatchObject({ nativeId: 'message-live', payload: { kind: 'assistant-text', text: 'partial final', final: true } });
  });

  test('normalizes active status and leaves unrelated notifications unsupported', () => {
    const events = normalizeCodexNotification(notifications[2] as never);
    expect(events).toMatchObject([{ nativeId: 'thread-1:status', payload: { kind: 'system-notice', tone: 'info' } }]);
    const unknown = normalizeCodexNotification({ method: 'future/notice', params: { threadId: 'thread-1', secret: 'never expose' } } as never);
    expect(unknown).toMatchObject([{ nativeType: 'future/notice', payload: { kind: 'unsupported', captureCompleteness: 'partial' } }]);
    expect(JSON.stringify(unknown)).not.toContain('never expose');
  });

  test('opens a sanitized native approval request', () => {
    const events = normalizeCodexServerRequest({
      id: 9, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 3, approvalId: null, environmentId: null, reason: 'private', command: 'private command', cwd: null, commandActions: null, proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null },
    } as never);

    expect(events).toMatchObject([{ nativeId: 'request:9', payload: { kind: 'request-opened', turnId: 'turn-1', request: { id: '9', kind: 'approval', provider: 'codex', operation: 'Command execution' } } }]);
    expect(JSON.stringify(events)).not.toContain('private');
  });
});
