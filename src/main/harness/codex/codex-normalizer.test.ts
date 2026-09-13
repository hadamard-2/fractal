import { describe, expect, test } from 'vitest';
import { createCodexLiveNormalizationContext, normalizeCodexNotification, normalizeCodexServerRequest, normalizeCodexThread } from '@/main/harness/codex/codex-normalizer';
import { reconcileNativeEvents } from '@/main/harness/reconciler';
import { TurnProjector } from '@/main/harness/turn-projector';
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
    expect(events.find((event) => event.nativeId === 'file-1:file:src/main.ts:status')?.payload).toMatchObject({ patch: '@@ safe patch' });
    const unsupported = events.find((event) => event.nativeId === 'future-1');
    expect(unsupported).toMatchObject({ nativeType: 'futureItem', payload: { kind: 'unsupported', captureCompleteness: 'partial' } });
    expect(JSON.stringify(events)).not.toContain('privatePayload');
    expect(JSON.stringify(events)).not.toContain('not exposed');
  });

  test('accumulates repeated deltas, replaces with a completion snapshot, and projects one final block', () => {
    const context = createCodexLiveNormalizationContext();
    const partial = normalizeCodexNotification(notifications[0] as never, context)[0];
    const repeated = normalizeCodexNotification(notifications[0] as never, context)[0];
    const final = normalizeCodexNotification(notifications[1] as never, context)[0];
    const observations = [partial, repeated, final].filter((event): event is NonNullable<typeof event> => event !== undefined);
    const reconciled = reconcileNativeEvents([], observations);
    const projector = new TurnProjector();
    const updates = reconciled.flatMap((event) => projector.push(event));

    expect(partial).toMatchObject({ nativeId: 'message-live', payload: { kind: 'assistant-text', text: 'partial', final: false } });
    expect(repeated).toMatchObject({ payload: { kind: 'assistant-text', text: 'partialpartial', final: false } });
    expect(final).toMatchObject({ payload: { kind: 'assistant-text', text: 'partial final', final: true } });
    expect(updates.at(-1)?.turn.blocks).toMatchObject([{ id: 'message-live', kind: 'assistant-prose', text: 'partial final' }]);
  });

  test('normalizes active status and leaves unrelated notifications unsupported', () => {
    const events = normalizeCodexNotification(notifications[2] as never);
    expect(events).toMatchObject([{ nativeId: 'thread-1:status', payload: { kind: 'system-notice', tone: 'info' } }]);
    expect(events[0]?.payload).not.toHaveProperty('turnId');
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

  test('quarantines malformed known items, preserves later valid items, and keeps empty active turns', () => {
    const malformed = {
      ...threadRead.thread,
      turns: [
      { id: 'active-empty', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null },
      { id: 'mixed', items: [{ type: 'reasoning', id: 'bad-reasoning', summary: 'not-an-array', content: [] as unknown[] }, { type: 'agentMessage', id: 'good-message', text: 'still here', phase: null as unknown, memoryCitation: null as unknown, delivery: null as unknown }], itemsView: 'full', status: 'completed', error: null as unknown, startedAt: 2, completedAt: 3, durationMs: 1 },
      ],
    };
    const events = normalizeCodexThread(malformed as never);

    expect(events.slice(0, 3)).toMatchObject([
      { nativeId: 'active-empty:started', payload: { kind: 'turn-started', turnId: 'active-empty' } },
      { nativeId: 'bad-reasoning', payload: { kind: 'unsupported', turnId: 'mixed', captureCompleteness: 'partial' } },
      { nativeId: 'good-message', payload: { kind: 'assistant-text', text: 'still here' } },
    ]);
  });

  test('uses file paths rather than change count or ordering for file action identity', () => {
    const first = structuredClone(threadRead.thread) as { turns: Array<{ items: unknown[] }> };
    const second = structuredClone(threadRead.thread) as { turns: Array<{ items: unknown[] }> };
    const changes = [{ path: 'a.ts', kind: 'update', diff: 'a' }, { path: 'b.ts', kind: 'update', diff: 'b' }];
    first.turns[1].items[1] = { type: 'fileChange', id: 'patch-1', changes, status: 'inProgress' };
    second.turns[1].items[1] = { type: 'fileChange', id: 'patch-1', changes: [...changes].reverse(), status: 'inProgress' };

    const ids = (value: unknown) => normalizeCodexThread(value as never).filter((event) => event.payload.kind === 'action-requested').map((event) => event.nativeId).filter((id) => id.startsWith('patch-1'));
    expect(ids(first).sort()).toEqual(ids(second).sort());
  });
});
