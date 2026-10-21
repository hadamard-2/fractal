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

  test('opens a decision-relevant native approval request without unrelated provider fields', () => {
    const events = normalizeCodexServerRequest({
      id: 9, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 3, approvalId: null, environmentId: null, reason: 'private', command: 'private command', cwd: null, commandActions: null, proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null },
    } as never);

    expect(events).toMatchObject([{ nativeId: 'request:9', payload: { kind: 'request-opened', turnId: 'turn-1', request: { id: '9', kind: 'approval', provider: 'codex', operation: expect.stringContaining('private command') } } }]);
    expect(JSON.stringify(events)).toContain('Reason: private');
  });

  test('exposes only the generated session scope for remembered permission grants', () => {
    const events = normalizeCodexServerRequest({ id: 30, method: 'item/permissions/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'permission', environmentId: null, startedAtMs: 3,
      cwd: '/repo', reason: null, permissions: { network: { enabled: true }, fileSystem: null },
    } } as never);
    expect(events).toMatchObject([{ payload: { kind: 'request-opened', request: { id: '30', kind: 'approval', rememberScope: 'session' } } }]);
  });

  test('describes the command and working directory without exposing unrelated provider fields', () => {
    const events = normalizeCodexServerRequest({ id: 40, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command', startedAtMs: 1, environmentId: null,
      command: 'pnpm lint', cwd: '/repo', reason: 'Requires network access', networkApprovalContext: null,
    } } as never);
    expect(events[0]?.payload).toMatchObject({ kind: 'request-opened', request: { operation: expect.stringContaining('pnpm lint') } });
    expect(JSON.stringify(events)).toContain('/repo');
    expect(JSON.stringify(events)).toContain('Requires network access');
  });

  test('redacts embedded credentials while retaining the proposed command', () => {
    const events = normalizeCodexServerRequest({ id: 43, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command', startedAtMs: 1, environmentId: null,
      command: 'curl -H "Authorization: Bearer top-secret" https://example.com', cwd: '/repo', reason: null,
    } } as never);
    expect(JSON.stringify(events)).toContain('curl -H');
    expect(JSON.stringify(events)).not.toContain('top-secret');
  });

  test('describes a file grant and requested permission scope explicitly', () => {
    const file = normalizeCodexServerRequest({ id: 41, method: 'item/fileChange/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'change', startedAtMs: 1,
      reason: 'Edit config', grantRoot: '/repo/config',
    } } as never);
    expect(JSON.stringify(file)).toContain('/repo/config');
    expect(JSON.stringify(file)).toContain('Edit config');
    const permissions = normalizeCodexServerRequest({ id: 42, method: 'item/permissions/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'permission', startedAtMs: 1, environmentId: null,
      cwd: '/repo', reason: 'Fetch dependencies', permissions: { network: { enabled: true }, fileSystem: { read: ['/repo'], write: ['/repo/config'], globScanMaxDepth: 4 } },
    } } as never);
    expect(JSON.stringify(permissions)).toContain('Network: enabled');
    expect(JSON.stringify(permissions)).toContain('/repo/config');
    expect(JSON.stringify(permissions)).toContain('session');
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

  test('drops the token usage Codex reports after each model response', () => {
    // Recorded from codex-cli 0.162.1's app server.
    const usage = { totalTokens: 17460, inputTokens: 17455, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 };
    expect(normalizeCodexNotification({ method: 'thread/tokenUsage/updated', params: {
      threadId: '01a159ee-8347-79c3-a9bb-1cfef893df72', turnId: '01a159ee-83c1-7943-8751-93fc7fa8578f', tokenUsage: { total: usage, last: usage, modelContextWindow: 258400 },
    } }, createCodexLiveNormalizationContext())).toEqual([]);
  });

  test('drops the automatic approval review Codex runs before an action', () => {
    // Shaped after the app server's generated ItemGuardianApprovalReview*Notification types.
    const reviewed = {
      threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1_000, reviewId: 'review-1', targetItemId: 'item-1',
      action: { type: 'applyPatch', cwd: '/repo', files: ['/repo/hello.txt'] },
    };
    const context = createCodexLiveNormalizationContext();
    expect(normalizeCodexNotification({ method: 'item/autoApprovalReview/started', params: {
      ...reviewed, review: { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null },
    } } as never, context)).toEqual([]);
    expect(normalizeCodexNotification({ method: 'item/autoApprovalReview/completed', params: {
      ...reviewed, completedAtMs: 1_200, decisionSource: 'agent', review: { status: 'approved', riskLevel: 'low', userAuthorization: null, rationale: 'Writes one file in the project.' },
    } } as never, context)).toEqual([]);
  });

  test('finishes a failed turn whose completion carries no loaded items', () => {
    const events = normalizeCodexNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: {
      id: 'turn-1', items: [], itemsView: 'notLoaded', status: 'failed', error: { message: 'The model is not available for this account.', codexErrorInfo: null, additionalDetails: null }, startedAt: 1, completedAt: 2, durationMs: 1_000,
    } } } as never, createCodexLiveNormalizationContext());
    expect(events.map((event) => event.payload)).toEqual([
      { kind: 'system-notice', turnId: 'turn-1', message: 'The model is not available for this account.', tone: 'error' },
      { kind: 'turn-finished', turnId: 'turn-1', status: 'failed' },
    ]);
  });

  describe('a failed turn\'s error', () => {
    const upstream = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." } });
    const turnError = (message: string) => ({ message, codexErrorInfo: 'other', additionalDetails: null as string | null });
    const notice = (message: string, tone: 'warning' | 'error') => ({ kind: 'system-notice', turnId: 'turn-1', message, tone });
    const errorNotification = (message: string, willRetry: boolean) => normalizeCodexNotification({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry, error: turnError(message) } } as never, createCodexLiveNormalizationContext());

    test('shows the readable message inside a JSON error response', () => {
      expect(errorNotification(upstream, false).map((event) => [event.nativeId, event.payload])).toEqual([
        ['turn-1:error', notice("The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.", 'error')],
      ]);
    });

    test('shows any other message as it is', () => {
      expect(errorNotification('  stream disconnected  ', false).map((event) => event.payload)).toEqual([notice('stream disconnected', 'error')]);
      expect(errorNotification('{"error":"not the shape"}', false).map((event) => event.payload)).toEqual([notice('{"error":"not the shape"}', 'error')]);
    });

    test('is a warning while Codex will retry, under the id the final error replaces', () => {
      expect(errorNotification('Reconnecting…', true).map((event) => [event.nativeId, event.payload])).toEqual([['turn-1:error', notice('Reconnecting…', 'warning')]]);
    });

    test('shows nothing for an empty message, and marks a malformed notification unsupported', () => {
      expect(errorNotification('  ', false)).toEqual([]);
      const malformed = normalizeCodexNotification({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', error: turnError('x') } } as never, createCodexLiveNormalizationContext());
      expect(malformed.map((event) => event.payload.kind)).toEqual(['unsupported']);
    });

    test('is read back from history before the turn finishes', () => {
      const thread = structuredClone(threadRead.thread) as unknown as { turns: Array<Record<string, unknown>> };
      const [first] = thread.turns;
      if (!first) throw new Error('fixture is incomplete');
      thread.turns = [{ ...first, status: 'failed', error: turnError(upstream) }];
      const kinds = normalizeCodexThread(thread as never).map((event) => [event.nativeId, event.payload.kind]);
      expect(kinds.slice(-2)).toEqual([[`${String(first.id)}:error`, 'system-notice'], [`${String(first.id)}:status`, 'turn-finished']]);
    });
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

  test('records local images on the user message instead of reporting them unsupported', () => {
    const thread = structuredClone(threadRead.thread) as typeof threadRead.thread;
    (thread.turns[0].items[0] as { content: unknown[] }).content = [
      { type: 'text', text: 'What is this?', text_elements: [] },
      { type: 'localImage', path: '/tmp/shot.png' },
      { type: 'skill', name: 'review', path: '/skills/review' },
    ];
    const events = normalizeCodexThread(thread as never);
    expect(events[0].payload).toMatchObject({ kind: 'turn-started', text: 'What is this?', attachments: [{ path: '/tmp/shot.png', kind: 'image' }], createdAt: thread.turns[0].startedAt * 1000 });
    expect(events.filter((event) => event.nativeId.startsWith('user-1:content:')).map((event) => event.nativeType)).toEqual(['skill']);
  });
});
