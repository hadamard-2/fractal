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

    expect(events.find((event) => event.nativeId === 'active-empty:started')).toMatchObject({ payload: { kind: 'turn-started', turnId: 'active-empty' } });
    expect(events.find((event) => event.nativeId === 'active-empty:missing-user')).toMatchObject({ payload: { kind: 'unsupported', turnId: 'active-empty', captureCompleteness: 'partial' } });
    expect(events.find((event) => event.nativeId === 'bad-reasoning')).toMatchObject({ payload: { kind: 'unsupported', turnId: 'mixed', captureCompleteness: 'partial' } });
    expect(events.find((event) => event.nativeId === 'good-message')).toMatchObject({ payload: { kind: 'assistant-text', text: 'still here' } });
  });

  test.each([42, false, { secret: 'private approval identity' }, ['private approval identity']])('quarantines a malformed approvalId: %j', (approvalId) => {
    const events = normalizeCodexServerRequest({
      id: 9, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 3, approvalId },
    } as never);

    expect(events).toMatchObject([{ nativeId: 'request:9', payload: { kind: 'unsupported', captureCompleteness: 'partial' } }]);
    expect(JSON.stringify(events)).not.toContain('private approval identity');
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

  test('marks active historical work partial, accumulates from a seeded snapshot, and clears interrupted streams', () => {
    const context = createCodexLiveNormalizationContext();
    const active = structuredClone(threadRead.thread) as { turns: Array<{ items: Array<Record<string, unknown>>; [key: string]: unknown }> };
    const firstTurn = active.turns[0];
    const commandItem = firstTurn?.items[2];
    if (!firstTurn || !commandItem) throw new Error('fixture is incomplete');
    active.turns = [{ ...firstTurn, status: 'inProgress', completedAt: null, items: [{ type: 'agentMessage', id: 'live-message', text: 'Hello', phase: null as unknown, memoryCitation: null as unknown, delivery: null as unknown }, { ...commandItem, id: 'live-command', aggregatedOutput: 'first' }] }];
    const history = normalizeCodexThread(active as never);
    context.seed(active as never);
    const assistant = normalizeCodexNotification({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'live-message', delta: ' world' } } as never, context);
    const command = normalizeCodexNotification({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'live-command', delta: ' second' } } as never, context);
    normalizeCodexNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'interrupted', error: null, startedAt: 1, completedAt: 2, durationMs: 1_000 } } } as never, context);
    const afterInterrupt = normalizeCodexNotification({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'live-message', delta: 'new' } } as never, context);

    expect(history.find((event) => event.nativeId === 'live-message')?.payload).toMatchObject({ final: false });
    expect(assistant[0]?.payload).toMatchObject({ text: 'Hello world' });
    expect(command[0]?.payload).toMatchObject({ output: 'first second' });
    expect(afterInterrupt[0]?.payload).toMatchObject({ text: 'new' });
  });

  test('validates malformed live envelopes and requests without blocking later valid activity', () => {
    const context = createCodexLiveNormalizationContext();
    const malformed = normalizeCodexNotification({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 'bad', item: { type: 'agentMessage', id: 'bad', text: 'hidden' } } } as never, context);
    const request = normalizeCodexServerRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 2, startedAtMs: 'bad' } } as never);
    const valid = normalizeCodexNotification({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'ok', delta: 'ok' } } as never, context);

    expect(malformed[0]?.payload).toMatchObject({ kind: 'unsupported', captureCompleteness: 'partial' });
    expect(request[0]?.payload).toMatchObject({ kind: 'unsupported', captureCompleteness: 'partial' });
    expect(valid[0]?.payload).toMatchObject({ kind: 'assistant-text', text: 'ok' });
  });

  test('gives ID-less unsupported notices distinct context-local identities and maps interrupted subagents', () => {
    const context = createCodexLiveNormalizationContext();
    const first = normalizeCodexNotification({ method: 'future/notice', params: { threadId: 'thread-1' } } as never, context)[0];
    const second = normalizeCodexNotification({ method: 'future/notice', params: { threadId: 'thread-1' } } as never, context)[0];
    const item = structuredClone(threadRead.thread) as { turns: Array<{ items: Array<{ kind?: string }> }> };
    const subagent = item.turns[1]?.items[4];
    if (!subagent) throw new Error('fixture is incomplete');
    subagent.kind = 'interrupted';
    const interrupted = normalizeCodexThread(item as never).find((event) => event.nativeId === 'subagent-1:status');

    expect(first?.nativeId).not.toBe(second?.nativeId);
    expect(interrupted?.payload).toMatchObject({ kind: 'action-updated', status: 'interrupted' });
  });

  test('uses safe title extraction and retains running action snapshots from active turns', () => {
    const active = structuredClone(threadRead.thread) as any;
    active.name = ' ';
    active.preview = ' ';
    active.turns = [{ ...active.turns[0], status: 'inProgress', items: [{ type: 'userMessage', id: 'broken-user', content: null }, { ...active.turns[0].items[2], status: 'inProgress', aggregatedOutput: 'running output' }, { type: 'fileChange', id: 'running-file', status: 'inProgress', changes: [{ path: 'a.ts', kind: 'update', diff: 'patch' }] }] }];
    const events = normalizeCodexThread(active);

    expect(events.find((event) => event.nativeId === 'command-1:status')?.payload).toMatchObject({ kind: 'action-updated', status: 'running', output: 'running output' });
    expect(events.find((event) => event.nativeId === 'running-file:file:a.ts:status')?.payload).toMatchObject({ kind: 'action-updated', status: 'running', patch: 'patch' });
  });
});
